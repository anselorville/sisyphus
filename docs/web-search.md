# 网页搜索：多源、兜底链与多路检索

`web_search` 不再只依赖一个搜索服务。同一次搜索可以走 **DeepSeek、Brave、Tavily、智谱 GLM** 四个互相独立的索引，
按问题的难度和时效选择单路 + 兜底，或多路并行再融合；某个源额度耗尽、限流或超时时自动让位，恢复后自动回来。

代码在 `agent-runtime/src/search/`，工具入口仍是 `web_search`（`src/tools/web-tools.ts`）。

## 1. 四个搜索源（2026-10-25 实测，本机）

| 源 | 接口 | 热连接延迟 | 成本 | 特点 / 坑 |
|---|---|---|---|---|
| **DeepSeek** | `POST /v1/tools/search` | **~0.3–0.6 s** | 5 元 / 千次成功请求，按次不按条数 | 与 LLM 同一把 key；握手快；查询 ≤128 字符；返回 `rerank_score`、`authority`、日期 |
| **Brave** | `GET /res/v1/web/search` | ~0.5–0.9 s | 按 Brave 方案 | 独立索引，适合交叉验证 |
| **Tavily** | `POST /search` | ~0.5–1.6 s（服务端 0.1–0.4 s） | 1 credit（basic）/ 2（advanced） | 面向 LLM，有 `news` 主题与 `time_range` |
| **GLM** | MCP `web_search_prime` | ~1–2 s | 随智谱方案 | **REST 接口报 429 / 1113「余额不足或无可用资源包」**，只有 MCP 能用；需要完整 MCP 会话；内容安全过滤会拒绝个别查询 |

**连接是最大的坑。** 从这台机器到 Brave、Tavily（和 TypeSafe）的**新连接 TLS 握手要 ~5.5 秒**，复用连接后才是上面的延迟；
DeepSeek、智谱握手只要几十毫秒。所以每个源有自己的长连接池，启动时预热、每 15 秒保活；
冷启动慢的源（`slowCold`）在预热完成前排到后面，但不排除。

**GLM MCP 的两个坑**（已封装在 `providers/glm-mcp.ts`）：
1. 只做 `initialize` 就 `tools/call` 会报 "Api key not found"（误导性错误）。必须 `initialize` →
   取响应头 `Mcp-Session-Id` → `notifications/initialized` → 之后每次调用都带该会话 ID。
2. 返回是 SSE 帧（`data: {...}`），文本是**二次 JSON 编码**的数组。

## 2. 一次搜索怎么走

```
query ─► 规则计划 planByRules（模式 / 宽度 / 时效 / 主题 / 偏好层）
           │
           ├─ 第一波：按偏好层取前 width 个健康的源，并发请求
           └─ 同时（并行，不增加延迟）：Jev 细化计划（这个问题多难？答案多快过期？）
           │
           ├─ 细化要求更宽 → 追加第二波
           ├─ 还没有结果 → 沿兜底链逐个往下试，直到有人答出来或到总期限
           └─ 多路：取第一个有结果的答案，再多等一个宽限期（700ms）收其他源 → 加权 RRF 融合
```

- **单路（简单查询）**：DeepSeek → [Tavily, Brave 轮换] → GLM。失败、超时、空结果都往下走。
- **多路（难题 / 对比 / 研究型）**：同时问 2–3 个独立索引，**同时被多个源命中的页面排名更高**（加权 RRF，权重见 §6，
  按规范化 URL 去重：忽略 scheme、`www.`、片段、末尾斜杠、跟踪参数）。工具输出会标注 `(found by deepseek + tavily)`，
  这是模型可以引用的"交叉验证"信号。
- **时效**：`今天 / 现在 / 天气 / 股价 / 比分` → `day`；`最近 / 最新 / 新闻` → `week`；新闻类走 Tavily 的 `news` 主题，
  新鲜度参数传给各源（Brave `freshness`、Tavily `time_range`、GLM `search_recency_filter`）。偏好层随之变为
  DeepSeek → Tavily → Brave → GLM。
- **轮转**：同一偏好层里的源逐次轮换起点，把负载和免费额度摊开。
- **难度与时效由谁判断**：规则（长度、对比 / 原理类词、`site:` 或引号 → 单路）先给计划；
  Jev 在 `AGENT_RUNTIME_JEV_MODE=live` 时与第一个源**并行**细化，规则兜底。仅 shadow 模式则只记录不改变行为。

## 3. 活性（健康）与冷却

`src/search/health.ts`。冷却时长取决于失败**原因**，因为它预示着何时能恢复：

| 原因 | 处理 |
|---|---|
| 单次超时 / 网络 / 5xx | 只触发兜底，不冷却；**连续失败**才指数退避（10 s → 最多 5 min） |
| 限流 429 | 按 `Retry-After`（上限 10 min），缺省 30 s |
| 额度耗尽（402 / 432 / 433 / GLM 1113） | 冷却 15 min 后再探（余额可能已充值） |
| 鉴权失败（401 / 403） | 冷却 30 min |
| 请求本身有问题（400、GLM 内容过滤） | **不惩罚**该源，只跳过这次 |
| 成功 | 清零连续失败与冷却，更新平滑延迟 |

全部源都失败时，抛一条说明**每个源各自为什么失败**的错误，模型据此如实告诉用户；
全部源都正常但没搜到东西，返回空结果（不是错误）。

## 4. 配置

```bash
DEEPSEEK_API_KEY=   # 同时是 LLM key 和搜索 key
BRAVE_SEARCH_API_KEY=
TAVILY_API_KEY=
GLM_API_KEY=        # 同时是 ASR key
SEARCH_PROVIDERS=deepseek,brave   # 可选：白名单（默认：所有有 key 的）
```

没有 key 的源直接不存在，链条随部署自适应。`uv run python scripts/doctor.py` 会提示只配了一个源（没有兜底）。
启动日志：`[search] providers: deepseek, brave, tavily, glm`。

## 5. 观测与评测

```bash
scripts/query-hci-events.sh --search       # 模式分布、各源调用 / 失败 / 延迟、失败原因、最近搜索
cd agent-runtime && npm run build && set -a && . ../.env && set +a
node scripts/eval-search.mjs --verbose     # 真实四家：单家延迟与"域名命中"、路由、故障注入
```

每次搜索写一条 `search.made` 事件（计划、每个源的尝试与耗时、贡献者、总耗时）。

2026-10-25 的评测（8 个问题，中英文、时效、对比）：

| | 作答 | 域名命中 | 中位延迟 |
|---|---|---|---|
| DeepSeek | 8/8 | 6/8 | ~340–390 ms |
| Brave | 8/8 | 6/8 | ~540–800 ms |
| Tavily | 8/8 | 7/8 | ~500–1600 ms |
| GLM | 7/8（1 条被内容过滤拒绝） | 7/8 | ~1.0–1.9 s |
| **路由** | **8/8** | **8/8** | **~450 ms** |

故障注入：让 DeepSeek 报配额耗尽 → 首个查询由 Tavily 兜底作答；之后 DeepSeek 被"停用"，查询在 Tavily 与 Brave 间轮转；
健康视图显示 `deepseek=benched`。

"域名命中"只检查已知好来源是否出现在前 5 条，是冒烟测试，不是相关性评测。

## 6. 融合权重（离线评测）

融合用加权 RRF：`得分 = Σ 权重 / (60 + 名次)`。默认权重 `deepseek 3 / brave 2 / tavily 1 / glm 0.5`
（`DEFAULT_FUSION_WEIGHTS`，`SearchRouter` 的 `weights` 选项可覆盖；未列出的源权重为 1）。

**评测方法**：98 个查询（7 类 × 14：中文时效、英文技术文档、中文技术、近期新闻、事实查询、对比研究、本地生活，
`agent-runtime/eval/search-queries.json`）在四个源各取前 8 条，冻结为候选池；每个候选由 Jev（Score 0/1/2，每个查询
一次调用）和 DeepSeek（批量打 0/1/2）各评一次，只看标题、摘要、URL 与日期，两者平均作为相关性。指标 nDCG@5。
调参结果只在**没参与调参的查询**上计分（按类别分层的 5 折交叉验证，重复 20 次），差值给配对 bootstrap 95% 区间。
两位评委在 2272 个候选上相关系数 0.68，均值几乎相同（1.29 / 1.28）。

```bash
cd agent-runtime && npm run build && set -a && . ../.env && set +a
node scripts/build-search-pool.mjs      # 四个源 × 98 查询 → eval/search-pool.json（消耗搜索额度）
node scripts/judge-search-pool.mjs      # → eval/search-judgments.json
node scripts/fusion-experiment.mjs --providers=deepseek,tavily,brave --candidate=deepseek:3,tavily:1,brave:2
```

**结果**（deepseek + tavily + brave，96 个有相关结果的查询）：

| 方案 | nDCG@5 | 相对等权 RRF（95% 区间） |
|---|---|---|
| Tavily 单独 | 0.677 | −0.109 [−0.141, −0.079] |
| Brave 单独 | 0.731 | −0.055 [−0.091, −0.021] |
| **等权 RRF（旧默认）** | 0.786 | — |
| DeepSeek 单独 | 0.833 | +0.047 [0.017, 0.078] |
| 全局调参（留出） | 0.840 | +0.054 [0.029, 0.079] |
| **按类别自适应（留出）** | 0.834 | +0.048 [0.025, 0.073] |
| 逐查询最优（上界，含答案） | 0.905 | +0.119 |

- 等权 RRF **低于 DeepSeek 单独**：DeepSeek 的排序质量明显高于 Tavily / Brave，等权让较差的排序拖累它。
  只用 Jev 评委时差 −0.071，只用 DeepSeek 评委时差 −0.021（DeepSeek 评委没有偏袒 DeepSeek 自己的结果）。
- DeepSeek 为主的静态权重去掉了这个损失（两位评委下都显著优于等权），但**相对 DeepSeek 单独没有显著提升**
  （Jev 评委 −0.002，DeepSeek 评委 +0.017，合并 +0.008，区间都跨 0 或贴近 0）。多路融合的价值是召回、兜底和交叉验证，不是排序精度。
- **按查询类别自适应权重没有收益**：留出分数与全局权重相同（0.834 vs 0.840）。逐查询上界比全局权重高 0.065，说明查询间
  确有差异，但"查询类别"不是能解释它的信号。四源（67 个 GLM 有结果的查询）结论一致，最优 GLM 权重为 0.5。
- 默认权重是在这份数据上挑的，对它自己的区间偏乐观；同一数据上留出的全局调参给出相同分数（0.840）。
- 结论是否推广：标注由模型产生，只看摘要不开网页；候选来自单次、固定的 top 8；类别标签是人工的，真实流量分布不同；
  GLM 在评测中途触发周 / 月额度上限（1310），四源分析只用了 67 个查询。

## 7. 局限与路线图

- 没有结果缓存：同一问题连问会重复花钱（成本很低，但可加 TTL 缓存）。
- `web_fetch` 仍是直连抓取，会被 Cloudflare 等拦截（曾遇到 timeanddate）。DeepSeek 另有 `POST /v1/tools/fetch`
  （Markdown 正文、5 元 / 千次），Tavily 有 Extract，可作为抓取失败时的兜底链——同样的架构，尚未做。
- 融合只用排名（加权 RRF）；各源自带的分数（DeepSeek `rerank_score`、`authority`，Tavily `score`）没参与排序，也没有评估过按它们加权。
- 查询由 LLM 生成（常中英各发一条）；没有做查询改写或去重。
- 计费：DeepSeek 文档称经 Harness / Claude Code / Codex 的服务端工具调用目前免费、2026-11-01 起计费；本项目直接调用 REST 接口，按文档标价（5 元 / 千次成功请求）计。

# Harness² 与图工程：Marcus 能用什么、怎么进一步优化

调研日期：2026-10-25。事实来源标在括号里；**“判断”**是我的推断，不是来源里写的。

## 1. 结论（先说）

1. **不直接用 Harness² 优化 Marcus。** 它是为“文件/文本类任务 + 基准评审员”设计的研究代码，
   文档里没有接入自定义任务或自定义 agent 的路径，也不涉及音频、延迟、轮次。Marcus 的 harness
   是一条受延迟约束的语音链路，没有标准答案，直接套会削足适履。
2. **但它的方法值得偷。** 对同一任务在“被编辑过的 harness”下重跑、靠行为对比而不是标准答案来取舍、
   把经验沉淀进一个持续改进的 harness——这三件事 Marcus 都能用自己已有的积木搭出来，
   而且成本极低：评测一轮 87 条决策只花约 $0.0025（见 `docs/jev-decision-layer.md`）。
3. **图工程方面，Marcus 当前的“图”已经不差，真正的缺口是三条边：**
   独立于 LLM 的**验证边**、把失败变成约束的**学习边**、以及串行等待造成的**假依赖**。第 4 节逐条给出做法。

## 2. Harness² 是什么

来源：[KDnuggets 报道（2026-10-22）](https://www.kdnuggets.com/google-open-sources-harness-self-improving-ai-agents-without-retraining)、
[GitHub google-research/harness2](https://github.com/google-research/harness2)、
[arXiv 2610.14224](https://arxiv.org/abs/2610.14224)、[Product Hunt](https://www.producthunt.com/products/harness-104)。

- Google Research 开源（Apache-2.0）的“递归 agent harness 改进”框架：**模型权重不变，只改模型外面的一圈**。
- 被进化的八类东西：system prompt、guardrails、memory、skills、tool guidance、scripts、subagents、plugins。
- 两层递归：
  - **任务级 Propose–Probe–Compose**：改进器提出通用/领域两类编辑 → 用每个编辑过的 harness 重跑同一任务 →
    由 composer 比较各次运行，合并有效的编辑。**不需要标准答案**，靠运行之间的行为差异学习。
  - **harness 级**：把被采纳的 harness 和“有证据支持的经验”存进持久的 improvement harness，指导后续任务。
- 预算参数 k：每个任务 4k 次 executor 运行 + 3k 次 improver 会话（k=3 即 12 + 9）。
- 论文自报的收益（k=1，最好情况而非平均）：WorkBuddy-Bench +11.5、LAB +11.8（百分点）、JobBench +4.5；
  k 更大收益更多。**这些是 Google 自己的数字，尚待独立复现**（报道和仓库都这么说）。
- 运行要求：Linux（macOS 需虚拟机/容器）、Python 3.12 + uv、Node 20+（OpenCode executor）、
  GCP Vertex AI（executor / improver / judge 三类模型）；LAB 要 Pandoc/Poppler，WorkBuddy-Bench 要 Docker。
  executor 默认**不限网络**，Codex 以关闭沙箱的方式运行——文档建议自行加网络限制。
- 另有无 key 的演示：`harness2-demo --output runs/demo --k 2`，只演示机制，不代表模型能力。
- 成熟度：报道称“研究软件，无 Google 官方产品支持”；`.env.example` 在报道当时 404。

## 3. 为什么不能直接用，以及能借什么

| 维度 | Harness² 假定 | Marcus 的实际情况 | 判断 |
|---|---|---|---|
| 任务形态 | 文件/文本类专业任务，有基准评审员 | 实时语音对话，延迟是一等指标 | 不匹配 |
| 接入 | 内置 OpenCode / Codex executor；文档未提自定义 | executor 是 Pipecat 媒体面 + TS sidecar + Pi 角色会话 | 要自写 executor 适配，等于重写核心 |
| 平台 | Linux + Vertex AI | macOS + DeepSeek / MiniMax / 智谱 | 额外依赖一整套 GCP |
| 评审 | 每个基准各自的 judge | 没有标准答案；有 HCI 事件日志、可冻结的脚本场景 | 需要自建评审 |
| 安全 | 允许改写 guardrails | guardrails 里有“发邮件前必须由人口头确认” | 绝不能让循环改这一层 |

**可以借的是方法而不是代码：**

- **对比式评估**：同一批话语，在 harness 变体 A / B 下重跑，比行为而不是比答案。
- **编辑分类**：区分“通用编辑”（所有任务受益）和“领域编辑”（只对某类话语），分别验证。
- **持久经验**：被采纳的改动连同证据一起存档，下次改进时可检索（Marcus 已有 `docs/lessons-learned.md`
  和 `events` 表，缺的是把它们喂回改进循环）。
- **预算化**：用 k 控制每轮花多少。

## 4. “Marcus harness”是什么，以及怎么搭一个自改进循环

### 4.1 Marcus 的 harness 清单（对照 Harness² 的八类）

| Harness² 组件 | Marcus 里对应的东西 | 能否交给循环改 |
|---|---|---|
| system prompt | `agent-runtime/resources/roles/*.md`（身份、Speaking style、各角色职责） | 可以（提议→评审） |
| tool guidance | 工具定义里的 `promptSnippet` / `promptGuidelines` | 可以 |
| 路由语义 | 各角色 `routingHint`、Jev 的问题措辞与 criteria（`turn-decision.ts`） | **最适合：评测快、便宜、有标注集** |
| guardrails | 邮件确认闸、外交官（Diplomacy）规则、Jev 的阈值（尤其 `confirm ≥ 0.9`） | **不可以**，只能人改 |
| memory | `MemoryCurator` / `memories` 表 / 话题账本（Scribe） | 谨慎 |
| subagents | 角色及其工具白名单（`manifests.ts`） | 人改 |
| scripts | `speech normalizer`、`restart-backend.sh` 等确定性代码 | 人改 |
| plugins | 暂无 | — |

原则（来自 X-Notebook 的《300 Agents, One Graph…》《Loops and Graphs》笔记）：**被评估的对象不能控制闸门**；
能修改约束的 agent 迟早会把不方便的约束删掉。所以循环只能“提议”，落地要过人。

### 4.2 评测底座（Marcus 已经有一半）

- **冻结场景**：`scripts/voice-smoke.py --suite`（真链路）+ `agent-runtime/eval/turn-cases.json`（87 条标注话语）。
- **确定性检查先行**：延迟预算、回复音频时长、是否真的调用了工具、邮件是否真的出现在“已发送”——这些由代码判断，
  不让模型判断。
- **语义评审用 Jev**：回答是否先给结论、有没有念出 Markdown、是否复述了来源——有界的是非/打分题，
  正是 Jev 擅长的（见 X-Notebook《Build a Jev Judge》：judge ≠ 评测系统；评测器失败必须报“评测失败”，
  不能悄悄变成通过）。
- **轨迹比分数重要**：`events` 表里已有每轮的入站、出站、工具调用、决策（`decision.made`）；
  AutoAgent 笔记的教训是“traces are everything”。

### 4.3 循环

```
冻结场景集 ──► 基线 harness 跑一遍 ──► 指标（确定性 + Jev 评审）
                    ▲                          │
                    │                   improver LLM 读失败轨迹
                    │                          ▼
        人审后合并 ◄── compose：保留相对基线无回退的编辑 ◄── probe：每个候选在同一场景集重跑
```

- **第一个目标选路由层**：改的是 Jev 的 criteria 文本和 `routingHint`，评测只要调 Jev（每条约 $0.00003、约 0.3 秒），
  一轮几百个候选也花不了几毛钱。这是最便宜、最安全的起点。
- **第二个目标：Speaking style 与角色提示词**：用 Jev 评审“是否先给结论 / 是否过长 / 有无 Markdown”，
  再用 voice-smoke 的回复时长做确定性约束。
- **防过拟合**：留出一部分标注话语不给 improver 看；同时在 shadow 日志里的真实分歧上验证
  （AutoAgent 笔记里 agent 会对基准过拟合）。
- **成本闸**：每轮候选数、每轮 token 上限写死在脚本里。
- **改动落地**：improver 只产出 diff，由人在 PR 里评审。

### 4.4 现在就能做的最小版本

1. 把 shadow 日志里的分歧导出成新的标注样本（`scripts/query-hci-events.sh --decisions`）。
2. 写 `scripts/improve-routing.mjs`：读失败样本 → 让 LLM 提议改 `routingHint` / criteria → 对全部标注样本重评 →
   输出“相对基线无回退”的候选 diff。**不自动写文件。**
3. 先跑通一轮，看提议质量，再决定要不要接 Harness² 的 composer 思路做多候选合并。

## 5. 图工程：Marcus 现在的图、缺口与优化

依据 X-Notebook 的图工程笔记（《Graph Engineering with Opus 5：14 步》《Loops and Graphs》《300 Agents…》）：
节点是带契约的有界工作单元，边只在数据真的流动时才存在；循环住在节点里，图住在节点之间；
判断给模型，路由给代码；验证者坐在边上；闸门按爆炸半径开，不按置信度。

### 5.1 当前的图（一轮语音对话）

```
VAD ─► STT ─► 语义缓冲 ─► [规则路由] ─► [Jev 判断] ─► 角色会话(LLM) ─► 工具 ─► Herald(语音过滤) ─► TTS预合成 ─► 输出
 │                                           │                  │
 └── 打断(UserStarted)─────────────────────► 取消/清缓冲        └─► 工具事件落库 ─► 任务终态 ─► assimilation(fitness/pheromone/memory)
                                       Scribe(旁路 LLM 话题账本)
```

### 5.2 做得对的地方

- **判断给模型、路由给代码**：Jev 只答类型化的问题，阈值与分支在代码里（`turn-decision.ts`）。
- **边是纯代码**：语音文本规整（去 Markdown）、事件序号、持久化都是确定性代码，零 token。
- **按爆炸半径开闸**：邮件发送/删除必须由用户口头确认，且确认是“语义上的同意”（Jev ≥0.9），不是计数；
  设备控制只允许重启自己的后端。
- **旁路不挡主路**：Scribe、assimilation、事件落库都不在首句音频的关键路径上。
- **打断是一等公民**：已修复自动模式下打断从未生效的缺陷（见 `docs/lessons-learned.md`）。

### 5.3 缺口与具体做法（按价值排序）

1. **缺“验证边”：成功全靠工具自己说。** 教训已经发生过一次——邮件已发出，工具却报失败。
   做法：关键动作后加**独立于 LLM 与工具返回值**的核对节点：发信后查“已发送”文件夹、重启后端后探端口并比 PID、
   联网回答的来源数。借 Browser Use 的做法：模型说 DONE 之后由别处独立检查结果。
2. **缺“学习边”：失败不会变成约束。** `decision.made` 的分歧、用户的纠正、`lessons-learned` 都躺在那里，
   没有东西把它们变成下次路由用的提示。做法：一个带评审的 `CONSTRAINTS` 文件，被 `routingHint` 和角色提示词引用；
   落点是**拆分/路由的简报**，不是 worker 的指令（笔记原话）。
3. **假依赖 / 串行等待：** 首句音频前串了 VAD 停顿 → 转写（约 0.6 s）→ Jev（约 0.3 s）→ 会话创建/调用 → TTS 首包。
   做法：Jev 判断期间**推测性预热**最可能的角色会话；不依赖彼此的步骤并行（笔记：画不出变量箭头就没有边）。
4. **没有逐节点的时间账：** 延迟只有总数（`voice_latency`）和 sidecar 侧“说完→首句入队”。
   做法：每轮写一条 `turn.trace` 事件，带各节点耗时，才能知道优化该砍哪里。
5. **回合结束靠定时器猜：** 语义缓冲用标点 + 0.5 s 计时。换成 Jev 的 Noul“用户说完了吗”，
   能同时降延迟、降误切（见 `docs/jev-decision-layer.md` 路线图 1）。
6. **模型分级没用上：** 目前全部 `deepseek-flash`（有意的产品决策）。若引入更强的档位，
   用 Jev 的 Score 判断任务复杂度来选档，而不是写死角色档位。
7. **不要“修”没坏的：** 笔记的反规则——图只买宽度不买判断力；切不开的工作多 agent 只会更贵更慢。
   Marcus 是单人单线对话，不需要为了“图”而并行化角色；上面各项都是**节点内的验证与路由**，不是多 agent 扇出。

## 6. 建议的下一步

1. 本周：做 5.3 的 1 与 4（独立核对 + 每轮节点耗时），它们让后面的一切优化有数据可依。
2. 跑两周 shadow/live 日志，把分歧导成标注样本，扩到 200+ 条。
3. 做 4.4 的最小改进脚本（只产出 diff，不自动落地）。
4. 之后再评估回合结束判定（5.3 的 5）和推测性预热（5.3 的 3）。

## 来源

- [Harness² 仓库](https://github.com/google-research/harness2)、[论文摘要](https://arxiv.org/abs/2610.14224)、
  [KDnuggets](https://www.kdnuggets.com/google-open-sources-harness-self-improving-ai-agents-without-retraining)、
  [Product Hunt](https://www.producthunt.com/products/harness-104)
- 本机 X-Notebook（`/data/git_repository/X-Notebook/AI/`）：Graph Engineering with Opus 5、Graph Engineering for Normal People、
  300 Agents One Graph and a Loop That Edits the Loop、Loops and Graphs、AutoAgent、Build a Jev Judge、Building a Harness with Jev
- 未能验证的：Harness² 论文的完整方法细节（只读到摘要页）、improvement harness 的存储格式（仓库页面未描述）。

# Sisyphus Project Restart

**日期**：2026-10-18 初版；2026-10-24/25 复验并补完开发缺口（见第 3、4、6 节）
**规范开发根目录**：`/data/git_repository/sisyphus`
**当前分支**：`main`（= `origin/main`，工作区干净；orca 附属 worktree 已移除）
**本文用途**：这是重新开始开发时的唯一入口文档。它记录项目现在的真实状态、
已验证的能力、已知缺口、下一步顺序，以及哪些历史文档仍然可信。

---

## 0. ✅ Git 收敛已完成（2026-10-19）

本节原先记录的是"下次开工第一件事"的收敛清单，已于 2026-10-19 执行完毕。
**当前仓库状态：本地只有一个分支 `main`，只有一个 worktree（主仓库本身），
`main` 已推送到 `origin/main`，工作区干净。** 以下保留为历史记录。

实际执行的命令：

```bash
cd /data/git_repository/sisyphus

git status --short            # 1) 确认为空（工作区干净）
git switch -c main            # 2) main 指向已验证的 HEAD（0b8c683）
git worktree remove --force /Users/anse10rville/orca/workspaces/sisyphus/goby
git worktree prune            # 4) 移除 orca 附属 worktree
git branch -D proj-friday master feature/tauri-client rewrite/pipecat anselorville/goby
git push -u origin main       # 5) 发布
```

结果与注意：

- 本地分支只剩 `main`，跟踪 `origin/main`；被删分支全部已合并，无内容丢失。
- orca 的 `goby` worktree 已移除（其分支早已合并、无独有提交）。移除前目录里
  唯一的未跟踪文件 `.omo/run-continuation/ses_*.json` 已备份到
  `/tmp/sisyphus-goby-omo-backup-*`。
- **远程分支一个都没删**（按用户的明确决定保留）：`origin/master`（当前默认
  分支）、`origin/proj-friday`、`origin/feature/tauri-client`、
  `origin/rewrite/pipecat`、`origin/webrtc`。没有 force-push。
- 若希望 `main` 成为 GitHub 默认分支，需要在仓库设置里手动切换
  （`origin/HEAD` 目前仍指向 `origin/master`）。
- `origin/webrtc` 是翻译器时代的旧分支（10 个未合并 commit，已被 `legacy/`
  归档取代），如无需要可以不管。

---

## 1. 项目定位与演进历史

这个项目**不是**实时翻译器。翻译器是已经被放弃的 Phase-1 原型，归档在
`legacy/`，只作参考，不参与运行。

当前产品目标：

> **Marcus** —— 一个通用个人语音助手（general voice agent），不是
> coding-agent。覆盖日常交流、web search、通信，以及技术课题的 deep
> research。

演进路径：

| 阶段 | 形态 | 状态 |
|------|------|------|
| Phase-1 原型 | Tauri/Rust + React + 本地 ASR/TTS 的双向语音翻译器 | 已放弃，归档在 `legacy/` |
| 重写 | Pipecat 媒体平面 + TypeScript agent-runtime sidecar | 当前运行形态 |
| 蜂群架构（zerg/swarm） | Queen / Population / GeneBank / PheromoneMap / economy | **已设计、已实现、刻意停放** |
| 现在（Phase A） | 单 pi-agent + 扩展工具面的通用 voice agent | 正在推进 |

蜂群治理层不是废弃代码。它接在组合根上、有测试，但执行循环不调用治理决策。
是否唤醒它，要等真实 HCI 数据出来再决定（见 `docs/adr/0001-phase-a-b-path-for-oh-my-pi.md`）。

---

## 2. 当前架构（三个进程）

```
浏览器/客户端 (client/, React + Vite)
        │  WebRTC
        ▼
Python media plane (app/, Pipecat)          ← 只做音频 I/O，不含业务 LLM
  WebRTC mic → Silero VAD → 流式 STT → 流式 TTS → WebRTC speaker
        │  loopback WebSocket 事件桥 (app/realtime/event_bridge.py)
        ▼
TypeScript agent-runtime sidecar (agent-runtime/)
  TaskExecutor → ReflexRouter → Pi Session → LLM/工具 → 语音旁白
        │
        ▼
SQLite: tasks / role_fitness / memories / diplomacy_* / events(HCI 事件日志)
```

关键点：

- **媒体平面刻意不包含业务 LLM**（有测试
  `tests/realtime/test_media_pipeline.py::test_media_pipeline_contains_no_business_llm`）。
- **sidecar 是大脑**：路由、角色、工具、语音旁白、任务终态与经验沉淀。
- **媒体平面在 sidecar 失联时仍能维持完整 STT/TTS**。
- 所有角色统一使用 `deepseek-flash`（`.env` 的
  `AGENT_RUNTIME_MODEL_FAST/BALANCED/DEEP` 三项都指向它）。

---

## 3. 已验证状态（2026-10-25 复验）

### 3.1 测试与构建

| 范围 | 命令 | 结果 |
|------|------|------|
| Python 媒体平面 | `uv run pytest tests/ -q --ignore=tests/performance` | **180 passed** |
| agent-runtime sidecar | `cd agent-runtime && npm test` | **637 passed / 50 files** |
| client | `cd client && npm test` | **27 passed / 3 files** |
| sidecar 类型检查 + 构建 | `cd agent-runtime && npm run check && npm run build` | **通过** |
| client 类型检查 | `cd client && npx tsc --noEmit` | **通过** |

### 3.2 任务执行闭环（真实进程 + 真实 LLM）

已实现并验收：`agent-runtime/src/tasks/task-executor.ts`。

实测方法：独立启动 `node agent-runtime/dist/index.js`，通过 WebSocket 注入一条
`voice.transcript.final`（文本：“你好，请用一句话介绍你自己。”），观察：

```
task.created → task.assigned(general)
→ voice.speech.enqueue × 3（确认 + 回答）
→ task.completed
```

落库结果：

- `tasks` 表：1 行，`status=completed`，`role_id=general`
- `role_fitness` 表：1 行，`metric=task_outcome`，`value=1.0`
- `memories` 表：1 行（经 MemoryCurator 审核后的任务摘要）

这证明 Phase 1 的“说话 → 任务 → Pi Session → 终态 → assimilation”链路是真的通了。

### 3.3 全链路语音冒烟测试（真实后端 + 真实 provider）

`scripts/voice-smoke.py` 用 aiortc 扮演浏览器：和真实客户端一样 POST `/api/offer`、
推一路麦克风音轨、开 `transcript` 数据通道，把一句合成的中文语音当作用户说话，
然后收听回复。它走的是完整真链路：VAD → STT → sidecar → LLM → TTS → 音频回传。

```bash
scripts/start.sh                                   # 先起栈
uv run python scripts/voice-smoke.py               # 默认说一句中文问候
uv run python scripts/voice-smoke.py --barge-in    # 回复开始后插话
```

2026-10-25 实测（Zhipu ASR + MiniMax TTS + DeepSeek `deepseek-flash`）：

| 指标 | 结果 |
|---|---|
| 单句"请用一句话介绍你自己" | 转写正确；Marcus 自称 Marcus；收到约 11 秒回复语音 |
| 说完 → 第一句回复文字 | 约 1.5–1.9 s |
| 说完 → 听到第一段回复音频 | 约 2.2–2.8 s |
| sidecar 侧"说完 → 首句语音入队"（`--latency`） | 0.8–1.9 s |
| 打断（`--barge-in`） | 回复音频在插话后约 0.5 s 内停止，随后回答新问题 |

这个测试能证明链路活着、能把真实回合写进 HCI 日志；**它不能评判听感**（语气、节奏、
误触发），那仍需要真人对着麦克风说。

这次冒烟测试一次性暴露并修复了四个只在真实音频链路上才会出现的缺陷，见第 6 节。

---

## 4. 在线 ASR / TTS provider 验证矩阵

> **2026-10-24 复验**（真实调用）：
> - Zhipu ASR + OpenRouter TTS 闭环通过：TTS 7.0s 音频 / 总耗时 8.6s，ASR 回喂逐字还原基准句，耗时 0.61s。
> - DeepSeek `deepseek-flash` 返回正常。
> - **MiniMax 配额已恢复**：`speech-2.8-hd` 真实合成返回 `status_code 0` 与音频数据（此前为 2056）。中文 TTS 现有 OpenRouter 与 MiniMax 两个可选项。
> - Deepgram 仍 `401`（key 无效）；AssemblyAI、Cartesia、OpenRouter 的 key 有效（200）。
> - Edge TTS 仍 `403`；VoxCPM2（LAN `192.168.2.128:8765`）仍不可达。
> - **LLM 模型改名为 `deepseek-flash`**：DeepSeek 官方 `GET /models` 现在只列出 `deepseek-flash` 与 `deepseek-v4-pro`，旧名 `deepseek-v4-flash` 仅作为别名还能调用。sidecar 的模型目录来自 pi-ai，0.82.0 只认旧名，所以把 `@earendil-works/pi-ai` 与 `pi-coding-agent` 同步升到 **0.86.0**（首个收录 `deepseek-flash` 的版本）。升级后 sidecar 类型检查、603 项测试通过，真实 LLM 端到端（说话→任务→`task.completed`，`role_fitness` 落库）通过。
> - 起完整栈前确认 8765（sidecar）、7860（后端）、1420（前端）没有被别的进程占用，否则 sidecar 会起不来。
>
> 下表以 2026-10-25 的复验为准，未复验的行保留 2026-10-18 的记录。

验证方法：直接调用项目自己的 `app/model_lab_preview.py` provider 构造器（不是
mock），用 macOS `say` 生成一段已知中文语音作为基准，并把 TTS 输出回喂 ASR
做可懂度闭环。

基准句：`你好，今天天气怎么样？我们现在开始测试语音助手。`

### ASR

| Provider / model | 状态 | 证据 |
|---|---|---|
| **Zhipu GLM ASR `glm-asr-2512`** | ✅ **可用（推荐）** | 中文基准句逐字正确：`你好，今天天气怎么样？我们现在开始测试语音助手。`；英文片段也正确；耗时 0.56–0.77s |
| AssemblyAI `universal-3-5-pro` | ⚠️ 可用，英文佳、中文有瑕疵 | 预览夹具修复后（等待流式 final 并合并多段）：英文逐字正确；中文整体正确，但开头的"你好"被写成拼音 `Ni hao.`。流式延迟约 7–9 s（含 1.5 s 收敛窗口）。中文场景仍推荐 Zhipu |
| Deepgram `nova-3-general` | ❌ 不可用 | 官方 REST 返回 `Invalid credentials`；现有 key 无效 |
| OpenRouter `qwen/qwen3-asr-flash-2026-02-10` | ❌ 不可用 | 调用返回 404；OpenRouter 当前模型列表里没有任何 ASR 模型 |

### TTS

| Provider / model | 状态 | 证据 |
|---|---|---|
| OpenRouter `microsoft/mai-voice-2` | ⚠️ 可用但慢 | 中文回喂逐字正确；但**不是流式**，一句话合成要 ~9 s（2026-10-25 实测 3.5 s 音频耗时 9.0 s），不适合做语音助手默认 |
| Cartesia `sonic-3.5` | ⚠️ 可用但慢 | 语言现在可配（`CARTESIA_LANGUAGE`，默认 `zh`）；中文回喂逐字正确，英文也正确。但一句话合成 ~6.2 s，延迟不理想 |
| **MiniMax `speech-2.8-hd`** | ✅ **可用（推荐）** | 10-18 曾因配额返回 `2056`，10-24 已恢复。一句话合成 **0.4–0.7 s**；中文回喂 ASR 可懂（`您好，今天天气怎么样？…`），英文逐字正确 |
| Edge TTS | ❌ 不可用 | Microsoft 端点返回 403（`Invalid response status`） |
| VoxCPM2-CUDA（LAN） | ❌ 当前不可达 | `http://192.168.2.128:8765` 连接失败（服务未启动/不在线） |

### 文本 LLM

| Provider / model | 状态 | 证据 |
|---|---|---|
| DeepSeek `deepseek-flash` | ✅ 可用 | 见 `docs/llm-auth-verification.md`；本次端到端测试中真实返回了中文回答 |

### 结论

当前推荐的在线组合：

```
ASR: Zhipu GLM glm-asr-2512       （批量，~0.6–0.8 s）
TTS: MiniMax speech-2.8-hd        （流式，一句 0.4–0.7 s）
LLM: DeepSeek deepseek-flash
```

选 MiniMax 做 TTS 的依据是延迟：同一句话 MiniMax 0.4–0.7 s、Cartesia ~6.2 s、OpenRouter
~9 s。代码里的默认值本来就是 MiniMax + Zhipu（`app/model_providers.py`），
`model_providers.json`（本地配置，已被 gitignore）现已与之一致。

---

## 5. 如何启动与复验

### 启动完整栈

```bash
cd /data/git_repository/sisyphus
scripts/start.sh
# sidecar:  ws://127.0.0.1:8765
# backend:  http://localhost:7860
# frontend: http://localhost:1420
# 日志: /tmp/sisyphus-sidecar.log, /tmp/sisyphus-backend.log, /tmp/sisyphus-frontend.log
scripts/start.sh stop   # 停止全部
```

注意（来自 `docs/lessons-learned.md`）：`start.sh` 只在 `dist/index.js`
**不存在**时构建。改过 sidecar 源码后必须手动
`cd agent-runtime && npm run build`，否则跑的是旧代码。

### 复验 provider

```bash
# ASR + TTS 闭环（会真实调用 API）
uv run python - <<'PY'
import asyncio, pathlib
from app.config import load_settings
from app.model_lab_preview import preview_speech, preview_transcription

TEXT = "你好，今天天气怎么样？我们现在开始测试语音助手。"

async def main():
    s = load_settings()
    wav, t1 = await preview_speech(adapter_id="cloud:speech", values={}, input_text=TEXT, settings=s)
    print("TTS", t1, "bytes", len(wav))
    text, t2 = await preview_transcription(adapter_id="cloud:transcription", values={}, audio_wav_bytes=wav, settings=s)
    print("ASR", repr(text), t2)

asyncio.run(main())
PY
```

### 全链路语音冒烟测试

```bash
START_NO_LOG_WINDOWS=1 scripts/start.sh            # 不弹 Terminal 日志窗口
uv run python scripts/voice-smoke.py               # 见 3.3；--barge-in 测打断
```

### 查看 HCI / 任务数据

```bash
scripts/query-hci-events.sh --summary   # 事件类型分布、打断次数、任务终态、转写样例
scripts/query-hci-events.sh --latency   # 每轮"说完 → 首句语音入队"延迟与汇总
sqlite3 agent-runtime/data/agent-runtime.sqlite3 \
  "SELECT id,status,role_id,goal FROM tasks ORDER BY created_at DESC LIMIT 5;"
```

---

## 6. 缺口：已修复的与仍然开放的

### 6.1 2026-10-24/25 修复的（均有测试）

这些缺陷之前文档里都没有，是做全链路语音冒烟测试时才暴露的——此前所有"验证"
都停在文字层，没有真正听过一次回复：

1. **线上语音输出从未工作。** `PreSynthQueueProcessor` 直接对一个从未启动过的
   TTS 服务调 `run_tts`，采样率为 0，OpenRouter 报
   `range() arg 3 must not be zero`，每一句回复都静默失败。
   现用 `StandaloneTTS`（`app/realtime/standalone_tts.py`）用一次性小管线驱动服务。
2. **自动模式下打断从未生效。** `VADProcessor` 只发 `VADUserStarted/Stopped`，
   而打断逻辑和语义缓冲等待的是 `UserStarted/StoppedSpeakingFrame`，自动模式下
   没有任何东西产生它们。现由 `VadTurnFramesProcessor` 补发。
3. **打断只清了待播队列，传输层缓冲里的声音照放。** 现在打断时向下游发
   `InterruptionFrame`，实测回复音频在插话后约 0.5 s 内停止。
4. **sidecar 事件序号互相冲突。** Python 桥只按 `sequence` 去重，而任务执行器、
   外交模块、Scribe 各有一个从 1 开始的独立计数器，撞号的真实事件（包括语音播报）
   会被当成重复丢掉；sidecar 重启后序号归零，同样被旧记录吞掉。现用进程级
   `EventSequencer`（`agent-runtime/src/protocol/sequence.ts`，按时钟播种，
   重启后天然更大）。
5. **回复里的 Markdown 会被念出来**（`**加粗**` 读成"星星"）。现在送 TTS 前剥掉
   强调、标题、列表、链接、代码。
6. **TTS 默认选错。** OpenRouter 合成一句要 ~9 s，改为 MiniMax（0.4–0.7 s）。

同批完成的重启文档 P0/P1 项：

- HCI 事件日志完整：媒体面补发 `voice.user.started/stopped`、`voice.transcript.partial`、
  `voice.speech.cancel`；工具调用生命周期（名称、截断后的参数、耗时、结果大小）落
  `events` 表；`--latency` 能按轮算延迟，`--summary` 能数打断；表有 20 万行保留上限。
- 流式 ASR 预览夹具会等 final、合并多段，不再截断。
- Cartesia 语言可配（`CARTESIA_LANGUAGE`，默认 `zh`），不再写死英文。
- `scripts/start.sh` 在 `dist/` 比源码旧时自动重建，不再静默跑旧代码。
- `pheromone` 增量不再恒为 `null`：任务带 `taskFeature`，按（任务特征、角色、设备、
  网络）路径强化/惩罚并落 `pheromones` 表（设备 `AGENT_RUNTIME_DEVICE_ID`，默认主机名；
  网络 `AGENT_RUNTIME_NETWORK_ID`，默认 `default`）。
- 所有面向用户的角色提示词、页面标题改为以 Marcus 自称。

### 6.2 仍然开放的

1. **真人麦克风/扬声器对话未人工验证（P0，只能由人做）。**
   冒烟测试用的是合成语音，证明了链路，但证明不了听感：语气与节奏、嘈杂环境下的
   VAD 误触发、真实口音的识别率、免提下的回声。请对着麦克风跑几轮，把观察记进
   `docs/hci-observations.md`。
2. **句中停顿会把一句话切成两个回合（P1，需要真人声音调参）。**
   合成语音"你好，请用一句话介绍你自己"在逗号处停顿，Zhipu 是整段批量识别，VAD
   一停就出结果，于是产生两个任务、Marcus 答两遍。语义缓冲的 flush 超时是 0.5 s，
   VAD 停顿时长还没有按真人语速调过；调大会增加每一轮的等待，需要用真实数据权衡。
3. **首句回复延迟 ~2.2–2.8 s（P1）。** 构成：VAD 停顿 + Zhipu 批量转写 ~0.6 s +
   路由与首句确认 + MiniMax 首包。已无明显浪费，进一步降低需要流式 ASR（但 AssemblyAI
   中文有瑕疵，Deepgram key 失效）。
4. **蜂群治理未参与决策（P2，刻意停放）。** Queen merge/wake、
   `PopulationRegistry.retire()` 仍无触发规则；等真实 fitness/pheromone 数据积累后再启用。
5. **树莓派硬件未调优/基准（P2，需要硬件）。** `.proj-init/performance-baseline.md`
   的 Pi 章节仍是"未测"。
6. **设备控制器仍是占位（P3）。** 邮件之外的可注入接口未接具体系统
   （systemd/launchd/IoT 网关尚未决策）。
7. **外部依赖状态：** Deepgram key 无效（401）；Edge TTS 返回 403；局域网 VoxCPM2
   不在线。以上都不影响推荐组合。

---

## 7. 下一步（建议顺序）

1. **真人对话几轮**（见 6.2-1、6.2-2），记录进 `docs/hci-observations.md`，据此调
   VAD 停顿与语义缓冲超时。
2. 收集一周 HCI 数据（`scripts/query-hci-events.sh`）后，再决定：
   - 是否唤醒蜂群治理（Queen/Population）；
   - 是否引入 oh-my-pi 的子 agent / 记忆 / 插件市场（见 ADR-001）。
3. 有树莓派硬件时做基准测试。
4. 决定设备控制器要接哪个具体系统。

---

## 8. 文档地图（哪些可信）

| 文档 | 地位 | 说明 |
|------|------|------|
| `docs/project-restart.md` | **权威入口** | 本文件；状态、provider 矩阵、下一步 |
| `README.md` / `README_CN.md` | 权威概览 | 架构、安装、引擎选择；已同步本次状态 |
| `CONTEXT.md` | 权威上下文 | 产品愿景、分层、停放策略、HCI 收集 |
| `TODO.md` | 权威待办 | Phase 1 已完成；Phase 2–5 及缺口 |
| `agent-runtime/README.md` | 权威 sidecar 说明 | 模块与已知缺口 |
| `docs/adr/0001-*.md` | 权威决策 | Phase A/B 路径与 oh-my-pi 取舍 |
| `docs/lessons-learned.md` | 经验 | 调试教训（旧进程、构建新鲜度等） |
| `docs/hci-observations.md` | 运行日志 | HCI 观察记录模板/记录 |
| `docs/llm-auth-verification.md` | 历史证据 | 2026-08-08 的 LLM 认证验证 |
| `.proj-init/*` | 设计档案 | 蜂群架构与分阶段计划；不是当前运行状态 |
| `legacy/*` | 归档 | 已放弃的翻译器原型，不要在其上开发 |

---

## 9. Git 状态（2026-10-19 收敛后）

> 2026-10-25 起 `main` 已在此基础上继续前进（改名 Marcus、`deepseek-flash`、事件日志、
> 语音链路修复等），分支拓扑仍是下面这样；以 `git log` 为准。

**开发根目录**：`/data/git_repository/sisyphus`（主仓库，`.git` 就在这里）。
orca 的 `~/orca/workspaces/sisyphus/goby` 已作为 worktree 移除，不再指向本仓库。

**整理成果**：工作区里 30+ 个未提交改动被整理成 5 个提交，全部在 `main` 上：

| 提交 | 内容 |
|------|------|
| `chore(repo)` | 取消 `tests/` 忽略规则并补回 6 个被漏掉的测试文件；忽略本地运行时产物；排除含明文 key 的 `tests/validate/` |
| `feat` | 任务执行闭环（TaskExecutor、三层确认播报、InfoHub/Scribe、媒体面 pre-synth 队列、客户端 transcript/task-nest 改版） |
| `docs` ×3 | 本文件、README/README_CN/TODO/CONTEXT 同步，归档历史笔记；分批补写重启指南与分支收敛清单 |

**收敛动作**：删除了全部本地分支（只剩 `main`）、移除了 orca worktree、
推送了 `main`。**远程分支一个未删、未 force-push。** 详见第 0 节。

当前分支拓扑（截至本文写作）：

```
main         ← 当前 HEAD = origin/main = 0b8c683（工作区干净）
origin/master              旧默认分支（origin/HEAD 仍指向它），是 main 的祖先
origin/proj-friday         收敛前的临时整理分支，远程保留
origin/feature/tauri-client 已合并，远程保留
origin/rewrite/pipecat      已合并，远程保留
origin/webrtc              未合并，翻译器时代旧线，已被 legacy/ 取代
```

---

## 10. 安全提醒

`tests/validate/test_openrouter.py` 与 `tests/validate/test_openrouter_1.py`
里含明文 OpenRouter API key。该目录已被 `.gitignore` 排除、不会提交。
**建议轮换这个 key**，因为它曾以明文形式存在于工作区。

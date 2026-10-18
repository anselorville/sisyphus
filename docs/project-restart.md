# Sisyphus Project Restart

**日期**：2026-10-18
**规范开发根目录**：`/data/git_repository/sisyphus`
**当前分支**：`proj-friday`（工作区干净）；本次整理的 4 个提交都在这里，**尚未推送**到远程
**本文用途**：这是重新开始开发时的唯一入口文档。它记录项目现在的真实状态、
已验证的能力、已知缺口、下一步顺序，以及哪些历史文档仍然可信。

---

## 0. ⚠️ 下次开工的第一件事：把本地分支收敛到 `main`

本次整理**刻意没有删除任何分支**（本地和远程都保留），这是用户的明确决定。
下次把开发会话切到 `/data/git_repository/sisyphus` 后，**第一件事**是：

```bash
cd /data/git_repository/sisyphus

# 1) 先确认工作区干净（应为空输出）
git status --short

# 2) 让 main 指向当前已验证的提交（当前 HEAD 是 proj-friday）
git switch -c main            # 若已存在 main：git switch main

# 3) 删除除 main 以外的所有本地分支
git branch | grep -v -E '^\*|^  main$' | xargs -r -n1 git branch -D

# 4) 删除 orca 的附属 worktree（可选，goby 已合并、无独有提交）
git worktree remove /Users/anse10rville/orca/workspaces/sisyphus/goby
git worktree prune

# 5) 发布（远程当前仍是旧状态；本次整理未推送）
git push -u origin main
```

注意：

- 当前默认分支是 `master`（`origin/HEAD -> origin/master`）。远程分支本次
  **未做任何改动**。如果希望 `main` 成为默认分支，需要在 GitHub 仓库设置里
  手动切换。
- 本次的 3 个提交目前只在本地（在 `proj-friday` 上，HEAD 已包含）。步骤 5 会
  把它们推上去。
- `origin/webrtc` 是翻译器时代的旧分支（10 个未合并 commit，已被 `legacy/`
  归档取代），如无需要可以不管。

---

## 1. 项目定位与演进历史

这个项目**不是**实时翻译器。翻译器是已经被放弃的 Phase-1 原型，归档在
`legacy/`，只作参考，不参与运行。

当前产品目标：

> **JARVIS** —— 一个通用个人语音助手（general voice agent），不是
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
SQLite: tasks / role_fitness / memories / diplomacy_* / events(未写入)
```

关键点：

- **媒体平面刻意不包含业务 LLM**（有测试
  `tests/realtime/test_media_pipeline.py::test_media_pipeline_contains_no_business_llm`）。
- **sidecar 是大脑**：路由、角色、工具、语音旁白、任务终态与经验沉淀。
- **媒体平面在 sidecar 失联时仍能维持完整 STT/TTS**。
- 所有角色统一使用 `deepseek-v4-flash`（`.env` 的
  `AGENT_RUNTIME_MODEL_FAST/BALANCED/DEEP` 三项都指向它）。

---

## 3. 已验证状态（2026-10-18）

### 3.1 测试与构建

| 范围 | 命令 | 结果 |
|------|------|------|
| Python 媒体平面 | `uv run pytest tests/ -q --ignore=tests/performance` | **161 passed** |
| agent-runtime sidecar | `cd agent-runtime && npm test` | **603 passed / 45 files** |
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

---

## 4. 在线 ASR / TTS provider 验证矩阵

验证方法：直接调用项目自己的 `app/model_lab_preview.py` provider 构造器（不是
mock），用 macOS `say` 生成一段已知中文语音作为基准，并把 TTS 输出回喂 ASR
做可懂度闭环。

基准句：`你好，今天天气怎么样？我们现在开始测试语音助手。`

### ASR

| Provider / model | 状态 | 证据 |
|---|---|---|
| **Zhipu GLM ASR `glm-asr-2512`** | ✅ **可用（推荐）** | 中文基准句逐字正确：`你好，今天天气怎么样？我们现在开始测试语音助手。`；英文片段也正确；耗时 0.56–0.77s |
| AssemblyAI `universal-3-5-pro` | ✅ 可用（REST 验证） | 官方 REST 接口对中文/英文都逐字正确。⚠️ 项目内 `preview_transcription` 会在流式服务返回前就关闭管线，导致截断（`Hello.` / 空），这是测试夹具限制，不是 provider 故障 |
| Deepgram `nova-3-general` | ❌ 不可用 | 官方 REST 返回 `Invalid credentials`；现有 key 无效 |
| OpenRouter `qwen/qwen3-asr-flash-2026-02-10` | ❌ 不可用 | 调用返回 404；OpenRouter 当前模型列表里没有任何 ASR 模型 |

### TTS

| Provider / model | 状态 | 证据 |
|---|---|---|
| **OpenRouter `microsoft/mai-voice-2`** | ✅ **可用（推荐）** | 中文合成后回喂 Zhipu ASR，逐字还原基准句；6.4s 音频，总耗时 ~4.4s |
| Cartesia `sonic-3.5` | ⚠️ 可用但仅适合英文 | 英文合成正常（2.5s 音频，~4.3s）；中文回喂 ASR 得到 `你好，Kindergarten怎么样？…Young Jiu Shou.`，因为 builder 把 `language` 硬编码为 `EN`，中文发音错误 |
| MiniMax `speech-2.8-hd` | ❌ 不可用 | WebSocket 返回 `status_code 2056`：“已达到 Token Plan 用量上限，请升级或购买积分” |
| Edge TTS | ❌ 不可用 | Microsoft 端点返回 403（`Invalid response status`） |
| VoxCPM2-CUDA（LAN） | ❌ 当前不可达 | `http://192.168.2.128:8765` 连接失败（服务未启动/不在线） |

### 文本 LLM

| Provider / model | 状态 | 证据 |
|---|---|---|
| DeepSeek `deepseek-v4-flash` | ✅ 可用 | 见 `docs/llm-auth-verification.md`；本次端到端测试中真实返回了中文回答 |

### 结论

当前**唯一完整可用**的在线组合：

```
ASR: Zhipu GLM glm-asr-2512
TTS: OpenRouter microsoft/mai-voice-2
LLM: DeepSeek deepseek-v4-flash
```

`model_providers.json`（运行时本地配置，已被 gitignore）已切换到这套组合。
MiniMax 配额恢复后可以切回（它的流式延迟更低），但中文 TTS 目前必须用
OpenRouter。

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

### 查看 HCI / 任务数据

```bash
scripts/query-hci-events.sh --summary   # ⚠️ events 表目前为空，见已知缺口
sqlite3 agent-runtime/data/agent-runtime.sqlite3 \
  "SELECT id,status,role_id,goal FROM tasks ORDER BY created_at DESC LIMIT 5;"
```

---

## 6. 已知缺口（按优先级）

1. **`events` 表从未写入（P0 观测缺口）**
   `agent-runtime/src/storage/database.ts` 的注释明确写着：`events` 表“为后续
   工作预留，目前没有任何命令读写它”。结果是 `scripts/query-hci-events.sh`
   永远为空，HCI 数据只能靠进程日志 + `tasks`/`role_fitness`。
   修复方向：新增 `event.record` DB 命令，并在 `RuntimeWebSocketServer` 的
   入站/广播两个 seam 上落库（一次事件一行，不要按连接重复写）。

2. **真实麦克风/扬声器对话未人工验证（P0）**
   文本事件注入 + 真实 LLM 的执行闭环已验证；但 barge-in、播报延迟的主观听感
   还没有在真实音频链路上人工跑过。

3. **流式 ASR 的预览夹具会截断结果（P1）**
   `preview_transcription` 对 Deepgram/AssemblyAI 这类 WebSocket 流式服务会在
   结果返回前关闭管线。要么给预览加“等待 final”窗口，要么在文档/UI 里明确它
   只适合 batch ASR。

4. **`pheromone` 增量仍为 `null`（P1）**
   memory 已接 MemoryCurator；pheromone 还缺 task-feature/device/network 上下文。

5. **蜂群治理未参与决策（P2，刻意停放）**
   Queen merge/wake、PopulationRegistry.retire() 还没有触发规则。等 Phase 1/2
   的真实 fitness/pheromone 数据再启用。

6. **树莓派硬件未调优/基准（P2）**
   `.proj-init/performance-baseline.md` 的 Pi 章节仍是“未测”。

7. **`diplomacy-persistence.ts` 的 `sequence` 重启归零（P2）**
   进程内自增，没有跨重启的持久化序号源。

8. **设备控制器仍是占位（P3）**
   邮件之外的可注入接口未接具体系统（systemd/launchd/IoT 网关尚未决策）。

---

## 7. 下一步（建议顺序）

1. **补 `event.record`**，让 `scripts/query-hci-events.sh` 真正可用。
2. **用真实麦克风/扬声器跑一次完整对话**，记录延迟、打断、错误路由到
   `docs/hci-observations.md`。
3. 修流式 ASR 预览夹具（或明确标注限制），避免以后误判 provider 故障。
4. 收集一周 HCI 数据后，再决定：
   - 是否唤醒蜂群治理（Queen/Population）；
   - 是否引入 oh-my-pi 的子 agent / 记忆 / 插件市场（见 ADR-001）。
5. 树莓派基准测试（有硬件时）。

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

## 9. Git 状态

**开发根目录**：`/data/git_repository/sisyphus`（这是主仓库，`.git` 就在
这里）。orca 的 `~/orca/workspaces/sisyphus/goby` 只是附属 worktree，不要
把它当作开发根。

**本次整理做了什么**：把工作区里 30+ 个未提交改动整理成 3 个提交，全部落在
当前分支 `proj-friday`：

| 提交 | 内容 |
|------|------|
| `chore(repo)` | 取消 `tests/` 忽略规则并补回 6 个被漏掉的测试文件；忽略本地运行时产物；排除含明文 key 的 `tests/validate/` |
| `feat` | 任务执行闭环（TaskExecutor、三层确认播报、InfoHub/Scribe、媒体面 pre-synth 队列、客户端 transcript/task-nest 改版） |
| `docs` | 本文件、README/README_CN/TODO/CONTEXT 同步，归档历史笔记 |

**本次刻意没做的**：没有删除任何分支、没有推送、没有动 orca 的 worktree。
收敛分支的操作清单见本文第 0 节。

当前分支拓扑（截至本文写作）：

```
proj-friday  ← 当前 HEAD，含本次 3 个提交（= 唯一需要保留的工作）
  ├─ master            落后（proj-friday 的祖先）
  ├─ feature/tauri-client   已合并
  ├─ rewrite/pipecat        已合并
  └─ anselorville/goby      已合并（orca 附属 worktree）
origin/master              proj-friday 的祖先
origin/webrtc              未合并，翻译器时代旧线，已被 legacy/ 取代
```

---

## 10. 安全提醒

`tests/validate/test_openrouter.py` 与 `tests/validate/test_openrouter_1.py`
里含明文 OpenRouter API key。该目录已被 `.gitignore` 排除、不会提交。
**建议轮换这个 key**，因为它曾以明文形式存在于工作区。

# Sisyphus Voice Agent

一个自主蜂群式（swarm）语音助手：与它对话，一群按需诞生、按需退场的专职
worker 角色（代码、网页、设备、邮件等）会在后台完成实际工作，而对外只保
持一个统一的语音出口继续对话 —— 全双工、可随时打断，并且能感知自身的资
源预算（一套「生态系统」，负载升高时自动收缩、负载下降后自动恢复）。当前
是浏览器/桌面客户端，后续目标是树莓派硬件。

运行中的系统由两个进程组成：

- **Python 媒体平面**（本仓库的 `app/`，基于
  [Pipecat](https://github.com/pipecat-ai/pipecat) 构建）：浏览器麦克风
  （WebRTC）-> Silero VAD -> 流式 STT -> 流式 TTS -> 浏览器扬声器
  （WebRTC）。这一层刻意**不**包含任何业务 LLM/推理逻辑（见
  `tests/realtime/test_media_pipeline.py::test_media_pipeline_contains_no_business_llm`）
  —— 它纯粹是音频输入输出平面。
- **TypeScript agent-runtime sidecar**（`agent-runtime/`）：真正的
  「大脑」—— 任务路由、worker 角色种姓（caste）、生态/经济预算管理、隔离
  的角色执行，以及面向语音的事件旁白。通过本地事件桥接与媒体平面通信
  （见 `app/realtime/event_bridge.py`）；即使 sidecar 不可达，媒体平面仍
  能维持完整的 STT/TTS。
- **语音客户端**（`client/`）：一个 React/Tauri 应用（浏览器开发服务器
  或原生桌面壳），通过 WebRTC 连接 Python 媒体平面，并渲染 sidecar 的任
  务/生态/提权（elevation）状态。

完整的蜂群生态设计与分阶段构建计划见 `.proj-init/`；实测性能数据（对照项
目自身的预算）见 `.proj-init/performance-baseline.md`。`legacy/README.md`
记录了本项目重写前的归档 Phase-1 原型（一个从零实现的双向语音翻译器）
—— 已被取代，不属于当前运行中的系统。

## 安装

需要 Python 3.11+ 和 [uv](https://docs.astral.sh/uv/)，以及 Node.js（
sidecar 和客户端的工具链见 `agent-runtime/package.json` 和
`client/package.json`）。

```bash
uv sync
cp .env.example .env
```

编辑 `.env`。需要填哪些 key 取决于你运行哪个 engine —— 见下方
「Engines」。默认的云端 engine 默认组合是 Zhipu GLM ASR（转写）+
MiniMax（语音合成），并可配置 Cartesia/Edge TTS/AssemblyAI/Deepgram/
OpenRouter 作为替代 —— 具体填哪些 provider 的 key，取决于你的 Model
Provider 配置选择了哪个（见 `GET/PUT /api/model-providers`，或客户端
Settings -> Model Provider 界面）。这些 key 只在云端 engine 被实际选中、
且某个 provider 真正被构建
时才会校验（也才是必需的）—— 用 `ENGINE=offline` 或 `ENGINE=omlx` 运行
时都不需要它们。

可选调整：

- `WEBRTC_HOST` / `WEBRTC_PORT`（默认 `0.0.0.0:7860`）。

注意：`ANTHROPIC_API_KEY` 和 `OLLAMA_*` 相关设置会被 `app/config.py`
读取，但目前 Python 媒体平面里没有任何 builder 会用到它们 —— 一次实际对
话的 LLM/推理步骤运行在 `agent-runtime` sidecar 里，而不在这个进程里
（见上面的架构说明）。保留这些配置项，是留给未来在媒体平面里接入本地/
Anthropic LLM 步骤的人使用。

## 运行

`scripts/start.sh` 一次性拉起全部三个部分（sidecar、backend、
frontend），会先停掉之前遗留的实例 —— 可以放心重复运行：

```bash
scripts/start.sh          # 停掉旧实例,启动 sidecar + backend + frontend
scripts/start.sh stop     # 等效于 scripts/stop.sh —— 只停止,不启动任何东西
scripts/stop.sh           # 停止全部服务
```

如果 sidecar 缺少构建产物（`agent-runtime/dist/`），脚本会先构建它；每
个进程的日志分别写到 `/tmp/sisyphus-{sidecar,backend,frontend}.log`，在
macOS 上还会自动打开对应的日志 tail 终端窗口。端口解析规则
（`.env` 里的 `WEBRTC_PORT`/`AGENT_RUNTIME_PORT`）等具体行为见脚本自身的
头部注释。

如果只想直接运行 Python 后端：

```bash
uv run python -m app.server
```

然后在浏览器打开 `http://localhost:7860`（一个最简调试页面；真正的客户
端在 `client/`），点击 **Connect**，允许麦克风权限，然后开始说话。
`GET /api/status` 报告当前生效的 STT/TTS provider 和 turn 模式；
`GET /api/agent-runtime/status` 报告媒体平面与 sidecar 的综合健康状态
（生态/食物状态、sidecar 连通性）。

**本地打断（barge-in）。** 在 manual turn 模式（默认，见下方
`TURN_MODE`）下，`app/realtime/audio_gate.py` 的
`MicGateProcessor`/`TTSOutputGateProcessor` 这一对组件负责在麦克风开/关
边界上门控麦克风输入、缓冲/打断 TTS 输出：当 agent 正在说话时打开麦克
风，会在 Python 进程本地立即清空任何已缓冲/正在播放的 TTS 音频，无需往
返 sidecar。这部分在 `tests/test_mic_gate.py` 和
`tests/test_speculative_pipeline.py` 中有帧级别的单元测试覆盖，并在
`tests/performance/test_barge_in_latency.py`
（`test_local_barge_in_cancel_p95_is_under_budget`）中有延迟预算约束。
**注意：** 这些测试只能确认门控/打断逻辑在帧层面是正确且够快的；「在真
实扬声器上打断时确实能听到声音立刻停止」这件事需要真实硬件，在当前开发
环境中（没有麦克风/扬声器）尚未做过人工验证。

更高层的语音指令（停止说话、取消、引导/纠偏、追问、开新任务）由
agent-runtime sidecar 的 Reflex Router / Interruption Router
（`agent-runtime/src/routing/`）分类，而不是 Python 媒体平面 —— 见
`agent-runtime/test/routing/interruption-router.test.ts` 和
`agent-runtime/test/routing/reflex-router.test.ts`。

### 延迟行为与日志

最终的 STT 片段会先经过一个语义缓冲区，再作为 transcript 事件发布，因此
即便某个 provider 把一句话拆成多个 final 结果，也不会触发多次 partial
事件。终止标点会立即刷新该缓冲区。一次显式的 Pipecat user-turn stop 同
样会立即刷新；如果这两个信号都没出现，无标点情况下的兜底等待时间上限
是 **500ms**。

每个 pipeline worker 都安装了 Pipecat 的 user-to-bot 延迟观察器。在后端
日志里搜索 `voice_latency` 可以看到：

```text
voice_latency user_to_bot_seconds=0.842
voice_latency first_bot_speech_seconds=0.315
voice_latency breakdown=LatencyBreakdown(...)
```

第一个指标覆盖的是「用户说完话」到「机器人可听见的语音开始」之间的时
间。breakdown 包含了 metrics 开启期间 Pipecat 能归因到的各项服务耗
时，例如 STT 最终化、TTS 首字节时间，以及文本聚合耗时。

## Engines

STT/TTS 媒体平面有三种 engine，运行的都是完全相同的 pipeline *形状*
（VAD -> STT -> TTS，见 `app/realtime/media_pipeline.py`）—— 区别只在于
具体用哪个 STT/TTS 服务实现。（LLM/推理不属于这里的选择范围 —— 见本文
最上方的架构说明。）

| Engine    | STT                  | TTS                        | 能否跑树莓派? | 何时使用 |
|-----------|----------------------|------------------------------|--------------|-------------|
| `cloud`   | Zhipu GLM ASR（默认）/ Deepgram / AssemblyAI / OpenRouter | MiniMax（默认）/ Cartesia / Edge TTS / OpenRouter / VoxCPM2-CUDA | 可以（需要联网） | 生产环境 / 有网络时 |
| `offline` | `faster-whisper`（`WhisperSTTService`） | Piper（`PiperTTSService`） | **可以** —— 真正的树莓派目标平台 | 无网络、未来跑在树莓派硬件上时 |
| `omlx`    | oMLX 服务（`/v1/audio/transcriptions`） | oMLX 服务（`/v1/audio/speech`） | **不行 —— 仅限 Apple Silicon/MLX** | 在 Mac 上快速本地开发/测试，零云端花费，零网络依赖 |

通过 `.env` 里的 `ENGINE` 选择 engine：

```
ENGINE=auto      # (默认) 启动时探测网络;有网用 cloud,没网用 offline
ENGINE=cloud     # 始终使用云端(已配置的云端 STT/TTS provider)
ENGINE=offline   # 始终使用可移植到树莓派的本地兜底方案(faster-whisper + Piper)
ENGINE=omlx      # 始终使用仅限 Mac 的 oMLX 开发/测试 engine
```

旧版的 `FORCE_OFFLINE=true` / `FORCE_ONLINE=true` 开关依然有效（它们内
部分别映射到 `ENGINE=offline` / `ENGINE=cloud`），前提是 `ENGINE` 本身
没有被设置；同时设置两者会导致启动报错。只要设置了 `ENGINE`，它总是优
先于这两个旧开关生效。

**重要提示：`omlx` 现在不是、以后也永远不会是树莓派目标方案。** 它依赖
[MLX](https://github.com/ml-explore/mlx)（Apple 为 Apple Silicon 打造
的数组框架）—— 它没有 Linux/树莓派后端，以后也不会有。它存在的唯一目的
是让你能在 Mac 上快速迭代这个产品（不花云端 API 费用、不依赖网络、本地
模型速度快），不要把这套开发工作流和真正的树莓派可移植性工作搞混 ——
后者始终、只能是 `offline` engine 的职责（faster-whisper + Piper，两者
都能跑在 Linux/ARM 上）。

### oMLX 配置（仅限 Mac 的开发 engine）

需要本机已经有一个正在运行的 oMLX 服务（默认地址
`http://127.0.0.1:6789`），已加载好 STT 和 TTS 模型，并通过其兼容
OpenAI 的 `/v1/audio/transcriptions` 和 `/v1/audio/speech` 接口提供服
务。这套自定义 service 子类背后的完整设计理由见 `app/mlx_services.py`。

在 `.env` 中设置：

```
ENGINE=omlx
OMLX_BASE_URL=http://127.0.0.1:6789/v1
OMLX_API_KEY=<你本地的 oMLX key>
OMLX_STT_MODEL=<你配置的 oMLX STT 模型>
OMLX_TTS_MODEL=<你配置的 oMLX TTS 模型>
```

`OMLX_LLM_MODEL` 也会被读取（用于 Model Lab / model-provider 的
「local」模式界面），但目前 Pipecat 媒体 pipeline 本身并没有内置任何
LLM。

## 离线/本地兜底方案（树莓派目标平台）

这个项目的最终目标是作为一个便携的旅行语音助手运行在树莓派上，在那种场
景下 wifi/网络流量经常不可用。为此，STT/TTS 两个阶段各自都有一个推理时
完全不需要联网的本地等价实现：

| 阶段 | 云端（默认） | 本地/离线兜底 |
|-------|------------------|-------------------------|
| STT | Zhipu GLM ASR（或 Deepgram/AssemblyAI/OpenRouter） | 通过 Pipecat 的 `WhisperSTTService` 使用 `faster-whisper` |
| TTS | MiniMax（或 Cartesia/Edge TTS/OpenRouter/VoxCPM2-CUDA） | 通过 Pipecat 的 `PiperTTSService` 使用 Piper |

**选择只发生一次，在 pipeline 构建时。** `app/server.py` 会为每个 WebRTC
连接构建一条 pipeline；此时 `app/providers/transcription.py` 的
`select_engine()` 会解析 `ENGINE`（见上方「Engines」）—— 在
`ENGINE=auto` 下，它会检测网络连通性（`app/connectivity.py`，一个对
`1.1.1.1:53` 的快速 TCP 探测，超时 2 秒），没有网络就使用离线组合。对话
过程中不会中途切换 —— 一条 pipeline 一旦为某个连接构建完成，就会一直使
用它启动时选定的那一套组合。

### 搭建本地方案

1. **本地 STT（faster-whisper）** —— 除了 `uv sync`（见
   `pyproject.toml` 的 `whisper` extra）之外无需额外安装。模型
   （`WHISPER_MODEL`，默认 `small`）会在首次使用时自动从 Hugging Face
   下载并本地缓存。`small` 对树莓派 5 来说是一个合理的多语言体量/精度权
   衡；如果实机跑起来太慢可以降到 `base`/`tiny`，如果算力有富余想要更好
   的精度可以升到 `medium`。不要在树莓派上使用 `large`。

   > Apple Silicon 开发机注意事项：Pipecat 的
   > `pipecat.services.whisper.stt` 模块在 Darwin/arm64 主机上会无条件
   > 尝试 import `mlx_whisper`（即使你只想用这里用到的
   > faster-whisper 后端）。如果你在 Apple Silicon Mac 上开发，并且确
   > 实想在本地构造出 `WhisperSTTService`，需要执行
   > `uv add "pipecat-ai[mlx-whisper]"`（注意：这会连带装入
   > `torch`，所以这只是一个开发便利选项 —— 树莓派/Linux 目标平台永远
   > 不会走到这条代码路径）。`app/local_services.py` 是延迟（在函数内
   > 部而不是模块顶层）import Pipecat 的 Whisper 类的，专门是为了让
   > `import app.local_services` 在没装这个 extra 的 Mac 上也能成功 ——
   > 只有真正*构造*本地 STT 服务时才需要它。

2. **本地 TTS（Piper）** —— 除了 `uv sync`（见 `pyproject.toml` 的
   `piper` extra）之外无需额外安装。语音模型（`PIPER_VOICE`，默认
   `en_US-lessac-medium`）会在首次使用时自动下载到 `PIPER_DOWNLOAD_DIR`
   （默认 `./models/piper`）。请选择与你想要的语言匹配的语音 —— 可选项
   见 [Piper 的语音列表](https://github.com/OHF-Voice/piper1-gpl)。

两者的模型下载完成后都能完全离线运行 —— 只有首次运行的模型下载需要联
网。

## 已实现内容

- `app/config.py` —— 环境变量加载（通过 `python-dotenv`）、engine 选择
  （`ENGINE`，兼容 `FORCE_OFFLINE`/`FORCE_ONLINE` 旧开关 ——
  `_resolve_engine()`），以及离线兜底（`WHISPER_MODEL`、`PIPER_*`）和
  oMLX（`OMLX_*`）相关设置。
- `app/realtime/media_pipeline.py` —— 为一个 WebRTC 连接构建 STT -> TTS
  媒体 pipeline（不含业务 LLM —— 见
  `tests/realtime/test_media_pipeline.py`），接入 manual turn 模式的麦
  克风门控，并通过 `build_pipeline_worker` 把它包装进带有延迟观察器的
  `PipelineWorker`。
- `app/providers/` —— STT（`transcription.py`）和 TTS（`speech.py`）的
  provider 选择：解析 `ENGINE`，分派到云端（Zhipu/Deepgram/
  AssemblyAI/Cartesia/Edge TTS/MiniMax/OpenRouter/VoxCPM2-CUDA）、离线
  （`app/local_services.py`）或 oMLX（`app/mlx_services.py`）的 service
  builder。
- `app/realtime/` —— 实时媒体平面的其余部分：音频门控
  （`audio_gate.py`）、turn 检测与语义句子缓冲区（`turn_detection.py`）、
  transcript 事件发布（`transcription.py`）、出站语音队列
  （`speech_queue.py`/`queueing.py`）、实时事件契约（`events.py`），以
  及 sidecar 事件桥接（`event_bridge.py`）。
- `app/model_providers.py` / `app/model_settings.py` /
  `app/model_adapters/` —— 「Model Provider」（每种能力由哪个
  provider/model 提供）和「Model Lab」（调优当前生效的
  provider/model）这两个配置界面，支撑 `/api/model-providers` 和
  `/api/model-lab/*`。
- `app/connectivity.py` —— `ENGINE=auto` 用于自动选择云端/离线的启动时
  网络连通性探测。
- `app/server.py` —— 提供客户端页面的 FastAPI/uvicorn 应用、
  `/api/offer` WebRTC 信令端点（`SmallWebRTCTransport`）、
  `GET /api/status` / `GET /api/agent-runtime/status`，以及 Model
  Provider/Model Lab/语音库相关的 HTTP 接口。
- `app/static/index.html` —— 最简单页兜底客户端（连接按钮、状态指示、
  transcript 日志），纯 HTML/JS，无需构建步骤。真正的客户端在
  `client/`。
- `agent-runtime/` —— TypeScript sidecar：协议/传输层、worker 角色与种
  姓（caste）、任务路由、生态/经济预算管理、隔离的角色执行，以及语音旁
  白。完整设计见 `.proj-init/`，测试套件见 `agent-runtime/test/`。
- `client/` —— React/Tauri 语音助手前端（`AgentHomeScreen` 及其子树：
  对话控制、任务巢（task nest）、生态面板、提权对话框），以及
  Settings/Model Lab/Model Provider 配置界面。

## 已知缺口（另行跟踪，不属于本阶段）

- 尚未针对真实树莓派硬件做适配/调优 —— 目前本地方案的选择（模型体量
  等）只是合理的起点，尚未在树莓派 5 上做过实测基准；见
  `.proj-init/performance-baseline.md` 的树莓派章节，该部分明确标注为
  等待真实硬件到位后再验证。
- 云端/本地的选择只在启动时发生一次；本阶段设计上没有对话过程中重新检
  测网络状态或自动恢复的机制。
- 针对真实硬件（麦克风、扬声器）和真实云端/LLM 凭据的完整端到端语音对
  话，在当前开发环境中尚未做过人工验证 —— 具体哪些内容已验证、哪些尚未
  验证、验证方式是什么，见
  `.proj-init/06-software-release-acceptance.md`。

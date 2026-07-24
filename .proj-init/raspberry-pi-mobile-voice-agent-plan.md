# Raspberry Pi 4 Mobile Voice Agent 改造计划

日期：2026-07-25  
目标设备：Raspberry Pi 4 Model B，4GB RAM，Ubuntu 22.04  
现有项目：Sisyphus Translator，已从实时翻译助手逐步演进为可迁移语音助手雏形

## 1. 结论先行

这台 4GB 的 Raspberry Pi 4 可以被改造成一个可移动 voice agent，但推荐采用“云优先、本地兜底”的产品形态，而不是一开始就追求完全离线、完全本地大模型。Pi 4 的 CPU 和 4GB 内存足够支撑 WebRTC 音频接入、VAD、轻量 Whisper/faster-whisper、Piper TTS、状态面板、热点/联网管理和系统服务；但它不适合承担低延迟、高质量的本地 LLM 对话主力。

最落地的一期方案是：

- 电源：使用 5V/3A 以上稳定输出的 USB-C 移动电源，优先选支持常开低电流模式或 UPS HAT 的方案。
- 网络：不需要额外 Wi-Fi 模块，Pi 4 自带 2.4GHz/5GHz Wi-Fi；移动网络优先用手机热点，独立版本再加 USB 4G 网卡或 4G HAT。
- 音频：不要依赖显示器/浏览器麦克风；加一个 USB 免驱麦克风或 USB 声卡 + 领夹麦克风，再加一个小型 USB/3.5mm/蓝牙音箱。
- 软件：保留现有 Pipecat 管线和 `CONVERSATION_MODE=assistant`，新增设备模式、系统服务、自启动、网络状态、音频设备检测、电池/电源提示、手机控制页面。
- 模式：在线时走 cloud provider，弱网或断网时降级到 offline 翻译/简短助手能力；真正的移动 AI 助手体验依赖在线 LLM。

## 2. 根据照片确认的现有硬件

照片中能确认的物品：

- Raspberry Pi 4 Model B，4GB RAM。
- 带主动风扇的外壳。
- 5V/3A 电源适配器。
- GPIO 对照板。
- USB 摄像头模块。
- 3.5 inch RPi Display，480x320，XPT2046 触控控制器。
- 树莓派 Linux/编程资料。

当前硬件的价值判断：

- Pi 4B 4GB：可作为移动语音终端主控。
- 5V/3A 适配器：适合桌面调试，不是移动方案。
- 带风扇外壳：有利于长时间跑 WebRTC、Whisper、浏览器 UI。
- 3.5 寸屏：可做状态屏和备用触控控制，但第一期不建议强依赖它，因为驱动和小屏 UI 会增加复杂度。
- USB 摄像头：不是 voice agent 一期必需品，可作为二期“看图问答/视觉记忆”扩展。
- GPIO 对照板：后续接实体按键、LED、电源状态脚位时有用。

## 3. 产品目标

一期目标是做成“能带出门、能独立启动、能用手机或小屏操作的语音助手”：

1. 插上移动电源后自动开机并启动后端。
2. 自动连接已知 Wi-Fi；无 Wi-Fi 时可创建本机热点或等待手机热点。
3. 手机打开一个本地网页即可连接、说话、听回答。
4. 在线时使用云端 ASR/LLM/TTS 获得较好延迟和质量。
5. 断网时提供最小可用能力：本地语音识别 + 小模型文本处理 + Piper TTS，或者明确提示“离线能力有限”。
6. 支持手动按键/页面按钮控制收音，避免嘈杂环境误触发。
7. 有清楚的设备状态：电源、网络、服务、音频输入、引擎模式。

二期目标：

- 独立 4G/5G 联网。
- 实体按键、LED、音量旋钮。
- 小屏常驻状态页。
- 摄像头视觉能力。
- 更完整的记忆、工具调用和任务自动化。

## 4. 推荐硬件改造

### 4.1 电源方案

Pi 4 的官方级别供电目标是 5V/3A。你照片里的适配器正好是 5V/3A，但移动场景需要移动电源、UPS HAT 或电池管理板提供同等级稳定输出。

推荐分三档：

| 档位 | 方案 | 优点 | 风险 | 推荐度 |
| --- | --- | --- | --- | --- |
| A | USB-C 移动电源，5V/3A 输出 | 最简单、便宜、安全 | 有些充电宝低电流自动断电；线材压降会导致低电压告警 | 一期推荐 |
| B | Raspberry Pi UPS HAT，18650/锂电池 | 可边充边用，可读电量，可安全关机 | 发热、安装空间、供电质量取决于板子 | 二期推荐 |
| C | 自制锂电 + 升压模块 | 体积可控、可定制 | 安全风险高，需要电池保护、电流余量、外壳绝缘 | 暂不推荐 |

一期建议采购：

- 10000mAh 或 20000mAh 移动电源，明确支持 5V/3A 或 USB-C PD 5V/3A。
- 短而粗的 USB-C 供电线，长度尽量小于 30cm。
- 可选 USB 电压电流表，用于确认负载下仍接近 5V。

续航粗估：

- Pi 4 + 风扇 + Wi-Fi + USB 麦克风 + 轻量服务：约 4W-8W。
- 10000mAh 充电宝按 3.7V 标称约 37Wh，考虑转换损耗后可用约 25Wh-30Wh。
- 预估续航约 3-6 小时，具体取决于模型、音箱、屏幕和网络模块。

### 4.2 网络方案

Pi 4 自带 Wi-Fi，因此“不差 Wi-Fi 模块”。真正要补的是移动网络接入方式。

推荐顺序：

1. 一期：手机热点。
   - Pi 保存手机热点 SSID 和密码。
   - 出门时手机开热点，Pi 自动连接。
   - 优点是稳定、低成本、无需 4G HAT 驱动。

2. 一期增强：Pi 自建热点。
   - 没有外网时，Pi 开一个 `Sisyphus-Setup` 热点。
   - 手机连上后访问 `http://10.42.0.1:7860` 管理设备。
   - 适合离线配置、查看状态、改 Wi-Fi。

3. 二期：USB 4G/5G 网卡。
   - 比 HAT 更少占用 GPIO 和外壳空间。
   - Ubuntu 22.04 通常可用 NetworkManager/ModemManager 管理。
   - 推荐优先选免驱 RNDIS/ECM 模式设备。

4. 二期高级：4G/LTE HAT。
   - 适合做真正一体化设备。
   - 需要处理天线、SIM 卡、供电峰值、串口/USB 模式和散热。

### 4.3 音频方案

语音助手的一期体验，音频比屏幕更关键。

推荐路线：

| 角色 | 一期建议 | 二期建议 |
| --- | --- | --- |
| 麦克风 | USB 免驱麦克风或 USB 声卡 + 领夹麦 | ReSpeaker USB Mic Array 或 I2S 麦克风阵列 |
| 扬声器 | 小 USB 音箱、3.5mm 有源音箱或蓝牙音箱 | 内置小功放 + 3W 扬声器 |
| 控制 | 手机网页按钮 | GPIO 物理 PTT 按键 |

注意：

- 不建议一期就上 I2S 麦克风阵列，驱动、声卡路由、回声消除都会拖慢进度。
- 如果用外放扬声器，建议默认 `TURN_MODE=manual`，也就是按下说话、松开/再按结束，避免扬声器声音回灌进麦克风。
- 后续如要 hands-free，需要回声消除、VAD 参数、唤醒词和噪声测试一起做。

### 4.4 屏幕与实体交互

3.5 寸屏可以保留，但不要作为一期主路径。

一期 UI：

- 手机浏览器作为主控制器。
- Pi 后端提供移动端友好的设备控制页。
- 屏幕可暂时只显示终端或简单状态页。

二期 UI：

- 3.5 寸屏常驻展示：
  - 网络状态。
  - 当前引擎：cloud/offline。
  - 电量或外接电源状态。
  - 麦克风状态。
  - 最近一句识别/回复摘要。
- GPIO 按键：
  - 单击：开始/结束说话。
  - 长按：断开/重连。
  - 双击：切换翻译/助手模式。
- LED：
  - 绿色：在线可用。
  - 蓝色：正在听。
  - 白色：正在说。
  - 红色：网络/音频/电源错误。

## 5. 现有软件项目判断

当前项目已经具备以下基础：

- 后端基于 FastAPI + Pipecat。
- WebRTC 音频连接已存在。
- 支持 `ENGINE=auto/cloud/offline/omlx`。
- 离线路线已有：
  - STT：`faster-whisper`/`WhisperSTTService`。
  - LLM：Ollama。
  - TTS：Piper。
- 已有 `CONVERSATION_MODE=translator/assistant`。
- 默认 `TURN_MODE=manual`，这很适合移动设备和嘈杂环境。
- 前端已有 React/Vite，支持连接后端、麦克风控制、转录记录、设置页面。
- 有模型实验室、provider 配置和若干语音能力适配器。

当前主要缺口：

1. 项目仍偏“开发机 + 浏览器客户端”形态，不是“设备固件/服务”形态。
2. 前端默认仍像应用界面，不是移动设备控制面板。
3. Pi 部署脚本、systemd 服务、健康检查、日志轮转还未产品化。
4. 音频输入/输出设备没有设备级探测和配置向导。
5. 网络状态、热点配置、移动网络状态未接入 UI。
6. 电池/低电压/温度状态未接入 UI。
7. 离线 assistant 的能力边界需要明确，否则 Pi 4 上会出现“能跑但不好用”的体验。
8. 没有针对 Raspberry Pi 的验收脚本和性能基线。

## 6. 推荐系统架构

```text
手机浏览器 / 3.5寸屏
        |
        | HTTP + WebRTC
        v
FastAPI Device Server
        |
        +-- Device Status API
        |   +-- network: Wi-Fi/热点/4G
        |   +-- power: 低电压/电量/温度
        |   +-- audio: 输入/输出设备
        |   +-- engine: cloud/offline
        |
        +-- Voice Session API
        |   +-- Pipecat WebRTC transport
        |   +-- manual mic gate
        |   +-- transcript stream
        |
        +-- Agent Runtime
            +-- online: cloud ASR + cloud LLM + cloud TTS
            +-- offline: faster-whisper + Ollama + Piper
            +-- fallback: text-only or short local replies
```

建议把“语音助手”拆成三层：

1. Device Layer：负责设备状态、网络、电源、音频、服务自启动。
2. Voice Runtime Layer：负责 WebRTC、麦克风门控、ASR/LLM/TTS 管线。
3. Agent Layer：负责助手人格、工具、记忆、模式切换。

这样后面接摄像头、实体按键或 4G 模块时，不会污染 Pipecat 管线核心。

## 7. Realtime Voice Agent 架构修订

前面的计划把重点放在“移动硬件 + 设备化部署”上，但真正要做成智能 voice agent，还有一个更关键的问题：现有管线更像 speech-to-speech translator，而不是完整 realtime voice agent。它的 LLM 节点只是一个普通文本模型调用，加一段系统提示词；没有 agent harness、工具治理、长期任务调度、session tree、权限边界、可观察事件，也没有把 VAD、打断、回声、流式反馈这些实时语音体验作为一等公民处理。

### 7.1 Pipecat 是否是最优架构

结论：Pipecat 适合继续保留，但定位要收窄。它应该是 media plane，不应该承担完整 agentOS。

Pipecat 的优势：

- 很适合编排音频输入、WebRTC transport、STT、LLM、TTS、frame processor。
- 官方定位就是 voice/multimodal pipeline，支持 transports、VAD、pipeline frame processing、worker/bus 等结构。
- `SmallWebRTCTransport` 适合当前 Pi + 手机局域网场景，能做 bidirectional audio/video/data channel。
- 当前项目已经围绕 Pipecat 写了大量管线、手动 mic gate、transcript tap、provider 适配和测试，直接推翻成本很高。

Pipecat 的不足：

- 它的主模型是“实时媒体管线”，不是完整 agent runtime。
- 如果把长时工具调用、规划、记忆、session branch、权限、复杂状态都塞进 Pipecat 的 LLM processor，实时语音链路会被 agent 任务拖慢。
- 原管线仍偏 turn-based：用户说完 -> STT final -> LLM -> TTS；与真正 full-duplex assistant 仍有差距。
- VAD 当前只是 turn boundary 的基础能力，还缺抗噪增强、speaker gating、echo suppression、barge-in recovery、overlap speech 策略。

因此推荐架构不是“Pipecat vs Pi 二选一”，而是：

```text
Realtime Media Plane                       Agent Runtime Plane
--------------------                       -------------------
WebRTC / Audio IO
VAD / AEC / Barge-in
Streaming STT
Fast Reply Policy        <---- events ---> Pi Agent Harness
TTS / Playback Gate                       Tools / Skills / Memory
Session State Mirror                       Long-running tasks
```

Pipecat 负责“听见、判断、打断、说出来”。Pi 负责“思考、调用工具、管理状态、执行长任务”。

### 7.2 为什么不能把 Pi 直接放进语音热路径

用户的语音体验有一个硬约束：第一反馈必须快。复杂 agentOS 的天然倾向却是慢：它会计划、读上下文、调用工具、等待外部系统、压缩记忆、分支 session。把这些动作都放在用户正在等待下一句话的链路里，会造成“我说完以后一直等”的体验。

所以语音交互要拆成两类响应：

1. Hot path response：必须在 300ms-1200ms 内开始反馈。
   - “我在看。”
   - “可以，我先帮你记下。”
   - “这个需要查一下，我边查边告诉你。”
   - 简短问答、确认、澄清、取消、打断。

2. Cold path agent work：可以持续数秒到数分钟。
   - 多步工具调用。
   - 文件/网页/代码/日程/邮件处理。
   - 长期记忆整理。
   - 复杂规划。
   - 后台任务。

这意味着 Pi agent harness 应该异步化接入，而不是替换掉每一轮 LLM 调用。

### 7.3 推荐的双层 brain 设计

新增一个 `Voice Orchestrator`，它不等同于 LLM，也不等同于 Pi agent。它负责决定每句话走哪条路径。

```text
User speech final/partial
        |
        v
Voice Orchestrator
        |
        +-- Reflex Brain
        |   - 超低延迟
        |   - 小模型或云端 fast model
        |   - 只做短回复、澄清、打断处理、任务确认
        |
        +-- Pi Agent Bridge
            - 调用 pi SDK/RPC
            - 工具、skills、session、memory
            - 事件流回传给语音层
            - 支持后台继续运行
```

Reflex Brain 的职责：

- 快速判断意图类型：闲聊、问答、设备控制、长任务、取消、继续、澄清。
- 对长任务立即生成 spoken acknowledgement。
- 对 Pi 的流式事件做口语化摘要。
- 在用户打断时决定取消、暂停、改目标，或只让 TTS 停止但 Pi 后台继续。

Pi Agent Bridge 的职责：

- 把用户请求转为 Pi session prompt。
- 监听 Pi event stream，包括 text delta、tool execution、turn end、error。
- 把 Pi 的事件压缩成 voice-friendly events：
  - `agent_started`
  - `tool_started`
  - `tool_progress`
  - `partial_answer`
  - `needs_clarification`
  - `agent_done`
  - `agent_failed`
- 为语音层提供取消、暂停、恢复、follow-up、steer。

### 7.4 Pi 的嵌入方式

Pi 提供两条适合当前项目的路径：

1. SDK 嵌入。
   - Node.js 进程内直接使用 `@earendil-works/pi-coding-agent`。
   - 优点：事件和状态访问最完整；custom tools/extensions 更自然。
   - 缺点：当前后端是 Python/FastAPI/Pipecat，需要新增一个 Node sidecar 或把 agent runtime 独立成服务。

2. RPC/JSONL 子进程。
   - Python 后端启动 `pi --mode rpc --no-session` 或一个自定义 Pi RPC sidecar。
   - 优点：语言边界清楚，Python 只通过 JSON RPC 交互；故障隔离更好。
   - 缺点：事件协议、生命周期和错误恢复需要自己封装。

推荐一期采用 Node sidecar + HTTP/WebSocket bridge：

```text
Python FastAPI + Pipecat
        |
        | localhost WebSocket / HTTP
        v
Node Pi Voice Bridge
        |
        v
Pi SDK AgentSession
```

理由：

- Pi SDK 文档明确支持 programmatic embedding、custom UI、custom tools、event subscription、session management。
- SDK 可以直接订阅 `message_update`、`tool_execution_start`、`tool_execution_update`、`turn_end` 等事件。
- Python 侧保持稳定，Pi 侧按 Node/TypeScript 生态演进。
- sidecar 崩溃不应带崩 WebRTC 会话；FastAPI 可以降级回普通 LLM 节点。

### 7.5 Full-duplex 和 VAD 增强路线

真正 voice agent 的体验不只是“能打断 TTS”，而是：

- 用户可以在助手说话时插话。
- 助手能立刻停止播放。
- 系统能区分用户声音、环境噪声、助手自己的声音。
- 被打断的回复不会在下一次继续冒出来。
- agent 后台任务是否取消，是语义决定，不是单纯音频事件决定。

建议分四层增强：

1. Audio front-end：
   - 输入增益归一。
   - 能量阈值 + Silero VAD 双门控。
   - 噪声底估计。
   - 麦克风静音和播放 gate 分离。

2. Echo strategy：
   - 一期保持 `TURN_MODE=manual`，降低回声风险。
   - 二期加入浏览器/WebRTC AEC 能力验证。
   - 三期引入自声参考：TTS 播放音频作为 echo reference，做 echo suppression 或至少做 barge-in 判定抑制。

3. Barge-in policy：
   - 音频层事件：检测到用户开始说话。
   - 播放层动作：立即停止 TTS。
   - agent 层动作：根据用户话语决定 `cancel`、`steer`、`followUp` 或 `continue_silent`。

4. Streaming interaction：
   - STT partial 用于预判用户意图，但不直接提交 agent。
   - STT final/稳定片段提交 Reflex Brain。
   - Reflex Brain 可先发 ack TTS。
   - Pi agent 事件流后续分段播报。

### 7.6 Voice-friendly AgentOS 原则

为了避免 agentOS 和语音体验互相拖累，需要立几条规则：

- 任何工具调用超过 800ms，都必须先口头确认或显示状态。
- 任何超过 3 秒的任务，默认进入后台，并允许用户继续说下一件事。
- Pi agent 的原始长文本不能直接喂给 TTS，需要经过 voice summarizer。
- 工具执行日志默认不上语音，只在 UI 显示；语音只播关键进展。
- 用户打断时，TTS 停止是立即动作；agent 是否取消是二次决策。
- 每个语音 turn 都要有 `interaction_id`，和 Pi session entry 关联。
- Pi session 是长记忆，Pipecat context 是短期语音上下文，两者不能混用。

### 7.7 推荐新增模块

建议在后续实现中新增这些边界：

- `app/voice_orchestrator.py`
  - 判断短答/长任务/取消/澄清。
  - 管理 voice turn state。
- `app/pi_bridge_client.py`
  - Python 侧 Pi bridge client。
  - 发送 prompt、steer、followUp、cancel。
  - 接收 agent events。
- `agent-bridge/`
  - Node/TypeScript sidecar。
  - 使用 Pi SDK 创建 `AgentSession`。
  - 定义 voice-safe custom tools。
  - 暴露 WebSocket 事件流。
- `app/realtime_events.py`
  - 统一事件模型：audio、vad、stt、agent、tts。
- `app/barge_in_policy.py`
  - 把 VAD/STT/播放状态转为中断策略。
- `client/src/device/AgentTaskPanel.tsx`
  - 显示后台任务、工具进度、可取消状态。

### 7.8 修改后的阶段计划

原计划的 Phase 5 应改成两个阶段：

Phase 5A：Realtime Voice Runtime

- 明确 Pipecat 只做 media plane。
- 增强 VAD 与 barge-in policy。
- 增加 spoken acknowledgement。
- 增加 TTS cancel 和 playback state 的测试。
- 引入 interaction_id，把每次语音输入、TTS 输出和 agent 事件关联起来。

Phase 5B：Pi Agent Harness Integration

- 新增 Node Pi bridge sidecar。
- 使用 Pi SDK 创建 persistent agent session。
- 把语音请求分为 short response 和 background task。
- 将 Pi 事件转成 voice-friendly event。
- 前端增加后台 agent task panel。
- 失败时自动降级到原 LLM processor。

验收：

- 用户提出复杂任务后，1 秒内听到确认。
- Pi agent 可以后台执行，用户可继续发起下一轮语音。
- 用户说“停一下/算了/换个目标”时，TTS 立即停止，后台任务按语义取消或改写。
- 工具调用进度可在 UI 看到，但不会把冗长日志念出来。
- Pi bridge 挂掉时，语音会话不崩溃，并能回退到普通助手回复。

## 8. 软件改造计划

### Phase 0：建立 Raspberry Pi 设备基线

目标：先证明硬件和 Ubuntu 22.04 可稳定运行当前项目。

任务：

- 在 Pi 上安装 Python 3.11+、uv、Node.js、npm、git。
- 克隆项目并运行 `uv sync`。
- 创建 Pi 专用 `.env.pi`：
  - `WEBRTC_HOST=0.0.0.0`
  - `WEBRTC_PORT=7860`
  - `ENGINE=cloud`
  - `TURN_MODE=manual`
  - `CONVERSATION_MODE=assistant`
- 手机和 Pi 在同一 Wi-Fi 下，手机访问 `http://<pi-ip>:7860` 或前端地址。
- 验证麦克风权限、音频输出、连接状态和一轮对话。

验收：

- Pi 重启后能手动启动后端。
- 手机能连接并发起一次语音会话。
- 日志里能看到选中的 engine、连接建立、转录和回复。

### Phase 1：设备化启动与部署

目标：Pi 插电后自动启动，不依赖 SSH 手动操作。

新增建议文件：

- `deploy/pi/sisyphus-backend.service`
- `deploy/pi/sisyphus-frontend.service` 或改为后端直接托管前端静态产物。
- `deploy/pi/install.sh`
- `deploy/pi/env.example`
- `deploy/pi/README.md`
- `app/device_status.py`
- `tests/test_device_status.py`

改造点：

- 前端执行 build 后由 FastAPI 静态托管，减少 Pi 上长期运行 Vite dev server。
- systemd 管理后端：
  - 开机启动。
  - 失败自动重启。
  - 日志进入 journald。
- 增加 `/api/device/status`：
  - hostname。
  - uptime。
  - IP 地址。
  - engine。
  - CPU 温度。
  - 低电压状态。
  - 音频设备列表。
- 增加 `/api/device/health`：
  - 仅返回服务是否可用，供手机页面和 systemd watchdog 使用。

验收：

- 断电重启后 60 秒内手机可打开控制页。
- `systemctl status sisyphus-backend` 显示 running。
- `/api/device/status` 可看到网络、温度、音频设备。

### Phase 2：移动端控制页

目标：把前端从“开发实验台”收敛出一个移动设备主界面。

改造点：

- 新增 Device Home 视图：
  - 大按钮：按住/点击说话。
  - 当前模式：Assistant / Translator。
  - 当前网络：Wi-Fi / Hotspot / 4G / Offline。
  - 当前引擎：Cloud / Offline。
  - 麦克风和扬声器状态。
  - 最近对话。
- Settings 中新增设备项：
  - 后端地址。
  - conversation mode。
  - turn mode。
  - engine preference。
  - 音频输入/输出选择。
- 保留 Model Lab，但移动主界面不要默认展示过多模型调参内容。

验收：

- 手机竖屏单手可完成连接、说话、停止、听回复。
- 主界面能一眼看出设备能不能用。
- 网络断开时 UI 明确显示 cloud 不可用，而不是只显示连接失败。

### Phase 3：网络与热点策略

目标：出门后设备可被找到、可被配置。

推荐行为：

1. 开机尝试连接已保存 Wi-Fi。
2. 如果 30 秒内无网络：
   - 启动本地热点 `Sisyphus-Setup`。
   - 后端监听 `10.42.0.1:7860`。
3. 手机连入热点后可打开设备页。
4. 页面提示：
   - 当前无互联网。
   - 可继续使用离线模式，或配置 Wi-Fi/手机热点。

实现建议：

- 使用 NetworkManager/nmcli，而不是手写 wpa_supplicant。
- 新增 `app/network_manager.py` 包装：
  - 当前连接状态。
  - 扫描 Wi-Fi。
  - 保存 Wi-Fi。
  - 启动/停止热点。
- 管理接口要做本地网段限制和简单 token，避免热点开放时被随意改配置。

验收：

- 家里 Wi-Fi 存在时自动连家里 Wi-Fi。
- 家里 Wi-Fi 不存在时创建 `Sisyphus-Setup`。
- 手机能通过热点访问控制页。

### Phase 4：音频设备稳定化

目标：外接麦克风和扬声器稳定可用。

任务：

- 增加音频设备探测：
  - `arecord -l`
  - `aplay -l`
  - PulseAudio/PipeWire 默认 source/sink。
- 在 UI 中显示当前输入/输出设备。
- 增加启动前检查：
  - 没有麦克风时提示。
  - 没有扬声器时提示。
- 增加录音测试 endpoint：
  - 录 3 秒。
  - 返回 RMS/峰值/是否静音。
- 增加播放测试 endpoint：
  - 播放短提示音。

验收：

- 插入 USB 麦克风后 UI 能显示。
- 拔掉麦克风后 UI 能提示。
- 手机页面可触发录音测试和播放测试。

### Phase 5A：Realtime Voice Runtime

目标：把当前 turn-based speech pipeline 提升成 realtime voice runtime，先解决语音体验的基本盘。

任务：

- 明确 Pipecat 只承担 media plane：WebRTC、VAD、STT、TTS、播放和打断。
- 引入 `interaction_id`，把每次用户语音、STT、agent 事件和 TTS 输出关联起来。
- 增加 spoken acknowledgement：
  - 长任务先说“我在处理”。
  - 工具调用先说“我需要查一下”。
  - 异常先说“这一步失败了，我换个办法”。
- 增加 barge-in policy：
  - 用户开始说话时立即停止 TTS。
  - 等 STT 稳定后再决定取消、改写、follow-up 还是后台继续。
- 增加 TTS playback state：
  - queued。
  - speaking。
  - interrupted。
  - finished。
- 增强 VAD 输入策略：
  - 音量阈值。
  - 噪声底估计。
  - Silero VAD。
  - 手动模式和自动模式分离。

验收：

- 用户在助手说话时插话，播放能立即停止。
- 被打断的旧 TTS 不会在下一轮继续冒出来。
- 长任务 1 秒内有确认反馈。
- 每条 transcript、TTS、agent event 都能追溯到同一个 `interaction_id`。

### Phase 5B：Pi Agent Harness Integration

目标：把 `earendil-works/pi` 作为真正的 agent runtime 接入，而不是继续只用一个 LLM 节点。

任务：

- 新增 `agent-bridge/` Node/TypeScript sidecar。
- 使用 Pi SDK 创建 `AgentSession`，保留 session、tools、skills、prompt templates、context files。
- Python 后端通过 localhost WebSocket/HTTP 与 sidecar 通讯。
- 实现 Pi event -> voice event 转换：
  - `message_update` -> partial answer。
  - `tool_execution_start` -> tool progress。
  - `tool_execution_update` -> UI-only progress。
  - `turn_end` -> final answer / task done。
  - error -> spoken failure summary。
- 实现语音层控制 Pi：
  - prompt。
  - steer。
  - followUp。
  - cancel。
  - start new session。
- 给 Pi 定义 voice-safe custom tools：
  - 不直接读写危险文件。
  - 不在语音里输出长日志。
  - 工具结果先摘要再播报。

验收：

- 简单问答可以走 fast path，不必进入 Pi 长任务。
- 复杂任务进入 Pi 后台执行，用户可以继续说下一句。
- Pi 工具执行进度在 UI 显示，语音只播关键进展。
- Pi sidecar 崩溃时，FastAPI/Pipecat 会话仍能降级到普通 LLM 回复。

### Phase 6：在线/离线引擎策略

目标：避免用户在 Pi 4 上期待不现实的完全本地 AI 能力。

推荐策略：

- 默认 `ENGINE=auto`：
  - 有互联网：cloud。
  - 无互联网：offline。
- `CONVERSATION_MODE=assistant` 在线时启用完整助手。
- 离线 assistant 改成“短回答模式”：
  - 限制回答长度。
  - 禁止复杂推理。
  - 明确提示离线模式能力较弱。
- 保留 translator 离线能力作为更现实的本地 fallback。

Pi 4 上推荐离线模型：

- STT：
  - `WHISPER_MODEL=tiny` 或 `base` 作为初始基线。
  - `small` 只在实测可接受后启用。
- LLM：
  - Ollama 小模型，如 `qwen2.5:0.5b`、`qwen2.5:1.5b` 级别。
  - 不建议在 Pi 4 上追求 7B 级实时语音对话。
- TTS：
  - Piper 本地语音。

验收：

- 有网时一轮语音助手回复在可接受延迟内完成。
- 断网时系统不崩溃，UI 显示 offline，并能给出最小可用回复或清楚说明能力受限。
- 切换网络后重启服务能重新选择 engine。

### Phase 7：电源、温度和安全关机

目标：移动设备不会因为低电压或强制断电损坏系统。

任务：

- 读取 Pi 低电压状态：
  - `vcgencmd get_throttled`
- 读取 CPU 温度：
  - `vcgencmd measure_temp`
  - 或 `/sys/class/thermal/thermal_zone0/temp`
- UI 提示：
  - 低电压。
  - 过热。
  - 正在降频。
- 增加安全关机按钮：
  - 手机页面长按确认关机。
  - GPIO 长按关机。
- 如果使用 UPS HAT：
  - 接入电量、电压、充电状态。
  - 低电量自动关机。

验收：

- 使用劣质线材或低电量移动电源时能看到低电压告警。
- 手机页面可以安全关机。
- 过热时 UI 给出提醒。

### Phase 8：物理外设

目标：减少对手机页面的依赖。

建议 GPIO 外设：

- 一个大号按键：PTT 说话键。
- 一个小按键：模式切换。
- 一个 RGB LED 或三颗 LED：状态提示。
- 可选旋钮：音量。

软件任务：

- 新增 `app/gpio_controls.py`。
- GPIO 事件转换成已有 mic open/close 控制语义。
- LED 状态订阅 device status 和 session state。

验收：

- 不打开手机页面，也能按键说话。
- LED 能表达 ready/listening/speaking/error。

### Phase 9：摄像头视觉扩展

目标：把照片里的 USB 摄像头变成二期能力，而不是一期阻塞项。

能力：

- “看一下这是什么？”
- “帮我读这个标签。”
- “记住这个物品放在这里。”
- “拍照并发给远端多模态模型。”

注意：

- Pi 4 本地视觉模型不现实，建议走云端多模态。
- 摄像头涉及隐私，需要物理遮挡或明显状态灯。
- 摄像头会增加功耗。

## 9. 软件任务清单

优先级 P0：

- 写 Pi 部署文档和 `.env.pi.example`。
- 后端托管前端静态产物，减少 Vite 长驻。
- 增加 systemd service。
- 增加 `/api/device/status` 和 `/api/device/health`。
- 增加移动端主界面。
- 增加 `interaction_id` 和 TTS playback state。
- 增加 barge-in policy，确保用户插话时 TTS 立即停止。
- 在 README 增加 Raspberry Pi deployment 章节。

优先级 P1：

- 音频设备检测和测试。
- Wi-Fi/热点状态读取。
- `ENGINE=auto` 的 UI 可视化。
- 低电压/温度读取。
- 安全关机 endpoint。
- 新增 `Voice Orchestrator`。
- 新增 `agent-bridge/`，用 Pi SDK 接入 Pi agent harness。
- 将 Pi event stream 转成 voice-friendly event。

优先级 P2：

- nmcli Wi-Fi 配置页面。
- USB 4G/ModemManager 状态。
- GPIO PTT 按键和 LED。
- 3.5 寸屏 kiosk 模式。
- Agent task panel。

优先级 P3：

- 摄像头视觉能力。
- 本地记忆库。
- 唤醒词。
- 回声消除和免手动模式。

## 10. 推荐采购清单

一期必买/必备：

- 5V/3A 或更高稳定输出的 USB-C 移动电源。
- 短 USB-C 供电线。
- USB 免驱麦克风，或 USB 声卡 + 领夹麦克风。
- 小型有源扬声器或 USB 音箱。
- 32GB/64GB 高质量 microSD 卡，或 USB SSD。

一期建议：

- USB 电压电流表。
- 散热更好的外壳或更安静风扇。
- 简单收纳盒/固定板，避免线缆拉扯。

二期可选：

- USB 4G/5G 网卡，优先免驱 RNDIS/ECM。
- UPS HAT。
- GPIO 大按键。
- RGB LED。
- ReSpeaker USB Mic Array。
- 更结实的一体化外壳。

暂不建议一期购买：

- 复杂 I2S 麦克风阵列。
- 自制锂电池升压板。
- 过小容量电池。
- 无明确 Linux 支持的 4G HAT。

## 11. Raspberry Pi 上的推荐运行形态

### 在线助手

```env
ENGINE=auto
CONVERSATION_MODE=assistant
TURN_MODE=manual
WEBRTC_HOST=0.0.0.0
WEBRTC_PORT=7860
```

特点：

- 有网时体验最好。
- 使用手机页面控制。
- 适合日常移动 voice agent。

### 离线翻译/兜底

```env
ENGINE=offline
CONVERSATION_MODE=translator
TURN_MODE=manual
WHISPER_MODEL=tiny
OLLAMA_MODEL=qwen2.5:0.5b
PIPER_VOICE=en_US-lessac-medium
```

特点：

- 质量和延迟都有限。
- 适合“没有互联网也别完全死掉”的兜底。

### 桌面开发

```env
ENGINE=omlx
CONVERSATION_MODE=assistant
TURN_MODE=manual
```

特点：

- 仅 Mac 开发机。
- 不作为 Pi 目标。

## 12. 风险与规避

| 风险 | 影响 | 规避 |
| --- | --- | --- |
| 移动电源低电流自动断电 | 设备突然关机 | 选支持常开模式的移动电源，或 UPS HAT |
| 线材压降 | Pi 低电压、降频、音频异常 | 短粗线，电压表验证 |
| Pi 4 本地 LLM 太慢 | 助手体验差 | 云优先，本地只做兜底 |
| Agent harness 阻塞语音链路 | 用户说完一直等待 | Pi agent 异步后台执行，hot path 先给 spoken acknowledgement |
| Pi sidecar 崩溃 | 工具和长任务不可用 | Python 后端降级到普通 LLM 节点 |
| 麦克风拾取扬声器声音 | 自激、误识别、打断回复 | 默认 manual turn mode，外放降音量，后续做 AEC |
| 3.5 寸屏驱动复杂 | 拖慢一期 | 一期手机网页为主 |
| 4G HAT 驱动/供电复杂 | 网络不稳定 | 先手机热点，再 USB 网卡，最后 HAT |
| 强制断电损坏系统 | SD 卡损坏 | 安全关机按钮，UPS HAT，日志减少写入 |
| 热量 | 降频、卡顿 | 主动散热，温度监控，控制本地模型规模 |

## 13. 验收标准

一期完成标准：

- Pi 接移动电源启动。
- 60 秒内后端可访问。
- 手机能打开控制页。
- 能完成至少 10 轮语音对话。
- 一次完整出门测试不少于 30 分钟。
- 期间无低电压告警或服务崩溃。
- 网络断开时 UI 能明确显示离线/不可用状态。
- 重新联网后重启服务可恢复在线助手能力。

二期完成标准：

- 不依赖手机热点，能通过 4G/5G 独立联网。
- 有实体 PTT 按键和 LED 状态。
- 能从页面安全关机。
- 能在小屏上查看状态。
- 有电量估算或 UPS 状态。
- Pi agent harness 可后台执行长任务，并能通过语音打断、改写或取消。

## 14. 建议执行顺序

1. 先买移动电源、USB 麦克风、小音箱。
2. 在 Pi 上跑通当前项目的 cloud assistant 模式。
3. 做 systemd 自启动和静态前端托管。
4. 做 `/api/device/status`。
5. 做移动端主界面。
6. 做 realtime voice runtime：`interaction_id`、TTS playback state、barge-in policy。
7. 做 Pi agent bridge sidecar，把 Pi SDK 接入为后台 agent runtime。
8. 做音频检测和测试。
9. 做热点/网络状态。
10. 做电源/温度/安全关机。
11. 做 GPIO 按键和 LED。
12. 再考虑 UPS HAT、4G 模块和摄像头视觉。

## 15. 参考资料

- Raspberry Pi 4 官方规格页：<https://www.raspberrypi.com/products/raspberry-pi-4-model-b/specifications/>。Pi 4 Model B 自带 2.4GHz/5GHz Wi-Fi、Bluetooth 5.0/BLE，并通过 USB-C 5V DC 供电，最低 3A。
- Raspberry Pi 官方硬件文档：<https://www.raspberrypi.com/documentation/computers/raspberry-pi.html>。Pi 4 Model B 条目列出 USB-C power、5V at 3A、双频 Wi-Fi、Bluetooth 5/BLE。
- Raspberry Pi 官方 15W USB-C 电源：<https://www.raspberrypi.com/products/type-c-power-supply/>。官方电源输出为 5.1V/3.0A DC，面向 Raspberry Pi 4/400。
- Pi Agent Harness GitHub：<https://github.com/earendil-works/pi>。README 描述其包含 `pi-agent-core`、`pi-ai`、coding agent CLI，以及工具调用和状态管理 runtime。
- Pi SDK 文档：<https://pi.dev/docs/latest/sdk>。SDK 支持 `createAgentSession()`、事件订阅、custom tools、extensions、skills、sessions、RPC mode 等 programmatic embedding 能力。
- Pipecat 官方介绍：<https://docs.pipecat.ai/overview/introduction>。Pipecat 是用于构建 voice/multimodal AI agent 的实时 pipeline 生态。
- Pipecat speech input 文档：<https://docs.pipecat.ai/pipecat/learn/speech-input>。VAD 用于检测用户开始/停止说话，Silero VAD 可在 CPU 本地运行。
- Pipecat SmallWebRTCTransport 文档：<https://docs.pipecat.ai/api-reference/server/services/transport/small-webrtc>。SmallWebRTCTransport 提供 WebRTC bidirectional audio/video/data channel。
- 当前项目 `README.md`：已定义 cloud/offline/omlx 三引擎和 Pi-portable offline fallback。
- 当前项目 `app/config.py`：已有 `ENGINE`、`TURN_MODE`、`CONVERSATION_MODE`、Whisper/Ollama/Piper 配置。
- 当前项目 `app/pipeline.py`：已有 assistant system prompt、manual mic gate、cloud/offline/oMLX pipeline 构建路径。

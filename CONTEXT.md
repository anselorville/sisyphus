# Context — Sisyphus 语音 Agent

## 产品愿景

**Marcus**（中文译名：马库斯）：目标产品原型——一个通用个人语音助手，不是 coding-agent。覆盖日常交流（web search、通信）和技术课题的 deep research。用户身份：算法架构师。

**general-agent**：进化目标——pi-agent 从 coding-agent 演化为通用 agent。当前 pi-agent 的默认工具是代码编辑工具（bash、edit、write、grep、find、ls），但 SDK 支持任意工具（`createAgentSession({ tools })`）。让 pi-agent 成为 general-agent 的关键是**工具面和系统提示词**，不是运行时。

## 架构分层

**media plane（媒体平面）**：Python/Pipecat 进程，负责音频 I/O（WebRTC → Silero VAD → 流式 STT → 流式 TTS）。刻意不包含业务 LLM。即使 sidecar 失联也能维持完整 STT/TTS。

**agent-runtime sidecar**：TypeScript 进程，"大脑"——任务路由、角色管理、生态/经济治理、语音旁白。使用 `@earendil-works/pi-coding-agent` 0.82.0 的 `createAgentSession()` 建立 Pi Session。

**pi-agent**：`@earendil-works/pi-coding-agent` 的 SDK 入口（`createAgentSession`）。当前版本 0.82.0，Node 兼容。层级：`pi-ai`（LLM 访问层）→ `pi-agent-core`（agent 循环：工具调用+状态管理）→ `pi-coding-agent`（组合产品：CLI + SDK）。

**模型选择**：所有角色统一使用 deepseek-flash（不分 fast/balanced/deep tier）。通过 `AGENT_RUNTIME_MODEL_FAST`、`AGENT_RUNTIME_MODEL_BALANCED`、`AGENT_RUNTIME_MODEL_DEEP` 三个环境变量均设为 `deepseek:deepseek-flash` 实现。

**oh-my-pi / omp**：Pi 的完整 fork（`can1357/oh-my-pi`，22.8k star，MIT）。有自己的 npm scope `@oh-my-pi/*`、CLI `omp`、版本线 17.x。Bun-only 运行时（≥1.3.14）。添加了 LSP、DAP、浏览器自动化、子 agent、记忆、插件市场等 harness 功能。**不是插件，是 fork**。SDK 面变了：`modelRuntime`/`resourceLoader` 被移除，换成 `authStorage`/`ModelRegistry`/`Settings`。

## 当前实现状态（2026-10-18）

**任务执行编排循环：已完成并验证。** `TaskExecutor`（`agent-runtime/src/tasks/task-executor.ts`）接管 `voice.transcript.final`：ReflexRouter 决策 → `sessionManager.prompt()` → Pi session 回答 → `voice.speech.enqueue` → `task.completed`/`failed`/`cancelled` → `task.assimilate`。已用真实 sidecar 进程 + 真实 LLM 调用跑通：`tasks` 表出现 completed 行，`role_fitness` 出现 `task_outcome=1.0`。steer/follow-up/cancel 也已派发到 session manager。

**在线 provider 可用性：** 当前可用栈是 Zhipu GLM ASR（`glm-asr-2512`）+ OpenRouter TTS（`microsoft/mai-voice-2`）+ DeepSeek 文本。MiniMax TTS 账户配额耗尽（status 2056）、Deepgram key 无效、Edge TTS 403、OpenRouter 没有可用 ASR 模型。完整矩阵见 `docs/project-restart.md`。

## 关键缺口

**HCI 事件持久化**：SQLite `events` 表建了但没有任何 `event.record` 写入路径，`scripts/query-hci-events.sh` 永远为空。HCI 数据目前只能靠进程日志和 `tasks`/`role_fitness`。这是 Phase A 最优先要补的观测缺口。

**harness**：用户术语，指 agent 的工具/编排层。"完善的 harness" = 完整的工具 + 编排能力。oh-my-pi 的 harness 包括 LSP、DAP、浏览器、子 agent、记忆、插件市场。对 Marcus 相关的子集：子 agent 委派、跨会话记忆、插件市场。

**顶层编排能力**：协调多个工具/能力的结构化能力。蜂群治理（Queen/Population/GeneBank）是一种形式；oh-my-pi 的子 agent 系统是另一种。当前阶段：单 pi-agent + 扩展工具面即可，编排能力后续再议。

## 停放策略

**停放**：保留代码、不删除、不接线，等适合的场景再启用。当前停放对象：蜂群治理层（Queen/Population/GeneBank/PheromoneMap/economy）。组合根接线保留，但执行循环不调用治理决策。

**选择性释放**：7 个角色不是全部休眠——general 是入口，specialized roles（web、code、mail 等）按场景释放。Phase A 先释放 general + web（搜索场景），后续按需加 code/mail 等。角色注册表和 7 个 manifest 全部保留。

## HCI 问题收集

**HCI problem**：人机交互过程中的所有问题维度——延迟体感、打断/barge-in 失灵、错误路由、幻觉工具调用、转写错误等。用户希望收集所有维度。载体：transcript + sidecar 事件（SQLite events 表）+ 人工观察，写入 running log。

**注意**：events 表当前没有写入路径（见"关键缺口"）。在补上 `event.record` 之前，HCI 只能靠 `/tmp/sisyphus-*.log` 和 `tasks`/`role_fitness` 表。

## 决策路径

**Phase A（当前）**：用上游 `@earendil-works/pi-coding-agent` 补全编排循环，扩展 general 角色工具面，跑起来，收集 HCI 数据。蜂群治理休眠但保留。oh-my-pi 暂不引入。

**Phase B（有 HCI 数据后）**：用真实数据评估 oh-my-pi 的哪些能力（子 agent、记忆、插件市场）是真正需要的。如果需要，规划 Bun 迁移——有数据支撑的投资决策。

## Harness 期望

用户期望后期具备的完整能力清单：
- 子 agent 委派（分工协作，如 deep research 由专门 agent 执行）—— 蜂群治理已有角色委派机制
- 跨会话记忆（记住用户偏好、历史对话）—— Memory Curator 角色已存在
- 插件市场（第三方扩展能力）—— oh-my-pi 独有，上游没有
- 其他（待 HCI 数据后确定）

## 首版设计

**入口角色**：general（默认入口，接收语音指令，决定自行处理或委派给 specialized role）。

**首批释放角色**：general + web（搜索场景）。general 作为入口，当用户指令涉及搜索/信息检索时，ReflexRouter 委派给 web 角色（`web_search` + `web_fetch`）。后续按场景按需释放 code/mail 等。

**语音交互层**：Traffic Commander 是延迟掩盖的关键——在 agent 工作时给用户即时语音反馈（首次确认 700ms、进度播报 ≥5s 间隔）。VoiceHerald 做内容安全过滤（拒绝代码块、JSON、长 URL、超过 160 字、含未核实措辞的文本）。

**首个真实交互**：纯对话测试（"你好，你是谁？"），验证基本循环质量（延迟、打断、转写）。有了底数后加工具场景（web search）。

**HCI 问题收集**：所有维度（延迟体感、打断/barge-in 失灵、错误路由、幻觉工具调用、转写错误等）。载体：transcript + sidecar 事件（SQLite events 表）+ 人工观察，写入 running log（`docs/hci-observations.md`）。

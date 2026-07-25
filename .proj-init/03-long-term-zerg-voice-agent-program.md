# 长远计划书：从移动语音助手到虫群式 Agent 生态

日期：2026-07-25  
项目代号建议：Sisyphus Hive  
长期目标：构建一个可移动、可感知、可实时交互、可调度长任务、可自我演化的个人 agent 生态系统

## 1. 愿景

Sisyphus Hive 不是一个“会说话的聊天机器人”，也不是一个“树莓派外壳里的 LLM”。它应该是一个随身携带的智能生态：能听、能说、能等待、能插话、能安抚、能规划、能执行、能检测、能记忆、能变异、能淘汰旧策略，并在长期使用中形成越来越适合主人的专门化品种。

更准确地说，Sisyphus Hive 不追求创造一个复杂的中央智慧个体。它追求的是：平时由低能耗、去中心化、专业化的工种快速独立响应；当环境熵增、风险越界或任务未知度超过稳态能力时，才临时孵化高阶智力品级。高阶智力不是统治者，而是应激器官；问题解决后必须蒸馏经验、释放资源、回归稳态。

这个系统的最终形态接近一个虫群式 superorganism：

- Raspberry Pi 是移动巢穴。
- Transport 是神经和呼吸系统。
- Wake word 是入口感受器。
- Speaker verification 是身份气味识别。
- VAD/turn detection 是听觉反射。
- Traffic Commander 是语音交互中的交通指挥。
- Stress Judge 是应激裁判，只判定是否越界，不做复杂思考。
- Pi Agent Harness 是 agent 生态的孵化与运行时。
- Planner、Executor、Inspector、Memory、Scout 是不同品种。
- Temporary Intelligence Caste 是临时高阶智力品级，只在越界时出现。
- Event log、state board、task nest、pheromone map 是生态基质。
- 用户不是在调用一个模型，而是在和一个活着的系统协作。

## 2. 长期设计信条

1. 语音优先：任何复杂 agent 任务都不能破坏实时语音体验。
2. 全双工优先：系统要能边听边说，用户打断必须被尊重。
3. 快速反馈优先：超过 800ms 无反馈就需要安慰、确认或进度。
4. 生态优先：不要用一个大 prompt 假装 agentOS。
5. 分工优先：每个 agent 角色只做自己进化到极致的事。
6. 事件优先：角色通过环境痕迹协同，而不是彼此长篇聊天。
7. 权限优先：声纹、唤醒、风险等级决定能做什么。
8. 退化优先：断网、低电、过热、sidecar 挂掉时，系统要保留最小生命。
9. 进化优先：失败、延迟、重复需求都要变成下一代角色或策略的养料。
10. 主人体验优先：内部复杂性不能泄漏成冗长语音。
11. 应激优先：高阶智力只在高熵、高风险、未知任务越界时短暂出现。
12. 退场优先：临时智力品级完成任务后必须同化经验并销毁上下文。

## 3. 北极星指标

### 3.1 语音体验指标

| 指标 | 一期目标 | 长期目标 |
| --- | --- | --- |
| 用户停止说话到第一反馈 | P50 < 1.2s | P50 < 700ms |
| 插话到 TTS 停止 | P50 < 250ms | P50 < 120ms |
| 长任务首个安慰反馈 | < 800ms | < 500ms |
| 错误唤醒率 | 可手动纠正 | 每小时极低 |
| 主人声纹通过率 | 室内可用 | 嘈杂环境可用 |
| 非主人高风险指令拒绝 | 基于确认 | 默认拒绝 |
| 对话自然度 | 不沉默太久 | 能 backchannel、能恢复误打断 |

### 3.2 Agent 生态指标

| 指标 | 一期目标 | 长期目标 |
| --- | --- | --- |
| Pi sidecar 可用性 | 可连接/可降级 | 可恢复/可迁移 |
| 长任务可后台执行 | 初步支持 | 多任务并行与暂停恢复 |
| 工具执行可观察 | UI 可见 | 全链路可审计 |
| 角色分工 | 固定角色 | 动态孵化/淘汰 |
| 记忆能力 | 用户显式保存 | 自动提炼、冲突检测、遗忘 |
| 策略优化 | 手工调参 | pheromone 自动路由 |
| 自我修复 | fallback | 诊断、修复建议、自动回滚 |
| 高阶智力常驻率 | 不追求常驻 | 只有应激越界时短暂出现 |
| 应激裁判准确性 | 手工规则 | 熵/风险/未知度可解释评分 |

## 4. 发展路线总览

```text
Stage 0  现状整理
Stage 1  移动硬件生命体
Stage 2  Realtime Voice Runtime
Stage 3  Stress Judge 与应激边界
Stage 4  Pi Agent Bridge
Stage 5  Swarm Runtime Substrate
Stage 6  Voice-Native AgentOS
Stage 7  Adaptive Evolution
Stage 8  Multimodal Hive
Stage 9  Personal Superorganism
```

## 5. Stage 0：现状整理

目标：确认当前项目从 translator 迁移到 assistant 的基础可用。

已有资产：

- FastAPI server。
- Pipecat pipeline。
- WebRTC client。
- cloud/offline/omlx engines。
- manual turn mode。
- assistant mode system prompt。
- model provider/model lab 基础。
- Raspberry Pi 4 设备和外壳。

要完成：

- 明确产品命名：Sisyphus Hive 或 Sisyphus Voice。
- 保留现有 translator 能力作为模式之一。
- 以 assistant mode 作为新主线。
- 把 `.proj-init` 的三份文档作为项目初始化蓝图。

验收：

- 文档齐备。
- 现有代码现状被映射到新架构。
- 后续实施有清晰阶段。

## 6. Stage 1：移动硬件生命体

目标：让 Raspberry Pi 成为可带出门的语音终端。

硬件：

- 5V/3A 以上移动电源。
- USB 免驱麦克风。
- 小型扬声器。
- 短 USB-C 供电线。
- 可选 USB 电压表。

软件：

- Pi 专用 `.env.pi.example`。
- systemd 自启动。
- FastAPI 托管前端静态产物。
- `/api/device/status`。
- `/api/device/health`。
- 手机控制页。

验收：

- 插移动电源开机。
- 60 秒内手机可访问。
- 能完成 10 轮语音对话。
- 30 分钟出门测试无崩溃。

## 7. Stage 2：Realtime Voice Runtime

目标：从 turn-based pipeline 升级到真正的语音实时运行时。

关键能力：

- 全双工 transport state machine。
- `interaction_id` 全链路追踪。
- Wake Guard。
- Speaker Gate。
- VAD Scouts。
- Smart endpointing。
- Barge-in policy。
- TTS playback state。
- Comfort timeout。
- Audio diagnostics。

核心模块：

- `app/realtime_events.py`
- `app/reflex_router.py`
- `app/stress_judge.py`
- `app/wake_guard.py`
- `app/speaker_gate.py`
- `app/barge_in_policy.py`
- `app/tts_playback_state.py`
- `app/traffic_commander.py`

关键体验：

- 用户插话，TTS 立即停止。
- 用户说完后，系统不沉默太久。
- 长任务先反馈，再后台跑。
- 嘈杂环境下先做声纹和唤醒判断。

验收：

- 插话停止播放 P50 < 250ms。
- 用户停止说话后 P95 < 1200ms 有反馈。
- timeout 触发 Traffic Commander 安慰话术。
- 误打断能恢复或要求澄清。

## 8. Stage 3：Stress Judge 与应激边界

目标：让系统知道什么时候应该保持低能耗稳态，什么时候应该升级到专业工种协同，什么时候才值得孵化临时高阶智力品级。

Stress Judge 三轴评分：

- `entropy_score`：链路混乱度，包括连续失败、信号冲突、循环、等待无进展、用户反复纠正。
- `risk_score`：行为危险度，包括文件写入/删除、系统命令、外部发送、隐私读取、医疗法律金融安全建议、非主人高权限请求。
- `novelty_score`：任务未知度，包括无匹配 route/skill/tool、低 pheromone、新领域、新设备、新 API、所有 worker 低置信。

裁判范围：

| 分数 | 状态 | 响应 |
| --- | --- | --- |
| `0.00-0.39` | 稳态 | 固定低阶工种直接处理 |
| `0.40-0.64` | 局部扰动 | 专业 worker 或澄清问题 |
| `0.65-0.79` | 应激预警 | Planner/Inspector/Traffic Commander 协同 |
| `0.80-1.00` | 应激越界 | Temporary Intelligence Caste 临时孵化 |

注意：

- 高风险不等于高阶智力；高风险首先触发确认、隔离、审计。
- 复杂不等于未知；熟悉的复杂任务应交给专业 worker。
- 等待超时不等于应激越界；短超时先由 Traffic Commander 安慰，持续无进展才提高 entropy。
- Stress Judge 不能输出最终答案，不能规划，不能调用工具。

验收：

- 每个进入 Pi sidecar 的请求都有 stress decision。
- 每个高风险动作都能说明触发原因和确认策略。
- 每次孵化 Temporary Intelligence Caste 都有 `must_regress_after=true`。
- 完成后能把成功轨迹蒸馏为 prompt/skill/pheromone，并销毁临时上下文。

## 9. Stage 4：Pi Agent Bridge

目标：先建立应激裁判，再把 Pi Agent Harness 接入为 agent 生态运行时。Pi 不作为中央主脑常驻，而作为工种网络、任务巢穴和临时智力品级的孵化环境。

架构：

- Python/FastAPI/Pipecat 保持 media plane。
- Node sidecar 使用 Pi SDK。
- 本地 WebSocket/HTTP 连接。
- Pi events 转为 voice-friendly events。

新增目录：

```text
agent-bridge/
  src/
    index.ts
    piSessionManager.ts
    voiceEventServer.ts
    eventAdapter.ts
    roleRegistry.ts
    tools/
    prompts/
```

角色：

- Reflex Router。
- Stress Judge。
- Temporary Intelligence Caste。
- Traffic Commander。
- Reflex Agent。
- Planner Brood。
- Executor Workers。
- Inspector Soldiers。
- Memory Workers。
- Scout Mutators。
- Device Sentinels。
- Voice Stylist。

验收：

- 简单请求走 Reflex，不进入长任务。
- 熟悉的复杂请求进入 baseline worker，不唤醒高阶智力。
- 高熵、高风险、未知任务由 Stress Judge 判定是否孵化 Temporary Intelligence Caste。
- Pi sidecar 事件能进入 UI 和 TTS。
- sidecar 崩溃时语音会话不中断。
- 用户能通过语音取消、暂停、改写后台任务。

## 10. Stage 5：Swarm Runtime Substrate

目标：建立虫群生态的底层基质，让角色通过环境协同。

组件：

- Event Log：所有实时事件和 agent 事件。
- State Board：当前系统状态。
- Task Nest：后台任务巢穴。
- Pheromone Map：路径/工具/模型/提示词评分。
- Memory Substrate：长期记忆、偏好、项目知识。
- Risk Field：权限和风险状态。
- Device Field：网络、电量、温度、音频设备。

设计重点：

- 所有状态可观察。
- 所有决策可追踪。
- 所有路由可学习。
- 所有成功经验会蒸发，必须被重新验证。

验收：

- 任意一次语音交互可通过 `interaction_id` 回放。
- 长任务每个步骤可见。
- route pheromone 能影响模型/工具选择。
- 失败路径会降权。

## 11. Stage 6：Voice-Native AgentOS

目标：让 agentOS 真正适配语音，而不是把文字 agent 搬进声音里。

核心能力：

- 语音任务调度。
- 进度压缩播报。
- backchannel。
- 用户等待感知。
- 多任务共存。
- 声音中的权限确认。
- 语音风格和人格一致性。

规则：

- 工具日志只进 UI，不直接进 TTS。
- 长结果先摘要，再问用户是否展开。
- 多步执行时定期给短进展。
- 用户可随时问“你现在在干嘛”。
- 用户可说“这个先后台跑”。
- 用户可说“别念了，给我看屏幕上”。

验收：

- 用户不需要理解 agent 内部复杂性。
- 长任务不会占满语音通道。
- agent 可以同时后台处理任务和继续对话。

## 12. Stage 7：Adaptive Evolution

目标：系统开始根据真实使用演化。

机制：

- Failure clustering：聚类反复失败。
- Latency profiling：识别慢链路。
- Prompt mutation：生成新角色提示词。
- Tool specialization：常用工具形成专用 worker。
- Shadow evaluation：新策略影子运行。
- Canary activation：低风险启用。
- Pheromone reinforcement：成功路径强化。
- Evaporation：过时经验衰减。
- Role retirement：低价值角色淘汰。

例子：

- 如果购物清单类请求频繁，孵化 `ShoppingPlannerWorker`。
- 如果嘈杂环境唤醒失败频繁，孵化 `WakeWordTuner`。
- 如果某 TTS 模型慢，pheromone 降权。
- 如果用户总是让系统“简短点”，Voice Stylist 永久降低 verbosity。

验收：

- 每月自动生成生态健康报告。
- 每类高频请求有专门 route。
- 新角色必须经历 shadow -> canary -> stable。
- 用户可以查看/禁用/删除角色。

## 13. Stage 8：Multimodal Hive

目标：引入视觉、位置、设备状态和外部工具。

能力：

- USB 摄像头视觉问答。
- 拍照 OCR。
- 物品识别。
- 屏幕状态显示。
- 位置/网络上下文。
- 日历/邮件/文档/代码工具。
- 家庭设备控制。

原则：

- 视觉默认不上云，除非用户确认或配置允许。
- 摄像头有明显状态指示。
- 高隐私任务需要声纹确认。
- 多模态输入进入同一个 `interaction_id`。

验收：

- 用户可以说“看一下这个”并获得简短说明。
- UI 显示图片和 agent 进度。
- 摄像头能力不影响语音热路径。

## 14. Stage 9：Personal Superorganism

目标：系统成为长期伴随的个人智能生态。

特征：

- 有稳定人格，但不是单一 prompt。
- 有长期记忆，但能遗忘和纠错。
- 有个人工具库，但有权限边界。
- 有自我监控和健康报告。
- 有可迁移巢穴：Pi、本机、云端、手机都可承载部分器官。
- 有生态进化：新角色因需求而生，旧角色因无用而死。

最终体验：

- 它听得见你，但不会乱听。
- 它听懂你，但不会乱做。
- 它能马上回应，也能慢慢完成。
- 它能被打断，也能恢复上下文。
- 它能成为工具，也能成为组织者。
- 它不是“一个模型”，而是一整个活系统。

## 15. 角色路线图

### 第一代：固定角色

- Wake Guard。
- Speaker Gate。
- Reflex Router。
- Stress Judge。
- Traffic Commander。
- Reflex Agent。
- Pi Bridge。
- Planner。
- Executor。
- Inspector。
- Memory。

### 第二代：专门角色

- Shopping Planner。
- Travel Translator。
- Device Doctor。
- Audio Tuner。
- Network Fixer。
- Calendar Clerk。
- Document Reader。
- Code Assistant。
- Camera Observer。

### 第三代：自我进化角色

- Temporary Intelligence Caste。
- Role Incubator。
- Prompt Mutator。
- Tool Scout。
- Pheromone Auditor。
- Failure Clustering Agent。
- Safety Immune Agent。
- Cost Governor。
- Latency Governor。

## 16. 技术路线细化

### 15.1 Python 层

短期：

- 保持 FastAPI。
- 保持 Pipecat。
- 新增 realtime event model。
- 新增 orchestrator。
- 新增 bridge client。

中期：

- 将 pipeline processor 拆小。
- 引入智能 turn detection。
- 支持 wake word/audio preprocessor。
- 支持 agent event injection to TTS。

长期：

- 多 worker Pipecat bus。
- 独立 media microservice。
- 可替换 transport：SmallWebRTC、LiveKit、phone/SIP。

### 15.2 Node/Pi 层

短期：

- sidecar。
- Pi SDK session。
- event adapter。
- voice-safe prompts。

中期：

- role registry。
- custom tools。
- session persistence。
- task nest。

长期：

- role incubation。
- pheromone routing。
- distributed worker pool。
- remote execution。

### 15.3 前端层

短期：

- Mobile Device Home。
- Big PTT button。
- agent status strip。
- task panel。

中期：

- audio diagnostics。
- wake/speaker enrollment。
- task control：pause/cancel/steer。
- memory manager。

长期：

- ecology dashboard。
- role inspector。
- pheromone map visualization。
- evolution history。

## 17. 研究路线

持续研究主题：

- Wake word：openWakeWord、Porcupine、自定义中文/英文唤醒词。
- Speaker identity：ECAPA-TDNN、d-vector/x-vector、VoiceFilter/SpeakerBeam。
- Target speaker extraction：单麦克风 vs 麦克风阵列。
- Turn-taking：VAD + semantic endpointing + interruption classifier。
- Full-duplex：pause handling、backchanneling、overlap、barge-in。
- Voice UX：安慰话术、短反馈、进度播报、沉默管理。
- Agent runtime：Pi SDK、RPC、tools、session、extensions。
- Swarm algorithms：response threshold、pheromone、quorum、stigmergy。
- Edge deployment：Pi 4 性能、电源、热、离线模型。

研究产物：

- 每个主题一份实验记录。
- 每个模型一份 latency/quality/cost 表。
- 每个角色一份 role spec。
- 每个失败簇一份 postmortem。

## 18. 产品路线

### Alpha：可移动语音助手

范围：

- 手机网页控制。
- cloud assistant。
- Pi 自启动。
- 基础状态页。
- manual PTT。

### Beta：实时语音系统

范围：

- wake word。
- speaker gate。
- barge-in。
- timeout comfort。
- task panel。

### Gamma：Pi agent 生态

范围：

- Pi bridge。
- background tasks。
- planner/executor/inspector。
- memory worker。
- voice-friendly events。

### Delta：自适应虫群

范围：

- pheromone map。
- role evolution。
- scout/mutator。
- ecology dashboard。
- automated audits。

### Omega：个人 superorganism

范围：

- 多设备巢穴。
- 多模态。
- 自我修复。
- 自我扩展。
- 长期共生。

## 19. 风险

| 风险 | 描述 | 对策 |
| --- | --- | --- |
| 语音链路被 agentOS 拖慢 | 用户等待太久 | hot/cold path 分离，Traffic Commander |
| 唤醒词误触发 | 隐私和体验风险 | hybrid wake，物理按钮，置信阈值 |
| 声纹误判 | 错拒或误授权 | 分级权限，不把声纹作为唯一依据 |
| Pi 4 算力不足 | 本地模型慢 | 云优先，本地兜底，模型分层 |
| 系统过度复杂 | 难以落地 | 阶段化，先固定角色再进化 |
| 工具调用危险 | 文件/系统损坏 | 权限、确认、sandbox、audit |
| 角色泛滥 | 生态失控 | role registry、淘汰机制、用户可见 |
| 记忆污染 | 错误记忆长期影响 | memory inspector、冲突检测、遗忘 |
| 用户体验过度机器化 | 进度话术烦人 | Traffic Commander 控制频率和风格 |

## 20. 首个 90 天计划

### 第 1-2 周：设备基线

- Pi 上跑通现有项目。
- 手机访问控制页。
- USB 麦克风/扬声器测试。
- systemd 自启动。
- 静态前端托管。

### 第 3-4 周：Realtime event spine

- 新增 `interaction_id`。
- 新增 realtime event log。
- TTS playback state。
- timeout event。
- UI 显示当前语音状态。

### 第 5-6 周：Barge-in 与 Traffic Commander

- 插话停止播放。
- false interruption 恢复。
- 800ms comfort message。
- 2.5s progress message。
- 长任务后台提示。

### 第 7-8 周：Wake 与 Speaker

- openWakeWord/Porcupine 二选一接入。
- 声纹录入原型。
- speaker confidence policy。
- 噪声诊断。

### 第 9-10 周：Pi Bridge

- Node sidecar。
- Pi SDK session。
- Python bridge client。
- Pi events -> voice events。
- sidecar fallback。

### 第 11-12 周：Swarm v0

- 固定角色 prompt。
- Task Nest。
- AgentTaskPanel。
- basic Inspector。
- 端到端长任务演示。

90 天验收演示：

1. 用户说唤醒词。
2. 系统确认主人声纹。
3. 用户提出复杂任务。
4. 800ms 内听到安慰反馈。
5. Pi agent 后台规划和执行。
6. 用户中途插话修改目标。
7. TTS 立即停止并改写任务。
8. UI 展示任务进度。
9. 最终语音给出短摘要。
10. 关键结果写入记忆。

## 21. 一年计划

第一季度：

- 完成移动设备和 realtime voice runtime。
- 完成 Pi bridge。
- 固定角色 swarm v0。

第二季度：

- 声纹和唤醒稳定化。
- Smart turn / interruption classifier。
- Memory worker。
- Inspector worker。
- Agent task panel 完整化。

第三季度：

- Pheromone map。
- Route optimization。
- Scout / Mutator shadow mode。
- 多工具 workflow。
- 摄像头视觉原型。

第四季度：

- 自适应角色孵化。
- 生态健康报告。
- 多设备同步。
- Pi + laptop/cloud 混合巢穴。
- 长期个人助手 beta。

## 22. 最终架构原则图

```text
            User
             │
             ▼
      Voice Interface
             │
             ▼
 ┌──────────────────────┐
 │ Realtime Media Plane │
 │ wake/speaker/vad/tts │
 └──────────┬───────────┘
            │ events
            ▼
 ┌──────────────────────┐
 │ Reflex Router        │
 │ hot path / timeout   │
 └──────────┬───────────┘
            │ stress decision
            ▼
 ┌──────────────────────┐
 │ Stress Judge         │
 │ entropy/risk/novelty │
 └──────────┬───────────┘
            │ agent bridge
            ▼
 ┌──────────────────────┐
 │ Swarm Agent Runtime  │
 │ Pi SDK / tools/state │
 └──────────┬───────────┘
            │ traces
            ▼
 ┌──────────────────────┐
 │ Evolution Substrate  │
 │ pheromone/memory/log │
 └──────────────────────┘
```

## 23. 项目成功的标志

这个项目成功时，不是因为它回答得最长，也不是因为它接入了最多模型，而是因为：

- 它听起来像一个真正在线的存在。
- 它不会因为思考而冷场。
- 它能把复杂任务藏到后台生态里。
- 它能把等待变成交互，而不是沉默。
- 它能把失败变成下一代策略。
- 它能在移动硬件、电源、网络、噪声这些现实限制中活下来。
- 它能随着你长期使用，长出越来越适合你的“器官”。

## 24. 资料来源

- Pi Agent Harness：<https://github.com/earendil-works/pi>
- Pi SDK：<https://pi.dev/docs/latest/sdk>
- Pi RPC：<https://pi.dev/docs/latest/rpc>
- Pipecat overview：<https://docs.pipecat.ai/overview/introduction>
- Pipecat speech input / VAD：<https://docs.pipecat.ai/pipecat/learn/speech-input>
- Pipecat SmallWebRTCTransport：<https://docs.pipecat.ai/api-reference/server/services/transport/small-webrtc>
- LiveKit turn-taking tuning：<https://docs.livekit.io/agents/logic/turns/tuning/>
- Full-Duplex-Bench：<https://arxiv.org/html/2503.04721v3>
- openWakeWord：<https://github.com/dscripka/openWakeWord>
- Picovoice Porcupine：<https://picovoice.ai/products/voice/wake-word/>
- VoiceFilter：<https://google.github.io/speaker-id/publications/VoiceFilter/>
- Deborah Gordon, “The Ecology of Collective Behavior”：<https://pmc.ncbi.nlm.nih.gov/articles/PMC3949665/>
- “Resilience in social insect infrastructure systems”：<https://pmc.ncbi.nlm.nih.gov/articles/PMC4843670/>
- “A Brief History of Stigmergy”：<https://static.ias.edu/pitp/archive/2012files/29.pdf>
- “The biological principles of swarm intelligence”：<https://static.ias.edu/pitp/archive/2012files/66.pdf>

# 基于虫群生态的 Realtime Voice Agent 架构设计

日期：2026-07-25  
目标项目：Sisyphus Translator -> Mobile Realtime Voice Agent  
核心框架：Pipecat media plane + Pi Agent Harness agent plane + swarm runtime substrate

## 1. 架构结论

当前项目不能只把原来的 `LLM -> TTS` 节点替换成一个更强 LLM。真正的 realtime voice agent 需要四层解耦：

1. Transport / Media Plane：负责全双工音频、唤醒、声纹、VAD、STT、TTS、播放、打断、超时反馈。
2. Reflex Routing Plane：负责毫秒级语音反射，判断 fast path、timeout、barge-in、安慰反馈、澄清、取消。
3. Stress Judge Plane：负责判定高熵、高风险、未知任务是否越界，只裁判，不规划，不执行。
4. Swarm Agent Plane：以 Pi Agent Harness 为核心，运行低能耗常驻工种网络；只有越界时才孵化临时高阶智力品级。

这三层的 SLA 完全不同：

| 层 | 目标 | 响应时间预算 | 失败时 |
| --- | --- | --- | --- |
| Transport / Media | 听、说、停、唤醒、识别人 | 10ms-300ms | 降级为按钮/文字 |
| Reflex Router | 给用户即时反馈，路由任务 | 100ms-800ms | 给短答或道歉 |
| Stress Judge | 判定是否超出稳态基线 | 50ms-300ms | 保守降级、请求确认 |
| Swarm Agent | 计划、执行、验证、记忆 | 1s-分钟级 | 后台失败、可恢复 |

关键原则：用户面对的是 voice agent，不是后台任务管理器。任何 agent 生态中的复杂活动都不能让语音通道沉默太久；任何高阶智力都不能常驻成中央主脑，只能作为应激工具被短暂唤醒。

## 2. 总体拓扑

```text
                             ┌────────────────────────────┐
                             │ Mobile Web UI / 3.5" Screen│
                             └──────────────┬─────────────┘
                                            │
                                            │ WebRTC + DataChannel + HTTP
                                            │
┌───────────────────────────────────────────▼───────────────────────────────────────────┐
│                         Python FastAPI + Pipecat Media Plane                           │
│                                                                                       │
│  ┌─────────────┐   ┌──────────────┐   ┌────────────┐   ┌──────────────────────────┐  │
│  │ Wake Guard  │──▶│ Speaker Gate │──▶│ VAD Scouts │──▶│ STT / Transcript Stream  │  │
│  └─────────────┘   └──────────────┘   └────────────┘   └──────────────┬───────────┘  │
│                                                                       │              │
│  ┌─────────────┐   ┌──────────────┐   ┌────────────┐   ┌──────────────▼───────────┐  │
│  │ Audio Input │◀▶│ Transport     │◀▶│ Playback   │◀──│ Reflex Router + Stress    │  │
│  │ WebRTC/USB  │  │ Spine         │  │ Gate/TTS   │   │ Judge: fast path + stress │  │
│  └─────────────┘   └──────────────┘   └────────────┘   └──────────────┬───────────┘  │
│                                                                       │              │
└───────────────────────────────────────────────────────────────────────┼──────────────┘
                                                                        │ localhost WS/HTTP
                                                                        │
┌───────────────────────────────────────────────────────────────────────▼──────────────┐
│                         Node Agent Bridge / Pi SDK Sidecar                            │
│                                                                                       │
│  ┌─────────────────────┐      ┌───────────────────────────────────────────────────┐  │
│  │ Voice Event Adapter │─────▶│ Pi AgentSession / Swarm Runtime                   │  │
│  └─────────────────────┘      │  Baseline workers + temporary intelligence caste   │  │
│                               └───────────────────────────────────────────────────┘  │
│                                                                                       │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

Pipecat 继续存在，但它被定义为实时媒体骨架。Pi 通过 sidecar 成为 agent 生态层，负责长任务和复杂认知。

## 3. 当前项目适配点

当前项目已有的基础：

- `app/server.py`：FastAPI + WebRTC offer endpoint。
- `app/pipeline.py`：Pipecat pipeline，已有 `SmallWebRTCTransport`、manual mic gate、TTS output gate、translator/assistant prompt。
- `app/config.py`：已有 `ENGINE`、`TURN_MODE`、`CONVERSATION_MODE`。
- `client/src/hooks/useTranslatorConnection.ts`：WebRTC 客户端，支持 data channel mic control。
- `client/src/design-system/components/TalkButton`：可作为 PTT/voice button 基础。
- `tests/test_mic_gate.py`、`tests/test_speculative_pipeline.py`：已有 manual mode 和 speculative TTS 相关测试。

要新增的能力：

- 唤醒词 gate。
- 目标声纹 gate。
- 全双工 transport 状态机。
- timeout/backchannel 机制。
- interaction_id 全链路关联。
- Pi sidecar agent bridge。
- agent event -> voice event adapter。
- Swarm runtime substrate。
- Stress Judge：高熵、高风险、未知任务的应激裁判。
- 后台任务面板。

## 4. Transport / Media Plane

### 4.1 职责边界

Transport 层负责输入输出，不负责复杂思考。

输入职责：

- USB/WebRTC microphone capture。
- Wake word detection。
- Speaker verification / target speaker extraction。
- VAD / smart turn detection。
- STT streaming / segmented transcription。
- Barge-in detection。
- Audio quality metrics：RMS、SNR、noise floor、clipping。

输出职责：

- TTS queue。
- Playback gate。
- Barge-in immediate stop。
- Comfort message injection。
- Audio ducking / volume control。
- Output state report。

状态职责：

- `listening_idle`。
- `wake_detected`。
- `speaker_verified`。
- `user_speaking`。
- `agent_thinking`。
- `agent_speaking`。
- `agent_background_working`。
- `interrupted`。
- `timeout_waiting`。
- `degraded`。

### 4.2 全双工状态机

全双工不是“用户说完以后助手说”，而是系统同时维护两个方向：

```text
Input Stream:  idle -> wake -> verify -> listen -> partial -> final -> listen
Output Stream: idle -> queued -> speaking -> interrupted/finished
Agent Stream:  idle -> ack -> working -> progress -> final
```

三条流互不阻塞，但通过事件协调。

关键规则：

- 用户说话时，输入流永远不断。
- 助手说话时，输入流仍然监听 wake/barge-in。
- 用户插话只立即停止输出，不立即取消后台 agent。
- STT final 到达后，Reflex Router 只做快速路由；是否应激越界由 Stress Judge 判定。
- 如果后台 agent 仍在工作，用户可以问“进度怎样”“停一下”“换成另一个目标”。

### 4.3 唤醒词设计

Wake Guard 是最低功耗入口。

推荐模式：

- `manual`：按钮唤醒，最可靠。
- `wake_word`：唤醒词激活，适合 hands-free。
- `hybrid`：按钮 + 唤醒词，移动设备推荐。

推荐实现：

- 一期：openWakeWord 或 Picovoice Porcupine 二选一。
- openWakeWord 优点：开源，可在 Raspberry Pi 级硬件实时跑。
- Porcupine 优点：成熟、轻量、支持 Raspberry Pi、自定义唤醒词方便。
- 保留物理按键作为 wake fallback。

唤醒词事件：

```json
{
  "type": "wake_detected",
  "wake_id": "w_20260725_001",
  "keyword": "sisyphus",
  "confidence": 0.83,
  "source": "openwakeword",
  "audio_window_ms": 1280
}
```

唤醒后的策略：

- 打开 Speaker Gate。
- 提升 VAD 灵敏度。
- 打开 STT。
- 开始 `interaction_id`。
- 如果 5 秒内没有有效语音，回到 idle。

### 4.4 声纹与特定人声分离

Speaker Gate 是移动 voice agent 在嘈杂环境下的关键器官。

能力分三档：

1. Speaker verification：判断是不是已登记用户。
2. Speaker diarization：区分谁在说话。
3. Target speaker extraction：在多人/噪声混合中提取目标人声。

推荐一期：

- 先做 speaker verification，不直接做重型分离。
- 录入 3-5 段主人声音，每段 5-10 秒。
- 生成 voice embedding。
- 每次唤醒后计算 speaker confidence。
- confidence 高：正常处理。
- confidence 中：只允许低风险操作。
- confidence 低：要求确认或忽略。

推荐二期：

- 引入 target speaker extraction。
- 参考 VoiceFilter / SpeakerBeam 思路：用目标 speaker embedding 生成 spectrogram mask。
- 多麦克风阵列或 ReSpeaker USB Mic Array 可提高分离质量。

声纹事件：

```json
{
  "type": "speaker_verified",
  "interaction_id": "i_20260725_001",
  "speaker_id": "owner",
  "confidence": 0.78,
  "policy": "allow_low_risk"
}
```

### 4.5 VAD 与 Smart Turn

VAD 只能判断“有没有人声”，不是完整的 turn-taking。

需要组合：

- Energy VAD：快速粗筛。
- Silero VAD：本地 CPU 低开销语音段检测。
- Smart turn / semantic endpointing：判断用户是否真的说完。
- Timeout forcing：超过最大等待直接关闭 turn。
- Interruption classifier：区分真正插话与“嗯/对/好”的 backchannel。

推荐参数思想：

- `min_speech_ms`: 200-500ms，避免短噪声。
- `min_silence_ms`: 400-800ms，决定基本 endpoint。
- `max_turn_wait_ms`: 3000ms，防止永远等。
- `barge_in_min_ms`: 300-500ms，防止呼吸/笑声误打断。
- `false_interruption_timeout_ms`: 1500-2500ms，误打断后可恢复。

### 4.6 Stress Judge：高熵、高风险、未知任务裁判

Stress Judge 是系统里的“应激裁判”。它是低成本、常驻、快速、可解释的裁判工种，不是中央智慧个体。它不写计划、不调用工具、不生成最终答案，只根据实时事件和生态状态判断：当前请求是否仍可由稳态低阶工种处理，还是必须孵化临时高阶智力品级。

判定分三轴：

```text
entropy_score = 链路混乱度 / 失败密度 / 信号冲突度
risk_score = 行为不可逆性 / 隐私敏感度 / 权限危险度
novelty_score = 任务未知度 / 路由缺失度 / 工具与领域新颖度
stress_score = max(entropy_score, risk_score, novelty_score)
```

分数区间：

| `stress_score` | 状态 | 动作 |
| --- | --- | --- |
| `0.00-0.39` | Homeostasis / 稳态 | Reflex Router 或固定 worker 直接响应 |
| `0.40-0.64` | Local Perturbation / 局部扰动 | 激活专业 worker，必要时问澄清 |
| `0.65-0.79` | Stress Warning / 应激预警 | 启动 Planner、Inspector、Traffic Commander 协同，但仍不唤醒高阶智力 |
| `0.80-1.00` | Stress Overflow / 应激越界 | 孵化 Temporary Intelligence Caste，完成后必须退化 |

高熵范围：

- 同一路由连续失败 2 次。
- 同一工具或外部 API 连续失败 3 次。
- STT final、用户意图、声纹、VAD、工具状态互相冲突。
- 用户连续纠正目标，说明系统已经误解。
- agent 反复规划、反复调用同一工具、重复输出但没有实质进展。
- 后台任务超过 5-10 秒没有任何可解释状态变化。
- 多个 worker 置信度分裂严重，无法形成稳定局部选择。

高风险范围：

- 文件写入、删除、覆盖、移动。
- shell、系统设置、网络设置、关机、重启。
- 发送邮件/消息、发布内容、提交表单、付款、下单。
- 读取或暴露隐私：凭据、日历、联系人、位置、聊天记录。
- 医疗、法律、金融、安全相关建议。
- 非主人声纹、低声纹置信度或多人环境下的私人/高权限请求。
- 高成本模型调用、长时间后台执行、可能耗尽 Pi 电池/网络流量的动作。

未知任务范围：

- 无匹配 route、skill、prompt、tool bundle。
- route pheromone 低于阈值，历史成功样本不足。
- 首次出现的新外部系统、新设备、新 API、新文件类型或新业务域。
- 需要动态发现 MCP/工具协议。
- 所有现有 worker 都低置信。
- 用户要求系统探索，而不是执行已知流程。

裁判输出：

```json
{
  "type": "stress_decision",
  "interaction_id": "i_20260725_001",
  "entropy_score": 0.72,
  "risk_score": 0.34,
  "novelty_score": 0.81,
  "stress_score": 0.81,
  "decision": "spawn_intelligence_caste",
  "reason": "unknown_task_no_route_and_low_worker_confidence",
  "allowed_actions": ["spawn_temporary_agent", "ask_user_confirmation"],
  "must_regress_after": true
}
```

Stress Judge 的戒律：

- 不直接回答用户。
- 不直接规划。
- 不直接调用工具。
- 不让“高风险”自动等于“高阶智力”，高风险优先是确认、隔离、审计。
- 不让“复杂”自动等于“未知”，复杂但熟悉的任务应交给专业 worker。
- 不让“等待超时”自动唤醒高阶智力；短等待先由 Traffic Commander 安慰，持续无进展才提高 entropy。

## 5. Timeout / 安慰反馈机制

这是用户提出的关键设计：transport 层一旦等待超过阈值，就向 agent 生态层的“交通指挥”索取一个安慰信息，再流入 TTS 输出给用户。

### 5.1 Traffic Commander

Traffic Commander 是专门观察链路流转状态的角色。它不负责完成任务，只负责保持用户对系统的信任。

输入：

- 当前 interaction 状态。
- STT 是否 final。
- Reflex Agent 是否已响应。
- Pi Agent 是否开始。
- Planner 是否产出计划。
- Executor 是否卡住。
- Inspector 是否在验证。
- 网络、模型、TTS、工具延迟。
- 用户最近是否打断或催促。

输出：

- comfort message。
- progress message。
- clarification request。
- wait strategy。
- cancel recommendation。
- escalation recommendation。

### 5.2 超时阈值

建议初始 SLA：

| 阶段 | 阈值 | 动作 |
| --- | --- | --- |
| Wake 后无有效语音 | 5s | 回 idle，轻提示或静默 |
| 用户停止说话后无任何反馈 | 800ms | Traffic Commander 生成短 ack |
| Agent 无可播进展 | 2.5s | 播报“我还在处理...” |
| 工具执行超过预估 | 5s | 播报具体阶段 |
| 后台任务超过 15s | 15s | 转后台，告诉用户可以继续说话 |
| 用户催促 | 立即 | 播当前状态摘要 |

### 5.3 Comfort Message Contract

Traffic Commander 输出必须非常短，不能像普通 LLM 长篇解释。

```json
{
  "type": "comfort_message",
  "interaction_id": "i_20260725_001",
  "urgency": "soft",
  "text": "我在查，先别等我说完，你可以继续补充。",
  "ttl_ms": 2500,
  "interruptible": true,
  "reason": "agent_work_no_output_2500ms"
}
```

语音风格：

- 短。
- 诚实。
- 不重复。
- 不打断用户。
- 不把内部工具名直接念出来，除非用户需要。

错误示例：

- “正在调用 search_tool_execute_pipeline_handler 并等待 JSON 结果。”
- “请稍等，我正在基于多步骤工具链进行综合处理。”

正确示例：

- “我在查，马上给你结果。”
- “这一步比较慢，我先继续处理。”
- “我已经找到方向了，还在验证。”
- “可以，你先继续说，我在后台做。”

## 6. Reflex Router

Reflex Router 是语音层的低阶反射路由器，不是中枢，也不是最高智能。它负责在很短时间内把事件送到正确工种：短答给 Reflex Agent，等待给 Traffic Commander，常规长任务给 baseline workers，越界判定交给 Stress Judge。

职责：

- 建立 `interaction_id`。
- 聚合 wake、speaker、VAD、STT、barge-in、timeout。
- 决定 fast path / baseline worker path / stress judge path。
- 触发 Reflex Agent、Traffic Commander、Stress Judge、Pi Agent Bridge。
- 管理 TTS queue。
- 处理 cancellation 和 steering。
- 把 agent 事件转成可播报事件。

输入事件：

- `wake_detected`
- `speaker_verified`
- `vad_started`
- `vad_stopped`
- `stt_partial`
- `stt_final`
- `playback_started`
- `playback_interrupted`
- `timeout_elapsed`
- `agent_progress`
- `agent_result`
- `agent_error`

输出事件：

- `tts_enqueue`
- `agent_start`
- `agent_cancel`
- `agent_steer`
- `ui_update`
- `memory_write_request`
- `session_close`

## 7. Swarm Agent Plane

Swarm Agent Plane 以 Pi Agent Harness 为核心。

Pi 的适配价值：

- `pi-agent-core` 已提供 agent runtime、tool calling、state management。
- Pi 支持 SDK、RPC、extensions、skills、prompt templates、sessions。
- Pi 可作为可嵌入 agent harness，而不是封闭产品。

推荐接入方式：

- 新增 `agent-bridge/` Node sidecar。
- 使用 Pi SDK 创建 `AgentSession`。
- Python 后端通过 localhost WebSocket 发 voice events。
- Node sidecar 把 Pi event stream 转回 voice-friendly events。
- 如果 sidecar 不可用，Python 降级到现有 LLM node。

### 7.1 Sidecar API

Python -> Node：

```json
{
  "type": "agent_prompt",
  "interaction_id": "i_20260725_001",
  "session_id": "voice_owner_main",
  "text": "帮我整理今天要买的东西",
  "mode": "background",
  "deadline_ms": 800,
  "speaker": {
    "id": "owner",
    "confidence": 0.92
  },
  "context": {
    "device": "raspberry_pi_4",
    "network": "wifi",
    "conversation_mode": "assistant"
  }
}
```

Node -> Python：

```json
{
  "type": "agent_progress",
  "interaction_id": "i_20260725_001",
  "phase": "planning",
  "speakable": true,
  "text": "我先列出清单，再帮你按地点分组。",
  "ui_detail": "Planner produced 3 subtasks",
  "confidence": 0.74
}
```

控制事件：

```json
{ "type": "agent_cancel", "interaction_id": "i_20260725_001", "reason": "user_said_stop" }
{ "type": "agent_steer", "interaction_id": "i_20260725_001", "instruction": "改成按超市区域排序" }
{ "type": "agent_follow_up", "interaction_id": "i_20260725_001", "text": "还要加上电池" }
```

### 7.2 Role Taxonomy

Swarm Agent Plane 中建议定义这些“品种”：

| 角色 | 中文名 | 职责 | 是否可发声 | 是否可调用工具 |
| --- | --- | --- | --- | --- |
| Reflex Router | 反射路由器 | 毫秒级事件路由，维持 hot path | 否 | 否 |
| Stress Judge | 应激裁判 | 判定高熵、高风险、未知度是否越界 | 否 | 否 |
| Temporary Intelligence Caste | 临时智力品级 | 只在越界时孵化，生成新策略/新品级，完成后退化 | 受控 | 受控 |
| Traffic Commander | 交通指挥 | 观察等待与拥堵，生成短反馈 | 是 | 否 |
| Reflex Agent | 反射体 | 快速短答、澄清、确认、拒绝 | 是 | 极少 |
| Planner Brood | 规划孵化群 | 任务拆解、依赖图、风险标注 | UI 摘要 | 否 |
| Executor Workers | 执行工群 | 工具调用、文件/网页/API 操作 | 否 | 是 |
| Inspector Soldiers | 检测兵群 | 验证、审计、风险控制 | 错误摘要 | 可读 |
| Memory Workers | 记忆工群 | 检索、写入、遗忘、压缩 | 否 | 记忆工具 |
| Scout Mutators | 侦察变异体 | 探索新工具、模型、prompt | 否 | sandbox |
| Device Sentinels | 设备哨兵 | 网络、电量、温度、音频设备 | 错误提示 | 系统只读 |
| Voice Stylist | 发声整形者 | 将文本压缩为口语 TTS | 是 | 否 |

### 7.3 角色激活阈值

```text
Traffic Commander:
  if user_wait_ms > 800 and no_spoken_feedback
  if agent_progress_gap_ms > 2500
  if user_asks_progress

Stress Judge:
  if entropy_score >= 0.40 or risk_score >= 0.40 or novelty_score >= 0.40
  if stress_score < 0.65 -> activate specialists or ask clarification
  if 0.65 <= stress_score < 0.80 -> planner/inspector collaboration
  if stress_score >= 0.80 -> spawn temporary intelligence caste

Reflex Agent:
  if intent in [smalltalk, confirm, reject, clarify, quick answer]
  if response_budget_ms < 1000

Temporary Intelligence Caste:
  if stress_score >= 0.80
  if no existing worker route can solve the task
  if successful -> distill trajectory into skills/prompts/pheromone
  if finished -> de-instantiate and release model/context resources

Planner Brood:
  if task_complexity >= medium
  if tool_count_estimate >= 2
  if user asks planning / multi-step outcome

Inspector Soldiers:
  if risk >= medium
  if file/system/network action
  if final answer includes factual claim needing validation

Memory Workers:
  if user says remember
  if repeated preference appears >= 3 times
  if agent task produces reusable artifact

Scout Mutators:
  if repeated failure cluster appears
  if route pheromone decays below threshold
```

## 8. Swarm Runtime Substrate

### 8.1 Event Log

所有层都写事件：

```json
{
  "event_id": "e_001",
  "ts": 1784970000.123,
  "interaction_id": "i_001",
  "source": "vad_scout",
  "type": "vad_started",
  "payload": { "confidence": 0.84 }
}
```

要求：

- append-only。
- 可本地持久化。
- 支持按 `interaction_id` 查询。
- 支持调试延迟。
- 支持后续训练/评估。

### 8.2 State Board

State Board 是当前生态状态：

```json
{
  "audio": { "input": "ok", "noise": "medium", "speaker": "owner" },
  "transport": { "input": "listening", "output": "speaking" },
  "agent": { "main": "working", "phase": "executing" },
  "device": { "network": "wifi", "battery": "external", "temp_c": 58.1 },
  "sla": { "user_wait_ms": 1210, "last_spoken_ms": 900 }
}
```

### 8.3 Pheromone Map

Pheromone Map 用于路由优化：

```json
{
  "routes": {
    "shopping_list/simple": {
      "fast_path_success": 0.81,
      "pi_agent_success": 0.93,
      "avg_latency_ms": 1800,
      "last_verified": "2026-07-25"
    }
  },
  "models": {
    "cloud_fast_llm": { "latency": 0.9, "quality": 0.76, "cost": 0.4 },
    "pi_offline_llm": { "latency": 0.2, "quality": 0.31, "cost": 0.05 }
  }
}
```

蒸发规则：

- 每天自动衰减未使用路径。
- 新网络/噪声/设备状态下单独计分。
- 失败事件快速降权。
- 用户纠正时强降权。

### 8.4 Task Nest

Task Nest 存储后台任务：

```json
{
  "task_id": "t_001",
  "interaction_id": "i_001",
  "goal": "整理今天的购物清单",
  "state": "executing",
  "subtasks": [
    { "id": "t_001_a", "role": "planner", "state": "done" },
    { "id": "t_001_b", "role": "executor", "state": "running" },
    { "id": "t_001_c", "role": "inspector", "state": "pending" }
  ],
  "speak_policy": "progress_only"
}
```

## 9. 端到端流程

### 9.1 快速短答

```text
Wake -> Speaker verified -> VAD -> STT final
  -> Reflex Router classifies quick answer
  -> Reflex Agent generates concise answer
  -> TTS
  -> done
```

目标：

- 1 秒左右开始说话。
- 不进入 Pi sidecar。
- 不写长期记忆，除非用户明确要求。

### 9.2 长任务

```text
Wake -> STT final
  -> Reflex Router sees complex task
  -> Stress Judge confirms it is not stress overflow
  -> Traffic Commander says short ack within 800ms
  -> Pi Bridge starts AgentSession turn
  -> Planner creates task graph
  -> Executors run tools
  -> Inspectors validate
  -> Voice Stylist summarizes
  -> TTS final answer
```

目标：

- 用户不会沉默等待。
- 后台任务可持续。
- 前端 task panel 可见。

### 9.3 用户打断

```text
Agent speaking
  -> VAD detects user speech
  -> Playback gate immediately stops TTS
  -> STT collects interruption
  -> Reflex Router classifies:
      "停" -> cancel agent task
      "等一下" -> pause TTS, keep task
      "改成..." -> steer Pi task
      "嗯/好" -> false interruption, optionally resume
```

### 9.4 嘈杂环境

```text
Wake confidence medium
  -> Speaker Gate checks voiceprint
  -> noise high -> strengthen VAD threshold
  -> speaker confidence low -> require confirmation
  -> target speaker extraction if enabled
  -> only low-risk commands allowed until verified
```

### 9.5 Timeout 安慰

```text
STT final at T=0
No spoken output by T=800ms
  -> timeout_elapsed event
  -> Traffic Commander reads state board
  -> emits comfort_message
  -> TTS says "我在处理，你可以继续补充。"
Agent result arrives later
  -> Voice Stylist summarizes
  -> TTS final answer
```

## 10. 文件级设计

建议新增：

```text
app/
  realtime_events.py
  reflex_router.py
  stress_judge.py
  traffic_commander.py
  wake_guard.py
  speaker_gate.py
  barge_in_policy.py
  tts_playback_state.py
  pi_bridge_client.py
  swarm_state.py
  device_status.py

agent-bridge/
  package.json
  tsconfig.json
  src/
    index.ts
    piSessionManager.ts
    voiceEventServer.ts
    eventAdapter.ts
    roleRegistry.ts
    tools/
      voiceSafeTools.ts
      deviceTools.ts
    prompts/
      hive-core.md
      traffic-commander.md
      voice-stylist.md

client/src/device/
  DeviceHome.tsx
  AgentTaskPanel.tsx
  VoiceStateStrip.tsx
  AudioDiagnostics.tsx
```

### 10.1 `app/realtime_events.py`

定义统一事件：

- `InteractionStarted`
- `WakeDetected`
- `SpeakerVerified`
- `VadStarted`
- `VadStopped`
- `SttPartial`
- `SttFinal`
- `TimeoutElapsed`
- `TtsQueued`
- `TtsStarted`
- `TtsInterrupted`
- `AgentStarted`
- `AgentProgress`
- `AgentResult`
- `AgentFailed`

### 10.2 `app/reflex_router.py` 与 `app/stress_judge.py`

核心接口：

```python
class ReflexRouter:
    async def handle_event(self, event: RealtimeEvent) -> list[RealtimeCommand]:
        ...

class StressJudge:
    async def judge(self, snapshot: StressSnapshot) -> StressDecision:
        ...
```

输出命令：

- `EnqueueTTS`
- `StopTTS`
- `StartAgentTask`
- `CancelAgentTask`
- `SteerAgentTask`
- `UpdateUI`
- `WriteMemory`

### 10.3 `app/pi_bridge_client.py`

职责：

- 连接 Node sidecar。
- 发送 prompt/cancel/steer/follow-up。
- 接收 agent events。
- 断线重连。
- sidecar 不可用时返回 degraded。

### 10.4 `agent-bridge/src/piSessionManager.ts`

职责：

- 创建和缓存 Pi `AgentSession`。
- 维护 voice session -> Pi session 映射。
- 控制 enabled tools。
- 控制 role prompt。
- 订阅 Pi event stream。

## 11. 测试策略

### 11.1 单元测试

- Wake event creates interaction。
- Speaker low confidence blocks high-risk task。
- Timeout at 800ms triggers comfort message。
- Timeout after agent progress does not repeat same comfort。
- Barge-in stops TTS immediately。
- “停一下” cancels or pauses according to policy。
- Pi bridge unavailable falls back to normal LLM。

### 11.2 集成测试

- Python orchestrator <-> Node sidecar WebSocket。
- Pi event stream -> voice event adapter。
- Long task with progress + final answer。
- Agent cancel while tool running。
- Multiple interactions while one background task continues。

### 11.3 真人验收

- 嘈杂环境中唤醒误触发率。
- 主人声纹通过率。
- 非主人高风险指令拒绝率。
- 用户停止说话到第一反馈时间 P50/P95。
- 用户插话到 TTS 停止时间 P50/P95。
- 长任务中每 2-5 秒有合理进度或静默策略。

## 12. 性能预算

建议初始目标：

| 指标 | 目标 |
| --- | --- |
| Wake detection latency | < 200ms after keyword end |
| Barge-in audio stop | < 150ms |
| First acknowledgement | P50 < 800ms, P95 < 1200ms |
| Fast answer speech start | P50 < 1200ms |
| Long task first comfort | < 800ms |
| Progress gap | 2.5s-5s 内可解释 |
| Agent final result | 视任务而定，但必须有后台状态 |

## 13. 安全与权限

声纹与唤醒词会引入权限语义：

- 未唤醒：不处理语音内容，只做 wake detection。
- 唤醒但未验证 speaker：只允许低风险问答。
- 已验证 speaker：允许个人记忆、设备控制。
- 高风险工具：仍需要口头确认或 UI 确认。
- 多人环境：默认不读私人信息。

Pi sidecar 工具权限：

- 默认禁用危险 shell/write。
- voice-safe tools 先从只读开始。
- 文件写入需要 interaction 确认。
- 系统命令需要本地 device token。
- 所有工具执行写 event log。

## 14. 与现有 Pipecat 的关系

Pipecat 不被替换。它承担：

- WebRTC transport。
- audio frame flow。
- VAD/STT/TTS processor。
- manual mode gate。
- playback gate。
- realtime frame lifecycle。

Pi Agent Harness 承担：

- 长任务 agent loop。
- tool calling。
- state management。
- session management。
- extension/skills。
- planning/execution/checking ecosystem。

Reflex Router 与 Stress Judge 站在二者之间：前者只做快速路由，后者只做应激判定。它们都不能演化成常驻中央智慧。

## 15. 资料来源

- Pi Agent Harness GitHub：<https://github.com/earendil-works/pi>
- Pi SDK：<https://pi.dev/docs/latest/sdk>
- Pi RPC mode：<https://pi.dev/docs/latest/rpc>
- Pi extensions：<https://pi.dev/docs/latest/extensions>
- Pipecat introduction：<https://docs.pipecat.ai/overview/introduction>
- Pipecat speech input / VAD：<https://docs.pipecat.ai/pipecat/learn/speech-input>
- Pipecat SmallWebRTCTransport：<https://docs.pipecat.ai/api-reference/server/services/transport/small-webrtc>
- Pipecat Smart Turn Detection：<https://docs.pipecat.ai/pipecat-cloud/guides/smart-turn>
- LiveKit turn-taking tuning：<https://docs.livekit.io/agents/logic/turns/tuning/>
- Full-Duplex-Bench：<https://arxiv.org/html/2503.04721v3>
- VoiceFilter：<https://google.github.io/speaker-id/publications/VoiceFilter/>
- Neural Target Speech Extraction overview：<https://www.fit.vut.cz/research/group/speech/public/publi/2023/zmolikova_2023_IEEE_SPM_Neural_Target_Speech_Extraction_An_overview.pdf>
- openWakeWord：<https://github.com/dscripka/openWakeWord>
- Picovoice Porcupine：<https://picovoice.ai/products/voice/wake-word/>

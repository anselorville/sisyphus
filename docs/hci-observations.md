# HCI 观察记录（HCI Observations）

> 人机交互问题收集载体。记录每次真实语音交互中观察到的所有 HCI 问题维度。
> 数据来源：transcript + sidecar 事件（SQLite `events` 表）+ 人工观察。
> 自动化查询：`scripts/query-hci-events.sh`。

## 记录约定

- **严重度**：`S1` 完全不可用 / `S2` 明显影响使用 / `S3` 轻微不适 / `S4` 可忽略
- **可复现**：`高`（每次必现）/ `中`（偶尔）/ `低`（仅特定条件）
- 每条记录独立成块，不合并多条问题
- 时间使用 `YYYY-MM-DD HH:MM:SS`（本地时区）

---

## 观察记录模板

```markdown
### [维度] 一句话描述问题

- **日期**: YYYY-MM-DD HH:MM:SS
- **严重度**: S?（1-4）
- **可复现**: 高/中/低
- **场景**: 本次交互的意图 / 用户原话
- **现象描述**: 实际发生了什么，与期望的差异
- **数据佐证**:
  - transcript / 事件类型（如 `voice.transcript.final` / `voice.speech.enqueue`）
  - 时间戳、interaction_id / task_id（可从 `events` 表查）
  - 相关命令：`scripts/query-hci-events.sh --interaction <id>`
- **根因猜测**: （可选）可能的原因
- **处理**: 已修复 / 待观察 / 搁置 / 已复现待修

---

```

---

## 五维观察清单

### 1. 延迟体感（Latency）

从说话结束到听到 agent 回答的时间。涉及 Pipecat 的 `voice_latency`
观测（`user_to_bot_seconds` / `first_bot_speech_seconds`）与
TrafficCommander 的进度播报节奏。

观察要点：

- 首次确认（目标 ≤700ms）是否及时
- 从语音结束到首次听到回答的总时长体感
- 长任务中进度播报是否 ≥5s 间隔、是否有长时间静默
- 转写缓冲（语义句子缓冲 / 500ms 无标点回退）是否引入额外等待

### 2. 打断 / barge-in 失灵（Interruption）

用户说「停 / 停下 / cancel」但 agent 没停（或很晚才停）。

观察要点：

- `voice.speech.cancel` 是否在说「停」后立即触发
- 本地 MicGate/TTSOutputGate 的帧级打断是否生效（听感上音频是否立刻停）
- InterruptionRouter 短语表是否漏掉了用户的实际说法
- 打断后任务是否被取消，还是只停了播报但任务仍在跑

### 3. 错误路由（Wrong Routing）

agent 误解指令，把任务路由给了错误的角色 / 调用了错误的工具。

观察要点：

- ReflexRouter 能力标签匹配是否命中正确角色（general/web/code/mail…）
- 用户说 A 意图，agent 却当成 B 意图处理
- StressJudge 是否错误升级 / 错误兜底到 general
- 路由决策（`task.assigned` 的角色 id）与用户意图是否一致

### 4. 幻觉工具调用（Hallucinated Tool Calls）

agent 调用了不存在的工具、编造了工具结果，或执行了与指令无关的动作。

观察要点：

- 调用了角色工具面之外的工具（可对照
  `agent-runtime/src/roles/manifests.ts` 各角色工具列表）
- 工具返回了编造的 / 未核实的成功结果（Inspector 未发现证据）
- CapabilityGateway / Diplomacy 是否拦截了不应放行的调用
- 调用与当前任务目标是否无关

### 5. 转写错误（Transcription Errors）

STT 转写不准确，导致 agent 收到错误文本。

观察要点：

- `voice.transcript.final` 文本与用户实际发音的差异
- 同音词 / 专有名词 / 中英混说 / 口音导致的转写失败
- 语义句子缓冲是否把错误片段拼进最终转写
- 因转写错误引发的后续错误路由（可与维度 3 关联）

---

## 单次交互记录（一次交互一块）

```markdown
## 交互 `YYYY-MM-DD HH:MM:SS` — interaction_id: `xxx`

**用户原话（听感）**: …

**transcript（STT 结果）**: …

**路由**: general / web / code / mail / 其它（→ task_id: …）

**agent 回答（TTS 播报）**: …

**延迟**: 首次确认 ___ms；总回答 ___ms（`voice_latency` 可查）

**问题观察**:
- [ ] 延迟体感：…
- [ ] 打断/barge-in：…
- [ ] 错误路由：…
- [ ] 幻觉工具调用：…
- [ ] 转写错误：…

**备注**: …
```

---

## 运行记录

### [延迟] 合成语音单句问答的端到端延迟（自动化，非真人）

- **日期**: 2026-10-25
- **严重度**: S3
- **可复现**: 高
- **场景**: `scripts/voice-smoke.py --text "请用一句话介绍你自己"`，macOS `say` 合成语音当麦克风，
  Zhipu ASR + MiniMax TTS + DeepSeek `deepseek-flash`
- **现象描述**: 说完 → 第一句回复文字 约 1.5–1.9 s；说完 → 听到第一段回复音频 约 2.2–2.8 s
- **数据佐证**: `scripts/query-hci-events.sh --latency`（sidecar 侧"说完 → 首句语音入队"
  0.8–1.9 s，不含 TTS 合成与播放）
- **根因猜测**: VAD 停顿 + Zhipu 批量转写（~0.6 s）+ 首句确认 + MiniMax 首包
- **处理**: 待真人对话验证是否可接受

### [转写/回合] 句中逗号停顿把一句话切成两个回合（自动化，非真人）

- **日期**: 2026-10-25
- **严重度**: S2
- **可复现**: 高（对带明显停顿的合成语音）
- **场景**: 用户说"你好，请用一句话介绍你自己"
- **现象描述**: 产生两条 `voice.transcript.final`（"你好" / "请用一句话介绍你自己"）、两个任务，
  Marcus 回答了两次
- **根因猜测**: Zhipu 是整段批量识别，VAD 在逗号处判停；语义缓冲 flush 超时仅 0.5 s
- **处理**: 待用真人语速复现后调 VAD 停顿时长与缓冲超时

### [打断] 插话后回复音频在约 0.5 s 内停止（自动化，非真人）

- **日期**: 2026-10-25
- **严重度**: S4（已修复项的回归记录）
- **可复现**: 高
- **现象描述**: 修复前自动模式下打断完全不生效、旧回复继续播约 17 s；修复后在插话后约 0.5 s 内停止
- **数据佐证**: `scripts/voice-smoke.py --barge-in` 的 `reply_audio_segments_s`；
  `scripts/query-hci-events.sh --summary` 的"打断 N 次 / 用户发言 M 次"
- **处理**: 已修复；真人环境下的误触发率待观察

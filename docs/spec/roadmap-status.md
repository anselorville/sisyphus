# 语音交互路线进度看板

两条并行路线的阶段与当前状态。阶段内容详见各自的方案文档，本文只记录进度、依赖和阻塞项；阶段状态变化时同步更新本文。

| 路线 | 方案文档 | 侧重 |
|---|---|---|
| UX 路线（P0–P4） | [`voice-ux-optimization-plan.md`](voice-ux-optimization-plan.md) §4 | 前端可视化与交互 |
| 双工架构路线（S1–S6） | [`duplex-voice-architecture.md`](duplex-voice-architecture.md) §10 | agent-runtime 与媒体层的时间、话权和决策 |

状态标记：✅ 完成 · 🚧 进行中 · ⏸ 阻塞 · ⏳ 未开始

---

## UX 路线

| 阶段 | 内容 | 状态 | 备注 |
|---|---|---|---|
| P0 打通信号 | 语音事件转发到浏览器、Agent 发声起止事件、`useVoiceSession` 状态机、远端音量、生态事件驱动 | ✅（授权事件除外） | 授权事件转发受阻塞项 B1 影响 |
| P1 主界面重构 | `VoiceOrb`、`LiveCaption`、`SessionDrawer`、Ecology 移入设置、去掉 Connect 按钮 | ⏳ | `AgentHomeScreen` 的 story 已修复，并有 Thinking / ListeningWithPartialText / AgentSpeaking 三个状态 story |
| P2 对话交互 | 一键开始、按住说话、打断按钮、结构化错误分类、授权卡片、首次引导、文字输入、会话留存、提示音 | ⏳ | 授权卡片受 B1 影响；打断按钮依赖 S4 |
| P3 视觉系统 | 文案字典、深色模式、语义状态色、字号与动效规范、品牌图标、视觉回归 | ⏳ | 可与 P2 并行 |
| P4 体验度量 | 前端埋点、指标目标、延迟浮层 | ⏳ | 与 S1 的 `turn.trace` 共用数据 |

## 双工架构路线

| 阶段 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| S1 时间账与应答门 | `turn.trace` 各节点耗时；工具耗时分析器；D6 应答门（shadow → live）；`drainQueue` 改走决策引擎 | 无 | 🚧 代码完成；D6 以 shadow 运行（规则生效）；B3 已于 11-12 19:41 解除，可切 live |
| S2 计时官与进度叙述 | 计时官的沉默预算与 ETA；进度叙述者替换固定话术；主持人回答状态询问 | S1 | ⏳ |
| S3 回合判定 | D1 判断用户是否说完，shadow 校准后 live | S1 | ⏳ |
| S4 插话语义 | 媒体层降音 / 暂停 / 恢复；D2 插话分类 | S3 | ⏳ |
| S5 对话与执行解耦 | 多轨道调度、D5 关系判定、话权仲裁、主持人闲聊 | S2、S4 | ⏳ |
| S6 预测与学习边 | 部分识别结果预热与预取；决策分歧回流为标注样本 | S3、S5 | ⏳ |

## 跨路线依赖

| 前端需求 | 依赖的架构阶段 |
|---|---|
| P2 打断按钮（`voice.speech.stop`） | S4 媒体层的暂停 / 恢复 / 清空指令 |
| P1 / P2 状态文案（"仍在处理"、"比平时久"） | S2 计时官 |
| P4 感知延迟等指标 | S1 `turn.trace` |
| P2 授权卡片 | 阻塞项 B1 |

## 阻塞项

| 编号 | 问题 | 影响 | 解除条件 |
|---|---|---|---|
| B1 | 授权确认闭环未接通：没有代码调用 `CapabilityGateway.approve()`，`buildRouteState` 不传入待确认请求，浏览器端"允许 / 拒绝"无服务端处理 | P0 授权事件转发、P2 授权卡片 | agent-runtime 补齐确认链路后，再转发 `diplomacy.elevation.*` |
| B2 | 智谱语音识别余额不足（429） | 默认配置下无法进行真实语音测试 | 已绕开：本机 `model_providers.json` 改用 AssemblyAI（`universal-3-5-pro`），`voice-smoke.py` 全链路通过。Deepgram 的 key 无效（401）。智谱充值后可切回 |
| B3 | ✅ 已解除（2026-11-12 19:41）：TypeSafe 对中国大陆出口返回 451 "not available in your region"；路由器 OpenClash 在该时刻重载后，`DOMAIN-SUFFIX,typesafe.ai` 开始命中 🤖 AI 服务（SFL 美国 02） | 解除前：自 2026-10-25 起 Jev 判断全部回落 `not_ready`，D3/D4/D7 未生效、D6 无法转 live。解除后：`GET /v1/models` 返回 200、`jev-1.14.0` 正常作答，sidecar 保持 2 条长连接 | 已满足：路由器规则生效，且本机默认路由走 `en0 → 192.168.2.1`。残留风险：`en1`（192.168.1.x，网关 192.168.1.1）实测仍 451，切到该网络会复发 |

## 已知体验问题

作为 S1–S4 的验收依据，详见 `duplex-voice-architecture.md` §2.2：

- 闲聊也会先说确认语（S1 应答门）
- 确认语的动词与实际动作不符（S1 应答门）
- 自动模式下句中停顿被切成两轮、抢话（S3 回合判定）
- 附和或咳嗽会打断 Agent（S4 插话语义）
- 任务执行期间的新提问被排队（S5 解耦）
- 识别服务报错时界面无提示（P2 错误分类）

## S1 现状

- 应答门：`agent-runtime/src/voice/ack-gate.ts`，与路由判断同一次 Jev 调用（`turn` 判断 v2 多一个 `ack` 问题）。开关 `AGENT_RUNTIME_ACK_GATE`（默认 `shadow`：按规则执行，Jev 的判断记为 `decision.made` / `ack_gate`）。规则：问候、致谢、问 Marcus 自己 → 不说确认语，2.5 s 仍无回答才说"嗯，稍等"。
- 确认语措辞按路由的角色取动词：`web` 才说"我查一下"，`mail` 说邮件，`general` 说"我想想"。
- `turn.trace`：每轮任务结束写一条，`scripts/query-hci-events.sh --trace` 查看。
- 工具耗时分析器：`scripts/query-hci-events.sh --tools`（p50 / p90 / 失败率）。S2 的计时官需要在运行时读取时，再落成 TS 模块。
- `drainQueue` 改走 `onVoiceTranscript`：排队的话走同一条决策路径，并补发了此前缺失的 `task.created` / `task.assigned`。
- 真实链路验证：问候与"介绍你自己"不再出现确认语；"明天上海天气怎么样"的确认语为"明天上海天气啊，我查一下。"。
- 实测工具耗时：`web_search` p50 约 0.4 s、p90 约 6.4 s，`web_fetch` p50 约 0.1 s、p90 约 5.3 s。

## 下一步建议

1. **B3 已解除（11-12 19:41）**：D6 可切 live——设 `AGENT_RUNTIME_ACK_GATE=live` 并重启 sidecar 读取新 env；S3 之后的阶段可继续用 Jev 校准。
2. **P1 的 `VoiceOrb`**：不依赖 Jev，可以并行推进。
3. **S2 计时官**：可以先用 `--tools` 的耗时分布做规则版 ETA，Jev 恢复后再接 D8 / D9。
4. **B1**：解除后才能完成 P0 剩余项和 P2 的授权卡片。

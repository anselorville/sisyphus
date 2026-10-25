# TODO

工作计划与已知缺口的汇总入口。这是一份待办清单，不是 README——允许优先级标记、
勾选状态、依赖关系说明；面向准备接下来动手的人，不面向第一次了解这个项目的人
（那部分内容在 `README.md`/`README_CN.md`/`agent-runtime/README.md`）。

## 里程碑：从治理骨架到一次真正闭环的语音任务

当前状态（2026-10-18）：任务执行闭环已实现并通过真实验收。蜂群治理层
（Queen/Population/PheromoneMap/GeneBank）仍然刻意停放——它接在组合根上，
但不参与路由决策。接下来的排序原则：先补齐观测（events 表 / HCI），再用真实
数据决定要不要唤醒治理层，最后才是需要产品决策的部分。

### Phase 1 — P0（已完成，2026-10-18）：任务执行编排循环
一句语音指令能真正走完"创建任务 → 派给角色 → Pi Session 执行 → 拿到结果 →
`TaskNest.transition()` 到终态 → `task.assimilate` 被触发"这条链路。

- [x] `agent-runtime/src/tasks/task-executor.ts`：`voice.transcript.final` 之后
      真正调用 `PiRoleSessionManager.prompt(roleId, taskId, text)`；steer/
      follow_up/cancel 分别派发到 `sessionManager.steer()`/新任务/`abort()`。
- [x] `agent_end`/工具失败等信号驱动 `taskNest.transition()` 落到
      `completed`/`failed`/`cancelled`，并触发 `task.assimilate`。
- [x] 验收（已执行）：起真实 `node dist/index.js`，发一条
      `voice.transcript.final`，观察到 `task.created → task.assigned →
      voice.speech.enqueue × N → task.completed`，`tasks` 表新增 completed
      行，`role_fitness` 新增 `task_outcome=1.0` 行。

### Phase 2 — P1（部分完成）：真实 pheromone/memory 信号
- [x] memory：`task-assimilation.ts` 已通过 `MemoryCurator.consider()` 写入
      审核后的压缩内容（成功任务）。
- [ ] pheromone delta 仍固定为 `null`：需要决定 task-feature/device/network
      上下文从哪一层拿（`TaskRecord` 本身不携带；ReflexRouter 的能力标签匹配
      结果是现成候选）。

### Phase 3 — P2：Queen 的 merge/wake 决策 + `PopulationRegistry.retire()` 触发规则
- [ ] 纯函数规则/类型可以现在定稿（例如两个角色能力高度重叠触发 merge、休眠角色
      被高频路由命中触发 wake、连续失败达到阈值触发 retire）。
- [ ] 但接入 `src/index.ts` 组合根前，建议等 Phase 1/2 有真实 fitness/pheromone
      数据源之后再做——否则是拿假数据做真决策。

### Phase 4 — P0（非代码，发布前必须做）：真实环境验证
- [x] 真实 LLM 凭据 + 真实 sidecar 进程的任务执行闭环（2026-10-18，见 Phase 1）。
- [x] 在线 ASR/TTS provider 矩阵（2026-10-25 复验，见 `docs/project-restart.md`）：
      Zhipu ASR + MiniMax TTS 为推荐组合；OpenRouter/Cartesia TTS 可用但慢；
      Deepgram key 无效、Edge TTS 403、OpenRouter ASR 无可用模型。
- [x] 全链路语音冒烟测试（`scripts/voice-smoke.py`，合成语音 + 真实 provider），
      含打断：回复音频在插话后约 0.5 s 内停止。
- [ ] 用麦克风/扬声器人工跑一次完整语音对话，确认播报延迟、打断、误触发的主观听感
      （冒烟测试用合成语音，只能证明链路）。
- [ ] 在真实树莓派上跑一次 `scripts/benchmark-runtime.sh --raspberry-pi`，把
      `.proj-init/performance-baseline.md` 的 Pi 章节从"未测"填成有数据。

### Phase 5 — P3（需要先做产品决策，暂不排期）
- [ ] 设备控制器（mail 之外）的真实实现——先决定目标平台（systemd？launchd？
      某个 IoT 网关？），再谈工作量。

## 已知缺口（现状记录，非任务本身）

### `agent-runtime`（详见 `agent-runtime/README.md` 的"已知缺口"一节）
- Jev 决策层的评测集是自己标注的 87 条，不是真实流量；需要用 shadow/live 日志里的分歧扩充标注并重新校准阈值（`docs/jev-decision-layer.md` 第 5 节）。
- 路线图未做：回合结束判定、Scribe 话题漂移门、工具调用风险闸、独立验证边、推测性预热（见 `docs/jev-decision-layer.md` 第 6 节与 `docs/research/harness2-and-graph-engineering.md`）。
- 没有真人用麦克风/扬声器跑过完整对话。合成语音冒烟测试（`scripts/voice-smoke.py`）
  证明了链路和打断，但语气节奏、嘈杂环境下的 VAD 误触发、真实口音识别率只能真人测。
  这是 Phase A 最优先的缺口。
- `mail_reply`/`mail_forward`/`mail_trash` 的"确认后真正执行"没有在真实邮箱上各跑一次（`mail_send` 已真实验证）；`mail_watch` 未暴露给 LLM。
- 代码角色（带终端）没有中文口语路由入口，需要单独的安全决定。
- `Queen` 的 merge/wake 决策、`PopulationRegistry.retire()` 尚无触发规则（= Phase 3）。
- 邮件之外的设备控制器仍是可注入的接口占位，未接入具体系统（= Phase 5）。

### 媒体面/产品整体（详见根目录 `README.md` 的"Known gaps"一节）
- 未针对真实树莓派硬件调优/基准测试（= Phase 4 第二项）。
- Cloud-vs-local 引擎选择只发生在连接建立时，会话中途网络状态变化不会自动切换
  （设计如此，非缺陷）。
- 真实语音全双工对话未做人工验证：本机尚未用麦克风/扬声器跑完整对话
  （= Phase 4 最后一项）。文本事件注入 + 真实 LLM 的执行闭环已验证。

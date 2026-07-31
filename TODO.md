# TODO

工作计划与已知缺口的汇总入口。这是一份待办清单，不是 README——允许优先级标记、
勾选状态、依赖关系说明；面向准备接下来动手的人，不面向第一次了解这个项目的人
（那部分内容在 `README.md`/`README_CN.md`/`agent-runtime/README.md`）。

## 里程碑：从治理骨架到一次真正闭环的语音任务

当前状态：`agent-runtime` 的蜂群治理层（Queen/Population/PheromoneMap/GeneBank）
已经比"任务本身能不能被执行"更完整——本仓库目前没有任何生产代码把一个任务从
`pending` 推到终态。下面的排序原则：先让任务真的能被执行完，再回头用真实数据喂
治理层，最后才是需要产品决策的部分。

### Phase 1 — P0（阻塞项，本里程碑主体）：任务执行编排循环
一句语音指令要能真正走完"创建任务 → 派给角色 → Pi Session 执行 → 拿到结果 →
`TaskNest.transition()` 到终态 → `task.assimilate` 被触发"这条链路。

- [ ] 扩展 `agent-runtime/src/tasks/inbound-event-router.ts`：目前只处理
      `voice.transcript.final` 一种事件类型；`ReflexRouter` 已能判出
      steer/follow_up/cancel，但这些决策还没有派发到具体 `PiSession`
      （`sessionManager.steer()`/`abort()`）。
- [ ] 新增任务执行驱动：`TaskNest.create()` 之后需要真正调用
      `PiRoleSessionManager.prompt(roleId, taskId, text)`，并在 Pi Session 产出
      `agent_end`/工具执行失败等信号时调用 `taskNest.transition()` 落到
      `completed`/`failed`。
- [ ] 验收：起真实 `node dist/index.js` 子进程，发一条真实事件进去，断言
      `task_outcome`/`role_fitness` 表里真的多了一行（不是只测 hook 被正确调用）。

### Phase 2 — P1（依赖 Phase 1）：真实 pheromone/memory 信号
`agent-runtime/src/tasks/task-assimilation.ts` 目前把这两个字段固定写 `null`。

- [ ] 决定 pheromone delta 所需的 task-feature/device/network 上下文从哪一层拿
      （`TaskRecord` 本身不携带；ReflexRouter 的能力标签匹配结果是现成候选）。
- [ ] memory 写入必须经 `MemoryCurator` 审核后的压缩内容，不能直接把原始任务
      文本喂进去。

### Phase 3 — P2：Queen 的 merge/wake 决策 + `PopulationRegistry.retire()` 触发规则
- [ ] 纯函数规则/类型可以现在定稿（例如两个角色能力高度重叠触发 merge、休眠角色
      被高频路由命中触发 wake、连续失败达到阈值触发 retire）。
- [ ] 但接入 `src/index.ts` 组合根前，建议等 Phase 1/2 有真实 fitness/pheromone
      数据源之后再做——否则是拿假数据做真决策。

### Phase 4 — P0（非代码，发布前必须做）：真实环境验证
- [ ] 配置真实 LLM 凭据 + 找一台有麦克风/扬声器的机器，人工跑一次完整语音对话，
      确认 barge-in、播报延迟的主观听感（目前只验证到帧级/队列级）。
- [ ] 在真实树莓派上跑一次 `scripts/benchmark-runtime.sh --raspberry-pi`，把
      `.proj-init/performance-baseline.md` 的 Pi 章节从"未测"填成有数据。

### Phase 5 — P3（需要先做产品决策，暂不排期）
- [ ] 设备控制器（mail 之外）的真实实现——先决定目标平台（systemd？launchd？
      某个 IoT 网关？），再谈工作量。

## 已知缺口（现状记录，非任务本身）

### `agent-runtime`（详见 `agent-runtime/README.md` 的"已知缺口"一节）
- 没有任务执行编排循环（= Phase 1 要解决的问题）。
- `pheromone`/`memory` 增量固定为 `null`（= Phase 2）。
- `Queen` 的 merge/wake 决策、`PopulationRegistry.retire()` 尚无触发规则（= Phase 3）。
- `diplomacy-persistence.ts` 广播事件的 `sequence` 是进程内自增计数器，重启后归零，
  无跨重启的持久化序号源。
- 邮件之外的设备控制器仍是可注入的接口占位，未接入具体系统（= Phase 5）。

### 媒体面/产品整体（详见根目录 `README.md` 的"Known gaps"一节）
- 未针对真实树莓派硬件调优/基准测试（= Phase 4 第二项）。
- Cloud-vs-local 引擎选择只发生在连接建立时，会话中途网络状态变化不会自动切换
  （设计如此，非缺陷）。
- 真实语音全双工对话未做人工验证：本开发环境无麦克风/扬声器/真实 LLM 凭据
  （= Phase 4 第一项）。

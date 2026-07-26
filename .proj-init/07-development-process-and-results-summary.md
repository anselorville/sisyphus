# 自治虫群 Voice Agent — 开发过程与成果总结

> 记录范围：`.proj-init/05-autonomous-swarm-voice-agent-development-action-plan.md` 全部 20 个任务、6 个阶段的开发过程。
>
> 工作分支：`codex/swarm-voice-agent-runtime`（工作树 `.worktrees/swarm-voice-agent-runtime`）
>
> 完成日期：2026-07-26

## 一、项目背景

本项目起点是一个实时双语语音翻译器。根据 `04-autonomous-swarm-voice-agent-software-design.md` 确立的设计基线，整个产品被重新定义为一个语音优先、可长时运行、能自主分工与自我演化的个人 Agent 生态：

- Python 进程只保留 Pipecat 实时媒体能力（WebRTC、VAD、STT、TTS、本地打断），移除全部翻译业务逻辑。
- 新增 TypeScript sidecar（`agent-runtime/`），承载任务、角色、工具、资源经济与生态状态，内嵌 Pi Agent SDK。
- 前端从"语言对选择 + 双语字幕"改造为"语音助手主界面"。

## 二、开发方法

### 2.1 任务起点

行动计划的 Task 1-4（性能基线、事件协议、音频/turn 处理器抽取、翻译管道替换为媒体管道）在本轮开发开始前已经完成并提交（commit `cbfb326`–`404ad83`）。本轮工作从 **Task 5** 开始，一直执行到 **Task 20**（计划全部完成），对应提交 `422bbc9`–`0ab31ad`，共新增 17 个提交。

### 2.2 执行方式：并行子代理 + 强制独立复核

采用"调度并行代理"（`/dispatching-parallel-agents`）的工作法：

1. **按文件边界拆分任务**：同一阶段内文件互不重叠的任务（如 Stage B 的 Task 8/9/10、Stage C 的 Web/Device 工具）并行派发给独立子代理；存在依赖关系的任务（如 Task 11 的外交官必须先于 Task 12 的工种落地）严格串行。
2. **每个子代理独立完成 TDD 循环**：先写失败测试，确认失败原因正确，再实现，再跑通目标测试与回归测试，最后自行验证（`npm run check` / `npm test` / `uv run pytest`）。
3. **子代理不直接提交**：所有变更留在工作区，由主协调者（本次会话）逐一 `Read` 源码复核后再决定是否提交，避免"自己出的卷子自己判"。
4. **对每个子代理的完成报告都做独立复跑**：不信任自报的测试通过数字，而是亲自重跑测试、亲自读关键源码、必要时亲自起真实子进程验证（例如 Task 17 的 sidecar 崩溃恢复、Task 18 的浏览器渲染）。
5. **遇到瞬时基础设施故障（连接中断）时优先 `SendMessage` 续跑**已启动的子代理而非从零重派，最大化利用已完成的工作。本轮开发中共发生约 8 次连接中断，均通过检查磁盘实际状态后续跑或重派解决，未造成工作丢失。

### 2.3 阶段门（Stage Gate）的处理方式

行动计划为每个阶段设有"阶段门"验收场景（如"Stage E Gate: 构造一个当前角色无法完成的新工具任务，验证出生请求、隔离试运行……"）。这些场景大多要求一个尚未存在的"整机运行"能力（真正的 composition root 直到 Task 17 才交付）。处理原则：

- 阶段门涉及的每个子能力（出生请求、隔离试运行、Inspector 结果、基因保存、晋升/休眠……）逐项对照**已落地且通过的自动化测试**核实，确认它们在代码层面能够正确组合。
- 明确记录"完整端到端组合验证需等到 Task 17 的 composition root"，不在阶段门处伪造整机联调证据。
- Task 17 交付 composition root 后，用真实进程（真实 WebSocket 客户端、真实 SQLite 文件、真实 `node dist/index.js` 子进程）补齐了此前阶段门欠下的端到端证据。

## 三、交付成果（按阶段）

| 阶段 | 任务 | 核心交付 | 提交 |
| --- | --- | --- | --- |
| A. 媒体与性能基线 | 1-6 | 事件协议、有界队列、音频/turn 处理器、纯媒体管道、可抢占 Speech Queue 与本地 barge-in、Python↔sidecar WebSocket 事件桥 | `cbfb326`…`cc05671` |
| B. Pi 常态运行时 | 7-10 | TypeScript sidecar 脚手架与协议契约、WebSocket Server/DB Worker/Task Nest、独立 Pi Role Session 管理、Reflex Router/Interruption Router/Voice Herald | `bc428e9`…`4781fe8` |
| C. 首发能力与边界 | 11-12 | Capability Gateway + 外交事故评估官、Code/Web/Device/Mail 四个首发工种 | `dd00c61`, `4a625db`, `f082738` |
| D. 资源与生态 | 13-14 | API Budget/Subscription Quota/Provider Router、Queen + Population Registry + Prosperity Score + 软硬冬眠 | `f9981b9`, `27f8191` |
| E. 动态孕育与记忆 | 15-16 | Gene Bank + Role Incubator + Pi RPC 隔离舱、Inspector + Memory Curator + Pheromone Map | `e19eebc`, `7791fc5` |
| F. 产品与长期运行 | 17-20 | 完整 composition root（真实进程可启动/可崩溃恢复）、语音助手前端（替换翻译器 UI）、性能与故障注入测试、翻译遗留清理与发布验收 | `8501d9f`, `e6e0183`, `3356135`, `3c20cf8`, `0ab31ad` |

### 3.1 关键架构组件

- **Python 媒体层**（`app/realtime/`）：`events.py`（msgspec 事件协议）、`queueing.py`（有界优先级队列）、`speech_queue.py`（可抢占语音队列，本地 barge-in）、`event_bridge.py`（与 sidecar 的 WebSocket 桥，断线重连、去重、重放）。
- **TypeScript sidecar**（`agent-runtime/src/`）：
  - `protocol/` `transport/` — 与 Python 对齐的事件协议、有界出站队列、WebSocket Server。
  - `storage/` — SQLite 只在独立 Worker Thread 中打开，WAL 模式，批量事务。
  - `roles/` — 每个工种一个独立 Pi Session，同驻一个 Node 进程；`session-manager.ts` 支持软/硬冬眠门控。
  - `routing/` `voice/` — 纯规则、零 LLM 调用的插话分类与 Voice Herald（唯一允许发声的出口，内容安全过滤）。
  - `tools/` — Capability Gateway + Diplomacy Officer（ALLOW/ALLOW_LOGGED/ELEVATE 三态风险裁决）、Code/Web/Device/Mail 四个工种工具。
  - `economy/` `ecology/` — 两种粮食（API Budget、Subscription Quota）、Queen（确定性生态治理，无 prompt、无 tools）、Gene Bank/Role Incubator（角色孵化）、Pheromone Map（成功率强化与用户纠正惩罚）。
  - `isolation/` — Pi RPC 隔离舱，严格 LF JSONL 分帧，首版并发上限为 1。
  - `inspection/` `memory/` — Inspector（无证据不判定成功）、Memory Curator（原始工具日志/邮件正文/思维链永不自动进入长期记忆）。
  - `index.ts` — composition root，只负责构造与装配，不写业务逻辑；支持真实 SIGINT/SIGTERM 优雅关闭与崩溃后自动恢复。
- **前端**（`client/src/`）：`AgentHomeScreen` 及配套 `AgentStatusStrip`/`TaskNestPanel`/`EcologyPanel`/`ElevationDialog`，`useAgentConnection`/`useAgentTasks`/`useEcologyStatus` 三个 Hook，均以 Storybook 状态用例 + 纯 reducer 单元测试驱动。

## 四、开发过程中发现并修复的问题

除计划本身要求的功能外，本轮开发过程中通过"真实进程而非双方各自 mock"的集成测试，发现并修复了以下计划之外、影响系统正确性的缺陷：

1. **SQLite 外键约束顺序错误**（Task 8）：`tasks.role_id` 被误建为指向 `roles.id` 的外键，而角色分配（Task Nest）与角色基因持久化（Gene Bank，Task 15 才交付）本是两条独立生命周期，导致任务分配在角色尚未持久化时直接失败。已改为普通字段并加索引。
2. **Python↔TypeScript 三处真实的跨语言协议不兼容**（Task 17，最严重的一批发现）：
   - Python `websockets.send(bytes)` 默认发送二进制帧，而 sidecar 把所有二进制帧当作音频静默丢弃 —— **上线前 Python 发出的每一条事件事实上都从未被 sidecar 接收过**。
   - Python 把事件包一层 `{"kind":"event","event":...}`，但 sidecar 的 TypeBox schema 要求裸 `RealtimeEvent`，直接拒绝。
   - msgspec 默认把未设置字段编码为显式 `null`，而 TypeBox 的 `Optional` 语义是"键可省略"而非"值可为 null"，导致任何缺省 `task_id`/`interaction_id` 的事件都校验失败。
   - 三处问题此前均未被发现，原因是双方各自的测试都只用**本语言编写的假对端**，从未真正互相通信过。修复后同时更新了共享测试夹具 `tests/conftest.py`，全部既有测试保持通过。
3. **崩溃恢复的任务重复创建竞态**（Task 17）：sidecar 的入站事件去重只在单条 WebSocket 连接的内存中生效，重连后失效；`TaskNest.create()` 原本没有幂等键，若崩溃发生在"任务已持久化、ack 尚未送达"的窗口期，重放会创建重复任务。已为 `TaskNest.create()` 增加基于 `metadata.sourceEventId` 的幂等去重（含跨重启的恢复场景与容量淘汰后的清理）。
4. **`tool.progress` 事件类型缺失**（Task 19 发现）：Python 侧自 Task 2 起就在队列合并规则中使用 `tool.progress` 作为一个真实、被测试覆盖的事件类型，但 TypeScript 侧的 `RealtimeEventType` 联合类型从未包含它 —— 任何此类事件同样会被 schema 直接拒绝。已补齐类型定义，并说明为何暂不将其纳入 sidecar 出站队列的合并规则（合并粒度不同，且该方向目前无实际生产者，默认按 DURABLE 处理更安全）。

## 五、测试与验证

完成 Task 20 时，三套生态系统的验证全部独立复跑通过：

| 生态 | 结果 |
| --- | --- |
| Python（`uv run pytest -q`） | **66 passed** |
| TypeScript sidecar（`agent-runtime`：`npm test` / `npm run check` / `npm run build`） | **509 passed**，类型检查与构建均无错误 |
| 前端（`client`：`npm run build` / `npm run build-storybook`） | 构建与 Storybook 构建均成功 |

验证方式上坚持"能起真实进程就不用 fake"：Task 17 的崩溃恢复测试起真实 `node dist/index.js` 子进程并 `SIGKILL`；Task 18 用真实 headless Chrome 打开真实页面，核对与真实后端的网络往返；Task 19 的突发负载测试起真实 sidecar 子进程测量端到端延迟（而非仅测本地入队耗时）。

## 六、已知限制（诚实记录，非遗留缺陷）

以下两项在 `.proj-init/06-software-release-acceptance.md` 与 `.proj-init/performance-baseline.md` 中被明确标记为"待真实环境验证"，而非伪造数据充数：

1. **树莓派性能基线未测**：开发环境不具备树莓派硬件，`scripts/benchmark-runtime.sh --raspberry-pi` 已实现并会主动拒绝在非 ARM Linux 环境上运行，防止误用开发机数据冒充 Pi 数据，但尚未在真实硬件上跑过。
2. **真实语音全双工对话未做人工验证**：本环境没有麦克风/扬声器硬件，也没有配置真实的 LLM/Pi 服务凭据。发布验收文档中的每一项都标注了具体自动化测试证据（文件路径 + 用例名），凡是必须依赖真实语音硬件或真实模型凭据才能验证的项目，一律显式标注"NOT VERIFIED — 待真实硬件/凭据/部署"。

## 七、后续建议

- 尽快在真实树莓派上跑一次 `scripts/benchmark-runtime.sh --raspberry-pi`，把 `.proj-init/performance-baseline.md` 的 Pi 章节补齐——这是发布前唯一被文档正式标记为阻塞项的检查。
- 配置真实 LLM/Pi 凭据后，跑一次真实语音对话，人工确认全双工听说、barge-in 的听感延迟（当前只验证到帧级/队列级正确性与延迟预算，未验证"人耳能听出来"的主观体验）。
- Reflex Router 的插话决策（steer/followUp/cancel）目前只在 Task 17 的最小集成范围内接入 Task Nest；把这些决策实际派发到具体 Pi Session（`sessionManager.steer()`/`abort()`）是下一步很自然的延伸，当前 `inbound-event-router.ts` 只处理了 `voice.transcript.final` 一种事件类型。

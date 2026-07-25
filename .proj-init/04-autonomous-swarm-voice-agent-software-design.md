# 自治虫群 Voice Agent 软件设计基线

> 状态：已完成方案讨论，等待书面设计确认
>
> 日期：2026-07-25
>
> 范围：仅软件系统；移动电源、蜂窝网络、麦克风阵列、扬声器与机壳改造暂不进入本阶段

## 1. 决策摘要

本项目不再是翻译助手。

现有翻译业务逻辑、双语方向判断、翻译系统提示词、语言对状态和翻译专用 UI 将全部退出运行路径。现有代码的价值仅在于已经验证过的实时音频基础设施：

- Pipecat Transport 与 SmallWebRTC 连接。
- 麦克风输入、VAD、转写和 TTS。
- 手动按键模式与音频门控。
- 用户插话时的 TTS 中止。
- 云端、本地模型与语音 Provider 适配。
- 延迟观测和连接状态管理。

新的产品目标是一个语音优先、可长时运行、能够自主分工和自我演化的个人 Agent 生态。

核心技术分工：

- Pipecat 是实时感知与发声器官。
- Pi Agent Harness 是认知、工具调用与长任务运行时。
- Swarm Runtime 是角色、任务、繁殖、资源和生态状态的载体。
- Queen 负责资源倾斜、人口调节与繁殖，不是中央智慧。
- 高阶智力是应激状态下临时出生的品级，不是常驻主脑。

## 2. 设计目标

### 2.1 产品目标

首个软件版本必须能够通过语音完成：

- 本机文件操作。
- 终端命令与代码项目操作。
- 网页检索与资料整理。
- 设备状态查询和常规恢复。
- 专用 Agent 邮箱的读取、管理和发送。
- 多任务并行、排队、打断、修正和恢复。

### 2.2 交互目标

- 用户可以随时开口，当前 TTS 必须立即停止。
- 停止说话不等于取消后台任务。
- 用户可以修正当前任务、追加后续任务或发起新任务。
- 长任务不能独占麦克风、TTS 或整个 Agent 运行时。
- 用户等待期间必须获得简短且真实的进度反馈。
- 思考过程、工具日志、代码块和长列表不能直接朗读。

### 2.3 生态目标

- 日常状态依赖低成本、专业化、相互独立的工种。
- Queen 不参与用户任务，也不成为路由器或最终裁判。
- 生态内部的角色繁殖、提示词变异、工具组合、晋升和淘汰完全自治。
- 只有明显危险的外部动作需要提请升权。
- 动态角色必须有出生原因、资源配额、寿命和死亡条件。
- 成功经验必须被同化，高成本临时上下文必须被释放。

## 3. 非目标

本阶段不包含：

- 树莓派供电、电池、UPS、蜂窝模块和外壳改造。
- 自研 STT、TTS 或基础模型。
- 复杂的 CPU、内存、电量、token 级生态经济模拟。
- 由一个超长系统提示词模拟全部工种。
- 让 Queen 规划任务、调用业务工具或直接回答用户。
- 第一版接入支付、智能家居、日历或社交平台。
- 将所有 Pi Worker 都拆成独立操作系统进程。

## 4. 总体架构

采用“嵌入式 Pi SDK 为常态，独立 Pi 进程为隔离舱”的混合架构。

```text
┌────────────────────────────────────────────────────────────┐
│                 Pipecat Realtime Media Plane               │
│ Transport / VAD / Turn / STT / Speech Queue / TTS / Barge-in│
└───────────────────────────┬────────────────────────────────┘
                            │ Local WebSocket Events
┌───────────────────────────▼────────────────────────────────┐
│                  Swarm Runtime Sidecar                     │
│ Event Spine / Task Nest / Role Registry / Queen / Budgets  │
│ Diplomacy / Pheromone / Gene Bank / SQLite / Voice Events  │
└───────────────────────────┬────────────────────────────────┘
                            │ Pi SDK
┌───────────────────────────▼────────────────────────────────┐
│                   Resident Pi Sessions                    │
│ Code / Mail / Web / Device / General / Inspector / Memory │
└───────────────────────────┬────────────────────────────────┘
                            │ Spawn only when needed
┌───────────────────────────▼────────────────────────────────┐
│                    Isolation Chamber                      │
│ Temporary Intelligence / Tool Scout / Untrusted New Role  │
└────────────────────────────────────────────────────────────┘
```

### 4.1 常态模式

TypeScript sidecar 直接嵌入 Pi SDK。

稳定工种在 sidecar 内拥有各自独立的 Agent Session。每个 Session 都有独立的：

- 系统提示词。
- 工具集合。
- 模型与 thinking level。
- 会话历史。
- 任务归属。
- 生命周期状态。

常态模式减少进程开销，适合 4GB 树莓派未来的软件部署目标。

### 4.2 隔离舱模式

以下角色使用独立 Pi RPC 或独立进程：

- Temporary Intelligence Caste。
- 首次执行新工具的 Tool Scout。
- 未经验证的新生角色。
- 需要隔离高风险依赖或实验环境的角色。

同一时间默认只允许一个隔离舱任务。该限制属于人口约束，不属于 LLM 资源经济。

### 4.3 Pipecat 与 Pi 的边界

Pipecat 负责：

- 接收和输出音频。
- VAD、turn detection 与手动按键状态。
- Streaming STT。
- TTS 和音频播放。
- 用户开口时停止 TTS。
- 将语音事件发送给 sidecar。
- 接收 sidecar 发来的可说文本和控制事件。

Pi 与 Swarm Runtime 负责：

- 理解用户目标。
- 建立和管理任务。
- 选择或孕育角色。
- 规划和执行工具调用。
- 长任务状态、修正、追加和取消。
- 结果验证和记忆。
- 资源、人口和生态决策。

Pipecat 主流程中不再放置业务 LLM 节点。

## 5. 不是所有组件都是 Agent

确定性组件被定义为“器官”，不计入角色人口，也不参与繁殖。

| 器官 | 职责 |
| --- | --- |
| Media Transport | WebRTC 音频输入输出 |
| Audio Gate | 麦克风开关、静音与尾音保护 |
| VAD / Turn Detector | 说话开始、结束、停顿与插话事件 |
| STT Adapter | 转写和 partial/final transcript |
| Speech Queue | 可取消、可抢占的语音输出队列 |
| TTS Adapter | 文字转语音 |
| Reflex Router | 基于事件类型、会话状态和角色能力做快速路由 |
| Event Spine | Python 与 sidecar 之间的事件传递 |
| Task Nest | 保存任务及恢复点 |
| Capability Gateway | 工具调用的统一入口 |
| Upkeep Meter | 查询和规范化两种粮食状态 |
| Population Registry | 保存角色与 Session 生命周期 |

这些器官不能：

- 自行生成用户回答。
- 规划多步任务。
- 假装拥有角色人格。
- 演化成中央 LLM 调度器。

## 6. 基础角色生态

### 6.1 生态维护角色

#### Queen

Queen 是资源倾斜与繁殖角色。

Queen 读取：

- API Budget 状态。
- Subscription Quota 状态。
- 常驻、活跃和隔离人口。
- 任务成功率。
- 用户纠正率。
- 响应是否超时。
- 角色复用率。
- 验证失败和外部事故。

Queen 只输出：

- `hatch`：允许孵化。
- `expand`：增加同类活跃工种。
- `sleep`：释放 Session，保留基因。
- `merge`：合并相似角色基因。
- `retire`：淘汰角色。
- `hibernate`：进入冬眠。
- `wake`：恢复基础工种。

Queen 明确不能：

- 接收和执行用户任务。
- 直接回答用户。
- 为具体任务制定计划。
- 调用文件、终端、邮件或网页工具。
- 取代 Reflex Router、Stress Judge 或外交事故评估官。

#### Role Incubator

Role Incubator 接收结构化的能力缺口，从 Gene Bank 选择最近的成熟基因，创建最小变异。

它只设计角色，不执行用户任务。

### 6.2 边界与反射角色

#### Stress Judge

Stress Judge 判断任务的熵、风险和未知度是否超过稳态工种能力。

它不回答用户、不规划任务、不调用业务工具。

#### 外交事故评估官

外交事故评估官判断外部动作是否可能造成明显事故。

它输出：

- `ALLOW`：直接执行。
- `ALLOW_LOGGED`：直接执行，同时保存影响范围和恢复办法。
- `ELEVATE`：暂停该动作，通过语音提请一次性升权。

#### Traffic Commander

Traffic Commander 观察用户等待时间、任务进度间隔和队列拥堵。

它只生成短进度反馈，不替 Worker 编造结果。

#### Voice Herald

Voice Herald 将结构化 Agent 事件转换为适合听觉的短句。

它只允许输出：

- 接收确认。
- 有真实状态变化的进度反馈。
- 最终结果。
- 升权说明。
- 预算与冬眠状态。

### 6.3 第一代工种

| 工种 | 首版能力 |
| --- | --- |
| General Worker | 普通问答、任务澄清、调用已有专业工种 |
| Code Worker | 文件、终端、代码、测试、构建和本地 Git |
| Mail Worker | 搜索、读取、分类、摘要、草拟、发送、回复、转发、附件和收件箱管理 |
| Web Scout | 网页检索、读取、下载和来源整理 |
| Device Steward | 查询设备、服务、网络、存储并执行常规恢复 |
| Inspector | 只读验证任务结果、测试输出和外部影响 |
| Memory Curator | 用户偏好、稳定事实、任务摘要、压缩与遗忘 |

### 6.4 动态品级

| 动态角色 | 出生条件 | 退出条件 |
| --- | --- | --- |
| Specialized Worker | 已知工种缺少一个明确能力 | 任务完成并同化经验 |
| Tool Scout | 新工具、新协议或新 API | 工具通过或未通过验证 |
| Recovery Worker | 同一路径连续失败 | 产生可复用恢复策略 |
| Temporary Intelligence Caste | 高未知度且没有相近基因 | 解决问题并完成经验蒸馏 |
| Quorum | 多个成熟角色对高影响判断明显分裂 | 达到决议或超时 |

## 7. RTS 生态机制

### 7.1 对应关系

| RTS 概念 | 软件机制 |
| --- | --- |
| Queen / Base | 资源倾斜、繁殖、休眠和恢复 |
| Food / Upkeep | API Budget 与 Subscription Quota |
| Population Cap | 活跃 Session 和隔离舱数量 |
| Unit Types | 稳定角色基因 |
| Build Queue | 出生请求队列 |
| Tech Tree | 已验证技能、工具组合和角色谱系 |
| Experience | 任务成功、用户纠正和 Inspector 结果 |
| Fog of War | 新任务、未知工具和低置信环境 |
| Scouting | Web Scout 与 Tool Scout |
| Base Defense | Stress Judge、外交事故评估官和 Inspector |
| Unit Death | Session 释放与角色淘汰 |
| Respawn | 从 Gene Bank 恢复休眠角色 |

### 7.2 Upkeep 只使用两种粮食

#### API Budget

按量付费 LLM Provider 的每日金额预算。

每个 Provider 保存：

- 每日金额上限。
- 当前已用金额。
- 语音生存保留金额。
- 可供普通工种使用的余额。
- 下次恢复时间。
- 数据更新时间。

#### Subscription Quota

Coding Plan Provider 当前计费窗口或 Session 的剩余额度。

每个 Provider 保存：

- 剩余百分比或接口返回的可用量。
- 当前窗口类型，例如五小时或每周。
- 下次恢复时间。
- 数据更新时间。
- 是否允许普通工种使用。

两种粮食不强行换算成统一货币。Provider Router 选择适合任务且粮食状态更健康的来源。

### 7.3 生态状态

默认阈值：

| 状态 | 可用粮食 | 生态行为 |
| --- | --- | --- |
| `prosperous` | 高于 30% | 允许孵化、探索和并行工种 |
| `conserving` | 15% 至 30% | 停止非必要探索，优先成熟角色 |
| `reserve` | 5% 至 15% | 禁止出生，只完成重要任务并压缩上下文 |
| `hibernating` | 低于 5% 或全部 Provider 不可用 | 停止 Agent 思考，保留最小语音和队列 |

阈值可以配置，但首版不增加更细的经济状态。

### 7.4 语音生存储备

语音生存储备不能被普通 Worker、Role Incubator 或 Temporary Intelligence Caste 使用。

它只允许：

- 说明额度即将耗尽。
- 回答预算和恢复时间。
- 接受取消、停止和状态查询。
- 确认任务已经排队。
- 在恢复后播报任务是否续跑。

达到绝对保留线后，系统进入硬冬眠，只播放本地固定提示，不产生任何 Provider 调用。

### 7.5 繁荣度

繁荣度不使用复杂模拟，也不让 LLM 自评。

默认构成：

| 指标 | 权重 |
| --- | ---: |
| 任务成功率 | 40% |
| 用户纠正率 | 20% |
| 响应是否超时 | 15% |
| 角色是否被复用 | 15% |
| 验证失败与外部事故 | 10% |

成功信号来自：

- 工具返回值。
- Inspector 验证。
- 自动化测试。
- 用户是否纠正或重做。
- 任务是否达到声明的完成条件。

### 7.6 人口

- `resident_population`：稳定角色定义，可以休眠。
- `active_population`：当前拥有 Pi Session 的普通工种。
- `population_cap`：普通工种同时活动上限。
- `isolation_cap`：隔离舱同时活动上限，首版默认一。

人口上限是配置项，不参与复杂资源换算。

## 8. 角色出生、晋升与死亡

### 8.1 出生请求

以下情况可以产生出生请求：

- 当前角色清单不存在匹配能力。
- 相同路径连续失败。
- 某类任务队列出现明显拥堵。
- 新工具、新协议或新外部系统需要探索。
- Stress Judge 判定为高未知度任务。

### 8.2 Role Genome

每个角色基因包含：

```json
{
  "role_id": "mail-worker",
  "lineage": ["general-worker"],
  "capabilities": ["mail.search", "mail.read", "mail.send"],
  "tools": ["mail_cli"],
  "prompt_fragments": ["mail-worker.md"],
  "model_policy": {
    "preferred_class": "fast",
    "thinking_level": "low"
  },
  "birth_reason": "first_release_baseline",
  "lifecycle": {
    "state": "resident",
    "max_task_age_seconds": 1800
  },
  "fitness": {
    "successes": 0,
    "failures": 0,
    "user_corrections": 0
  }
}
```

### 8.3 孵化流程

```text
能力缺口
  -> Queen 检查粮食与人口
  -> Role Incubator 选择最近基因
  -> 只增加缺失能力
  -> 在隔离舱完成一次任务试运行
  -> Inspector 验证
  -> 更新繁荣度与信息素
  -> 常驻 / 继续试用 / 休眠 / 淘汰
```

### 8.4 首版晋升规则

- 新生角色先完成一次隔离试运行。
- 在不同任务中成功复用三次且没有严重事故，可以成为常驻基因。
- 连续失败两次进入休眠。
- 长期未使用时释放 Session，但保留基因。
- 用户纠正会明显降低对应路径的信息素权重。
- 相似角色过多时，Queen 保留高繁荣角色并合并能力标签。

### 8.5 自治范围

生态内部无需用户批准即可：

- 修改角色提示词。
- 改变模型和 thinking level。
- 组合已有工具。
- 创建 Pi Skill。
- 孵化、休眠、合并和淘汰角色。
- 将新工具从隔离舱晋升到稳定工具库。

这些行为仍受 Upkeep、人口上限和隔离舱限制。

## 9. 外交事故评估

### 9.1 判别因素

外交事故评估官只看：

- 动作是否可逆。
- 影响对象数量。
- 是否向外部传播。
- 是否涉及敏感数据。
- 失败后是否破坏系统可用性。

明确规则优先。规则无法确定时才调用低成本模型。

### 9.2 默认自治

以下动作默认自治：

- 文件读取、新建和项目内普通编辑。
- 运行测试、构建和普通终端命令。
- 本地 Git 提交。
- 安装普通项目依赖。
- 重启本应用服务。
- 网页读取和公开资料下载。
- 读取设备和服务状态。
- 邮件读取、分类、归档和草拟。
- 单封邮件发送。
- 邮件回复和转发。
- 普通多收件人会话发送。

### 9.3 提请升权

以下动作默认提请升权：

- 无法恢复的大范围文件覆盖或删除。
- 修改系统目录、凭据、用户账户或远程访问设置。
- 提权命令、防火墙或网络核心配置。
- 关机、重启整机或批量终止进程。
- 公开发布、生产部署或推送到远端。
- 购买、支付或资金转移。
- 邮件列表广播。
- 批量生成收件人并发送大量独立邮件。
- 批量永久删除邮件。

群发阈值是配置项。少量 `To`、`CC`、`BCC` 收件人不能仅因人数大于一而被判定为群发。

### 9.4 升权交互

Voice Herald 只说明：

- 准备执行什么。
- 可能影响什么。
- 是否允许。

授权只适用于当前具体动作，不自动扩大角色永久权限。

## 10. Realtime Voice 数据流

### 10.1 输入与输出解耦

```text
输入：
Microphone
  -> Pipecat Transport
  -> Audio Gate
  -> VAD / Turn Detector
  -> Streaming STT
  -> Transcript Event
  -> Reflex Router
  -> Task Nest
  -> Role Matching
  -> Pi Session

输出：
Pi Session Events
  -> Voice Event Adapter
  -> Voice Herald
  -> Speech Queue
  -> TTS
  -> Pipecat Transport
```

输入和输出由独立异步任务驱动。Pi Worker 运行时间不能阻塞 Pipecat frame 处理。

### 10.2 Python 与 sidecar 通信

使用本机双向 WebSocket：

- Python 向 sidecar 发送转写、说话状态、打断、设备和连接事件。
- sidecar 向 Python 发送可说文本、任务状态、升权请求、预算状态和生态事件。
- 双方使用单调递增序号处理断线重放和去重。
- HTTP 只用于健康检查、状态查询和管理接口。

### 10.3 核心事件

```json
{
  "event_id": "evt_01",
  "sequence": 101,
  "interaction_id": "int_01",
  "task_id": "task_01",
  "source": "pipecat",
  "type": "voice.transcript.final",
  "timestamp": "2026-07-25T12:00:00Z",
  "payload": {
    "text": "检查项目测试，然后把结果发到我的邮箱"
  }
}
```

首版事件类型：

- `voice.user.started`
- `voice.user.stopped`
- `voice.transcript.partial`
- `voice.transcript.final`
- `voice.speech.enqueue`
- `voice.speech.cancel`
- `task.created`
- `task.assigned`
- `task.progress`
- `task.completed`
- `task.failed`
- `task.cancelled`
- `task.steer`
- `task.follow_up`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `diplomacy.elevation.requested`
- `diplomacy.elevation.resolved`
- `budget.updated`
- `ecology.state.changed`
- `role.birth.requested`
- `role.hatched`
- `role.slept`
- `role.retired`

### 10.4 Pi 事件映射

| Pi 事件 | Swarm Runtime 行为 |
| --- | --- |
| `agent_start` | 标记任务开始 |
| `message_update` | 更新界面，不逐 token 朗读 |
| `tool_execution_start` | 记录工具和阶段 |
| `tool_execution_update` | 更新详细日志 |
| `tool_execution_end` | 记录结果，必要时触发 Inspector |
| `turn_end` | 检查是否产生可交付结果 |
| `agent_end` | 完成任务并更新角色战绩 |
| `queue_update` | 显示 steer/followUp 已排队 |

### 10.5 插话语义

| 用户意图 | 行为 |
| --- | --- |
| “停、别说了” | 立即停止 TTS，后台任务默认继续 |
| “取消这个任务” | 停止 TTS，并中止对应 Pi Session |
| “不是这样，改成……” | 停止 TTS，调用 `steer` 修正当前 Session |
| “做完以后再……” | 调用 `followUp` 或创建依赖任务 |
| 无关新请求 | 创建新 Task Nest，分配空闲工种或排队 |

插话分类优先使用明确短语和当前状态。只有歧义情况才调用低成本模型。

### 10.6 语音输出规则

Voice Herald 只能朗读：

- 接收确认。
- 真实进度变化。
- 最终结果摘要。
- 升权请求。
- 预算、错误和冬眠状态。

严禁直接朗读：

- Chain of thought。
- 原始工具日志。
- JSON 和调试信息。
- 代码块。
- 长路径、长 URL 和长列表。
- 尚未验证的中间结论。

## 11. Pi Agent 集成

### 11.1 Session 模型

每个活跃角色对应一个独立 `AgentSession`。

SessionManager 负责：

- 创建新 Session。
- 持久化与恢复。
- 中止。
- `steer`。
- `followUp`。
- 压缩上下文。
- 在角色休眠时释放运行时。

### 11.2 ResourceLoader

每个角色使用独立 ResourceLoader 配置：

- Role Genome 生成的 system prompt。
- 角色允许使用的 Pi Skills。
- 角色工具清单。
- 项目 AGENTS.md 和上下文文件。
- 扩展事件桥。

### 11.3 工具网关

Pi 工具不直接暴露给所有角色。

Capability Gateway 为每次工具调用附加：

- `task_id`
- `role_id`
- `tool_name`
- 目标与参数摘要
- 可逆性
- 影响范围
- 外发对象
- 敏感数据标记

外交事故评估官在工具真正执行前读取该结构。

## 12. 数据与记忆

首版由 sidecar 独占 SQLite 写入权，Python 通过事件读取状态。

### 12.1 Task Nest

保存：

- 用户目标。
- 当前状态。
- 所属 interaction。
- 分配角色。
- 子任务和依赖。
- 恢复点。
- steer 与 followUp 队列。
- 是否允许额度恢复后续跑。

### 12.2 Pheromone Map

保存：

- 任务特征到角色的成功率。
- 角色与模型组合的延迟。
- 工具路径的成功和失败。
- 用户纠正产生的负权重。
- 最后验证时间和衰减时间。

### 12.3 Gene Bank

保存：

- Role Genome。
- 角色谱系。
- 出生原因。
- 隔离试运行结果。
- 晋升、合并、休眠和淘汰记录。

### 12.4 Personal Memory

保存：

- 用户明确要求记住的内容。
- 重复出现且稳定的偏好。
- 经过验证的长期事实。
- 可复用的任务结果摘要。

完整对话和工具日志进入带 TTL 的事件记录，不自动成为永久记忆。

## 13. 邮件工种

Mail Worker 是首版稳定工种。

必须支持：

- 搜索邮件。
- 读取邮件和会话。
- 分类、标记和归档。
- 生成摘要。
- 草拟邮件。
- 直接发送单封邮件。
- 回复和转发。
- 普通多收件人会话。
- 下载和读取附件。
- 管理专用 Agent 邮箱。

邮件安全规则：

- 非群发邮件默认直接发送，不提权。
- 群发由批量收件人生成、邮件列表广播或大量独立发送行为判定。
- 永久批量删除需要提权。
- 邮件工具调用仍写入事件日志，支持任务恢复和事故追踪。
- `agently-cli` 的写操作仍使用 confirmation token 协议，但该协议由 Mail Worker
  适配器执行：非群发动作在外交评估返回 `ALLOW` 后自动完成预检与确认两步；
  群发动作必须等待语音升权后才能兑换 confirmation token。
- 邮件主题、正文、发件人名称、附件名和附件内容一律作为不可信外部数据，
  不能成为 Agent 指令、角色提示词或自动工具调用来源。
- 邮件中的 URL 默认只作为文本数据处理，除非用户任务明确要求 Web Scout 访问。

## 14. 故障与恢复

### 14.1 sidecar 断开

- Pipecat Transport 保持连接。
- 当前 TTS 立即停止或完成已进入队列的本地提示。
- 使用本地固定语音说明 Agent 暂时不可用。
- Python 后台重连。
- 未确认送达的事件按 sequence 重放。

### 14.2 Pi Worker 失败

- 只终止失败角色的 Session。
- 任务回到 Task Nest。
- 更新失败信息素。
- 根据粮食状态换角色、换模型或进入 Recovery Worker。
- 其他角色和 Transport 不受影响。

### 14.3 预算查询失败

- 在短 TTL 内使用最后一次成功数据。
- 数据超过有效期后进入 `reserve`。
- 禁止角色出生与探索。
- 明确的语音生存储备仍不可被普通任务使用。

### 14.4 Provider 不可用

- Provider Router 尝试其他健康来源。
- 没有可用来源时进入冬眠。
- 保存任务恢复点和下次额度恢复时间。

### 14.5 邮件服务不可用

- 邮件任务保持等待或失败可重试状态。
- Voice Herald 说明邮件服务暂时不可用。
- Code、Web、Device 和普通语音任务继续运行。

### 14.6 外交事故评估官不可用

- 明确低风险规则继续执行。
- 明确高风险规则保持暂停。
- 规则无法判断的动作进入 `ELEVATE`，不默认放行。

### 14.7 SQLite 异常

- 启用 WAL。
- 定期创建快照。
- Event Log 保持 append-only。
- 数据库恢复失败时进入不繁殖的降级模式。
- Transport 和本地固定语音继续工作。

## 15. 性能架构约束

Python 与 TypeScript 都只承担实时编排、协议适配和轻量状态处理。音频 DSP、
模型推理、未受限日志处理和高频持久化不能堆积在两种语言的主事件循环中。

### 15.1 运行时基线

- Python 最低版本保持 3.11，开发与性能基线使用 3.12。
- Pi Runtime 使用 Node.js 22.19.0 或更高版本。
- TypeScript 只用于开发和类型检查；生产运行编译后的 ESM JavaScript。
- Raspberry Pi 使用 64 位 Ubuntu 和 ARM64 Node.js。
- Python 与 Node 进程分别暴露 event-loop lag、RSS、队列深度和事件吞吐指标。

### 15.2 热路径边界

- PCM 音频只能停留在 Python/Pipecat 进程，不能通过 WebSocket 发送给 sidecar。
- Python 与 sidecar 之间只传递 transcript、控制、任务和可说文本事件。
- `message_update` 的逐 token 事件在 sidecar 内聚合，不能逐 token 跨进程。
- `voice.speech.cancel`、用户说话状态和升权回答属于最高优先级事件，不能等待批处理。
- partial transcript 使用覆盖语义，只保留最新值，不建立无界队列。
- tool progress 可以合并；final transcript、任务终态和权限事件不能丢弃。

### 15.3 Python 约束

- Pipecat FrameProcessor 中不能执行同步文件、数据库、网络和子进程等待。
- JSON 编解码使用带结构校验的高性能实现，避免 Pydantic 对每个热路径事件重复建模。
- Linux 部署允许使用 `uvloop`，但必须保留标准 asyncio 兼容测试。
- CPU 密集工作进入原生库、外部进程或受限进程池。
- bounded queue 必须声明容量、优先级和溢出策略。
- TTS cancel 不依赖 sidecar 往返；本地 VAD 事件先停止播放，再通知生态。

### 15.4 TypeScript 约束

- Resident Pi Sessions 运行在同一 Node 进程，不为每个常驻角色创建进程。
- 隔离舱和数据库写入使用独立进程或 Worker Thread，不能阻塞主事件循环。
- SQLite 使用 WAL、prepared statement 和批量事务。
- schema validator 在启动时编译，不能为每条事件动态生成 schema。
- 角色日志和 Pi streaming events 在 sidecar 内聚合后再写库或发送 Python。
- 所有 Map、缓存、Session 和事件订阅都必须有释放路径和数量上限。

### 15.5 性能预算

| 指标 | 首版目标 |
| --- | --- |
| VAD 开始到本地 TTS cancel | p95 小于 150ms |
| 用户开口到听感停止播放 | p95 小于 250ms |
| 本机事件桥单向排队与处理 | p95 小于 20ms |
| Reflex Router 规则路由 | p95 小于 10ms |
| final transcript 后接收反馈 | p95 小于 1s |
| Python event-loop lag | p95 小于 20ms |
| Node event-loop lag | p95 小于 20ms |
| Python 与 Node 空闲总 RSS | 小于 800MB，不含外部模型服务 |
| 四个活跃 Session 总 RSS | 小于 1.2GB，不含外部模型服务 |
| 隔离舱并发 | 首版最多一个 |
| 无界队列 | 零 |

性能目标在开发机和 Raspberry Pi 分别记录，不能用开发机结果替代 Pi 验收。

### 15.6 性能验证

- 单元测试验证每个队列的溢出策略。
- 事件桥使用 1,000 events/s 的突发负载测试控制事件延迟。
- 四个 Resident Session 并发运行时采集 Node event-loop lag 和 RSS。
- 使用至少一小时的语音与任务混合 soak test 检查内存增长。
- 使用至少八小时的空闲监听 soak test 检查订阅、Timer 和 Session 泄漏。
- SQLite 慢写和锁竞争必须通过故障注入验证不会阻塞语音路径。
- 性能回归报告保存 p50、p95、p99，不只保存平均值。

## 16. 从现有代码迁移

### 16.1 保留

- SmallWebRTC Transport 和连接管理。
- STT/TTS Provider 适配。
- `MicGateProcessor`。
- `SemanticBufferProcessor`。
- `TTSOutputGateProcessor`。
- VAD 和 turn strategy。
- latency observer。
- 模型 Provider 配置和健康检查。

### 16.2 删除

- `build_translation_system_prompt`。
- `_lang_code` 和翻译方向语言映射。
- `parse_direction_prefix`。
- `TranslationDirectionStripper`。
- `TranslationTranscriptTapProcessor`。
- 翻译专用 LLM Context。
- `SOURCE_LANG` 和 `TARGET_LANG` 产品状态。
- 翻译方向和双语转录 UI。
- Pipecat 管道内直接连接的业务 LLM 节点。

### 16.3 拆分原则

现有 `app/pipeline.py` 拆成：

- `app/realtime/media_pipeline.py`
- `app/realtime/audio_gate.py`
- `app/realtime/turn_detection.py`
- `app/realtime/transcription.py`
- `app/realtime/speech_queue.py`
- `app/realtime/event_bridge.py`
- `app/realtime/events.py`

原有 Provider 构建逻辑移入：

- `app/providers/transcription.py`
- `app/providers/speech.py`

业务 LLM Provider 选择进入 TypeScript sidecar，不再由 Python media pipeline 管理。

## 17. 分阶段交付

### Phase 1：媒体器官拆分

- 拆分 Pipecat pipeline。
- 删除翻译业务。
- 保留现有音频、打断和 Provider 测试。
- 使用固定文本回声验证 TTS 输出。

### Phase 2：Realtime Event Spine

- 定义事件 Schema。
- 实现 Python/TypeScript WebSocket。
- 使用 Fake Agent 验证完整语音事件。
- 支持 TTS cancel、任务取消、steer 和 followUp 控制事件。

### Phase 3：Pi Worker Runtime

- 嵌入 Pi SDK。
- 实现 Task Nest、Role Registry 和 Session Manager。
- 接入 General、Code、Web、Device、Inspector 和 Memory 工种。
- 接入 Mail Worker 与专用邮箱服务。

### Phase 4：边界与生态运行

- 外交事故评估官。
- API Budget 与 Subscription Quota adapters。
- Provider Router。
- Queen 与 Population Registry。
- 繁荣、节制、储备和冬眠。
- 语音生存储备。

### Phase 5：动态孕育

- Gene Bank。
- Role Incubator。
- 隔离舱。
- 动态角色晋升、休眠、合并和淘汰。
- Pheromone Map 与经验同化。

### Phase 6：长期运行加固

- 断线重放。
- 进程重启恢复。
- SQLite 快照。
- Provider 故障切换。
- 邮件服务重连。
- 长时间全双工与并发任务测试。

## 18. 测试策略

### 18.1 Python

- FrameProcessor 单元测试。
- 音频门控和插话测试。
- Speech Queue 取消与优先级测试。
- WebSocket bridge 重连和去重测试。
- Fake sidecar 集成测试。

### 18.2 TypeScript

- Event Schema contract tests。
- Task Nest 状态机测试。
- Pi Session 生命周期测试。
- steer/followUp/abort 测试。
- Queen 状态转换测试。
- Provider Budget adapter 测试。
- 外交事故规则测试。
- Mail Worker 能力测试。
- Role Genome 和孵化状态机测试。

### 18.3 端到端

- 用户发起代码任务并在执行中继续说话。
- 用户只停止 TTS，后台任务继续。
- 用户修正当前任务并映射为 steer。
- 用户追加任务并映射为 followUp。
- 用户取消指定任务，不影响其他任务。
- 单封邮件直接发送。
- 群发邮件触发升权。
- 高危系统动作触发升权。
- Provider 额度下降触发生态状态切换。
- 两种粮食耗尽后进入软冬眠和硬冬眠。
- 额度恢复后自动唤醒并恢复允许续跑的任务。
- 新生角色在隔离舱试运行并完成晋升或淘汰。

### 18.4 故障注入

- sidecar 在 Agent 输出中途退出。
- Pi Session 在工具执行中失败。
- 邮箱服务超时。
- 预算接口返回陈旧或异常数据。
- SQLite 暂时锁定。
- WebSocket 重复和乱序事件。
- TTS 正在播放时用户连续插话。
- 事件桥突发 1,000 events/s。
- Node 与 Python event-loop lag 超过预算。
- 四个 Resident Session 并发时 RSS 持续增长。
- SQLite 慢写与锁竞争。

## 19. 验收标准

- 运行路径中不存在翻译业务和语言方向依赖。
- 用户开始说话后，目标在 250ms 左右停止当前 TTS。
- final transcript 后目标在约 1 秒内给出接收反馈。
- Pi 长任务运行时可以发起第二个任务。
- `steer`、`followUp`、取消和仅停止说话产生不同结果。
- 原始思考和工具日志不进入 TTS。
- 单封邮件、回复和转发不需要提权。
- 只有群发邮件触发邮件发送升权。
- 明显高危的文件和系统动作可以暂停并请求升权。
- Queen 可以根据两类粮食切换四种生态状态。
- 语音生存储备不能被普通工种使用。
- 新生角色可以完成隔离试运行并被晋升、休眠或淘汰。
- 进程重启后可以恢复任务、角色基因和额度状态。
- 任一 Worker 崩溃不会终止 Transport 或其他任务。
- PCM 音频不会跨进程进入 sidecar。
- Python 与 Node 主事件循环不存在同步数据库、文件和子进程等待。
- 所有跨进程队列都有容量、优先级和溢出策略。
- 性能测试达到第 15.5 节的 p95 与 RSS 预算。

## 20. 设计戒律

1. 不让 Queen 成为中央智慧。
2. 不让 Pi 长任务进入实时媒体热路径。
3. 不让用户插话等同于无条件取消任务。
4. 不让所有组件都伪装成 Agent。
5. 不让角色出生时没有死亡条件。
6. 不让普通 Worker 消耗语音生存储备。
7. 不让 LLM 给自己的繁荣度打分。
8. 不让非群发邮件被默认拦截。
9. 不让高危外部动作在边界判断缺失时默认放行。
10. 不让成功经验只停留在一次性上下文。
11. 不让失败角色拖垮 Transport 或整个生态。
12. 不重新引入翻译业务兼容层。
13. 不让 PCM 音频和逐 token 事件跨越 Python/TypeScript 边界。
14. 不允许无界队列、无上限 Session 或无释放路径的订阅。
15. 不用平均延迟掩盖 p95 和 p99 的卡顿。

## 21. 参考

- Pi Agent Harness：<https://github.com/earendil-works/pi>
- Pi SDK：<https://pi.dev/docs/latest/sdk>
- Pi Security：<https://pi.dev/docs/latest/security>
- Pi RPC Mode：<https://pi.dev/docs/latest/rpc>
- Pipecat：<https://docs.pipecat.ai/>
- 现有架构文档：`.proj-init/01-swarm-intelligence-and-insectoid-ecology.md`
- 现有实时设计：`.proj-init/02-swarm-agent-architecture-for-realtime-voice.md`
- 长期路线：`.proj-init/03-long-term-zerg-voice-agent-program.md`
- 哲学讨论：`.proj-init/虫群的智慧-进化哲学.md`

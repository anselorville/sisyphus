# 虫族智慧理解与生态设计

日期：2026-07-25  
用途：为 Sisyphus / Raspberry Pi realtime voice agent 的 agent 生态架构提供生物学、群体智能和系统设计基础

## 1. 核心判断

“虫族智慧”真正有价值的地方，不是强大个体，而是强大生态。虫群、蜂群、白蚁群、蚁群之所以能在复杂环境中长期存在，是因为它们把智能从“单体大脑”转移到了“群体结构 + 环境反馈 + 专门化个体 + 可进化规则”中。

对 agent 系统来说，这个隐喻非常准确：LLM 端点本身像可被快速分化的同质细胞；不同 system prompt、tool set、memory scope、权限边界和调度规则会把同一个基础模型分化成不同“品种”。一个真正有生命力的 voice agent 不应该是“一个大 LLM 节点坐在管线中间”，而应该是一个可以感知、分工、调度、执行、监测、修复、进化的生态系统。

本文把“虫族智慧”定义为：

- 不是单一超级智能，而是由大量专门化单元组成的 superorganism。
- 不是全局同步控制，而是局部交互、阈值响应和环境记忆形成的涌现秩序。
- 不是一次性设计完美，而是持续变异、选择、强化和淘汰。
- 不是追求个体自由，而是让每个角色承担清晰功能，使整体持续存活和扩张。

与《虫群》的进化哲学对齐后，还要再加一条最高原则：智慧不是常驻王座，而是昂贵的应激器官。稳态下，生态应由低能耗、去中心化、快速响应的专业工种维持；只有当环境熵增、风险越界或任务未知度超出基线生态时，系统才临时孵化高阶智力品级。危机解除后，高阶智力必须蒸馏经验、释放资源、退回基质，不能永久变成新的中央主脑。

## 2. 资料基线

本设计主要借鉴以下研究方向：

- 社会性昆虫的 superorganism 模型。
- 蚁群、蜂群、白蚁群的自组织与 stigmergy。
- 社会性昆虫的 division of labor、response threshold、temporal polyethism。
- 蜂群选址中的 quorum sensing、cross inhibition、stop signal。
- 蚁群路径搜索、信息素蒸发、Ant Colony Optimization。
- 白蚁巢穴的分布式建造、通风、温湿度调节。
- 群体基础设施系统的韧性：交通网络、供应链、巢穴维护。
- 现代 voice-agent 工程中的 full-duplex、wake word、speaker isolation、turn-taking、timeout/backchannel。

重要参考见文末“资料来源”。

## 3. 虫群不是军队，而是身体

很多科幻作品里的“虫族”会被表现成军队：大量单位、快速繁殖、等级森严、集体服从。但从系统设计角度看，更准确的类比是“身体”：

- 个体像细胞。
- 品种像组织或器官。
- 信息素像神经递质和激素。
- 巢穴结构像外置器官。
- 觅食路径像血管。
- 免疫行为像白细胞系统。
- 繁殖/孵化机制像干细胞分化系统。
- 高阶智力像应激器官，只在生态越界时短暂出现。

这对 agent 生态非常重要。一个 agent 生态如果把“主控 LLM”设计成每件事都亲自思考、亲自调度、亲自验证、亲自回应用户，就会变慢、脆弱、昂贵，并且难以同时处理实时语音与长任务。虫群式系统的核心是：让不同品种在不同刺激下自动响应，而不是让一个中枢大脑轮询所有问题。

## 4. 机制一：Superorganism

Superorganism 的意思是群体整体表现出类似单个生命体的功能。蜂群、蚁群、白蚁群中的个体通常无法独立完成群体级生存任务，但群体可以完成觅食、防御、迁徙、温控、繁殖、建造、免疫和决策。

工程抽象：

- agent 不是一个对象，而是一组器官。
- 系统生命力不来自某个最强 agent，而来自器官之间的可替换、可恢复、可调度。
- 系统要有“代谢”：输入信息、分解任务、消耗算力、排出无用上下文。
- 系统要有“免疫”：检测异常、隔离失败工具、降低危险行为权限。
- 系统要有“发育”：随着使用场景稳定，形成更专门的角色。

设计原则：

1. 不把所有能力塞进一个 system prompt。
2. 不让高阶智力常驻，也不把每次语音都交给高阶模型。
3. 每个 agent 角色必须有明确器官功能。
4. 允许角色死亡、重启、替换和降级。
5. 让群体状态比个体状态更重要。

## 5. 机制二：局部交互而非全局控制

Deborah Gordon 关于蚁群的研究强调，蚁群行为不是由中央命令控制，而是由局部互动网络调节。个体通过触碰、气味、路径、等待时间、环境刺激来决定自己下一步做什么。

工程抽象：

- 每个 agent 不需要知道全局所有状态。
- agent 通过事件、任务队列、共享记忆、状态黑板和“信息素”工作。
- 调度不是单点命令，而是角色对刺激的响应。
- 生态调节器只塑造环境、阈值和约束，不直接替所有角色执行动作。

对应到 voice agent：

- Transport 层只关心 audio in/out、VAD、wake、speaker、barge-in、timeout。
- 交通指挥只关心链路是否堵塞、用户是否等待、是否需要安慰话术。
- Planner 只关心目标分解。
- Executor 只关心工具调用。
- Inspector 只关心验证和错误。
- Memory 只关心写入、检索、遗忘。

这让实时语音链路不会被长任务拖死。

## 6. 机制三：Response Threshold 阈值分工

社会性昆虫的分工常用 response-threshold model 解释：不同个体对任务刺激有不同响应阈值。某个任务刺激越强，越多适合该任务的个体会被激活。低阈值个体更早响应，高阈值个体在需求变强或低阈值个体不足时加入。

工程抽象：

每个 agent 品种都应有激活阈值：

```text
activation = f(stimulus_intensity, role_affinity, current_load, confidence, urgency, cost)
```

例如：

- Wake Sentinel 的阈值由唤醒词置信度、声纹置信度、环境噪声决定。
- Traffic Commander 的阈值由等待时间、用户焦躁程度、链路阻塞程度决定。
- Planner 的阈值由任务复杂度决定。
- Executor 的阈值由工具需求和权限决定。
- Inspector 的阈值由风险等级和输出可验证性决定。
- Memory Curator 的阈值由重复出现、用户显式“记住”、长期价值决定。

设计价值：

- 系统不是写死 if/else，而是让角色在刺激变强时自然加入。
- 当环境嘈杂，Speaker Sentinel 阈值降低，更多资源用于声纹和语音分离。
- 当用户等待变久，Traffic Commander 阈值降低，自动生成安慰反馈。
- 当任务风险升高，Inspector 阈值降低，更多检查介入。

### 6.1 应激裁判：高熵、高风险、未知任务的范围

虫群式 agent 生态必须有一个“应激裁判”（Stress Judge）。它不是中央智慧个体，不负责规划或执行；它是低成本、常驻、可解释的判定器，只回答一个问题：当前刺激是否超出稳态基线层，是否需要孵化临时高阶智力品级。

应激裁判读取三类分数：

```text
stress_score = max(entropy_score, risk_score, novelty_score)
```

| 分数区间 | 状态 | 响应 |
| --- | --- | --- |
| `0.00-0.39` | 稳态 | 低阶工种独立处理，不唤醒高阶智力 |
| `0.40-0.64` | 轻度扰动 | 交给专业 worker 或要求澄清 |
| `0.65-0.79` | 应激预警 | 启动 Planner/Inspector/Traffic Commander 等专门品级协同 |
| `0.80-1.00` | 越界危机 | 临时孵化 Intelligence Caste，高阶推理只作为应激工具出现 |

高熵任务的范围：

- 同一路由连续失败 2 次以上。
- 同一工具/API 连续报错 3 次以上。
- STT、意图分类、声纹、VAD 给出互相冲突的信号。
- 用户连续纠正系统，说明上下文或目标漂移。
- agent 进入循环、反复计划、反复调用同一工具但无产出。
- 超过预期等待窗口仍无可解释进展，例如后台任务超过 5-10 秒没有状态变化。
- 多个 worker 对同一任务的判断差异很大，置信度分裂超过预设阈值。

高风险任务的范围：

- 写入、删除、覆盖文件。
- 执行 shell、系统命令、网络配置、关机、重启。
- 发送邮件、消息、提交表单、付款、下单、公开发布。
- 访问隐私数据、凭据、日历、联系人、聊天记录、位置。
- 医疗、法律、金融、安全相关建议。
- 非主人声纹、低声纹置信度或多人环境下的私人/高权限请求。
- 高成本模型调用、长时间后台任务、可能耗尽移动设备电量或网络流量的操作。

未知任务的范围：

- 没有匹配到已有 route、skill、prompt 或工具组合。
- route pheromone 很低，历史成功样本不足。
- 用户提出从未出现过的新领域、新工具、新设备或新外部系统。
- 任务需要动态发现协议、接口或 MCP 工具。
- 现有 worker 都给出低置信度，或任务需要跨多个未知域组合。
- 任务目标含糊，但用户期望系统主动探索。

裁判输出不是“答案”，而是生态动作：

- `stay_baseline`：低阶工种直接处理。
- `ask_clarification`：先问一句澄清，避免高阶智力浪费。
- `activate_specialists`：唤醒已有专业 worker。
- `spawn_intelligence_caste`：临时孵化高阶智力品级。
- `quarantine_or_confirm`：高风险动作先隔离或请求确认。
- `assimilate_after_success`：任务完成后蒸馏轨迹、固化技能、销毁临时品级。

## 7. 机制四：Temporal Polyethism 年龄分工

蜂群和蚁群常见年龄分工：年轻个体做巢内任务，年长个体转向更危险的外部觅食。其价值是把高风险任务交给对群体未来价值更低、经验更丰富或更适合的个体。

工程抽象：

agent 角色也可以按“成熟度”分层：

- 新生角色：只观察，不执行。
- 幼虫角色：处理低风险任务。
- 工蜂角色：稳定执行常规任务。
- 兵蜂角色：处理风险、攻击、异常、权限边界。
- 侦察角色：探索新工具、新模型、新路径。
- 老化角色：如果长期低价值或错误率高，被淘汰。

这对应 agent ecosystem 的演化：

- 新 prompt template 先进入 shadow mode。
- 新工具先只读。
- 新模型先处理低风险请求。
- 表现稳定后提升权限。
- 错误率升高或成本过高时降级或淘汰。

## 8. 机制五：Stigmergy 环境即通信

Stigmergy 是虫群系统最关键的机制之一：个体不需要直接互相解释完整计划，而是在环境中留下痕迹，其他个体根据痕迹继续行动。白蚁筑巢、蚁群路径、任务堆积、巢穴结构都可理解为环境反馈驱动的协调。

工程抽象：

把 agent 系统的环境设计成可读写的“生态基质”：

- Event log：发生了什么。
- State board：当前链路状态。
- Pheromone map：哪些路径被证明有效。
- Task nest：任务分解和状态。
- Memory substrate：长期记忆、用户偏好、项目知识。
- Risk field：哪些行为危险。
- Latency field：哪些链路正在变慢。

这样 agent 不需要互相聊天太多。它们看环境痕迹即可行动。

例子：

```text
User asks complex request
  -> Transport writes: user_turn_final, deadline=800ms
  -> Orchestrator writes: task_complexity=high
  -> Traffic Commander sees deadline nearing, emits comfort_tts
  -> Planner writes task graph
  -> Executors compete/claim subtasks
  -> Inspector writes validation status
  -> Central Commander synthesizes final spoken result
```

## 9. 机制六：信息素与蒸发

蚁群信息素既是记忆，也是路由偏好。成功路径被强化，低价值路径会因为蒸发而消失。Ant Colony Optimization 中，信息素蒸发可以避免系统过早陷入局部最优。

工程抽象：

agent 生态需要人工信息素：

- Tool pheromone：某个工具在某类任务上的成功率。
- Model pheromone：某个模型在某类对话上的质量/延迟/成本。
- Route pheromone：某条处理路径的历史表现。
- Prompt pheromone：某个提示模板的成功率。
- User pheromone：用户偏好的交互风格。
- Environment pheromone：当前噪声、网络、电量、温度对策略的影响。

每个 pheromone 都必须有蒸发机制：

- 太久没被验证的成功经验衰减。
- 在新环境下失败的路径快速降权。
- 昂贵路径如果价值不高自动降低优先级。
- 延迟过高的模型在 realtime voice 中被降权。

这能避免“曾经好用的工具永远被优先使用”的僵化。

## 10. 机制七：正反馈与负反馈

虫群能形成结构，是因为正反馈放大有效行为；虫群能不崩溃，是因为负反馈抑制过度行为。

正反馈例子：

- 蚁群短路径被更多蚂蚁走过，信息素更强。
- 蜂群侦察蜂通过舞蹈招募更多支持者。
- 白蚁在已有泥粒附近继续堆砌，结构逐渐成形。

负反馈例子：

- 信息素蒸发。
- 资源耗尽后觅食活动下降。
- 蜂群 stop signal 抑制错误或竞争选项。
- 个体拥堵、等待时间变长后任务切换。

工程抽象：

- 成功路径强化，但必须有上限。
- 错误路径降权，但不要一次失败永久封杀。
- 高延迟触发安慰反馈。
- 高错误触发 Inspector。
- 高噪声触发声纹/降噪。
- 高成本触发低成本替代。
- 高用户等待触发 response budget 收紧。

## 11. 机制八：Quorum 与 Cross Inhibition

蜂群选址不是“女王决定”，而是侦察蜂探索多个候选地点，优质地点获得更多招募，达到 quorum 后群体迁移。研究还显示 stop signal / cross inhibition 可以提高集体决策可靠性。

工程抽象：

对高风险或高影响任务，不要让单个 agent 直接决定：

- 多个 scout agent 生成候选计划。
- Critic/Inspector 互相抑制明显差的方案。
- 达到质量 quorum 后进入执行。
- 低风险任务可单 agent 快速执行。

实时语音场景下要注意：quorum 不能阻塞 hot path。可以先给用户一个 acknowledgement，再让后台 quorum 决策。

## 12. 机制九：Task Partitioning 任务切分

社会性昆虫会把复杂任务拆分成多个可由不同个体执行的子任务。白蚁建巢、蚁群搬运、蜂群觅食都不是一个个体完成全流程。

工程抽象：

复杂 agent 任务必须拆成：

- 感知任务：识别用户意图、环境、声纹、唤醒。
- 路由任务：判断走 fast path 还是 agent path。
- 计划任务：拆分步骤。
- 执行任务：调用工具。
- 监测任务：看延迟、错误、用户等待。
- 审计任务：验证输出。
- 记忆任务：写入长期记忆。
- 交互任务：把进度转成适合语音的话。

每个任务有不同 SLA 和不同失败策略。

## 13. 机制十：冗余与韧性

群体系统的韧性来自冗余：大量个体可替代，局部损伤不会导致整体死亡。社会性昆虫基础设施研究会把交通网络、供应链、巢穴维护作为韧性系统来理解。

工程抽象：

- 每个关键角色至少有降级版本。
- Pi agent sidecar 崩溃时，语音管线继续运行。
- 云端模型不可用时，降到本地短答或文本提示。
- Wake word 失败时，保留按钮唤醒。
- 声纹识别低置信时，降到手动确认。
- TTS 失败时，UI 显示文字。
- 网络失败时，切到 offline。

韧性不是“不失败”，而是“失败被局部化”。

## 14. 机制十一：巢穴是外置器官

白蚁巢穴不是被动住所，而是群体外置器官：通风、温湿度、育幼、储藏、防御都由结构本身承担。巢穴改变了环境，环境又改变了群体行为。

工程抽象：

agent 系统的“巢穴”是 runtime substrate：

- 文件系统。
- session store。
- event bus。
- model cache。
- tool registry。
- memory database。
- observability dashboard。
- device status。
- audio buffers。
- task queues。

如果巢穴设计得好，个体 agent 可以更简单。反过来，如果没有巢穴，所有 agent 都必须记住所有上下文，系统就会变慢、混乱。

## 15. 机制十二：侦察与探索

虫群在稳定觅食路径之外仍保留随机探索者。没有探索，系统会被旧路径困住；探索过多，系统会浪费资源。

工程抽象：

- Scout agents 探索新模型、新工具、新 prompt、新路由。
- 探索不能直接进入生产语音链路。
- 探索结果通过 pheromone score 进入候选。
- 新策略先 shadow mode，再 canary，再主路径。

在 Raspberry Pi voice agent 中：

- 新 wake word 模型先只记录，不唤醒。
- 新 VAD 参数先旁路评估。
- 新 Pi agent skill 先 shadow 执行。
- 新 TTS voice 先 preview。

## 16. 机制十三：孵化、变异、选择

虫族生态的强大之处在于能根据外部环境孵化新的品种。agent 生态也应如此：

- 环境出现新需求：生成新角色。
- 某角色长期失败：变异 prompt 或替换模型。
- 某工具使用频繁：专门化出 worker。
- 某类用户请求增多：形成 workflow。
- 某类错误反复出现：形成 immune agent。

工程化流程：

1. 观察：收集失败、延迟、重复需求。
2. 聚类：识别新任务类型。
3. 孵化：生成候选 agent role/spec。
4. 影子运行：只观察不影响主流程。
5. 小流量执行：低风险任务试用。
6. 强化：成功则提高 pheromone。
7. 淘汰：失败则降权、封存或改造。

## 17. 机制十四：免疫系统

社会性昆虫有清洁、隔离、尸体处理、巢穴卫生、抗病行为。群体免疫不只是个体健康，而是阻止局部问题扩散。

agent 生态也必须有免疫系统：

- 权限免疫：危险工具需要更高权限。
- 输出免疫：高风险回答需要审计。
- 记忆免疫：错误记忆不能进入长期库。
- 成本免疫：异常调用量自动熔断。
- 延迟免疫：慢路径隔离出 realtime hot path。
- 安全免疫：提示注入、恶意指令、数据泄露检测。
- 设备免疫：低电压、过热、麦克风异常、网络异常触发保护。

## 18. 虫群智慧到 agent 设计的映射表

| 虫群机制 | 生物意义 | Agent 系统映射 |
| --- | --- | --- |
| Superorganism | 群体像一个生命体 | agent ecosystem，而非单 agent |
| Caste | 不同形态承担不同功能 | 专门化 agent roles |
| Response threshold | 刺激超过阈值才行动 | 事件驱动调度与角色激活 |
| Stigmergy | 通过环境痕迹协调 | event log、state board、memory substrate |
| Pheromone | 路径偏好与群体记忆 | route/model/tool score |
| Evaporation | 防止僵化 | score decay、TTL、revalidation |
| Quorum | 群体决策 | 多 agent 投票/置信度门槛 |
| Stop signal | 抑制错误选项 | critic、cancellation、risk gate |
| Task partitioning | 子任务分工 | planner/executor/inspector/memory |
| Temporal polyethism | 年龄/经验分工 | shadow/canary/stable/deprecated roles |
| Nest architecture | 外置器官 | runtime substrate 和 observability |
| Scout behavior | 探索新资源 | 新工具/模型/prompt 探索 |
| Colony immunity | 防止感染扩散 | sandbox、权限、审计、熔断 |
| Redundancy | 局部失败不致命 | fallback、replica、degraded mode |

## 19. 对 realtime voice agent 的启示

语音交互不是普通 chat。它有时间压力、噪声压力、打断压力和用户注意力压力。因此虫群生态必须分出“快速反射”和“深度认知”。

关键启示：

1. Transport 层必须全双工。
   - 系统要能边听边说。
   - 用户插话时立即停止播放。
   - 输入和输出不能被同一个阻塞式 turn 锁住。

2. 唤醒词是巢穴入口。
   - 常驻低功耗监听。
   - 唤醒后才打开重型 STT/LLM。
   - 支持物理按键作为 fallback。

3. 声纹是身份气味。
   - 提前录入主人的 voiceprint。
   - 嘈杂环境下优先提取目标人声。
   - 声纹低置信时降低权限或要求确认。

4. Timeout 是生态刺激。
   - 等待超过阈值，不是错误，而是触发 Traffic Commander。
   - Traffic Commander 给出安慰话术、进度说明或澄清。
   - 语音层不应该沉默等待长任务。

5. Agent runtime 是巢穴深处。
   - 长任务可以后台运行。
   - 用户继续说话不应打断整个生态。
   - 高阶智力只有在应激裁判判定越界时临时出现，不能常驻主流程。

## 20. 推荐生态原型

```text
外界声音
  -> Wake Sentinel
  -> Speaker Sentinel
  -> VAD Scouts
  -> Transport Spine
  -> Reflex Router
      -> Stress Judge
      -> Reflex Agent
      -> Traffic Commander
      -> Baseline Worker Network
          -> Planner Brood
          -> Executor Workers
          -> Memory Workers
          -> Inspector Soldiers
          -> Scout Mutators
      -> Temporary Intelligence Caste (only on stress overflow)
  -> TTS Speaker
  -> User
```

角色简述：

- Wake Sentinel：只负责唤醒。
- Speaker Sentinel：只负责“是不是目标人声”。
- VAD Scouts：持续报告说话状态、噪声、停顿。
- Transport Spine：全双工输入输出骨架。
- Reflex Router：低阶常驻反射路由，只做毫秒级路由，不做复杂思考。
- Stress Judge：应激裁判，判定高熵、高风险、未知度是否越界。
- Traffic Commander：观察等待时间和链路堵塞，给用户即时反馈。
- Reflex Agent：短答、澄清、拒绝、确认。
- Baseline Worker Network：Pi 生态中的低能耗常驻工种网络，负责常规长任务。
- Planner Brood：分解任务。
- Executor Workers：调用工具。
- Inspector Soldiers：检测风险和验证结果。
- Memory Workers：写入与检索长期记忆。
- Scout Mutators：探索新策略和孵化新角色。
- Temporary Intelligence Caste：应激孵化的临时高阶智力品级，解决越界问题后蒸馏经验并退化。

## 21. 设计戒律

1. 不让用户等黑箱。
2. 不让长任务阻塞语音热路径。
3. 不让单个 LLM 承担所有认知功能。
4. 不让工具日志直接进入 TTS。
5. 不把 VAD 当成完整 turn-taking。
6. 不把唤醒词、声纹、降噪、打断放到后面再说。
7. 不把 agentOS 当成聊天机器人。
8. 不让高阶智力常驻，也不让应激裁判变成主脑。
9. 不让成功路径永久固化。
10. 不让失败扩散到整个生态。

## 22. 资料来源

- Deborah M. Gordon, “The Ecology of Collective Behavior”, PLOS Biology / PMC：<https://pmc.ncbi.nlm.nih.gov/articles/PMC3949665/>
- Gordon, “The organization of work in social insect colonies”：<https://csc.ucdavis.edu/~cmg/netdyn/Gordon-1.pdf>
- Guy Theraulaz & Eric Bonabeau, “A Brief History of Stigmergy”：<https://static.ias.edu/pitp/archive/2012files/29.pdf>
- Simon Garnier, Jacques Gautrais, Guy Theraulaz, “The biological principles of swarm intelligence”：<https://static.ias.edu/pitp/archive/2012files/66.pdf>
- “Task allocation and partitioning in social insects”：<https://en.wikipedia.org/wiki/Task_allocation_and_partitioning_in_social_insects>
- “Resilience in social insect infrastructure systems”：<https://pmc.ncbi.nlm.nih.gov/articles/PMC4843670/>
- “Revisiting stigmergy in light of multi-functional, biogenic, termite structures”：<https://pmc.ncbi.nlm.nih.gov/articles/PMC7516209/>
- “Morphogenesis of termite mounds”, PNAS：<https://www.pnas.org/doi/10.1073/pnas.1818759116>
- Thomas D. Seeley / P. Kirk Visscher, “Group Decision Making in Honey Bee Swarms”：<https://www.americanscientist.org/article/group-decision-making-in-honey-bee-swarms>
- “Stop signals provide cross inhibition in collective decision-making by honeybee swarms”：<https://pubmed.ncbi.nlm.nih.gov/22157081/>
- Google Research, “VoiceFilter: Targeted Voice Separation by Speaker-Conditioned Spectrogram Masking”：<https://google.github.io/speaker-id/publications/VoiceFilter/>
- “Neural Target Speech Extraction: An overview”：<https://www.fit.vut.cz/research/group/speech/public/publi/2023/zmolikova_2023_IEEE_SPM_Neural_Target_Speech_Extraction_An_overview.pdf>
- openWakeWord：<https://github.com/dscripka/openWakeWord>
- Picovoice Porcupine Wake Word：<https://picovoice.ai/products/voice/wake-word/>
- Full-Duplex-Bench：<https://arxiv.org/html/2503.04721v3>
- LiveKit turn-taking tuning：<https://docs.livekit.io/agents/logic/turns/tuning/>
- Pi Agent Harness：<https://github.com/earendil-works/pi>
- Pi SDK：<https://pi.dev/docs/latest/sdk>
- Pipecat overview：<https://docs.pipecat.ai/overview/introduction>
- Pipecat speech input / VAD：<https://docs.pipecat.ai/pipecat/learn/speech-input>
- Pipecat SmallWebRTCTransport：<https://docs.pipecat.ai/api-reference/server/services/transport/small-webrtc>

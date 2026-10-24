# ADR-001: Phase A/B路径——先用上游 pi-coding-agent 跑通，HCI 数据到手后再评估 oh-my-pi

日期：2026-08-08

## 状态

已接受

## 背景

用户希望将 pi-agent 从 coding-agent 演化为 general-agent（Marcus），覆盖日常交流（web search、通信）和技术课题的 deep research。用户认为 oh-my-pi（Pi 的完整 fork，22.8k star，MIT）是实现这一演化的杠杆，因为 oh-my-pi 添加了 LSP、DAP、浏览器自动化、子 agent、记忆、插件市场等 harness 功能。

调研发现：

- **oh-my-pi 不是插件，是完整 fork**（`can1357/oh-my-pi`），有自己的 npm scope `@oh-my-pi/*`、CLI `omp`、版本线 17.x。
- **Bun-only 运行时**：oh-my-pi SDK 要求 Bun ≥ 1.3.14，明确 "Runtime is Bun (no Node entry points)"。当前 sidecar 是 Node ≥ 22.19 + better-sqlite3。
- **SDK 面变了**：`CreateAgentSessionOptions` 里 `modelRuntime` 和 `resourceLoader` 已被移除，换成 `authStorage` + `ModelRegistry` + `Settings`。当前 `createDefaultPiSessionProvider()` 传的就是 `modelRuntime`/`resourceLoader`，直接换包会编译失败。
- **当前 agent-runtime 已经集成上游 pi-coding-agent 0.82.0**：`createDefaultPiSessionProvider()` → `createAgentSession()` → LLM 会话层已完成。DEEPSEEK_API_KEY 在 sidecar 进程环境中。
- **真正的缺口是任务执行编排循环**（TODO Phase 1 P0）：`InboundEventRouter` 只做 `taskNest.create()`，全仓库没有生产代码调用 `sessionManager.prompt()`。说话 → STT → sidecar 建任务 → 停。
- **pi-agent SDK 支持任意工具**：`createAgentSession({ tools })` 的 tools 参数完全开放。让 pi-agent 成为 general-agent 的关键是工具面和系统提示词，不是运行时。
- **蜂群治理已有角色委派机制**：ReflexRouter + 7 个角色 manifest + Memory Curator 角色，可以先顶上 oh-my-pi 的子 agent/记忆能力。
- **机器有麦克风和扬声器**（Default Input Device: Yes），真实语音交互可行。

## 决策

采用 Phase A/B 路径：

**Phase A（当前）**：用上游 `@earendil-works/pi-coding-agent` 补全编排循环，基于场景选择性释放角色（general + web 先行），接入 Traffic Commander 语音反馈，跑起来，收集 HCI 数据。蜂群治理层休眠但保留。所有角色统一使用 deepseek-flash。oh-my-pi 暂不引入。

**Phase B（有 HCI 数据后）**：用真实数据评估 oh-my-pi 的哪些能力（子 agent、记忆、插件市场）是真正需要的。如果需要，规划 Bun 迁移——有数据支撑的投资决策。

## 理由

1. **速度**：补全编排循环是小而明确的任务（TODO Phase 1 P0），不涉及运行时迁移。媒体平面已在运行（cloud engine, zhipu STT + minimax TTS），sidecar 已连接。缺的只是把 LLM 接进语音链路。
2. **质量**：上游 pi-coding-agent 已集成，LLM 会话层已完成，无需重写。所有角色统一使用 deepseek-flash（降低延迟，简化路由）。
3. **角色委派**：7 个角色是场景引擎，不是负担。general 作为入口，ReflexRouter 委派给 specialized roles（web/code/mail 等）。Phase A 先释放 general + web。
4. **延迟管理**：Traffic Commander 已实现（首次确认 700ms、进度播报 ≥5s），是掩盖 agent 长任务耗时的关键。只需接入执行循环。
5. **蜂群治理可顶用**：角色委派机制（ReflexRouter）和 Memory Curator 角色已存在、已测试，可以先提供 oh-my-pi 的子 agent/记忆能力的子集。
6. **数据驱动**：HCI 数据会揭示 oh-my-pi 的哪些能力（子 agent、记忆、插件市场）是真正需要的，避免盲目投资。用户的期望是"完整的 harness 和顶层编排能力"——但这需要真实数据来定义"完整"的边界。
7. **pi-agent SDK 的灵活性**：`createAgentSession({ tools })` 支持任意工具，不需要 oh-my-pi 来"把 coding-agent 变成 general-agent"——换工具面和系统提示词即可。

## 后果

**正面**：
- 快速拿到真实 HCI 数据（延迟体感、打断/barge-in、错误路由、幻觉工具调用、转写错误），为后续投资提供依据。
- 保留蜂群治理层（已测试），Phase B 可以按需启用。
- 保持 Node 运行时，无迁移风险。

**负面**：
- Phase A 期间 harness 能力有限：没有插件市场、子 agent 系统较简单（蜂群的角色委派 vs oh-my-pi 的更灵活子 agent）。
- 如果 Phase B 决定迁移 oh-my-pi，需要做 Bun 迁移 + SDK 重构 + 配置迁移。

**风险**：
- LLM 认证未验证：DEEPSEEK_API_KEY 在 env 但 `~/.pi/agent/auth.json` 为空，`models.json` 不存在。pi-ai 的 `env-api-keys.js` 读取 env key，但 `ModelRuntime.create()` 的行为未在真实运行中验证。**首个阻塞验证步骤**：在 sidecar 中触发一次真实 prompt，确认模型认证通过。

## 替代方案

**方案 B：现在就切 oh-my-pi**——质量优先，但会延迟跑起来的时间。需要 Bun 迁移 + SDK 重构 + 配置迁移。适合"已经知道要什么"的场景，但当前缺乏 HCI 数据来判断 oh-my-pi 的哪些能力是真正需要的。

**方案 C：从零重写一个直连 pi-agent 的极简桥**——扔掉已测资产（蜂群治理、角色注册表、TaskNest），重新实现事件桥、TTS enqueue、语音安全检查。工作量最大，收益最小。

# 语音交互 Agent 可视化与交互优化方案

范围：`client/` 前端的视觉与交互，以及为此必须补齐的前后端事件信号。
不在范围内：安全加固、Tauri 打包发布、Agent 能力本身。

---

## 0. 结论

功能链路已经通了，但**用户在界面上感知不到"对话"本身**。核心原因有两层：

1. **信号断链**：后端已经产生"用户开始说话、识别中间结果、Agent 开始/结束说话、请求授权"等事件，但没有转发到浏览器。前端里"正在说话"状态的代码写好了却永远不会触发，授权弹窗在真实使用中永远不会弹出。
2. **界面重心错位**：主界面是"话题 + 字幕 + 生态"三块面板的仪表盘。真正的主角（Agent 在听、在想、在说）只靠底部一个 84px 的按钮和一行小字表达；占据大块空间的 Ecology 面板在大多数时候显示 "Unknown"。

方案分五个阶段：先打通信号（P0），再以"语音形象（Voice Orb）"为中心重构主界面（P1），然后补齐对话交互细节（P2），统一视觉系统（P3），最后用指标验证体验（P4）。P0 是其他所有阶段的前提。

---

## 1. 现状诊断

### 1.1 信号断链（影响最大）

| 问题 | 证据 | 用户感知 |
|---|---|---|
| "Agent 正在说话"永远不出现 | 前端只在收到 `voice.speech.enqueue` / `voice.speech.cancel` 时切换 `isSpeaking`（`client/src/hooks/useAgentConnection.ts`），但 `app/server.py` 的转发器只把 enqueue 转成 `agent.transcript` 发给浏览器，这两个事件本身从不下发。即使下发，也没有"说完了"的事件，状态会卡在 speaking | Agent 说话时界面没有任何变化 |
| 没有"正在听"的实时反馈 | `voice.user.started/stopped`、`voice.transcript.partial` 由 `app/realtime/voice_activity.py` 产生，只发往 sidecar，不发往浏览器 | 说话时看不到自己的话被识别，只能等整句结束 |
| 授权弹窗不会出现 | `diplomacy.elevation.*` 不在 `app/server.py` 的转发白名单里；`ElevationDialog` 只能在 Storybook 中看到 | 高风险操作只能靠语音确认，没有可视化兜底 |
| 没有"思考中"状态 | 用户说完到 Agent 第一句话之间没有任何事件和视觉 | 停顿 1–3 秒时用户不确定系统是否收到 |
| 看不到 Agent 的声音 | 只对本地麦克风做了电平分析（`useMicLevel`），远端音轨没有分析 | Agent 发声时界面是静止的 |
| 生态状态延迟大 | 生态事件不转发，靠每 10 秒轮询 `/api/agent-runtime/status` | 状态变化滞后，且多数时间是 Unknown |

### 1.2 交互问题

1. **手动轮次模式的心智模型没讲清楚。** 服务端在麦克风打开期间会暂存 TTS，关闭麦克风时才放出回复（`app/realtime/audio_gate.py`）。也就是说"关麦"实际上等于"我说完了，请回答"。但按钮文案写的是 "Tap to mute"，用户会以为只是静音。
2. **开口前要点两次。** 断开状态点按钮只会建立连接，连上后还要再点一次才开麦。另外状态栏的 Connect 按钮和底部大按钮重复承担"连接"职责。
3. **没有键盘操作。** 桌面端没有空格键按住说话、Esc 打断等快捷键。
4. **出错原因不透明。** 麦克风权限被拒、服务器连不上、WebRTC 协商失败，都显示为同一个 "Connection error / Tap to retry"。
5. **无法打断和控制任务。** 协议里已有 `task.cancel` / `task.steer` / `task.follow_up` 控制消息，但界面上没有任何入口。也没有"停止播报"按钮。
6. **对话不留存。** 字幕只存在内存里，刷新即丢失，也没有历史会话。
7. **没有文字兜底。** 在嘈杂或不便出声的场景下无法打字输入。
8. **没有声音反馈。** 开麦、关麦、Agent 开始思考都没有提示音。对语音产品来说，这是比视觉更直接的反馈通道。

### 1.3 视觉问题

1. **中英文混杂。** 状态栏、按钮、设置页、授权弹窗是英文；话题、字幕面板是中文；`index.html` 标为 `lang="en"`，标题是 "Marcus"，字幕说话人显示为"你 / Agent"。
2. **主界面像仪表盘。** 三块面板平铺，没有视觉焦点。Ecology 是开发者概念（System / Budget 四格量表），却占据主界面固定位置。
3. **话题面板的半张卡片看起来像被裁掉了。** `TaskNestPanel` 的设计是"一张完整卡片 + 半张预览"，但在实际渲染中第二张只露出标题上半部分，像是布局 bug。
4. **字幕区是纯文本流。** 用户和 Agent 只靠前缀标签区分，没有气泡、对齐或时间分隔。空状态文案"说话后，这里会显示双向字幕"沿用了翻译原型的说法。
5. **深色模式未启用。** `tokens.css` 已定义 `[data-theme="dark"]` 整套变量，但没有任何代码设置这个属性，也不跟随系统。
6. **Storybook 已经失真。** `Screens/AgentHomeScreen` 的 13 个 story 全部报错（缺少 `transcriptEntries` 参数），设计评审没法再依赖它。
7. **缺少品牌资产。** 没有 favicon；Tauri 图标是模板默认图。

### 1.4 已有的好底子（保留）

- 暖色调 token 体系完整，对比度有标注，`DESIGN.md` 已有设计约定。
- 组件分层清晰（tokens → primitives → components），状态都是 props 驱动，便于 Storybook 覆盖。
- `prefers-reduced-motion` 已在部分组件中处理。
- 设置页、Model Lab、Model Provider 已经接入。

---

## 2. 设计方向

**一句话：语音优先，一个主角。**

主界面只有一个视觉焦点：代表 Agent 的"语音形象"（下称 Voice Orb）。它用形状、颜色、动态表达 Agent 此刻在做什么。字幕是它的"嘴型"，紧贴其下。其余信息（话题、任务、资源状态）退到可展开的次级层。

设计原则：

1. **状态先于内容**：任何时刻，用户扫一眼就能知道"该我说，还是该它说"。
2. **声音与画面同步**：每个状态切换都有视觉变化，关键切换配一个短提示音。
3. **可打断**：Agent 说话、思考、执行任务时，用户都有一个明显的方式叫停。
4. **少即是多**：开发者信息（引擎、预算、sidecar 连接）不出现在主界面，异常时才浮出。
5. **语言统一**：面向用户的文案全部使用简体中文，保留 i18n 结构以便将来扩展。

---

## 3. 对话状态机

前端新增一个统一的会话状态（建议新建 `useVoiceSession` reducer，汇总连接状态、麦克风状态和各类语音事件），替代现在 `App.tsx` 里分散推导的 `deriveActivity`。

| 状态 | 触发 | Voice Orb 视觉 | 主文案 | 提示音 | 用户可做 |
|---|---|---|---|---|---|
| 离线 `offline` | 未连接 | 灰色静止圆，轻微呼吸 | 点一下开始对话 | — | 点击开始（连接并开麦） |
| 连接中 `connecting` | 发起连接 | 琥珀色环形旋转 | 正在连接… | — | 取消 |
| 待命 `ready` | 已连接、麦克风关 | 珊瑚色描边圆，静止 | 点按或按住空格说话 | — | 开麦 |
| 聆听 `listening` | 麦克风开 | 珊瑚色实心，随用户音量起伏 | 实时显示识别中的文字 | 开麦音（上扬） | 说完点按发送；按住模式下松开 |
| 思考 `thinking` | 关麦后、Agent 尚未开口 | 珊瑚色内收、缓慢旋转的光点 | 正在想… → 3 秒后：还在处理，稍等 → 10 秒后：花的时间比较久，可以随时打断 | 关麦音（下沉） | 取消本轮 |
| 说话 `speaking` | Agent 音频开始 | 鼠尾草绿，随 Agent 音量起伏 | 逐句显示 Agent 正在说的话 | — | 点按或按 Esc 打断；直接开口也可插话 |
| 后台工作 `working` | 有进行中的任务，前台空闲 | 待命外观 + 外圈琥珀色进度弧 | 正在处理 N 件事 | — | 查看或取消任务 |
| 需要确认 `needs-you` | 收到授权请求 | 琥珀色，外圈脉冲 | 需要你确认：{动作} | 提示音（两声） | 允许 / 拒绝（点按或说"允许/拒绝"） |
| 休眠 `hibernating` | 资源进入休眠档 | 灰蓝色，低频呼吸 | 省电模式，仍可正常对话 | — | 正常对话 |
| 出错 `error` | 见 4.2 错误分类 | 赤陶红，静止 | 按原因给出具体文案 | 错误音 | 按原因给出操作 |

状态优先级（同时满足时取高者）：`error` > `needs-you` > `speaking` > `listening` > `thinking` > `connecting` > `working` > `hibernating` > `ready` > `offline`。

---

## 4. 分阶段方案

### P0 打通信号（前提，约 2–3 天）

> **实施状态：除授权事件外已完成。**
>
> - 浏览器现在能收到：用户开始/停止说话、识别中间结果、Agent 开始/停止说话、打断、生态变化。转发规则集中在 `app/realtime/browser_wire.py`。
> - 额外修复：预合成队列（`app/realtime/pre_synth_queue.py`）原先丢弃了 TTS 结束帧，导致 Pipecat 要在音频停止 3 秒后才判定"Agent 说完"。现在最后一句播完立即触发。
> - 前端改为回调逐条派发事件（原先的 `lastEvent` 状态在消息成串到达时会丢事件），新增 `useVoiceSession` 状态机，并用一段真实通话录下的事件序列做了回放测试。
> - **授权事件暂缓转发**：TS 大脑里授权确认的闭环本身没有接通（没有任何代码调用 `CapabilityGateway.approve()`，路由时也不会传入待确认请求），浏览器端的"允许/拒绝"也没有服务端处理。此时显示弹窗只会给出无效按钮。需要先在 agent-runtime 补齐确认链路，再转发事件。
>
> 以下为原计划。

**后端（`app/server.py` 及 `app/realtime/voice_activity.py`）**

1. 把以下事件转发到浏览器数据通道：
   - `voice.user.started`、`voice.user.stopped`
   - `voice.transcript.partial`（已在源头去重，可直接转发；前端再做节流）
   - `diplomacy.elevation.requested`、`diplomacy.elevation.resolved`
   - `ecology.state.changed`、`budget.updated`
2. 新增 Agent 发声起止事件：在 `VoiceActivityEventProcessor` 处理 `BotStartedSpeakingFrame` / `BotStoppedSpeakingFrame` 时，发布 `voice.agent.started` / `voice.agent.stopped`，并转发给浏览器。这是"说话"状态唯一可靠的来源。
3. 打断事件 `voice.speech.cancel`（reason=barge_in）也转发，用于前端显示"已打断"。

**前端（`client/src/hooks/`）**

1. 在 `useAgentConnection.ts` 的事件白名单和类型定义里加入上述事件。
2. 新建 `useVoiceSession.ts`：纯 reducer + 单元测试，实现第 3 节的状态机。
3. 用 `voice.agent.started/stopped` 替换现在基于 enqueue 的 `isSpeaking`。
4. 对远端音轨接一个 `AnalyserNode`，输出 `agentLevel`（0–1），和已有的 `micLevel` 对称。
5. 生态状态改为事件驱动，轮询降为 30 秒一次兜底。

**验收**

- 用 `scripts/voice-smoke.py` 跑一轮：浏览器能依次收到 user.started → partial ×N → user.stopped → agent.started → agent.stopped。
- 在 `--barge-in` 场景下能收到 speech.cancel，界面在 0.5 秒内离开 speaking。
- 人工触发一个需要授权的任务，弹窗出现，点"允许"后任务继续。

### P1 主界面重构（约 4–5 天）

**布局**（基准为 Tauri 窗口 480×800，最小 360×560）：

```
┌─────────────────────────────┐
│ ● 已连接            ⚙        │  顶栏 48px：连接点 + 设置
├─────────────────────────────┤
│                             │
│          ╭─────╮            │
│          │ Orb │            │  Voice Orb，直径约 160px
│          ╰─────╯            │
│        正在想…               │  状态文案
│                             │
│   "帮我查一下明天的天气"     │  当前字幕：最新一句，大字号
│                             │
├─────────────────────────────┤
│  对话 · 话题 · 任务  ▲       │  底部抽屉把手（可上拉）
├─────────────────────────────┤
│        [ 🎤 大按钮 ]          │  主操作区：按钮 + 辅助操作
│   ⌨ 打字        ✋ 打断      │
└─────────────────────────────┘
```

具体改动：

1. **新组件 `VoiceOrb`**：SVG/CSS 实现，props 为 `state` 与 `level`（聆听时取 `micLevel`，说话时取 `agentLevel`）。动画只用 `transform` 和 `opacity`，`prefers-reduced-motion` 下退化为颜色变化。
2. **新组件 `LiveCaption`**：只显示当前一句。用户说话时显示 partial（浅色），定稿后转为正文色；Agent 说话时逐句显示。字号 `--ds-font-size-xl`，最多三行，超出时淡出顶部。
3. **底部抽屉 `SessionDrawer`**：收起时只露一行把手和计数（例："对话 12 · 话题 3 · 任务 1"）；上拉后有三个标签页：
   - 对话：完整字幕历史，改为气泡样式（用户靠右、珊瑚浅底；Agent 靠左、白底），每隔 5 分钟插入时间分隔。
   - 话题：现在的 `TaskNestPanel`，取消半卡预览和自动轮播，改为普通纵向列表，当前话题置顶高亮。
   - 任务：进行中的任务卡片，含角色、进度文字和"取消"按钮（发送 `task.cancel`）。
4. **Ecology 面板移出主界面**：移到设置页新的"运行状态"分组。主界面只在 `reserve` / `hibernating` 时于顶栏显示一个小标签，点击可查看说明。
5. **去掉状态栏的 Connect 按钮**：连接由主按钮负责；顶栏的连接点长按或点击可断开。
6. **修复 Storybook**：补齐 `AgentHomeScreen` 所有 story 的参数，新增 `VoiceOrb` 的全部状态 story，作为设计评审基准。

### P2 对话交互（约 4–5 天）

**轮次控制**

1. **一键开始**：离线时点主按钮 = 连接 + 连上后自动开麦，直接进入 `listening`。
2. **两种说话方式并存**：
   - 点按切换：点一下开麦，再点一下"发送"。按钮文案改为"点按说话 / 说完了"，不再使用"静音"。
   - 按住说话：按住按钮或空格键说话，松开即发送。按住超过 300ms 判定为按住模式。
3. **自动结束（可选）**：设置中提供"说完自动发送"开关。打开后，收到 `voice.user.stopped` 且静默 1.2 秒即自动关麦。服务端已支持 `TURN_MODE=auto`，此开关可对应切换。
4. **快捷键（桌面）**：空格按住说话；Esc 打断 Agent 或取消本轮；`⌘/Ctrl + ,` 打开设置；`⌘/Ctrl + K` 打开文字输入。

**打断与控制**

1. 说话状态下，主按钮变为"打断"，点按后发送新增的 `voice.speech.stop` 控制消息（需服务端配合清空 TTS 队列），并立即进入 `listening`。
2. 打断时 Orb 做一次快速收缩，字幕末尾标注"（已打断）"。
3. 思考超过 10 秒，状态文案下方出现"取消"文字按钮。

**错误分类**（替换统一的 "Connection error"）

| 原因 | 判定 | 文案 | 操作 |
|---|---|---|---|
| 麦克风权限被拒 | `getUserMedia` 抛出 `NotAllowedError` | 需要麦克风权限才能对话 | 显示各平台开启权限的步骤 |
| 没有麦克风 | `NotFoundError` | 没检测到麦克风 | 检查设备后重试 |
| 服务器连不上 | `/api/offer` 网络失败 | 连不上语音服务（{地址}） | 重试 / 打开设置改地址 |
| 服务器报错 | `/api/offer` 返回非 2xx | 语音服务出错了（{状态码}） | 重试 |
| 通话中断 | `connectionState` 变为 failed/disconnected | 连接断开了，正在重连… | 自动重连 3 次，失败后提示手动重试 |
| Agent 后台未连接 | sidecar 未连接 | 只能聊天，暂时不能执行任务 | 顶栏小标签提示，不阻断对话 |

需要在 `useAgentConnection` 中把错误原因作为结构化字段暴露（`error: { kind, detail }`），而不是只有一个 `"error"` 状态。

**授权确认**

1. 授权请求以"对话中的卡片"出现在字幕区上方，而不是遮挡全屏的模态框：用户仍能看到上下文，Agent 也会同时语音询问。
2. 卡片内容：要做什么、影响范围、来自哪个任务；按钮"允许 / 拒绝"。
3. 语音和点击二选一即可，任何一方完成后卡片立即收起（依赖 `diplomacy.elevation.resolved`）。
4. 文案中文化："需要你确认"、"将要：…"、"可能影响：…"。

**首次使用引导**

首次打开（本地存储无标记）时，用 3 步引导替代空白主界面：

1. 欢迎页：一句话介绍 + "开始"按钮；
2. 麦克风权限：解释用途后再请求权限；
3. 连接自检：依次检查服务器、语音识别、语音合成、Agent 后台，每项显示通过 / 失败与修复建议（复用 `/api/status` 和 `/api/agent-runtime/status`）。

**其他**

1. **文字输入兜底**：底部"打字"按钮展开单行输入框，发送后走与语音相同的链路（需服务端新增文字入口，发 `voice.transcript.final` 等价事件）。
2. **会话留存**：字幕与话题存入 IndexedDB，按会话分组；抽屉"对话"页顶部可切换历史会话。
3. **提示音**：开麦、关麦、需要确认、出错四种短音效（每个不超过 200ms，可在设置中关闭）。使用 WebAudio 合成，不引入音频文件。

### P3 视觉系统（约 3 天，可与 P2 并行）

1. **语言统一**：新建 `client/src/i18n/zh-CN.ts` 文案字典，所有面向用户的字符串从字典读取；`index.html` 改为 `lang="zh-CN"`，标题改为产品名。
2. **深色模式**：在 `main.tsx` 中按 `prefers-color-scheme` 设置 `data-theme`，设置页提供"跟随系统 / 浅色 / 深色"。补齐深色下 Voice Orb 与气泡的颜色 token。
3. **语义状态色 token**：新增 `--ds-color-state-listening/thinking/speaking/attention/idle`，组件只引用语义 token，便于整体调色。
4. **字号层级**：当前字幕 22px，状态文案 14px，历史气泡 15px，辅助信息 12px。中文行高统一 1.6。
5. **动效规范**：
   - 状态切换 200ms `--ds-ease-standard`；
   - Orb 随音量变化用 90ms 线性插值，避免抖动；
   - 抽屉展开 280ms，带轻微回弹；
   - `prefers-reduced-motion` 下关闭所有循环动画，只保留颜色过渡。
6. **品牌资产**：设计应用图标与 favicon（可基于 Voice Orb 造型），替换 Tauri 模板图标。
7. **视觉回归**：Storybook 修复后，为关键状态截图（Playwright 或 Chromatic），防止再次失真。

### P4 体验度量（约 1–2 天）

已有 HCI 事件日志（`scripts/query-hci-events.sh`），在此基础上补充前端埋点，并为每个指标设定目标：

| 指标 | 定义 | 目标 |
|---|---|---|
| 首次开口耗时 | 打开应用到进入 `listening` | 首次 < 10 秒，之后 < 2 秒 |
| 开口所需点击数 | 离线状态到 `listening` 的点击次数 | 1 次 |
| 感知响应延迟 | 关麦到 `voice.agent.started` | P50 < 1.5 秒，P90 < 3 秒 |
| 打断生效时间 | 点击打断到 Agent 音频停止 | < 300ms |
| 思考超时率 | `thinking` 超过 10 秒的轮次占比 | < 5% |
| 授权响应时间 | 授权卡片出现到用户做出选择 | 中位数 < 5 秒 |
| 误触发率 | 自动模式下无有效内容的轮次占比 | < 3% |

另外，在设置页"开发者选项"中加一个可开关的延迟浮层，实时显示每轮各段耗时，便于调试和体验评审。

---

## 5. 组件改动清单

| 文件 / 组件 | 改动 | 阶段 |
|---|---|---|
| `app/server.py` | 扩充转发白名单；新增 `voice.speech.stop` 控制处理 | P0 / P2 |
| `app/realtime/voice_activity.py` | 发布 `voice.agent.started/stopped` | P0 |
| `hooks/useAgentConnection.ts` | 新事件类型；结构化错误；远端音量；自动重连 | P0 / P2 |
| `hooks/useVoiceSession.ts`（新） | 统一会话状态机 | P0 |
| `hooks/useAgentLevel.ts`（新） | 远端音轨电平 | P0 |
| `VoiceOrb`（新） | 语音形象 | P1 |
| `LiveCaption`（新） | 当前句字幕 | P1 |
| `SessionDrawer`（新） | 对话 / 话题 / 任务抽屉 | P1 |
| `AgentHomeScreen` | 按新布局重排 | P1 |
| `AgentStatusStrip` | 精简为顶栏：连接点 + 异常标签 + 设置 | P1 |
| `TranscriptPanel` | 改为气泡样式，移入抽屉 | P1 |
| `TaskNestPanel` | 取消半卡与轮播，改为纵向列表 | P1 |
| `EcologyPanel` | 移入设置页"运行状态" | P1 |
| `TalkButton` | 按住说话、打断态、新文案 | P2 |
| `ElevationDialog` | 改为对话内卡片，中文化 | P2 |
| `OnboardingFlow`（新） | 首次引导与连接自检 | P2 |
| `TextComposer`（新） | 文字输入兜底 | P2 |
| `SettingsScreen` | 外观主题、提示音、自动发送、运行状态 | P2 / P3 |
| `i18n/zh-CN.ts`（新） | 文案字典 | P3 |
| `tokens.css` | 语义状态色、深色补齐、字幕字号 | P3 |
| `*.stories.tsx` | 修复失效 story，补齐新组件状态 | P1 / P3 |

---

## 6. 建议排期

| 周 | 内容 | 产出 |
|---|---|---|
| 第 1 周 | P0 信号打通 + `useVoiceSession` + 修复 Storybook | 所有状态在真实对话中可观测 |
| 第 2 周 | P1 主界面重构（Orb、字幕、抽屉） | 新主界面可用 |
| 第 3 周 | P2 交互（一键开始、按住说话、打断、错误分类、授权卡片） | 对话流程完整 |
| 第 4 周 | P2 引导 / 文字输入 / 留存 + P3 视觉系统 | 可交付内测版本 |
| 第 5 周 | P4 度量 + 真人 dogfood 一周 + 按数据调整 | 体验基线报告 |

如果只能先做一件事：**P0 + Voice Orb**。仅这两项就能让用户第一次在界面上"看见"对话。

---

## 7. 验收方式

1. **自动化**：`useVoiceSession` 状态机单元测试覆盖第 3 节所有状态转移；Storybook 每个状态有截图基线。
2. **半自动**：`scripts/voice-smoke.py --suite` 运行时，录制前端状态序列，与期望序列比对。
3. **人工**：用真实麦克风完成以下脚本，每步截图或录屏：
   - 首次打开 → 引导 → 第一句话；
   - 普通问答；
   - Agent 说话中途打断；
   - 触发需要授权的任务，分别用点击和语音确认；
   - 断网后自动重连；
   - 拒绝麦克风权限后的引导；
   - 深色模式和窄屏（360px）下各走一遍。

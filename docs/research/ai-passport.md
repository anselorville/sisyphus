# AI Passport（FoloToy AI 护照）：硬件调研与接入 Marcus 的方案

调研日期：2026-10-25。**已核实**的来自官网和开源固件仓库；**推断**和**未能核实**的单独标出。

## 1. 结论

- 它是一块 **ESP32-C3（8 MB Flash、无 PSRAM）** 的开源硬件：240×320 彩屏、三个按键、ES8311 音频编解码器
  （同时有麦克风和喇叭）、2.4 GHz Wi-Fi、BLE、Type-C、500 mAh 电池，固件 MIT 开源（ESP-IDF + LVGL）。
- **能做 Marcus 的“桌面语音终端”，但只能是一个薄客户端，走 WebSocket 而不是 WebRTC，用按键说话（Push-to-talk）。**
  C3 没有 PSRAM、单核，做不了 WebRTC，也不太可能在本机做唤醒词。
- 出厂固件**没有**联网语音能力：Wi-Fi 只有扫描演示，BLE 只有广播；联网配网（BluFi）有单独的演示分支。
  语音通路要自己写固件。
- 对 Marcus 需要两头的工作：**设备固件**（Wi-Fi 联网、PTT 录音上行、播放下行、屏幕状态）和
  **后端新增一条 WebSocket 音频入口**（复用现有 STT→sidecar→TTS 管线）。后端那头我估算 1–2 天，
  固件那头是主要风险（见第 6 节）。
- **价格、发售渠道、NFC 是否可用、麦克风/喇叭的具体型号，没有查到**（第 7 节列了该问厂商的问题）。

## 2. 它是什么

来源：[官网 ai-passport.folotoy.cn](https://ai-passport.folotoy.cn)、[快速上手](https://ai-passport.folotoy.cn/guides/getting-started/)、
[用 AI 做玩法](https://ai-passport.folotoy.cn/guides/create-a-play-with-agent/)、
[网页刷机](https://ai-passport.folotoy.cn/tools/web-flasher/)、
[GitHub FoloToy/ai-passport](https://github.com/folotoy/ai-passport)（主仓库在 [Gitee](https://gitee.com/FoloToy/ai-passport)）。

- 定位：开放的可穿戴 AI 平台，“给人塑造、改造、创造”。出厂自带“通行证”（身份卡）玩法：
  经 **BLE 连微信小程序**同步名字、头像、简介、全屏图；内置一个小游戏。
- **“玩法”（play）= 一整份固件**：社区可发布，安装会**覆盖设备上全部内容**；可用浏览器网页刷机，也可恢复出厂固件。
- 开发方式鼓励 **AI 编程 agent**（仓库有 `AGENTS.md` / `CLAUDE.md`，要求安装 `passport-develop`、`passport-setup`、
  `passport-build`、`passport-device-test`、`passport-debug` 五个 skill）。官网有 Codex / Claude Code / TRAE 教程。
- 官网另提供企业礼品定制（轻定制 100 台起）。

## 3. 硬件规格

| 项 | 内容 | 来源 |
|---|---|---|
| 尺寸 / 重量 | 60 × 95 × 8.5 mm，50 g | 官网 |
| SoC | **ESP32-C3**，8 MB Flash，**无 PSRAM** | 仓库 README / AGENTS.md |
| 屏幕 | ST7789P3，240×320 竖屏，RGB565，SPI2 @40 MHz，LEDC 背光；无触摸，无 LCD MISO / TE | 仓库 docs |
| 按键 | 左侧电源键；右侧 上 / 下 / 确定 三键（共用 GPIO0 上的 ADC 电阻梯） | 快速上手 + 仓库 |
| 音频 | **ES8311** 编解码器，I2S0 全双工 PCM，支持播放和麦克风采集、挂起/恢复 | 仓库 docs |
| Wi-Fi | 2.4 GHz；**固件只有扫描演示**（`demo_wifi.c`），不连接、不存凭据；连接/BluFi 配网有 `demo/blufi-provisioning` 分支 | 仓库 docs |
| 蓝牙 | BLE（NimBLE）；主分支只做不可连接的广播（名 `FoloPassport`）；C3 不支持经典蓝牙 | 仓库 docs |
| 电池 | 500 mAh；CW2017 电量计（读数未校准） | 官网 + 仓库 |
| 充电 | Type-C；充电时绿灯常亮，充满灭（屏幕不显示充电状态） | 快速上手 |
| 烧录 / 日志 | 原生 USB Serial/JTAG（GPIO18/19 被占用） | 仓库 docs |
| 低功耗 | 轻睡眠 / 深睡眠，RTC 定时唤醒 | 仓库 docs |
| NFC | 官网外壳透视图提到 NFC；**固件文档没有任何 NFC 内容** | 官网（未核实可用） |
| 固件框架 | ESP-IDF 5.5.3 + LVGL；BSP 在 `components/bsp`（`bsp_audio_*`、`bsp_display_*`、`bsp_lvgl_*`、`bsp_button_*`、`bsp_battery_*`） | 仓库 AGENTS.md |
| 许可 | MIT | 仓库 |

芯片通识（非本次抓取，来自 Espressif 公开规格与搜索摘要）：ESP32-C3 为单核 RISC-V、约 400 KB SRAM、Wi-Fi 4 + BLE 5。
[JLCPCB 对比文](https://jlcpcb.com/blog/esp32-c3-vs-s3)印证了“400 KB SRAM、不支持 PSRAM”。

## 4. 对 Marcus 意味着什么

### 4.1 能力对照

| Marcus 需要 | AI Passport | 判断 |
|---|---|---|
| 收音 | ES8311 + 麦克风，I2S 采集 | 可以（具体麦克风指标未知，收音距离/信噪比要实测） |
| 出声 | ES8311 + 喇叭 | 可以（喇叭尺寸小，音质/音量要实测） |
| 联网 | Wi-Fi 2.4G（固件需自己写连接） | 可以 |
| 传输协议 | 没有 WebRTC 的余量 | **只能 WebSocket / MQTT / HTTP 流** |
| 唤醒词 | 无 PSRAM | **推断**：本机跑唤醒词很吃紧，建议按键说话 |
| 回声消除 | 无硬件 AEC | 用 PTT（说话时喇叭静音）规避，不做免提 |
| 显示 | 240×320 彩屏 | 够显示状态、字幕、任务进度；中文需要 LVGL 中文字体子集（官方有 `lvgl-chinese-fonts` 指南） |
| 输入 | 3 键，无触摸 | 确定键 = 按住说话；上/下 = 翻字幕/切换 |
| 续航 | 500 mAh | **推断**：持续 Wi-Fi 收发约 1–2 小时量级，需实测；插电使用更合理 |

### 4.2 推荐架构：设备做薄客户端，Marcus 后端不变

```
AI Passport (ESP32-C3)                          Marcus 主机
┌──────────────────────┐   Wi-Fi / WSS    ┌─────────────────────────────────────┐
│ OK 键 按住 = 说话        │ ───────────────► │ 新增 /ws/device (FastAPI WebSocket)  │
│ I2S 采集 16kHz mono PCM │  JSON 控制 +      │   └► 同一条媒体管线：STT → sidecar →     │
│ 分块上行(20~40ms)       │  二进制音频帧     │      (Jev 决策, 角色, 工具) → TTS      │
│                        │ ◄─────────────── │ 回传 TTS PCM + 字幕/任务事件           │
│ 播放下行 PCM / 显示字幕   │                  └─────────────────────────────────────┘
└──────────────────────┘
```

- **转 WebSocket 的原因**：现有后端用 SmallWebRTC，C3 做不了 WebRTC（无 PSRAM、单核）。
  后端需要一个“设备入口”，把设备音频接到现有管线。Pipecat 自带 WebSocket 传输（带序列化器），
  可复用 `build_media_pipeline` 的 STT / TTS / 预合成队列 / 语音活动事件，只换 transport。
- **回合边界**：设备用 OK 键发 `{"type":"mic","open":true/false}`，后端按现有 `manual` 模式处理
  （`MicGateProcessor` 已经把这类消息转成回合帧；WebSocket 入口只需把设备发来的 `mic` 控制消息
  交给它，即转成它认的 `InputTransportMessageFrame`）。这样不需要设备端 VAD。
- **音频格式**：先用 **16 kHz 单声道 PCM16 原始流**（约 32 KB/s，家用 Wi-Fi 毫无压力），把固件复杂度压到最低；
  下行 TTS 同样用 PCM。Opus 编码在 C3 上是否可行**未核实**（常见 Opus 组件按 ESP32/S3 与 PSRAM 设计）；
  如要省流量，可先试 ADPCM / μ-law 这类轻量压缩。
- **配网**：仓库已有 BluFi 配网演示和配套小程序文档，可直接参考。
- **安全**：局域网内先用 `ws://` + 共享令牌起步；要出局域网再上 `wss://`（C3 上 TLS 有内存开销，需实测）。

### 4.3 设备上的体验设计

- 屏幕状态机：待机 / 聆听（按住中）/ 思考 / 说话 / 断线；说话时显示 Marcus 的字幕行。
- 复用后端已有事件：`user.transcript`、`agent.transcript`、`task.created/progress/completed`。
- 打断：设备按下 OK 键即视为插话，立刻停止本地播放，并发 `mic open`（后端已有打断链路）。

## 5. 要做的工作

**后端（预计 1–2 天，风险低）**
1. `/ws/device`：WebSocket 接入，鉴权令牌，协议版本号。
2. 复用 `build_media_pipeline`，用 WebSocket transport 替换 `SmallWebRTCTransport`；PTT 走 `mic` 消息。
3. 下行：TTS 音频帧 + 事件（字幕、任务状态）；上行：PCM 帧 + 控制消息。
4. 测试：用脚本扮演设备（类似 `scripts/voice-smoke.py`，改成 WebSocket 客户端）。

**固件（主要风险，预计数天到一两周，取决于是否顺利）**
1. 从 `main` 分支起新应用（官方要求**自行设计 UI**，不能复用 demo 的菜单壳）。
2. Wi-Fi 连接 + BluFi 配网，保存凭据（官方 `main` 分支没有）。
3. I2S 采集 → WebSocket 二进制帧；下行 PCM → I2S 播放；按键事件；LVGL 字幕。
4. 所有慢操作放工作线程（官方规范：按键回调不能阻塞）。
5. 用官方五个 skill 配合 AI 编程 agent 开发，**刷机前需用户确认**（官方流程要求）。

## 6. 风险

- **单核 + 400 KB SRAM 同时跑 Wi-Fi、I2S 双向、LVGL、WebSocket**：音频欠载/卡顿是首要风险。
  缓解：小缓冲、固定帧长、优先级分层，先做“只录不放”、再做“只放不录”，最后合并。
- **没有 AEC，喇叭和麦克风靠得很近**：必须半双工（说话时不播）。
- **TLS 与 Opus 的内存预算未知**：先做明文局域网 + PCM 的最小闭环验证。
- **Wi-Fi 省电模式 vs 延迟**：省电开着会增加数十到数百毫秒抖动，需实测。
- **电池寿命**：未知，插电使用是稳妥假设。
- **覆盖式刷机**：每次安装玩法会清掉整机内容；务必先学会恢复出厂固件。
- **生态风险**：产品新、文档有缺（例如官网没写价格、规格不全）；固件是 MIT，可自行掌控。

## 7. 没有核实的，以及建议问厂商的

- 价格、发售渠道、库存（官网只有“立即购买”按钮；搜索也没查到）。
- NFC 是否真的可用及型号（官网外壳图提到，固件文档无）。
- 麦克风 / 喇叭的型号、灵敏度、功率；天线性能。
- 出厂 Flash 分区和 OTA 方案是否支持“只更新我的固件而不清空设备内容”。
- Wi-Fi 发射功耗与续航实测数据。
- 搜索结果里有一条第三方条目（`RongleCat/ai-passport-muse`，声称是 Meta Muse Gadget SDK 的 AI Passport 移植，
  宣称“ESP32-C3 语音 + 屏幕回复 + Home Link”）。**我没有核实它是否真实可用**，但若属实，
  它是个可参考的“C3 + 语音”先例，值得你打开仓库看一眼。

## 8. 建议的验证顺序（每一步都有明确的通过标准）

1. **拿到设备，用网页刷机装一个社区玩法**，确认 USB / 浏览器串口权限都正常，并实操“恢复出厂固件”。
2. 克隆官方仓库，用其 skill 构建并刷入**官方音频测试页**，确认能录音、能放音。
3. 固件 PoC：Wi-Fi 连接 + WebSocket + **回环**（上行 PCM 原样回放），测往返延迟和欠载率。
4. 后端：`/ws/device` + 脚本扮演设备，跑通“说话 → 转写 → Marcus 回答 → 设备出声”。
5. 合并，并按 `docs/hci-observations.md` 的格式记录真人体验（延迟、误触、音量、续航）。

## 来源

- [ai-passport.folotoy.cn](https://ai-passport.folotoy.cn)（首页、getting-started、create-your-own-play、create-a-play-with-agent、web-flasher）
- [github.com/folotoy/ai-passport](https://github.com/folotoy/ai-passport)：README、`AGENTS.md`、`docs/README.md`
- [JLCPCB: ESP32-C3 vs ESP32-S3](https://jlcpcb.com/blog/esp32-c3-vs-s3)
- 搜索未查到价格与第三方移植的一手来源。

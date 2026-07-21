# Model Lab v2 Design（模型调优工作台二期设计）

## Objective / 目标

把 Model Lab 从"参数表单 + 单次试跑"升级为真正的**调优工作台**：

1. 本地（oMLX）LLM 支持任意角色（persona）调试与一键切换——不再只有云端才能改系统提示词。
2. 本地 TTS（VoxCPM2）补齐音色维度：voice 克隆（ref_audio/ref_text）、音色库管理、
   角色前置词（delivery persona）预设——与已有的 speed/temperature/instructions 组成完整调优面。
3. 预设（Preset）体系：LLM 角色和 TTS 风格都可以命名保存、快速切换，而不是每次手敲 textarea。
4. 预览闭环增强：延迟数据、A/B 对比、麦克风直录、全链路（说话→STT→LLM→TTS）一键测试。

非目标（本期不做）：offline 引擎（Ollama/Piper/faster-whisper）的 adapter 化（列为 Phase E 可选项）、
中途热切换 pipeline 配置、Pi 硬件调参。

## Current State / 现状

架构分层已经很干净，二期几乎全是增量：

- **Schema 层** `app/model_adapters/`：每个 adapter 一个 JSON spec（`specs/*.json`），
  声明可调字段；本地 adapter 按 oMLX `config_model_type` 命名（`omlx:qwen3_5`、`omlx:voxcpm2`），
  云端按 capability 共享（`cloud:text/speech/transcription`）。
- **Values 层** `app/model_settings.py`：`model_settings.json`，`{adapter_id: {field: value}}` 通用存储。
- **应用层** `app/pipeline.py`：连接建立时读取 values 构建服务。
  **注意：`build_pipeline()` 已经把 `omlx:<llm_type>` 的 `system_prompt_override` 作为
  `persona_override` 传入 `build_translation_system_prompt()`（pipeline.py:1461-1474），
  且 persona 与格式契约（`[SRC->DST|tone]` 标签协议）分离，persona 替换不会破坏管线。**
- **预览层** `app/model_lab_preview.py`：用 Pipecat `run_test()` 跑真实服务，
  `preview_text` 也已经读取 `system_prompt_override`。
- **前端** `ModelLabScreen.tsx` + `useModelLab.ts`：完全由 `/api/model-lab/schema` 动态渲染，
  draft 本地暂存、显式 Save、Test-it-now 面板。

## Gap Analysis / 差距

| # | 差距 | 根因 | 用户感知 |
|---|------|------|---------|
| G1 | 本地 LLM 无法改角色 | `omlx_qwen3_5.json` 未声明 `system_prompt_override` 字段（后端已接线） | "只有云端能调 persona" |
| G2 | 角色只能手敲 textarea | 无 preset 存储/API/UI | 无法"随意切换任意角色" |
| G3 | VoxCPM2 音色只有 "default" | oMLX 的 ref_audio/ref_text 克隆能力未接线 | 音色不可调 |
| G4 | TTS 无"角色前置词"预设 | `instructions` 只有裸 textarea，无预设 | 每次调风格都重新描述 |
| G5 | 预览看不到延迟 | 预览响应无 timing 元数据 | 调优时对性能"盲" |
| G6 | 调 TTS 无法对比 | 每次生成覆盖上一次，无 A/B、无历史 | "改了参数但说不出差别" |
| G7 | STT 预览只能传 WAV 文件 | 无浏览器录音入口 | 调 Listening 门槛高 |
| G8 | 单点预览 ≠ 产品体验 | 无全链路预览 | 各环节单独 OK，串起来不 OK 无法在 Lab 里复现 |

## Design

### 1. 本地 LLM persona 字段（G1）

`app/model_adapters/specs/omlx_qwen3_5.json` 增加一个字段（与 `cloud_text.json` 同款文案）：

```json
{
  "key": "system_prompt_override",
  "label": "Persona / system prompt",
  "kind": "textarea",
  "help": "Replaces the assistant's persona and behavior instructions. The structural output format the pipeline depends on (direction/tone tagging) is always preserved underneath. Leave empty to use the default translator persona.",
  "default": null
}
```

改动仅此一处：values 存储是 schema-free 的，`build_pipeline` 与 `preview_text` 均已读取该 key。
其它本地 text 架构（未来新增 spec 文件时）同样带上这个字段。

### 2. Preset 体系（G2 / G4）

一个通用机制同时服务 LLM 角色与 TTS 风格：**preset = 命名的字段值包**。

**存储**：仓库根 `model_presets.json`（与 `model_settings.json` 同级、同 gitignore 层级）：

```json
{
  "text": [
    {"id": "p_travel", "name": "旅行翻译官", "builtin": false,
     "values": {"system_prompt_override": "...", "temperature": 0.3}}
  ],
  "speech": [
    {"id": "p_warm", "name": "温柔慢速", "builtin": false,
     "values": {"instructions": "speak warmly and a little slower", "speed": 0.9}}
  ]
}
```

- Preset 按 **capability** 归类而非 adapter：同一个角色文案在 cloud:text 与 omlx:qwen3_5
  之间通用（两边字段 key 一致是既有设计约定）。apply 时只取目标 adapter spec 里声明过的 key，
  多余 key 静默忽略（与 values 层 forward-compat posture 一致）。
- **内置 preset**（`builtin: true`，代码内置常量，不落盘、不可删）：
  - text：`默认翻译专家`（即 `_DEFAULT_PERSONA`，values 为空 = 恢复默认）、`同声传译（极简直译）`、
    `口语化意译`、`商务正式`、`儿童友好`；
  - speech：`默认`、`温柔舒缓`、`新闻播报`、`快速简洁`、`热情活泼`。

**API**（`app/server.py`）：

```
GET    /api/model-lab/presets?capability=text|speech      -> {"presets": [...]}（内置+自定义）
POST   /api/model-lab/presets     body {capability, name, values}   -> 新建（201）
PUT    /api/model-lab/presets/{id}  body {name?, values?}           -> 更新（内置 -> 400）
DELETE /api/model-lab/presets/{id}                                  -> 删除（内置 -> 400）
```

**UI**（`ModelLabScreen`）：字段区上方加一行 preset 条——下拉选择 + `另存为预设` + `删除`。
选中 preset = 把它的 values 写入当前 draft（仍走既有 draft→Test→Save 流程，不直接落盘）；
draft 与选中 preset 出现差异时显示"已修改"标记。

### 3. VoxCPM2 音色库 / voice 克隆（G3）

oMLX `/v1/audio/speech`（`AudioSpeechRequest`）支持 `ref_audio` + `ref_text` 做 zero-shot
音色克隆（spec 文件的 help 文案已写明"supported by oMLX's endpoint but not wired up"）。
实现前先对着运行中的 oMLX `/openapi.json` 确认两个字段的确切名称与类型（base64 还是 URL/路径）。

**存储**：`models/voices/<voice_id>/`（与 `models/piper` 同层级，gitignored）：

```
models/voices/aunt_mei/
  ref.wav        # 参考音频（5~15s，16-bit PCM WAV）
  ref.txt        # 参考音频的逐字文本
  meta.json      # {"name": "梅姨", "created_at": ..., "language": "zh"}
```

**API**：

```
GET    /api/model-lab/voices                    -> {"voices": [{"id", "name", "language", ...}]}
POST   /api/model-lab/voices   multipart: name, ref_text, audio(wav)   -> 新建
DELETE /api/model-lab/voices/{id}
```

上传校验：16-bit PCM WAV（复用 `_pcm_chunks_from_wav` 的校验姿势）、时长 1~30s、`ref_text` 非空。

**接线**：

- `MlxTTSService` 增加 `ref_audio_path` / `ref_text` 构造参数；`run_tts()` 中当 voice 非
  `"default"` 时把参考音频（按 openapi 确认的编码方式）放进 `extra_body`。
- `omlx_voxcpm2.json` 的 `voice` 字段保留 `kind: "select"`，但 options 改为**服务端动态注入**：
  `list_adapters` 响应组装时，speech capability 的本地 adapter 若为 voxcpm2，把
  `["default", ...voices]` 填入 options（schema 本来就是每次请求现算的，无缓存问题）。
- 预览与正式管线走同一构建函数（既有原则：preview 永远复用真实 builder）。

**UI**：Voice 下拉 + "添加音色"入口（弹出：名称、录音/上传参考音频、参考文本）。
录音复用 G7 的麦克风录制组件。

### 4. 预览闭环增强（G5 / G6 / G7 / G8）

**G5 延迟元数据**：三个 preview 端点的响应统一带上 timing：

- text/transcription（JSON）：增加 `"timing": {"total_ms": ...}`；
- speech（音频流）：用响应头 `X-Preview-Total-Ms` 与 `X-Preview-Audio-Ms`（音频时长）。

前端在结果区显示 `合成 8.6s / 音频 1.8s` 这类摘要。实现在 `model_lab_preview.py`
各函数内计时（`time.monotonic()` 包住 `run_test()`）。

**G6 生成历史与 A/B**：前端 state 级功能，后端零改动。SpeechTestPanel 把每次生成的
`{blob, 当时的 draft 快照, timing}` push 进列表（session 内存留，上限 10 条，逐条可播放/删除），
每条显示与当前 draft 的参数 diff。LLM TextTestPanel 同样保留最近 N 次输出+参数快照。

**G7 麦克风直录**：TranscriptionTestPanel 增加"录一段"按钮——`getUserMedia` +
AudioWorklet/ScriptProcessor 采 PCM，前端封 WAV（16-bit）后走既有 multipart 上传。
不用 MediaRecorder 的 webm/opus，避免后端加解码依赖（preview 端点是 WAV-only，保持不变）。

**G8 全链路预览**：新端点

```
POST /api/model-lab/preview/chain   multipart: audio(wav), values(JSON, 全量 draft 按 adapter_id 分组)
  -> {"transcript": ..., "translated_text": ..., "direction": ..., "tone": ...,
      "timing": {"stt_ms", "llm_ms", "tts_ms", "total_ms"}}  + 音频（拆两步：见下）
```

实现为顺序调用既有三个 preview 函数（STT→LLM→TTS），LLM 步骤用**真实翻译系统提示词**
（`build_translation_system_prompt(persona_override=draft 的 system_prompt_override)`），
并经 `parse_direction_prefix` 剥标签——这是与单点 text 预览（刻意不用翻译契约）的关键区别：
chain 预览的目的就是复现产品行为。响应因含音频用 multipart 或两次请求
（先 JSON 返回文本+timing+一个一次性 audio token，再 GET 取音频）——实现时二选一，倾向后者（简单）。

UI：Model Lab 顶部新增第四个 tab `全链路`（录音→逐段显示 转写/译文/方向/tone/分段耗时→播放）。

### 5. API 一览（新增/变更）

| Endpoint | 变更 |
|---|---|
| `GET /api/model-lab/schema` | speech 本地 adapter 的 voice options 动态注入音色库 |
| `POST /api/model-lab/preview/{text,transcription}` | 响应加 `timing` |
| `POST /api/model-lab/preview/speech` | 响应头加 `X-Preview-*-Ms` |
| `GET/POST/PUT/DELETE /api/model-lab/presets` | 新增 |
| `GET/POST/DELETE /api/model-lab/voices` | 新增 |
| `POST /api/model-lab/preview/chain` (+audio 取回) | 新增 |

存储新增：`model_presets.json`（根目录，gitignore）、`models/voices/`（gitignore）。

## Phase E（可选，后续）

- offline 引擎 adapter 化：`ollama:<family>`、`piper` spec 文件 + `_build_local_service_trio`
  接线（目前该函数显式不读 values）；Piper 的可调面主要是 voice 模型选择与 length_scale（语速）。
- 保存后热生效："应用并重连"按钮（客户端主动断开重连即可，不需要 pipeline 热重建）。

## Risks / 注意

- oMLX ref_audio 的编码方式（base64 inline vs 文件路径）未验证——Task 开工第一步先打 openapi.json。
- Preset 跨 adapter 复用依赖"同 capability 字段 key 一致"的约定，新增 spec 文件时需守住这个约定。
- chain 预览的 LLM 步骤走翻译契约，若 persona 写得离谱导致标签缺失，行为与产品一致
  （标签剥不掉、direction 为空）——这正是要暴露给调优者看的，不做兜底美化。

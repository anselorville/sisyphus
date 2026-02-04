## 📋 项目上下文文档

以下是完整的上下文信息，您可以在新session中使用这些内容继续工作：

---

## ✅ 已完成工作

### Phase 1: 项目搭建
- [x] Git仓库初始化（.gitignore）
- [x] Tauri v2 + React + TypeScript项目创建
- [x] 依赖配置（package.json）

### Phase 2: Python推理服务
- [x] 虚拟环境创建（inference/venv）
- [x] 依赖安装（websockets, transformers, torch, numpy, librosa）
- [x] ASR WebSocket服务（asr_service.py）
- [x] TTS WebSocket服务（tts_service.py）
- [x] 编排脚本（run_inference.py）
- [x] 测试脚本（test_asr.py, test_tts.py）
- [x] CUDA环境搭建（Visual C++ Redistributable + PyTorch 2.4.0+cu124）
- [x] 模型配置（models.yaml）
- [x] ASR服务CUDA优化（device检测、FP16、KV cache）
- [x] TTS服务CUDA优化（device检测、FP16、base/custom模型）
- [x] 语音管理工具（voice_manager.py）
- [x] 独立运行脚本（run_asr.py、run_tts.py、start_both.bat）
- [x] TTS独立环境（venv-tts，transformers 4.57.x + qwen-tts）
- [x] WebSocket通信修复（超时处理、bytes.tobytes()错误）
- [x] 音频生成验证（test_diagnose.py、test_tts.py通过）

### Phase 3: Rust后端组件
- [x] 依赖配置（tokio, tokio-tungstenite, serde, async-openai, cpal, anyhow）
- [x] 音频捕获（audio/capture.rs）- 包含ASR WebSocket集成
- [x] WebSocket客户端（inference/client.rs）
- [x] 音频播放（audio/playback.rs）- 包含状态事件发射
- [x] 对话状态机（conversation/state.rs）
- [x] LLM流式客户端（llm/client.rs）- 包含TTS集成
- [x] Tauri命令集成

### Phase 4: React前端
- [x] Zustand状态管理安装
- [x] VoiceAssistant组件实现
- [x] Tauri事件/命令集成
- [x] 事件监听更新（voice_assistant: 前缀命名空间）

### Phase 5: 前后端集成 ✨ **完成**
- [x] ASR WebSocket集成（capture.rs → ws://127.0.0.1:8765）
- [x] TTS WebSocket集成（llm/client.rs → ws://127.0.0.1:8766）
- [x] 音频流式传输（PCM16 格式，640字节帧）
- [x] 状态机自动转换（Idle → Listening → FinalizingASR → Thinking → Speaking → Idle）
- [x] 编译错误修复（async_openai API、cpal Stream生命周期、MutexGuard跨await）
- [x] 播放完成自动回到Idle状态

### Phase 6: 文档
- [x] README.md创建（架构、安装、使用说明）
- [x] PROJECT_CURRENT_STATUS.md（本文档，工作状态追踪）
- [x] .gitignore更新

---

## 🎉 当前状态：集成完成，可以测试

**项目已完成所有核心功能集成，可以进行端到端测试！**

---

## 📂 当前文件结构

```
sisyphus/
├── .env.example                    # 环境变量模板
├── .gitignore
├── PROJECT_CURRENT_STATUS.md        # 本文档（工作状态追踪）
├── README.md                       # 主文档
├── docs/
│   └── MODELS.md                 # 模型配置文档
├── inference/
│   ├── venv/                      # ASR虚拟环境（transformers 5.x + torch 2.4.0+cu124）
│   ├── venv-tts/                  # TTS虚拟环境（transformers 4.57.x + qwen-tts）
│   ├── requirements.txt              # ASR依赖
│   ├── requirements-tts.txt          # TTS依赖
│   ├── models.yaml                # 模型配置（ASR: GLM-ASR-Nano-2512, TTS: Qwen3-TTS-12Hz-1.7B Base/CustomVoice）
│   ├── voices/                    # 语音参考目录
│   ├── voice_manager.py           # 语音管理工具
│   ├── asr_service.py             # ASR WebSocket服务（CUDA优化）
│   ├── tts_service.py             # TTS WebSocket服务（CUDA优化、base/custom支持）
│   ├── run_asr.py                # ASR独立运行入口
│   ├── run_tts.py                # TTS独立运行入口
│   ├── start_both.bat            # 批量启动脚本
│   ├── test_asr.py              # ASR测试脚本
│   ├── test_tts.py              # TTS测试脚本（已修复超时问题）
│   ├── test_diagnose.py         # TTS诊断脚本
│   └── run_inference.py         # 编排脚本（原始，已被独立脚本替代）
├── src-tauri/
│   ├── Cargo.toml
│   ├── src/
│   │   ├── audio/
│   │   │   ├── capture.rs       # 音频捕获 + ASR WebSocket集成
│   │   │   ├── playback.rs      # 音频播放 + 状态事件发射 + 自动完成检测
│   │   │   └── mod.rs
│   │   ├── conversation/
│   │   │   ├── state.rs
│   │   │   └── mod.rs
│   │   ├── inference/
│   │   │   ├── client.rs        # WebSocket连接工具（重试逻辑）
│   │   │   └── mod.rs
│   │   ├── llm/
│   │   │   ├── client.rs        # LLM + TTS集成（OpenAI → TTS → 播放队列）
│   │   │   └── mod.rs
│   │   └── lib.rs               # 应用入口（初始化playback模块）
│   └── tauri.conf.json
└── src/
    ├── components/
    │   └── VoiceAssistant.tsx   # React组件（事件监听、状态管理）
    ├── App.tsx
    ├── App.css
    ├── main.tsx
    └── vite-env.d.ts
```

---

## 🔄 完整数据流架构

```
┌─────────────────────────────────────────────────────────────────┐
│                     Tauri Application                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────┐  f32 samples  ┌──────────────┐  PCM16 Binary     │
│  │Microphone├──────────────►│ capture.rs   ├────────────────┐   │
│  └──────────┘               │ - 转PCM16     │                │   │
│                             │ - 640字节帧    │                │   │
│                             │ - 音量级别     │                │   │
│                             └───────┬────────┘                │   │
│                                     │                         │   │
│                              voice_assistant:                 │   │
│                              audio_level                      │   │
│                                     ↓                         ↓   │
│                             ┌───────────────┐         ┌──────────┤
│                             │  Frontend     │         │ ASR WS   │
│                             │  (React)      │         │:8765     │
│                             │               │◄────────┤          │
│                             │  - 状态显示    │  JSON   └──────────┘
│                             │  - 转录显示    │  (transcript)      │
│                             │  - 响应显示    │                    │
│                             └───────┬───────┘                    │
│                                     │                            │
│                               user message                       │
│                              (stop_recording)                    │
│                                     │                            │
│                                     ▼                            │
│                             ┌───────────────┐                    │
│                             │ llm/client.rs │                    │
│                             │ - OpenAI API  │                    │
│                             │ - 流式响应     │                    │
│                             └───────┬───────┘                    │
│                                     │                            │
│                                text chunks                       │
│                                     │                            │
│                                     ▼                            │
│  ┌──────────┐  PCM16       ┌───────────────┐  JSON (text)      │
│  │ Speaker  │◄─────────────┤ playback.rs   │◄──────────────┐   │
│  └──────────┘              │ - 队列缓冲     │               │   │
│                            │ - 自动播放     │               │   │
│                            │ - 完成检测     │        ┌──────┴───┤
│                            └───────┬────────┘        │ TTS WS   │
│                                    │                 │:8766     │
│                             voice_assistant:         └──────────┘
│                             playback_ended                       │
│                             state_changed(Idle)                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 数据流说明：

1. **录音阶段**：
   - 用户点击录音 → `start_recording()`
   - 麦克风 → f32 samples → 转 PCM16 (i16) → 640字节帧
   - 发送到 ASR WebSocket (ws://127.0.0.1:8765)
   - ASR 返回 JSON `{ partial, final, confidence }`
   - 前端显示实时转录

2. **思考阶段**：
   - 用户点击停止 → `stop_recording()`
   - ASR 返回 final 转录 → 发射 `state_changed(FinalizingASR)`
   - 前端调用 `stream_llm_response(user_message)`
   - 连接 OpenAI API → 发射 `state_changed(Thinking)`

3. **回复阶段**：
   - LLM 流式返回文本块
   - 每个块发送到 TTS WebSocket (ws://127.0.0.1:8766)
   - TTS 返回 PCM16 音频帧（Binary）
   - 音频帧加入播放队列 → 发射 `state_changed(Speaking)`

4. **完成阶段**：
   - 播放队列清空 → 监控任务检测完成
   - 发射 `playback_ended` + `state_changed(Idle)`
   - 系统回到待机状态

---

## 🚀 端到端测试指南

### 前置条件检查

- [x] Visual Studio C++ build tools 已安装（link.exe 可用）
- [x] Python 虚拟环境已创建（venv 和 venv-tts）
- [x] CUDA 环境已配置（torch 2.4.0+cu124）
- [x] 模型已下载（GLM-ASR-Nano-2512, Qwen3-TTS-12Hz-1.7B）
- [x] OpenAI API Key 已设置（环境变量）
- [x] Rust 编译通过（cargo build 成功）

### 步骤 1: 启动 Python 推理服务

**终端 1 - ASR 服务:**
```bash
cd f:\GitRepository\sisyphus\inference
venv\Scripts\activate
python run_asr.py
# 等待显示: "Server started on ws://127.0.0.1:8765"
```

**终端 2 - TTS 服务:**
```bash
cd f:\GitRepository\sisyphus\inference
venv-tts\Scripts\activate
python run_tts.py
# 等待显示: "Server started on ws://127.0.0.1:8766"
```

### 步骤 2: 设置环境变量

**终端 3 (PowerShell):**
```powershell
cd f:\GitRepository\sisyphus

# 设置 OpenAI API Key
$env:OPENAI_API_KEY = "sk-your-api-key-here"
# 或使用
$env:LLM_API_KEY = "sk-your-api-key-here"
```

### 步骤 3: 启动 Tauri 应用

在同一终端 3 中：
```bash
npm run tauri dev
```

### 步骤 4: 执行测试流程

#### 测试场景 1：基本对话
1. **点击录音按钮**
   - ✅ 状态显示 "Listening"
   - ✅ 音量指示器开始显示波动

2. **说话："你好，今天天气怎么样？"**
   - ✅ 实时显示转录文本（partial）
   - ✅ ASR 识别准确

3. **点击停止按钮**
   - ✅ 显示最终转录文本（final）
   - ✅ 状态变为 "Thinking"
   - ✅ LLM 开始生成响应
   - ✅ 状态变为 "Speaking"
   - ✅ 扬声器播放 TTS 音频
   - ✅ 播放完成后状态回到 "Idle"

#### 测试场景 2：多轮对话
1. 第一轮对话完成后
2. 再次点击录音，进行第二轮对话
3. 验证对话历史是否保持

#### 测试场景 3：错误处理
1. 关闭 ASR 服务，尝试录音
   - ✅ 应显示错误消息
2. 关闭 TTS 服务，尝试对话
   - ✅ 应显示 TTS 连接失败

---

## 📊 统一事件命名规范

| 事件名称 | 触发时机 | 数据结构 | 发射位置 |
|---------|---------|---------|---------|
| `voice_assistant:state_changed` | 状态变化 | `{ state: "Idle" \| "Listening" \| "FinalizingASR" \| "Thinking" \| "Speaking" }` | capture.rs, llm/client.rs, playback.rs |
| `voice_assistant:user_transcript` | ASR 转录 | `{ partial, final_text, confidence }` | capture.rs |
| `voice_assistant:assistant_response` | LLM 响应 | `{ content, is_complete }` | llm/client.rs |
| `voice_assistant:audio_level` | 音量变化 | `{ level }` | capture.rs |
| `voice_assistant:vad_status` | VAD 状态 | `{ status: "speech_start" \| "speech_end" }` | capture.rs |
| `voice_assistant:playback_started` | 播放开始 | `()` | playback.rs |
| `voice_assistant:playback_ended` | 播放结束 | `()` | playback.rs |
| `voice_assistant:error` | 错误发生 | `{ code, message }` | capture.rs, llm/client.rs |

---

## 💡 已知问题和解决方案

### 问题1：Transformers版本冲突 ✅ 已解决
**症状**：GLM-ASR需要transformers 5.x，Qwen3-TTS需要4.57.x
**解决方案**：使用独立虚拟环境
- venv: transformers 5.x（用于ASR）
- venv-tts: transformers 4.57.x（用于TTS）

### 问题2：cpal::Stream 不是 Send ✅ 已解决
**症状**：无法将 Stream 放入 Arc<Mutex<>>
**解决方案**：使用 Box::leak 保持 Stream 存活，通过 AtomicBool 控制状态

### 问题3：async_openai 0.14 API ✅ 已解决
**症状**：类型不存在（ChatCompletionRequestUserMessageArgs等）
**解决方案**：使用正确的 ChatCompletionRequestMessageArgs + Role 构建消息

### 问题4：MutexGuard 跨 await 点 ✅ 已解决
**症状**：future is not Send
**解决方案**：在 await 前释放锁，clone 需要的数据

### 问题5：播放完成检测 ✅ 已解决
**症状**：播放结束后状态不自动回到 Idle
**解决方案**：使用 AtomicBool + 监控任务定期检查队列状态并发射事件

---

## 🔍 调试指南

### 如果 ASR 没有转录：
1. 检查终端 1 是否显示 "Received audio data"
2. 检查麦克风权限（Windows 隐私设置）
3. 使用 `test_asr.py` 独立测试 ASR 服务
4. 查看 capture.rs 是否连接成功（错误日志）

### 如果 TTS 没有声音：
1. 检查终端 2 是否显示 "Received text chunk"
2. 检查扬声器/音频输出设备设置
3. 使用 `test_tts.py` 独立测试 TTS 服务
4. 查看 playback.rs 是否接收到音频数据

### 如果 LLM 失败：
1. 检查环境变量：`echo $env:OPENAI_API_KEY`
2. 检查 API key 是否有效（有余额）
3. 查看控制台错误消息（网络/API错误）
4. 检查 llm/client.rs 日志输出

### 如果编译失败：
1. 清理构建：`cargo clean`
2. 重新构建：`cargo build`
3. 检查 Cargo.toml 依赖版本
4. 查看具体错误信息

---

## 🎯 下一步工作建议

### 优先级 1：实际测试验证
- [ ] 完整测试 ASR → LLM → TTS 流程
- [ ] 测量端到端延迟（目标 < 1秒）
- [ ] 验证多轮对话功能
- [ ] 测试各种错误场景

### 优先级 2：用户体验优化
- [ ] 添加打断功能（说话时停止当前播放）
- [ ] 添加音量可视化增强
- [ ] 添加加载状态指示器
- [ ] 优化状态转换动画

### 优先级 3：错误处理增强
- [ ] WebSocket 自动重连（ASR/TTS）
- [ ] 网络错误友好提示
- [ ] 模型加载失败重试
- [ ] GPU 内存不足降级策略

### 优先级 4：性能优化
- [ ] 安装 flash-attn（提升 TTS 速度 2-3x）
- [ ] 优化音频缓冲区大小
- [ ] 实现音频块批量处理
- [ ] 添加性能监控指标

### 优先级 5：部署和分发
- [ ] 创建 Dockerfile（ASR 服务）
- [ ] 创建 Dockerfile（TTS 服务）
- [ ] 创建 docker-compose.yml
- [ ] 编写部署文档

---

## 📝 新Session指令

在新session中，请告诉AI：

**"读取 F:\GitRepository\sisyphus\PROJECT_CURRENT_STATUS.md，然后继续工作"**

这样AI就能获得完整的项目上下文！

---

## 📊 工作日志摘要

### 2025-02-03（Session 3 - 集成完成）

#### 1. 编译错误修复
- ✅ 修复 `async_openai` 0.14 API 使用（ChatCompletionRequestMessageArgs + Role）
- ✅ 修复 `inference/client.rs` 返回类型嵌套 Result 问题
- ✅ 解决 MutexGuard 跨 await 点问题（clone + 提前释放）
- ✅ 清理未使用的 import 警告

#### 2. ASR 集成实现
**文件**: [src-tauri/src/audio/capture.rs](src-tauri/src/audio/capture.rs)
- ✅ 连接 ASR WebSocket (ws://127.0.0.1:8765)
- ✅ 音频捕获回调 → f32 to i16 PCM 转换
- ✅ 640字节帧发送（20ms @ 16kHz）
- ✅ 接收 JSON 转录结果并发射事件
- ✅ 音量级别计算和发射

**关键实现**：
```rust
// 使用 mpsc channel 桥接同步回调和异步任务
let (audio_tx, audio_rx) = mpsc::unbounded_channel::<Vec<u8>>();

// 音频回调（同步）
move |data: &[f32], _| {
    let pcm_bytes: Vec<u8> = data.iter()
        .flat_map(|&sample| {
            let i16_sample = (sample.max(-1.0).min(1.0) * 32767.0) as i16;
            i16_sample.to_le_bytes()
        })
        .collect();
    let _ = tx.send(pcm_bytes);
}

// ASR 任务（异步）
tauri::async_runtime::spawn(async move {
    run_asr_session(app_handle, audio_rx).await;
});
```

#### 3. TTS 集成实现
**文件**: [src-tauri/src/llm/client.rs](src-tauri/src/llm/client.rs)
- ✅ 连接 TTS WebSocket (ws://127.0.0.1:8766)
- ✅ LLM 流式响应 → 文本块 → TTS
- ✅ 接收 PCM16 音频帧（Binary）
- ✅ 调用 `queue_playback_audio()` 加入播放队列

**关键实现**：
```rust
// LLM 生成 → TTS
for chunk in &chunks {
    let tts_request = TtsRequest {
        request_type: "text_chunk".to_string(),
        text: chunk.content.clone(),
        text_id,
    };
    ws_stream.send(WsMessage::Text(json)).await?;
}

// TTS 返回音频 → 播放队列
while let Some(msg_result) = ws_stream.next().await {
    match msg_result {
        Ok(WsMessage::Binary(audio_data)) => {
            queue_playback_audio(audio_data)?;
        }
        // ...
    }
}
```

#### 4. 状态机协调
**文件**: [src-tauri/src/audio/playback.rs](src-tauri/src/audio/playback.rs)
- ✅ 自动播放触发（缓冲 ≥ 5 帧）
- ✅ 播放完成检测（队列为空 + PLAYING 标志）
- ✅ 监控任务定期检查并发射事件
- ✅ 自动状态转换回 Idle

**关键实现**：
```rust
// 音频回调检测队列为空
if queue.is_empty() && PLAYING.load(Ordering::SeqCst) {
    if !PLAYBACK_COMPLETE_FLAG.swap(true, Ordering::SeqCst) {
        PLAYING.store(false, Ordering::SeqCst);
    }
}

// 监控任务发射事件
tauri::async_runtime::spawn(async move {
    loop {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if PLAYBACK_COMPLETE_FLAG.load(Ordering::SeqCst) {
            let _ = app.emit("voice_assistant:playback_ended", ());
            let _ = app.emit("voice_assistant:state_changed",
                serde_json::json!({ "state": "Idle" }));
            break;
        }
    }
});
```

#### 5. 前端事件更新
**文件**: [src/components/VoiceAssistant.tsx](src/components/VoiceAssistant.tsx)
- ✅ 统一 `voice_assistant:` 前缀命名空间
- ✅ 添加音量可视化组件
- ✅ 更新所有事件监听器

#### 6. 应用初始化
**文件**: [src-tauri/src/lib.rs](src-tauri/src/lib.rs)
- ✅ 添加 `init_playback()` 在 setup 钩子中初始化
- ✅ 传递 AppHandle 用于播放完成事件发射

---

### 2025-02-01（Session 2）
1. **CUDA环境搭建**
   - 安装Visual C++ Redistributable
   - 安装PyTorch 2.4.0+cu124（CUDA 12.4）
   - 验证CUDA可用性

2. **模型配置和优化**
   - 创建inference/models.yaml
   - 更新asr_service.py（CUDA检测、FP16、KV cache、config加载）
   - 更新tts_service.py（双模型支持、语音切换、CUDA优化）

3. **独立运行脚本创建**
   - 创建run_asr.py（ASR独立入口）
   - 创建run_tts.py（TTS独立入口）
   - 创建start_both.bat（批量启动）

4. **TTS独立环境搭建**
   - 创建venv-tts（transformers 4.57.x + qwen-tts）
   - 解决NumPy版本冲突（numpy<2）
   - 解决onnxruntime DLL问题（降级到CPU版本）

5. **WebSocket通信问题诊断和修复**
   - 问题：原始test_tts.py超时太短（1.0s），音频接收不完整
   - 诊断：创建test_diagnose.py，确认通信正常（3.4s接收87帧，0.62秒"test"语音）
   - 修复：增加超时到2.0s，修改超时行为为continue（不break）
   - 修复：删除bytes.tobytes()调用（audio_data已是bytes类型）

6. **文档更新**
   - 更新README.md（CUDA设置、模型依赖、性能基准）
   - 创建docs/MODELS.md（models.yaml示例、双环境运行说明）
   - 创建.env.example

---

## 🎉 项目里程碑

- ✅ **2025-02-01**: Python 推理服务完成（ASR + TTS）
- ✅ **2025-02-03**: Rust 后端集成完成（ASR + LLM + TTS）
- ✅ **2025-02-03**: 前后端完全打通，可以进行端到端测试
- 📍 **下一步**: 实际测试验证和性能优化

---

## 📈 技术架构总结

### 核心技术栈
- **前端**: React 18 + TypeScript + Zustand + Tauri v2
- **后端**: Rust + Tokio + cpal + async-openai
- **推理**: Python + PyTorch 2.4.0 + CUDA 12.4 + transformers
- **通信**: WebSocket (tokio-tungstenite + websockets)
- **音频**: PCM16 @ 16kHz mono

### 关键设计决策
1. **双虚拟环境**: 解决 transformers 版本冲突
2. **Box::leak Stream**: 解决 cpal Stream 不是 Send 的问题
3. **mpsc channel**: 桥接同步音频回调和异步 WebSocket
4. **监控任务**: 检测播放完成并发射事件
5. **统一事件命名**: voice_assistant: 前缀命名空间

### 性能目标（待测量）
- ASR 延迟: < 500ms
- LLM 延迟: < 1000ms（取决于 OpenAI API）
- TTS 延迟: < 300ms
- 端到端: < 2000ms（理想 < 1000ms）

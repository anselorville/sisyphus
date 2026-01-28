
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

### Phase 3: Rust后端组件
- [x] 依赖配置（tokio, tokio-tungstenite, serde, async-openai, cpal, anyhow）
- [x] 音频捕获+ VAD（audio/capture.rs）
- [x] WebSocket客户端（inference/client.rs）
- [x] 音频播放（audio/playback.rs）
- [x] 对话状态机（conversation/state.rs）
- [x] LLM流式客户端（llm/client.rs）
- [x] Tauri命令集成

### Phase 4: React前端
- [x] Zustand状态管理安装
- [x] VoiceAssistant组件实现
- [x] Tauri事件/命令集成

### Phase 5: 文档
- [x] README.md创建（架构、安装、使用说明）
- [x] .gitignore更新

---

## 📂 当前文件结构

```
sisyphus/
├── .env.example                    # 环境变量模板
├── .gitignore
├── PROJECT_CONTEXT.md             # 本文档（需要手动创建）
├── README.md                        # 主文档
├── docs/
│   └── MODELS.md                 # 模型文档（待创建）
├── inference/
│   ├── venv/                      # Python虚拟环境
│   ├── requirements.txt              # 依赖列表
│   ├── models.yaml                # 模型配置（待创建）
│   ├── voices/                    # 语音参考（待创建）
│   ├── voice_manager.py           # 语音管理（待创建）
│   ├── asr_service.py              # ASR服务（待CUDA优化）
│   ├── tts_service.py              # TTS服务（待CUDA优化）
│   └── run_inference.py           # 编排脚本（待更新）
├── src-tauri/
│   ├── Cargo.toml
│   ├── src/
│   │   ├── audio/
│   │   │   ├── capture.rs
│   │   │   ├── playback.rs
│   │   │   └── mod.rs
│   │   ├── conversation/
│   │   │   ├── state.rs
│   │   │   └── mod.rs
│   │   ├── inference/
│   │   │   └── client.rs
│   │   ├── llm/
│   │   │   ├── client.rs
│   │   │   └── mod.rs
│   │   └── lib.rs
│   └── tauri.conf.json
└── src/
    ├── components/
    │   └── VoiceAssistant.tsx
    ├── App.tsx
    ├── App.css
    ├── main.tsx
    └── vite-env.d.ts
```

---

## 🚀 继续执行计划

### 阻塞问题
**当前状态**：Visual C++ Redistributable需要手动安装，PyTorch无法加载CUDA运行时

### 下一步（按顺序）

#### Step 1: 手动安装Visual C++ Redistributable
- 下载地址：https://aka.ms/vs/17/release/vc_redist.x64.exe
- 运行安装程序
- 重启计算机（如需要）

#### Step 2: 安装PyTorch 2.4.0 (CUDA 12.6)
- 命令：`cd inference/venv/Scripts && pip install torch==2.4.0 torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124`
- 验证：`python -c "import torch; print('CUDA:', torch.cuda.is_available())"`

#### Step 3: 更新requirements.txt
- 移除torch版本限制
- 添加：`pyyaml>=6.0`

#### Step 4: 创建models.yaml
- ASR路径：F:\\GitRepository\GLM-ASR-Nano-2512
- TTS Base路径：F:\\GitRepository\Qwen3-TTS-12Hz-1.7B-Base
- TTS Custom路径：F:\\GitRepository\Qwen3-TTS-12Hz-1.7B-CustomVoice
- 设备：auto
- FP16：true
- 默认语音：custom_voice

#### Step 5: 优化ASR服务
- 加载配置（models.yaml）
- CUDA设备检测
- FP16优化（torch.cuda.amp.autocast）
- KV缓存启用

#### Step 6: 优化TTS服务
- 加载配置
- 语音切换（base/custom）
- SpeechTokenizer加载（custom voice）
- CUDA优化

#### Step 7: 创建voice_manager.py
- 语音引用管理
- 克隆/list/删除命令

#### Step 8: 更新orchestration
- 配置加载显示
- CUDA状态输出
- 内存监控

#### Step 9: 创建.env.example
- 所有环境变量文档

#### Step 10: 更新文档
- CUDA设置说明
- 模型配置指南
- 性能基准

---

## 💡 内存管理策略

**确认方案**：启动时加载两个模型（~8GB总内存）
- ASR：4GB + overhead
- TTS Custom：3.6GB
- 剩余：~3.6GB（在11.6GB系统中应该舒适）

**如果内存不足**：
- 策略A：仅加载ASR，TTS按需加载
- 策略B：卸载不需要的模型，降低内存占用

---

## 🎯 预期性能提升

| 组件 | 当前（CPU） | CUDA 12.6 | 提升 |
|--------|--------------|-----------|-----|
| ASR推理 | ~3.5s | ~200-500ms | **6-25x** |
| TTS合成 | ~2.3s | ~100-200ms | **10-23x** |
| 语音克隆 | N/A | ~300-500ms | **新功能** |
| 总流水线 | ~5.8s | ~400-700ms | **10-15x** |

---

## 🔍 故障排查

### 问题：PyTorch CUDA DLL加载失败
**症状**：`ImportError: DLL load failed while importing _C`
**原因**：缺少Visual C++ Redistributable 2015-2022
**解决**：安装vc_redist.x64.exe

### 问题：CUDA可用但未使用
**症状**：torch.cuda.is_available()返回False
**解决**：1. 验证PyTorch CUDA版本安装；2. 检查NVIDIA驱动

---

## ✅ 检查清单

在新session中继续前，请确认：

- [ ] Visual C++ Redistributable已安装
- [ ] PyTorch 2.4.0 CUDA版本已安装
- [ ] CUDA检测返回True
- [ ] models.yaml创建完成
- [ ] ASR服务CUDA优化完成
- [ ] TTS服务CUDA+语音克隆完成
- [ ] 所有服务启动正常

---

## 📝 新Session指令

在新session中，请告诉AI：

**"读取F:\GitRepository\sisyphus\PROJECT_CONTEXT.md，然后继续执行Step 1"**

这样AI就能获得完整的项目上下文并继续CUDA实现工作！


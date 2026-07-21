# Inference Services

本目录包含 ASR（语音识别）和 TTS（语音合成）推理服务。

> **Note**: 本项目基于 Windows 系统开发。

## 目录结构

```
inference/
├── venv-asr/          # ASR 服务虚拟环境
├── venv-tts/          # TTS 服务虚拟环境
├── asr_service.py     # ASR WebSocket 服务
├── tts_service.py     # TTS WebSocket 服务
├── models.yaml        # 模型配置文件
└── requirements-*.txt # 依赖文件
```

## 环境配置

### TTS 服务

创建虚拟环境并安装依赖：
```cmd
python -m venv inference\venv-tts
inference\venv-tts\Scripts\activate.bat
pip install -r inference\requirements-tts.txt
```

### ASR 服务

创建虚拟环境并安装依赖：
```cmd
python -m venv inference\venv-asr
inference\venv-asr\Scripts\activate.bat
pip install -r inference\requirements-asr.txt
```

## 启动服务

### 启动 TTS 服务

服务将在 `ws://127.0.0.1:8766` 启动：
```cmd
inference\venv-tts\Scripts\activate.bat
python inference\run_tts.py
```

### 启动 ASR 服务

服务将在 `ws://127.0.0.1:8765` 启动：
```cmd
inference\venv-asr\Scripts\activate.bat
python inference\run_asr.py
```

### 同时启动两个服务

```cmd
inference\start_both.bat
```

## 测试服务

### 测试 TTS 服务

```cmd
inference\venv-tts\Scripts\activate.bat
python inference\test_tts.py
```

### 测试 ASR 服务

```cmd
inference\venv-asr\Scripts\activate.bat
python inference\test_asr.py
```

## 配置说明

编辑 `models.yaml` 配置模型路径和参数：

```yaml
asr:
  model_path: "path/to/asr/model"
  device: auto
  fp16: true

tts:
  base_model_path: "path/to/tts/base/model"
  custom_model_path: "path/to/tts/custom/model"
  device: auto
  fp16: true
  default_voice: custom_voice
```

## 服务端口

| 服务 | 端口 | 协议 |
|------|------|------|
| ASR  | 8765 | WebSocket |
| TTS  | 8766 | WebSocket |

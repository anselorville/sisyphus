# 环境变量配置指南

本项目使用 `.env` 文件统一管理全局变量配置。

## 📋 配置项说明

### LLM API 配置

支持任何 OpenAI-compatible API（OpenAI、Azure OpenAI、本地部署等）

```env
# API Key（必需）
LLM_API_KEY=sk-your-api-key-here

# Base URL（可选，默认为 OpenAI API）
LLM_BASE_URL=https://api.openai.com/v1

# 模型名称（可选，默认为 gpt-3.5-turbo）
LLM_MODEL=gpt-3.5-turbo
```

**兼容模式**：
- 如果设置了 `OPENAI_API_KEY`，会被 `LLM_API_KEY` 覆盖
- 这样可以兼容旧的环境变量配置

### ASR/TTS 模型配置

```env
# ASR 模型
GLM_ASR_MODEL=THUDM/glm-4-voice-9b

# TTS 模型
QWEN_TTS_MODEL=Qwen/Qwen2.5-1.5B-Instruct
```

### 推理服务配置

```env
# ASR 服务地址
ASR_HOST=127.0.0.1
ASR_PORT=8765

# TTS 服务地址
TTS_HOST=127.0.0.1
TTS_PORT=8766
```

### CUDA 配置

```env
# 指定使用的 GPU 设备
CUDA_VISIBLE_DEVICES=0
```

---

## 🚀 使用示例

### 1. OpenAI 官方 API

```env
LLM_API_KEY=sk-xxx
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-3.5-turbo
```

### 2. Azure OpenAI

```env
LLM_API_KEY=your-azure-key
LLM_BASE_URL=https://your-resource.openai.azure.com/openai/deployments/your-deployment
LLM_MODEL=gpt-35-turbo
```

### 3. 本地部署（Ollama、vLLM 等）

```env
LLM_API_KEY=dummy-key  # 某些本地服务不需要真实 key
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=llama2
```

### 4. 国内 API（智谱、月之暗面等）

```env
# 智谱 GLM
LLM_API_KEY=your-glm-key
LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
LLM_MODEL=glm-4

# 月之暗面 Kimi
LLM_API_KEY=your-kimi-key
LLM_BASE_URL=https://api.moonshot.cn/v1
LLM_MODEL=moonshot-v1-8k
```

---

## 🔧 技术实现

### Rust 端 (Tauri)

使用 `dotenvy` crate 加载 .env 文件：

```rust
// src-tauri/src/lib.rs
use dotenvy::dotenv;

pub fn run() {
    // 加载 .env 文件
    if let Err(e) = dotenv() {
        eprintln!("Warning: Failed to load .env file: {}", e);
    }

    // 后续代码...
}
```

```rust
// src-tauri/src/llm/client.rs
use async_openai::config::OpenAIConfig;
use std::env;

impl LlmClient {
    pub fn new() -> Result<Self> {
        // 读取环境变量
        let api_key = env::var("LLM_API_KEY")
            .or_else(|_| env::var("OPENAI_API_KEY"))?;

        let base_url = env::var("LLM_BASE_URL")
            .unwrap_or_else(|_| "https://api.openai.com/v1".to_string());

        let model = env::var("LLM_MODEL")
            .unwrap_or_else(|_| "gpt-3.5-turbo".to_string());

        // 配置 OpenAI 客户端
        let config = OpenAIConfig::default()
            .with_api_key(api_key)
            .with_api_base(base_url);

        let client = Client::with_config(config);

        Ok(Self { client, model })
    }
}
```

### Python 端

使用 `python-dotenv` 包加载 .env 文件：

```python
# inference/llm_client_example.py
import os
from dotenv import load_dotenv
from openai import OpenAI

# 加载 .env 文件
load_dotenv()

# 读取环境变量
API_KEY = os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY")
BASE_URL = os.getenv("LLM_BASE_URL", "https://api.openai.com/v1")
MODEL = os.getenv("LLM_MODEL", "gpt-3.5-turbo")

# 创建客户端
client = OpenAI(
    api_key=API_KEY,
    base_url=BASE_URL
)

# 发送请求
response = client.chat.completions.create(
    model=MODEL,
    messages=[{"role": "user", "content": "Hello"}],
    stream=True
)
```

---

## 📦 依赖安装

### Rust

已在 `Cargo.toml` 中添加：

```toml
dotenvy = "0.15"
async-openai = "0.14"
```

### Python

已在 `requirements-asr.txt` 和 `requirements-tts.txt` 中添加：

```txt
python-dotenv>=1.0.0
openai>=1.0.0
```

安装依赖：

```bash
# ASR 环境
cd inference
venv\Scripts\activate
pip install -r requirements-asr.txt

# TTS 环境
cd inference
venv-tts\Scripts\activate
pip install -r requirements-tts.txt
```

---

## ⚠️ 注意事项

### 1. .env 文件位置

- `.env` 文件应放在项目根目录（`F:\GitRepository\sisyphus\.env`）
- Rust 会自动从当前工作目录或父目录查找 .env 文件
- Python 需要确保 `load_dotenv()` 在读取环境变量之前调用

### 2. 安全性

- ⚠️ **永远不要提交 .env 文件到 Git！**
- `.env` 已添加到 `.gitignore`
- 使用 `.env.example` 作为模板

### 3. 环境变量优先级

1. 系统环境变量
2. .env 文件中的变量
3. 代码中的默认值

### 4. OpenAI 包版本

Python 端使用 `openai>=1.0.0`（新版 API）：
- ✅ 支持 OpenAI-compatible API
- ✅ 无需 `tiktoken` 包
- ✅ 简化的 API 接口

---

## 🧪 测试配置

### 测试 Rust 配置

```bash
cd src-tauri

# 设置环境变量
$env:LLM_API_KEY = "your-key"
$env:LLM_BASE_URL = "https://api.openai.com/v1"
$env:LLM_MODEL = "gpt-3.5-turbo"

# 编译测试
cargo build
```

### 测试 Python 配置

```bash
cd inference

# 激活环境
venv\Scripts\activate

# 运行示例
python llm_client_example.py
```

---

## 📝 常见问题

### Q: 如何使用本地 LLM？

A: 设置 `LLM_BASE_URL` 指向本地服务，例如：

```env
LLM_BASE_URL=http://localhost:11434/v1  # Ollama
LLM_MODEL=llama2
```

### Q: 为什么不使用 tiktoken？

A:
- tiktoken 仅用于 token 计数，对 LLM 调用不是必需的
- OpenAI-compatible API 通常不需要本地 token 计数
- 减少依赖，简化部署

### Q: 如何切换不同的 API 提供商？

A: 只需修改 `.env` 中的三个配置项：

```env
LLM_API_KEY=new-key
LLM_BASE_URL=new-base-url
LLM_MODEL=new-model
```

重启应用即可生效。

---

## 🔗 相关文档

- [OpenAI API 文档](https://platform.openai.com/docs/api-reference)
- [async-openai Rust crate](https://docs.rs/async-openai/)
- [python-dotenv 文档](https://pypi.org/project/python-dotenv/)
- [OpenAI Python SDK](https://github.com/openai/openai-python)

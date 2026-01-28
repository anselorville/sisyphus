# Sisyphus Voice Assistant

A desktop voice assistant built with Tauri, Rust, React, and local GLM-ASR/Qwen3-TTS models.

## Overview

This project implements a voice assistant with sub-500ms response latency, real-time streaming, and interruption support.

## Architecture

- **Rust Backend**: Audio capture, playback, WebSocket clients, LLM streaming, conversation state management
- **Python Inference**: ASR and TTS WebSocket services with local models
- **React Frontend**: UI for conversation display and status indication

## Prerequisites

- **Rust**: 1.93.0 or later
- **Node.js**: 22.17.1 or later
- **Python**: 3.11.5 or later
- **Windows**: Microsoft Visual C++ Build Tools (for Rust compilation)

## Installation

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd sisyphus
   ```

2. **Install Python dependencies**:
   ```bash
   cd inference
   python -m venv venv
   
   # Windows:
   venv\Scripts\activate
   # Linux/Mac:
   source venv/bin/activate
   
   pip install -r requirements.txt
   ```

3. **Install Node.js dependencies**:
   ```bash
   npm install
   ```

4. **Build Rust backend**:
   ```bash
   cd src-tauri
   cargo build
   ```

## Usage

1. **Start Python inference services**:
   ```bash
   cd inference
   python run_inference.py
   ```

2. **Start Tauri application**:
   ```bash
   npm run tauri dev
   ```

## Configuration

Set the following environment variables:

- `OPENAI_API_KEY` or `LLM_API_KEY`: OpenAI-compatible API key for LLM
- `GLM_ASR_MODEL`: Path to GLM-ASR model (optional, defaults to HuggingFace)
- `QWEN_TTS_MODEL`: Path to Qwen-TTS model (optional, defaults to HuggingFace)

## Development

- **Backend code**: `src-tauri/src/`
- **Inference code**: `inference/`
- **Frontend code**: `src/`

## Features

- Real-time speech recognition (GLM-ASR)
- Streaming text-to-speech (Qwen3-TTS)
- OpenAI-compatible LLM integration
- Voice activity detection
- Audio buffering and playback
- Conversation history management
- Interruption support (barge-in)

## License

MIT

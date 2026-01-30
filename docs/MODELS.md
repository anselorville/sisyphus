# Models Configuration

## models.yaml

Create `inference/models.yaml` to point to local models and control CUDA settings.

Example:

```yaml
asr:
  model_path: "F:\\GitRepository\\GLM-ASR-Nano-2512"
  device: auto
  fp16: true
  kv_cache: true

tts:
  base_model_path: "F:\\GitRepository\\Qwen3-TTS-12Hz-1.7B-Base"
  custom_model_path: "F:\\GitRepository\\Qwen3-TTS-12Hz-1.7B-CustomVoice"
  device: auto
  fp16: true
  default_voice: custom_voice
  default_language: Auto
  default_speaker: Vivian
  attn_implementation: null
```

## Voice references

Use `inference/voice_manager.py` to manage voice references.

```bash
python inference/voice_manager.py list
python inference/voice_manager.py clone --name my_voice --source "F:\\path\\to\\voice"
python inference/voice_manager.py delete --name my_voice
```

## Runtime dependencies

```bash
# ASR env (transformers 5.x)
pip install git+https://github.com/huggingface/transformers

# TTS env (transformers 4.57.x)
pip install -r inference/requirements-tts.txt
```

## Running ASR + TTS with separate environments

Set `TTS_PYTHON` to the Python executable of the TTS virtual environment,
then start the orchestrator.

```bash
set TTS_PYTHON=F:\\GitRepository\\sisyphus\\inference\\venv-tts\\Scripts\\python.exe
python inference/run_inference.py
```

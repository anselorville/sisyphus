#!/usr/bin/env python
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from asr_service import ASRService

async def main():
    import yaml
    
    config_path = os.path.join(os.path.dirname(__file__), "models.yaml")
    config = {}
    if os.path.exists(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            config = yaml.safe_load(f) or {}
    
    asr_config = config.get("asr", {})
    host = asr_config.get("host", "127.0.0.1")
    port = asr_config.get("port", 8765)
    
    print(f"Starting ASR service on {host}:{port}")
    service = ASRService(host=host, port=port)
    await service.start()

if __name__ == "__main__":
    asyncio.run(main())

import asyncio
import os
import signal
import sys

import yaml

from asr_service import ASRService
from tts_service import TTSService

class InferenceOrchestrator:
    def __init__(self):
        self.asr_service = None
        self.tts_service = None
        self.tts_process = None
        self.shutdown_event = asyncio.Event()
        self.memory_task = None
        
        self.setup_signal_handlers()
    
    def setup_signal_handlers(self):
        signal.signal(signal.SIGINT, self.handle_shutdown)
        signal.signal(signal.SIGTERM, self.handle_shutdown)
        
        if sys.platform == "win32":
            signal.signal(signal.SIGBREAK, self.handle_shutdown)
    
    def handle_shutdown(self, signum, frame):
        print(f"\nReceived signal {signum}, shutting down gracefully...")
        self.shutdown_event.set()

    def load_models_config(self) -> dict:
        config_path = os.path.join(os.path.dirname(__file__), "models.yaml")
        if not os.path.exists(config_path):
            return {}
        with open(config_path, "r", encoding="utf-8") as handle:
            return yaml.safe_load(handle) or {}

    def print_config_summary(self, config: dict) -> None:
        if not config:
            print("models.yaml not found, using defaults")
            return
        print("Loaded models.yaml")
        asr = config.get("asr", {})
        tts = config.get("tts", {})
        print(
            "ASR model: "
            f"{asr.get('model_path', 'default')} | "
            f"device={asr.get('device', 'auto')} | "
            f"fp16={asr.get('fp16', True)}"
        )
        print(
            "TTS base: "
            f"{tts.get('base_model_path', 'default')} | "
            f"custom: {tts.get('custom_model_path', 'default')} | "
            f"device={tts.get('device', 'auto')} | "
            f"fp16={tts.get('fp16', True)} | "
            f"default_voice={tts.get('default_voice', 'custom_voice')}"
        )

    def print_cuda_status(self) -> bool:
        try:
            import torch

            available = torch.cuda.is_available()
            print(
                "CUDA: "
                f"available={available} | "
                f"torch={torch.__version__} | "
                f"cuda={torch.version.cuda}"
            )
            return available
        except Exception as e:
            print(f"CUDA status check failed: {e}")
            return False

    async def monitor_cuda_memory(self):
        import torch

        while not self.shutdown_event.is_set():
            try:
                if torch.cuda.is_available():
                    free, total = torch.cuda.mem_get_info()
                    allocated = torch.cuda.memory_allocated()
                    reserved = torch.cuda.memory_reserved()
                    mib = 1024 * 1024
                    print(
                        "CUDA memory | "
                        f"allocated={allocated // mib} MiB | "
                        f"reserved={reserved // mib} MiB | "
                        f"free={free // mib} MiB | "
                        f"total={total // mib} MiB"
                    )
            except Exception as e:
                print(f"CUDA memory check failed: {e}")
            await asyncio.sleep(30)
    
    async def start_asr_service(self):
        self.asr_service = ASRService()
        try:
            await self.asr_service.start()
        except asyncio.CancelledError:
            print("ASR service cancelled")
    
    async def start_tts_service(self):
        tts_python = os.environ.get("TTS_PYTHON")
        if tts_python:
            tts_script = os.path.join(os.path.dirname(__file__), "tts_service.py")
            print(f"Starting TTS service via external Python: {tts_python}")
            try:
                self.tts_process = await asyncio.create_subprocess_exec(
                    tts_python,
                    tts_script,
                    stdout=sys.stdout,
                    stderr=sys.stderr,
                )
                await self.tts_process.wait()
            except asyncio.CancelledError:
                print("TTS service cancelled")
        else:
            self.tts_service = TTSService()
            try:
                await self.tts_service.start()
            except asyncio.CancelledError:
                print("TTS service cancelled")
    
    async def run(self):
        print("Starting Inference Services Orchestrator")
        print("=" * 50)

        config = self.load_models_config()
        self.print_config_summary(config)
        cuda_available = self.print_cuda_status()
        if cuda_available:
            self.memory_task = asyncio.create_task(self.monitor_cuda_memory())
        
        tasks = [
            asyncio.create_task(self.start_asr_service()),
            asyncio.create_task(self.start_tts_service())
        ]
        
        try:
            print("Waiting for shutdown signal (Ctrl+C)...")
            await self.shutdown_event.wait()
            
            print("Cancelling service tasks...")
            for task in tasks:
                task.cancel()

            if self.memory_task:
                self.memory_task.cancel()

            if self.tts_process and self.tts_process.returncode is None:
                self.tts_process.terminate()
            
            results = await asyncio.gather(*tasks, return_exceptions=True)
            
            for i, result in enumerate(results):
                if isinstance(result, Exception):
                    print(f"Service {i} error during shutdown: {result}")
            
            print("All services stopped")
            
        except Exception as e:
            print(f"Orchestrator error: {e}")
            for task in tasks:
                task.cancel()

async def main():
    orchestrator = InferenceOrchestrator()
    await orchestrator.run()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nKeyboard interrupt received")
    except Exception as e:
        print(f"Fatal error: {e}")
        sys.exit(1)

import asyncio
import signal
import sys
from asr_service import ASRService
from tts_service import TTSService

class InferenceOrchestrator:
    def __init__(self):
        self.asr_service = None
        self.tts_service = None
        self.shutdown_event = asyncio.Event()
        
        self.setup_signal_handlers()
    
    def setup_signal_handlers(self):
        signal.signal(signal.SIGINT, self.handle_shutdown)
        signal.signal(signal.SIGTERM, self.handle_shutdown)
        
        if sys.platform == "win32":
            signal.signal(signal.SIGBREAK, self.handle_shutdown)
    
    def handle_shutdown(self, signum, frame):
        print(f"\nReceived signal {signum}, shutting down gracefully...")
        self.shutdown_event.set()
    
    async def start_asr_service(self):
        self.asr_service = ASRService()
        try:
            await self.asr_service.start()
        except asyncio.CancelledError:
            print("ASR service cancelled")
    
    async def start_tts_service(self):
        self.tts_service = TTSService()
        try:
            await self.tts_service.start()
        except asyncio.CancelledError:
            print("TTS service cancelled")
    
    async def run(self):
        print("Starting Inference Services Orchestrator")
        print("=" * 50)
        
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

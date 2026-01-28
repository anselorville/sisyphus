import asyncio
import websockets
import json
import numpy as np
from typing import Optional

class ASRService:
    def __init__(self, host: str = "127.0.0.1", port: int = 8765):
        self.host = host
        self.port = port
        self.model = None
        self.processor = None
        self.sample_rate = 16000
        self.frame_size = 640
        self.accumulated_audio = []
        self.window_duration = 2.5
        self.overlap_duration = 0.5
        self.overlap_samples = int(self.sample_rate * self.overlap_duration)
        
    async def load_model(self):
        try:
            from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor
            
            model_name = "THUDM/glm-asr-nano-2512"
            print(f"Loading ASR model: {model_name}")
            
            self.processor = AutoProcessor.from_pretrained(model_name)
            self.model = AutoModelForSpeechSeq2Seq.from_pretrained(model_name)
            
            import torch
            device = "cuda" if torch.cuda.is_available() else "cpu"
            self.model.to(device)
            
            print(f"ASR model loaded successfully on {device}")
            return True
        except Exception as e:
            print(f"Error loading ASR model: {e}")
            print("Using fallback mock transcription")
            return False
    
    def pcm16_to_float32(self, pcm_data: bytes) -> np.ndarray:
        pcm_array = np.frombuffer(pcm_data, dtype=np.int16)
        return pcm_array.astype(np.float32) / 32768.0
    
    async def transcribe(self, audio_array: np.ndarray) -> dict:
        if self.model is None or self.processor is None:
            return {
                "partial": "",
                "final": "[Mock transcription: model not loaded]",
                "confidence": 0.0
            }
        
        try:
            import torch
            
            inputs = self.processor(audio_array, sampling_rate=self.sample_rate, return_tensors="pt")
            input_features = inputs.input_features.to(self.model.device)
            
            with torch.no_grad():
                predicted_ids = self.model.generate(input_features)
            
            transcription = self.processor.batch_decode(predicted_ids, skip_special_tokens=True)[0]
            
            return {
                "partial": "",
                "final": transcription,
                "confidence": 0.95
            }
        except Exception as e:
            print(f"Transcription error: {e}")
            return {
                "partial": "",
                "final": "[Transcription error]",
                "confidence": 0.0
            }
    
    async def process_audio_frame(self, audio_data: bytes) -> Optional[dict]:
        audio_float = self.pcm16_to_float32(audio_data)
        self.accumulated_audio.extend(audio_float)
        
        window_samples = int(self.sample_rate * self.window_duration)
        
        if len(self.accumulated_audio) >= window_samples:
            audio_window = np.array(self.accumulated_audio[:window_samples])
            
            if self.overlap_samples > 0:
                self.accumulated_audio = self.accumulated_audio[window_samples - self.overlap_samples:]
            else:
                self.accumulated_audio = []
            
            result = await self.transcribe(audio_window)
            result["type"] = "asr_result"
            return result
        
        return None
    
    async def handle_connection(self, websocket):
        print(f"New ASR connection from {websocket.remote_address}")
        
        try:
            async for message in websocket:
                if isinstance(message, bytes):
                    result = await self.process_audio_frame(message)
                    if result:
                        await websocket.send(json.dumps(result))
                elif isinstance(message, str):
                    control = json.loads(message)
                    if control.get("type") == "reset":
                        self.accumulated_audio = []
                        print("Audio buffer reset")
        except websockets.exceptions.ConnectionClosed:
            print(f"ASR connection closed: {websocket.remote_address}")
        except Exception as e:
            print(f"ASR connection error: {e}")
    
    async def start(self):
        print(f"Starting ASR WebSocket server on {self.host}:{self.port}")
        
        await self.load_model()
        
        async with websockets.serve(self.handle_connection, self.host, self.port):
            print(f"ASR server is running on ws://{self.host}:{self.port}")
            await asyncio.Future()

async def main():
    service = ASRService()
    await service.start()

if __name__ == "__main__":
    asyncio.run(main())

import asyncio
import websockets
import json
import numpy as np
from typing import Optional

class TTSService:
    def __init__(self, host: str = "127.0.0.1", port: int = 8766):
        self.host = host
        self.port = port
        self.model = None
        self.sample_rate = 16000
        self.target_sample_rate = 16000
        self.frame_size = 640
        
    async def load_model(self):
        try:
            from transformers import VitsModel, AutoTokenizer
            
            model_name = "Qwen/Qwen-Audio-TTS"
            print(f"Loading TTS model: {model_name}")
            
            self.model = VitsModel.from_pretrained(model_name)
            self.tokenizer = AutoTokenizer.from_pretrained(model_name)
            
            import torch
            device = "cuda" if torch.cuda.is_available() else "cpu"
            self.model.to(device)
            
            print(f"TTS model loaded successfully on {device}")
            return True
        except Exception as e:
            print(f"Error loading TTS model: {e}")
            print("Using fallback mock TTS generation")
            return False
    
    def float32_to_pcm16(self, audio_array: np.ndarray) -> bytes:
        audio_int16 = np.clip(audio_array * 32767, -32768, 32767).astype(np.int16)
        return audio_int16.tobytes()
    
    async def synthesize(self, text: str) -> np.ndarray:
        if self.model is None:
            return np.zeros(int(self.sample_rate * 0.5))
        
        try:
            import torch
            
            inputs = self.tokenizer(text, return_tensors="pt")
            input_ids = inputs["input_ids"].to(self.model.device)
            
            with torch.no_grad():
                output = self.model(input_ids=input_ids)
            
            audio_waveform = output.waveform[0].cpu().numpy()
            
            if hasattr(output, 'sampling_rate') and output.sampling_rate != self.target_sample_rate:
                import librosa
                audio_waveform = librosa.resample(
                    audio_waveform,
                    orig_sr=output.sampling_rate,
                    target_sr=self.target_sample_rate
                )
            
            return audio_waveform
        except Exception as e:
            print(f"TTS synthesis error: {e}")
            return np.zeros(int(self.sample_rate * 0.5))
    
    async def process_text_chunk(self, text: str, text_id: int) -> list[bytes]:
        audio_waveform = await self.synthesize(text)
        
        audio_pcm16 = self.float32_to_pcm16(audio_waveform)
        
        frames = []
        for i in range(0, len(audio_pcm16), self.frame_size):
            frame = audio_pcm16[i:i+self.frame_size]
            if len(frame) < self.frame_size:
                frame += b'\x00' * (self.frame_size - len(frame))
            frames.append(frame)
        
        return frames
    
    async def handle_connection(self, websocket):
        print(f"New TTS connection from {websocket.remote_address}")
        
        try:
            async for message in websocket:
                if isinstance(message, str):
                    control = json.loads(message)
                    
                    if control.get("type") == "text_chunk":
                        text = control.get("text", "")
                        text_id = control.get("text_id", 0)
                        
                        frames = await self.process_text_chunk(text, text_id)
                        
                        for frame in frames:
                            await websocket.send(frame)
                            
                    elif control.get("type") == "flush":
                        pass
                        
        except websockets.exceptions.ConnectionClosed:
            print(f"TTS connection closed: {websocket.remote_address}")
        except Exception as e:
            print(f"TTS connection error: {e}")
    
    async def start(self):
        print(f"Starting TTS WebSocket server on {self.host}:{self.port}")
        
        await self.load_model()
        
        async with websockets.serve(self.handle_connection, self.host, self.port):
            print(f"TTS server is running on ws://{self.host}:{self.port}")
            await asyncio.Future()

async def main():
    service = TTSService()
    await service.start()

if __name__ == "__main__":
    asyncio.run(main())

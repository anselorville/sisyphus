import asyncio
import websockets
import json
import numpy as np
import time

async def test_asr_service():
    uri = "ws://127.0.0.1:8765"
    
    try:
        async with websockets.connect(uri) as websocket:
            print(f"Connected to ASR service at {uri}")
            
            sample_rate = 16000
            duration = 3.0
            num_samples = int(sample_rate * duration)
            
            t = np.linspace(0, duration, num_samples, False)
            audio_float = np.sin(2 * np.pi * 440 * t) * 0.3
            
            audio_pcm16 = (audio_float * 32767).astype(np.int16)
            
            frame_size = 640
            frames = [audio_pcm16[i:i+frame_size].tobytes() for i in range(0, len(audio_pcm16), frame_size)]
            
            print(f"Sending {len(frames)} audio frames ({duration}s of audio)...")
            
            for i, frame in enumerate(frames):
                if len(frame) < frame_size:
                    frame += b'\x00' * (frame_size - len(frame))
                
                await websocket.send(frame)
                print(f"Sent frame {i+1}/{len(frames)}")
                await asyncio.sleep(0.02)
            
            print("All frames sent, waiting for responses...")
            
            responses = []
            timeout_seconds = 10
            start_time = time.time()
            
            while time.time() - start_time < timeout_seconds:
                try:
                    response = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                    result = json.loads(response)
                    responses.append(result)
                    
                    if result.get("final"):
                        print(f"\nTranscription: {result['final']}")
                        print(f"Confidence: {result.get('confidence', 0):.2f}")
                        break
                except asyncio.TimeoutError:
                    continue
            
            if not responses:
                print("No transcription received within timeout")
            
    except ConnectionRefusedError:
        print("Error: Could not connect to ASR service. Is it running?")
        print("Start it with: python inference/asr_service.py")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    print("ASR Service Test")
    print("Make sure the ASR service is running on ws://127.0.0.1:8765")
    print()
    
    asyncio.run(test_asr_service())

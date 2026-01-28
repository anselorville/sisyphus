use anyhow::Result;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, Host, SampleFormat, SupportedStreamConfig, Stream};
use std::sync::{Arc, Mutex};
use std::collections::VecDeque;
use tauri::{Emitter, Manager};

const SAMPLE_RATE: u32 = 16000;
const CHANNELS: u16 = 1;
const FRAME_SIZE: usize = 640;
const JITTER_BUFFER_MS: usize = 150;
const JITTER_BUFFER_FRAMES: usize = (SAMPLE_RATE as usize * JITTER_BUFFER_MS) / 1000 / (FRAME_SIZE * 2);

pub struct AudioPlayback {
    is_playing: Arc<Mutex<bool>>,
    audio_queue: Arc<Mutex<VecDeque<Vec<u8>>>>,
    stream: Option<Stream>,
}

impl AudioPlayback {
    pub fn new() -> Self {
        Self {
            is_playing: Arc::new(Mutex::new(false)),
            audio_queue: Arc::new(Mutex::new(VecDeque::new())),
            stream: None,
        }
    }
    
    async fn get_default_output_device() -> Result<Device> {
        let host = cpal::default_host();
        
        let default_device = host
            .default_output_device()
            .ok_or_else(|| anyhow::anyhow!("No default output device found"))?;
        
        Ok(default_device)
    }
    
    pub fn queue_audio(&self, audio_data: Vec<u8>) -> Result<()> {
        let mut queue = self.audio_queue.lock().unwrap();
        queue.push_back(audio_data);
        
        if queue.len() > JITTER_BUFFER_FRAMES {
            if !*self.is_playing.lock().unwrap() {
                self.start_playback()?;
            }
        }
        
        Ok(())
    }
    
    pub fn start_playback(&mut self) -> Result<()> {
        if *self.is_playing.lock().unwrap() {
            return Ok(());
        }
        
        let device = Self::get_default_output_device().await?;
        
        let config = SupportedStreamConfig::new(
            SAMPLE_RATE,
            CHANNELS,
            SampleFormat::I16,
        );
        
        let queue = self.audio_queue.clone();
        
        let stream = device.build_output_stream(
            &config.into(),
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                let mut queue = queue.lock().unwrap();
                
                let mut data_iter = data.iter_mut();
                
                while !queue.is_empty() && data_iter.len() >= FRAME_SIZE {
                    let audio_bytes = queue.pop_front().unwrap();
                    
                    let samples: &[i16] = unsafe {
                        std::slice::from_raw_parts(
                            audio_bytes.as_ptr() as *const i16,
                            audio_bytes.len() / 2,
                        )
                    };
                    
                    for (sample, output) in samples.iter().zip(data_iter.by_ref()) {
                        *output = *sample as f32 / 32768.0;
                    }
                    
                    if data_iter.len() < FRAME_SIZE {
                        break;
                    }
                }
            },
            move |err| {
                eprintln!("Audio playback error: {}", err);
            },
            None,
        )?;
        
        stream.play()?;
        self.stream = Some(stream);
        *self.is_playing.lock().unwrap() = true;
        
        Ok(())
    }
    
    pub fn stop_playback(&mut self) -> Result<()> {
        *self.is_playing.lock().unwrap() = false;
        
        if let Some(stream) = self.stream.take() {
            stream.pause()?;
        }
        
        self.audio_queue.lock().unwrap().clear();
        
        Ok(())
    }
    
    pub fn is_playing(&self) -> bool {
        *self.is_playing.lock().unwrap()
    }
}

#[tauri::command]
pub fn queue_playback_audio(
    state: tauri::State<'_, Arc<Mutex<AudioPlayback>>>,
    audio_data: Vec<u8>,
) -> Result<(), String> {
    let playback = state.lock().unwrap();
    
    playback.queue_audio(audio_data)
        .map_err(|e| format!("Failed to queue audio: {}", e))?;
    
    Ok(())
}

#[tauri::command]
pub fn start_playback<M: Manager + Clone>(
    app: tauri::AppHandle<M>,
    state: tauri::State<'_, Arc<Mutex<AudioPlayback>>>,
) -> Result<(), String> {
    let mut playback = state.lock().unwrap();
    
    playback.start_playback()
        .map_err(|e| format!("Failed to start playback: {}", e))?;
    
    app.emit("playback_started", ()).map_err(|e| format!("Failed to emit event: {}", e))?;
    
    Ok(())
}

#[tauri::command]
pub fn stop_playback<M: Manager + Clone>(
    app: tauri::AppHandle<M>,
    state: tauri::State<'_, Arc<Mutex<AudioPlayback>>>,
) -> Result<(), String> {
    let mut playback = state.lock().unwrap();
    
    playback.stop_playback()
        .map_err(|e| format!("Failed to stop playback: {}", e))?;
    
    app.emit("playback_ended", ()).map_err(|e| format!("Failed to emit event: {}", e))?;
    
    Ok(())
}

#[tauri::command]
pub fn is_playback_active(state: tauri::State<'_, Arc<Mutex<AudioPlayback>>>) -> bool {
    state.lock().unwrap().is_playing()
}

use anyhow::Result;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, Host, SampleFormat, SupportedStreamConfig};
use silero_vad_rs::{Model as VADModel, VadIterator, SampleRate};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

const SAMPLE_RATE: u32 = 16000;
const CHANNELS: u16 = 1;
const FRAME_SIZE: usize = 640;
const HANGOVER_MS: usize = 200;

#[derive(Clone, serde::Serialize)]
enum VadEvent {
    SpeechStart,
    SpeechEnd,
    Silence,
}

#[derive(Clone, serde::Serialize)]
struct AudioLevel {
    level: f32,
}

pub struct AudioCapture {
    is_recording: Arc<Mutex<bool>>,
    vad_model: VADModel,
    vad_iterator: Option<VadIterator>,
}

impl AudioCapture {
    pub fn new() -> Result<Self> {
        let vad_model = VADModel::new(SampleRate::Hz16000)?;
        
        Ok(Self {
            is_recording: Arc::new(Mutex::new(false)),
            vad_model,
            vad_iterator: None,
        })
    }
    
    fn init_vad_iterator(&mut self) {
        self.vad_iterator = Some(VadIterator::new(self.vad_model.clone()));
    }
    
    async fn get_default_input_device() -> Result<Device> {
        let host = cpal::default_host();
        
        let default_device = host
            .default_input_device()
            .ok_or_else(|| anyhow::anyhow!("No default input device found"))?;
        
        Ok(default_device)
    }
    
    fn pcm16_to_f32(samples: &[i16]) -> Vec<f32> {
        samples.iter().map(|&s| s as f32 / 32768.0).collect()
    }
    
    fn calculate_audio_level(samples: &[f32]) -> f32 {
        if samples.is_empty() {
            return 0.0;
        }
        
        let rms: f32 = samples.iter().map(|&x| x * x).sum::<f32>() / samples.len() as f32;
        rms.sqrt()
    }
    
    pub async fn start_recording<M: Manager + Clone>(
        &mut self,
        app_handle: tauri::AppHandle<M>,
    ) -> Result<()> {
        self.init_vad_iterator();
        
        *self.is_recording.lock().unwrap() = true;
        
        let device = Self::get_default_input_device().await?;
        
        let config = SupportedStreamConfig::new(
            SAMPLE_RATE,
            CHANNELS,
            SampleFormat::I16,
        );
        
        let stream = device.build_input_stream(
            &config.into(),
            move |data, _: &cpal::InputCallbackInfo| {
                let samples: &[i16] = data.as_slice().unwrap();
                
                let float_samples = Self::pcm16_to_f32(samples);
                let audio_level = Self::calculate_audio_level(&float_samples);
                
                let _ = app_handle.emit("audio_level", AudioLevel { level: audio_level });
            },
            move |err| {
                eprintln!("Audio capture error: {}", err);
            },
            None,
        )?;
        
        stream.play()?;
        
        app_handle.emit("vad_status", VadEvent::SpeechStart)?;
        
        Ok(())
    }
    
    pub fn stop_recording<M: Manager + Clone>(
        &mut self,
        app_handle: tauri::AppHandle<M>,
    ) -> Result<()> {
        *self.is_recording.lock().unwrap() = false;
        
        app_handle.emit("vad_status", VadEvent::Silence)?;
        
        Ok(())
    }
    
    pub fn is_recording(&self) -> bool {
        *self.is_recording.lock().unwrap()
    }
}

#[tauri::command]
pub async fn start_recording<M: Manager + Clone>(
    app: tauri::AppHandle<M>,
    state: tauri::State<'_, Arc<Mutex<AudioCapture>>>,
) -> Result<(), String> {
    let mut capture = state.lock().unwrap();
    
    if capture.is_recording() {
        return Err("Already recording".to_string());
    }
    
    capture.start_recording(app)
        .await
        .map_err(|e| format!("Failed to start recording: {}", e))?;
    
    Ok(())
}

#[tauri::command]
pub fn stop_recording<M: Manager + Clone>(
    app: tauri::AppHandle<M>,
    state: tauri::State<'_, Arc<Mutex<AudioCapture>>>,
) -> Result<(), String> {
    let mut capture = state.lock().unwrap();
    
    capture.stop_recording(app)
        .map_err(|e| format!("Failed to stop recording: {}", e))?;
    
    Ok(())
}

#[tauri::command]
pub fn is_recording(state: tauri::State<'_, Arc<Mutex<AudioCapture>>>) -> bool {
    state.lock().unwrap().is_recording()
}

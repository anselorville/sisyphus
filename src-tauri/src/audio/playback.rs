use anyhow::Result;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, StreamConfig};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Emitter;

const SAMPLE_RATE: u32 = 16000;
const CHANNELS: u16 = 1;
const JITTER_BUFFER_FRAMES: usize = 5;

static PLAYING: AtomicBool = AtomicBool::new(false);
static AUDIO_QUEUE: OnceLock<Arc<Mutex<VecDeque<Vec<u8>>>>> = OnceLock::new();
static APP_HANDLE: OnceLock<Arc<Mutex<Option<tauri::AppHandle>>>> = OnceLock::new();
static PLAYBACK_COMPLETE_FLAG: AtomicBool = AtomicBool::new(false);

fn get_queue() -> &'static Arc<Mutex<VecDeque<Vec<u8>>>> {
    AUDIO_QUEUE.get_or_init(|| Arc::new(Mutex::new(VecDeque::new())))
}

fn get_app_handle() -> &'static Arc<Mutex<Option<tauri::AppHandle>>> {
    APP_HANDLE.get_or_init(|| Arc::new(Mutex::new(None)))
}

pub struct AudioPlayback;

impl AudioPlayback {
    fn get_default_output_device() -> Result<Device> {
        let host = cpal::default_host();

        let default_device = host
            .default_output_device()
            .ok_or_else(|| anyhow::anyhow!("No default output device found"))?;

        Ok(default_device)
    }

    pub fn is_playing() -> bool {
        PLAYING.load(Ordering::SeqCst)
    }
}

#[tauri::command]
pub fn queue_playback_audio(audio_data: Vec<u8>) -> Result<(), String> {
    let queue = get_queue();
    let mut q = queue.lock().unwrap();
    q.push_back(audio_data);

    let should_start = q.len() >= JITTER_BUFFER_FRAMES && !PLAYING.load(Ordering::SeqCst);
    drop(q);

    if should_start {
        start_playback_internal()?;
    }

    Ok(())
}

fn start_playback_internal() -> Result<(), String> {
    if PLAYING.load(Ordering::SeqCst) {
        return Ok(());
    }

    PLAYING.store(true, Ordering::SeqCst);
    PLAYBACK_COMPLETE_FLAG.store(false, Ordering::SeqCst);

    let device =
        AudioPlayback::get_default_output_device().map_err(|e| format!("Device error: {}", e))?;

    let config = StreamConfig {
        channels: CHANNELS,
        sample_rate: cpal::SampleRate(SAMPLE_RATE),
        buffer_size: cpal::BufferSize::Default,
    };

    let queue = get_queue().clone();

    let stream = device
        .build_output_stream(
            &config,
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                // Initialize all samples to silence
                for sample in data.iter_mut() {
                    *sample = 0.0;
                }

                if !PLAYING.load(Ordering::SeqCst) {
                    return;
                }

                let mut queue = queue.lock().unwrap();
                let mut output_idx = 0;

                while !queue.is_empty() && output_idx < data.len() {
                    if let Some(audio_bytes) = queue.front() {
                        let samples: &[i16] = unsafe {
                            std::slice::from_raw_parts(
                                audio_bytes.as_ptr() as *const i16,
                                audio_bytes.len() / 2,
                            )
                        };

                        for sample in samples.iter() {
                            if output_idx >= data.len() {
                                break;
                            }
                            data[output_idx] = *sample as f32 / 32768.0;
                            output_idx += 1;
                        }

                        queue.pop_front();
                    }
                }

                // Check if we've finished playing all audio
                if queue.is_empty() && PLAYING.load(Ordering::SeqCst) {
                    // Signal that playback is complete
                    if !PLAYBACK_COMPLETE_FLAG.swap(true, Ordering::SeqCst) {
                        PLAYING.store(false, Ordering::SeqCst);
                    }
                }
            },
            move |err| {
                eprintln!("Audio playback error: {}", err);
            },
            None,
        )
        .map_err(|e| format!("Failed to build stream: {}", e))?;

    stream
        .play()
        .map_err(|e| format!("Failed to play stream: {}", e))?;

    // Leak the stream to keep it alive
    Box::leak(Box::new(stream));

    // Start a monitoring task to emit events when playback completes
    if let Some(app) = get_app_handle().lock().unwrap().as_ref() {
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            // Wait for playback to complete
            loop {
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

                if PLAYBACK_COMPLETE_FLAG.load(Ordering::SeqCst) {
                    // Emit playback ended and state change
                    let _ = app_clone.emit("voice_assistant:playback_ended", ());
                    let _ = app_clone.emit(
                        "voice_assistant:state_changed",
                        serde_json::json!({ "state": "Idle" }),
                    );
                    break;
                }

                if !PLAYING.load(Ordering::SeqCst) {
                    break;
                }
            }
        });
    }

    Ok(())
}

#[tauri::command]
pub fn start_playback(app: tauri::AppHandle) -> Result<(), String> {
    // Store the app handle for later use
    {
        let mut handle = get_app_handle().lock().unwrap();
        *handle = Some(app.clone());
    }

    start_playback_internal()?;

    app.emit("voice_assistant:playback_started", ())
        .map_err(|e| format!("Failed to emit event: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn stop_playback(app: tauri::AppHandle) -> Result<(), String> {
    PLAYING.store(false, Ordering::SeqCst);
    get_queue().lock().unwrap().clear();

    app.emit("voice_assistant:playback_ended", ())
        .map_err(|e| format!("Failed to emit event: {}", e))?;

    app.emit(
        "voice_assistant:state_changed",
        serde_json::json!({ "state": "Idle" }),
    )
    .map_err(|e| format!("Failed to emit state: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn is_playback_active() -> bool {
    AudioPlayback::is_playing()
}

/// Initialize playback with app handle for event emission
/// This should be called at app startup
pub fn init_playback(app: tauri::AppHandle) {
    let mut handle = get_app_handle().lock().unwrap();
    *handle = Some(app);
}

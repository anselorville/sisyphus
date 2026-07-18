//! Audio capture and the voice-service Tauri commands.
//!
//! The service session owns a persistent capture stream and ASR link; the
//! mic (or the auto-VAD) only decides which frames become utterances.

use anyhow::Result;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleRate, SupportedStreamConfigRange};
use std::sync::atomic::Ordering;
use tauri::Emitter;
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;

use crate::audio::asr_session::run_asr_session;
use crate::audio::playback;
use crate::audio::state::{
    emit_pipeline_status, emit_service_status, emit_speech_end, get_capture_shutdown, get_pipe_tx,
    AudioLevel, CaptureMsg, VadEvent, AUTO_VAD, MIC_OPEN, SERVICE_ACTIVE, TARGET_SAMPLE_RATE,
    TTS_HOST, TTS_OK,
};

const TTS_HEALTH_INTERVAL_SECS: u64 = 10;

pub struct AudioCapture;

/// Audio configuration for capture
struct CaptureConfig {
    sample_rate: u32,
    channels: u16,
}

impl AudioCapture {
    fn get_default_input_device() -> Result<Device> {
        let host = cpal::default_host();

        let default_device = host
            .default_input_device()
            .ok_or_else(|| anyhow::anyhow!("No default input device found"))?;

        Ok(default_device)
    }

    /// Find the best supported configuration for the device
    fn get_supported_config(device: &Device) -> Result<CaptureConfig> {
        let supported_configs: Vec<SupportedStreamConfigRange> = device
            .supported_input_configs()
            .map_err(|e| anyhow::anyhow!("Failed to get supported configs: {}", e))?
            .collect();

        if supported_configs.is_empty() {
            return Err(anyhow::anyhow!("No supported input configurations"));
        }

        // Try to find a config that supports our target sample rate
        // Prefer mono, but accept stereo if needed
        let target_rate = SampleRate(TARGET_SAMPLE_RATE);

        for config in &supported_configs {
            if config.channels() == 1
                && config.min_sample_rate() <= target_rate
                && config.max_sample_rate() >= target_rate
            {
                return Ok(CaptureConfig {
                    sample_rate: TARGET_SAMPLE_RATE,
                    channels: 1,
                });
            }
        }

        for config in &supported_configs {
            if config.channels() == 2
                && config.min_sample_rate() <= target_rate
                && config.max_sample_rate() >= target_rate
            {
                return Ok(CaptureConfig {
                    sample_rate: TARGET_SAMPLE_RATE,
                    channels: 2,
                });
            }
        }

        // Fall back to any supported config (prefer lower sample rates and mono)
        let best_config = supported_configs
            .iter()
            .min_by_key(|c| (c.channels(), c.min_sample_rate().0))
            .unwrap();

        let sample_rate = if best_config.min_sample_rate().0 <= 48000
            && best_config.max_sample_rate().0 >= 48000
        {
            48000
        } else if best_config.min_sample_rate().0 <= 44100
            && best_config.max_sample_rate().0 >= 44100
        {
            44100
        } else {
            best_config.min_sample_rate().0
        };

        Ok(CaptureConfig {
            sample_rate,
            channels: best_config.channels(),
        })
    }

    fn calculate_audio_level(samples: &[f32]) -> f32 {
        if samples.is_empty() {
            return 0.0;
        }

        let rms: f32 = samples.iter().map(|&x| x * x).sum::<f32>() / samples.len() as f32;
        rms.sqrt()
    }

    pub fn is_recording() -> bool {
        MIC_OPEN.load(Ordering::SeqCst)
    }
}

/// Simple linear resampling from source rate to target rate (16kHz)
fn resample_to_16k(samples: &[f32], source_rate: u32, channels: u16) -> Vec<f32> {
    // First, convert stereo to mono if needed
    let mono_samples: Vec<f32> = if channels == 2 {
        samples
            .chunks(2)
            .map(|chunk| {
                if chunk.len() == 2 {
                    (chunk[0] + chunk[1]) / 2.0
                } else {
                    chunk[0]
                }
            })
            .collect()
    } else {
        samples.to_vec()
    };

    if source_rate == TARGET_SAMPLE_RATE {
        return mono_samples;
    }

    // Linear interpolation resampling
    let ratio = source_rate as f64 / TARGET_SAMPLE_RATE as f64;
    let output_len = (mono_samples.len() as f64 / ratio).ceil() as usize;
    let mut output = Vec::with_capacity(output_len);

    for i in 0..output_len {
        let src_idx = i as f64 * ratio;
        let src_idx_floor = src_idx.floor() as usize;
        let frac = (src_idx - src_idx_floor as f64) as f32;

        let sample = if src_idx_floor + 1 < mono_samples.len() {
            mono_samples[src_idx_floor] * (1.0 - frac) + mono_samples[src_idx_floor + 1] * frac
        } else if src_idx_floor < mono_samples.len() {
            mono_samples[src_idx_floor]
        } else {
            0.0
        };

        output.push(sample);
    }

    output
}

/// Start the voice service session: persistent ASR link + always-on capture
/// stream. The mic starts CLOSED — no audio is forwarded until `open_mic`
/// (or until the auto-VAD detects speech).
#[tauri::command]
pub fn start_voice_service(app: tauri::AppHandle) -> Result<(), String> {
    if SERVICE_ACTIVE.swap(true, Ordering::SeqCst) {
        return Err("Voice service already running".to_string());
    }
    MIC_OPEN.store(false, Ordering::SeqCst);
    crate::audio::state::ASR_OK.store(false, Ordering::SeqCst);
    TTS_OK.store(false, Ordering::SeqCst);

    emit_service_status(&app, "starting", "正在启动语音服务");

    let device = match AudioCapture::get_default_input_device() {
        Ok(d) => d,
        Err(e) => {
            SERVICE_ACTIVE.store(false, Ordering::SeqCst);
            emit_service_status(&app, "error", "没有可用的输入设备");
            return Err(format!("Device error: {}", e));
        }
    };

    let capture_config = match AudioCapture::get_supported_config(&device) {
        Ok(c) => c,
        Err(e) => {
            SERVICE_ACTIVE.store(false, Ordering::SeqCst);
            emit_service_status(&app, "error", "输入设备配置失败");
            return Err(format!("Config error: {}", e));
        }
    };

    println!(
        "Audio capture config: {}Hz, {} channels",
        capture_config.sample_rate, capture_config.channels
    );

    let (pipe_tx, pipe_rx) = mpsc::unbounded_channel::<CaptureMsg>();
    {
        *get_pipe_tx().lock().unwrap() = Some(pipe_tx);
    }

    // Persistent ASR session for the whole service lifetime
    let app_for_asr = app.clone();
    tauri::async_runtime::spawn(async move {
        run_asr_session(app_for_asr, pipe_rx).await;
    });

    // TTS health monitor: keeps the aggregated pipeline status honest and
    // self-healing — if TTS comes up later, "degraded" clears by itself.
    let app_for_tts = app.clone();
    tauri::async_runtime::spawn(async move {
        while SERVICE_ACTIVE.load(Ordering::SeqCst) {
            let ok = match connect_async(TTS_HOST).await {
                Ok((mut ws, _)) => {
                    let _ = ws.close(None).await;
                    true
                }
                Err(_) => false,
            };

            if TTS_OK.swap(ok, Ordering::SeqCst) != ok {
                emit_pipeline_status(&app_for_tts);
            }

            tokio::time::sleep(tokio::time::Duration::from_secs(TTS_HEALTH_INTERVAL_SECS))
                .await;
        }
    });

    // The cpal stream is !Send, so a dedicated thread owns it; the thread
    // blocks until service shutdown, then drops the stream (no more leaks).
    let (shutdown_tx, shutdown_rx) = std::sync::mpsc::channel::<()>();
    {
        *get_capture_shutdown().lock().unwrap() = Some(shutdown_tx);
    }

    let app_for_stream = app.clone();
    let source_rate = capture_config.sample_rate;
    let source_channels = capture_config.channels;

    std::thread::spawn(move || {
        let config = cpal::StreamConfig {
            channels: source_channels,
            sample_rate: cpal::SampleRate(source_rate),
            buffer_size: cpal::BufferSize::Default,
        };

        let stream = match device.build_input_stream(
            &config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                // Manual mode: forward only while the mic is open.
                // Auto-VAD mode: always forward; the session-side VAD decides.
                if !MIC_OPEN.load(Ordering::SeqCst) && !AUTO_VAD.load(Ordering::SeqCst) {
                    return;
                }

                let audio_level = AudioCapture::calculate_audio_level(data);
                let _ = app_for_stream.emit(
                    "voice_assistant:audio_level",
                    AudioLevel { level: audio_level },
                );

                let resampled = resample_to_16k(data, source_rate, source_channels);

                let pcm_bytes: Vec<u8> = resampled
                    .iter()
                    .flat_map(|&sample| {
                        let clamped = sample.clamp(-1.0, 1.0);
                        let i16_sample = (clamped * 32767.0) as i16;
                        i16_sample.to_le_bytes()
                    })
                    .collect();

                if let Some(tx) = get_pipe_tx().lock().unwrap().as_ref() {
                    let _ = tx.send(CaptureMsg::Frame(pcm_bytes));
                }
            },
            move |err| {
                eprintln!("Audio capture error: {}", err);
            },
            None,
        ) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("Failed to build capture stream: {}", e);
                return;
            }
        };

        if let Err(e) = stream.play() {
            eprintln!("Failed to start capture stream: {}", e);
            return;
        }

        // Block until shutdown, then the stream is dropped cleanly
        let _ = shutdown_rx.recv();
    });

    Ok(())
}

/// Stop the whole voice service session (capture stream + ASR link).
#[tauri::command]
pub fn stop_voice_service(app: tauri::AppHandle) -> Result<(), String> {
    SERVICE_ACTIVE.store(false, Ordering::SeqCst);
    MIC_OPEN.store(false, Ordering::SeqCst);

    // Dropping the sender unblocks and terminates the ASR session
    {
        *get_pipe_tx().lock().unwrap() = None;
    }

    // Signal the capture thread to drop the stream
    {
        let mut guard = get_capture_shutdown().lock().unwrap();
        if let Some(tx) = guard.take() {
            let _ = tx.send(());
        }
    }

    playback::resume_playback_internal(&app);
    emit_service_status(&app, "offline", "语音服务已停止");
    let _ = app.emit(
        "voice_assistant:state_changed",
        serde_json::json!({ "state": "Idle" }),
    );

    Ok(())
}

/// Open the mic: start a new utterance. If TTS audio is playing, pause it
/// and keep the remaining audio cached (barge-in).
#[tauri::command]
pub fn open_mic(app: tauri::AppHandle) -> Result<(), String> {
    if !SERVICE_ACTIVE.load(Ordering::SeqCst) {
        return Err("Voice service is not running".to_string());
    }
    if AUTO_VAD.load(Ordering::SeqCst) {
        return Err("Auto VAD mode is active; the mic is hands-free".to_string());
    }
    if MIC_OPEN.swap(true, Ordering::SeqCst) {
        return Ok(()); // already open
    }

    // Barge-in: pause TTS playback, cache what's left
    playback::pause_playback_internal(&app);

    if let Some(tx) = get_pipe_tx().lock().unwrap().as_ref() {
        let _ = tx.send(CaptureMsg::BeginUtterance);
    }

    let _ = app.emit(
        "voice_assistant:vad_status",
        VadEvent {
            status: "speech_start".to_string(),
        },
    );
    let _ = app.emit(
        "voice_assistant:state_changed",
        serde_json::json!({ "state": "Listening" }),
    );

    Ok(())
}

/// Close the mic: this is the explicit "sentence finished" signal. ASR gets
/// end_utterance and will reply with the authoritative final text; paused
/// TTS playback resumes from its cache.
#[tauri::command]
pub fn close_mic(app: tauri::AppHandle) -> Result<(), String> {
    if !MIC_OPEN.swap(false, Ordering::SeqCst) {
        return Ok(()); // already closed
    }

    if let Some(tx) = get_pipe_tx().lock().unwrap().as_ref() {
        let _ = tx.send(CaptureMsg::EndUtterance);
    }

    emit_speech_end(&app);

    // Resume any paused TTS playback from the cache
    playback::resume_playback_internal(&app);

    Ok(())
}

/// Switch between manual mic toggling and hands-free auto-VAD mode.
#[tauri::command]
pub fn set_vad_mode(app: tauri::AppHandle, auto: bool) -> Result<(), String> {
    let was_auto = AUTO_VAD.swap(auto, Ordering::SeqCst);
    if was_auto == auto {
        return Ok(());
    }

    // Entering auto mode with a manual utterance in flight: close it first
    if auto && MIC_OPEN.swap(false, Ordering::SeqCst) {
        if let Some(tx) = get_pipe_tx().lock().unwrap().as_ref() {
            let _ = tx.send(CaptureMsg::EndUtterance);
        }
        emit_speech_end(&app);
        playback::resume_playback_internal(&app);
    }

    // Tell the session (FIFO, after any queued frames) so it can close an
    // auto-detected utterance that is still in progress when switching off.
    if let Some(tx) = get_pipe_tx().lock().unwrap().as_ref() {
        let _ = tx.send(CaptureMsg::SetAutoVad(auto));
    }

    let _ = app.emit(
        "voice_assistant:vad_mode",
        serde_json::json!({ "auto": auto }),
    );

    Ok(())
}

#[tauri::command]
pub fn is_recording() -> bool {
    AudioCapture::is_recording()
}

#[tauri::command]
pub fn is_service_active() -> bool {
    SERVICE_ACTIVE.load(Ordering::SeqCst)
}

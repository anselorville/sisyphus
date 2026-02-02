use anyhow::Result;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, StreamConfig};
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Emitter;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};

const SAMPLE_RATE: u32 = 16000;
const CHANNELS: u16 = 1;
const ASR_HOST: &str = "ws://127.0.0.1:8765";
const AUDIO_FRAME_SIZE: usize = 640; // 20ms at 16kHz mono = 320 samples * 2 bytes

#[derive(Clone, serde::Serialize)]
pub struct VadEvent {
    pub status: String,
}

#[derive(Clone, serde::Serialize)]
pub struct AudioLevel {
    pub level: f32,
}

#[derive(Clone, serde::Serialize, serde::Deserialize, Debug)]
pub struct AsrTranscript {
    pub partial: String,
    #[serde(rename = "final")]
    pub final_text: Option<String>,
    pub confidence: f32,
}

static RECORDING: AtomicBool = AtomicBool::new(false);
static AUDIO_TX: OnceLock<Arc<Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>>> = OnceLock::new();

fn get_audio_tx() -> &'static Arc<Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>> {
    AUDIO_TX.get_or_init(|| Arc::new(Mutex::new(None)))
}

pub struct AudioCapture;

impl AudioCapture {
    fn get_default_input_device() -> Result<Device> {
        let host = cpal::default_host();

        let default_device = host
            .default_input_device()
            .ok_or_else(|| anyhow::anyhow!("No default input device found"))?;

        Ok(default_device)
    }

    fn calculate_audio_level(samples: &[f32]) -> f32 {
        if samples.is_empty() {
            return 0.0;
        }

        let rms: f32 = samples.iter().map(|&x| x * x).sum::<f32>() / samples.len() as f32;
        rms.sqrt()
    }

    pub fn is_recording() -> bool {
        RECORDING.load(Ordering::SeqCst)
    }
}

async fn run_asr_session(
    app: tauri::AppHandle,
    mut audio_rx: mpsc::UnboundedReceiver<Vec<u8>>,
) {
    // Connect to ASR WebSocket
    let ws_result = connect_async(ASR_HOST).await;

    let (mut ws_stream, _) = match ws_result {
        Ok(conn) => conn,
        Err(e) => {
            eprintln!("Failed to connect to ASR: {}", e);
            let _ = app.emit(
                "voice_assistant:error",
                serde_json::json!({ "code": "ASR_CONNECTION_FAILED", "message": format!("{}", e) }),
            );
            return;
        }
    };

    let mut audio_buffer = Vec::with_capacity(AUDIO_FRAME_SIZE);

    loop {
        tokio::select! {
            // Receive audio from capture and send to ASR
            Some(audio_data) = audio_rx.recv() => {
                audio_buffer.extend_from_slice(&audio_data);

                // Send complete frames to ASR
                while audio_buffer.len() >= AUDIO_FRAME_SIZE {
                    let frame: Vec<u8> = audio_buffer.drain(..AUDIO_FRAME_SIZE).collect();
                    if let Err(e) = ws_stream.send(Message::Binary(frame)).await {
                        eprintln!("Failed to send audio to ASR: {}", e);
                        return;
                    }
                }
            }

            // Receive results from ASR
            Some(msg_result) = ws_stream.next() => {
                match msg_result {
                    Ok(Message::Text(text)) => {
                        // Parse ASR result
                        if let Ok(result) = serde_json::from_str::<serde_json::Value>(&text) {
                            let partial = result.get("partial")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();

                            let final_text = result.get("final")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());

                            let confidence = result.get("confidence")
                                .and_then(|v| v.as_f64())
                                .unwrap_or(0.0) as f32;

                            let transcript = AsrTranscript {
                                partial,
                                final_text: final_text.clone(),
                                confidence,
                            };

                            let _ = app.emit("voice_assistant:user_transcript", &transcript);

                            // If we got a final result, transition state
                            if final_text.is_some() {
                                let _ = app.emit(
                                    "voice_assistant:state_changed",
                                    serde_json::json!({ "state": "FinalizingASR" }),
                                );
                            }
                        }
                    }
                    Ok(Message::Close(_)) => {
                        break;
                    }
                    Err(e) => {
                        eprintln!("ASR WebSocket error: {}", e);
                        break;
                    }
                    _ => {}
                }
            }

            else => {
                // Channel closed or recording stopped
                if !RECORDING.load(Ordering::SeqCst) {
                    // Send any remaining buffered audio
                    if !audio_buffer.is_empty() {
                        let _ = ws_stream.send(Message::Binary(audio_buffer.clone())).await;
                    }
                    // Close the WebSocket gracefully
                    let _ = ws_stream.close(None).await;
                    break;
                }
            }
        }
    }
}

#[tauri::command]
pub fn start_recording(app: tauri::AppHandle) -> Result<(), String> {
    if RECORDING.load(Ordering::SeqCst) {
        return Err("Already recording".to_string());
    }

    RECORDING.store(true, Ordering::SeqCst);

    let device =
        AudioCapture::get_default_input_device().map_err(|e| format!("Device error: {}", e))?;

    let config = StreamConfig {
        channels: CHANNELS,
        sample_rate: cpal::SampleRate(SAMPLE_RATE),
        buffer_size: cpal::BufferSize::Default,
    };

    // Create channel for audio data
    let (audio_tx, audio_rx) = mpsc::unbounded_channel::<Vec<u8>>();

    // Store the sender for the capture callback
    {
        let mut tx_guard = get_audio_tx().lock().unwrap();
        *tx_guard = Some(audio_tx);
    }

    let app_handle = app.clone();
    let app_handle_for_stream = app.clone();

    // Spawn ASR session task
    tauri::async_runtime::spawn(async move {
        run_asr_session(app_handle_for_stream, audio_rx).await;
    });

    let stream = device
        .build_input_stream(
            &config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if !RECORDING.load(Ordering::SeqCst) {
                    return;
                }

                // Calculate and emit audio level
                let audio_level = AudioCapture::calculate_audio_level(data);
                let _ = app_handle.emit(
                    "voice_assistant:audio_level",
                    AudioLevel { level: audio_level },
                );

                // Convert f32 samples to i16 PCM bytes and send to ASR
                let pcm_bytes: Vec<u8> = data
                    .iter()
                    .flat_map(|&sample| {
                        let clamped = sample.max(-1.0).min(1.0);
                        let i16_sample = (clamped * 32767.0) as i16;
                        i16_sample.to_le_bytes()
                    })
                    .collect();

                // Send audio to ASR task
                if let Some(tx) = get_audio_tx().lock().unwrap().as_ref() {
                    let _ = tx.send(pcm_bytes);
                }
            },
            move |err| {
                eprintln!("Audio capture error: {}", err);
            },
            None,
        )
        .map_err(|e| format!("Failed to build stream: {}", e))?;

    stream
        .play()
        .map_err(|e| format!("Failed to play stream: {}", e))?;

    // Leak the stream to keep it alive
    Box::leak(Box::new(stream));

    app.emit(
        "voice_assistant:vad_status",
        VadEvent {
            status: "speech_start".to_string(),
        },
    )
    .map_err(|e| format!("Failed to emit event: {}", e))?;

    app.emit(
        "voice_assistant:state_changed",
        serde_json::json!({ "state": "Listening" }),
    )
    .map_err(|e| format!("Failed to emit state: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn stop_recording(app: tauri::AppHandle) -> Result<(), String> {
    RECORDING.store(false, Ordering::SeqCst);

    // Close the audio channel to signal ASR task to finish
    {
        let mut tx_guard = get_audio_tx().lock().unwrap();
        *tx_guard = None;
    }

    app.emit(
        "voice_assistant:vad_status",
        VadEvent {
            status: "speech_end".to_string(),
        },
    )
    .map_err(|e| format!("Failed to emit event: {}", e))?;

    app.emit(
        "voice_assistant:state_changed",
        serde_json::json!({ "state": "Idle" }),
    )
    .map_err(|e| format!("Failed to emit state: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn is_recording() -> bool {
    AudioCapture::is_recording()
}

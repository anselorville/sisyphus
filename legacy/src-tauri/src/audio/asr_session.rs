//! Persistent ASR session: lives for the whole service session and survives
//! mic open/close cycles. Reconnects if the WebSocket drops while the
//! service is still active.

use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::Ordering;
use tauri::Emitter;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::audio::playback;
use crate::audio::state::{
    emit_pipeline_status, emit_service_status, emit_speech_end, emit_speech_start, AsrTranscript,
    CaptureMsg, ASR_HOST, ASR_OK, AUDIO_FRAME_SIZE, AUTO_VAD, SERVICE_ACTIVE,
};
use crate::audio::vad::{AutoVad, VadAction};

const ASR_CONNECT_RETRIES: u32 = 5;
const ASR_RECONNECT_DELAY_MS: u64 = 1000;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Send all complete AUDIO_FRAME_SIZE frames buffered so far.
async fn send_full_frames(ws_stream: &mut WsStream, audio_buffer: &mut Vec<u8>) -> Result<(), ()> {
    while audio_buffer.len() >= AUDIO_FRAME_SIZE {
        let frame: Vec<u8> = audio_buffer.drain(..AUDIO_FRAME_SIZE).collect();
        if let Err(e) = ws_stream.send(Message::Binary(frame)).await {
            eprintln!("Failed to send audio to ASR: {}", e);
            return Err(());
        }
    }
    Ok(())
}

/// Flush the sub-frame tail and signal the utterance boundary to ASR.
async fn send_end_utterance(ws_stream: &mut WsStream, audio_buffer: &mut Vec<u8>) -> Result<(), ()> {
    if !audio_buffer.is_empty() {
        let tail = std::mem::take(audio_buffer);
        let _ = ws_stream.send(Message::Binary(tail)).await;
    }
    let msg = serde_json::json!({ "type": "end_utterance" }).to_string();
    ws_stream.send(Message::Text(msg)).await.map_err(|_| ())
}

async fn send_begin_utterance(ws_stream: &mut WsStream) -> Result<(), ()> {
    let msg = serde_json::json!({ "type": "begin_utterance" }).to_string();
    ws_stream.send(Message::Text(msg)).await.map_err(|_| ())
}

fn handle_asr_message(app: &tauri::AppHandle, text: &str) {
    let Ok(result) = serde_json::from_str::<serde_json::Value>(text) else {
        return;
    };

    let msg_type = result
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("asr_result");

    let confidence = result
        .get("confidence")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0) as f32;

    match msg_type {
        // Streaming window transcription while the utterance is in progress.
        // The Python side accumulates windows, so `partial` is the full
        // utterance-so-far text.
        "asr_result" => {
            let partial = result
                .get("partial")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let transcript = AsrTranscript {
                partial,
                final_text: None,
                confidence,
            };
            let _ = app.emit("voice_assistant:user_transcript", &transcript);
        }
        // Authoritative whole-utterance transcription (with punctuation),
        // produced after end_utterance. This is the text that goes to the LLM.
        "utterance_final" => {
            let final_text = result
                .get("final")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let transcript = AsrTranscript {
                partial: String::new(),
                final_text: Some(final_text.clone()),
                confidence,
            };
            let _ = app.emit("voice_assistant:user_transcript", &transcript);
            let _ = app.emit(
                "voice_assistant:utterance_final",
                serde_json::json!({ "text": final_text, "confidence": confidence }),
            );
        }
        _ => {}
    }
}

pub async fn run_asr_session(
    app: tauri::AppHandle,
    mut pipe_rx: mpsc::UnboundedReceiver<CaptureMsg>,
) {
    'outer: while SERVICE_ACTIVE.load(Ordering::SeqCst) {
        let mut ws_stream = None;
        for attempt in 0..ASR_CONNECT_RETRIES {
            match connect_async(ASR_HOST).await {
                Ok((stream, _)) => {
                    ws_stream = Some(stream);
                    break;
                }
                Err(e) => {
                    eprintln!(
                        "ASR connect failed (attempt {}/{}): {}",
                        attempt + 1,
                        ASR_CONNECT_RETRIES,
                        e
                    );
                    tokio::time::sleep(tokio::time::Duration::from_millis(
                        ASR_RECONNECT_DELAY_MS,
                    ))
                    .await;
                }
            }
            if !SERVICE_ACTIVE.load(Ordering::SeqCst) {
                break 'outer;
            }
        }

        let mut ws_stream = match ws_stream {
            Some(s) => s,
            None => {
                emit_service_status(&app, "error", "无法连接语音识别服务（端口 8765），请确认推理服务已启动");
                let _ = app.emit(
                    "voice_assistant:error",
                    serde_json::json!({ "code": "ASR_CONNECTION_FAILED", "message": "ASR unreachable" }),
                );
                SERVICE_ACTIVE.store(false, Ordering::SeqCst);
                break;
            }
        };

        ASR_OK.store(true, Ordering::SeqCst);
        emit_pipeline_status(&app);

        let mut audio_buffer: Vec<u8> = Vec::with_capacity(AUDIO_FRAME_SIZE);
        let mut vad = AutoVad::new();

        macro_rules! reconnect {
            () => {{
                ASR_OK.store(false, Ordering::SeqCst);
                emit_service_status(&app, "reconnecting", "语音识别连接中断，正在重连…");
                continue 'outer;
            }};
        }

        loop {
            tokio::select! {
                // Audio frames + utterance boundaries, in FIFO order
                maybe_msg = pipe_rx.recv() => {
                    match maybe_msg {
                        Some(CaptureMsg::Frame(audio_data)) => {
                            if AUTO_VAD.load(Ordering::SeqCst) {
                                let playback_active = playback::is_audibly_playing();
                                let (send_frame, action) = vad.feed(audio_data, playback_active);

                                match action {
                                    VadAction::StartUtterance => {
                                        playback::pause_playback_internal(&app);
                                        emit_speech_start(&app);
                                        audio_buffer.clear();
                                        if send_begin_utterance(&mut ws_stream).await.is_err() {
                                            reconnect!();
                                        }
                                        // Flush the pre-roll so the onset isn't clipped
                                        let preroll: Vec<Vec<u8>> = vad.prebuffer.drain(..).collect();
                                        vad.prebuffer_ms = 0.0;
                                        for f in preroll {
                                            audio_buffer.extend_from_slice(&f);
                                        }
                                        if send_full_frames(&mut ws_stream, &mut audio_buffer).await.is_err() {
                                            reconnect!();
                                        }
                                    }
                                    VadAction::EndUtterance => {
                                        if let Some(f) = send_frame {
                                            audio_buffer.extend_from_slice(&f);
                                        }
                                        if send_full_frames(&mut ws_stream, &mut audio_buffer).await.is_err()
                                            || send_end_utterance(&mut ws_stream, &mut audio_buffer).await.is_err()
                                        {
                                            reconnect!();
                                        }
                                        emit_speech_end(&app);
                                        playback::resume_playback_internal(&app);
                                    }
                                    VadAction::None => {
                                        if let Some(f) = send_frame {
                                            audio_buffer.extend_from_slice(&f);
                                            if send_full_frames(&mut ws_stream, &mut audio_buffer).await.is_err() {
                                                reconnect!();
                                            }
                                        }
                                    }
                                }
                            } else {
                                // Manual mode: frames only arrive while the mic is open
                                audio_buffer.extend_from_slice(&audio_data);
                                if send_full_frames(&mut ws_stream, &mut audio_buffer).await.is_err() {
                                    reconnect!();
                                }
                            }
                        }
                        Some(CaptureMsg::BeginUtterance) => {
                            audio_buffer.clear();
                            if send_begin_utterance(&mut ws_stream).await.is_err() {
                                reconnect!();
                            }
                        }
                        Some(CaptureMsg::EndUtterance) => {
                            if send_end_utterance(&mut ws_stream, &mut audio_buffer).await.is_err() {
                                reconnect!();
                            }
                        }
                        Some(CaptureMsg::SetAutoVad(enabled)) => {
                            // Turning auto mode off mid-speech: close the
                            // in-flight utterance so it isn't left dangling.
                            if !enabled && vad.in_speech {
                                if send_end_utterance(&mut ws_stream, &mut audio_buffer).await.is_err() {
                                    vad.reset();
                                    reconnect!();
                                }
                                emit_speech_end(&app);
                                playback::resume_playback_internal(&app);
                            }
                            vad.reset();
                        }
                        None => {
                            // Service shut down
                            ASR_OK.store(false, Ordering::SeqCst);
                            let _ = ws_stream.close(None).await;
                            break 'outer;
                        }
                    }
                }

                // Results from ASR
                maybe_msg = ws_stream.next() => {
                    match maybe_msg {
                        Some(Ok(Message::Text(text))) => {
                            handle_asr_message(&app, &text);
                        }
                        Some(Ok(Message::Close(_))) | None => {
                            if SERVICE_ACTIVE.load(Ordering::SeqCst) {
                                reconnect!();
                            }
                            break 'outer;
                        }
                        Some(Err(e)) => {
                            eprintln!("ASR WebSocket error: {}", e);
                            if SERVICE_ACTIVE.load(Ordering::SeqCst) {
                                reconnect!();
                            }
                            break 'outer;
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    ASR_OK.store(false, Ordering::SeqCst);
}

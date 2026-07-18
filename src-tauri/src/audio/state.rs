//! Shared state and events for the voice service session.
//!
//! SERVICE_ACTIVE covers the whole voice service (capture stream + ASR link),
//! MIC_OPEN only gates whether captured frames are forwarded to ASR, and
//! AUTO_VAD switches from manual mic toggling to hands-free voice detection.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Emitter;
use tokio::sync::mpsc;

pub const TARGET_SAMPLE_RATE: u32 = 16000;
pub const ASR_HOST: &str = "ws://127.0.0.1:8765";
pub const TTS_HOST: &str = "ws://127.0.0.1:8766";
pub const AUDIO_FRAME_SIZE: usize = 640; // 20ms at 16kHz mono = 320 samples * 2 bytes

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

/// Messages flowing from capture/mic-toggling to the persistent ASR session.
/// Audio frames and utterance boundaries share ONE channel so their relative
/// order is preserved (an EndUtterance must never overtake the tail frames).
pub enum CaptureMsg {
    Frame(Vec<u8>),
    BeginUtterance,
    EndUtterance,
    SetAutoVad(bool),
}

pub static SERVICE_ACTIVE: AtomicBool = AtomicBool::new(false);
pub static MIC_OPEN: AtomicBool = AtomicBool::new(false);
pub static AUTO_VAD: AtomicBool = AtomicBool::new(false);
// Component health, aggregated into ONE user-facing pipeline status.
pub static ASR_OK: AtomicBool = AtomicBool::new(false);
pub static TTS_OK: AtomicBool = AtomicBool::new(false);

static PIPE_TX: OnceLock<Arc<Mutex<Option<mpsc::UnboundedSender<CaptureMsg>>>>> = OnceLock::new();
static CAPTURE_SHUTDOWN: OnceLock<Arc<Mutex<Option<std::sync::mpsc::Sender<()>>>>> =
    OnceLock::new();

pub fn get_pipe_tx() -> &'static Arc<Mutex<Option<mpsc::UnboundedSender<CaptureMsg>>>> {
    PIPE_TX.get_or_init(|| Arc::new(Mutex::new(None)))
}

pub fn get_capture_shutdown() -> &'static Arc<Mutex<Option<std::sync::mpsc::Sender<()>>>> {
    CAPTURE_SHUTDOWN.get_or_init(|| Arc::new(Mutex::new(None)))
}

pub fn emit_service_status(app: &tauri::AppHandle, status: &str, message: &str) {
    let _ = app.emit(
        "voice_assistant:service_status",
        serde_json::json!({ "status": status, "message": message }),
    );
}

/// Derive the ONE status the user sees from component health. The pipeline
/// is usable as long as ASR works: without TTS we degrade to text-only
/// replies instead of failing, and recover automatically when TTS returns.
pub fn emit_pipeline_status(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;

    if !SERVICE_ACTIVE.load(Ordering::SeqCst) || !ASR_OK.load(Ordering::SeqCst) {
        return; // transitional states are emitted by the ASR session itself
    }

    if TTS_OK.load(Ordering::SeqCst) {
        emit_service_status(app, "ready", "语音服务就绪");
    } else {
        emit_service_status(
            app,
            "degraded",
            "语音合成未连接：回复将只显示文字，不播放语音。启动 TTS 服务（端口 8766）后自动恢复。",
        );
    }
}

pub fn emit_speech_start(app: &tauri::AppHandle) {
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
}

pub fn emit_speech_end(app: &tauri::AppHandle) {
    let _ = app.emit(
        "voice_assistant:vad_status",
        VadEvent {
            status: "speech_end".to_string(),
        },
    );
    let _ = app.emit(
        "voice_assistant:state_changed",
        serde_json::json!({ "state": "FinalizingASR" }),
    );
}

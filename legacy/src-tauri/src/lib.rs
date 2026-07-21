mod audio;
mod conversation;
mod inference;
mod llm;

use audio::capture::{
    close_mic, is_recording, is_service_active, open_mic, set_vad_mode, start_voice_service,
    stop_voice_service,
};
use audio::playback::{
    init_playback, is_playback_active, pause_playback, queue_playback_audio, resume_playback,
    start_playback, stop_playback,
};
use conversation::{
    add_assistant_message, add_user_message, get_conversation_history, get_conversation_status,
    is_conversation_active, transition_conversation_status, ConversationState,
};
use inference::client::{test_asr_connection, test_tts_connection};
use llm::{send_llm_request, stream_llm_response, LlmClient};
use std::sync::{Arc, Mutex};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 加载 .env 文件（如果存在）
    if let Err(e) = dotenvy::dotenv() {
        eprintln!("Warning: Failed to load .env file: {}. Using system environment variables.", e);
    }

    let conversation_state = Arc::new(Mutex::new(ConversationState::new()));
    let llm_client = Arc::new(Mutex::new(
        LlmClient::new().unwrap_or_else(|e| {
            eprintln!("Warning: Failed to create LLM client: {}. LLM features will not work.", e);
            panic!("LLM client required");
        }),
    ));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(conversation_state)
        .manage(llm_client)
        .setup(|app| {
            // Initialize playback with app handle for event emission
            init_playback(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            start_voice_service,
            stop_voice_service,
            open_mic,
            close_mic,
            set_vad_mode,
            is_recording,
            is_service_active,
            queue_playback_audio,
            start_playback,
            stop_playback,
            pause_playback,
            resume_playback,
            is_playback_active,
            get_conversation_history,
            get_conversation_status,
            is_conversation_active,
            transition_conversation_status,
            add_user_message,
            add_assistant_message,
            send_llm_request,
            stream_llm_response,
            test_asr_connection,
            test_tts_connection
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

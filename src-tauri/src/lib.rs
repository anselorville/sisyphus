mod audio;
mod conversation;
mod inference;
mod llm;

use audio::capture::AudioCapture;
use audio::playback::AudioPlayback;
use conversation::ConversationState;
use llm::LlmClient;
use std::sync::Arc;
use tauri::Manager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let audio_capture = Arc::new(Mutex::new(AudioCapture::new().expect("Failed to create audio capture")));
    let audio_playback = Arc::new(Mutex::new(AudioPlayback::new()));
    let conversation_state = Arc::new(Mutex::new(ConversationState::new()));
    let llm_client = Arc::new(Mutex::new(LlmClient::new().expect("Failed to create LLM client")));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(audio_capture)
        .manage(audio_playback)
        .manage(conversation_state)
        .manage(llm_client)
        .invoke_handler(tauri::generate_handler![
            greet,
            start_recording,
            stop_recording,
            is_recording,
            queue_playback_audio,
            start_playback,
            stop_playback,
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

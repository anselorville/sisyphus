// WebRTC (RTCPeerConnection, getUserMedia, data channels) and all
// translation logic happen entirely in the webview via standard browser
// APIs -- see client/src/hooks/useTranslatorConnection.ts. This Rust shell
// intentionally has no custom commands.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

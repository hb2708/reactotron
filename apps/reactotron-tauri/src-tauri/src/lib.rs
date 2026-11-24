mod commands;
pub mod server;

use std::sync::Arc;

use server::{start_server, ServerState, TauriEventSink, DEFAULT_BIND_ADDR, DEFAULT_PORT};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let server_state = Arc::new(ServerState::new(DEFAULT_PORT));
    let setup_state = Arc::clone(&server_state);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(server_state)
        .setup(move |app| {
            let handle = app.handle().clone();
            let state = Arc::clone(&setup_state);
            let sink = Arc::new(TauriEventSink::new(handle));

            tauri::async_runtime::spawn(async move {
                if let Err(err) = start_server(state, sink).await {
                    eprintln!("Reactotron server failed to bind {DEFAULT_BIND_ADDR}: {err}");
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_server_state,
            commands::send_command,
            commands::set_max_payload_bytes,
            commands::open_in_editor,
            commands::read_local_file,
            commands::export_timeline_log,
            commands::ipc_noop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Reactotron Tauri application");
}

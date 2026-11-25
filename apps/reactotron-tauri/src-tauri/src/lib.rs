mod adb;
mod commands;
pub mod mcp;
pub mod payload_store;
pub mod server;

use std::sync::Arc;

use tauri::menu::{
    CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri_plugin_opener::OpenerExt;

use mcp::McpHandle;
use server::{EventSink, ServerHandle, ServerState, TauriEventSink, DEFAULT_PORT};

fn initial_lan_enabled() -> bool {
    !matches!(
        std::env::var("REACTOTRON_HOST").as_deref(),
        Ok("127.0.0.1") | Ok("localhost") | Ok("::1")
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let lan_enabled = initial_lan_enabled();
    let server_state = Arc::new(ServerState::new(DEFAULT_PORT));
    let server_handle = Arc::new(ServerHandle::new(lan_enabled));
    let mcp_handle = Arc::new(McpHandle::new());

    let setup_state = Arc::clone(&server_state);
    let setup_handle = Arc::clone(&server_handle);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(server_state)
        .manage(server_handle)
        .manage(mcp_handle)
        .setup(move |app| {
            use tauri::Manager;

            let handle = app.handle().clone();
            let sink: Arc<dyn EventSink> = Arc::new(TauriEventSink::new(handle.clone()));
            app.manage(Arc::clone(&sink));

            let lan_menu_item = CheckMenuItemBuilder::with_id(
                "toggle-lan-bind",
                "Allow LAN Connections (0.0.0.0)",
            )
            .checked(lan_enabled)
            .build(app)?;

            let app_submenu = SubmenuBuilder::new(app, "Reactotron Tauri")
                .item(&PredefinedMenuItem::about(app, None, None)?)
                .separator()
                .item(&PredefinedMenuItem::hide(app, None)?)
                .item(&PredefinedMenuItem::hide_others(app, None)?)
                .item(&PredefinedMenuItem::show_all(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::quit(app, None)?)
                .build()?;

            let edit_submenu = SubmenuBuilder::new(app, "Edit")
                .item(&PredefinedMenuItem::undo(app, None)?)
                .item(&PredefinedMenuItem::redo(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(app, None)?)
                .item(&PredefinedMenuItem::copy(app, None)?)
                .item(&PredefinedMenuItem::paste(app, None)?)
                .item(&PredefinedMenuItem::select_all(app, None)?)
                .build()?;

            let server_submenu = SubmenuBuilder::new(app, "Server")
                .item(&lan_menu_item)
                .build()?;

            let window_submenu = SubmenuBuilder::new(app, "Window")
                .item(&PredefinedMenuItem::minimize(app, None)?)
                .item(&PredefinedMenuItem::maximize(app, None)?)
                .item(&PredefinedMenuItem::close_window(app, None)?)
                .build()?;

            let docs_item = MenuItemBuilder::with_id("help-docs", "GitHub Docs").build(app)?;
            let issue_item = MenuItemBuilder::with_id("help-issue", "Report Issue").build(app)?;
            let releases_item = MenuItemBuilder::with_id("help-releases", "Releases").build(app)?;
            let help_submenu = SubmenuBuilder::new(app, "Help")
                .item(&docs_item)
                .item(&issue_item)
                .item(&releases_item)
                .build()?;

            let menu = MenuBuilder::new(app)
                .items(&[
                    &app_submenu,
                    &edit_submenu,
                    &server_submenu,
                    &window_submenu,
                    &help_submenu,
                ])
                .build()?;
            app.set_menu(menu)?;

            let menu_lan_item = lan_menu_item.clone();
            app.on_menu_event(move |app_handle, event| match event.id().as_ref() {
                "toggle-lan-bind" => {
                    let state = app_handle.state::<Arc<ServerState>>().inner().clone();
                    let srv_handle = app_handle.state::<Arc<ServerHandle>>().inner().clone();
                    let srv_sink = app_handle.state::<Arc<dyn EventSink>>().inner().clone();
                    let next_lan = !srv_handle.is_lan_enabled();
                    let item = menu_lan_item.clone();

                    tauri::async_runtime::spawn(async move {
                        match srv_handle.restart_with_mode(next_lan, state, srv_sink).await {
                            Ok(_) => {
                                let _ = item.set_checked(next_lan);
                            }
                            Err(err) => {
                                eprintln!("Failed to toggle LAN bind mode: {err}");
                                let _ = item.set_checked(srv_handle.is_lan_enabled());
                            }
                        }
                    });
                }
                "help-docs" => {
                    let _ = app_handle
                        .opener()
                        .open_url("https://github.com/infinitered/reactotron", None::<&str>);
                }
                "help-issue" => {
                    let _ = app_handle.opener().open_url(
                        "https://github.com/infinitered/reactotron/issues/new",
                        None::<&str>,
                    );
                }
                "help-releases" => {
                    let _ = app_handle.opener().open_url(
                        "https://github.com/infinitered/reactotron/releases",
                        None::<&str>,
                    );
                }
                _ => {}
            });

            let start_state = Arc::clone(&setup_state);
            let start_handle = Arc::clone(&setup_handle);
            let start_sink = Arc::clone(&sink);
            tauri::async_runtime::spawn(async move {
                if let Err(err) = start_handle
                    .start_with_mode(lan_enabled, start_state, start_sink)
                    .await
                {
                    eprintln!("Reactotron server failed to start: {err}");
                }
            });

            adb::spawn_adb_tracker(handle);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_server_state,
            commands::send_command,
            commands::set_max_payload_bytes,
            commands::set_bind_mode,
            commands::open_in_editor,
            commands::read_local_file,
            commands::export_timeline_log,
            commands::get_command_payload,
            commands::clear_payload_store,
            commands::search_command_payloads,
            commands::start_mcp_server,
            commands::stop_mcp_server,
            commands::ipc_noop,
            adb::adb_list_devices,
            adb::adb_reverse_tunnel,
            adb::adb_reload_app,
            adb::adb_shake_device,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Reactotron Tauri application");
}

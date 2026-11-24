use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use chrono::Utc;
use serde_json::Value;
use tauri::State;

use crate::server::{send_command as relay_send_command, ServerState, ServerStateSnapshot};

const MAX_READ_FILE_BYTES: u64 = 1024 * 1024;

#[tauri::command]
pub async fn get_server_state(state: State<'_, Arc<ServerState>>) -> Result<ServerStateSnapshot, String> {
    Ok(state.snapshot().await)
}

#[tauri::command]
pub async fn send_command(
    state: State<'_, Arc<ServerState>>,
    command_type: String,
    payload: Option<Value>,
    client_id: Option<String>,
) -> Result<usize, String> {
    relay_send_command(
        &state,
        &command_type,
        payload.unwrap_or(Value::Null),
        client_id.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn set_max_payload_bytes(
    state: State<'_, Arc<ServerState>>,
    max_bytes: usize,
) -> Result<(), String> {
    if max_bytes < 1024 {
        return Err("maxBytes must be at least 1024 bytes".to_string());
    }
    state.max_payload_bytes.store(max_bytes, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn open_in_editor(file: String, line_number: Option<u64>) -> Result<(), String> {
    let trimmed = file.trim();
    if trimmed.is_empty() {
        return Err("Empty file path".to_string());
    }

    let line = line_number.unwrap_or(1);
    let target_with_line = format!("{trimmed}:{line}");

    let editor = std::env::var("REACT_EDITOR")
        .or_else(|_| std::env::var("EDITOR"))
        .unwrap_or_default();

    let spawn_result = if !editor.trim().is_empty() {
        let bin = editor.split_whitespace().next().unwrap_or("code");
        if bin.ends_with("code") || bin.ends_with("cursor") {
            Command::new(bin).arg("-g").arg(&target_with_line).spawn()
        } else {
            Command::new(bin).arg(trimmed).spawn()
        }
    } else if let Ok(child) = Command::new("code").arg("-g").arg(&target_with_line).spawn() {
        Ok(child)
    } else {
        #[cfg(target_os = "macos")]
        {
            Command::new("open").arg(trimmed).spawn()
        }
        #[cfg(target_os = "linux")]
        {
            Command::new("xdg-open").arg(trimmed).spawn()
        }
        #[cfg(target_os = "windows")]
        {
            Command::new("cmd").args(["/C", "start", "", trimmed]).spawn()
        }
    };

    spawn_result
        .map(|_| ())
        .map_err(|e| format!("Failed to open file in editor: {e}"))
}

#[tauri::command]
pub async fn read_local_file(path: String) -> Result<String, String> {
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("Cannot read file metadata: {e}"))?;
    if meta.len() > MAX_READ_FILE_BYTES {
        return Err("Source file exceeds 1 MB limit".to_string());
    }
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read file: {e}"))
}

#[tauri::command]
pub async fn export_timeline_log(
    contents: String,
    file_path: Option<String>,
) -> Result<String, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "Could not resolve home directory".to_string())?;
    let downloads = PathBuf::from(home).join("Downloads");
    tokio::fs::create_dir_all(&downloads)
        .await
        .map_err(|e| format!("Failed to ensure Downloads directory: {e}"))?;

    let filename = file_path
        .as_deref()
        .and_then(|p| std::path::Path::new(p).file_name())
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("timeline-log-{}.json", Utc::now().timestamp_millis()));

    let target = downloads.join(filename);
    tokio::fs::write(&target, contents)
        .await
        .map_err(|e| format!("Failed to write export file: {e}"))?;

    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn ipc_noop(_channel: String, _args: Option<Value>) -> Result<(), String> {
    Ok(())
}

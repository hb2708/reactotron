use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use chrono::Utc;
use serde_json::Value;
use tauri::State;

use crate::mcp::{McpHandle, DEFAULT_MCP_PORT};
use crate::server::{
    send_command as relay_send_command, EventSink, ServerHandle, ServerState, ServerStateSnapshot,
};

const MAX_READ_FILE_BYTES: u64 = 1024 * 1024;

const ALLOWED_SOURCE_EXTENSIONS: &[&str] = &[
    "js", "jsx", "ts", "tsx", "mjs", "cjs", "json", "swift", "m", "mm", "h", "kt", "java", "dart",
    "rs", "css", "scss", "html", "md", "txt", "yaml", "yml", "xml", "gradle", "podspec",
];

const BLOCKED_PATH_PARTS: &[&str] = &[
    ".ssh",
    ".aws",
    ".gnupg",
    "keychains",
    ".env",
    "id_rsa",
    "id_ed25519",
    "credentials",
    ".npmrc",
    ".netrc",
];

pub fn validate_readable_source_path(path: &Path) -> Result<(), String> {
    for comp in path.components() {
        if let Component::Normal(os_str) = comp {
            let lower = os_str.to_string_lossy().to_ascii_lowercase();
            if BLOCKED_PATH_PARTS.iter().any(|b| lower == *b || lower.starts_with(".env.")) {
                return Err("Access to sensitive path blocked".to_string());
            }
        }
    }

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .ok_or_else(|| "File extension required for source preview".to_string())?;

    if !ALLOWED_SOURCE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!("Unsupported source file extension: .{ext}"));
    }

    Ok(())
}

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
    let canonical = tokio::fs::canonicalize(&path)
        .await
        .map_err(|e| format!("Cannot resolve source file path: {e}"))?;
    validate_readable_source_path(&canonical)?;

    let meta = tokio::fs::metadata(&canonical)
        .await
        .map_err(|e| format!("Cannot read file metadata: {e}"))?;
    if !meta.is_file() {
        return Err("Target path is not a regular file".to_string());
    }
    if meta.len() > MAX_READ_FILE_BYTES {
        return Err("Source file exceeds 1 MB limit".to_string());
    }
    tokio::fs::read_to_string(&canonical)
        .await
        .map_err(|e| format!("Failed to read file: {e}"))
}

#[tauri::command]
pub async fn export_timeline_log(
    state: State<'_, Arc<ServerState>>,
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

    // Hydrate any offloaded payloads from SQLite so exported JSON is 100% lossless.
    let final_contents = if let Ok(mut parsed) = serde_json::from_str::<Value>(&contents) {
        if let Some(arr) = parsed.as_array_mut() {
            if let Ok(stored) = state.payload_store.get_all_payloads() {
                for item in arr.iter_mut() {
                    let is_offloaded = item
                        .get("payloadOffloaded")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    if !is_offloaded {
                        continue;
                    }
                    if let Some(msg_id) = item.get("messageId").and_then(|v| v.as_u64()) {
                        if let Some(raw_json) = stored.get(&msg_id) {
                            if let Ok(full_payload) = serde_json::from_str::<Value>(raw_json) {
                                if let Some(obj) = item.as_object_mut() {
                                    obj.insert("payload".to_string(), full_payload);
                                    obj.remove("payloadOffloaded");
                                }
                            }
                        }
                    }
                }
            }
            serde_json::to_string(&parsed).unwrap_or(contents)
        } else {
            contents
        }
    } else {
        contents
    };

    let target = downloads.join(filename);
    tokio::fs::write(&target, final_contents)
        .await
        .map_err(|e| format!("Failed to write export file: {e}"))?;

    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn get_command_payload(
    state: State<'_, Arc<ServerState>>,
    message_id: u64,
) -> Result<Option<Value>, String> {
    match state.payload_store.get_payload(message_id)? {
        Some(raw) => {
            let val: Value = serde_json::from_str(&raw)
                .map_err(|e| format!("Failed to parse stored payload: {e}"))?;
            Ok(Some(val))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn clear_payload_store(
    state: State<'_, Arc<ServerState>>,
    client_id: Option<String>,
) -> Result<usize, String> {
    state.payload_store.clear(client_id.as_deref())
}

#[tauri::command]
pub async fn search_command_payloads(
    state: State<'_, Arc<ServerState>>,
    query: String,
    client_id: Option<String>,
) -> Result<Vec<u64>, String> {
    state
        .payload_store
        .search_message_ids(&query, client_id.as_deref())
}

#[tauri::command]
pub async fn start_mcp_server(
    state: State<'_, Arc<ServerState>>,
    mcp: State<'_, Arc<McpHandle>>,
    port: Option<u16>,
) -> Result<(), String> {
    mcp.start(port.unwrap_or(DEFAULT_MCP_PORT), Arc::clone(&state))
        .await
}

#[tauri::command]
pub async fn stop_mcp_server(mcp: State<'_, Arc<McpHandle>>) -> Result<(), String> {
    mcp.stop().await;
    Ok(())
}

#[tauri::command]
pub async fn set_bind_mode(
    lan_enabled: bool,
    state: State<'_, Arc<ServerState>>,
    handle: State<'_, Arc<ServerHandle>>,
    sink: State<'_, Arc<dyn EventSink>>,
) -> Result<bool, String> {
    handle
        .restart_with_mode(lan_enabled, Arc::clone(&state), Arc::clone(&sink))
        .await
        .map_err(|e| format!("Failed to switch bind mode: {e}"))?;
    Ok(lan_enabled)
}

#[tauri::command]
pub async fn ipc_noop(_channel: String, _args: Option<Value>) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_path_validation() {
        assert!(validate_readable_source_path(Path::new("/tmp/project/src/App.tsx")).is_ok());
        assert!(validate_readable_source_path(Path::new("/tmp/project/ios/AppDelegate.mm")).is_ok());
        assert!(validate_readable_source_path(Path::new("/Users/me/.ssh/id_rsa")).is_err());
        assert!(validate_readable_source_path(Path::new("/tmp/project/.env")).is_err());
        assert!(validate_readable_source_path(Path::new("/tmp/project/.env.local")).is_err());
        assert!(validate_readable_source_path(Path::new("/tmp/project/data.db")).is_err());
    }
}

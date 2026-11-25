use std::process::Stdio;

use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

pub fn validate_device_id(id: &str) -> Result<&str, String> {
    let trimmed = id.trim();
    if trimmed.is_empty() || trimmed.len() > 128 {
        return Err("Invalid Android device id".to_string());
    }
    if trimmed.starts_with('-') {
        return Err("Invalid Android device id".to_string());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '_' | '-'))
    {
        return Err("Android device id contains disallowed characters".to_string());
    }
    Ok(trimmed)
}

async fn run_adb(args: &[&str]) -> Result<String, String> {
    let output = Command::new("adb")
        .args(args)
        .output()
        .await
        .map_err(|e| format!("Failed to invoke adb: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("adb {:?} failed: {}", args, stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
pub async fn adb_list_devices() -> Result<String, String> {
    match Command::new("adb").arg("devices").output().await {
        Ok(output) if output.status.success() => {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        }
        Ok(_) | Err(_) => Ok("List of devices attached\n".to_string()),
    }
}

#[tauri::command]
pub async fn adb_reverse_tunnel(
    device_id: String,
    reactotron_port: u16,
    metro_port: u16,
) -> Result<(), String> {
    let safe_id = validate_device_id(&device_id)?;
    let tron_spec = format!("tcp:{reactotron_port}");
    let metro_spec = format!("tcp:{metro_port}");

    run_adb(&["-s", safe_id, "reverse", &tron_spec, &tron_spec]).await?;
    run_adb(&["-s", safe_id, "reverse", &metro_spec, &metro_spec]).await?;
    Ok(())
}

#[tauri::command]
pub async fn adb_reload_app(device_id: String) -> Result<(), String> {
    let safe_id = validate_device_id(&device_id)?;
    run_adb(&["-s", safe_id, "shell", "input", "text", "RR"]).await?;
    Ok(())
}

#[tauri::command]
pub async fn adb_shake_device(device_id: String) -> Result<(), String> {
    let safe_id = validate_device_id(&device_id)?;
    run_adb(&["-s", safe_id, "shell", "input", "keyevent", "82"]).await?;
    Ok(())
}

pub fn spawn_adb_tracker(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut child = match Command::new("adb")
            .arg("track-devices")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(_) => return,
        };

        let Some(stdout) = child.stdout.take() else {
            return;
        };

        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if let Ok(devices) = adb_list_devices().await {
                        let _ = app.emit("reactotron://adb-device-list", devices);
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_id_validation() {
        assert_eq!(validate_device_id("emulator-5554").unwrap(), "emulator-5554");
        assert_eq!(
            validate_device_id("192.168.1.5:5555").unwrap(),
            "192.168.1.5:5555"
        );
        assert_eq!(validate_device_id("R5CR1234ABC").unwrap(), "R5CR1234ABC");

        assert!(validate_device_id("").is_err());
        assert!(validate_device_id("-evil").is_err());
        assert!(validate_device_id("emulator-5554; rm -rf /").is_err());
        assert!(validate_device_id("../etc/passwd").is_err());
    }
}

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex};

use crate::server::{send_command as relay_send_command, ServerState};

pub const DEFAULT_MCP_PORT: u16 = 4567;

pub struct McpHandle {
    shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
}

impl McpHandle {
    pub fn new() -> Self {
        Self {
            shutdown_tx: Mutex::new(None),
        }
    }

    pub async fn start(&self, port: u16, state: Arc<ServerState>) -> Result<(), String> {
        self.stop().await;
        let bind_addr = format!("127.0.0.1:{port}");
        let listener = TcpListener::bind(&bind_addr)
            .await
            .map_err(|e| format!("Failed to bind MCP server on {bind_addr}: {e}"))?;

        let (tx, mut rx) = oneshot::channel::<()>();
        *self.shutdown_tx.lock().await = Some(tx);

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut rx => break,
                    accept_res = listener.accept() => {
                        match accept_res {
                            Ok((stream, _)) => {
                                let state_clone = Arc::clone(&state);
                                tokio::spawn(async move {
                                    let _ = handle_http_connection(stream, state_clone).await;
                                });
                            }
                            Err(_) => break,
                        }
                    }
                }
            }
        });

        Ok(())
    }

    pub async fn stop(&self) {
        if let Some(tx) = self.shutdown_tx.lock().await.take() {
            let _ = tx.send(());
        }
    }
}

async fn handle_http_connection(
    mut stream: TcpStream,
    state: Arc<ServerState>,
) -> Result<(), String> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];

    // Read headers
    let header_end = loop {
        let n = stream.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        if buf.len() > 64 * 1024 {
            return Ok(());
        }
    };

    let (method, path, content_length) = {
        let header_str = String::from_utf8_lossy(&buf[..header_end]);
        let mut lines = header_str.lines();
        let request_line = lines.next().unwrap_or_default();
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or_default().to_string();
        let path = parts.next().unwrap_or_default().to_string();

        let content_length: usize = lines
            .find_map(|line| {
                let (k, v) = line.split_once(':')?;
                if k.eq_ignore_ascii_case("content-length") {
                    v.trim().parse::<usize>().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0);
        (method, path, content_length)
    };

    // Read remaining body bytes
    while buf.len() < header_end + content_length {
        let n = stream.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }

    if method == "OPTIONS" {
        write_response(&mut stream, 204, "text/plain", "").await?;
        return Ok(());
    }

    if method != "POST" || (path != "/mcp" && path != "/") {
        write_response(&mut stream, 404, "application/json", r#"{"error":"Not Found"}"#).await?;
        return Ok(());
    }

    let body = &buf[header_end..std::cmp::min(buf.len(), header_end + content_length)];
    let req: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => {
            let err = json!({
                "jsonrpc": "2.0",
                "id": Value::Null,
                "error": { "code": -32700, "message": format!("Parse error: {e}") }
            });
            write_response(&mut stream, 400, "application/json", &err.to_string()).await?;
            return Ok(());
        }
    };

    let id = req.get("id").cloned();
    let rpc_method = req.get("method").and_then(|m| m.as_str()).unwrap_or_default();
    let params = req.get("params").cloned().unwrap_or_else(|| json!({}));

    if rpc_method.starts_with("notifications/") || id.is_none() {
        write_response(&mut stream, 202, "text/plain", "").await?;
        return Ok(());
    }

    let resp = dispatch_rpc(id.unwrap(), rpc_method, params, &state).await;
    let sse = format!("event: message\ndata: {}\n\n", resp);
    write_response(&mut stream, 200, "text/event-stream", &sse).await?;
    Ok(())
}

async fn write_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &str,
) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Internal Server Error",
    };
    let resp = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: POST, OPTIONS\r\n\
         Access-Control-Allow-Headers: Content-Type, Accept, Mcp-Session-Id\r\n\
         Connection: close\r\n\r\n\
         {body}",
        body.len()
    );
    stream
        .write_all(resp.as_bytes())
        .await
        .map_err(|e| e.to_string())
}

async fn dispatch_rpc(
    id: Value,
    method: &str,
    params: Value,
    state: &Arc<ServerState>,
) -> Value {
    match method {
        "initialize" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {}, "resources": {} },
                "serverInfo": { "name": "reactotron-tauri-mcp", "version": "0.1.0" }
            }
        }),
        "tools/list" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "tools": [
                    {
                        "name": "clear_timeline",
                        "description": "Clear stored timeline events in Reactotron.",
                        "inputSchema": { "type": "object", "properties": { "clientId": { "type": "string" } } }
                    },
                    {
                        "name": "dispatch_action",
                        "description": "Dispatch a Redux action to the connected app.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "actionType": { "type": "string" },
                                "actionPayload": {},
                                "clientId": { "type": "string" }
                            },
                            "required": ["actionType"]
                        }
                    },
                    {
                        "name": "request_state",
                        "description": "Request a state snapshot from the connected app.",
                        "inputSchema": {
                            "type": "object",
                            "properties": { "path": { "type": "string" }, "clientId": { "type": "string" } }
                        }
                    },
                    {
                        "name": "request_state_keys",
                        "description": "Request state keys at a path from the connected app.",
                        "inputSchema": {
                            "type": "object",
                            "properties": { "path": { "type": "string" }, "clientId": { "type": "string" } }
                        }
                    },
                    {
                        "name": "send_custom_command",
                        "description": "Invoke a registered custom command on the connected app.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "command": { "type": "string" },
                                "args": {},
                                "clientId": { "type": "string" }
                            },
                            "required": ["command"]
                        }
                    }
                ]
            }
        }),
        "tools/call" => {
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or_default();
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let client_id = args.get("clientId").and_then(|v| v.as_str());
            let result_text = match name {
                "clear_timeline" => match state.payload_store.clear(client_id) {
                    Ok(removed) => json!({ "status": "cleared", "eventsRemoved": removed }).to_string(),
                    Err(e) => json!({ "error": e }).to_string(),
                },
                "dispatch_action" => {
                    let action_type = args.get("actionType").and_then(|v| v.as_str()).unwrap_or_default();
                    let action = match args.get("actionPayload") {
                        Some(p) => json!({ "type": action_type, "payload": p }),
                        None => json!({ "type": action_type }),
                    };
                    match relay_send_command(state, "state.action.dispatch", json!({ "action": action }), client_id).await {
                        Ok(sent) => json!({ "status": "dispatched", "sentTo": sent }).to_string(),
                        Err(e) => json!({ "error": e }).to_string(),
                    }
                }
                "request_state" => {
                    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or_default();
                    match relay_send_command(state, "state.values.request", json!({ "path": path }), client_id).await {
                        Ok(sent) => json!({ "status": "requested", "sentTo": sent }).to_string(),
                        Err(e) => json!({ "error": e }).to_string(),
                    }
                }
                "request_state_keys" => {
                    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or_default();
                    match relay_send_command(state, "state.keys.request", json!({ "path": path }), client_id).await {
                        Ok(sent) => json!({ "status": "requested", "sentTo": sent }).to_string(),
                        Err(e) => json!({ "error": e }).to_string(),
                    }
                }
                "send_custom_command" => {
                    let command = args.get("command").and_then(|v| v.as_str()).unwrap_or_default();
                    let cmd_args = args.get("args").cloned().unwrap_or(Value::Null);
                    match relay_send_command(state, "custom", json!({ "command": command, "args": cmd_args }), client_id).await {
                        Ok(sent) => json!({ "status": "sent", "sentTo": sent }).to_string(),
                        Err(e) => json!({ "error": e }).to_string(),
                    }
                }
                _ => json!({ "error": format!("Unknown tool: {name}") }).to_string(),
            };
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "content": [{ "type": "text", "text": result_text }] }
            })
        }
        "resources/list" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "resources": [
                    { "uri": "reactotron://timeline", "name": "Timeline", "mimeType": "application/json" },
                    { "uri": "reactotron://timeline/log", "name": "Logs", "mimeType": "application/json" },
                    { "uri": "reactotron://timeline/asyncStorage.mutation", "name": "AsyncStorage Mutations", "mimeType": "application/json" },
                    { "uri": "reactotron://network/log", "name": "Network Log", "mimeType": "application/json" },
                    { "uri": "reactotron://benchmarks", "name": "Benchmarks", "mimeType": "application/json" },
                    { "uri": "reactotron://apps", "name": "Connected Apps", "mimeType": "application/json" }
                ]
            }
        }),
        "resources/read" => {
            let uri = params.get("uri").and_then(|v| v.as_str()).unwrap_or_default();
            let text = match uri {
                "reactotron://apps" => {
                    let snap = state.snapshot().await;
                    json!({ "apps": snap.connections }).to_string()
                }
                "reactotron://timeline" => build_events_json(state, None),
                "reactotron://timeline/log" => build_events_json(state, Some("log")),
                "reactotron://timeline/asyncStorage.mutation" => {
                    build_events_json(state, Some("asyncStorage.mutation"))
                }
                "reactotron://network/log" => build_events_json(state, Some("api.response")),
                "reactotron://benchmarks" => build_events_json(state, Some("benchmark.report")),
                _ => json!({ "error": format!("Unknown resource: {uri}") }).to_string(),
            };
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "contents": [{ "uri": uri, "mimeType": "application/json", "text": text }]
                }
            })
        }
        _ => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("Method not found: {method}") }
        }),
    }
}

const SENSITIVE_KEYS: &[&str] = &[
    "password",
    "passwd",
    "pwd",
    "secret",
    "client_secret",
    "clientsecret",
    "credentials",
    "ssn",
    "creditcard",
    "privatekey",
    "private_key",
    "apikey",
    "api_key",
    "x-api-key",
    "accesstoken",
    "access_token",
    "refreshtoken",
    "refresh_token",
    "idtoken",
    "id_token",
    "token",
    "bearer",
    "jwt",
    "session",
    "sessionid",
    "session_id",
    "csrf",
    "xsrf",
    "csrf_token",
    "xsrf_token",
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-auth-token",
    "x-csrf-token",
    "x-xsrf-token",
    "csrf-token",
    "x-forwarded-for",
    "x-real-ip",
];

fn redact_value(val: &mut Value) {
    match val {
        Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                let lower = k.to_lowercase();
                if SENSITIVE_KEYS.iter().any(|sk| *sk == lower) {
                    *v = Value::String("[REDACTED]".to_string());
                } else {
                    redact_value(v);
                }
            }
        }
        Value::Array(arr) => {
            for item in arr.iter_mut() {
                redact_value(item);
            }
        }
        _ => {}
    }
}

fn build_events_json(state: &ServerState, command_type: Option<&str>) -> String {
    let rows = state.payload_store.list_events(command_type).unwrap_or_default();
    let events: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            let mut payload: Value = serde_json::from_str(&r.payload_json).unwrap_or(Value::Null);
            redact_value(&mut payload);
            json!({
                "messageId": r.message_id,
                "clientId": r.client_id,
                "type": r.command_type,
                "date": r.date,
                "deltaTime": r.delta_time,
                "important": r.important,
                "payload": payload
            })
        })
        .collect();
    json!({
        "eventCount": events.len(),
        "events": events
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mcp_lists_and_reads_timeline_from_sqlite() {
        let state = Arc::new(ServerState::new(0));
        state
            .payload_store
            .insert_event(
                1,
                Some("c1"),
                "log",
                "2026-01-01T00:00:00Z",
                0.0,
                false,
                r#"{"message":"hi","password":"secret123","headers":{"Authorization":"Bearer xyz"}}"#,
            )
            .unwrap();

        let resp = dispatch_rpc(
            json!(1),
            "resources/read",
            json!({ "uri": "reactotron://timeline" }),
            &state,
        )
        .await;
        let text = resp["result"]["contents"][0]["text"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(text).unwrap();
        assert_eq!(parsed["eventCount"], 1);
        assert_eq!(parsed["events"][0]["payload"]["message"], "hi");
        assert_eq!(parsed["events"][0]["payload"]["password"], "[REDACTED]");
        assert_eq!(
            parsed["events"][0]["payload"]["headers"]["Authorization"],
            "[REDACTED]"
        );
    }
}

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, RwLock};
use tokio_tungstenite::{accept_async, tungstenite::Message};
use uuid::Uuid;

pub const DEFAULT_PORT: u16 = 9090;
pub const DEFAULT_BIND_ADDR: &str = "0.0.0.0:9090";
pub const LOOPBACK_V6_ADDR: &str = "[::1]:9090";
pub const DEFAULT_MAX_PAYLOAD_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ServerStatus {
    Stopped,
    Started,
    PortUnavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactotronConnection {
    pub id: u64,
    pub client_id: String,
    pub address: String,
    #[serde(default)]
    pub platform: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_release: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboundCommandEvent {
    #[serde(rename = "type")]
    pub command_type: String,
    pub connection_id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    pub date: String,
    pub delta_time: f64,
    pub important: bool,
    pub message_id: u64,
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStateSnapshot {
    pub status: ServerStatus,
    pub port: u16,
    pub connections: Vec<ReactotronConnection>,
    pub max_payload_bytes: usize,
}

pub struct ClientSession {
    pub connection_id: u64,
    pub metadata: ReactotronConnection,
    pub outbound_tx: mpsc::UnboundedSender<Message>,
}

pub struct ServerState {
    pub status: RwLock<ServerStatus>,
    pub port: AtomicU64,
    pub max_payload_bytes: AtomicUsize,
    pub next_connection_id: AtomicU64,
    pub next_message_id: AtomicU64,
    pub sessions: RwLock<HashMap<String, ClientSession>>,
    pub subscriptions: RwLock<Vec<String>>,
}

impl ServerState {
    pub fn new(port: u16) -> Self {
        Self {
            status: RwLock::new(ServerStatus::Stopped),
            port: AtomicU64::new(port as u64),
            max_payload_bytes: AtomicUsize::new(DEFAULT_MAX_PAYLOAD_BYTES),
            next_connection_id: AtomicU64::new(0),
            next_message_id: AtomicU64::new(0),
            sessions: RwLock::new(HashMap::new()),
            subscriptions: RwLock::new(Vec::new()),
        }
    }

    pub async fn snapshot(&self) -> ServerStateSnapshot {
        let status = *self.status.read().await;
        let connections = self
            .sessions
            .read()
            .await
            .values()
            .map(|s| s.metadata.clone())
            .collect();
        ServerStateSnapshot {
            status,
            port: self.port.load(Ordering::Relaxed) as u16,
            connections,
            max_payload_bytes: self.max_payload_bytes.load(Ordering::Relaxed),
        }
    }
}

pub trait EventSink: Send + Sync {
    fn emit_server_started(&self);
    fn emit_port_unavailable(&self);
    fn emit_connection_established(&self, conn: &ReactotronConnection);
    fn emit_disconnect(&self, conn: &ReactotronConnection);
    fn emit_command(&self, cmd: &OutboundCommandEvent);
}

pub struct TauriEventSink {
    app: AppHandle,
}

impl TauriEventSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl EventSink for TauriEventSink {
    fn emit_server_started(&self) {
        let _ = self.app.emit("reactotron://server-started", ());
    }

    fn emit_port_unavailable(&self) {
        let _ = self.app.emit("reactotron://port-unavailable", ());
    }

    fn emit_connection_established(&self, conn: &ReactotronConnection) {
        let _ = self.app.emit("reactotron://connection-established", conn);
    }

    fn emit_disconnect(&self, conn: &ReactotronConnection) {
        let _ = self.app.emit("reactotron://disconnect", conn);
    }

    fn emit_command(&self, cmd: &OutboundCommandEvent) {
        let _ = self.app.emit("reactotron://command", cmd);
    }
}

/// Restores Reactotron's sentinel strings back to JSON primitives.
/// Leaves `undefined`, `NaN`, `Infinity`, and `-Infinity` markers untouched so
/// `reactotron-core-ui` can resolve them on the JS side after IPC deserialization.
pub fn repair_serialization(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (_, v) in map.iter_mut() {
                repair_serialization(v);
            }
        }
        Value::Array(arr) => {
            for v in arr.iter_mut() {
                repair_serialization(v);
            }
        }
        Value::String(s) => {
            let lower = s.to_lowercase();
            match lower.as_str() {
                "~~~ null ~~~" => *value = Value::Null,
                "~~~ false ~~~" => *value = Value::Bool(false),
                "~~~ zero ~~~" => *value = json!(0),
                "~~~ empty string ~~~" => *value = Value::String(String::new()),
                "~~~ anonymous function ~~~" => *value = Value::String("fn()".to_string()),
                "~~~ undefined ~~~"
                | "~~~ nan ~~~"
                | "~~~ infinity ~~~"
                | "~~~ -infinity ~~~" => {}
                _ => {
                    if s.len() > 9 && s.starts_with("~~~ ") && s.ends_with(" ~~~") {
                        *s = s.replace("~~~", "");
                    }
                }
            }
        }
        _ => {}
    }
}

fn spawn_accept_loop(
    listener: TcpListener,
    state: Arc<ServerState>,
    sink: Arc<dyn EventSink>,
) {
    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, peer_addr)) => {
                    let conn_state = Arc::clone(&state);
                    let conn_sink = Arc::clone(&sink);
                    tokio::spawn(async move {
                        handle_connection(stream, peer_addr, conn_state, conn_sink).await;
                    });
                }
                Err(err) => {
                    eprintln!("WebSocket accept error: {err}");
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
        }
    });
}

pub async fn start_on(
    bind_addr: &str,
    state: Arc<ServerState>,
    sink: Arc<dyn EventSink>,
) -> Result<SocketAddr, std::io::Error> {
    let listener = match TcpListener::bind(bind_addr).await {
        Ok(l) => l,
        Err(err) => {
            *state.status.write().await = ServerStatus::PortUnavailable;
            sink.emit_port_unavailable();
            return Err(err);
        }
    };

    let local_addr = listener.local_addr()?;
    state.port.store(local_addr.port() as u64, Ordering::Relaxed);
    *state.status.write().await = ServerStatus::Started;
    sink.emit_server_started();

    spawn_accept_loop(listener, state, sink);

    Ok(local_addr)
}

pub async fn start_server(
    state: Arc<ServerState>,
    sink: Arc<dyn EventSink>,
) -> Result<SocketAddr, std::io::Error> {
    let v4_addr = start_on(DEFAULT_BIND_ADDR, Arc::clone(&state), Arc::clone(&sink)).await?;

    match TcpListener::bind(LOOPBACK_V6_ADDR).await {
        Ok(v6_listener) => spawn_accept_loop(v6_listener, state, sink),
        Err(err) => eprintln!("IPv6 loopback {LOOPBACK_V6_ADDR} unavailable: {err}"),
    }

    Ok(v4_addr)
}

async fn handle_connection(
    stream: TcpStream,
    peer_addr: SocketAddr,
    state: Arc<ServerState>,
    sink: Arc<dyn EventSink>,
) {
    let ws_stream = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(err) => {
            eprintln!("WebSocket handshake failed for {peer_addr}: {err}");
            return;
        }
    };

    let connection_id = state.next_connection_id.fetch_add(1, Ordering::Relaxed);
    let address = peer_addr.ip().to_string();
    let (mut ws_sink, mut ws_stream_rx) = ws_stream.split();
    let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<Message>();

    // Immediately sync active subscriptions upon socket connect (matches core-server).
    {
        let subs = state.subscriptions.read().await.clone();
        if let Ok(text) = serde_json::to_string(&json!({
            "type": "state.values.subscribe",
            "payload": { "paths": subs }
        })) {
            let _ = outbound_tx.send(Message::Text(text));
        }
    }

    let writer_task = tokio::spawn(async move {
        let mut keep_alive = tokio::time::interval(Duration::from_secs(30));
        keep_alive.tick().await;
        loop {
            tokio::select! {
                Some(msg) = outbound_rx.recv() => {
                    let is_close = matches!(msg, Message::Close(_));
                    if ws_sink.send(msg).await.is_err() || is_close {
                        break;
                    }
                }
                _ = keep_alive.tick() => {
                    if ws_sink.send(Message::Ping(Vec::new())).await.is_err() {
                        break;
                    }
                }
                else => break,
            }
        }
    });

    let mut active_client_id: Option<String> = None;

    while let Some(frame_res) = ws_stream_rx.next().await {
        let frame = match frame_res {
            Ok(f) => f,
            Err(_) => break,
        };

        let raw_text = match frame {
            Message::Text(txt) => txt,
            Message::Binary(bin) => match String::from_utf8(bin) {
                Ok(s) => s,
                Err(_) => continue,
            },
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
        };

        let max_bytes = state.max_payload_bytes.load(Ordering::Relaxed);
        if raw_text.len() > max_bytes {
            let message_id = state.next_message_id.fetch_add(1, Ordering::Relaxed) + 1;
            let truncated_event = OutboundCommandEvent {
                command_type: "log".to_string(),
                connection_id,
                client_id: active_client_id.clone(),
                date: Utc::now().to_rfc3339(),
                delta_time: 0.0,
                important: true,
                message_id,
                payload: json!({
                    "level": "warn",
                    "message": {
                        "warning": "Payload exceeded maxPayloadBytes limit and was truncated",
                        "originalBytes": raw_text.len(),
                        "maxBytes": max_bytes
                    }
                }),
                diff: None,
            };
            sink.emit_command(&truncated_event);
            continue;
        }

        let mut parsed: Value = match serde_json::from_str(&raw_text) {
            Ok(v) => v,
            Err(err) => {
                eprintln!("Invalid JSON payload from client {peer_addr}: {err}");
                continue;
            }
        };

        repair_serialization(&mut parsed);

        let command_type = parsed
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if command_type.is_empty() {
            continue;
        }

        let important = parsed
            .get("important")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let delta_time = parsed
            .get("deltaTime")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let date = parsed
            .get("date")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| Utc::now().to_rfc3339());
        let diff = parsed.get("diff").cloned().filter(|v| !v.is_null());
        let mut payload = parsed.get("payload").cloned().unwrap_or_else(|| json!({}));

        let message_id = state.next_message_id.fetch_add(1, Ordering::Relaxed) + 1;

        if command_type == "client.intro" {
            if let Some(obj) = payload.as_object_mut() {
                obj.insert("address".to_string(), Value::String(address.clone()));
            }

            let provided_client_id = payload
                .get("clientId")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());

            let assigned_client_id = match provided_client_id {
                Some(id) => id,
                None => {
                    let generated = Uuid::new_v4().to_string();
                    if let Ok(reply) = serde_json::to_string(&json!({
                        "type": "setClientId",
                        "payload": generated
                    })) {
                        let _ = outbound_tx.send(Message::Text(reply));
                    }
                    generated
                }
            };

            let conn_meta = build_connection_metadata(
                connection_id,
                &assigned_client_id,
                &address,
                &payload,
                diff.clone(),
            );

            let prev_session = {
                let mut sessions = state.sessions.write().await;
                sessions.insert(
                    assigned_client_id.clone(),
                    ClientSession {
                        connection_id,
                        metadata: conn_meta.clone(),
                        outbound_tx: outbound_tx.clone(),
                    },
                )
            };

            if let Some(old) = prev_session {
                // Close superseded socket gracefully without disrupting the new session.
                let _ = old.outbound_tx.send(Message::Close(None));
            }

            active_client_id = Some(assigned_client_id.clone());
            sink.emit_connection_established(&conn_meta);
        } else if command_type == "state.values.change" {
            if let Some(changes) = payload.get("changes").and_then(|v| v.as_array()) {
                let paths: Vec<String> = changes
                    .iter()
                    .filter_map(|item| item.get("path").and_then(|p| p.as_str()).map(str::to_string))
                    .collect();
                *state.subscriptions.write().await = paths;
            }
        } else if command_type == "state.backup.response" {
            if let Some(obj) = payload.as_object_mut() {
                obj.insert("name".to_string(), Value::Null);
            }
        }

        let cmd_event = OutboundCommandEvent {
            command_type,
            connection_id,
            client_id: active_client_id.clone(),
            date,
            delta_time,
            important,
            message_id,
            payload,
            diff,
        };
        sink.emit_command(&cmd_event);
    }

    let _ = outbound_tx.send(Message::Close(None));
    drop(outbound_tx);

    if let Some(cid) = active_client_id {
        let removed_meta = {
            let mut sessions = state.sessions.write().await;
            let should_remove = sessions
                .get(&cid)
                .map(|s| s.connection_id == connection_id)
                .unwrap_or(false);
            if should_remove {
                sessions.remove(&cid).map(|s| s.metadata)
            } else {
                None
            }
        };
        if let Some(meta) = removed_meta {
            sink.emit_disconnect(&meta);
        }
    }

    let _ = writer_task.await;
}

fn build_connection_metadata(
    connection_id: u64,
    client_id: &str,
    address: &str,
    payload: &Value,
    diff: Option<Value>,
) -> ReactotronConnection {
    let mut extra = payload.as_object().cloned().unwrap_or_default();
    let platform = extra
        .remove("platform")
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    let name = extra
        .remove("name")
        .and_then(|v| v.as_str().map(str::to_string));
    let platform_version = extra
        .remove("platformVersion")
        .and_then(|v| v.as_str().map(str::to_string));
    let os_release = extra
        .remove("osRelease")
        .and_then(|v| v.as_str().map(str::to_string));
    let user_agent = extra
        .remove("userAgent")
        .and_then(|v| v.as_str().map(str::to_string));

    extra.remove("id");
    extra.remove("clientId");
    extra.remove("address");
    if let Some(d) = diff {
        extra.insert("diff".to_string(), d);
    }

    ReactotronConnection {
        id: connection_id,
        client_id: client_id.to_string(),
        address: address.to_string(),
        platform,
        name,
        platform_version,
        os_release,
        user_agent,
        extra,
    }
}

pub async fn send_command(
    state: &ServerState,
    command_type: &str,
    payload: Value,
    client_id: Option<&str>,
) -> Result<usize, String> {
    if command_type == "state.values.subscribe" {
        if let Some(paths) = payload.get("paths").and_then(|v| v.as_array()) {
            let next_subs: Vec<String> = paths
                .iter()
                .filter_map(|p| p.as_str().map(str::to_string))
                .collect();
            *state.subscriptions.write().await = next_subs;
        }
    }

    let encoded = serde_json::to_string(&json!({
        "type": command_type,
        "payload": payload,
    }))
    .map_err(|e| format!("Failed to serialize command: {e}"))?;

    let sessions = state.sessions.read().await;
    let mut sent = 0usize;
    match client_id {
        Some(target) => {
            if let Some(session) = sessions.get(target) {
                if session.outbound_tx.send(Message::Text(encoded)).is_ok() {
                    sent = 1;
                }
            }
        }
        None => {
            for session in sessions.values() {
                if session.outbound_tx.send(Message::Text(encoded.clone())).is_ok() {
                    sent += 1;
                }
            }
        }
    }
    Ok(sent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::broadcast;
    use tokio_tungstenite::connect_async;

    #[derive(Debug, Clone)]
    enum TestEvent {
        ServerStarted,
        ConnectionEstablished(ReactotronConnection),
        Disconnect(ReactotronConnection),
        Command(OutboundCommandEvent),
    }

    struct TestSink {
        tx: broadcast::Sender<TestEvent>,
    }

    impl EventSink for TestSink {
        fn emit_server_started(&self) {
            let _ = self.tx.send(TestEvent::ServerStarted);
        }
        fn emit_port_unavailable(&self) {}
        fn emit_connection_established(&self, conn: &ReactotronConnection) {
            let _ = self.tx.send(TestEvent::ConnectionEstablished(conn.clone()));
        }
        fn emit_disconnect(&self, conn: &ReactotronConnection) {
            let _ = self.tx.send(TestEvent::Disconnect(conn.clone()));
        }
        fn emit_command(&self, cmd: &OutboundCommandEvent) {
            let _ = self.tx.send(TestEvent::Command(cmd.clone()));
        }
    }

    #[tokio::test]
    async fn client_intro_round_trip_and_payload_guard() {
        let state = Arc::new(ServerState::new(0));
        let (tx, mut rx) = broadcast::channel(64);
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });

        let addr = start_on("127.0.0.1:0", Arc::clone(&state), Arc::clone(&sink))
            .await
            .expect("bind loopback");
        assert!(addr.ip().is_loopback());

        // Drain ServerStarted
        let ev = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(ev, TestEvent::ServerStarted));

        let url = format!("ws://127.0.0.1:{}", addr.port());
        let (mut ws, _) = connect_async(&url).await.expect("client connect");

        // Receive initial empty state.values.subscribe sent on socket connect
        let init_msg = tokio::time::timeout(Duration::from_secs(2), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let init_json: Value = serde_json::from_str(init_msg.to_text().unwrap()).unwrap();
        assert_eq!(init_json["type"], "state.values.subscribe");

        // Send client.intro without clientId
        ws.send(Message::Text(
            json!({
                "type": "client.intro",
                "payload": {
                    "name": "MockRNApp",
                    "platform": "ios",
                    "platformVersion": "18.0"
                }
            })
            .to_string(),
        ))
        .await
        .unwrap();

        // Expect setClientId reply from Rust server
        let id_msg = tokio::time::timeout(Duration::from_secs(2), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let id_json: Value = serde_json::from_str(id_msg.to_text().unwrap()).unwrap();
        assert_eq!(id_json["type"], "setClientId");
        let assigned_id = id_json["payload"].as_str().unwrap().to_string();
        assert!(!assigned_id.is_empty());

        // Expect ConnectionEstablished + client.intro Command events
        let established = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        match established {
            TestEvent::ConnectionEstablished(c) => {
                assert_eq!(c.client_id, assigned_id);
                assert_eq!(c.address, "127.0.0.1");
                assert_eq!(c.platform, "ios");
            }
            other => panic!("Unexpected event: {other:?}"),
        }
        let intro_cmd = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(intro_cmd, TestEvent::Command(c) if c.command_type == "client.intro"));

        // Send log with serialization sentinels
        ws.send(Message::Text(
            json!({
                "type": "log",
                "important": false,
                "payload": {
                    "level": "debug",
                    "message": {
                        "flag": "~~~ false ~~~",
                        "count": "~~~ zero ~~~",
                        "empty": "~~~ empty string ~~~",
                        "cb": "~~~ anonymous function ~~~"
                    }
                }
            })
            .to_string(),
        ))
        .await
        .unwrap();

        let log_ev = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        match log_ev {
            TestEvent::Command(cmd) => {
                assert_eq!(cmd.command_type, "log");
                assert_eq!(cmd.client_id.as_deref(), Some(assigned_id.as_str()));
                assert_eq!(cmd.payload["message"]["flag"], json!(false));
                assert_eq!(cmd.payload["message"]["count"], json!(0));
                assert_eq!(cmd.payload["message"]["empty"], json!(""));
                assert_eq!(cmd.payload["message"]["cb"], json!("fn()"));
            }
            other => panic!("Unexpected event: {other:?}"),
        }

        // Outbound command round-trip UI -> Rust -> Mock Client
        let sent_count = send_command(
            &state,
            "state.values.request",
            json!({ "path": "user.profile" }),
            Some(&assigned_id),
        )
        .await
        .unwrap();
        assert_eq!(sent_count, 1);

        let outbound = tokio::time::timeout(Duration::from_secs(2), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let out_json: Value = serde_json::from_str(outbound.to_text().unwrap()).unwrap();
        assert_eq!(out_json["type"], "state.values.request");
        assert_eq!(out_json["payload"]["path"], "user.profile");

        // Payload guard check (> configured limit)
        state.max_payload_bytes.store(256, Ordering::Relaxed);
        let big_blob = "x".repeat(512);
        ws.send(Message::Text(
            json!({
                "type": "api.response",
                "payload": { "body": big_blob }
            })
            .to_string(),
        ))
        .await
        .unwrap();

        let truncated_ev = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        match truncated_ev {
            TestEvent::Command(cmd) => {
                assert_eq!(cmd.command_type, "log");
                assert_eq!(cmd.payload["level"], "warn");
                assert_eq!(cmd.payload["message"]["maxBytes"], 256);
            }
            other => panic!("Expected truncated log event, got {other:?}"),
        }

        ws.close(None).await.unwrap();
        let disc_ev = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(disc_ev, TestEvent::Disconnect(c) if c.client_id == assigned_id));
    }
}

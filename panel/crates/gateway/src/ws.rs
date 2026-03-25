use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    extract::{Query, State, WebSocketUpgrade, ws::{Message, WebSocket}},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::{mpsc, Mutex};

use tenodera_protocol::message;

use crate::AppState;
use crate::audit;
use crate::bridge_transport::BridgeProcess;
use crate::hosts_config;

#[derive(Deserialize)]
pub struct WsParams {
    pub session_id: Option<String>,
}

/// GET /api/ws?session_id=… — upgrade to WebSocket for channel transport.
/// Requires a valid session. Returns 401 if session is missing or invalid.
/// Validates Origin header to prevent Cross-Site WebSocket Hijacking.
pub async fn ws_upgrade(
    State(state): State<Arc<AppState>>,
    Query(params): Query<WsParams>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, StatusCode> {
    // Validate Origin header against Host to prevent CSWSH
    if let Some(origin) = headers.get("origin") {
        let origin_str = origin.to_str().unwrap_or("");
        let host = headers
            .get("host")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");

        if !origin_matches_host(origin_str, host) {
            tracing::warn!(origin = %origin_str, host = %host, "WS upgrade rejected: origin mismatch");
            return Err(StatusCode::FORBIDDEN);
        }
    }

    let session_id = params.session_id.ok_or(StatusCode::UNAUTHORIZED)?;
    let session = state
        .sessions
        .get(&session_id)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;

    // Check idle timeout
    let elapsed = session.last_activity.elapsed().as_secs();
    if elapsed > state.config.idle_timeout_secs {
        state.sessions.remove(&session_id).await;
        return Err(StatusCode::UNAUTHORIZED);
    }

    // Refresh activity on WS upgrade
    state.sessions.touch(&session_id).await;

    let user = session.user.clone();
    let password = session.password.clone();
    tracing::info!(user = %user, "WS upgrade authorized");

    Ok(ws.on_upgrade(move |socket| handle_socket(state, socket, session_id, user, password)))
}

/// Spawn a task forwarding messages from a bridge to the WebSocket sink.
fn spawn_bridge_forwarder(
    label: String,
    mut from_bridge: mpsc::Receiver<message::Message>,
    sink: Arc<Mutex<futures::stream::SplitSink<WebSocket, Message>>>,
) {
    tokio::spawn(async move {
        while let Some(msg) = from_bridge.recv().await {
            match serde_json::to_string(&msg) {
                Ok(json) => {
                    let mut s = sink.lock().await;
                    if s.send(Message::Text(json.into())).await.is_err() {
                        break;
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, bridge = %label, "failed to serialize bridge msg");
                }
            }
        }
        tracing::debug!(bridge = %label, "bridge->ws forwarder ended");
    });
}

async fn handle_socket(state: Arc<AppState>, socket: WebSocket, session_id: String, user: String, password: String) {
    let (sink, mut stream) = socket.split();

    tracing::debug!(user = %user, "new WebSocket connection");

    audit::log(&user, "ws_connect", "websocket", true, "WebSocket connection established");

    // Try to spawn local bridge subprocess
    let bridge_bin = &state.config.bridge_bin;
    let local_bridge = match BridgeProcess::spawn(bridge_bin).await {
        Ok(b) => {
            audit::log(&user, "bridge_spawn", "local", true, "local bridge spawned");
            b
        }
        Err(e) => {
            audit::log(&user, "bridge_spawn", "local", false, &format!("failed: {e}"));
            tracing::error!(error = %e, bin = %bridge_bin, "failed to spawn bridge");
            let err_msg = message::Message::AuthResult {
                success: false,
                problem: Some(format!("bridge-spawn-failed: {e}")),
                user: None,
            };
            let mut sink = sink;
            let _ = sink
                .send(Message::Text(serde_json::to_string(&err_msg).unwrap().into()))
                .await;
            return;
        }
    };

    tracing::info!(bin = %bridge_bin, "local bridge spawned");

    // Decompose local bridge
    let BridgeProcess { child: local_child, to_bridge: local_sender, from_bridge: local_receiver } = local_bridge;

    // Keep all bridge child processes alive for the session
    let mut _children = vec![local_child];

    // Shared WebSocket sink
    let sink = Arc::new(Mutex::new(sink));

    // Forward local bridge -> WebSocket
    spawn_bridge_forwarder("local".into(), local_receiver, sink.clone());

    // Channel -> bridge sender routing table
    let mut channel_routes: HashMap<String, mpsc::Sender<message::Message>> = HashMap::new();

    // Remote bridge senders keyed by host ID
    let mut remote_senders: HashMap<String, mpsc::Sender<message::Message>> = HashMap::new();

    // Main loop: route WebSocket client messages to the correct bridge
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(text) => {
                // Refresh session activity on every message
                state.sessions.touch(&session_id).await;

                match serde_json::from_str::<message::Message>(&text) {
                    Ok(message::Message::Ping) => {
                        let pong = serde_json::to_string(&message::Message::Pong)
                            .expect("pong serialization");
                        let mut s = sink.lock().await;
                        let _ = s.send(Message::Text(pong.into())).await;
                    }
                    Ok(message::Message::Open { channel, options }) => {
                        let host_id = options.extra.get("host")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());

                        let target_sender = if let Some(ref hid) = host_id {
                            // Route to remote bridge via SSH
                            if let Some(sender) = remote_senders.get(hid) {
                                sender.clone()
                            } else {
                                // Spawn bridge on remote host via SSH
                                match connect_remote(hid, &user, &password, bridge_bin).await {
                                    Ok(bridge) => {
                                        audit::log(&user, "bridge_spawn", hid, true, "remote bridge spawned via SSH");
                                        let BridgeProcess { child, to_bridge: sender, from_bridge } = bridge;
                                        _children.push(child);
                                        spawn_bridge_forwarder(
                                            format!("remote:{hid}"),
                                            from_bridge,
                                            sink.clone(),
                                        );
                                        remote_senders.insert(hid.clone(), sender.clone());
                                        sender
                                    }
                                    Err(e) => {
                                        audit::log(&user, "bridge_spawn", hid, false, &format!("remote SSH connect failed: {e}"));
                                        tracing::error!(host = %hid, error = %e, "remote connect failed");
                                        let close = message::Message::Close {
                                            channel: channel.clone(),
                                            problem: Some(format!("connect-failed: {e}")),
                                        };
                                        let json = serde_json::to_string(&close).unwrap();
                                        let mut s = sink.lock().await;
                                        let _ = s.send(Message::Text(json.into())).await;
                                        continue;
                                    }
                                }
                            }
                        } else {
                            // Route to local bridge
                            local_sender.clone()
                        };

                        // Store channel -> bridge mapping
                        channel_routes.insert(channel.clone(), target_sender.clone());

                        // Inject authenticated user and strip host field before forwarding
                        let open_msg = {
                            let mut clean = options.clone();
                            clean.extra.remove("host");
                            clean.extra.insert(
                                "_user".into(),
                                serde_json::Value::String(user.clone()),
                            );
                            message::Message::Open { channel, options: clean }
                        };

                        if target_sender.send(open_msg).await.is_err() {
                            tracing::warn!("bridge channel closed on Open");
                        }
                    }
                    Ok(parsed) => {
                        // Data, Close, Control — route to owning bridge
                        let ch = match &parsed {
                            message::Message::Data { channel, .. } => Some(channel.clone()),
                            message::Message::Close { channel, .. } => Some(channel.clone()),
                            message::Message::Control { channel, .. } => Some(channel.clone()),
                            _ => None,
                        };

                        let is_close = matches!(&parsed, message::Message::Close { .. });

                        if let Some(ch) = ch {
                            let sender = channel_routes
                                .get(&ch)
                                .cloned()
                                .unwrap_or_else(|| local_sender.clone());

                            if sender.send(parsed).await.is_err() {
                                tracing::warn!(channel = %ch, "bridge closed");
                            }

                            if is_close {
                                channel_routes.remove(&ch);
                            }
                        } else {
                            // Forward unknown messages to local bridge
                            let _ = local_sender.send(parsed).await;
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, raw = %text, "invalid message from client");
                    }
                }
            }
            Message::Close(_) => {
                tracing::debug!("WebSocket closed by client");
                break;
            }
            _ => {}
        }
    }

    // Clean up — dropping senders and children kills bridge processes
    drop(local_sender);
    drop(remote_senders);
    drop(channel_routes);
    audit::log(&user, "ws_disconnect", "websocket", true, "WebSocket connection ended");
    tracing::debug!("WebSocket connection ended");
}

/// Spawn tenodera-bridge on a remote host via SSH.
/// The bridge communicates through SSH stdin/stdout using the same
/// newline-delimited JSON protocol as a local bridge — no intermediate
/// daemon or port required on the remote host.
async fn connect_remote(
    host_id: &str,
    session_user: &str,
    session_password: &str,
    bridge_bin: &str,
) -> anyhow::Result<BridgeProcess> {
    let host = hosts_config::find_host(host_id)
        .ok_or_else(|| anyhow::anyhow!("host not found: {host_id}"))?;

    let ssh_user = host.effective_user(session_user);
    tracing::info!(
        host = %host_id,
        address = %host.address,
        ssh_user = %ssh_user,
        ssh_port = host.ssh_port,
        "spawning remote bridge via SSH"
    );

    BridgeProcess::spawn_remote(
        ssh_user,
        session_password,
        &host.address,
        host.ssh_port,
        bridge_bin,
    ).await
}

/// Check whether a WebSocket Origin header matches the request Host.
///
/// Origin format: `https://example.com:9090` or `http://localhost:3000`
/// Host format: `example.com:9090` or `localhost:3000`
///
/// Extracts the hostname(:port) from the origin URL and compares it
/// with the Host header. This prevents Cross-Site WebSocket Hijacking
/// from a malicious page on a different domain.
fn origin_matches_host(origin: &str, host: &str) -> bool {
    // Extract host portion from origin URL (strip scheme)
    let origin_host = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))
        .unwrap_or(origin);

    // Strip trailing path if any
    let origin_host = origin_host.split('/').next().unwrap_or(origin_host);

    origin_host.eq_ignore_ascii_case(host)
}

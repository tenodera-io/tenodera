use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    extract::{State, WebSocketUpgrade, ws::{Message, WebSocket}},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use tokio::sync::{mpsc, Mutex};

use tenodera_protocol::channel::ChannelId;
use tenodera_protocol::message;

use crate::AppState;
use crate::audit;
use crate::bridge_transport::BridgeProcess;
use crate::hosts_config;
use crate::security_headers::origin_matches_host;

/// Hard limit on simultaneously open channels per WebSocket session.
const MAX_CHANNELS_PER_SESSION: usize = 512;
/// Hard limit on remote bridge connections per WebSocket session.
const MAX_REMOTE_BRIDGES: usize = 50;
/// Timeout for the initial Auth message after WS upgrade.
const AUTH_TIMEOUT_SECS: u64 = 10;

/// GET /api/ws — upgrade to WebSocket for channel transport.
/// Authentication happens inside the WebSocket via the first Auth message
/// (session token), NOT via query parameters.
/// Validates Origin header to prevent Cross-Site WebSocket Hijacking.
pub async fn ws_upgrade(
    State(state): State<Arc<AppState>>,
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

    Ok(ws.on_upgrade(move |socket| handle_socket(state, socket)))
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
                    tracing::trace!(bridge = %label, raw = %json, "bridge → WS client");
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

async fn handle_socket(state: Arc<AppState>, socket: WebSocket) {
    let (sink, mut stream) = socket.split();
    let sink = Arc::new(Mutex::new(sink));

    // ── Auth phase: wait for the first message to be Auth { token } ──
    let (session_id, user, password) = {
        let auth_timeout = tokio::time::sleep(std::time::Duration::from_secs(AUTH_TIMEOUT_SECS));
        tokio::pin!(auth_timeout);

        let auth_result = loop {
            tokio::select! {
                _ = &mut auth_timeout => {
                    tracing::warn!("WS auth timeout — no Auth message received");
                    let err = message::Message::AuthResult {
                        success: false,
                        problem: Some("auth-timeout".into()),
                        user: None,
                    };
                    let mut s = sink.lock().await;
                    let _ = s.send(Message::Text(serde_json::to_string(&err).unwrap().into())).await;
                    return;
                }
                maybe_msg = stream.next() => {
                    let Some(Ok(msg)) = maybe_msg else {
                        return; // connection closed before auth
                    };
                    match msg {
                        Message::Text(text) => {
                            match serde_json::from_str::<message::Message>(&text) {
                                Ok(message::Message::Auth { credentials }) => {
                                    break credentials;
                                }
                                _ => {
                                    // Non-auth message before auth — reject
                                    tracing::warn!(raw = %text, "WS received non-auth message before authentication");
                                    let err = message::Message::AuthResult {
                                        success: false,
                                        problem: Some("auth-required".into()),
                                        user: None,
                                    };
                                    let mut s = sink.lock().await;
                                    let _ = s.send(Message::Text(serde_json::to_string(&err).unwrap().into())).await;
                                    return;
                                }
                            }
                        }
                        Message::Close(_) => return,
                        _ => continue,
                    }
                }
            }
        };

        // Validate the token
        let token = match auth_result {
            message::AuthCredentials::Token { token } => token,
            _ => {
                let err = message::Message::AuthResult {
                    success: false,
                    problem: Some("token-scheme-required".into()),
                    user: None,
                };
                let mut s = sink.lock().await;
                let _ = s.send(Message::Text(serde_json::to_string(&err).unwrap().into())).await;
                return;
            }
        };

        let session = match state.sessions.get(&token).await {
            Some(s) => s,
            None => {
                let err = message::Message::AuthResult {
                    success: false,
                    problem: Some("invalid-session".into()),
                    user: None,
                };
                let mut s = sink.lock().await;
                let _ = s.send(Message::Text(serde_json::to_string(&err).unwrap().into())).await;
                return;
            }
        };

        // Check idle timeout
        let elapsed = session.last_activity.elapsed().as_secs();
        if elapsed > state.config.idle_timeout_secs {
            state.sessions.remove(&token).await;
            let err = message::Message::AuthResult {
                success: false,
                problem: Some("session-expired".into()),
                user: None,
            };
            let mut s = sink.lock().await;
            let _ = s.send(Message::Text(serde_json::to_string(&err).unwrap().into())).await;
            return;
        }

        state.sessions.touch(&token).await;
        let user = session.user.clone();
        let password = session.password.clone();

        // Send success
        let ok = message::Message::AuthResult {
            success: true,
            problem: None,
            user: Some(user.clone()),
        };
        {
            let mut s = sink.lock().await;
            let _ = s.send(Message::Text(serde_json::to_string(&ok).unwrap().into())).await;
        }

        tracing::info!(user = %user, "WS authenticated via token");
        (token, user, password)
    };

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
            let mut s = sink.lock().await;
            let _ = s
                .send(Message::Text(serde_json::to_string(&err_msg).unwrap().into()))
                .await;
            return;
        }
    };

    tracing::info!(bin = %bridge_bin, "local bridge spawned");

    // Decompose local bridge
    let BridgeProcess { child: local_child, to_bridge: local_sender, from_bridge: local_receiver, .. } = local_bridge;

    // Keep all bridge child processes alive for the session
    let mut _children = vec![local_child];

    // Keep temp known_hosts files alive for SSH connections
    let mut _temp_files: Vec<tempfile::NamedTempFile> = Vec::new();

    // Forward local bridge -> WebSocket
    spawn_bridge_forwarder("local".into(), local_receiver, sink.clone());

    // Channel -> bridge sender routing table
    let mut channel_routes: HashMap<ChannelId, mpsc::Sender<message::Message>> = HashMap::new();

    // Remote bridge senders keyed by host ID
    let mut remote_senders: HashMap<String, mpsc::Sender<message::Message>> = HashMap::new();

    // Periodic session-existence check so that logout (or reaper) kills
    // live WebSocket connections promptly instead of leaving them orphaned.
    let mut session_check = tokio::time::interval(std::time::Duration::from_secs(5));
    // consume the first immediate tick
    session_check.tick().await;

    // Main loop: route WebSocket client messages to the correct bridge
    loop {
        tokio::select! {
            maybe_msg = stream.next() => {
                let Some(Ok(msg)) = maybe_msg else { break };
                match msg {
                    Message::Text(text) => {
                        // Refresh session activity on every message
                        state.sessions.touch(&session_id).await;

                        tracing::trace!(raw = %text, "WS client → gateway");

                        match serde_json::from_str::<message::Message>(&text) {
                            Ok(message::Message::Ping) => {
                                let pong = serde_json::to_string(&message::Message::Pong)
                                    .expect("pong serialization");
                                let mut s = sink.lock().await;
                                let _ = s.send(Message::Text(pong.into())).await;
                            }
                            Ok(message::Message::Open { channel, options }) => {
                                // Enforce per-session channel limit
                                if channel_routes.len() >= MAX_CHANNELS_PER_SESSION {
                                    tracing::warn!(user = %user, count = channel_routes.len(), "channel limit reached");
                                    let close = message::Message::Close {
                                        channel: channel.clone(),
                                        problem: Some("channel-limit-exceeded".into()),
                                    };
                                    let json = serde_json::to_string(&close).unwrap();
                                    let mut s = sink.lock().await;
                                    let _ = s.send(Message::Text(json.into())).await;
                                    continue;
                                }

                                let host_id = options.extra.get("host")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());

                                let target_sender = if let Some(ref hid) = host_id {
                                    // Route to remote bridge via SSH
                                    if let Some(sender) = remote_senders.get(hid) {
                                        sender.clone()
                                    } else {
                                        // Enforce per-session remote bridge limit
                                        if remote_senders.len() >= MAX_REMOTE_BRIDGES {
                                            tracing::warn!(user = %user, count = remote_senders.len(), "remote bridge limit reached");
                                            let close = message::Message::Close {
                                                channel: channel.clone(),
                                                problem: Some("remote-bridge-limit-exceeded".into()),
                                            };
                                            let json = serde_json::to_string(&close).unwrap();
                                            let mut s = sink.lock().await;
                                            let _ = s.send(Message::Text(json.into())).await;
                                            continue;
                                        }

                                        // Spawn bridge on remote host via SSH
                                        match connect_remote(hid, &user, &password, bridge_bin).await {
                                            Ok(bridge) => {
                                                audit::log(&user, "bridge_spawn", hid, true, "remote bridge spawned via SSH");
                                                let BridgeProcess { child, to_bridge: sender, from_bridge, _temp_known_hosts } = bridge;
                                                _children.push(child);
                                                if let Some(tmp) = _temp_known_hosts {
                                                    _temp_files.push(tmp);
                                                }
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
                                    if let Some(sender) = channel_routes.get(&ch) {
                                        if sender.send(parsed).await.is_err() {
                                            tracing::warn!(channel = %ch, "bridge closed");
                                        }
                                    } else {
                                        tracing::warn!(channel = %ch, "message for unknown channel — dropped");
                                    }

                                    if is_close {
                                        channel_routes.remove(&ch);
                                    }
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
            // Periodically verify the session still exists — logout or
            // the reaper may have removed it while the WS was idle.
            _ = session_check.tick() => {
                if state.sessions.get(&session_id).await.is_none() {
                    tracing::info!(user = %user, "session invalidated — closing WebSocket");
                    audit::log(&user, "ws_disconnect", "websocket", true, "session invalidated (logout/expired)");
                    // Send close frame to client before dropping
                    let mut s = sink.lock().await;
                    let _ = s.send(Message::Close(None)).await;
                    break;
                }
            }
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
    let host = hosts_config::find_host(host_id).await
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
        &host.host_key,
    ).await
}

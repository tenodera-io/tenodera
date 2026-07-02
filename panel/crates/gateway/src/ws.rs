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
use crate::agent_registry::session_prefix;
use crate::security_headers::origin_matches_host;

const MAX_CHANNELS_PER_SESSION: usize = 512;
const MAX_REMOTE_AGENTS: usize = 50;
const AUTH_TIMEOUT_SECS: u64 = 10;

pub async fn ws_upgrade(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, StatusCode> {
    let origin = headers.get("origin");
    let host = headers
        .get("host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");

    match origin {
        Some(o) => {
            let origin_str = o.to_str().unwrap_or("");
            if !origin_matches_host(origin_str, host) {
                tracing::warn!(origin = %origin_str, host = %host, "WS upgrade rejected: origin mismatch");
                return Err(StatusCode::FORBIDDEN);
            }
        }
        None => {
            if !state.config.allow_unencrypted {
                tracing::warn!(host = %host, "WS upgrade rejected: missing Origin header");
                return Err(StatusCode::FORBIDDEN);
            }
        }
    }

    Ok(ws.on_upgrade(move |socket| handle_socket(state, socket)))
}

fn spawn_agent_forwarder(
    label: String,
    mut from_agent: mpsc::Receiver<message::Message>,
    sink: Arc<Mutex<futures::stream::SplitSink<WebSocket, Message>>>,
    close_notify: mpsc::UnboundedSender<ChannelId>,
) {
    tokio::spawn(async move {
        while let Some(msg) = from_agent.recv().await {
            let close_channel = match &msg {
                message::Message::Close { channel, .. } => Some(channel.clone()),
                _ => None,
            };

            if let Ok(json) = serde_json::to_string(&msg) {
                tracing::trace!(agent = %label, raw = %json, "agent → WS client");
                let mut s = sink.lock().await;
                if s.send(Message::Text(json.into())).await.is_err() {
                    break;
                }
            }

            if let Some(ch) = close_channel {
                let _ = close_notify.send(ch);
            }
        }
        tracing::debug!(agent = %label, "agent->ws forwarder ended");
    });
}

async fn handle_socket(state: Arc<AppState>, socket: WebSocket) {
    let (sink, mut stream) = socket.split();
    let sink = Arc::new(Mutex::new(sink));

    // ── Auth phase ────────────────────────────────────────────────────────
    let (session_id, user, role) = {
        let auth_timeout = tokio::time::sleep(std::time::Duration::from_secs(AUTH_TIMEOUT_SECS));
        tokio::pin!(auth_timeout);

        let credentials = loop {
            tokio::select! {
                _ = &mut auth_timeout => {
                    let err = message::Message::AuthResult {
                        success: false, problem: Some("auth-timeout".into()), user: None,
                    };
                    let mut s = sink.lock().await;
                    let _ = s.send(Message::Text(serde_json::to_string(&err).unwrap().into())).await;
                    return;
                }
                maybe_msg = stream.next() => {
                    let Some(Ok(msg)) = maybe_msg else { return };
                    match msg {
                        Message::Text(text) => {
                            match serde_json::from_str::<message::Message>(&text) {
                                Ok(message::Message::Auth { credentials }) => break credentials,
                                _ => {
                                    let err = message::Message::AuthResult {
                                        success: false, problem: Some("auth-required".into()), user: None,
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

        let token = match credentials {
            message::AuthCredentials::Token { token } => token,
            _ => {
                let err = message::Message::AuthResult {
                    success: false, problem: Some("token-scheme-required".into()), user: None,
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
                    success: false, problem: Some("invalid-session".into()), user: None,
                };
                let mut s = sink.lock().await;
                let _ = s.send(Message::Text(serde_json::to_string(&err).unwrap().into())).await;
                return;
            }
        };

        if session.last_activity.elapsed().as_secs() > state.config.idle_timeout_secs {
            state.sessions.remove(&token).await;
            let err = message::Message::AuthResult {
                success: false, problem: Some("session-expired".into()), user: None,
            };
            let mut s = sink.lock().await;
            let _ = s.send(Message::Text(serde_json::to_string(&err).unwrap().into())).await;
            return;
        }

        state.sessions.touch(&token).await;
        let user = session.user.clone();
        let role = session.role;

        let ok = message::Message::AuthResult { success: true, problem: None, user: Some(user.clone()) };
        { let mut s = sink.lock().await; let _ = s.send(Message::Text(serde_json::to_string(&ok).unwrap().into())).await; }

        tracing::info!(user = %user, role = %role.as_str(), "WS authenticated");
        (token, user, role)
    };

    audit::log(&user, "ws_connect", "websocket", true, "WebSocket connection established");

    let (close_tx, mut close_rx) = mpsc::unbounded_channel::<ChannelId>();

    // channel_id → sender for that agent
    let mut channel_routes: HashMap<ChannelId, mpsc::Sender<message::Message>> = HashMap::new();
    // host_id → (proxy sender, conn liveness token) for the remote agent session.
    // The Weak<()> becomes non-upgradeable when the AgentConn is replaced (reconnect)
    // or removed (disconnect), allowing stale-connection detection without a round-trip.
    let mut remote_senders: HashMap<String, (mpsc::Sender<message::Message>, std::sync::Weak<()>)> = HashMap::new();

    let mut session_check = tokio::time::interval(std::time::Duration::from_secs(5));
    session_check.tick().await;

    // Session prefix for channel ID namespacing on remote agents
    let s_prefix = session_prefix(&session_id);

    loop {
        tokio::select! {
            maybe_msg = stream.next() => {
                let Some(Ok(msg)) = maybe_msg else { break };
                match msg {
                    Message::Text(text) => {
                        state.sessions.touch(&session_id).await;
                        tracing::trace!(raw = %text, "WS client → gateway");

                        match serde_json::from_str::<message::Message>(&text) {
                            Ok(message::Message::Ping) => {
                                let pong = serde_json::to_string(&message::Message::Pong).unwrap();
                                let mut s = sink.lock().await;
                                let _ = s.send(Message::Text(pong.into())).await;
                            }
                            Ok(message::Message::Open { channel, options }) => {
                                if channel_routes.len() >= MAX_CHANNELS_PER_SESSION {
                                    let close = message::Message::Close {
                                        channel: channel.clone(),
                                        problem: Some("channel-limit-exceeded".into()),
                                    };
                                    let mut s = sink.lock().await;
                                    let _ = s.send(Message::Text(serde_json::to_string(&close).unwrap().into())).await;
                                    continue;
                                }

                                let host_id = options.extra.get("host")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());

                                let target_sender = if let Some(ref hid) = host_id {
                                    // Use cached sender only if its liveness token is still alive
                                    // (token is dropped when the AgentConn is replaced on reconnect).
                                    let valid_cached = remote_senders.get(hid)
                                        .and_then(|(tx, weak)| weak.upgrade().map(|_| tx.clone()));

                                    if let Some(sender) = valid_cached {
                                        sender
                                    } else {
                                        // Stale or no entry — remove old entry and reconnect.
                                        remote_senders.remove(hid);

                                        if remote_senders.len() >= MAX_REMOTE_AGENTS {
                                            let close = message::Message::Close {
                                                channel: channel.clone(),
                                                problem: Some("remote-agent-limit-exceeded".into()),
                                            };
                                            let mut s = sink.lock().await;
                                            let _ = s.send(Message::Text(serde_json::to_string(&close).unwrap().into())).await;
                                            continue;
                                        }

                                        match state.agent_registry.connect_session(hid, &s_prefix).await {
                                            Some((proxy_tx, from_rx, conn_token)) => {
                                                audit::log(&user, "agent_connect", hid, true, "remote agent connected via registry");
                                                spawn_agent_forwarder(
                                                    format!("remote:{hid}"),
                                                    from_rx,
                                                    sink.clone(),
                                                    close_tx.clone(),
                                                );
                                                remote_senders.insert(hid.clone(), (proxy_tx.clone(), conn_token));
                                                proxy_tx
                                            }
                                            None => {
                                                audit::log(&user, "agent_connect", hid, false, "host offline");
                                                tracing::warn!(host = %hid, "agent not connected");
                                                let close = message::Message::Close {
                                                    channel: channel.clone(),
                                                    problem: Some("host-offline".into()),
                                                };
                                                let mut s = sink.lock().await;
                                                let _ = s.send(Message::Text(serde_json::to_string(&close).unwrap().into())).await;
                                                continue;
                                            }
                                        }
                                    }
                                } else {
                                    // No host specified — local agent no longer supported
                                    let close = message::Message::Close {
                                        channel: channel.clone(),
                                        problem: Some("host-required".into()),
                                    };
                                    let mut s = sink.lock().await;
                                    let _ = s.send(Message::Text(serde_json::to_string(&close).unwrap().into())).await;
                                    continue;
                                };

                                let channel_key = channel.clone();
                                channel_routes.insert(channel_key.clone(), target_sender.clone());

                                // Inject user+role, strip host field
                                let open_msg = {
                                    let mut clean = options.clone();
                                    clean.extra.remove("host");
                                    clean.extra.insert("_user".into(), serde_json::Value::String(user.clone()));
                                    clean.extra.insert("_role".into(), serde_json::Value::String(role.as_str().into()));
                                    message::Message::Open { channel, options: clean }
                                };

                                if target_sender.send(open_msg).await.is_err() {
                                    channel_routes.remove(&channel_key);
                                    // Proxy task died (race: conn dropped between Weak check and send).
                                    // Evict stale entry and immediately tell the client so it doesn't
                                    // wait 30 s for a request timeout.
                                    if let Some(ref hid) = host_id {
                                        remote_senders.remove(hid);
                                    }
                                    let close = message::Message::Close {
                                        channel: channel_key,
                                        problem: Some("host-offline".into()),
                                    };
                                    let mut s = sink.lock().await;
                                    let _ = s.send(Message::Text(serde_json::to_string(&close).unwrap().into())).await;
                                }
                            }
                            Ok(parsed) => {
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
                                            channel_routes.remove(&ch);
                                        }
                                    }
                                    if is_close {
                                        channel_routes.remove(&ch);
                                    }
                                }
                            }
                            Err(e) => tracing::warn!(error = %e, raw = %text, "invalid message from client"),
                        }
                    }
                    Message::Close(_) => { tracing::debug!("WebSocket closed by client"); break; }
                    _ => {}
                }
            }
            Some(closed_ch) = close_rx.recv() => {
                channel_routes.remove(&closed_ch);
            }
            _ = session_check.tick() => {
                if state.sessions.get(&session_id).await.is_none() {
                    tracing::info!(user = %user, "session invalidated — closing WebSocket");
                    audit::log(&user, "ws_disconnect", "websocket", true, "session invalidated");
                    let mut s = sink.lock().await;
                    let _ = s.send(Message::Close(None)).await;
                    break;
                }
            }
        }
    }

    drop(remote_senders);
    drop(channel_routes);
    audit::log(&user, "ws_disconnect", "websocket", true, "WebSocket connection ended");
}

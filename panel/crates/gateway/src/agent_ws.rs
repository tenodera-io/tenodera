use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::ws::Message as WsMessage,
    extract::{ConnectInfo, State, WebSocketUpgrade, ws::WebSocket},
    http::HeaderMap,
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot};

use tenodera_protocol::message::{self, PROTOCOL_VERSION};

use crate::AppState;
use crate::agent_auth::{
    AuthenticatedAgent, BootstrapRegistry, CHALLENGE_DEADLINE, PENDING_TIMEOUT, PendingRegistry,
    generate_nonce, pubkey_fingerprint_display, verify_signature,
};
use crate::agent_registry::{self, AgentRegistry};
use crate::hosts_config;

/// Best-effort primary (outbound) IP of this host. Used to label the local agent,
/// which connects over loopback so its socket peer is `127.0.0.1`. Uses the classic
/// "connect a UDP socket to a public address and read the local address" trick — no
/// packet is sent; it just resolves the source IP the routing table would pick.
fn primary_ip() -> Option<std::net::IpAddr> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("1.1.1.1:80").ok()?;
    sock.local_addr().ok().map(|a| a.ip())
}

/// GET /api/agent — WebSocket endpoint for agent connections.
pub async fn agent_ws_upgrade(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let registry = state.agent_registry.clone();
    let pending_registry = state.pending_registry.clone();
    let bootstrap_registry = state.bootstrap_registry.clone();
    let gateway_id = state.gateway_id.clone();
    // Behind the loopback reverse proxy the socket peer is 127.0.0.1; recover the
    // agent's real IP from the proxy's X-Forwarded-For (trusted only from loopback).
    // A still-loopback result means the local agent connected over loopback with no
    // proxy — label it with the host's primary IP rather than 127.0.0.1.
    let mut client_ip = crate::auth::real_client_ip(addr.ip(), &headers);
    if client_ip.is_loopback()
        && let Some(ip) = primary_ip()
    {
        client_ip = ip;
    }
    let remote_ip = client_ip.to_string();
    ws.on_upgrade(move |socket| {
        handle_agent_socket(
            registry,
            pending_registry,
            bootstrap_registry,
            gateway_id,
            socket,
            remote_ip,
        )
    })
}

async fn handle_agent_socket(
    registry: AgentRegistry,
    pending_registry: PendingRegistry,
    bootstrap_registry: BootstrapRegistry,
    gateway_id: String,
    socket: WebSocket,
    remote_ip: String,
) {
    let (mut sink, mut stream) = socket.split();

    // ── AwaitHello ────────────────────────────────────────────────────────────
    let hello = loop {
        match stream.next().await {
            Some(Ok(WsMessage::Text(text))) => {
                match serde_json::from_str::<message::Message>(&text) {
                    Ok(message::Message::Hello {
                        version,
                        hostname,
                        is_local,
                        public_key,
                        bootstrap_token,
                        os_id,
                        ..
                    }) => {
                        if version < 2 {
                            tracing::warn!(
                                %remote_ip, %hostname, version,
                                "agent rejected: protocol version < 2"
                            );
                            return;
                        }
                        let public_key = match public_key {
                            Some(pk) => pk,
                            None => {
                                tracing::warn!(
                                    %remote_ip, %hostname,
                                    "agent rejected: protocol v2 requires public_key"
                                );
                                return;
                            }
                        };
                        break (hostname, is_local, public_key, bootstrap_token, os_id);
                    }
                    Ok(other) => {
                        tracing::warn!(%remote_ip, ?other, "expected Hello from agent");
                        return;
                    }
                    Err(e) => {
                        tracing::warn!(%remote_ip, error = %e, "failed to parse Hello");
                        return;
                    }
                }
            }
            Some(Ok(WsMessage::Close(_))) | None => return,
            Some(Ok(_)) => continue,
            Some(Err(e)) => {
                tracing::warn!(%remote_ip, error = %e, "WS error during Hello");
                return;
            }
        }
    };

    let (hostname, is_local, pubkey_b64, bootstrap_token, os_id) = hello;

    // ── Send Challenge ────────────────────────────────────────────────────────
    let (nonce_bytes, nonce_b64) = generate_nonce();
    let challenge = serde_json::to_string(&message::Message::Challenge {
        nonce: nonce_b64,
        gateway_id: gateway_id.clone(),
    })
    .expect("serialize Challenge");

    if sink.send(WsMessage::Text(challenge.into())).await.is_err() {
        return;
    }

    // ── AwaitResponse (10s deadline) ──────────────────────────────────────────
    let sig_b64 = match tokio::time::timeout(
        CHALLENGE_DEADLINE,
        recv_challenge_response(&mut stream),
    )
    .await
    {
        Ok(Some(sig)) => sig,
        Ok(None) => {
            tracing::warn!(%remote_ip, %hostname, "connection closed waiting for ChallengeResponse");
            return;
        }
        Err(_) => {
            tracing::warn!(%remote_ip, %hostname, "challenge deadline exceeded (10s)");
            return;
        }
    };

    // ── Verify signature ──────────────────────────────────────────────────────
    if !verify_signature(&pubkey_b64, &sig_b64, &nonce_bytes, &hostname, &gateway_id) {
        tracing::warn!(%remote_ip, %hostname, "invalid Ed25519 signature — closing");
        return;
    }

    let fingerprint = pubkey_fingerprint_display(&pubkey_b64);
    tracing::debug!(%hostname, %fingerprint, "signature verified");

    // ── Route to correct authentication path ──────────────────────────────────
    let auth = match resolve_auth_path(
        &hostname,
        &pubkey_b64,
        bootstrap_token.as_deref(),
        is_local,
        &remote_ip,
        &fingerprint,
        os_id.as_deref(),
        &bootstrap_registry,
        &registry,
    )
    .await
    {
        AuthPath::Authenticated(a) => a,

        AuthPath::Pending(reason) => {
            // Send Pending, then wait for admin approval
            let pending_msg = serde_json::to_string(&message::Message::Pending { reason })
                .expect("serialize Pending");
            if sink
                .send(WsMessage::Text(pending_msg.into()))
                .await
                .is_err()
            {
                return;
            }

            let (approve_tx, approve_rx) = oneshot::channel::<hosts_config::HostEntry>();
            let inserted = pending_registry
                .insert(
                    pubkey_b64.clone(),
                    hostname.clone(),
                    remote_ip.clone(),
                    os_id.clone(),
                    approve_tx,
                )
                .await;

            if !inserted {
                tracing::warn!(%hostname, "pending registry full — rejecting");
                return;
            }
            tracing::info!(%hostname, %fingerprint, "agent pending admin approval");

            let host = match wait_for_approval(&mut sink, &mut stream, approve_rx).await {
                Some(h) => h,
                None => {
                    pending_registry.remove(&pubkey_b64).await;
                    tracing::info!(%hostname, "pending agent disconnected or timed out");
                    return;
                }
            };

            AuthenticatedAgent {
                host,
                remote_ip: remote_ip.clone(),
            }
        }

        AuthPath::Reject => return,
    };

    // ── Fill os_id if missing (write-once: only for hosts that predate this field) ──
    if auth.host.os_id.is_none()
        && let Some(ref id) = os_id
    {
        hosts_config::update_os_id(&auth.host.id, id).await;
    }

    // ── HelloAck ──────────────────────────────────────────────────────────────
    let ack = serde_json::to_string(&message::Message::HelloAck {
        version: PROTOCOL_VERSION,
        warning: None,
    })
    .expect("serialize HelloAck");

    if sink.send(WsMessage::Text(ack.into())).await.is_err() {
        return;
    }

    tracing::info!(
        host_id = %auth.host.id,
        hostname = %auth.host.hostname,
        %fingerprint,
        "agent authenticated"
    );

    // ── Register in agent registry ────────────────────────────────────────────
    let (to_agent_tx, mut to_agent_rx) = mpsc::channel::<message::Message>(512);
    let subscribers = registry.register(&auth, to_agent_tx).await;
    let host_id = auth.host.id.clone();

    // ── WS writer task: gateway → agent ──────────────────────────────────────
    let writer_handle = tokio::spawn(async move {
        while let Some(msg) = to_agent_rx.recv().await {
            match serde_json::to_string(&msg) {
                Ok(json) => {
                    if sink.send(WsMessage::Text(json.into())).await.is_err() {
                        break;
                    }
                }
                Err(e) => tracing::warn!(error = %e, "failed to serialize message to agent"),
            }
        }
    });

    // ── WS reader task: agent → gateway sessions ──────────────────────────────
    while let Some(frame) = stream.next().await {
        let text = match frame {
            Ok(WsMessage::Text(t)) => t,
            Ok(WsMessage::Close(_)) | Err(_) => break,
            Ok(WsMessage::Ping(_)) => continue,
            Ok(_) => continue,
        };

        let msg: message::Message = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(host = %host_id, error = %e, "invalid message from agent");
                continue;
            }
        };

        let (stripped, prefix) = match agent_registry::strip_prefix_from_message(msg) {
            Some(pair) => pair,
            None => continue,
        };

        let subs = subscribers.read().await;
        if let Some(sub_tx) = subs.get(&prefix) {
            if sub_tx.send(stripped).await.is_err() {
                tracing::debug!(host = %host_id, prefix = %prefix, "session subscriber gone");
            }
        } else {
            tracing::debug!(host = %host_id, prefix = %prefix, "no subscriber for prefix");
        }
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────
    hosts_config::update_last_seen(&host_id).await;
    registry.unregister(&host_id).await;
    writer_handle.abort();
    tracing::info!(host = %host_id, "agent disconnected");
}

// ── Authentication path resolution ───────────────────────────────────────────

enum AuthPath {
    Authenticated(AuthenticatedAgent),
    Pending(String),
    Reject,
}

// Enrollment decision draws on several independent inputs (identity, network,
// and both registries); grouping them into a struct would not simplify callers.
#[allow(clippy::too_many_arguments)]
async fn resolve_auth_path(
    hostname: &str,
    pubkey_b64: &str,
    bootstrap_token: Option<&str>,
    is_local: bool,
    remote_ip: &str,
    fingerprint: &str,
    os_id: Option<&str>,
    bootstrap_registry: &BootstrapRegistry,
    agent_registry: &AgentRegistry,
) -> AuthPath {
    // Path 1 & Path 2: known host
    if let Some(host) = hosts_config::find_by_pubkey(pubkey_b64).await {
        // Path 1: pubkey matches stored key → authenticated
        tracing::info!(
            hostname = %host.hostname,
            host_id = %host.id,
            %fingerprint,
            "known host reconnected"
        );
        return AuthPath::Authenticated(AuthenticatedAgent {
            host,
            remote_ip: remote_ip.to_string(),
        });
    }

    // Path 2: known hostname but different pubkey
    if let Some(existing) = hosts_config::find_by_hostname(hostname).await {
        // Check for re_enroll token bound to this hostname
        if let Some(token_val) = bootstrap_token
            && let Some(true) = bootstrap_registry
                .validate_and_consume(token_val, hostname)
                .await
        {
            // re_enroll path: replace public key
            match hosts_config::replace_pubkey(&existing.id, pubkey_b64).await {
                Ok(updated) => {
                    // Kick old agent session
                    agent_registry.unregister(&existing.id).await;
                    tracing::warn!(
                        hostname,
                        old_fingerprint = %pubkey_fingerprint_display(
                            existing.public_key.as_deref().unwrap_or("")
                        ),
                        new_fingerprint = %fingerprint,
                        "key replaced via re_enroll token"
                    );
                    return AuthPath::Authenticated(AuthenticatedAgent {
                        host: updated,
                        remote_ip: remote_ip.to_string(),
                    });
                }
                Err(e) => {
                    tracing::error!(error = %e, "failed to replace pubkey");
                    return AuthPath::Reject;
                }
            }
        }

        // No valid re_enroll token → pubkey mismatch ALERT
        tracing::error!(
            hostname,
            host_id = %existing.id,
            known_fingerprint = %pubkey_fingerprint_display(
                existing.public_key.as_deref().unwrap_or("")
            ),
            presented_fingerprint = %fingerprint,
            "SECURITY ALERT: known hostname presented unknown pubkey — closing connection"
        );
        return AuthPath::Reject;
    }

    // Path 3 & Path 4: new host
    if let Some(token_val) = bootstrap_token {
        match bootstrap_registry
            .validate_and_consume(token_val, hostname)
            .await
        {
            Some(_) => {
                // Path 3: valid token → auto-enroll
                match hosts_config::register_host(
                    hostname,
                    pubkey_b64,
                    is_local,
                    None,
                    os_id.map(str::to_string),
                )
                .await
                {
                    Ok(host) => {
                        tracing::info!(hostname, %fingerprint, "new host enrolled via bootstrap token");
                        return AuthPath::Authenticated(AuthenticatedAgent {
                            host,
                            remote_ip: remote_ip.to_string(),
                        });
                    }
                    Err(e) => {
                        tracing::error!(error = %e, "failed to register host");
                        return AuthPath::Reject;
                    }
                }
            }
            None => {
                // Token present but invalid/expired
                tracing::warn!(hostname, %fingerprint, "bootstrap token invalid or expired");
                return AuthPath::Pending("token_invalid".to_string());
            }
        }
    }

    // Path 3b: loopback connection — auto-enroll without admin approval.
    // If the agent connects from 127.0.0.1/::1 it is running on the same host
    // as the gateway, which means the operator already has root on this machine
    // and explicitly ran the panel installer. No further approval is needed.
    if matches!(remote_ip, "127.0.0.1" | "::1") {
        match hosts_config::register_host(
            hostname,
            pubkey_b64,
            true,
            None,
            os_id.map(str::to_string),
        )
        .await
        {
            Ok(host) => {
                tracing::info!(hostname, %fingerprint, "loopback agent auto-enrolled as local host");
                return AuthPath::Authenticated(AuthenticatedAgent {
                    host,
                    remote_ip: remote_ip.to_string(),
                });
            }
            Err(e) => {
                tracing::error!(error = %e, "failed to auto-enroll loopback host");
                return AuthPath::Reject;
            }
        }
    }

    // Path 4: no token, not loopback → pending
    tracing::info!(hostname, %fingerprint, "new host without token — entering pending state");
    AuthPath::Pending("enrollment_required".to_string())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async fn recv_challenge_response<S>(stream: &mut S) -> Option<String>
where
    S: StreamExt<Item = Result<WsMessage, axum::Error>> + Unpin,
{
    loop {
        match stream.next().await? {
            Ok(WsMessage::Text(text)) => match serde_json::from_str::<message::Message>(&text) {
                Ok(message::Message::Challengeresponse { signature }) => return Some(signature),
                Ok(_) => continue,
                Err(_) => return None,
            },
            Ok(WsMessage::Close(_)) => return None,
            Ok(_) => continue,
            Err(_) => return None,
        }
    }
}

async fn wait_for_approval<Si, St>(
    sink: &mut Si,
    stream: &mut St,
    mut approve_rx: oneshot::Receiver<hosts_config::HostEntry>,
) -> Option<hosts_config::HostEntry>
where
    Si: SinkExt<WsMessage> + Unpin,
    St: StreamExt<Item = Result<WsMessage, axum::Error>> + Unpin,
{
    let mut ping_interval = tokio::time::interval(Duration::from_secs(30));
    ping_interval.tick().await; // skip immediate tick

    loop {
        tokio::select! {
            result = &mut approve_rx => {
                return result.ok();
            }
            _ = ping_interval.tick() => {
                if sink.send(WsMessage::Ping(vec![].into())).await.is_err() {
                    return None;
                }
            }
            frame = stream.next() => {
                match frame {
                    Some(Ok(WsMessage::Close(_))) | None => return None,
                    Some(Err(_)) => return None,
                    _ => {}
                }
            }
            _ = tokio::time::sleep(PENDING_TIMEOUT) => {
                return None;
            }
        }
    }
}

use std::sync::Arc;

use axum::{
    extract::{State, WebSocketUpgrade, ws::{Message, WebSocket}},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc;

use tenodera_protocol::message::{self, PROTOCOL_VERSION};

use crate::AppState;
use crate::bridge_registry::{self, BridgeRegistry};
use crate::hosts_config;

/// GET /api/bridge — WebSocket endpoint for bridge connections.
///
/// The bridge authenticates via `Authorization: Bearer <token>`.
/// The token is matched against registered hosts in hosts.json.
/// On success, the bridge is registered in the BridgeRegistry for the duration
/// of the connection.
pub async fn bridge_ws_upgrade(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, StatusCode> {
    let token = extract_bearer(&headers).ok_or(StatusCode::UNAUTHORIZED)?;
    let hostname = headers
        .get("X-Bridge-Hostname")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_string();

    let host = hosts_config::find_host_by_token(&token).await
        .ok_or(StatusCode::UNAUTHORIZED)?;

    tracing::info!(
        host_id = %host.id,
        host_name = %host.name,
        %hostname,
        "bridge connection accepted"
    );

    let registry = state.bridge_registry.clone();
    Ok(ws.on_upgrade(move |socket| handle_bridge_socket(registry, socket, host.id, hostname)))
}

async fn handle_bridge_socket(
    registry: BridgeRegistry,
    socket: WebSocket,
    host_id: String,
    hostname: String,
) {
    let (mut sink, mut stream) = socket.split();

    // ── Hello/HelloAck handshake ──────────────────────────────────────────
    let bridge_version = loop {
        match stream.next().await {
            Some(Ok(Message::Text(text))) => {
                match serde_json::from_str::<message::Message>(&text) {
                    Ok(message::Message::Hello { version }) => break version,
                    Ok(other) => {
                        tracing::warn!(host = %host_id, ?other, "expected Hello from bridge");
                        return;
                    }
                    Err(e) => {
                        tracing::warn!(host = %host_id, error = %e, "failed to parse Hello");
                        return;
                    }
                }
            }
            Some(Ok(Message::Close(_))) | None => return,
            Some(Ok(_)) => continue,
            Some(Err(e)) => {
                tracing::warn!(host = %host_id, error = %e, "WS error during handshake");
                return;
            }
        }
    };

    let warning = if bridge_version != PROTOCOL_VERSION {
        let w = format!(
            "protocol version mismatch: gateway={PROTOCOL_VERSION}, bridge={bridge_version}"
        );
        tracing::warn!(host = %host_id, "{w}");
        Some(w)
    } else {
        None
    };

    let ack = message::Message::HelloAck { version: PROTOCOL_VERSION, warning };
    let ack_json = match serde_json::to_string(&ack) {
        Ok(j) => j,
        Err(e) => {
            tracing::error!(error = %e, "failed to serialize HelloAck");
            return;
        }
    };
    if sink.send(Message::Text(ack_json.into())).await.is_err() {
        return;
    }

    tracing::info!(
        host = %host_id,
        %hostname,
        bridge_version,
        "bridge handshake complete"
    );

    // ── Register in bridge registry ───────────────────────────────────────
    let (to_bridge_tx, mut to_bridge_rx) = mpsc::channel::<message::Message>(512);
    let subscribers = registry.register(host_id.clone(), to_bridge_tx).await;

    // ── WS writer task: gateway → bridge ─────────────────────────────────
    let writer_handle = tokio::spawn(async move {
        while let Some(msg) = to_bridge_rx.recv().await {
            match serde_json::to_string(&msg) {
                Ok(json) => {
                    if sink.send(Message::Text(json.into())).await.is_err() {
                        break;
                    }
                }
                Err(e) => tracing::warn!(error = %e, "failed to serialize message to bridge"),
            }
        }
    });

    // ── WS reader task: bridge → gateway sessions ─────────────────────────
    while let Some(frame) = stream.next().await {
        let text = match frame {
            Ok(Message::Text(t)) => t,
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(Message::Ping(_)) => continue,
            Ok(_) => continue,
        };

        let msg: message::Message = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(host = %host_id, error = %e, "invalid message from bridge");
                continue;
            }
        };

        // Extract prefix from channel ID, route to correct session subscriber
        let (stripped, prefix) = match bridge_registry::strip_prefix_from_message(msg) {
            Some(pair) => pair,
            None => continue, // message without a valid prefixed channel (e.g. Pong)
        };

        let subs = subscribers.read().await;
        if let Some(sub_tx) = subs.get(&prefix) {
            if sub_tx.send(stripped).await.is_err() {
                // Session ended — subscriber will be cleaned up lazily
                tracing::debug!(host = %host_id, prefix = %prefix, "session subscriber gone");
            }
        } else {
            tracing::debug!(host = %host_id, prefix = %prefix, "no subscriber for prefix");
        }
    }

    // ── Cleanup ───────────────────────────────────────────────────────────
    registry.unregister(&host_id).await;
    writer_handle.abort();
    tracing::info!(host = %host_id, "bridge disconnected");
}

fn extract_bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_string())
}

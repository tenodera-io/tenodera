use std::sync::Arc;

use axum::{
    extract::{State, WebSocketUpgrade, ws::{Message, WebSocket}},
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
/// Any bridge may connect. The bridge identifies itself via its hostname sent
/// in the Hello message. If no entry exists for that hostname, one is created
/// automatically (Zabbix-style auto-registration).
pub async fn bridge_ws_upgrade(
    State(state): State<Arc<AppState>>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let registry = state.bridge_registry.clone();
    ws.on_upgrade(move |socket| handle_bridge_socket(registry, socket))
}

async fn handle_bridge_socket(registry: BridgeRegistry, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();

    // ── Hello/HelloAck handshake ──────────────────────────────────────────
    let (bridge_version, hostname, is_local) = loop {
        match stream.next().await {
            Some(Ok(Message::Text(text))) => {
                match serde_json::from_str::<message::Message>(&text) {
                    Ok(message::Message::Hello { version, hostname, is_local }) => {
                        break (version, hostname, is_local);
                    }
                    Ok(other) => {
                        tracing::warn!(?other, "expected Hello from bridge");
                        return;
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "failed to parse Hello");
                        return;
                    }
                }
            }
            Some(Ok(Message::Close(_))) | None => return,
            Some(Ok(_)) => continue,
            Some(Err(e)) => {
                tracing::warn!(error = %e, "WS error during handshake");
                return;
            }
        }
    };

    // ── Auto-register ─────────────────────────────────────────────────────
    let effective_hostname = if hostname.is_empty() { "unknown".to_string() } else { hostname };
    let host = hosts_config::find_or_register_by_hostname(&effective_hostname, is_local).await;

    tracing::info!(
        host_id = %host.id,
        host_name = %host.name,
        hostname = %effective_hostname,
        "bridge connection accepted"
    );

    let warning = if bridge_version != PROTOCOL_VERSION {
        let w = format!(
            "protocol version mismatch: gateway={PROTOCOL_VERSION}, bridge={bridge_version}"
        );
        tracing::warn!(host = %host.id, "{w}");
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
        host = %host.id,
        hostname = %effective_hostname,
        bridge_version,
        "bridge handshake complete"
    );

    // ── Register in bridge registry ───────────────────────────────────────
    let (to_bridge_tx, mut to_bridge_rx) = mpsc::channel::<message::Message>(512);
    let subscribers = registry.register(host.id.clone(), to_bridge_tx).await;

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
                tracing::warn!(host = %host.id, error = %e, "invalid message from bridge");
                continue;
            }
        };

        let (stripped, prefix) = match bridge_registry::strip_prefix_from_message(msg) {
            Some(pair) => pair,
            None => continue,
        };

        let subs = subscribers.read().await;
        if let Some(sub_tx) = subs.get(&prefix) {
            if sub_tx.send(stripped).await.is_err() {
                tracing::debug!(host = %host.id, prefix = %prefix, "session subscriber gone");
            }
        } else {
            tracing::debug!(host = %host.id, prefix = %prefix, "no subscriber for prefix");
        }
    }

    // ── Cleanup ───────────────────────────────────────────────────────────
    hosts_config::update_last_seen(&host.id).await;
    registry.unregister(&host.id).await;
    writer_handle.abort();
    tracing::info!(host = %host.id, "bridge disconnected");
}

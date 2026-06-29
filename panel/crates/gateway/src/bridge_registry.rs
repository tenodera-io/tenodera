use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{mpsc, RwLock};

use tenodera_protocol::message::Message;

const SESSION_PREFIX_LEN: usize = 8;

/// One entry per connected bridge host.
struct BridgeConn {
    /// Send messages to the bridge WS connection.
    to_bridge: mpsc::Sender<Message>,
    /// session_prefix → channel back to that WS session.
    subscribers: Arc<RwLock<HashMap<String, mpsc::Sender<Message>>>>,
    /// Remote IP address of the bridge connection.
    remote_ip: Option<String>,
}

/// Registry of currently-connected bridge WebSocket connections.
/// One entry per managed host; multiple user sessions share the same bridge connection.
#[derive(Clone)]
pub struct BridgeRegistry {
    inner: Arc<RwLock<HashMap<String, Arc<BridgeConn>>>>,
}

impl BridgeRegistry {
    pub fn new() -> Self {
        Self { inner: Arc::new(RwLock::new(HashMap::new())) }
    }

    /// Register a newly-connected bridge.
    /// Returns the subscriber map so the bridge WS reader can route responses.
    pub async fn register(
        &self,
        host_id: String,
        to_bridge: mpsc::Sender<Message>,
        remote_ip: Option<String>,
    ) -> Arc<RwLock<HashMap<String, mpsc::Sender<Message>>>> {
        let subscribers = Arc::new(RwLock::new(HashMap::new()));
        let conn = Arc::new(BridgeConn { to_bridge, subscribers: subscribers.clone(), remote_ip });
        self.inner.write().await.insert(host_id, conn);
        subscribers
    }

    pub async fn get_remote_ip(&self, host_id: &str) -> Option<String> {
        self.inner.read().await.get(host_id)?.remote_ip.clone()
    }

    pub async fn unregister(&self, host_id: &str) {
        self.inner.write().await.remove(host_id);
    }

    pub async fn is_online(&self, host_id: &str) -> bool {
        self.inner.read().await.contains_key(host_id)
    }

    pub async fn online_host_ids(&self) -> Vec<String> {
        self.inner.read().await.keys().cloned().collect()
    }

    /// Subscribe a user WS session to a bridge connection.
    ///
    /// Returns a `(tx, rx)` pair:
    /// - `tx`: proxy sender — transparently prefixes channel IDs with `session_prefix`
    ///   so multiple sessions can share the same bridge without channel ID collisions.
    /// - `rx`: receives bridge responses for this session (prefix stripped).
    pub async fn connect_session(
        &self,
        host_id: &str,
        session_id: &str,
    ) -> Option<(mpsc::Sender<Message>, mpsc::Receiver<Message>)> {
        let conn = self.inner.read().await.get(host_id)?.clone();

        let prefix = session_prefix(session_id);

        // Channel that the gateway session writes to (before prefixing)
        let (proxy_tx, mut proxy_rx) = mpsc::channel::<Message>(256);
        // Channel that bridge responses are delivered to
        let (sub_tx, sub_rx) = mpsc::channel::<Message>(256);

        conn.subscribers.write().await.insert(prefix.clone(), sub_tx);

        // Proxy task: add prefix to channel IDs before forwarding to bridge
        let real_tx = conn.to_bridge.clone();
        tokio::spawn(async move {
            while let Some(msg) = proxy_rx.recv().await {
                let prefixed = prefix_message(msg, &prefix);
                if real_tx.send(prefixed).await.is_err() {
                    break;
                }
            }
        });

        Some((proxy_tx, sub_rx))
    }
}

/// Derive a short unique prefix from the session UUID.
/// Takes the first SESSION_PREFIX_LEN hex characters (UUID dashes removed).
pub fn session_prefix(session_id: &str) -> String {
    session_id
        .chars()
        .filter(|c| *c != '-')
        .take(SESSION_PREFIX_LEN)
        .collect()
}

/// Prepend `prefix-` to any channel ID in a message.
pub fn prefix_message(msg: Message, prefix: &str) -> Message {
    match msg {
        Message::Open { channel, options } => Message::Open {
            channel: format!("{prefix}-{channel}").into(),
            options,
        },
        Message::Data { channel, data } => Message::Data {
            channel: format!("{prefix}-{channel}").into(),
            data,
        },
        Message::Control { channel, command, extra } => Message::Control {
            channel: format!("{prefix}-{channel}").into(),
            command,
            extra,
        },
        Message::Close { channel, problem } => Message::Close {
            channel: format!("{prefix}-{channel}").into(),
            problem,
        },
        other => other,
    }
}

/// Extract prefix from a message's channel ID and strip it.
/// Returns `(stripped_message, prefix)` or `None` if not a prefixed channel message.
pub fn strip_prefix_from_message(msg: Message) -> Option<(Message, String)> {
    let channel_str = match &msg {
        Message::Data { channel, .. }
        | Message::Control { channel, .. }
        | Message::Close { channel, .. }
        | Message::Ready { channel } => channel.as_str().to_string(),
        _ => return None,
    };

    if channel_str.len() <= SESSION_PREFIX_LEN + 1 {
        return None;
    }

    let prefix = &channel_str[..SESSION_PREFIX_LEN];
    if channel_str.as_bytes().get(SESSION_PREFIX_LEN) != Some(&b'-') {
        return None;
    }

    let original = &channel_str[SESSION_PREFIX_LEN + 1..];
    if original.is_empty() {
        return None;
    }

    let prefix = prefix.to_string();
    let stripped = match msg {
        Message::Data { data, .. } => Message::Data {
            channel: original.into(),
            data,
        },
        Message::Control { command, extra, .. } => Message::Control {
            channel: original.into(),
            command,
            extra,
        },
        Message::Close { problem, .. } => Message::Close {
            channel: original.into(),
            problem,
        },
        Message::Ready { .. } => Message::Ready {
            channel: original.into(),
        },
        other => other,
    };
    Some((stripped, prefix))
}

use serde::{Deserialize, Serialize};

use crate::channel::{ChannelId, ChannelOpenOptions};

// ---------------------------------------------------------------------------
// Wire protocol: every WebSocket frame is one JSON Message
// ---------------------------------------------------------------------------

/// Top-level envelope for all messages on the WebSocket transport.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Message {
    /// Client → Bridge: open a new channel.
    Open {
        channel: ChannelId,
        #[serde(flatten)]
        options: ChannelOpenOptions,
    },

    /// Bridge → Client: channel is ready to send/receive data.
    Ready {
        channel: ChannelId,
    },

    /// Bidirectional: payload data on an open channel.
    Data {
        channel: ChannelId,
        data: serde_json::Value,
    },

    /// Bidirectional: control/signal on an open channel.
    Control {
        channel: ChannelId,
        command: String,
        #[serde(flatten)]
        extra: serde_json::Map<String, serde_json::Value>,
    },

    /// Bidirectional: close a channel.
    Close {
        channel: ChannelId,
        /// `None` = clean close; `Some(reason)` = error / problem.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        problem: Option<String>,
    },

    /// Client → Gateway: authenticate.
    Auth {
        credentials: AuthCredentials,
    },

    /// Gateway → Client: authentication result.
    AuthResult {
        success: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        problem: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        user: Option<String>,
    },

    /// Heartbeat / keep-alive (either direction).
    Ping,
    Pong,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", tag = "scheme")]
pub enum AuthCredentials {
    Basic { user: String, password: String },
    Token { token: String },
}

impl std::fmt::Debug for AuthCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Basic { user, .. } => f
                .debug_struct("Basic")
                .field("user", user)
                .field("password", &"[REDACTED]")
                .finish(),
            Self::Token { .. } => f
                .debug_struct("Token")
                .field("token", &"[REDACTED]")
                .finish(),
        }
    }
}

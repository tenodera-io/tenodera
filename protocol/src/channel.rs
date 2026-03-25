use serde::{Deserialize, Serialize};

/// Unique channel identifier within a session.
pub type ChannelId = String;

/// Channel state machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChannelState {
    Opening,
    Ready,
    Closing,
    Closed,
}

/// Options sent when opening a channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelOpenOptions {
    /// Required: which payload handler to use.
    pub payload: String,

    /// Optional: request superuser privileges.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superuser: Option<SuperuserMode>,

    /// Payload-specific options (passed through to the handler).
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SuperuserMode {
    Require,
    Try,
}

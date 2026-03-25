use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("invalid message: {0}")]
    InvalidMessage(String),

    #[error("unknown payload type: {0}")]
    UnknownPayload(String),

    #[error("channel not found: {0}")]
    ChannelNotFound(String),

    #[error("channel already exists: {0}")]
    ChannelAlreadyExists(String),

    #[error("authentication failed: {0}")]
    AuthFailed(String),

    #[error("permission denied: {0}")]
    PermissionDenied(String),

    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("transport error: {0}")]
    Transport(String),
}

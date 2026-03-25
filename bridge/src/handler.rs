use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;
use tokio::sync::mpsc;

/// Trait for payload-specific channel handlers.
///
/// Handlers can be one-shot (return all messages immediately) or streaming
/// (send messages through the provided `tx` sender over time).
#[async_trait::async_trait]
pub trait ChannelHandler: Send + Sync {
    /// Payload type this handler serves, e.g. "system.info".
    fn payload_type(&self) -> &str;

    /// Is this a streaming handler? Streaming handlers keep the channel open
    /// and send data over time via the `tx` sender.
    fn is_streaming(&self) -> bool {
        false
    }

    /// Handle a channel open — return initial messages (Ready, Data…, Close).
    /// For one-shot handlers, return all messages at once.
    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message>;

    /// Start a streaming channel. The handler sends messages through `tx`
    /// and should stop when `shutdown` is notified.
    /// Default: not implemented (one-shot handlers don't need this).
    async fn stream(
        &self,
        _channel: &str,
        _options: &ChannelOpenOptions,
        _tx: mpsc::Sender<Message>,
        _shutdown: tokio::sync::watch::Receiver<bool>,
    ) {
        // Default: no-op for one-shot handlers
    }

    /// Handle incoming data on an open channel.
    async fn data(&self, _channel: &str, _data: &serde_json::Value) -> Vec<Message> {
        vec![]
    }
}

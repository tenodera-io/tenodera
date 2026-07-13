use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

use crate::handler::ChannelHandler;

pub struct SystemPubkeyHandler;

#[async_trait::async_trait]
impl ChannelHandler for SystemPubkeyHandler {
    fn payload_type(&self) -> &str {
        "system.pubkey"
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        let key_path = std::env::var("TENODERA_SSH_KEY")
            .unwrap_or_else(|_| "/etc/tenodera/id_ed25519".to_string());
        let pub_path = format!("{key_path}.pub");

        let pubkey = tokio::fs::read_to_string(&pub_path)
            .await
            .map(|s| s.trim().to_string())
            .unwrap_or_default();

        let data = if pubkey.is_empty() {
            serde_json::json!({ "ok": false, "error": format!("public key not found at {pub_path}") })
        } else {
            serde_json::json!({ "ok": true, "pubkey": pubkey })
        };

        vec![
            Message::Ready {
                channel: channel.into(),
            },
            Message::Data {
                channel: channel.into(),
                data,
            },
            Message::Close {
                channel: channel.into(),
                problem: None,
            },
        ]
    }
}

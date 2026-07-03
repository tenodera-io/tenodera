use serde::{Deserialize, Serialize};

use crate::channel::{ChannelId, ChannelOpenOptions};

// ---------------------------------------------------------------------------
// Wire protocol: every WebSocket frame is one JSON Message
// ---------------------------------------------------------------------------

/// Current protocol version sent in Hello/HelloAck.
///
/// Version 2 adds Ed25519 challenge-response authentication.
/// Gateways reject Hello with version < 2.
pub const PROTOCOL_VERSION: u32 = 2;

/// Top-level envelope for all messages on the WebSocket transport.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Message {
    /// Agent → Gateway (first message after connection).
    Hello {
        version: u32,
        /// System hostname of the agent host.
        #[serde(default)]
        hostname: String,
        /// Agent crate version string.
        #[serde(default)]
        agent_version: String,
        /// True when the agent is connecting from the same host as the gateway.
        #[serde(default)]
        is_local: bool,
        /// Ed25519 public key (base64, 32 bytes). Required in protocol v2.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        public_key: Option<String>,
        /// Bootstrap enrollment token. Absent for already-enrolled agents.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bootstrap_token: Option<String>,
    },

    /// Gateway → Agent: issue authentication challenge.
    Challenge {
        /// Fresh 32-byte nonce, base64-encoded.
        nonce: String,
        /// Stable UUID identifying this gateway instance.
        gateway_id: String,
    },

    /// Agent → Gateway: signed response to Challenge.
    Challengeresponse {
        /// Ed25519 signature over the domain-separated payload, base64-encoded (64 bytes).
        signature: String,
    },

    /// Gateway → Agent: agent is connected but pending admin approval.
    Pending {
        /// "enrollment_required" | "token_invalid"
        reason: String,
    },

    /// Gateway → Agent: acknowledge and report own version.
    HelloAck {
        version: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        warning: Option<String>,
    },

    /// Client → Agent: open a new channel.
    Open {
        channel: ChannelId,
        #[serde(flatten)]
        options: ChannelOpenOptions,
    },

    /// Agent → Client: channel is ready to send/receive data.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel::ChannelOpenOptions;

    fn roundtrip(msg: &Message) -> Message {
        let json = serde_json::to_string(msg).expect("serialize");
        serde_json::from_str(&json).expect("deserialize")
    }

    #[test]
    fn open_roundtrip() {
        let msg = Message::Open {
            channel: "42".into(),
            options: ChannelOpenOptions {
                payload: "system.info".into(),
                superuser: None,
                extra: Default::default(),
            },
        };
        let rt = roundtrip(&msg);
        let Message::Open { channel, options } = rt else { panic!("wrong variant") };
        assert_eq!(channel.as_str(), "42");
        assert_eq!(options.payload, "system.info");
    }

    #[test]
    fn ready_roundtrip() {
        let msg = Message::Ready { channel: "1".into() };
        let Message::Ready { channel } = roundtrip(&msg) else { panic!() };
        assert_eq!(channel.as_str(), "1");
    }

    #[test]
    fn data_roundtrip() {
        let msg = Message::Data {
            channel: "5".into(),
            data: serde_json::json!({ "key": "value", "n": 42 }),
        };
        let Message::Data { channel, data } = roundtrip(&msg) else { panic!() };
        assert_eq!(channel.as_str(), "5");
        assert_eq!(data["key"], "value");
        assert_eq!(data["n"], 42);
    }

    #[test]
    fn control_roundtrip() {
        let mut extra = serde_json::Map::new();
        extra.insert("rows".into(), serde_json::json!(24));
        let msg = Message::Control {
            channel: "3".into(),
            command: "resize".into(),
            extra,
        };
        let Message::Control { channel, command, extra } = roundtrip(&msg) else { panic!() };
        assert_eq!(channel.as_str(), "3");
        assert_eq!(command, "resize");
        assert_eq!(extra["rows"], 24);
    }

    #[test]
    fn close_clean_roundtrip() {
        let msg = Message::Close { channel: "7".into(), problem: None };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(!json.contains("problem"), "skip_serializing_if failed");
        let Message::Close { problem, .. } = roundtrip(&msg) else { panic!() };
        assert!(problem.is_none());
    }

    #[test]
    fn close_with_problem_roundtrip() {
        let msg = Message::Close { channel: "7".into(), problem: Some("oops".into()) };
        let Message::Close { problem, .. } = roundtrip(&msg) else { panic!() };
        assert_eq!(problem.as_deref(), Some("oops"));
    }

    #[test]
    fn auth_token_roundtrip() {
        let msg = Message::Auth {
            credentials: AuthCredentials::Token { token: "abc123".into() },
        };
        let Message::Auth { credentials: AuthCredentials::Token { token } } = roundtrip(&msg) else { panic!() };
        assert_eq!(token, "abc123");
    }

    #[test]
    fn auth_basic_roundtrip() {
        let msg = Message::Auth {
            credentials: AuthCredentials::Basic { user: "alice".into(), password: "s3cr3t".into() },
        };
        let Message::Auth { credentials: AuthCredentials::Basic { user, password } } = roundtrip(&msg) else { panic!() };
        assert_eq!(user, "alice");
        assert_eq!(password, "s3cr3t");
    }

    #[test]
    fn authresult_ok_roundtrip() {
        let msg = Message::AuthResult { success: true, problem: None, user: Some("alice".into()) };
        let Message::AuthResult { success, problem, user } = roundtrip(&msg) else { panic!() };
        assert!(success);
        assert!(problem.is_none());
        assert_eq!(user.as_deref(), Some("alice"));
    }

    #[test]
    fn authresult_fail_roundtrip() {
        let msg = Message::AuthResult { success: false, problem: Some("bad password".into()), user: None };
        let Message::AuthResult { success, problem, .. } = roundtrip(&msg) else { panic!() };
        assert!(!success);
        assert_eq!(problem.as_deref(), Some("bad password"));
    }

    #[test]
    fn ping_pong_roundtrip() {
        let json_ping = serde_json::to_string(&Message::Ping).unwrap();
        assert!(json_ping.contains("\"ping\""));
        let rt: Message = serde_json::from_str(&json_ping).unwrap();
        assert!(matches!(rt, Message::Ping));

        let json_pong = serde_json::to_string(&Message::Pong).unwrap();
        let rt: Message = serde_json::from_str(&json_pong).unwrap();
        assert!(matches!(rt, Message::Pong));
    }

    #[test]
    fn hello_v2_roundtrip() {
        let msg = Message::Hello {
            version: 2,
            hostname: "srv01".into(),
            agent_version: "0.1.0".into(),
            is_local: false,
            public_key: Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".into()),
            bootstrap_token: Some("tok123".into()),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"hello\""), "tag missing: {json}");
        let rt: Message = serde_json::from_str(&json).unwrap();
        let Message::Hello { version, hostname, public_key, bootstrap_token, .. } = rt else { panic!() };
        assert_eq!(version, 2);
        assert_eq!(hostname, "srv01");
        assert_eq!(public_key.as_deref(), Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="));
        assert_eq!(bootstrap_token.as_deref(), Some("tok123"));
    }

    #[test]
    fn hello_no_optional_fields_roundtrip() {
        // Agents without public_key (old v1 agents) should still deserialize cleanly.
        // Gateway will reject them on version check.
        let json = r#"{"type":"hello","version":1,"hostname":"srv01"}"#;
        let rt: Message = serde_json::from_str(json).unwrap();
        let Message::Hello { version, hostname, public_key, .. } = rt else { panic!() };
        assert_eq!(version, 1);
        assert_eq!(hostname, "srv01");
        assert!(public_key.is_none());
    }

    #[test]
    fn challenge_roundtrip() {
        let msg = Message::Challenge {
            nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".into(),
            gateway_id: "550e8400-e29b-41d4-a716-446655440000".into(),
        };
        let Message::Challenge { nonce, gateway_id } = roundtrip(&msg) else { panic!() };
        assert_eq!(nonce, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
        assert_eq!(gateway_id, "550e8400-e29b-41d4-a716-446655440000");
    }

    #[test]
    fn challengeresponse_roundtrip() {
        let msg = Message::Challengeresponse { signature: "sig64bytes==".into() };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"challengeresponse\""));
        let Message::Challengeresponse { signature } = roundtrip(&msg) else { panic!() };
        assert_eq!(signature, "sig64bytes==");
    }

    #[test]
    fn pending_roundtrip() {
        let msg = Message::Pending { reason: "enrollment_required".into() };
        let Message::Pending { reason } = roundtrip(&msg) else { panic!() };
        assert_eq!(reason, "enrollment_required");
    }

    #[test]
    fn helloack_roundtrip() {
        let msg = Message::HelloAck { version: 2, warning: Some("version mismatch".into()) };
        let Message::HelloAck { version, warning } = roundtrip(&msg) else { panic!() };
        assert_eq!(version, 2);
        assert_eq!(warning.as_deref(), Some("version mismatch"));
    }

    #[test]
    fn helloack_no_warning_omits_field() {
        let msg = Message::HelloAck { version: 2, warning: None };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(!json.contains("warning"), "warning should be absent: {json}");
    }

    #[test]
    fn channel_id_validation() {
        use crate::channel::ChannelId;
        assert!(ChannelId::new("valid-id_123").is_ok());
        assert!(ChannelId::new("").is_err());
        assert!(ChannelId::new("a".repeat(65)).is_err());
        assert!(ChannelId::new("has space").is_err());
        assert!(ChannelId::new("has/slash").is_err());
    }
}

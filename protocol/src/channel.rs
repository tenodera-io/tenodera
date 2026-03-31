use std::fmt;

use serde::{Deserialize, Serialize};

/// Maximum length of a channel identifier (bytes).
const MAX_CHANNEL_ID_LEN: usize = 64;

/// Unique channel identifier within a session.
///
/// Validated on deserialization: non-empty, max 64 characters,
/// only ASCII alphanumeric, dash, and underscore.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct ChannelId(String);

impl ChannelId {
    /// Create a new `ChannelId`, validating the input.
    pub fn new(s: impl Into<String>) -> Result<Self, String> {
        let s = s.into();
        if s.is_empty() {
            return Err("channel id must not be empty".into());
        }
        if s.len() > MAX_CHANNEL_ID_LEN {
            return Err(format!("channel id exceeds {MAX_CHANNEL_ID_LEN} bytes"));
        }
        if !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("channel id contains invalid characters".into());
        }
        Ok(Self(s))
    }

    /// Return the inner string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Trusted conversions for internal use — channel IDs that already passed
/// validation at the deserialization boundary.  Debug builds assert validity.
impl From<String> for ChannelId {
    fn from(s: String) -> Self {
        debug_assert!(
            ChannelId::new(&s).is_ok(),
            "ChannelId::from(String) called with invalid id: {s:?}"
        );
        Self(s)
    }
}

impl From<&str> for ChannelId {
    fn from(s: &str) -> Self {
        debug_assert!(
            ChannelId::new(s).is_ok(),
            "ChannelId::from(&str) called with invalid id: {s:?}"
        );
        Self(s.to_owned())
    }
}

impl std::ops::Deref for ChannelId {
    type Target = str;
    fn deref(&self) -> &str {
        &self.0
    }
}

impl std::borrow::Borrow<str> for ChannelId {
    fn borrow(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ChannelId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for ChannelId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ChannelId({:?})", self.0)
    }
}

impl Serialize for ChannelId {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ChannelId {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        ChannelId::new(s).map_err(serde::de::Error::custom)
    }
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

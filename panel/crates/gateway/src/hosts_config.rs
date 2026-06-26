use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// A managed host entry.
/// The gateway no longer uses SSH to connect — the bridge connects to the gateway.
/// Each host has a unique token that its bridge presents on connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostEntry {
    pub id: String,
    pub name: String,
    /// Secret token — the bridge must present this to authenticate.
    pub token: String,
    /// ISO-8601 timestamp when the host was added.
    #[serde(default)]
    pub added_at: String,
    /// True for the host where the panel itself is installed.
    /// Set by install-panel.sh; the bridge on that host connects via loopback.
    #[serde(default)]
    pub is_local: bool,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct HostsConfig {
    pub hosts: Vec<HostEntry>,
}

fn config_path() -> PathBuf {
    PathBuf::from("/etc/tenodera/hosts.json")
}

pub async fn load() -> HostsConfig {
    let path = config_path();
    match tokio::fs::read_to_string(&path).await {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => HostsConfig::default(),
    }
}

pub async fn save(config: &HostsConfig) -> anyhow::Result<()> {
    let json = serde_json::to_string_pretty(config)?;
    tokio::fs::write(config_path(), json.as_bytes()).await?;
    Ok(())
}

pub async fn find_host(host_id: &str) -> Option<HostEntry> {
    load().await.hosts.into_iter().find(|h| h.id == host_id)
}

pub async fn find_host_by_token(token: &str) -> Option<HostEntry> {
    load().await.hosts.into_iter().find(|h| h.token == token)
}

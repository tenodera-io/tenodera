use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostEntry {
    pub id: String,
    pub name: String,
    /// System hostname reported by the bridge in Hello.
    #[serde(default)]
    pub hostname: String,
    /// ISO-8601 timestamp when the host was first registered.
    #[serde(default)]
    pub added_at: String,
    /// True for the host where the panel itself is installed.
    #[serde(default)]
    pub is_local: bool,
    /// User-assigned display name; falls back to `name` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// ISO-8601 timestamp of the last bridge disconnect (updated on each disconnect).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<String>,
    /// Legacy field — kept so existing hosts.json files deserialize cleanly.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub token: String,
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

pub async fn update_last_seen(host_id: &str) {
    let mut config = load().await;
    if let Some(h) = config.hosts.iter_mut().find(|h| h.id == host_id) {
        h.last_seen = Some(chrono::Utc::now().to_rfc3339());
        let _ = save(&config).await;
    }
}

/// Look up a host by its system hostname. If not found, auto-register it.
/// Existing entries without a hostname field are matched by name as a migration path.
pub async fn find_or_register_by_hostname(hostname: &str, is_local: bool) -> HostEntry {
    let mut config = load().await;

    // Find by hostname field, or fall back to name for legacy entries
    let pos = config.hosts.iter().position(|h| {
        h.hostname == hostname || (h.hostname.is_empty() && h.name == hostname)
    });

    if let Some(i) = pos {
        let mut changed = false;
        if config.hosts[i].hostname.is_empty() {
            config.hosts[i].hostname = hostname.to_string();
            changed = true;
        }
        // Update is_local if it changed (e.g. bridge.env switched to localhost URL)
        if config.hosts[i].is_local != is_local {
            config.hosts[i].is_local = is_local;
            changed = true;
        }
        if changed {
            let _ = save(&config).await;
        }
        return config.hosts[i].clone();
    }

    // Auto-register new host
    let entry = HostEntry {
        id: uuid::Uuid::new_v4().to_string(),
        name: hostname.to_string(),
        hostname: hostname.to_string(),
        added_at: chrono::Utc::now().to_rfc3339(),
        is_local,
        display_name: None,
        last_seen: None,
        token: String::new(),
    };
    tracing::info!(hostname, is_local, "auto-registered new host");
    config.hosts.push(entry.clone());
    let _ = save(&config).await;
    entry
}

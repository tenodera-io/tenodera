use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const DATA_DIR: &str = "/var/lib/tenodera-gw";
const HOSTS_PATH: &str = "/var/lib/tenodera-gw/hosts.json";
const GATEWAY_ID_PATH: &str = "/var/lib/tenodera-gw/gateway-id";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostEntry {
    pub id: String,
    pub name: String,
    /// System hostname reported by the agent in Hello.
    #[serde(default)]
    pub hostname: String,
    /// Ed25519 public key (base64, 32 bytes). None for legacy entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_key: Option<String>,
    /// ISO-8601 timestamp when the host was first registered.
    #[serde(default)]
    pub added_at: String,
    /// True for the host where the panel itself is installed.
    #[serde(default)]
    pub is_local: bool,
    /// User-assigned display name; falls back to `name` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// ISO-8601 timestamp of the last agent disconnect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct HostsConfig {
    pub hosts: Vec<HostEntry>,
}

fn config_path() -> PathBuf {
    PathBuf::from(HOSTS_PATH)
}

pub async fn load() -> HostsConfig {
    match tokio::fs::read_to_string(config_path()).await {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => HostsConfig::default(),
    }
}

pub async fn save(config: &HostsConfig) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(DATA_DIR).await?;
    let json = serde_json::to_string_pretty(config)?;
    tokio::fs::write(config_path(), json.as_bytes()).await?;
    Ok(())
}

/// Load the stable gateway UUID, or generate and persist one if absent.
pub async fn load_or_create_gateway_id() -> anyhow::Result<String> {
    if let Ok(s) = tokio::fs::read_to_string(GATEWAY_ID_PATH).await {
        let s = s.trim().to_string();
        if !s.is_empty() {
            tracing::info!(gateway_id = %s, "loaded existing gateway-id");
            return Ok(s);
        }
    }

    tokio::fs::create_dir_all(DATA_DIR).await?;
    let gateway_id = uuid::Uuid::new_v4().to_string();
    tokio::fs::write(GATEWAY_ID_PATH, gateway_id.as_bytes()).await?;
    tracing::info!(%gateway_id, "generated new gateway-id");
    Ok(gateway_id)
}

pub async fn update_last_seen(host_id: &str) {
    let mut config = load().await;
    if let Some(h) = config.hosts.iter_mut().find(|h| h.id == host_id) {
        h.last_seen = Some(chrono::Utc::now().to_rfc3339());
        let _ = save(&config).await;
    }
}

/// Look up an approved host by its Ed25519 public key.
pub async fn find_by_pubkey(pubkey_b64: &str) -> Option<HostEntry> {
    let config = load().await;
    config
        .hosts
        .into_iter()
        .find(|h| h.public_key.as_deref() == Some(pubkey_b64))
}

/// Look up an approved host by its hostname (for re_enroll token checks).
pub async fn find_by_hostname(hostname: &str) -> Option<HostEntry> {
    let config = load().await;
    config.hosts.into_iter().find(|h| h.hostname == hostname)
}

/// Register a newly-enrolled host with its Ed25519 public key.
pub async fn register_host(
    hostname: &str,
    pubkey_b64: &str,
    is_local: bool,
    display_name: Option<String>,
) -> anyhow::Result<HostEntry> {
    let mut config = load().await;
    let entry = HostEntry {
        id: uuid::Uuid::new_v4().to_string(),
        name: hostname.to_string(),
        hostname: hostname.to_string(),
        public_key: Some(pubkey_b64.to_string()),
        added_at: chrono::Utc::now().to_rfc3339(),
        is_local,
        display_name,
        last_seen: None,
    };
    config.hosts.push(entry.clone());
    save(&config).await?;
    tracing::info!(hostname, "registered new host");
    Ok(entry)
}

/// Replace the public key of an existing host (re-enrollment after key compromise).
/// Preserves the host's id, display_name, and history.
pub async fn replace_pubkey(host_id: &str, new_pubkey_b64: &str) -> anyhow::Result<HostEntry> {
    let mut config = load().await;
    let host = config
        .hosts
        .iter_mut()
        .find(|h| h.id == host_id)
        .ok_or_else(|| anyhow::anyhow!("host {host_id} not found"))?;
    host.public_key = Some(new_pubkey_b64.to_string());
    let updated = host.clone();
    save(&config).await?;
    Ok(updated)
}

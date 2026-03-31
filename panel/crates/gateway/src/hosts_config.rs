use std::path::PathBuf;

use serde::Deserialize;

/// Configuration for a remote host managed by the gateway.
/// Connection is always via SSH — the gateway spawns tenodera-bridge
/// on the remote host through an SSH session.
#[derive(Debug, Clone, Deserialize)]
pub struct HostEntry {
    pub id: String,
    pub address: String,
    /// SSH user override. Empty or missing -> use the logged-in session user.
    #[serde(default)]
    pub user: String,
    #[serde(default = "default_ssh_port")]
    pub ssh_port: u16,
    /// Full SSH host key line for strict host key verification.
    /// Written by the bridge during host enrollment (ssh-keyscan).
    #[serde(default)]
    pub host_key: String,
}

impl HostEntry {
    /// Effective SSH user: host-level override if set, otherwise the session user.
    pub fn effective_user<'a>(&'a self, session_user: &'a str) -> &'a str {
        if self.user.is_empty() {
            session_user
        } else {
            &self.user
        }
    }
}

fn default_ssh_port() -> u16 {
    22
}

#[derive(Debug, Deserialize, Default)]
pub struct HostsConfig {
    pub hosts: Vec<HostEntry>,
}

fn config_path() -> PathBuf {
    PathBuf::from("/etc/tenodera/hosts.json")
}

pub async fn find_host(host_id: &str) -> Option<HostEntry> {
    let path = config_path();
    let content = match tokio::fs::read_to_string(&path).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "failed to read hosts config");
            return None;
        }
    };
    let config: HostsConfig = match serde_json::from_str(&content) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "failed to parse hosts config");
            return None;
        }
    };

    config.hosts.into_iter().find(|h| h.id == host_id)
}

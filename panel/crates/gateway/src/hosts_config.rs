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

pub fn find_host(host_id: &str) -> Option<HostEntry> {
    let config: HostsConfig = std::fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    config.hosts.into_iter().find(|h| h.id == host_id)
}

use std::net::SocketAddr;
use std::os::unix::fs::PermissionsExt;

/// Gateway configuration. Later loaded from file / env.
#[derive(Debug, Clone)]
pub struct GatewayConfig {
    pub bind_addr: SocketAddr,
    pub allow_unencrypted: bool,
    pub idle_timeout_secs: u64,
    pub max_startups: usize,
    /// Path to the tenodera-agent binary.
    pub agent_bin: String,
    /// TLS certificate file path (PEM). If set with tls_key, enables TLS.
    pub tls_cert: Option<String>,
    /// TLS private key file path (PEM).
    pub tls_key: Option<String>,
    /// Publicly reachable URL of this gateway (used in install commands).
    /// Set TENODERA_EXTERNAL_URL in tenodera.cnf, e.g. https://panel.example.com
    pub external_url: Option<String>,
    /// PSK enrollment token agents must present in Hello.
    /// Generated automatically by tenodera.sh at install time.
    /// If absent, all agents are accepted (backward-compat only — not recommended).
    pub agent_token: Option<String>,
}

impl GatewayConfig {
    /// Validate configuration at startup — fail fast with clear error messages
    /// instead of silently starting and failing on first user action.
    pub fn validate(&self) -> anyhow::Result<()> {
        // Check agent binary exists and is executable.
        // If the path contains no '/', search PATH like the shell would.
        let agent_path = if self.agent_bin.contains('/') {
            std::path::PathBuf::from(&self.agent_bin)
        } else {
            std::env::var_os("PATH")
                .unwrap_or_default()
                .to_string_lossy()
                .split(':')
                .map(|dir| std::path::Path::new(dir).join(&self.agent_bin))
                .find(|p| p.exists())
                .unwrap_or_else(|| std::path::PathBuf::from(&self.agent_bin))
        };

        match std::fs::metadata(&agent_path) {
            Ok(meta) => {
                if meta.permissions().mode() & 0o111 == 0 {
                    anyhow::bail!(
                        "agent binary '{}' exists but is not executable — run: chmod +x {}",
                        agent_path.display(), agent_path.display()
                    );
                }
            }
            Err(e) => {
                anyhow::bail!(
                    "agent binary '{}' not found: {} — build and install tenodera-agent first",
                    self.agent_bin, e
                );
            }
        }

        // If TLS is partially configured, require both cert and key
        match (&self.tls_cert, &self.tls_key) {
            (Some(cert), Some(key)) => {
                // Both set — verify both paths are readable
                std::fs::File::open(cert).map_err(|e| {
                    anyhow::anyhow!("TLS cert '{}' not readable: {}", cert, e)
                })?;
                std::fs::File::open(key).map_err(|e| {
                    anyhow::anyhow!("TLS key '{}' not readable: {}", key, e)
                })?;
            }
            (Some(_), None) => {
                anyhow::bail!(
                    "TENODERA_TLS_CERT is set but TENODERA_TLS_KEY is missing — set both or neither"
                );
            }
            (None, Some(_)) => {
                anyhow::bail!(
                    "TENODERA_TLS_KEY is set but TENODERA_TLS_CERT is missing — set both or neither"
                );
            }
            (None, None) => {
                if !self.allow_unencrypted {
                    anyhow::bail!(
                        "TLS is required but not configured.\n\
                         Set TENODERA_TLS_CERT and TENODERA_TLS_KEY, or set TENODERA_ALLOW_UNENCRYPTED=1 for dev.\n\
                         Quick self-signed cert:\n\
                         \topenssl req -x509 -newkey rsa:4096 -nodes -days 365 \\\n\
                         \t  -keyout /etc/tenodera/tls/key.pem \\\n\
                         \t  -out /etc/tenodera/tls/cert.pem \\\n\
                         \t  -subj \"/CN=$(hostname)\""
                    );
                }
            }
        }

        Ok(())
    }
}

impl Default for GatewayConfig {
    fn default() -> Self {
        // Support both TENODERA_BIND (addr:port) and separate TENODERA_BIND_ADDR / TENODERA_BIND_PORT.
        // The combined form takes precedence for backward compatibility.
        let bind_addr = std::env::var("TENODERA_BIND")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(|| {
                let addr =
                    std::env::var("TENODERA_BIND_ADDR").unwrap_or_else(|_| "127.0.0.1".to_string());
                let port: u16 = std::env::var("TENODERA_BIND_PORT")
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(9090);
                format!("{addr}:{port}")
                    .parse()
                    .unwrap_or_else(|_| SocketAddr::from(([127, 0, 0, 1], 9090)))
            });
        Self {
            bind_addr,
            allow_unencrypted: std::env::var("TENODERA_ALLOW_UNENCRYPTED")
                .map(|v| v == "1" || v == "true")
                .unwrap_or(false), // secure default; set TENODERA_ALLOW_UNENCRYPTED=1 for dev
            idle_timeout_secs: std::env::var("TENODERA_IDLE_TIMEOUT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(900),
            max_startups: std::env::var("TENODERA_MAX_STARTUPS")
                .ok()
                .and_then(|s| s.parse().ok())
                .map(|n: usize| n.max(1)) // min 1 to prevent disabling all auth
                .unwrap_or(20),
            agent_bin: std::env::var("TENODERA_AGENT_BIN")
                .unwrap_or_else(|_| "tenodera-agent".to_string()),
            tls_cert: std::env::var("TENODERA_TLS_CERT")
                .ok()
                .filter(|s| !s.is_empty()),
            tls_key: std::env::var("TENODERA_TLS_KEY")
                .ok()
                .filter(|s| !s.is_empty()),
            external_url: std::env::var("TENODERA_EXTERNAL_URL")
                .ok()
                .filter(|s| !s.is_empty())
                .map(|s| s.trim_end_matches('/').to_string()),
            agent_token: std::env::var("TENODERA_AGENT_TOKEN")
                .ok()
                .filter(|s| !s.is_empty()),
        }
    }
}

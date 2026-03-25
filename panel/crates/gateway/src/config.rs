use std::net::SocketAddr;

/// Gateway configuration. Later loaded from file / env.
#[derive(Debug, Clone)]
pub struct GatewayConfig {
    pub bind_addr: SocketAddr,
    pub allow_unencrypted: bool,
    pub idle_timeout_secs: u64,
    pub max_startups: usize,
    /// Path to the tenodera-bridge binary.
    pub bridge_bin: String,
    /// TLS certificate file path (PEM). If set with tls_key, enables TLS.
    pub tls_cert: Option<String>,
    /// TLS private key file path (PEM).
    pub tls_key: Option<String>,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        let bind_addr = std::env::var("TENODERA_BIND")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(|| SocketAddr::from(([127, 0, 0, 1], 9090)));
        Self {
            bind_addr,
            allow_unencrypted: std::env::var("TENODERA_ALLOW_UNENCRYPTED")
                .map(|v| v == "1" || v == "true")
                .unwrap_or(false), // secure default; set TENODERA_ALLOW_UNENCRYPTED=1 for dev
            idle_timeout_secs: 900,
            max_startups: 20,
            bridge_bin: std::env::var("TENODERA_BRIDGE_BIN")
                .unwrap_or_else(|_| "tenodera-bridge".to_string()),
            tls_cert: std::env::var("TENODERA_TLS_CERT").ok(),
            tls_key: std::env::var("TENODERA_TLS_KEY").ok(),
        }
    }
}

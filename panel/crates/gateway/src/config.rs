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
                .unwrap_or(20),
            bridge_bin: std::env::var("TENODERA_BRIDGE_BIN")
                .unwrap_or_else(|_| "tenodera-bridge".to_string()),
            tls_cert: std::env::var("TENODERA_TLS_CERT").ok(),
            tls_key: std::env::var("TENODERA_TLS_KEY").ok(),
        }
    }
}

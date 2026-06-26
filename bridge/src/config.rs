
pub struct BridgeConfig {
    pub gateway_url: String,
    pub token: String,
    /// Skip TLS certificate verification. Use only for dev/self-signed certs.
    pub accept_insecure: bool,
}

impl BridgeConfig {
    pub fn from_env() -> anyhow::Result<Self> {
        load_env_file();

        let gateway_url = std::env::var("TENODERA_GATEWAY_URL")
            .map_err(|_| anyhow::anyhow!("TENODERA_GATEWAY_URL not set in environment or /etc/tenodera/bridge.env"))?;
        let token = std::env::var("TENODERA_BRIDGE_TOKEN")
            .map_err(|_| anyhow::anyhow!("TENODERA_BRIDGE_TOKEN not set in environment or /etc/tenodera/bridge.env"))?;

        let accept_insecure = std::env::var("TENODERA_BRIDGE_ACCEPT_INSECURE")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);

        Ok(Self { gateway_url, token, accept_insecure })
    }

    /// WebSocket URL for the bridge endpoint on the gateway.
    pub fn bridge_ws_url(&self) -> String {
        let base = self.gateway_url.trim_end_matches('/');
        let base = base
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1);
        format!("{base}/api/bridge")
    }
}

fn load_env_file() {
    let path = "/etc/tenodera/bridge.env";
    let Ok(content) = std::fs::read_to_string(path) else { return };
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, val)) = line.split_once('=') {
            let key = key.trim();
            let val = val.trim().trim_matches('"').trim_matches('\'');
            if std::env::var(key).is_err() {
                // Safety: single-threaded at startup, before tokio runtime starts
                unsafe { std::env::set_var(key, val) };
            }
        }
    }
}

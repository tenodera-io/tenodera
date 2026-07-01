
pub struct AgentConfig {
    pub gateway_url: String,
    /// Skip TLS certificate verification. Use only for dev/self-signed certs.
    pub accept_insecure: bool,
}

impl AgentConfig {
    pub fn from_env() -> anyhow::Result<Self> {
        load_env_file();

        let gateway_url = std::env::var("TENODERA_GATEWAY_URL")
            .map_err(|_| anyhow::anyhow!("TENODERA_GATEWAY_URL not set in environment or /etc/tenodera/agent.env"))?;

        let accept_insecure = std::env::var("TENODERA_AGENT_ACCEPT_INSECURE")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);

        Ok(Self { gateway_url, accept_insecure })
    }

    /// WebSocket URL for the agent endpoint on the gateway.
    pub fn agent_ws_url(&self) -> String {
        let base = self.gateway_url.trim_end_matches('/');
        let base = base
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1);
        format!("{base}/api/agent")
    }

    /// True when the gateway URL points to localhost — used to mark the panel host.
    pub fn is_local(&self) -> bool {
        let u = &self.gateway_url;
        u.contains("127.0.0.1") || u.contains("localhost") || u.contains("::1")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(url: &str) -> AgentConfig {
        AgentConfig { gateway_url: url.to_string(), accept_insecure: false }
    }

    #[test]
    fn https_becomes_wss() {
        assert_eq!(
            cfg("https://panel.example.com:9090").agent_ws_url(),
            "wss://panel.example.com:9090/api/agent"
        );
    }

    #[test]
    fn http_becomes_ws() {
        assert_eq!(
            cfg("http://panel.example.com:9090").agent_ws_url(),
            "ws://panel.example.com:9090/api/agent"
        );
    }

    #[test]
    fn trailing_slash_stripped() {
        assert_eq!(
            cfg("https://panel.example.com:9090/").agent_ws_url(),
            "wss://panel.example.com:9090/api/agent"
        );
    }

    #[test]
    fn is_local_127() {
        assert!(cfg("https://127.0.0.1:9090").is_local());
    }

    #[test]
    fn is_local_localhost() {
        assert!(cfg("http://localhost:9090").is_local());
    }

    #[test]
    fn is_local_ipv6_loopback() {
        assert!(cfg("http://[::1]:9090").is_local());
    }

    #[test]
    fn is_local_remote_false() {
        assert!(!cfg("https://192.168.56.10:9090").is_local());
    }
}

fn load_env_file() {
    let path = "/etc/tenodera/agent.env";
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

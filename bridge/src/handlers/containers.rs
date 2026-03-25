use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

use crate::handler::ChannelHandler;

pub struct ContainersHandler;

#[async_trait::async_trait]
impl ChannelHandler for ContainersHandler {
    fn payload_type(&self) -> &str {
        "container.manage"
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        // On open: detect which runtime is available and return info + container list
        let runtime = detect_runtime();
        let info = match &runtime {
            Some(rt) => get_info(rt).await,
            None => serde_json::json!({ "available": false }),
        };

        vec![
            Message::Ready {
                channel: channel.to_string(),
            },
            Message::Data {
                channel: channel.to_string(),
                data: serde_json::json!({
                    "type": "init",
                    "runtime": runtime,
                    "info": info,
                }),
            },
        ]
        // NOTE: no Close — channel stays open for bidirectional commands
    }

    async fn data(&self, channel: &str, data: &serde_json::Value) -> Vec<Message> {
        let action = data.get("action").and_then(|a| a.as_str()).unwrap_or("");
        let user = data.get("_user").and_then(|u| u.as_str()).unwrap_or("");
        let runtime = detect_runtime();
        let Some(rt) = runtime else {
            return vec![Message::Data {
                channel: channel.to_string(),
                data: serde_json::json!({ "type": "error", "action": action, "error": "No container runtime found" }),
            }];
        };

        let result = match action {
            "list_containers" => list_containers(&rt).await,
            "list_images" => list_images(&rt).await,
            "inspect" => {
                let id = data.get("id").and_then(|v| v.as_str()).unwrap_or("");
                inspect_container(&rt, id).await
            }
            "start" => {
                let id = data.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let password = data.get("password").and_then(|v| v.as_str()).unwrap_or("");
                container_action_sudo(&rt, "start", id, password).await
            }
            "stop" => {
                let id = data.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let password = data.get("password").and_then(|v| v.as_str()).unwrap_or("");
                container_action_sudo(&rt, "stop", id, password).await
            }
            "restart" => {
                let id = data.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let password = data.get("password").and_then(|v| v.as_str()).unwrap_or("");
                container_action_sudo(&rt, "restart", id, password).await
            }
            "remove" => {
                let id = data.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let force = data.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
                let password = data.get("password").and_then(|v| v.as_str()).unwrap_or("");
                remove_container(&rt, id, force, password).await
            }
            "remove_image" => {
                let id = data.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let force = data.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
                let password = data.get("password").and_then(|v| v.as_str()).unwrap_or("");
                remove_image(&rt, id, force, password).await
            }
            "pull" => {
                let image = data.get("image").and_then(|v| v.as_str()).unwrap_or("");
                let password = data.get("password").and_then(|v| v.as_str()).unwrap_or("");
                pull_image(&rt, image, password).await
            }
            "create" => {
                let password = data.get("password").and_then(|v| v.as_str()).unwrap_or("");
                create_container(&rt, data, password).await
            }
            "logs" => {
                let id = data.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let tail = data.get("tail").and_then(|v| v.as_u64()).unwrap_or(100);
                container_logs(&rt, id, tail).await
            }
            "service_status" => service_status(&rt).await,
            "service_start" => {
                let password = data.get("password").and_then(|v| v.as_str()).unwrap_or("");
                service_action_sudo(&rt, "start", password).await
            }
            "service_stop" => {
                let password = data.get("password").and_then(|v| v.as_str()).unwrap_or("");
                service_action_sudo(&rt, "stop", password).await
            }
            "service_restart" => {
                let password = data.get("password").and_then(|v| v.as_str()).unwrap_or("");
                service_action_sudo(&rt, "restart", password).await
            }
            _ => serde_json::json!({ "type": "error", "error": format!("unknown action: {action}") }),
        };

        // Audit mutating container actions
        match action {
            "start" | "stop" | "restart" | "remove" | "remove_image" | "pull" | "create"
            | "service_start" | "service_stop" | "service_restart" => {
                let target = data.get("id").or(data.get("image")).and_then(|v| v.as_str()).unwrap_or("");
                let ok = result.get("error").is_none();
                crate::audit::log(user, &format!("container.{action}"), target, ok, "");
            }
            _ => {}
        }

        vec![Message::Data {
            channel: channel.to_string(),
            data: serde_json::json!({ "type": "response", "action": action, "data": result }),
        }]
    }
}

/// Detect which container runtime is available (prefer docker, fallback to podman).
/// Checks daemon responsiveness, not just binary existence.
fn detect_runtime() -> Option<String> {
    for rt in &["docker", "podman"] {
        // Quick check: can we talk to the daemon?
        if std::process::Command::new(rt)
            .args(["info", "--format", "{{.ID}}"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
        {
            return Some((*rt).to_string());
        }
    }
    // Fallback: binary exists but daemon may not respond
    for rt in &["docker", "podman"] {
        if std::process::Command::new(rt)
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
        {
            return Some((*rt).to_string());
        }
    }
    None
}

async fn get_info(rt: &str) -> serde_json::Value {
    let version = run_cmd(rt, &["version", "--format", "json"]).await;
    let service = service_status(rt).await;
    serde_json::json!({
        "available": true,
        "version": version,
        "service": service,
    })
}

async fn list_containers(rt: &str) -> serde_json::Value {
    run_cmd(rt, &["ps", "-a", "--format", "{{json .}}", "--no-trunc"]).await
}

async fn list_images(rt: &str) -> serde_json::Value {
    run_cmd(rt, &["images", "--format", "{{json .}}", "--no-trunc"]).await
}

async fn inspect_container(rt: &str, id: &str) -> serde_json::Value {
    if id.is_empty() {
        return serde_json::json!({ "error": "no container id" });
    }
    if !is_valid_container_ref(id) {
        return serde_json::json!({ "error": "invalid container id" });
    }
    run_cmd(rt, &["inspect", id]).await
}

async fn container_action_sudo(rt: &str, action: &str, id: &str, password: &str) -> serde_json::Value {
    if id.is_empty() {
        return serde_json::json!({ "error": "no container id" });
    }
    if !is_valid_container_ref(id) {
        return serde_json::json!({ "error": "invalid container id" });
    }
    if password.is_empty() {
        return serde_json::json!({ "error": "password required" });
    }
    sudo_cmd(password, &[rt, action, id]).await
}

async fn remove_container(rt: &str, id: &str, force: bool, password: &str) -> serde_json::Value {
    if id.is_empty() {
        return serde_json::json!({ "error": "no container id" });
    }
    if !is_valid_container_ref(id) {
        return serde_json::json!({ "error": "invalid container id" });
    }
    if password.is_empty() {
        return serde_json::json!({ "error": "password required" });
    }
    let mut args = vec![rt, "rm"];
    if force {
        args.push("-f");
    }
    args.push(id);
    sudo_cmd(password, &args).await
}

async fn remove_image(rt: &str, id: &str, force: bool, password: &str) -> serde_json::Value {
    if id.is_empty() {
        return serde_json::json!({ "error": "no image id" });
    }
    if !is_valid_image_ref(id) {
        return serde_json::json!({ "error": "invalid image reference" });
    }
    if password.is_empty() {
        return serde_json::json!({ "error": "password required" });
    }
    let mut args = vec![rt, "rmi"];
    if force {
        args.push("-f");
    }
    args.push(id);
    sudo_cmd(password, &args).await
}

async fn pull_image(rt: &str, image: &str, password: &str) -> serde_json::Value {
    if image.is_empty() {
        return serde_json::json!({ "error": "no image specified" });
    }
    if !is_valid_image_ref(image) {
        return serde_json::json!({ "error": "invalid image reference" });
    }
    if password.is_empty() {
        return serde_json::json!({ "error": "password required" });
    }
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(300),
        sudo_cmd(password, &[rt, "pull", image]),
    )
    .await;
    match output {
        Ok(res) => res,
        Err(_) => serde_json::json!({ "ok": false, "error": "pull timed out after 5 minutes", "action": "pull" }),
    }
}

/// Paths that must never be bind-mounted into containers.
/// These provide direct access to host internals or credentials.
const DENIED_VOLUME_PATHS: &[&str] = &[
    "/", "/etc", "/etc/shadow", "/etc/passwd", "/etc/sudoers",
    "/proc", "/sys", "/dev", "/boot",
    "/var/run/docker.sock", "/run/docker.sock",
    "/var/run/podman", "/run/podman",
];

/// Check whether a host volume path is safe to mount.
fn is_safe_volume_path(path: &str) -> bool {
    if path.is_empty() || !path.starts_with('/') {
        return false;
    }
    if path.contains("..") {
        return false;
    }
    // Normalize: strip trailing slash for comparison
    let normalized = path.trim_end_matches('/');
    for denied in DENIED_VOLUME_PATHS {
        if normalized.eq_ignore_ascii_case(denied) {
            return false;
        }
    }
    true
}

async fn create_container(rt: &str, data: &serde_json::Value, password: &str) -> serde_json::Value {
    let image = data.get("image").and_then(|v| v.as_str()).unwrap_or("");
    if image.is_empty() {
        return serde_json::json!({ "error": "no image specified" });
    }
    if !is_valid_image_ref(image) {
        return serde_json::json!({ "error": "invalid image reference" });
    }
    if password.is_empty() {
        return serde_json::json!({ "error": "password required" });
    }

    let mut args: Vec<String> = vec![rt.into(), "run".into(), "-d".into()];

    // Container name
    if let Some(name) = data.get("name").and_then(|v| v.as_str())
        && !name.is_empty() {
            args.push("--name".into());
            args.push(name.into());
        }

    // Port mappings: [{host: "8080", container: "80"}]
    if let Some(ports) = data.get("ports").and_then(|v| v.as_array()) {
        for p in ports {
            let host = p.get("host").and_then(|v| v.as_str()).unwrap_or("");
            let container = p.get("container").and_then(|v| v.as_str()).unwrap_or("");
            if !host.is_empty() && !container.is_empty() {
                // Validate port numbers
                if host.parse::<u16>().is_err() || container.parse::<u16>().is_err() {
                    return serde_json::json!({ "error": format!("invalid port: {host}:{container}") });
                }
                args.push("-p".into());
                args.push(format!("{host}:{container}"));
            }
        }
    }

    // Environment variables: [{key: "FOO", value: "bar"}]
    if let Some(envs) = data.get("env").and_then(|v| v.as_array()) {
        for e in envs {
            let key = e.get("key").and_then(|v| v.as_str()).unwrap_or("");
            let value = e.get("value").and_then(|v| v.as_str()).unwrap_or("");
            if !key.is_empty() {
                args.push("-e".into());
                args.push(format!("{key}={value}"));
            }
        }
    }

    // Volume mounts: [{host: "/data", container: "/app/data"}]
    if let Some(vols) = data.get("volumes").and_then(|v| v.as_array()) {
        for v in vols {
            let host = v.get("host").and_then(|v| v.as_str()).unwrap_or("");
            let container = v.get("container").and_then(|v| v.as_str()).unwrap_or("");
            if !host.is_empty() && !container.is_empty() {
                if !is_safe_volume_path(host) {
                    return serde_json::json!({ "error": format!("volume path denied: {host}") });
                }
                args.push("-v".into());
                args.push(format!("{host}:{container}"));
            }
        }
    }

    // Restart policy
    if let Some(restart) = data.get("restart").and_then(|v| v.as_str())
        && !restart.is_empty() {
            args.push("--restart".into());
            args.push(restart.into());
        }

    args.push(image.into());

    // Optional command
    if let Some(cmd) = data.get("command").and_then(|v| v.as_str())
        && !cmd.is_empty() {
            // Split command by whitespace
            for part in cmd.split_whitespace() {
                args.push(part.into());
            }
        }

    let str_args: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    sudo_cmd(password, &str_args).await
}

async fn container_logs(rt: &str, id: &str, tail: u64) -> serde_json::Value {
    if id.is_empty() {
        return serde_json::json!({ "error": "no container id" });
    }
    let tail_str = tail.to_string();
    let output = tokio::process::Command::new(rt)
        .args(["logs", "--tail", &tail_str, "--timestamps", id])
        .output()
        .await;

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            // Combine both streams (many containers log to stderr)
            let combined = if stderr.is_empty() {
                stdout.to_string()
            } else if stdout.is_empty() {
                stderr.to_string()
            } else {
                format!("{stdout}\n{stderr}")
            };
            serde_json::json!({ "logs": combined })
        }
        Err(e) => serde_json::json!({ "error": e.to_string() }),
    }
}

async fn service_status(rt: &str) -> serde_json::Value {
    let service_name = if rt == "podman" { "podman.socket" } else { "docker.service" };
    let output = tokio::process::Command::new("systemctl")
        .args(["is-active", service_name])
        .output()
        .await;

    let active = match output {
        Ok(out) => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        Err(_) => "unknown".to_string(),
    };

    let enabled_output = tokio::process::Command::new("systemctl")
        .args(["is-enabled", service_name])
        .output()
        .await;

    let enabled = match enabled_output {
        Ok(out) => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        Err(_) => "unknown".to_string(),
    };

    serde_json::json!({
        "service": service_name,
        "active": active,
        "enabled": enabled,
    })
}

async fn service_action_sudo(rt: &str, action: &str, password: &str) -> serde_json::Value {
    let service_name = if rt == "podman" { "podman.socket" } else { "docker.service" };
    if password.is_empty() {
        return serde_json::json!({ "error": "password required" });
    }
    sudo_cmd(password, &["systemctl", action, service_name]).await
}

async fn sudo_cmd(password: &str, args: &[&str]) -> serde_json::Value {
    use tokio::io::AsyncWriteExt;

    let mut cmd_args = vec!["-S"];
    cmd_args.extend_from_slice(args);

    let child = tokio::process::Command::new("sudo")
        .args(&cmd_args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();

    let mut child = match child {
        Ok(c) => c,
        Err(e) => return serde_json::json!({ "error": e.to_string() }),
    };

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{password}\n").as_bytes()).await;
        drop(stdin);
    }

    match child.wait_with_output().await {
        Ok(out) if out.status.success() => serde_json::json!({ "ok": true }),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let clean = stderr.lines()
                .filter(|l| !l.contains("[sudo]") && !l.contains("password for"))
                .collect::<Vec<_>>()
                .join("\n");
            let msg = if clean.is_empty() { "authentication failed".to_string() } else { clean };
            serde_json::json!({ "error": msg })
        }
        Err(e) => serde_json::json!({ "error": e.to_string() }),
    }
}

/// Run a container runtime command and parse the JSON output.
async fn run_cmd(rt: &str, args: &[&str]) -> serde_json::Value {
    let output = tokio::process::Command::new(rt)
        .args(args)
        .output()
        .await;

    match output {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let trimmed = stdout.trim();
            if trimmed.is_empty() {
                return serde_json::Value::Array(vec![]);
            }
            // Some runtimes (podman) output one JSON object per line instead of an array
            if trimmed.starts_with('[') || trimmed.starts_with('{') {
                // Try parsing as-is first
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
                    // Ensure we always return an array (single object → wrap in array)
                    return match v {
                        serde_json::Value::Array(_) => v,
                        serde_json::Value::Object(_) => serde_json::Value::Array(vec![v]),
                        other => other,
                    };
                }
                // Try parsing line-by-line (podman `ps --format json` on some versions)
                let mut items = Vec::new();
                for line in trimmed.lines() {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                        items.push(v);
                    }
                }
                if !items.is_empty() {
                    return serde_json::Value::Array(items);
                }
            }
            serde_json::json!({ "raw": trimmed })
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            serde_json::json!({ "error": stderr.trim() })
        }
        Err(e) => serde_json::json!({ "error": e.to_string() }),
    }
}

/// Valid container reference: hex ID, name (alphanumeric + hyphens/underscores/dots).
fn is_valid_container_ref(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && !id.starts_with('-')
        && id.chars().all(|c| c.is_alphanumeric() || "-_.".contains(c))
}

/// Valid image reference: registry/repo:tag format — alphanumeric, dots, hyphens,
/// underscores, slashes, colons.
fn is_valid_image_ref(image: &str) -> bool {
    !image.is_empty()
        && image.len() <= 512
        && !image.starts_with('-')
        && image.chars().all(|c| c.is_alphanumeric() || "-_./: ".contains(c))
        && !image.contains("..")
}

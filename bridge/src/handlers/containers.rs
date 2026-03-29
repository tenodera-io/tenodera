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
        let password = data.get("password").and_then(|v| v.as_str()).unwrap_or("");

        // Detect runtime: try user-level first, then sudo if password available
        let user_rt = detect_runtime();
        let sudo_rt = if !password.is_empty() {
            detect_runtime_sudo(password).await
        } else {
            None
        };
        let rt = user_rt.as_deref().or(sudo_rt.as_deref());

        let Some(rt) = rt else {
            return vec![Message::Data {
                channel: channel.to_string(),
                data: serde_json::json!({ "type": "error", "action": action, "error": "No container runtime found" }),
            }];
        };

        let result = match action {
            "list_containers" => list_containers_merged(rt, password).await,
            "list_images" => list_images_merged(rt, password).await,
            "inspect" => {
                let id = data.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let owner = data.get("owner").and_then(|v| v.as_str()).unwrap_or("user");
                inspect_container(rt, id, owner, password).await
            }
            "start" => {
                let id = data.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let owner = data.get("owner").and_then(|v| v.as_str()).unwrap_or("root");
                container_action(rt, "start", id, owner, password).await
            }
            "stop" => {
                let id = data.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let owner = data.get("owner").and_then(|v| v.as_str()).unwrap_or("root");
                container_action(rt, "stop", id, owner, password).await
            }
            "restart" => {
                let id = data.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let owner = data.get("owner").and_then(|v| v.as_str()).unwrap_or("root");
                container_action(rt, "restart", id, owner, password).await
            }
            "remove" => {
                let id = data.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let force = data.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
                let owner = data.get("owner").and_then(|v| v.as_str()).unwrap_or("root");
                remove_container(rt, id, force, owner, password).await
            }
            "remove_image" => {
                let id = data.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let force = data.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
                let owner = data.get("owner").and_then(|v| v.as_str()).unwrap_or("root");
                remove_image(rt, id, force, owner, password).await
            }
            "pull" => {
                let image = data.get("image").and_then(|v| v.as_str()).unwrap_or("");
                pull_image(rt, image, password).await
            }
            "create" => {
                create_container(rt, data, password).await
            }
            "logs" => {
                let id = data.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let tail = data.get("tail").and_then(|v| v.as_u64()).unwrap_or(100);
                let owner = data.get("owner").and_then(|v| v.as_str()).unwrap_or("user");
                container_logs(rt, id, tail, owner, password).await
            }
            "service_status" => service_status(rt).await,
            "service_start" => {
                service_action_sudo(rt, "start", password).await
            }
            "service_stop" => {
                service_action_sudo(rt, "stop", password).await
            }
            "service_restart" => {
                service_action_sudo(rt, "restart", password).await
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

// ── Runtime detection ──────────────────────────────────────

/// Detect which container runtime is available as the current user.
fn detect_runtime() -> Option<String> {
    for rt in &["docker", "podman"] {
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

/// Detect container runtime via sudo (for users not in docker group).
async fn detect_runtime_sudo(password: &str) -> Option<String> {
    use tokio::io::AsyncWriteExt;

    for rt in &["docker", "podman"] {
        let child = tokio::process::Command::new("sudo")
            .args(["-S", rt, "info", "--format", "{{.ID}}"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();

        if let Ok(mut child) = child {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(format!("{password}\n").as_bytes()).await;
                drop(stdin);
            }
            if let Ok(out) = child.wait().await
                && out.success() {
                    return Some((*rt).to_string());
                }
        }
    }
    None
}

// ── Info ───────────────────────────────────────────────────

async fn get_info(rt: &str) -> serde_json::Value {
    let version = run_cmd(rt, &["version", "--format", "json"]).await;
    let service = service_status(rt).await;
    serde_json::json!({
        "available": true,
        "version": version,
        "service": service,
    })
}

// ── Merged listing (user + root) ──────────────────────────

/// List containers: run as user, then as root (via sudo) if password
/// is provided. Merge results, deduplicate by ID, tag each with "owner".
async fn list_containers_merged(rt: &str, password: &str) -> serde_json::Value {
    let user_list = run_cmd_parsed(rt, &["ps", "-a", "--format", "{{json .}}", "--no-trunc"]).await;
    let mut seen = std::collections::HashSet::new();
    let mut merged: Vec<serde_json::Value> = Vec::new();

    // Add user containers
    for mut c in user_list {
        let id = container_id(&c);
        if !id.is_empty() {
            seen.insert(id);
        }
        c.as_object_mut().map(|o| o.insert("_owner".to_string(), serde_json::json!("user")));
        merged.push(c);
    }

    // Add root containers (if password provided)
    if !password.is_empty() {
        let root_list = run_sudo_cmd_parsed(password, rt, &["ps", "-a", "--format", "{{json .}}", "--no-trunc"]).await;
        for mut c in root_list {
            let id = container_id(&c);
            if !id.is_empty() && seen.contains(&id) {
                continue; // already seen as user — skip duplicate
            }
            if !id.is_empty() {
                seen.insert(id);
            }
            c.as_object_mut().map(|o| o.insert("_owner".to_string(), serde_json::json!("root")));
            merged.push(c);
        }
    }

    serde_json::Value::Array(merged)
}

/// List images: same dual-query approach.
async fn list_images_merged(rt: &str, password: &str) -> serde_json::Value {
    let user_list = run_cmd_parsed(rt, &["images", "--format", "{{json .}}", "--no-trunc"]).await;
    let mut seen = std::collections::HashSet::new();
    let mut merged: Vec<serde_json::Value> = Vec::new();

    for mut img in user_list {
        let id = image_id(&img);
        if !id.is_empty() {
            seen.insert(id);
        }
        img.as_object_mut().map(|o| o.insert("_owner".to_string(), serde_json::json!("user")));
        merged.push(img);
    }

    if !password.is_empty() {
        let root_list = run_sudo_cmd_parsed(password, rt, &["images", "--format", "{{json .}}", "--no-trunc"]).await;
        for mut img in root_list {
            let id = image_id(&img);
            if !id.is_empty() && seen.contains(&id) {
                continue;
            }
            if !id.is_empty() {
                seen.insert(id);
            }
            img.as_object_mut().map(|o| o.insert("_owner".to_string(), serde_json::json!("root")));
            merged.push(img);
        }
    }

    serde_json::Value::Array(merged)
}

/// Extract container ID from JSON object (docker uses "ID", podman uses "Id").
fn container_id(c: &serde_json::Value) -> String {
    c.get("Id")
        .or(c.get("ID"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Extract image ID from JSON object.
fn image_id(img: &serde_json::Value) -> String {
    img.get("Id")
        .or(img.get("ID"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

// ── Container actions (owner-aware) ───────────────────────

async fn container_action(rt: &str, action: &str, id: &str, owner: &str, password: &str) -> serde_json::Value {
    if id.is_empty() {
        return serde_json::json!({ "error": "no container id" });
    }
    if !is_valid_container_ref(id) {
        return serde_json::json!({ "error": "invalid container id" });
    }
    if owner == "root" {
        if password.is_empty() {
            return serde_json::json!({ "error": "password required for root containers" });
        }
        sudo_cmd(password, &[rt, action, "--", id]).await
    } else {
        // User container — try direct first
        run_cmd_result(rt, &[action, "--", id]).await
    }
}

async fn remove_container(rt: &str, id: &str, force: bool, owner: &str, password: &str) -> serde_json::Value {
    if id.is_empty() {
        return serde_json::json!({ "error": "no container id" });
    }
    if !is_valid_container_ref(id) {
        return serde_json::json!({ "error": "invalid container id" });
    }
    if owner == "root" {
        if password.is_empty() {
            return serde_json::json!({ "error": "password required for root containers" });
        }
        let mut args = vec![rt, "rm"];
        if force { args.push("-f"); }
        args.push("--");
        args.push(id);
        sudo_cmd(password, &args).await
    } else {
        let mut args = vec!["rm"];
        if force { args.push("-f"); }
        args.push("--");
        args.push(id);
        run_cmd_result(rt, &args).await
    }
}

async fn remove_image(rt: &str, id: &str, force: bool, owner: &str, password: &str) -> serde_json::Value {
    if id.is_empty() {
        return serde_json::json!({ "error": "no image id" });
    }
    if !is_valid_image_ref(id) {
        return serde_json::json!({ "error": "invalid image reference" });
    }
    if owner == "root" {
        if password.is_empty() {
            return serde_json::json!({ "error": "password required for root images" });
        }
        let mut args = vec![rt, "rmi"];
        if force { args.push("-f"); }
        args.push("--");
        args.push(id);
        sudo_cmd(password, &args).await
    } else {
        let mut args = vec!["rmi"];
        if force { args.push("-f"); }
        args.push("--");
        args.push(id);
        run_cmd_result(rt, &args).await
    }
}

async fn inspect_container(rt: &str, id: &str, owner: &str, password: &str) -> serde_json::Value {
    if id.is_empty() {
        return serde_json::json!({ "error": "no container id" });
    }
    if !is_valid_container_ref(id) {
        return serde_json::json!({ "error": "invalid container id" });
    }
    if owner == "root" && !password.is_empty() {
        run_sudo_cmd(password, rt, &["inspect", "--", id]).await
    } else {
        run_cmd(rt, &["inspect", "--", id]).await
    }
}

async fn container_logs(rt: &str, id: &str, tail: u64, owner: &str, password: &str) -> serde_json::Value {
    if id.is_empty() {
        return serde_json::json!({ "error": "no container id" });
    }
    if !is_valid_container_ref(id) {
        return serde_json::json!({ "error": "invalid container id" });
    }
    let tail_str = tail.to_string();

    if owner == "root" && !password.is_empty() {
        // Use sudo for root containers
        let output = run_sudo_cmd_raw(password, rt, &["logs", "--tail", &tail_str, "--timestamps", "--", id]).await;
        return match output {
            Ok((stdout, stderr)) => {
                let combined = if stderr.is_empty() {
                    stdout
                } else if stdout.is_empty() {
                    stderr
                } else {
                    format!("{stdout}\n{stderr}")
                };
                serde_json::json!({ "logs": combined, "id": id })
            }
            Err(e) => serde_json::json!({ "error": e }),
        };
    }

    let output = tokio::process::Command::new(rt)
        .args(["logs", "--tail", &tail_str, "--timestamps", "--", id])
        .output()
        .await;

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            let combined = if stderr.is_empty() {
                stdout.to_string()
            } else if stdout.is_empty() {
                stderr.to_string()
            } else {
                format!("{stdout}\n{stderr}")
            };
            serde_json::json!({ "logs": combined, "id": id })
        }
        Err(e) => serde_json::json!({ "error": e.to_string() }),
    }
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
        sudo_cmd(password, &[rt, "pull", "--", image]),
    )
    .await;
    match output {
        Ok(res) => res,
        Err(_) => serde_json::json!({ "ok": false, "error": "pull timed out after 5 minutes", "action": "pull" }),
    }
}

/// Paths that must never be bind-mounted into containers.
const DENIED_VOLUME_PATHS: &[&str] = &[
    "/",
    "/etc",
    "/proc",
    "/sys",
    "/dev",
    "/boot",
    "/root",
    "/var/run/docker.sock",
    "/run/docker.sock",
    "/var/run/podman",
    "/run/podman",
    "/var/lib/docker",
    "/var/lib/containers",
];

fn is_safe_volume_path(path: &str) -> bool {
    if path.is_empty() || !path.starts_with('/') {
        return false;
    }
    if path.contains("..") {
        return false;
    }
    let resolved = std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string());

    let normalized = resolved.trim_end_matches('/');

    for denied in DENIED_VOLUME_PATHS {
        let denied_norm = denied.trim_end_matches('/');
        if normalized.eq_ignore_ascii_case(denied_norm) {
            return false;
        }
        if !denied_norm.is_empty()
            && normalized
                .to_ascii_lowercase()
                .starts_with(&format!("{}/", denied_norm.to_ascii_lowercase()))
        {
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
            if !is_valid_container_ref(name) {
                return serde_json::json!({ "error": "invalid container name" });
            }
            args.push("--name".into());
            args.push(name.into());
        }

    // Port mappings: [{host: "8080", container: "80"}]
    if let Some(ports) = data.get("ports").and_then(|v| v.as_array()) {
        for p in ports {
            let host = p.get("host").and_then(|v| v.as_str()).unwrap_or("");
            let container = p.get("container").and_then(|v| v.as_str()).unwrap_or("");
            if !host.is_empty() && !container.is_empty() {
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
            if !is_valid_restart_policy(restart) {
                return serde_json::json!({ "error": format!("invalid restart policy: {restart}") });
            }
            args.push("--restart".into());
            args.push(restart.into());
        }

    args.push("--".into());
    args.push(image.into());

    // Optional command
    if let Some(cmd) = data.get("command").and_then(|v| v.as_str())
        && !cmd.is_empty() {
            for part in cmd.split_whitespace() {
                args.push(part.into());
            }
        }

    let str_args: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    sudo_cmd(password, &str_args).await
}

// ── Service management ────────────────────────────────────

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

// ── Command execution helpers ─────────────────────────────

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
        Ok(out) if out.status.success() => parse_json_output(&out.stdout),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            serde_json::json!({ "error": stderr.trim() })
        }
        Err(e) => serde_json::json!({ "error": e.to_string() }),
    }
}

/// Run a container runtime command and return ok/error (for actions).
async fn run_cmd_result(rt: &str, args: &[&str]) -> serde_json::Value {
    let output = tokio::process::Command::new(rt)
        .args(args)
        .output()
        .await;

    match output {
        Ok(out) if out.status.success() => serde_json::json!({ "ok": true }),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let msg = if stderr.is_empty() { "command failed".to_string() } else { stderr };
            serde_json::json!({ "error": msg })
        }
        Err(e) => serde_json::json!({ "error": e.to_string() }),
    }
}

/// Run a container runtime command via sudo and parse JSON output.
async fn run_sudo_cmd(password: &str, rt: &str, args: &[&str]) -> serde_json::Value {
    use tokio::io::AsyncWriteExt;

    let mut cmd_args = vec!["-S", rt];
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
        Ok(out) if out.status.success() => parse_json_output(&out.stdout),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let clean = stderr.lines()
                .filter(|l| !l.contains("[sudo]") && !l.contains("password for"))
                .collect::<Vec<_>>()
                .join("\n");
            let msg = if clean.is_empty() { "command failed".to_string() } else { clean };
            serde_json::json!({ "error": msg })
        }
        Err(e) => serde_json::json!({ "error": e.to_string() }),
    }
}

/// Run a sudo command returning raw stdout + stderr strings.
async fn run_sudo_cmd_raw(password: &str, rt: &str, args: &[&str]) -> Result<(String, String), String> {
    use tokio::io::AsyncWriteExt;

    let mut cmd_args = vec!["-S", rt];
    cmd_args.extend_from_slice(args);

    let child = tokio::process::Command::new("sudo")
        .args(&cmd_args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();

    let mut child = match child {
        Ok(c) => c,
        Err(e) => return Err(e.to_string()),
    };

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{password}\n").as_bytes()).await;
        drop(stdin);
    }

    match child.wait_with_output().await {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr_raw = String::from_utf8_lossy(&out.stderr).to_string();
            // Filter sudo prompt lines from stderr
            let stderr: String = stderr_raw.lines()
                .filter(|l| !l.contains("[sudo]") && !l.contains("password for"))
                .collect::<Vec<_>>()
                .join("\n");
            Ok((stdout, stderr))
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Run a sudo container command and parse JSON output into a Vec.
async fn run_sudo_cmd_parsed(password: &str, rt: &str, args: &[&str]) -> Vec<serde_json::Value> {
    use tokio::io::AsyncWriteExt;

    let mut cmd_args = vec!["-S", rt];
    cmd_args.extend_from_slice(args);

    let child = tokio::process::Command::new("sudo")
        .args(&cmd_args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn();

    let mut child = match child {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{password}\n").as_bytes()).await;
        drop(stdin);
    }

    match child.wait_with_output().await {
        Ok(out) if out.status.success() => parse_json_array(&out.stdout),
        _ => vec![],
    }
}

/// Run a user-level command and parse JSON output into a Vec.
async fn run_cmd_parsed(rt: &str, args: &[&str]) -> Vec<serde_json::Value> {
    let output = tokio::process::Command::new(rt)
        .args(args)
        .output()
        .await;

    match output {
        Ok(out) if out.status.success() => parse_json_array(&out.stdout),
        _ => vec![],
    }
}

/// Parse command output as JSON (single value or array).
fn parse_json_output(stdout: &[u8]) -> serde_json::Value {
    let text = String::from_utf8_lossy(stdout);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return serde_json::Value::Array(vec![]);
    }
    if trimmed.starts_with('[') || trimmed.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
            return match v {
                serde_json::Value::Array(_) => v,
                serde_json::Value::Object(_) => serde_json::Value::Array(vec![v]),
                other => other,
            };
        }
        // Try line-by-line (podman `ps --format json` on some versions)
        let mut items = Vec::new();
        for line in trimmed.lines() {
            let line = line.trim();
            if line.is_empty() { continue; }
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

/// Parse command output into a Vec of JSON values.
fn parse_json_array(stdout: &[u8]) -> Vec<serde_json::Value> {
    let text = String::from_utf8_lossy(stdout);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return vec![];
    }
    // Try as array
    if let Ok(serde_json::Value::Array(arr)) = serde_json::from_str::<serde_json::Value>(trimmed) {
        return arr;
    }
    // Try as single object
    if let Ok(v @ serde_json::Value::Object(_)) = serde_json::from_str::<serde_json::Value>(trimmed) {
        return vec![v];
    }
    // Try line-by-line
    let mut items = Vec::new();
    for line in trimmed.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            items.push(v);
        }
    }
    items
}

// ── Validation ────────────────────────────────────────────

/// Valid container reference: hex ID, name (alphanumeric + hyphens/underscores/dots).
fn is_valid_container_ref(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && !id.starts_with('-')
        && id.chars().all(|c| c.is_alphanumeric() || "-_.".contains(c))
}

/// Valid image reference: registry/repo:tag format.
fn is_valid_image_ref(image: &str) -> bool {
    !image.is_empty()
        && image.len() <= 512
        && !image.starts_with('-')
        && image.chars().all(|c| c.is_alphanumeric() || "-_./: ".contains(c))
        && !image.contains("..")
}

/// Valid restart policy: no, always, unless-stopped, on-failure[:max-retries].
fn is_valid_restart_policy(policy: &str) -> bool {
    matches!(policy, "no" | "always" | "unless-stopped")
        || policy == "on-failure"
        || policy.starts_with("on-failure:")
            && policy.strip_prefix("on-failure:")
                .is_some_and(|n| !n.is_empty() && n.parse::<u32>().is_ok())
}

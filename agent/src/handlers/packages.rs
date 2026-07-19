use std::path::Path;

use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

use crate::handler::ChannelHandler;
use crate::util::{extract_string_array, run_cmd, sudo_as_user, sudo_stdin_write_as_user, which};

// ──────────────────────────────────────────────────────────────
//  Package management handler
//  Supports: pacman (Arch), apt (Debian/Ubuntu), dnf (Fedora)
// ──────────────────────────────────────────────────────────────

pub struct PackagesHandler;

#[async_trait::async_trait]
impl ChannelHandler for PackagesHandler {
    fn payload_type(&self) -> &str {
        "packages.manage"
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        vec![Message::Ready {
            channel: channel.into(),
        }]
    }

    async fn data(&self, channel: &str, data: &serde_json::Value) -> Vec<Message> {
        let action = data.get("action").and_then(|a| a.as_str()).unwrap_or("");
        let password = data.get("password").and_then(|p| p.as_str()).unwrap_or("");
        let user = data.get("_user").and_then(|u| u.as_str()).unwrap_or("");

        if !matches!(
            action,
            "detect"
                | "list_installed"
                | "search"
                | "package_info"
                | "list_updates"
                | "autoupdate_status"
        ) && let Some(err) = crate::util::require_admin(data)
        {
            return vec![Message::Data {
                channel: channel.into(),
                data: err,
            }];
        }

        let result = match action {
            // ── Detection ──
            "detect" => detect_info().await,

            // ── Package listing ──
            "list_installed" => list_installed().await,
            "search" => {
                let query = data.get("query").and_then(|v| v.as_str()).unwrap_or("");
                search_packages(query).await
            }
            "package_info" => {
                let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("");
                package_info(name).await
            }

            // ── Install / Remove ──
            "install" => {
                let names = extract_string_array(data, "names");
                let r = install_packages(user, password, &names).await;
                let ok = r.get("error").is_none();
                crate::audit::log(user, "pkg.install", &names.join(","), ok, "");
                r
            }
            "remove" => {
                let names = extract_string_array(data, "names");
                let r = remove_packages(user, password, &names).await;
                let ok = r.get("error").is_none();
                crate::audit::log(user, "pkg.remove", &names.join(","), ok, "");
                r
            }

            // ── Updates ──
            "check_updates" => check_updates().await,
            "update_system" => {
                let r = update_system(user, password).await;
                let ok = r.get("error").is_none();
                crate::audit::log(user, "pkg.update_system", "", ok, "");
                r
            }

            // ── Cache / cleanup ──
            "cleanup" => {
                let kind = data.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                let r = cleanup_packages(user, password, kind).await;
                let ok = r.get("error").is_none();
                crate::audit::log(user, "pkg.cleanup", kind, ok, "");
                r
            }

            // ── Repository management ──
            "list_repos" => list_repos().await,
            "add_repo" => {
                let repo = data.get("repo").and_then(|v| v.as_str()).unwrap_or("");
                let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("");
                add_repo(user, password, repo, name).await
            }
            "remove_repo" => {
                let repo = data.get("repo").and_then(|v| v.as_str()).unwrap_or("");
                remove_repo(user, password, repo).await
            }
            "refresh_repos" => refresh_repos(user, password).await,

            // ── Automatic updates ──
            "autoupdate_status" => autoupdate_status().await,
            "autoupdate_set" => {
                let r = autoupdate_set(data, user, password).await;
                let ok = r.get("error").is_none();
                let enabled = data
                    .get("enabled")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                crate::audit::log(
                    user,
                    "pkg.autoupdate_set",
                    if enabled { "enable" } else { "disable" },
                    ok,
                    "",
                );
                r
            }

            _ => serde_json::json!({ "error": format!("unknown action: {action}") }),
        };

        // Always echo back the action field so the frontend can match responses
        let mut result = result;
        if let Some(obj) = result.as_object_mut()
            && !obj.contains_key("action")
            && !action.is_empty()
        {
            obj.insert("action".to_string(), serde_json::json!(action));
        }

        vec![Message::Data {
            channel: channel.into(),
            data: result,
        }]
    }
}

// ──────────────────────────────────────────────────────────────
//  Distro / package manager detection
// ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
enum PkgBackend {
    Pacman, // Arch, Manjaro, EndeavourOS
    Apt,    // Debian, Ubuntu, Mint, Pop!_OS
    Dnf,    // Fedora, RHEL 9+, CentOS Stream 9+
    None,
}

async fn detect_backend() -> PkgBackend {
    if which("pacman").await {
        PkgBackend::Pacman
    } else if which("apt").await {
        PkgBackend::Apt
    } else if which("dnf").await {
        PkgBackend::Dnf
    } else {
        PkgBackend::None
    }
}

fn backend_name(b: PkgBackend) -> &'static str {
    match b {
        PkgBackend::Pacman => "pacman",
        PkgBackend::Apt => "apt",
        PkgBackend::Dnf => "dnf",
        PkgBackend::None => "none",
    }
}

async fn detect_info() -> serde_json::Value {
    let backend = detect_backend().await;

    // Read os-release for distro info
    let os_id = read_os_field("ID").await.unwrap_or_default();
    let os_name = read_os_field("PRETTY_NAME").await.unwrap_or_default();

    serde_json::json!({
        "backend": backend_name(backend),
        "distro_id": os_id,
        "distro_name": os_name,
    })
}

async fn read_os_field(field: &str) -> Option<String> {
    let content = tokio::fs::read_to_string("/etc/os-release").await.ok()?;
    for line in content.lines() {
        if let Some(val) = line.strip_prefix(&format!("{field}=")) {
            return Some(val.trim_matches('"').to_string());
        }
    }
    None
}

// ──────────────────────────────────────────────────────────────
//  Package listing
// ──────────────────────────────────────────────────────────────

async fn list_installed() -> serde_json::Value {
    let backend = detect_backend().await;

    let packages = match backend {
        PkgBackend::Pacman => list_installed_pacman().await,
        PkgBackend::Apt => list_installed_apt().await,
        PkgBackend::Dnf => list_installed_dnf().await,
        PkgBackend::None => vec![],
    };

    serde_json::json!({
        "backend": backend_name(backend),
        "packages": packages,
        "count": packages.len(),
    })
}

async fn list_installed_pacman() -> Vec<serde_json::Value> {
    // pacman -Q gives "name version"
    let out = run_cmd(&["pacman", "-Q"]).await;
    let mut pkgs = Vec::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.splitn(2, ' ').collect();
        if parts.len() == 2 {
            pkgs.push(serde_json::json!({
                "name": parts[0],
                "version": parts[1],
            }));
        }
    }
    pkgs
}

async fn list_installed_apt() -> Vec<serde_json::Value> {
    // dpkg-query for structured output
    let out = run_cmd(&[
        "dpkg-query",
        "-W",
        "-f",
        "${Package}\t${Version}\t${Status}\n",
    ])
    .await;
    let mut pkgs = Vec::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 3 && parts[2].contains("installed") {
            pkgs.push(serde_json::json!({
                "name": parts[0],
                "version": parts[1],
            }));
        }
    }
    pkgs
}

async fn list_installed_dnf() -> Vec<serde_json::Value> {
    // rpm -qa --queryformat for structured output
    let out = run_cmd(&[
        "rpm",
        "-qa",
        "--queryformat",
        "%{NAME}\t%{VERSION}-%{RELEASE}\n",
    ])
    .await;
    let mut pkgs = Vec::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() == 2 {
            pkgs.push(serde_json::json!({
                "name": parts[0],
                "version": parts[1],
            }));
        }
    }
    pkgs
}

// ──────────────────────────────────────────────────────────────
//  Search
// ──────────────────────────────────────────────────────────────

async fn search_packages(query: &str) -> serde_json::Value {
    if query.is_empty() {
        return serde_json::json!({ "error": "query required" });
    }
    if !is_valid_package_name(query) {
        return serde_json::json!({ "error": "invalid search query" });
    }

    let backend = detect_backend().await;
    let packages = match backend {
        PkgBackend::Pacman => search_pacman(query).await,
        PkgBackend::Apt => search_apt(query).await,
        PkgBackend::Dnf => search_dnf(query).await,
        PkgBackend::None => vec![],
    };

    serde_json::json!({
        "backend": backend_name(backend),
        "packages": packages,
    })
}

async fn search_pacman(query: &str) -> Vec<serde_json::Value> {
    // pacman -Ss <query>
    let out = run_cmd(&["pacman", "-Ss", "--", query]).await;
    let mut pkgs = Vec::new();
    let lines: Vec<&str> = out.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim();
        // Format: "repo/name version [installed]"
        //         "    description"
        if line.contains('/') && !line.starts_with(' ') {
            let parts: Vec<&str> = line.splitn(2, '/').collect();
            if parts.len() == 2 {
                let repo = parts[0];
                let rest: Vec<&str> = parts[1].splitn(2, ' ').collect();
                let name = rest.first().unwrap_or(&"");
                let version_part = rest.get(1).unwrap_or(&"");
                let installed = version_part.contains("[installed");
                let version = version_part.split_whitespace().next().unwrap_or("");

                let desc = if i + 1 < lines.len() && lines[i + 1].starts_with(' ') {
                    i += 1;
                    lines[i].trim()
                } else {
                    ""
                };

                pkgs.push(serde_json::json!({
                    "name": name,
                    "version": version,
                    "repo": repo,
                    "installed": installed,
                    "description": desc,
                }));
            }
        }
        i += 1;
    }
    pkgs
}

async fn search_apt(query: &str) -> Vec<serde_json::Value> {
    // apt-cache search <query>
    let out = run_cmd(&["apt-cache", "search", "--", query]).await;
    let mut names = Vec::new();
    let mut descs = Vec::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.splitn(2, " - ").collect();
        if parts.len() == 2 {
            names.push(parts[0].trim().to_string());
            descs.push(parts[1].trim().to_string());
        }
        if names.len() >= 200 {
            break;
        }
    }

    if names.is_empty() {
        return Vec::new();
    }

    // Batch: get installed status + version for all packages in one dpkg-query call.
    // dpkg-query accepts multiple package names and outputs one line per package.
    let mut cmd_args: Vec<String> = vec![
        "dpkg-query".into(),
        "-W".into(),
        "-f".into(),
        "${Package}\t${Status}\t${Version}\n".into(),
        "--".into(),
    ];
    cmd_args.extend(names.iter().cloned());
    let cmd_refs: Vec<&str> = cmd_args.iter().map(|s| s.as_str()).collect();
    let dpkg_out = run_cmd(&cmd_refs).await;

    // Parse dpkg-query output into a lookup map: name → (installed, version)
    let mut installed_map: std::collections::HashMap<&str, (bool, &str)> =
        std::collections::HashMap::new();
    for line in dpkg_out.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() >= 3 {
            let pkg = fields[0].trim();
            let status = fields[1].trim();
            let version = fields[2].trim();
            let is_installed = status.contains("install ok installed");
            installed_map.insert(pkg, (is_installed, version));
        }
    }

    // Build result using the lookup map
    let mut pkgs = Vec::with_capacity(names.len());
    for (name, desc) in names.iter().zip(descs.iter()) {
        let (installed, version) = installed_map
            .get(name.as_str())
            .copied()
            .unwrap_or((false, ""));
        pkgs.push(serde_json::json!({
            "name": name,
            "version": version,
            "installed": installed,
            "description": desc,
        }));
    }
    pkgs
}

async fn is_apt_installed(name: &str) -> bool {
    tokio::process::Command::new("dpkg-query")
        .args(["-W", "-f", "${Status}", "--", name])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .await
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("install ok installed"))
        .unwrap_or(false)
}

async fn search_dnf(query: &str) -> Vec<serde_json::Value> {
    // dnf search <query>
    // dnf5 does not support "--" after subcommands; query is validated by is_valid_package_name
    let out = run_cmd(&["dnf", "search", "--quiet", query]).await;
    let mut names = Vec::new();
    let mut descs = Vec::new();
    for line in out.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.starts_with('=')
            || trimmed.starts_with("Last metadata")
            || trimmed.starts_with("Matched fields")
        {
            continue;
        }

        // dnf4 format: "name.arch : description"
        // dnf5 format: " name.arch\tdescription"  (leading space, TAB separator)
        let (name_arch, desc) = if let Some((left, right)) = trimmed.split_once(" : ") {
            // dnf4
            (left.trim(), right.trim())
        } else if let Some((left, right)) = trimmed.split_once('\t') {
            // dnf5
            (left.trim(), right.trim())
        } else {
            continue;
        };

        if name_arch.is_empty() {
            continue;
        }

        // Strip architecture suffix (.x86_64, .noarch, etc.)
        let name = if name_arch.contains('.') {
            name_arch.rsplitn(2, '.').last().unwrap_or(name_arch)
        } else {
            name_arch
        };

        names.push(name.to_string());
        descs.push(desc.to_string());

        if names.len() >= 200 {
            break;
        }
    }

    if names.is_empty() {
        return Vec::new();
    }

    // Batch: check which packages are installed with a single rpm -q call.
    // rpm -q outputs "<name>-<ver>-<rel>.<arch>" for installed packages
    // and "package <name> is not installed" (on stderr) for missing ones.
    // We use --qf to get just the package name on stdout for installed ones.
    let mut cmd_args: Vec<String> = vec![
        "rpm".into(),
        "-q".into(),
        "--qf".into(),
        "%{NAME}\n".into(),
        "--".into(),
    ];
    cmd_args.extend(names.iter().cloned());
    let cmd_refs: Vec<&str> = cmd_args.iter().map(|s| s.as_str()).collect();
    let rpm_out = tokio::process::Command::new(cmd_refs[0])
        .args(&cmd_refs[1..])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .await;
    let installed_set: std::collections::HashSet<String> = match rpm_out {
        Ok(o) => String::from_utf8_lossy(&o.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect(),
        Err(_) => std::collections::HashSet::new(),
    };

    let mut pkgs = Vec::with_capacity(names.len());
    for (name, desc) in names.iter().zip(descs.iter()) {
        pkgs.push(serde_json::json!({
            "name": name,
            "version": "",
            "installed": installed_set.contains(name.as_str()),
            "description": desc,
        }));
    }
    pkgs
}

// ──────────────────────────────────────────────────────────────
//  Package info
// ──────────────────────────────────────────────────────────────

async fn package_info(name: &str) -> serde_json::Value {
    if name.is_empty() {
        return serde_json::json!({ "error": "package name required" });
    }
    if !is_valid_package_name(name) {
        return serde_json::json!({ "error": "invalid package name" });
    }
    let backend = detect_backend().await;
    match backend {
        PkgBackend::Pacman => {
            let out = run_cmd(&["pacman", "-Qi", "--", name]).await;
            if out.contains("was not found") {
                // Try remote info
                let out = run_cmd(&["pacman", "-Si", "--", name]).await;
                serde_json::json!({ "info": out, "installed": false })
            } else {
                serde_json::json!({ "info": out, "installed": true })
            }
        }
        PkgBackend::Apt => {
            let out = run_cmd(&["apt-cache", "show", "--", name]).await;
            let installed = is_apt_installed(name).await;
            serde_json::json!({ "info": out, "installed": installed })
        }
        PkgBackend::Dnf => {
            // dnf5 does not support "--" after subcommands; name is validated by is_valid_package_name
            let out = run_cmd(&["dnf", "info", "--quiet", name]).await;
            // dnf4: "Installed Packages", dnf5: "Installed packages"
            let installed = out.to_ascii_lowercase().contains("installed packages");
            serde_json::json!({ "info": out, "installed": installed })
        }
        PkgBackend::None => serde_json::json!({ "error": "no package manager" }),
    }
}

// ──────────────────────────────────────────────────────────────
//  Install / Remove
// ──────────────────────────────────────────────────────────────

/// Run a package-manager command AS THE USER via sudo, so the host's rules (local
/// sudoers or FreeIPA sudo via SSSD) decide what is permitted.
///
/// The command is passed to sudo verbatim — deliberately not wrapped in
/// `env VAR=… cmd`, because sudoers matches on the command sudo actually runs, and a
/// wrapper would make granular rules (e.g. `ALL=(ALL) /usr/bin/apt-get`) stop
/// matching. apt is driven non-interactively via `-y` instead.
async fn pkg_sudo(user: &str, password: &str, args: &[impl AsRef<str>]) -> serde_json::Value {
    let refs: Vec<&str> = args.iter().map(|a| a.as_ref()).collect();
    sudo_as_user(user, password, &refs).await
}

async fn install_packages(user: &str, password: &str, names: &[String]) -> serde_json::Value {
    if names.is_empty() {
        return serde_json::json!({ "error": "no packages specified" });
    }
    // Validate package names to prevent argument injection
    for name in names {
        if !is_valid_package_name(name) {
            return serde_json::json!({ "error": format!("invalid package name: {name}") });
        }
    }
    let backend = detect_backend().await;
    let mut args: Vec<String> = Vec::new();

    match backend {
        PkgBackend::Pacman => {
            args.push("pacman".into());
            args.push("-S".into());
            args.push("--noconfirm".into());
            args.push("--".into());
            args.extend(names.iter().cloned());
        }
        PkgBackend::Apt => {
            args.push("apt-get".into());
            args.push("install".into());
            args.push("-y".into());
            args.push("--".into());
            args.extend(names.iter().cloned());
        }
        PkgBackend::Dnf => {
            // dnf5 does not support "--"; names validated by is_valid_package_name
            args.push("dnf".into());
            args.push("install".into());
            args.push("-y".into());
            args.extend(names.iter().cloned());
        }
        PkgBackend::None => return serde_json::json!({ "error": "no package manager" }),
    }

    pkg_sudo(user, password, &args).await
}

async fn remove_packages(user: &str, password: &str, names: &[String]) -> serde_json::Value {
    if names.is_empty() {
        return serde_json::json!({ "error": "no packages specified" });
    }
    // Validate package names to prevent argument injection
    for name in names {
        if !is_valid_package_name(name) {
            return serde_json::json!({ "error": format!("invalid package name: {name}") });
        }
    }
    let backend = detect_backend().await;
    let mut args: Vec<String> = Vec::new();

    match backend {
        PkgBackend::Pacman => {
            args.push("pacman".into());
            args.push("-Rns".into());
            args.push("--noconfirm".into());
            args.push("--".into());
            args.extend(names.iter().cloned());
        }
        PkgBackend::Apt => {
            args.push("apt-get".into());
            args.push("remove".into());
            args.push("-y".into());
            args.push("--".into());
            args.extend(names.iter().cloned());
        }
        PkgBackend::Dnf => {
            // dnf5 does not support "--"; names validated by is_valid_package_name
            args.push("dnf".into());
            args.push("remove".into());
            args.push("-y".into());
            args.extend(names.iter().cloned());
        }
        PkgBackend::None => return serde_json::json!({ "error": "no package manager" }),
    }

    pkg_sudo(user, password, &args).await
}

// ──────────────────────────────────────────────────────────────
//  Updates
// ──────────────────────────────────────────────────────────────

async fn check_updates() -> serde_json::Value {
    let backend = detect_backend().await;

    match backend {
        PkgBackend::Pacman => {
            // checkupdates is from pacman-contrib, fallback to pacman -Qu
            let out = if which("checkupdates").await {
                run_cmd(&["checkupdates"]).await
            } else {
                // pacman -Qu lists upgradable packages (needs synced db)
                run_cmd(&["pacman", "-Qu"]).await
            };

            let mut updates = Vec::new();
            for line in out.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                // Format: "name old_ver -> new_ver"
                let parts: Vec<&str> = line.splitn(4, ' ').collect();
                if parts.len() >= 4 {
                    updates.push(serde_json::json!({
                        "name": parts[0],
                        "current": parts[1],
                        "available": parts[3],
                    }));
                } else if parts.len() >= 2 {
                    updates.push(serde_json::json!({
                        "name": parts[0],
                        "current": "",
                        "available": parts.get(1).unwrap_or(&""),
                    }));
                }
            }

            serde_json::json!({
                "backend": "pacman",
                "updates": updates,
                "count": updates.len(),
            })
        }
        PkgBackend::Apt => {
            // apt list --upgradable (Debian 8+ / Ubuntu 14.04+)
            let out = run_cmd(&["apt", "list", "--upgradable"]).await;
            let mut updates = Vec::new();
            for line in out.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with("Listing") {
                    continue;
                }
                // Format: "name/source version arch [upgradable from: old_ver]"
                let parts: Vec<&str> = line.splitn(2, '/').collect();
                if parts.len() == 2 {
                    let name = parts[0];
                    let rest = parts[1];
                    let version = rest.split_whitespace().nth(1).unwrap_or("");
                    let current = if rest.contains("upgradable from:") {
                        rest.rsplit("upgradable from: ")
                            .next()
                            .unwrap_or("")
                            .trim_end_matches(']')
                            .trim()
                    } else {
                        ""
                    };
                    updates.push(serde_json::json!({
                        "name": name,
                        "current": current,
                        "available": version,
                    }));
                }
            }

            serde_json::json!({
                "backend": "apt",
                "updates": updates,
                "count": updates.len(),
            })
        }
        PkgBackend::Dnf => {
            let out = run_cmd(&["dnf", "check-update", "--quiet"]).await;
            let mut updates = Vec::new();
            for line in out.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with("Last metadata") {
                    continue;
                }
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 3 {
                    // Format: "name.arch  version  repo"
                    let name_arch = parts[0];
                    let name = if name_arch.contains('.') {
                        name_arch.rsplitn(2, '.').last().unwrap_or(name_arch)
                    } else {
                        name_arch
                    };
                    updates.push(serde_json::json!({
                        "name": name,
                        "current": "",
                        "available": parts[1],
                    }));
                }
            }

            serde_json::json!({
                "backend": "dnf",
                "updates": updates,
                "count": updates.len(),
            })
        }
        PkgBackend::None => serde_json::json!({ "error": "no package manager" }),
    }
}

async fn update_system(user: &str, password: &str) -> serde_json::Value {
    let backend = detect_backend().await;
    let args: Vec<String> = match backend {
        PkgBackend::Pacman => vec!["pacman".into(), "-Syu".into(), "--noconfirm".into()],
        PkgBackend::Apt => {
            // For modern Debian/Ubuntu: apt-get dist-upgrade handles all upgrades
            // First refresh, then upgrade
            let refresh = pkg_sudo(user, password, &["apt-get", "update"]).await;
            if refresh.get("error").is_some() {
                return refresh;
            }
            vec!["apt-get".into(), "dist-upgrade".into(), "-y".into()]
        }
        PkgBackend::Dnf => vec![
            "dnf".into(),
            "upgrade".into(),
            "--refresh".into(),
            "-y".into(),
        ],
        PkgBackend::None => return serde_json::json!({ "error": "no package manager" }),
    };

    pkg_sudo(user, password, &args).await
}

/// Free disk from cached / orphaned packages. `kind`: "clean" (clear the download
/// cache), "autoclean" (apt only — drop only obsolete cache), "autoremove" (remove
/// automatically-installed packages no longer needed). Runs as the user via sudo.
async fn cleanup_packages(user: &str, password: &str, kind: &str) -> serde_json::Value {
    let backend = detect_backend().await;
    let args: Vec<String> = match (backend, kind) {
        (PkgBackend::Apt, "clean") => vec!["apt-get".into(), "clean".into()],
        (PkgBackend::Apt, "autoclean") => vec!["apt-get".into(), "autoclean".into()],
        (PkgBackend::Apt, "autoremove") => {
            vec!["apt-get".into(), "autoremove".into(), "-y".into()]
        }
        (PkgBackend::Dnf, "clean") => vec!["dnf".into(), "clean".into(), "all".into()],
        (PkgBackend::Dnf, "autoremove") => vec!["dnf".into(), "autoremove".into(), "-y".into()],
        (PkgBackend::Pacman, "clean") => vec!["pacman".into(), "-Sc".into(), "--noconfirm".into()],
        (PkgBackend::None, _) => return serde_json::json!({ "error": "no package manager" }),
        _ => {
            return serde_json::json!({
                "error": format!("cleanup '{kind}' is not supported for this package manager")
            });
        }
    };

    pkg_sudo(user, password, &args).await
}

// ──────────────────────────────────────────────────────────────
//  Repository management
// ──────────────────────────────────────────────────────────────

async fn list_repos() -> serde_json::Value {
    let backend = detect_backend().await;

    match backend {
        PkgBackend::Pacman => list_repos_pacman().await,
        PkgBackend::Apt => list_repos_apt().await,
        PkgBackend::Dnf => list_repos_dnf().await,
        PkgBackend::None => serde_json::json!({ "error": "no package manager" }),
    }
}

async fn list_repos_pacman() -> serde_json::Value {
    // Parse /etc/pacman.conf for [repo] sections
    let content = match tokio::fs::read_to_string("/etc/pacman.conf").await {
        Ok(c) => c,
        Err(e) => return serde_json::json!({ "error": e.to_string() }),
    };

    let mut repos = Vec::new();
    let mut current_repo: Option<String> = None;
    let mut current_server = String::new();
    let mut current_include = String::new();
    let mut current_sig_level = String::new();

    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.is_empty() {
            continue;
        }

        if line.starts_with('[') && line.ends_with(']') {
            // Save previous repo
            if let Some(name) = current_repo.take()
                && name != "options"
            {
                repos.push(serde_json::json!({
                    "name": name,
                    "server": current_server.clone(),
                    "include": current_include.clone(),
                    "sig_level": current_sig_level.clone(),
                    "enabled": true,
                }));
            }
            current_repo = Some(line.trim_matches(|c| c == '[' || c == ']').to_string());
            current_server.clear();
            current_include.clear();
            current_sig_level.clear();
        } else if let Some(val) = line.strip_prefix("Server") {
            current_server = val
                .trim_start_matches(|c: char| c == '=' || c.is_whitespace())
                .to_string();
        } else if let Some(val) = line.strip_prefix("Include") {
            current_include = val
                .trim_start_matches(|c: char| c == '=' || c.is_whitespace())
                .to_string();
        } else if let Some(val) = line.strip_prefix("SigLevel") {
            current_sig_level = val
                .trim_start_matches(|c: char| c == '=' || c.is_whitespace())
                .to_string();
        }
    }

    // Save last repo
    if let Some(name) = current_repo
        && name != "options"
    {
        repos.push(serde_json::json!({
            "name": name,
            "server": current_server,
            "include": current_include,
            "sig_level": current_sig_level,
            "enabled": true,
        }));
    }

    serde_json::json!({ "backend": "pacman", "repos": repos })
}

async fn list_repos_apt() -> serde_json::Value {
    // Modern Debian/Ubuntu uses .sources files in /etc/apt/sources.list.d/
    // as well as the classic /etc/apt/sources.list
    let mut repos = Vec::new();

    // Read classic sources.list
    if let Ok(content) = tokio::fs::read_to_string("/etc/apt/sources.list").await {
        for line in content.lines() {
            let line = line.trim();
            if line.starts_with('#') || line.is_empty() {
                continue;
            }
            repos.push(serde_json::json!({
                "name": line.split_whitespace().nth(1).unwrap_or(""),
                "line": line,
                "file": "/etc/apt/sources.list",
                "enabled": !line.starts_with('#'),
                "format": "oneline",
            }));
        }
    }

    // Read .list files in sources.list.d/
    if let Ok(mut dir) = tokio::fs::read_dir("/etc/apt/sources.list.d/").await {
        while let Ok(Some(entry)) = dir.next_entry().await {
            let path = entry.path();
            let fname = path.to_string_lossy().to_string();

            if fname.ends_with(".list") {
                if let Ok(content) = tokio::fs::read_to_string(&path).await {
                    for line in content.lines() {
                        let line = line.trim();
                        if line.is_empty() {
                            continue;
                        }
                        let enabled = !line.starts_with('#');
                        let clean = line.trim_start_matches('#').trim();
                        repos.push(serde_json::json!({
                            "name": clean.split_whitespace().nth(1).unwrap_or(&fname),
                            "line": clean,
                            "file": fname,
                            "enabled": enabled,
                            "format": "oneline",
                        }));
                    }
                }
            } else if fname.ends_with(".sources") {
                // DEB822 format (modern Debian 12+ / Ubuntu 24.04+)
                if let Ok(content) = tokio::fs::read_to_string(&path).await {
                    let mut current = serde_json::Map::new();
                    current.insert("file".to_string(), serde_json::json!(fname));
                    current.insert("format".to_string(), serde_json::json!("deb822"));

                    for line in content.lines() {
                        let line = line.trim();
                        if line.is_empty() {
                            if !current.is_empty() && current.contains_key("Types") {
                                let enabled = current
                                    .get("Enabled")
                                    .and_then(|v| v.as_str())
                                    .map(|v| v != "no")
                                    .unwrap_or(true);
                                current.insert("enabled".to_string(), serde_json::json!(enabled));
                                repos.push(serde_json::Value::Object(current.clone()));
                            }
                            current = serde_json::Map::new();
                            current.insert("file".to_string(), serde_json::json!(fname));
                            current.insert("format".to_string(), serde_json::json!("deb822"));
                            continue;
                        }
                        if let Some((key, val)) = line.split_once(':') {
                            current.insert(key.trim().to_string(), serde_json::json!(val.trim()));
                        }
                    }

                    // Save last block
                    if current.contains_key("Types") {
                        let enabled = current
                            .get("Enabled")
                            .and_then(|v| v.as_str())
                            .map(|v| v != "no")
                            .unwrap_or(true);
                        current.insert("enabled".to_string(), serde_json::json!(enabled));
                        repos.push(serde_json::Value::Object(current));
                    }
                }
            }
        }
    }

    serde_json::json!({ "backend": "apt", "repos": repos })
}

async fn list_repos_dnf() -> serde_json::Value {
    let out = run_cmd(&["dnf", "repolist", "--all", "--quiet"]).await;
    let mut repos = Vec::new();

    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("repo id") || line.starts_with("Last metadata") {
            continue;
        }
        let words: Vec<&str> = line.split_whitespace().collect();
        if words.len() < 2 {
            continue;
        }
        let id = words[0];
        let last = words[words.len() - 1];

        // dnf5: status is last word ("enabled" / "disabled")
        // dnf4: repo id may have "*disabled" suffix, or status column absent
        let (enabled, desc_words) = if last.eq_ignore_ascii_case("enabled") {
            (true, &words[1..words.len() - 1])
        } else if last.eq_ignore_ascii_case("disabled") {
            (false, &words[1..words.len() - 1])
        } else {
            // dnf4 fallback: check for *disabled suffix on repo id
            let en = !id.ends_with("*disabled");
            (en, &words[1..])
        };

        let clean_id = id.trim_end_matches("*disabled");
        let description = desc_words.join(" ");

        repos.push(serde_json::json!({
            "name": clean_id,
            "description": description,
            "enabled": enabled,
        }));
    }

    serde_json::json!({ "backend": "dnf", "repos": repos })
}

// ── Add repo ──

async fn add_repo(user: &str, password: &str, repo: &str, name: &str) -> serde_json::Value {
    if repo.is_empty() {
        return serde_json::json!({ "error": "repository URL/name required" });
    }

    let backend = detect_backend().await;

    match backend {
        PkgBackend::Pacman => {
            // For pacman: append a [name]\nServer = url block to /etc/pacman.conf
            if name.is_empty() {
                return serde_json::json!({ "error": "repository name required for pacman" });
            }
            // Validate name (alphanumeric + hyphens only)
            if !name
                .chars()
                .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
            {
                return serde_json::json!({ "error": "invalid repository name" });
            }
            // Validate repo URL
            if !is_valid_repo_url(repo) {
                return serde_json::json!({ "error": "invalid repository URL" });
            }
            let block = format!("\n[{name}]\nServer = {repo}\n");
            // Use tee with stdin to avoid shell injection
            sudo_stdin_write_as_user(user, password, &["tee", "-a", "/etc/pacman.conf"], &block)
                .await
        }
        PkgBackend::Apt => {
            // For modern apt: add-apt-repository or write .list file
            // If it's a PPA or http URL
            if repo.starts_with("ppa:") {
                pkg_sudo(user, password, &["add-apt-repository", "-y", repo]).await
            } else {
                // Write a .list file
                let fname = if name.is_empty() { "custom" } else { name };
                // Validate filename
                if !fname
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
                {
                    return serde_json::json!({ "error": "invalid repository name" });
                }
                let path = format!("/etc/apt/sources.list.d/{fname}.list");
                // Validate repo line
                if repo.contains('\n') || repo.contains('\r') {
                    return serde_json::json!({ "error": "invalid repository line" });
                }
                sudo_stdin_write_as_user(user, password, &["tee", &path], &format!("{repo}\n"))
                    .await
            }
        }
        PkgBackend::Dnf => {
            // dnf config-manager --add-repo <url>
            if which("dnf-3").await || which("dnf").await {
                pkg_sudo(
                    user,
                    password,
                    &["dnf", "config-manager", "--add-repo", repo],
                )
                .await
            } else {
                serde_json::json!({ "error": "dnf config-manager not available" })
            }
        }
        PkgBackend::None => serde_json::json!({ "error": "no package manager" }),
    }
}

// ── Remove repo ──

async fn remove_repo(user: &str, password: &str, repo: &str) -> serde_json::Value {
    if repo.is_empty() {
        return serde_json::json!({ "error": "repository identifier required" });
    }

    let backend = detect_backend().await;

    match backend {
        PkgBackend::Pacman => {
            // Remove [repo] section from /etc/pacman.conf
            // Validate repo name
            if !repo
                .chars()
                .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
            {
                return serde_json::json!({ "error": "invalid repository name" });
            }
            // Read, filter, and rewrite pacman.conf safely in Rust
            let content = match tokio::fs::read_to_string("/etc/pacman.conf").await {
                Ok(c) => c,
                Err(e) => return serde_json::json!({ "error": e.to_string() }),
            };
            let target_header = format!("[{repo}]");
            let mut new_lines = Vec::new();
            let mut skipping = false;
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed == target_header {
                    skipping = true;
                    continue;
                }
                if skipping && trimmed.starts_with('[') && trimmed.ends_with(']') {
                    skipping = false;
                }
                if !skipping {
                    new_lines.push(line);
                }
            }
            let new_content = new_lines.join("\n") + "\n";
            sudo_stdin_write_as_user(user, password, &["tee", "/etc/pacman.conf"], &new_content)
                .await
        }
        PkgBackend::Apt => {
            if repo.starts_with("ppa:") {
                pkg_sudo(
                    user,
                    password,
                    &["add-apt-repository", "--remove", "-y", repo],
                )
                .await
            } else if repo.starts_with("/") {
                // It's a file path — remove the file
                // Canonicalize to resolve .. and symlinks, then verify it's in sources.list.d
                let allowed_dir = Path::new("/etc/apt/sources.list.d");
                let canonical = match allowed_dir
                    .canonicalize()
                    .ok()
                    .zip(Path::new(repo).canonicalize().ok())
                {
                    Some((dir, file)) if file.starts_with(&dir) => file,
                    _ => {
                        return serde_json::json!({ "error": "can only remove files in /etc/apt/sources.list.d/" });
                    }
                };
                let canon_str = canonical.to_string_lossy();
                pkg_sudo(user, password, &["rm", "-f", "--", &canon_str]).await
            } else {
                // Try to find and remove matching file (.list or .sources)
                let list_path = format!("/etc/apt/sources.list.d/{repo}.list");
                let sources_path = format!("/etc/apt/sources.list.d/{repo}.sources");
                // Validate name characters
                if !repo
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
                {
                    return serde_json::json!({ "error": "invalid repository name" });
                }
                // Prefer .list, fall back to .sources
                if tokio::fs::metadata(&list_path).await.is_ok() {
                    pkg_sudo(user, password, &["rm", "-f", "--", &list_path]).await
                } else if tokio::fs::metadata(&sources_path).await.is_ok() {
                    pkg_sudo(user, password, &["rm", "-f", "--", &sources_path]).await
                } else {
                    // Try removing .list anyway (original behavior)
                    pkg_sudo(user, password, &["rm", "-f", "--", &list_path]).await
                }
            }
        }
        PkgBackend::Dnf => {
            // Remove .repo file from /etc/yum.repos.d/
            let path = if repo.starts_with("/") {
                // Canonicalize to resolve .. and symlinks, then verify it's in yum.repos.d
                let allowed_dir = Path::new("/etc/yum.repos.d");
                match allowed_dir
                    .canonicalize()
                    .ok()
                    .zip(Path::new(repo).canonicalize().ok())
                {
                    Some((dir, file)) if file.starts_with(&dir) => {
                        file.to_string_lossy().to_string()
                    }
                    _ => {
                        return serde_json::json!({ "error": "can only remove repo files in /etc/yum.repos.d/" });
                    }
                }
            } else {
                // Validate name
                if !repo
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
                {
                    return serde_json::json!({ "error": "invalid repository name" });
                }
                format!("/etc/yum.repos.d/{repo}.repo")
            };
            pkg_sudo(user, password, &["rm", "-f", "--", &path]).await
        }
        PkgBackend::None => serde_json::json!({ "error": "no package manager" }),
    }
}

// ── Refresh repos ──

async fn refresh_repos(user: &str, password: &str) -> serde_json::Value {
    let backend = detect_backend().await;
    match backend {
        PkgBackend::Pacman => pkg_sudo(user, password, &["pacman", "-Sy", "--noconfirm"]).await,
        PkgBackend::Apt => pkg_sudo(user, password, &["apt-get", "update"]).await,
        PkgBackend::Dnf => pkg_sudo(user, password, &["dnf", "makecache", "--quiet"]).await,
        PkgBackend::None => serde_json::json!({ "error": "no package manager" }),
    }
}

// ──────────────────────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────────────────────

/// Validate package name: alphanumeric, hyphens, dots, underscores, plus signs.
/// Must not start with a dash to prevent argument injection.
fn is_valid_package_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && name.len() <= 256
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || "-._+:".contains(c))
}

fn is_valid_repo_url(url: &str) -> bool {
    // Must start with a valid protocol and not contain shell metacharacters
    let has_valid_proto = url.starts_with("http://")
        || url.starts_with("https://")
        || url.starts_with("ftp://")
        || url.starts_with("file://");
    let no_dangerous_chars = !url.contains('`')
        && !url.contains('$')
        && !url.contains('\n')
        && !url.contains('\r')
        && !url.contains(';')
        && !url.contains('|')
        && !url.contains('&');
    has_valid_proto && no_dangerous_chars
}

// ──────────────────────────────────────────────────────────────
//  Automatic updates — comprehensive management
//  apt → unattended-upgrades ; dnf → dnf-automatic
//  Controls: enable, apply mode (install/download), scope (all/security),
//  schedule (systemd timer), auto-reboot (+time on apt), remove-unused (apt).
// ──────────────────────────────────────────────────────────────

use serde_json::{Value, json};

const APT_AUTO_CONF: &str = "/etc/apt/apt.conf.d/20auto-upgrades";
const APT_TENODERA_CONF: &str = "/etc/apt/apt.conf.d/51tenodera-unattended";
const DNF_AUTO_CONF: &str = "/etc/dnf/automatic.conf";
const APT_TIMER: &str = "apt-daily-upgrade.timer";
const DNF_TIMER: &str = "dnf-automatic.timer";

async fn autoupdate_status() -> Value {
    match detect_backend().await {
        PkgBackend::Apt => apt_status().await,
        PkgBackend::Dnf => dnf_status().await,
        b => json!({ "backend": backend_name(b), "supported": false }),
    }
}

async fn autoupdate_set(data: &Value, user: &str, password: &str) -> Value {
    match detect_backend().await {
        PkgBackend::Apt => apt_set(data, user, password).await,
        PkgBackend::Dnf => dnf_set(data, user, password).await,
        _ => json!({ "error": "automatic updates are not supported for this package manager" }),
    }
}

fn au_bool(d: &Value, k: &str) -> Option<bool> {
    d.get(k).and_then(|v| v.as_bool())
}
fn au_str(d: &Value, k: &str) -> Option<String> {
    d.get(k).and_then(|v| v.as_str()).map(|s| s.to_string())
}

// ── apt / unattended-upgrades ──

async fn apt_status() -> Value {
    let installed = which("unattended-upgrade").await;
    let periodic = std::fs::read_to_string(APT_AUTO_CONF).unwrap_or_default();
    let unattended = apt_periodic_value(&periodic, "Unattended-Upgrade").as_deref() == Some("1");
    let download =
        apt_periodic_value(&periodic, "Download-Upgradeable-Packages").as_deref() == Some("1");
    let enabled = installed && (unattended || download);
    let mode = if unattended { "install" } else { "download" };

    let managed = std::fs::read_to_string(APT_TENODERA_CONF).unwrap_or_default();
    let reboot = apt_uu_bool(&managed, "Automatic-Reboot").unwrap_or(false);
    let reboot_time =
        apt_uu_raw(&managed, "Automatic-Reboot-Time").unwrap_or_else(|| "02:00".into());
    let remove_unused = apt_uu_bool(&managed, "Remove-Unused-Dependencies").unwrap_or(false);
    // We own the origins pattern; presence of a "-updates" origin means "all".
    let scope = if managed.contains("-updates") {
        "all"
    } else {
        "security"
    };

    let (ta, te, next) = timer_state(APT_TIMER).await;
    let schedule = timer_oncalendar(APT_TIMER).await;

    json!({
        "backend": "apt", "supported": true, "tool": "unattended-upgrades",
        "installed": installed, "enabled": enabled,
        "timer": APT_TIMER, "timer_active": ta, "timer_enabled": te, "next_run": next,
        "caps": { "mode": true, "scope": true, "schedule": true, "reboot": true, "reboot_time": true, "remove_unused": true },
        "settings": {
            "mode": mode, "scope": scope, "schedule": schedule,
            "reboot": reboot, "reboot_time": reboot_time, "remove_unused": remove_unused,
        },
    })
}

async fn apt_set(data: &Value, user: &str, password: &str) -> Value {
    let cur = apt_status().await;
    let cs = cur.get("settings").cloned().unwrap_or_default();
    let gets = |k: &str, def: &str| {
        au_str(data, k)
            .or_else(|| cs.get(k).and_then(|v| v.as_str()).map(|s| s.to_string()))
            .unwrap_or_else(|| def.to_string())
    };
    let getb = |k: &str, def: bool| {
        au_bool(data, k)
            .or_else(|| cs.get(k).and_then(|v| v.as_bool()))
            .unwrap_or(def)
    };

    let enabled = au_bool(data, "enabled").unwrap_or_else(|| {
        cur.get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    });
    let mode = gets("mode", "install");
    let scope = gets("scope", "security");
    let schedule = gets("schedule", "");
    let reboot = getb("reboot", false);
    let reboot_time = gets("reboot_time", "02:00");
    let remove_unused = getb("remove_unused", false);

    if mode != "install" && mode != "download" {
        return json!({ "error": "invalid mode" });
    }
    if scope != "all" && scope != "security" {
        return json!({ "error": "invalid scope" });
    }
    if !is_valid_hhmm(&reboot_time) {
        return json!({ "error": "invalid reboot time (expected HH:MM)" });
    }

    if enabled && !which("unattended-upgrade").await {
        let r = install_packages(user, password, &["unattended-upgrades".to_string()]).await;
        if r.get("error").is_some() {
            return r;
        }
    }

    let periodic = build_apt_periodic(enabled, &mode);
    let w = sudo_stdin_write_as_user(user, password, &["tee", APT_AUTO_CONF], &periodic).await;
    if w.get("error").is_some() {
        return w;
    }
    let managed = build_apt_tenodera(&scope, reboot, &reboot_time, remove_unused);
    let w2 = sudo_stdin_write_as_user(user, password, &["tee", APT_TENODERA_CONF], &managed).await;
    if w2.get("error").is_some() {
        return w2;
    }
    if !schedule.trim().is_empty() {
        let r = set_timer_schedule(APT_TIMER, &schedule, user, password).await;
        if r.get("error").is_some() {
            return r;
        }
    }
    if enabled {
        let _ = sudo_as_user(
            user,
            password,
            &["systemctl", "enable", "--now", "apt-daily.timer", APT_TIMER],
        )
        .await;
    }
    json!({ "ok": true })
}

fn build_apt_periodic(enabled: bool, mode: &str) -> String {
    let unattended = if enabled && mode == "install" {
        "1"
    } else {
        "0"
    };
    let download = if enabled { "1" } else { "0" };
    format!(
        "// Managed by Tenodera\nAPT::Periodic::Update-Package-Lists \"1\";\nAPT::Periodic::Download-Upgradeable-Packages \"{download}\";\nAPT::Periodic::Unattended-Upgrade \"{unattended}\";\n"
    )
}

/// Tenodera-managed unattended-upgrades options (origins, reboot, autoremove).
/// Clears the distro's Allowed-Origins so our Origins-Pattern is authoritative.
fn build_apt_tenodera(scope: &str, reboot: bool, reboot_time: &str, remove_unused: bool) -> String {
    let mut s = String::from("// Managed by Tenodera — do not edit by hand\n");
    s.push_str("Unattended-Upgrade::Allowed-Origins { };\n");
    s.push_str("Unattended-Upgrade::Origins-Pattern {\n");
    s.push_str("    \"origin=${distro_id},codename=${distro_codename}-security,label=*\";\n");
    s.push_str("    \"origin=${distro_id}ESMApps,codename=${distro_codename}-apps-security\";\n");
    s.push_str("    \"origin=${distro_id}ESM,codename=${distro_codename}-infra-security\";\n");
    if scope == "all" {
        s.push_str("    \"origin=${distro_id},codename=${distro_codename}-updates\";\n");
        s.push_str("    \"origin=${distro_id},codename=${distro_codename}\";\n");
    }
    s.push_str("};\n");
    s.push_str(&format!(
        "Unattended-Upgrade::Automatic-Reboot \"{}\";\n",
        if reboot { "true" } else { "false" }
    ));
    s.push_str(&format!(
        "Unattended-Upgrade::Automatic-Reboot-Time \"{reboot_time}\";\n"
    ));
    s.push_str(&format!(
        "Unattended-Upgrade::Remove-Unused-Dependencies \"{}\";\n",
        if remove_unused { "true" } else { "false" }
    ));
    s
}

/// Read the numeric value of an `APT::Periodic::<key>` directive.
fn apt_periodic_value(conf: &str, key: &str) -> Option<String> {
    let needle = format!("APT::Periodic::{key}");
    for line in conf.lines() {
        let l = line.trim();
        if l.starts_with("//") || l.starts_with('#') {
            continue;
        }
        if let Some(rest) = l.strip_prefix(&needle) {
            let v: String = rest.chars().filter(|c| c.is_ascii_digit()).collect();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

/// Read the quoted value of an `Unattended-Upgrade::<opt> "value";` directive.
fn apt_uu_raw(conf: &str, opt: &str) -> Option<String> {
    let needle = format!("Unattended-Upgrade::{opt}");
    for line in conf.lines() {
        let l = line.trim();
        if l.starts_with("//") || l.starts_with('#') {
            continue;
        }
        if let Some(rest) = l.strip_prefix(&needle) {
            let start = rest.find('"')?;
            let rest2 = &rest[start + 1..];
            let end = rest2.find('"')?;
            return Some(rest2[..end].to_string());
        }
    }
    None
}
fn apt_uu_bool(conf: &str, opt: &str) -> Option<bool> {
    apt_uu_raw(conf, opt).map(|v| v.eq_ignore_ascii_case("true") || v == "1")
}

// ── dnf / dnf-automatic ──

async fn dnf_status() -> Value {
    let installed = which("dnf-automatic").await || Path::new(DNF_AUTO_CONF).exists();
    let conf = std::fs::read_to_string(DNF_AUTO_CONF).unwrap_or_default();
    let apply = ini_get(&conf, "commands", "apply_updates").unwrap_or_default();
    let upgrade_type =
        ini_get(&conf, "commands", "upgrade_type").unwrap_or_else(|| "default".into());
    let reboot_val = ini_get(&conf, "commands", "reboot").unwrap_or_else(|| "never".into());
    let (ta, te, next) = timer_state(DNF_TIMER).await;
    let mode = if apply.eq_ignore_ascii_case("yes") {
        "install"
    } else {
        "download"
    };
    let scope = if upgrade_type.eq_ignore_ascii_case("security") {
        "security"
    } else {
        "all"
    };
    let reboot = !reboot_val.eq_ignore_ascii_case("never");
    let schedule = timer_oncalendar(DNF_TIMER).await;

    json!({
        "backend": "dnf", "supported": true, "tool": "dnf-automatic",
        "installed": installed, "enabled": te || ta,
        "timer": DNF_TIMER, "timer_active": ta, "timer_enabled": te, "next_run": next,
        "caps": { "mode": true, "scope": true, "schedule": true, "reboot": true, "reboot_time": false, "remove_unused": false },
        "settings": {
            "mode": mode, "scope": scope, "schedule": schedule,
            "reboot": reboot, "reboot_time": "", "remove_unused": false,
        },
    })
}

async fn dnf_set(data: &Value, user: &str, password: &str) -> Value {
    let cur = dnf_status().await;
    let cs = cur.get("settings").cloned().unwrap_or_default();
    let gets = |k: &str, def: &str| {
        au_str(data, k)
            .or_else(|| cs.get(k).and_then(|v| v.as_str()).map(|s| s.to_string()))
            .unwrap_or_else(|| def.to_string())
    };
    let getb = |k: &str, def: bool| {
        au_bool(data, k)
            .or_else(|| cs.get(k).and_then(|v| v.as_bool()))
            .unwrap_or(def)
    };

    let enabled = au_bool(data, "enabled").unwrap_or_else(|| {
        cur.get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    });
    let mode = gets("mode", "install");
    let scope = gets("scope", "security");
    let schedule = gets("schedule", "");
    let reboot = getb("reboot", false);

    if mode != "install" && mode != "download" {
        return json!({ "error": "invalid mode" });
    }
    if scope != "all" && scope != "security" {
        return json!({ "error": "invalid scope" });
    }

    if !enabled {
        let r = sudo_as_user(
            user,
            password,
            &["systemctl", "disable", "--now", DNF_TIMER],
        )
        .await;
        return if r.get("error").is_some() {
            r
        } else {
            json!({ "ok": true })
        };
    }

    if !which("dnf-automatic").await && !Path::new(DNF_AUTO_CONF).exists() {
        let r = install_packages(user, password, &["dnf-automatic".to_string()]).await;
        if r.get("error").is_some() {
            return r;
        }
    }

    let apply = if mode == "install" { "yes" } else { "no" };
    let upgrade_type = if scope == "security" {
        "security"
    } else {
        "default"
    };
    let reboot_v = if reboot { "when-needed" } else { "never" };
    let current = std::fs::read_to_string(DNF_AUTO_CONF).unwrap_or_default();
    let updated = ini_set(
        &current,
        "commands",
        &[
            ("download_updates", "yes"),
            ("apply_updates", apply),
            ("upgrade_type", upgrade_type),
            ("reboot", reboot_v),
        ],
    );
    let w = sudo_stdin_write_as_user(user, password, &["tee", DNF_AUTO_CONF], &updated).await;
    if w.get("error").is_some() {
        return w;
    }
    if !schedule.trim().is_empty() {
        let r = set_timer_schedule(DNF_TIMER, &schedule, user, password).await;
        if r.get("error").is_some() {
            return r;
        }
    }
    let r = sudo_as_user(user, password, &["systemctl", "enable", "--now", DNF_TIMER]).await;
    if r.get("error").is_some() {
        r
    } else {
        json!({ "ok": true })
    }
}

// ── systemd timer helpers ──

/// (active, enabled, next_run) for a systemd timer.
async fn timer_state(unit: &str) -> (bool, bool, Option<String>) {
    let active = run_cmd(&["systemctl", "is-active", unit]).await.trim() == "active";
    let enabled = run_cmd(&["systemctl", "is-enabled", unit]).await.trim() == "enabled";
    let show = run_cmd(&[
        "systemctl",
        "show",
        unit,
        "-p",
        "NextElapseUSecRealtime",
        "--value",
    ])
    .await;
    let t = show.trim();
    let next = if t.is_empty() || t == "0" {
        None
    } else {
        Some(t.to_string())
    };
    (active, enabled, next)
}

/// Effective OnCalendar spec of a timer.
async fn timer_oncalendar(unit: &str) -> String {
    let out = run_cmd(&["systemctl", "show", unit, "-p", "TimersCalendar", "--value"]).await;
    parse_oncalendar(&out)
}
fn parse_oncalendar(s: &str) -> String {
    if let Some(i) = s.find("OnCalendar=") {
        let rest = &s[i + "OnCalendar=".len()..];
        let end = rest
            .find(" ; ")
            .or_else(|| rest.find('}'))
            .unwrap_or(rest.len());
        return rest[..end].trim().to_string();
    }
    String::new()
}
fn is_valid_oncalendar(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || " :,-*/.".contains(c))
}

/// Override a timer's OnCalendar via a drop-in and reload.
async fn set_timer_schedule(unit: &str, oncalendar: &str, user: &str, password: &str) -> Value {
    if !is_valid_oncalendar(oncalendar) {
        return json!({ "error": "invalid schedule" });
    }
    let dir = format!("/etc/systemd/system/{unit}.d");
    let file = format!("{dir}/50-tenodera.conf");
    let content =
        format!("[Timer]\nOnCalendar=\nOnCalendar={oncalendar}\nRandomizedDelaySec=30m\n");
    let mk = sudo_as_user(user, password, &["mkdir", "-p", &dir]).await;
    if mk.get("error").is_some() {
        return mk;
    }
    let w = sudo_stdin_write_as_user(user, password, &["tee", &file], &content).await;
    if w.get("error").is_some() {
        return w;
    }
    let _ = sudo_as_user(user, password, &["systemctl", "daemon-reload"]).await;
    let _ = sudo_as_user(user, password, &["systemctl", "restart", unit]).await;
    json!({ "ok": true })
}

fn is_valid_hhmm(s: &str) -> bool {
    let b = s.as_bytes();
    s.len() == 5
        && b[2] == b':'
        && s[..2].chars().all(|c| c.is_ascii_digit())
        && s[3..].chars().all(|c| c.is_ascii_digit())
}

// ── minimal INI read/write (dnf automatic.conf) ──

fn ini_get(content: &str, section: &str, key: &str) -> Option<String> {
    let mut in_section = false;
    for line in content.lines() {
        let l = line.trim();
        if l.starts_with('[') && l.ends_with(']') {
            in_section = &l[1..l.len() - 1] == section;
            continue;
        }
        if in_section
            && let Some((k, v)) = l.split_once('=')
            && k.trim() == key
        {
            return Some(v.trim().to_string());
        }
    }
    None
}

fn ini_set(content: &str, section: &str, kv: &[(&str, &str)]) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut in_section = false;
    let mut seen_section = false;
    let mut set: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for line in content.lines() {
        let l = line.trim();
        if l.starts_with('[') && l.ends_with(']') {
            if in_section {
                ini_append_missing(&mut out, kv, &set);
            }
            in_section = &l[1..l.len() - 1] == section;
            if in_section {
                seen_section = true;
            }
            out.push(line.to_string());
            continue;
        }
        if in_section
            && let Some((k, _)) = l.split_once('=')
            && let Some((key, v)) = kv.iter().find(|(kk, _)| *kk == k.trim())
        {
            out.push(format!("{key} = {v}"));
            set.insert(key);
            continue;
        }
        out.push(line.to_string());
    }
    if in_section {
        ini_append_missing(&mut out, kv, &set);
    }
    if !seen_section {
        out.push(format!("[{section}]"));
        for (k, v) in kv {
            out.push(format!("{k} = {v}"));
        }
    }
    let mut s = out.join("\n");
    s.push('\n');
    s
}
fn ini_append_missing(
    out: &mut Vec<String>,
    kv: &[(&str, &str)],
    set: &std::collections::HashSet<&str>,
) {
    for (k, v) in kv {
        if !set.contains(k) {
            out.push(format!("{k} = {v}"));
        }
    }
}

#[cfg(test)]
mod autoupdate_tests {
    use super::*;

    #[test]
    fn apt_parsers() {
        let periodic = "APT::Periodic::Unattended-Upgrade \"1\";\n";
        assert_eq!(
            apt_periodic_value(periodic, "Unattended-Upgrade").as_deref(),
            Some("1")
        );
        let managed = "Unattended-Upgrade::Automatic-Reboot \"true\";\nUnattended-Upgrade::Automatic-Reboot-Time \"03:30\";\n";
        assert_eq!(apt_uu_bool(managed, "Automatic-Reboot"), Some(true));
        assert_eq!(
            apt_uu_raw(managed, "Automatic-Reboot-Time").as_deref(),
            Some("03:30")
        );
    }

    #[test]
    fn ini_roundtrip() {
        let conf = "[commands]\nupgrade_type = default\napply_updates = no\n\n[emitters]\nemit_via = stdio\n";
        let up = ini_set(
            conf,
            "commands",
            &[("apply_updates", "yes"), ("reboot", "when-needed")],
        );
        assert_eq!(
            ini_get(&up, "commands", "apply_updates").as_deref(),
            Some("yes")
        );
        assert_eq!(
            ini_get(&up, "commands", "reboot").as_deref(),
            Some("when-needed")
        );
        assert_eq!(
            ini_get(&up, "emitters", "emit_via").as_deref(),
            Some("stdio")
        );
    }

    #[test]
    fn oncalendar_and_hhmm() {
        assert_eq!(
            parse_oncalendar("{ OnCalendar=*-*-* 06:00:00 ; next_elapse=x }"),
            "*-*-* 06:00:00"
        );
        assert!(is_valid_oncalendar("daily"));
        assert!(is_valid_oncalendar("*-*-* 06:00:00"));
        assert!(!is_valid_oncalendar("a;b"));
        assert!(is_valid_hhmm("02:00"));
        assert!(!is_valid_hhmm("2:00"));
        assert!(!is_valid_hhmm("0200"));
    }
}

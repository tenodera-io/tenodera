use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;
use tokio::io::AsyncWriteExt;

use crate::handler::ChannelHandler;

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
            channel: channel.to_string(),
        }]
    }

    async fn data(&self, channel: &str, data: &serde_json::Value) -> Vec<Message> {
        let action = data.get("action").and_then(|a| a.as_str()).unwrap_or("");
        let password = data.get("password").and_then(|p| p.as_str()).unwrap_or("");
        let user = data.get("_user").and_then(|u| u.as_str()).unwrap_or("");

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
                let r = install_packages(password, &names).await;
                let ok = r.get("error").is_none();
                crate::audit::log(user, "pkg.install", &names.join(","), ok, "");
                r
            }
            "remove" => {
                let names = extract_string_array(data, "names");
                let r = remove_packages(password, &names).await;
                let ok = r.get("error").is_none();
                crate::audit::log(user, "pkg.remove", &names.join(","), ok, "");
                r
            }

            // ── Updates ──
            "check_updates" => check_updates().await,
            "update_system" => {
                let r = update_system(password).await;
                let ok = r.get("error").is_none();
                crate::audit::log(user, "pkg.update_system", "", ok, "");
                r
            }

            // ── Repository management ──
            "list_repos" => list_repos().await,
            "add_repo" => {
                let repo = data.get("repo").and_then(|v| v.as_str()).unwrap_or("");
                let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("");
                add_repo(password, repo, name).await
            }
            "remove_repo" => {
                let repo = data.get("repo").and_then(|v| v.as_str()).unwrap_or("");
                remove_repo(password, repo).await
            }
            "refresh_repos" => refresh_repos(password).await,

            _ => serde_json::json!({ "error": format!("unknown action: {action}") }),
        };

        vec![Message::Data {
            channel: channel.to_string(),
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
    let out = run_cmd(&["dpkg-query", "-W", "-f", "${Package}\t${Version}\t${Status}\n"]).await;
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
    let out = run_cmd(&["rpm", "-qa", "--queryformat", "%{NAME}\t%{VERSION}-%{RELEASE}\n"]).await;
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
    let out = run_cmd(&["pacman", "-Ss", query]).await;
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
                let version = version_part
                    .split_whitespace()
                    .next()
                    .unwrap_or("");

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
    let out = run_cmd(&["apt-cache", "search", query]).await;
    let mut pkgs = Vec::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.splitn(2, " - ").collect();
        if parts.len() == 2 {
            let name = parts[0].trim();
            let desc = parts[1].trim();

            // Check if installed
            let installed = is_apt_installed(name).await;
            // Get version from apt-cache policy
            let version = get_apt_candidate_version(name).await;

            pkgs.push(serde_json::json!({
                "name": name,
                "version": version,
                "installed": installed,
                "description": desc,
            }));
        }
        // Limit results for performance
        if pkgs.len() >= 200 {
            break;
        }
    }
    pkgs
}

async fn is_apt_installed(name: &str) -> bool {
    let out = std::process::Command::new("dpkg-query")
        .args(["-W", "-f", "${Status}", name])
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).contains("install ok installed"),
        Err(_) => false,
    }
}

async fn get_apt_candidate_version(name: &str) -> String {
    let out = run_cmd(&["apt-cache", "policy", name]).await;
    for line in out.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Candidate:") {
            return trimmed
                .strip_prefix("Candidate:")
                .unwrap_or("")
                .trim()
                .to_string();
        }
    }
    String::new()
}

async fn search_dnf(query: &str) -> Vec<serde_json::Value> {
    // dnf search <query>
    let out = run_cmd(&["dnf", "search", "--quiet", query]).await;
    let mut pkgs = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('=') || line.starts_with("Last metadata") {
            continue;
        }
        // Format: "name.arch : description"
        let parts: Vec<&str> = line.splitn(2, " : ").collect();
        if parts.len() == 2 {
            let name_arch = parts[0].trim();
            let desc = parts[1].trim();
            // Strip architecture suffix
            let name = if name_arch.contains('.') {
                name_arch.rsplitn(2, '.').last().unwrap_or(name_arch)
            } else {
                name_arch
            };

            pkgs.push(serde_json::json!({
                "name": name,
                "version": "",
                "installed": false,
                "description": desc,
            }));
        }
        if pkgs.len() >= 200 {
            break;
        }
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
    let backend = detect_backend().await;
    match backend {
        PkgBackend::Pacman => {
            let out = run_cmd(&["pacman", "-Qi", name]).await;
            if out.contains("was not found") {
                // Try remote info
                let out = run_cmd(&["pacman", "-Si", name]).await;
                serde_json::json!({ "info": out, "installed": false })
            } else {
                serde_json::json!({ "info": out, "installed": true })
            }
        }
        PkgBackend::Apt => {
            let out = run_cmd(&["apt-cache", "show", name]).await;
            let installed = is_apt_installed(name).await;
            serde_json::json!({ "info": out, "installed": installed })
        }
        PkgBackend::Dnf => {
            let out = run_cmd(&["dnf", "info", "--quiet", name]).await;
            let installed = out.contains("Installed Packages");
            serde_json::json!({ "info": out, "installed": installed })
        }
        PkgBackend::None => serde_json::json!({ "error": "no package manager" }),
    }
}

// ──────────────────────────────────────────────────────────────
//  Install / Remove
// ──────────────────────────────────────────────────────────────

async fn install_packages(password: &str, names: &[String]) -> serde_json::Value {
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
            args.push("dnf".into());
            args.push("install".into());
            args.push("-y".into());
            args.push("--".into());
            args.extend(names.iter().cloned());
        }
        PkgBackend::None => return serde_json::json!({ "error": "no package manager" }),
    }

    sudo_action(password, &args).await
}

async fn remove_packages(password: &str, names: &[String]) -> serde_json::Value {
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
            args.push("dnf".into());
            args.push("remove".into());
            args.push("-y".into());
            args.push("--".into());
            args.extend(names.iter().cloned());
        }
        PkgBackend::None => return serde_json::json!({ "error": "no package manager" }),
    }

    sudo_action(password, &args).await
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
                if line.is_empty() { continue; }
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

async fn update_system(password: &str) -> serde_json::Value {
    let backend = detect_backend().await;
    let args: Vec<String> = match backend {
        PkgBackend::Pacman => vec!["pacman".into(), "-Syu".into(), "--noconfirm".into()],
        PkgBackend::Apt => {
            // For modern Debian/Ubuntu: apt-get dist-upgrade handles all upgrades
            // First refresh, then upgrade
            let refresh = sudo_action(password, &["apt-get", "update"]).await;
            if refresh.get("error").is_some() {
                return refresh;
            }
            vec!["apt-get".into(), "dist-upgrade".into(), "-y".into()]
        }
        PkgBackend::Dnf => vec!["dnf".into(), "upgrade".into(), "-y".into()],
        PkgBackend::None => return serde_json::json!({ "error": "no package manager" }),
    };

    sudo_action(password, &args).await
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
                && name != "options" {
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
            current_server = val.trim_start_matches(|c: char| c == '=' || c.is_whitespace()).to_string();
        } else if let Some(val) = line.strip_prefix("Include") {
            current_include = val.trim_start_matches(|c: char| c == '=' || c.is_whitespace()).to_string();
        } else if let Some(val) = line.strip_prefix("SigLevel") {
            current_sig_level = val.trim_start_matches(|c: char| c == '=' || c.is_whitespace()).to_string();
        }
    }

    // Save last repo
    if let Some(name) = current_repo
        && name != "options" {
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
                                let enabled = current.get("Enabled")
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
                        let enabled = current.get("Enabled")
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
        let parts: Vec<&str> = line.splitn(3, char::is_whitespace).collect();
        if parts.len() >= 2 {
            let id = parts[0].trim();
            let name = parts.get(1).unwrap_or(&"").trim();
            let enabled = !id.ends_with("*disabled");
            let clean_id = id.trim_end_matches("*disabled");
            repos.push(serde_json::json!({
                "name": clean_id,
                "description": name,
                "enabled": enabled,
            }));
        }
    }

    serde_json::json!({ "backend": "dnf", "repos": repos })
}

// ── Add repo ──

async fn add_repo(password: &str, repo: &str, name: &str) -> serde_json::Value {
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
            if !name.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
                return serde_json::json!({ "error": "invalid repository name" });
            }
            // Validate repo URL
            if !is_valid_repo_url(repo) {
                return serde_json::json!({ "error": "invalid repository URL" });
            }
            let block = format!("\n[{name}]\nServer = {repo}\n");
            // Use tee with stdin to avoid shell injection
            sudo_stdin_write(password, &["tee", "-a", "/etc/pacman.conf"], &block).await
        }
        PkgBackend::Apt => {
            // For modern apt: add-apt-repository or write .list file
            // If it's a PPA or http URL
            if repo.starts_with("ppa:") {
                sudo_action(password, &["add-apt-repository", "-y", repo]).await
            } else {
                // Write a .list file
                let fname = if name.is_empty() { "custom" } else { name };
                // Validate filename
                if !fname.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
                    return serde_json::json!({ "error": "invalid repository name" });
                }
                let path = format!("/etc/apt/sources.list.d/{fname}.list");
                // Validate repo line
                if repo.contains('\n') || repo.contains('\r') {
                    return serde_json::json!({ "error": "invalid repository line" });
                }
                sudo_stdin_write(password, &["tee", &path], &format!("{repo}\n")).await
            }
        }
        PkgBackend::Dnf => {
            // dnf config-manager --add-repo <url>
            if which("dnf-3").await || which("dnf").await {
                sudo_action(password, &["dnf", "config-manager", "--add-repo", repo]).await
            } else {
                serde_json::json!({ "error": "dnf config-manager not available" })
            }
        }
        PkgBackend::None => serde_json::json!({ "error": "no package manager" }),
    }
}

// ── Remove repo ──

async fn remove_repo(password: &str, repo: &str) -> serde_json::Value {
    if repo.is_empty() {
        return serde_json::json!({ "error": "repository identifier required" });
    }

    let backend = detect_backend().await;

    match backend {
        PkgBackend::Pacman => {
            // Remove [repo] section from /etc/pacman.conf
            // Validate repo name
            if !repo.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
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
            sudo_stdin_write(password, &["tee", "/etc/pacman.conf"], &new_content).await
        }
        PkgBackend::Apt => {
            if repo.starts_with("ppa:") {
                sudo_action(password, &["add-apt-repository", "--remove", "-y", repo]).await
            } else if repo.starts_with("/") {
                // It's a file path — remove the file
                // Validate path is in sources.list.d
                if !repo.starts_with("/etc/apt/sources.list.d/") {
                    return serde_json::json!({ "error": "can only remove files in /etc/apt/sources.list.d/" });
                }
                sudo_action(password, &["rm", "-f", repo]).await
            } else {
                // Try to find and remove matching .list file
                let fname = format!("/etc/apt/sources.list.d/{repo}.list");
                sudo_action(password, &["rm", "-f", &fname]).await
            }
        }
        PkgBackend::Dnf => {
            // Remove .repo file from /etc/yum.repos.d/
            let path = if repo.starts_with("/") {
                if !repo.starts_with("/etc/yum.repos.d/") {
                    return serde_json::json!({ "error": "can only remove repo files in /etc/yum.repos.d/" });
                }
                repo.to_string()
            } else {
                // Validate name
                if !repo.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.') {
                    return serde_json::json!({ "error": "invalid repository name" });
                }
                format!("/etc/yum.repos.d/{repo}.repo")
            };
            sudo_action(password, &["rm", "-f", &path]).await
        }
        PkgBackend::None => serde_json::json!({ "error": "no package manager" }),
    }
}

// ── Refresh repos ──

async fn refresh_repos(password: &str) -> serde_json::Value {
    let backend = detect_backend().await;
    match backend {
        PkgBackend::Pacman => sudo_action(password, &["pacman", "-Sy", "--noconfirm"]).await,
        PkgBackend::Apt => sudo_action(password, &["apt-get", "update"]).await,
        PkgBackend::Dnf => sudo_action(password, &["dnf", "makecache", "--quiet"]).await,
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
        && name.chars().all(|c| c.is_alphanumeric() || "-._+:".contains(c))
}

async fn which(cmd: &str) -> bool {
    tokio::process::Command::new("which")
        .arg(cmd)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

async fn run_cmd(args: &[&str]) -> String {
    let Some((cmd, rest)) = args.split_first() else {
        return String::new();
    };
    match tokio::process::Command::new(cmd)
        .args(rest)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
    {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            if stdout.is_empty() {
                String::from_utf8_lossy(&out.stderr).to_string()
            } else {
                stdout
            }
        }
        Err(e) => format!("error: {e}"),
    }
}

async fn sudo_action(password: &str, args: &[impl AsRef<str>]) -> serde_json::Value {
    if password.is_empty() {
        return serde_json::json!({ "error": "password required" });
    }

    let str_args: Vec<&str> = args.iter().map(|a| a.as_ref()).collect();
    let mut cmd_args = vec!["-S"];
    cmd_args.extend_from_slice(&str_args);

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
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            serde_json::json!({ "ok": true, "output": stdout })
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let clean = stderr
                .lines()
                .filter(|l| !l.contains("[sudo]") && !l.contains("password for"))
                .collect::<Vec<_>>()
                .join("\n");
            let msg = if clean.is_empty() {
                "authentication failed".to_string()
            } else {
                clean
            };
            serde_json::json!({ "error": msg })
        }
        Err(e) => serde_json::json!({ "error": e.to_string() }),
    }
}

/// Write `content` to a command's stdin via sudo, avoiding shell execution.
async fn sudo_stdin_write(password: &str, args: &[&str], content: &str) -> serde_json::Value {
    if password.is_empty() {
        return serde_json::json!({ "error": "password required" });
    }

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
        // Send sudo password, then the actual content
        let _ = stdin.write_all(format!("{password}\n").as_bytes()).await;
        let _ = stdin.write_all(content.as_bytes()).await;
        drop(stdin);
    }

    match child.wait_with_output().await {
        Ok(out) if out.status.success() => {
            serde_json::json!({ "ok": true })
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let clean = stderr
                .lines()
                .filter(|l| !l.contains("[sudo]") && !l.contains("password for"))
                .collect::<Vec<_>>()
                .join("\n");
            let msg = if clean.is_empty() {
                "operation failed".to_string()
            } else {
                clean
            };
            serde_json::json!({ "error": msg })
        }
        Err(e) => serde_json::json!({ "error": e.to_string() }),
    }
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

fn extract_string_array(data: &serde_json::Value, key: &str) -> Vec<String> {
    data.get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

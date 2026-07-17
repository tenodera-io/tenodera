use async_trait::async_trait;
use serde_json::{Value, json};

use crate::handler::ChannelHandler;
use crate::handlers::system_settings::active_unit;
use crate::util::{require_admin, run_cmd, sudo_as_user, sudo_stdin_write_as_user, which};
use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

// ── timesync.manage ───────────────────────────────────────────────────────────
// Generic management for the host's time-sync daemon *other than chrony* (which
// has its own richer chrony.manage). Covers systemd-timesyncd, ntpd/ntpsec,
// OpenNTPD and the PTP daemons (ptp4l / phc2sys): a read-only status readout, the
// main config file (view + edit), and service restart / enable-at-boot.
//
// The frontend passes the detected daemon in `daemon`. Open-time options: no
// `action` → read status+config; `action` set → mutate (admin-gated, privileged
// bits run via sudo as the calling user so host sudoers/HBAC apply).

pub struct TimeSyncHandler;

#[async_trait]
impl ChannelHandler for TimeSyncHandler {
    fn payload_type(&self) -> &str {
        "timesync.manage"
    }

    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let extra = Value::Object(options.extra.clone());
        let daemon = options
            .extra
            .get("daemon")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let action = options
            .extra
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let data = match Spec::for_daemon(daemon) {
            None => json!({ "available": false, "error": format!("unsupported daemon: {daemon}") }),
            Some(spec) => {
                if action.is_empty() || action == "status" {
                    read(&spec).await
                } else if let Some(err) = require_admin(&extra) {
                    err
                } else {
                    let password = options
                        .extra
                        .get("password")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let user = options
                        .extra
                        .get("_user")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    apply(&spec, action, &extra, user, password).await
                }
            }
        };

        vec![
            Message::Ready {
                channel: channel.into(),
            },
            Message::Data {
                channel: channel.into(),
                data,
            },
            Message::Close {
                channel: channel.into(),
                problem: None,
            },
        ]
    }
}

// ── Per-daemon spec ────────────────────────────────────────────────────────────

/// How to inspect a daemon's live status.
enum StatusKind {
    /// Run this command (its first token must be installed).
    Cmd(&'static [&'static str]),
    /// Tail the unit's journal (for daemons without a status client, e.g. PTP).
    Journal,
}

/// Candidate units, status source and config locations for one daemon.
struct Spec {
    daemon: &'static str,
    label: &'static str,
    units: &'static [&'static str],
    status_kind: StatusKind,
    status_label: &'static str,
    config_paths: &'static [&'static str],
    editable: bool,
}

impl Spec {
    fn for_daemon(d: &str) -> Option<Spec> {
        Some(match d {
            "systemd-timesyncd" => Spec {
                daemon: "systemd-timesyncd",
                label: "systemd-timesyncd",
                units: &["systemd-timesyncd"],
                status_kind: StatusKind::Cmd(&["timedatectl", "timesync-status"]),
                status_label: "timedatectl timesync-status",
                config_paths: &["/etc/systemd/timesyncd.conf"],
                editable: true,
            },
            "ntpd" => Spec {
                daemon: "ntpd",
                label: "ntpd",
                units: &["ntp", "ntpd"],
                status_kind: StatusKind::Cmd(&["ntpq", "-pn"]),
                status_label: "ntpq -pn",
                config_paths: &["/etc/ntp.conf"],
                editable: true,
            },
            "ntpsec" => Spec {
                daemon: "ntpsec",
                label: "NTPsec",
                units: &["ntpsec", "ntp"],
                status_kind: StatusKind::Cmd(&["ntpq", "-pn"]),
                status_label: "ntpq -pn",
                config_paths: &["/etc/ntpsec/ntp.conf", "/etc/ntp.conf"],
                editable: true,
            },
            "openntpd" => Spec {
                daemon: "openntpd",
                label: "OpenNTPD",
                units: &["openntpd"],
                status_kind: StatusKind::Cmd(&["ntpctl", "-s", "all"]),
                status_label: "ntpctl -s all",
                config_paths: &["/etc/openntpd/ntpd.conf", "/etc/ntpd.conf"],
                editable: true,
            },
            "ptp4l" => Spec {
                daemon: "ptp4l",
                label: "ptp4l (PTP)",
                units: &["ptp4l"],
                status_kind: StatusKind::Journal,
                status_label: "Recent journal (ptp4l)",
                config_paths: &["/etc/linuxptp/ptp4l.conf", "/etc/ptp4l.conf"],
                editable: true,
            },
            "phc2sys" => Spec {
                daemon: "phc2sys",
                label: "phc2sys (PTP)",
                units: &["phc2sys"],
                status_kind: StatusKind::Journal,
                status_label: "Recent journal (phc2sys)",
                // Usually configured via unit arguments, not a standard config file.
                config_paths: &["/etc/linuxptp/phc2sys.conf"],
                editable: false,
            },
            _ => return None,
        })
    }

    async fn unit(&self) -> String {
        active_unit(self.units)
            .await
            .unwrap_or_else(|| self.units[0].to_string())
    }

    fn config_path(&self) -> Option<String> {
        self.config_paths
            .iter()
            .find(|p| std::path::Path::new(p).exists())
            .map(|p| p.to_string())
    }
}

// ── Read ───────────────────────────────────────────────────────────────────────

async fn read(spec: &Spec) -> Value {
    let unit = spec.unit().await;
    let active = run_cmd(&["systemctl", "is-active", &unit]).await.trim() == "active";
    let enabled = run_cmd(&["systemctl", "is-enabled", &unit]).await.trim() == "enabled";

    let status_text = match spec.status_kind {
        StatusKind::Cmd(args) => {
            let bin = args[0];
            if which(bin).await {
                run_cmd(args).await
            } else {
                format!("{bin} is not installed.")
            }
        }
        StatusKind::Journal => {
            run_cmd(&[
                "journalctl",
                "-u",
                &unit,
                "-n",
                "40",
                "--no-pager",
                "-o",
                "short-iso",
            ])
            .await
        }
    };

    let config_path = spec.config_path();
    let config_raw = config_path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();

    json!({
        "available": true,
        "daemon": spec.daemon,
        "label": spec.label,
        "unit": unit,
        "active": active,
        "enabled": enabled,
        "status_label": spec.status_label,
        "status_text": status_text.trim_end(),
        "config_path": config_path,
        "config_raw": config_raw,
        "config_editable": spec.editable && config_path.is_some(),
    })
}

// ── Mutations ──────────────────────────────────────────────────────────────────

async fn apply(spec: &Spec, action: &str, data: &Value, user: &str, password: &str) -> Value {
    match action {
        "restart" => {
            let unit = spec.unit().await;
            let r = sudo_as_user(user, password, &["systemctl", "restart", &unit]).await;
            let ok = r.get("error").is_none();
            crate::audit::log(user, "timesync.restart", &unit, ok, spec.daemon);
            if !ok { r } else { json!({ "ok": true }) }
        }
        "set_enabled" => {
            let enabled = data
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let unit = spec.unit().await;
            let verb = if enabled { "enable" } else { "disable" };
            let r = sudo_as_user(user, password, &["systemctl", verb, &unit]).await;
            let ok = r.get("error").is_none();
            crate::audit::log(user, "timesync.set_enabled", &unit, ok, verb);
            if !ok { r } else { json!({ "ok": true }) }
        }
        "save_config" => {
            if !spec.editable {
                return json!({ "error": format!("{} has no editable config file", spec.label) });
            }
            let content = data.get("content").and_then(|v| v.as_str()).unwrap_or("");
            if content.trim().is_empty() {
                return json!({ "error": "config is empty" });
            }
            let Some(path) = spec.config_path() else {
                return json!({ "error": "configuration file not found" });
            };
            let normalized = if content.ends_with('\n') {
                content.to_string()
            } else {
                format!("{content}\n")
            };
            let w = sudo_stdin_write_as_user(user, password, &["tee", &path], &normalized).await;
            if w.get("error").is_some() {
                return w;
            }
            let unit = spec.unit().await;
            let r = sudo_as_user(user, password, &["systemctl", "restart", &unit]).await;
            let ok = r.get("error").is_none();
            crate::audit::log(user, "timesync.save_config", &path, ok, spec.daemon);
            if !ok { r } else { json!({ "ok": true }) }
        }
        other => json!({ "error": format!("unknown action: {other}") }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_daemons_have_specs() {
        for d in [
            "systemd-timesyncd",
            "ntpd",
            "ntpsec",
            "openntpd",
            "ptp4l",
            "phc2sys",
        ] {
            assert!(Spec::for_daemon(d).is_some(), "missing spec for {d}");
        }
        // chrony has its own handler; not served here.
        assert!(Spec::for_daemon("chrony").is_none());
        assert!(Spec::for_daemon("bogus").is_none());
    }

    #[test]
    fn phc2sys_config_not_editable() {
        let spec = Spec::for_daemon("phc2sys").unwrap();
        assert!(!spec.editable);
    }
}

use std::collections::HashMap;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;

use tenodera_protocol::channel::{ChannelId, ChannelOpenOptions};
use tenodera_protocol::message::Message;
use tokio::io::unix::AsyncFd;
use tokio::sync::{Mutex, mpsc, watch};

use crate::handler::ChannelHandler;

pub struct TerminalPtyHandler {
    /// Stores per-channel writer fds for writing client input to PTY master.
    writers: Arc<Mutex<HashMap<ChannelId, OwnedFd>>>,
}

impl Default for TerminalPtyHandler {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalPtyHandler {
    pub fn new() -> Self {
        Self {
            writers: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[async_trait::async_trait]
impl ChannelHandler for TerminalPtyHandler {
    fn payload_type(&self) -> &str {
        "terminal.pty"
    }

    fn is_streaming(&self) -> bool {
        true
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        vec![Message::Ready {
            channel: channel.into(),
        }]
    }

    async fn stream(
        &self,
        channel: &str,
        options: &ChannelOpenOptions,
        tx: mpsc::Sender<Message>,
        mut shutdown: watch::Receiver<bool>,
    ) {
        let cols = options
            .extra
            .get("cols")
            .and_then(|v| v.as_u64())
            .unwrap_or(80) as u16;
        let rows = options
            .extra
            .get("rows")
            .and_then(|v| v.as_u64())
            .unwrap_or(24) as u16;
        let channel: ChannelId = channel.into();

        // A `container` option turns this into an interactive exec into that
        // container (`<rt> exec -it <container> <shell>`), gated on a verified
        // superuser password. Otherwise it is a login shell as the caller.
        let container = options
            .extra
            .get("container")
            .and_then(|v| v.as_str())
            .filter(|c| {
                !c.is_empty()
                    && c.len() <= 128
                    && c.chars().all(|ch| {
                        ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':' | '/')
                    })
            });

        let pty = if let Some(container) = container {
            let user = options
                .extra
                .get("_user")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let password = options
                .extra
                .get("password")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            // Verify the caller's password + sudo access (PAM/SSSD) before a root shell into a container.
            let v = crate::handlers::superuser_verify::verify_password(user, password).await;
            if v.get("ok").and_then(|x| x.as_bool()) != Some(true) {
                let _ = tx
                    .send(Message::Close {
                        channel,
                        problem: Some("authentication required".into()),
                    })
                    .await;
                return;
            }
            let rt = if crate::util::which("docker").await {
                "docker"
            } else if crate::util::which("podman").await {
                "podman"
            } else {
                let _ = tx
                    .send(Message::Close {
                        channel,
                        problem: Some("no container runtime".into()),
                    })
                    .await;
                return;
            };
            let requested = options
                .extra
                .get("shell")
                .and_then(|v| v.as_str())
                .filter(|s| matches!(*s, "sh" | "bash" | "ash" | "/bin/sh" | "/bin/bash"));
            crate::audit::log(
                user,
                "container.exec",
                &format!("{rt} {container} {}", requested.unwrap_or("auto")),
                true,
                "",
            );
            // Honour an explicit shell; otherwise detect one inside the container —
            // prefer bash, fall back to ash/sh — since minimal images vary.
            let args: Vec<&str> = match requested {
                Some(sh) => vec!["exec", "-it", container, sh],
                None => vec![
                    "exec",
                    "-it",
                    container,
                    "/bin/sh",
                    "-c",
                    "exec \"$(command -v bash || command -v ash || echo /bin/sh)\"",
                ],
            };
            // Runs as the agent (root) against the host's rootful runtime.
            open_pty_cmd(rt, &args, cols, rows, "/", None)
        } else {
            // ── Login shell as the target user ──
            let target_user = options
                .extra
                .get("_user")
                .and_then(|v| v.as_str())
                .filter(|u| {
                    u.chars()
                        .all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == '.')
                })
                .map(|s| s.to_string());
            let user_info = target_user.as_deref().and_then(crate::util::lookup_user);

            let default_shell = user_info
                .as_ref()
                .map(|(_, _, _, s)| s.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| get_user_shell().unwrap_or_else(|| "/bin/sh".to_string()));
            let shell = options
                .extra
                .get("shell")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or(default_shell);

            const ALLOWED_SHELLS: &[&str] = &[
                "/bin/sh",
                "/bin/bash",
                "/bin/zsh",
                "/bin/fish",
                "/usr/bin/sh",
                "/usr/bin/bash",
                "/usr/bin/zsh",
                "/usr/bin/fish",
            ];
            if !ALLOWED_SHELLS.contains(&shell.as_str()) {
                tracing::warn!(shell = %shell, "rejected non-whitelisted shell");
                let _ = tx
                    .send(Message::Close {
                        channel,
                        problem: Some(format!("shell not allowed: {shell}")),
                    })
                    .await;
                return;
            }

            let default_cwd = user_info
                .as_ref()
                .map(|(_, _, home, _)| home.clone())
                .unwrap_or_else(|| "/tmp".to_string());
            let cwd = options
                .extra
                .get("cwd")
                .and_then(|v| v.as_str())
                .unwrap_or(&default_cwd);

            let audit_user = target_user.as_deref().unwrap_or("unknown");
            crate::audit::log(
                audit_user,
                "terminal.open",
                &format!("shell={shell}"),
                true,
                "",
            );

            open_pty_cmd(&shell, &[], cols, rows, cwd, target_user.as_deref())
        };

        // Open PTY — returns (async reader via AsyncFd, writer OwnedFd, child process)
        let (reader, writer, child) = match pty {
            Ok(tuple) => tuple,
            Err(e) => {
                tracing::error!(error = %e, "failed to open PTY");
                let _ = tx
                    .send(Message::Close {
                        channel,
                        problem: Some(format!("pty-error: {e}")),
                    })
                    .await;
                return;
            }
        };

        // Spawn a background task to reap the child process.
        // Without this, the child becomes a zombie after exit because
        // dropping a std::process::Child does NOT call wait() on Unix.
        let reaper_channel = channel.clone();
        tokio::task::spawn_blocking(move || {
            let mut child = child;
            match child.wait() {
                Ok(status) => {
                    tracing::debug!(channel = %reaper_channel, ?status, "PTY child reaped");
                }
                Err(e) => {
                    tracing::warn!(channel = %reaper_channel, error = %e, "PTY child wait failed");
                }
            }
        });

        // Store writer for this channel so data() can write to it
        self.writers.lock().await.insert(channel.clone(), writer);

        let mut buf = [0u8; 4096];

        loop {
            tokio::select! {
                guard_result = reader.readable() => {
                    let mut guard = match guard_result {
                        Ok(g) => g,
                        Err(e) => {
                            tracing::warn!(error = %e, "PTY AsyncFd error");
                            break;
                        }
                    };

                    match guard.try_io(|inner| {
                        let fd = inner.as_raw_fd();
                        let ret = unsafe {
                            libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len())
                        };
                        if ret < 0 {
                            Err(std::io::Error::last_os_error())
                        } else {
                            Ok(ret as usize)
                        }
                    }) {
                        Ok(Ok(0)) => break, // EOF
                        Ok(Ok(n)) => {
                            let text = String::from_utf8_lossy(&buf[..n]).to_string();
                            if tx.send(Message::Data {
                                channel: channel.clone(),
                                data: serde_json::json!({ "output": text }),
                            }).await.is_err() {
                                break;
                            }
                        }
                        Ok(Err(e)) => {
                            tracing::warn!(error = %e, "PTY read error");
                            break;
                        }
                        Err(_would_block) => continue, // EAGAIN — let AsyncFd re-poll
                    }
                }
                _ = shutdown.changed() => {
                    if *shutdown.borrow() {
                        tracing::debug!(channel = %channel, "PTY shutdown requested");
                        break;
                    }
                }
            }
        }

        // Clean up writer
        self.writers.lock().await.remove(&channel);

        let _ = tx
            .send(Message::Close {
                channel,
                problem: None,
            })
            .await;
    }

    async fn data(&self, channel: &str, data: &serde_json::Value) -> Vec<Message> {
        let writers = self.writers.lock().await;
        if let Some(writer_fd) = writers.get(channel) {
            let fd = writer_fd.as_raw_fd();

            // Handle resize
            if let Some(resize) = data.get("resize") {
                let cols = resize.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
                let rows = resize.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;
                let ws = nix::pty::Winsize {
                    ws_row: rows,
                    ws_col: cols,
                    ws_xpixel: 0,
                    ws_ypixel: 0,
                };
                unsafe {
                    libc::ioctl(fd, libc::TIOCSWINSZ, &ws as *const nix::pty::Winsize);
                }
            }

            // Handle keyboard input.
            // Release the mutex before the potentially-blocking write so other
            // channels are not starved if the PTY buffer is full.
            if let Some(input) = data.get("input").and_then(|v| v.as_str()) {
                let bytes = input.as_bytes().to_vec();
                // Drop the lock before the blocking write
                drop(writers);
                let channel_name = channel.to_string();
                tokio::task::spawn_blocking(move || {
                    let ret = unsafe {
                        libc::write(fd, bytes.as_ptr() as *const libc::c_void, bytes.len())
                    };
                    if ret < 0 {
                        let e = std::io::Error::last_os_error();
                        tracing::warn!(error = %e, channel = %channel_name, "failed to write to PTY");
                    }
                }).await.ok();
                return vec![];
            }
        }
        vec![]
    }
}

/// Detect the login shell of the current effective user via NSS (getpwuid_r).
/// Works for local users and LDAP/SSSD users alike.
fn get_user_shell() -> Option<String> {
    let uid = unsafe { libc::geteuid() };
    let mut pwd = unsafe { std::mem::zeroed::<libc::passwd>() };
    let mut buf = vec![0u8; 4096];
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    let ret = unsafe {
        libc::getpwuid_r(
            uid,
            &mut pwd,
            buf.as_mut_ptr().cast::<libc::c_char>(),
            buf.len(),
            &mut result,
        )
    };
    if ret != 0 || result.is_null() {
        return None;
    }
    let shell = unsafe { std::ffi::CStr::from_ptr((*result).pw_shell) }
        .to_string_lossy()
        .into_owned();
    if shell.is_empty() { None } else { Some(shell) }
}

/// Open a PTY and spawn the shell using `std::process::Command` with `pre_exec`.
///
/// This avoids raw `fork()` inside the async tokio runtime, which is unsafe
/// because `fork()` in a multi-threaded process only duplicates the calling
/// thread — all tokio runtime threads die in the child. Additionally, raw
/// `fork()` does not set `CLOEXEC` on inherited file descriptors, so the
/// child process inherits the agent's stdin/stdout pipes (SSH transport),
/// which can corrupt the JSON protocol stream.
///
/// `std::process::Command` handles `fork()`+`exec()` safely, sets `CLOEXEC`
/// on all non-stdio fds, and `pre_exec` runs in the child between fork and
/// exec for PTY/session/user setup.
///
/// Returns (AsyncFd reader, OwnedFd writer, Child) for the master side.
/// The caller MUST reap the Child (via wait/spawn_blocking) to avoid zombies.
fn open_pty_cmd(
    program: &str,
    args: &[&str],
    cols: u16,
    rows: u16,
    cwd: &str,
    run_as_user: Option<&str>,
) -> anyhow::Result<(AsyncFd<OwnedFd>, OwnedFd, Child)> {
    use std::os::unix::process::CommandExt;

    let winsize = nix::pty::Winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    let pty = nix::pty::openpty(Some(&winsize), None)?;

    // Dup slave fd three times: one each for stdin/stdout/stderr.
    // Command::stdin/stdout/stderr take ownership via Stdio::from(OwnedFd),
    // so each needs its own fd.
    let slave_raw = pty.slave.as_raw_fd();
    let slave_for_stdin = unsafe { OwnedFd::from_raw_fd(libc::dup(slave_raw)) };
    let slave_for_stdout = unsafe { OwnedFd::from_raw_fd(libc::dup(slave_raw)) };
    let slave_for_stderr = unsafe { OwnedFd::from_raw_fd(libc::dup(slave_raw)) };

    // Prepare argv0 — login shell prefix if switching user
    let argv0 = if run_as_user.is_some() {
        let basename = program.rsplit('/').next().unwrap_or(program);
        format!("-{basename}")
    } else {
        program.rsplit('/').next().unwrap_or(program).to_string()
    };

    // Resolve user info for pre_exec (uid, gid, home, username)
    let user_info = run_as_user.and_then(|u| {
        crate::util::lookup_user(u).map(|(uid, gid, home, _)| (uid, gid, home, u.to_string()))
    });
    let shell_for_env = program.to_string();

    let mut cmd = Command::new(program);
    cmd.arg0(&argv0);
    cmd.args(args);
    cmd.stdin(Stdio::from(slave_for_stdin));
    cmd.stdout(Stdio::from(slave_for_stdout));
    cmd.stderr(Stdio::from(slave_for_stderr));
    cmd.current_dir(cwd);

    // Set environment for target user
    if let Some((_, _, ref home, ref username)) = user_info {
        cmd.env("HOME", home);
        cmd.env("USER", username);
        cmd.env("LOGNAME", username);
        cmd.env("SHELL", &shell_for_env);
    }

    // pre_exec runs in child after fork, before exec — set up PTY session and user
    unsafe {
        let user_info_clone = user_info.clone();
        cmd.pre_exec(move || {
            // Create new session (detach from agent's session)
            libc::setsid();

            // Set controlling terminal — fd 0 is the PTY slave (set by Command)
            libc::ioctl(0, libc::TIOCSCTTY, 0);

            // Switch to target user if requested
            if let Some((uid, gid, _, ref username)) = user_info_clone {
                let user_cstr = std::ffi::CString::new(username.as_str())
                    .unwrap_or_else(|_| std::ffi::CString::new("nobody").unwrap());
                libc::initgroups(user_cstr.as_ptr(), gid);
                if libc::setgid(gid) != 0 || libc::setuid(uid) != 0 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        format!("failed to switch to user {username}"),
                    ));
                }
            }

            Ok(())
        });
    }

    // Spawn the child process — this does fork+exec safely
    let child = cmd
        .spawn()
        .map_err(|e| anyhow::anyhow!("failed to spawn {program}: {e}"))?;

    // Close slave fds in parent — they're only needed by the child
    drop(pty.slave);

    // Set up master fd for async reading and sync writing
    let master_raw = pty.master.as_raw_fd();

    // Dup master for writer (separate fd, same underlying file description)
    let writer_raw = unsafe { libc::dup(master_raw) };
    if writer_raw < 0 {
        return Err(anyhow::anyhow!(
            "dup failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let writer = unsafe { OwnedFd::from_raw_fd(writer_raw) };

    // Set master non-blocking for AsyncFd epoll integration
    unsafe {
        let flags = libc::fcntl(master_raw, libc::F_GETFL);
        libc::fcntl(master_raw, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }

    // Wrap master OwnedFd in AsyncFd (takes ownership, no manual close needed)
    let reader = AsyncFd::new(pty.master)?;

    Ok((reader, writer, child))
}

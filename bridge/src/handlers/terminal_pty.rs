use std::collections::HashMap;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::Arc;

use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;
use tokio::io::unix::AsyncFd;
use tokio::sync::{mpsc, watch, Mutex};

use crate::handler::ChannelHandler;

pub struct TerminalPtyHandler {
    /// Stores per-channel writer fds for writing client input to PTY master.
    writers: Arc<Mutex<HashMap<String, OwnedFd>>>,
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
            channel: channel.to_string(),
        }]
    }

    async fn stream(
        &self,
        channel: &str,
        options: &ChannelOpenOptions,
        tx: mpsc::Sender<Message>,
        mut shutdown: watch::Receiver<bool>,
    ) {
        // Resolve target user from gateway-injected _user field
        let target_user = options
            .extra
            .get("_user")
            .and_then(|v| v.as_str())
            .filter(|u| u.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == '.'))
            .map(|s| s.to_string());
        let user_info = target_user.as_deref().and_then(lookup_user);

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

        // Validate shell path against allowed shells
        const ALLOWED_SHELLS: &[&str] = &[
            "/bin/sh", "/bin/bash", "/bin/zsh", "/bin/fish",
            "/usr/bin/sh", "/usr/bin/bash", "/usr/bin/zsh", "/usr/bin/fish",
        ];
        if !ALLOWED_SHELLS.contains(&shell.as_str()) {
            tracing::warn!(shell = %shell, "rejected non-whitelisted shell");
            let _ = tx
                .send(Message::Close {
                    channel: channel.to_string(),
                    problem: Some(format!("shell not allowed: {shell}")),
                })
                .await;
            return;
        }

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

        let default_cwd = user_info
            .as_ref()
            .map(|(_, _, home, _)| home.clone())
            .unwrap_or_else(|| "/tmp".to_string());
        let cwd = options
            .extra
            .get("cwd")
            .and_then(|v| v.as_str())
            .unwrap_or(&default_cwd);

        let channel = channel.to_string();

        // Open PTY — returns (async reader via AsyncFd, writer OwnedFd)
        let (reader, writer) = match open_pty(&shell, cols, rows, cwd, target_user.as_deref()) {
            Ok(pair) => pair,
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

            // Handle keyboard input
            if let Some(input) = data.get("input").and_then(|v| v.as_str()) {
                let bytes = input.as_bytes();
                let ret = unsafe {
                    libc::write(fd, bytes.as_ptr() as *const libc::c_void, bytes.len())
                };
                if ret < 0 {
                    let e = std::io::Error::last_os_error();
                    tracing::warn!(error = %e, channel = %channel, "failed to write to PTY");
                }
            }
        }
        vec![]
    }
}

/// Detect the current user's login shell from /etc/passwd.
fn get_user_shell() -> Option<String> {
    let uid = nix::unistd::getuid();
    let passwd = std::fs::read_to_string("/etc/passwd").ok()?;
    for line in passwd.lines() {
        let fields: Vec<&str> = line.split(':').collect();
        if fields.len() >= 7
            && let Ok(entry_uid) = fields[2].parse::<u32>()
                && entry_uid == uid.as_raw() {
                    let shell = fields[6].trim();
                    if !shell.is_empty() {
                        return Some(shell.to_string());
                    }
                }
    }
    None
}

/// Look up a user in /etc/passwd. Returns (uid, gid, home, shell).
fn lookup_user(username: &str) -> Option<(u32, u32, String, String)> {
    let passwd = std::fs::read_to_string("/etc/passwd").ok()?;
    for line in passwd.lines() {
        let fields: Vec<&str> = line.split(':').collect();
        if fields.len() >= 7 && fields[0] == username {
            let uid = fields[2].parse::<u32>().ok()?;
            let gid = fields[3].parse::<u32>().ok()?;
            let home = fields[5].to_string();
            let shell = fields[6].trim().to_string();
            return Some((uid, gid, home, shell));
        }
    }
    None
}

/// Open a PTY, fork, and exec the shell in the child.
/// Returns (AsyncFd reader, OwnedFd writer) for the master side.
fn open_pty(
    shell: &str,
    cols: u16,
    rows: u16,
    cwd: &str,
    run_as_user: Option<&str>,
) -> anyhow::Result<(AsyncFd<OwnedFd>, OwnedFd)> {
    use nix::pty::openpty;
    use nix::unistd::{dup2, execvp, fork, setsid, setgid, setuid, ForkResult, Gid, Uid};

    let winsize = nix::pty::Winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    let pty = openpty(Some(&winsize), None)?;

    match unsafe { fork()? } {
        ForkResult::Parent { .. } => {
            // Close slave in parent — drop OwnedFd properly (no double-close)
            drop(pty.slave);

            let master_raw = pty.master.as_raw_fd();

            // Dup master for writer (separate fd, same file description)
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

            Ok((reader, writer))
        }
        ForkResult::Child => {
            // Close master in child
            drop(pty.master);

            // Create new session
            setsid().ok();

            // Set controlling terminal
            unsafe {
                libc::ioctl(pty.slave.as_raw_fd(), libc::TIOCSCTTY, 0);
            }

            // Redirect stdio to slave
            let slave_fd = pty.slave.as_raw_fd();
            dup2(slave_fd, 0).ok();
            dup2(slave_fd, 1).ok();
            dup2(slave_fd, 2).ok();

            if slave_fd > 2 {
                drop(pty.slave);
            } else {
                // slave IS one of stdin/stdout/stderr — don't close it
                std::mem::forget(pty.slave);
            }

            // Switch to target user if specified
            if let Some(username) = run_as_user {
                if let Some((uid, gid, home, _)) = lookup_user(username) {
                    let user_cstr = std::ffi::CString::new(username)
                        .unwrap_or_else(|_| std::ffi::CString::new("nobody").unwrap());
                    unsafe { libc::initgroups(user_cstr.as_ptr(), gid); }
                    if setgid(Gid::from_raw(gid)).is_err()
                        || setuid(Uid::from_raw(uid)).is_err()
                    {
                        let msg = format!("failed to switch to user {username}\r\n");
                        unsafe {
                            libc::write(2, msg.as_ptr() as *const libc::c_void, msg.len());
                        }
                        std::process::exit(1);
                    }
                    unsafe {
                        std::env::set_var("HOME", &home);
                        std::env::set_var("USER", username);
                        std::env::set_var("LOGNAME", username);
                        std::env::set_var("SHELL", shell);
                    }
                } else {
                    let msg = format!("user {username} not found\r\n");
                    unsafe {
                        libc::write(2, msg.as_ptr() as *const libc::c_void, msg.len());
                    }
                    std::process::exit(1);
                }
            }

            // Change to working directory
            let _ = std::env::set_current_dir(cwd);

            // Exec shell (login shell when switching user)
            let shell_cstr = std::ffi::CString::new(shell)
                .unwrap_or_else(|_| std::ffi::CString::new("/bin/sh").unwrap());
            let argv0 = if run_as_user.is_some() {
                let basename = shell.rsplit('/').next().unwrap_or(shell);
                std::ffi::CString::new(format!("-{basename}"))
                    .unwrap_or_else(|_| shell_cstr.clone())
            } else {
                shell_cstr.clone()
            };
            let _ = execvp(&shell_cstr, &[&argv0]);

            // If exec fails
            std::process::exit(1);
        }
    }
}

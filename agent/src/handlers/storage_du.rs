use std::os::unix::fs::MetadataExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, watch};

use crate::handler::ChannelHandler;
use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

// ── storage.du ───────────────────────────────────────────────────────────────
// "What's using space": one directory level at a time. Subdirectory sizes come
// from `du -x --max-depth=1` (stays on one filesystem); direct files are listed
// from the directory itself. Runs niced + ionice idle so it never starves the
// host, is capped by a hard timeout, and — being a streaming channel — is killed
// the moment the panel closes/cancels the channel. One scan at a time per agent.

const SCAN_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_ENTRIES: usize = 300; // cap payload
const MAX_DIR_READ: usize = 200_000; // cap direct-file enumeration

static SCANNING: AtomicBool = AtomicBool::new(false);

/// Flips SCANNING back to false on drop, however the handler returns.
struct ScanGuard;
impl Drop for ScanGuard {
    fn drop(&mut self) {
        SCANNING.store(false, Ordering::SeqCst);
    }
}

pub struct StorageDuHandler;

#[async_trait::async_trait]
impl ChannelHandler for StorageDuHandler {
    fn payload_type(&self) -> &str {
        "storage.du"
    }

    fn is_streaming(&self) -> bool {
        true
    }

    async fn stream(
        &self,
        channel: &str,
        options: &ChannelOpenOptions,
        tx: mpsc::Sender<Message>,
        mut shutdown: watch::Receiver<bool>,
    ) {
        let send = |data: Value| {
            let tx = tx.clone();
            let ch = channel.to_string();
            async move {
                let _ = tx
                    .send(Message::Data {
                        channel: ch.clone().into(),
                        data,
                    })
                    .await;
                let _ = tx
                    .send(Message::Close {
                        channel: ch.into(),
                        problem: None,
                    })
                    .await;
            }
        };

        let raw = options
            .extra
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("/");
        let path = match validate_dir(raw) {
            Ok(p) => p,
            Err(e) => {
                send(json!({ "error": e })).await;
                return;
            }
        };

        if SCANNING.swap(true, Ordering::SeqCst) {
            send(json!({ "error": "another scan is already running on this host" })).await;
            return;
        }
        let _guard = ScanGuard;

        // Spawn: nice -n19 ionice -c3 du -x --block-size=1 --max-depth=1 -- <path>
        let spawn = tokio::process::Command::new("nice")
            .args([
                "-n",
                "19",
                "ionice",
                "-c",
                "3",
                "du",
                "-x",
                "--block-size=1",
                "--max-depth=1",
                "--",
                &path,
            ])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn();
        let mut child = match spawn {
            Ok(c) => c,
            Err(e) => {
                send(json!({ "error": format!("failed to start du: {e}") })).await;
                return;
            }
        };
        let mut stdout = child.stdout.take().expect("piped");

        // Read du's output to completion, but cancel on shutdown/timeout by
        // killing the process (which closes the pipe and ends the read).
        let mut buf = Vec::new();
        let mut aborted = false;
        {
            let read_fut = stdout.read_to_end(&mut buf);
            tokio::pin!(read_fut);
            let timeout = tokio::time::sleep(SCAN_TIMEOUT);
            tokio::pin!(timeout);
            loop {
                tokio::select! {
                    r = &mut read_fut => { let _ = r; break; }
                    _ = &mut timeout => { aborted = true; let _ = child.start_kill(); let _ = (&mut read_fut).await; break; }
                    ch = shutdown.changed() => {
                        if ch.is_err() || *shutdown.borrow() {
                            aborted = true;
                            let _ = child.start_kill();
                            let _ = (&mut read_fut).await;
                            break;
                        }
                    }
                }
            }
        }
        let _ = child.wait().await;

        if aborted {
            // Cancelled/timed out: the panel isn't waiting for results anymore.
            return;
        }

        let result = build_result(&path, &String::from_utf8_lossy(&buf));
        send(result).await;
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        // Streaming handler — open is handled by the router via stream().
        vec![Message::Ready {
            channel: channel.into(),
        }]
    }
}

/// Resolve and validate the requested directory: absolute, existing, a directory.
fn validate_dir(raw: &str) -> Result<String, String> {
    if !raw.starts_with('/') {
        return Err("path must be absolute".into());
    }
    let canon = std::fs::canonicalize(raw).map_err(|_| "path not found".to_string())?;
    let meta = std::fs::metadata(&canon).map_err(|e| e.to_string())?;
    if !meta.is_dir() {
        return Err("not a directory".into());
    }
    Ok(canon.to_string_lossy().into_owned())
}

/// Combine du's subdirectory totals with the directory's own files into one
/// size-sorted list, plus the directory total and its parent.
fn build_result(path: &str, du_output: &str) -> Value {
    let mut entries: Vec<(String, u64, bool)> = Vec::new();
    let mut total: u64 = 0;

    for line in du_output.lines() {
        let Some((size_s, p)) = line.split_once('\t') else {
            continue;
        };
        let size: u64 = size_s.trim().parse().unwrap_or(0);
        if p == path {
            total = size;
            continue;
        }
        // Immediate subdirectory (recursive size).
        let name = p.rsplit('/').next().unwrap_or(p).to_string();
        entries.push((name, size, true));
    }

    // Direct files at this level (non-recursive) — cheap stat via the dir listing.
    let mut files_truncated = false;
    if let Ok(rd) = std::fs::read_dir(path) {
        let mut seen = 0usize;
        for ent in rd.flatten() {
            seen += 1;
            if seen > MAX_DIR_READ {
                files_truncated = true;
                break;
            }
            let Ok(ft) = ent.file_type() else { continue };
            if !ft.is_file() {
                continue; // dirs are covered by du; skip symlinks/specials
            }
            if let Ok(meta) = ent.metadata() {
                // actual on-disk usage (512-byte blocks), consistent with du.
                entries.push((
                    ent.file_name().to_string_lossy().into_owned(),
                    meta.blocks() * 512,
                    false,
                ));
            }
        }
    }

    entries.sort_by_key(|e| std::cmp::Reverse(e.1));
    let truncated_entries = entries.len() > MAX_ENTRIES;
    entries.truncate(MAX_ENTRIES);

    let items: Vec<Value> = entries
        .into_iter()
        .map(|(name, size, is_dir)| json!({ "name": name, "size": size, "is_dir": is_dir }))
        .collect();

    let parent = if path == "/" {
        Value::Null
    } else {
        std::path::Path::new(path)
            .parent()
            .map(|p| Value::String(p.to_string_lossy().into_owned()))
            .unwrap_or(Value::Null)
    };

    json!({
        "path": path,
        "parent": parent,
        "total": total,
        "entries": items,
        "truncated": truncated_entries || files_truncated,
    })
}

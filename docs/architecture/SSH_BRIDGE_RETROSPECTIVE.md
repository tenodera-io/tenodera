# SSH-bridge retrospective

**Purpose.** Tenodera v2 returns to an **SSH transport with a per-user bridge**.
Tenodera already shipped that model once (March–June 2026) and then *deliberately
replaced it* with the outbound reverse-WebSocket agent. Before we rebuild on SSH,
this document records — from the git history — **what the SSH model actually cost**,
so v2 solves those problems by design instead of rediscovering them.

This is not an argument against v2. It is the list of landmines.

## Timeline (from git)

| Date | Commit | Event |
|------|--------|-------|
| 2026-03-25 | `7da6d3b` | **SSH transport introduced** — "Replace agent daemon model with SSH transport (gateway spawns bridge via SSH)". |
| 2026-03-26 | `3c…` (C1) | SSH **host-key verification** replaces TOFU: keyscan + fingerprint confirm; `spawn_remote()` writes the key to a tempfile used as `UserKnownHostsFile` with `StrictHostKeyChecking=yes`, kept alive for the whole session to avoid a race. |
| 2026-03-28 | `3e3bace` | PTY-over-SSH **stream corruption**: raw `fork()` in the async runtime left the bridge's SSH stdin/stdout pipe FDs open in the child (no `CLOEXEC`), corrupting the newline-delimited JSON protocol. Fixed by `Command`+`pre_exec`. |
| 2026-03-28 | `a3e18b1` | **`sudo -S` stdin conflict** on non-root SSH bridges: `sudo -S` consumes the whole stdin buffer, starving `chpasswd`/`tee` of their data. Worked around by base64-embedding content inside `sudo … sh -c`. |
| 2026-06-25 | `91882be` | **sshpass → Ed25519 key auth**: gateway stops storing user passwords; connects with `ssh -i /etc/tenodera/id_ed25519`. Key generated at install and must be distributed to every host. |
| 2026-06-25 | `f77003c`, `ad4c7d9`, `2d79df9` | **Permission juggling** because the bridge runs as the SSH user, not root: `hosts.json`/audit-log writes need `sudo -n tee` + sudoers rules; local bridge must be spawned as the session user for `sudo` semantics to work. |
| 2026-06-26 | `1bb84cf` | **SSH transport abandoned** → reverse WebSocket. Stated reason: *"Eliminates SSH key distribution at scale."* |
| 2026-06-26 | `4fb9866` | Reverse-WS architecture: *"Bridge connects outbound to gateway via WebSocket — **no SSH, no inbound ports**."* |
| 2026-07-01 | `9b03c04`, `05672e4`, `e9be0f9` | Cosmetic rename `bridge → agent`. SSH was already gone; these commits only removed "stale SSH/bridge references". (These are the commits originally cited, but they are *not* where the decision happened.) |

## Why SSH was abandoned — and what v2 must answer

### 1. SSH key distribution at scale (the stated reason)
The gateway authenticated to hosts with a single Ed25519 key that had to be placed
in every managed host's `authorized_keys`. At a handful of hosts this is fine; at
hundreds it is an onboarding and rotation burden, and a single high-value key.

**v2 must decide:** short-lived **SSH certificates** (an SSH CA the server holds,
hosts trust the CA — no per-host key copying, built-in expiry) vs. per-host keys
managed centrally in PostgreSQL. The SSH-CA route is the standard answer and turns
"distribute N keys" into "trust one CA once".

### 2. "No inbound ports on managed hosts" is **lost** in v2 — the biggest trade-off
The outbound-WS model's headline feature (and today's README selling point) is that
managed hosts open **no inbound ports** — they dial out, so they work behind NAT and
strict firewalls. **SSH transport requires inbound `:22` reachable from the server.**

This is not a bug to fix; it is an inherent property of the direction. v2 must
either (a) accept "managed hosts must be SSH-reachable from the control plane" as a
documented requirement (fine for datacenter/VPC fleets, a regression for
edge/NAT/roadwarrior hosts), or (b) keep an **optional outbound reverse-tunnel**
mode for hosts that can't accept inbound SSH. Pick deliberately and write it down.

### 3. The `sudo -S` / `sh -c` problem is intrinsic to "bridge as user", not incidental
The base64-`sh -c` hack we flagged as audit item **A2** was born here (`a3e18b1`):
when the bridge runs as an unprivileged user, `sudo -S` needs stdin for the password,
which collides with piping file content. v2's per-user bridge has the **same
constraint**. The fix is the same regardless of transport: a **dedicated
file-helper** (content on stdin, path/mode as typed arguments, `O_NOFOLLOW`, no
shell). v2 should build that helper from day one so it never reintroduces `sh -c`.
And empirically (tested 2026-07-24): the "password + content on one stdin to
`sudo -S tee`" shortcut **leaks the password into the file** — it is not an option.

### 4. Transport stream fragility
The bridge speaks newline-delimited JSON over the SSH pipe. Any child that inherits
those pipe FDs, or any stray write to stdout, corrupts the stream (`3e3bace`). Over
SSH the framing is a bare byte pipe with no message boundaries. **v2 should not run
the control protocol over the raw SSH stdio pipe.** Prefer a framed channel: a
length-prefixed protocol, or run the bridge as a small server on a **Unix domain
socket** on the host and have SSH only establish the session / port-forward to it.
This also isolates PTY streams from the control channel.

### 5. Host-key verification and its race
`StrictHostKeyChecking=yes` with a per-session `UserKnownHostsFile` tempfile worked
but was fiddly (the tempfile had to outlive the session). v2 centralizes host keys
in PostgreSQL (`ssh_host_keys` with first/last-seen, trusted-by, rotation history)
and requires **explicit admin approval on key change** — a real improvement over
both TOFU and the tempfile dance, *if* the connection manager consults the DB as the
source of truth for `known_hosts`.

### 6. Identity/permission model was already correct — keep it
The SSH era established the pattern v2 keeps: **operator = system user**, bridge runs
**as that user**, `sudo`/PAM/SSSD/HBAC on the host is the authorization boundary.
That part was not the problem and should carry over unchanged.

## What actually improved by leaving SSH (so v2 doesn't lose it silently)
Moving to outbound WS bought three things v2 gives back up:
- **No inbound ports / NAT-friendly** (see §2).
- **One persistent multiplexed connection per host** instead of an SSH process per
  session — simpler lifecycle, cheaper reconnect. v2's SSH connection manager must
  re-solve connection pooling/leasing (the v2 doc's `connection_owner_instance_id` /
  `lease_expires_at` is exactly this).
- **No SSH key material to distribute** (see §1).

## Net guidance for v2
SSH transport is a defensible choice **for a server-reachable fleet** and it removes
the "agent = permanent root daemon" risk, which is the single biggest v0.x security
liability. But it is a **revert of a decision made for real reasons**. v2's design
must give an explicit, written answer to each of:

1. Key distribution → **SSH CA / short-lived certs** (recommended).
2. Inbound `:22` requirement → documented requirement, with an optional
   reverse-tunnel escape hatch for NAT'd hosts.
3. `sudo`+content → **dedicated file-helper**, never `sh -c`, never password-on-shared-stdin.
4. Protocol framing → **framed channel over a Unix socket**, not the raw SSH pipe.
5. Host-key trust → PostgreSQL as source of truth + approval on change.
6. Connection lifecycle → per-instance lease/heartbeat in PostgreSQL.

These become the acceptance criteria for **ADR-0001 (SSH/bridge transport)**.

> **ARCHIVED — historical v0.x document (2026-07-23).** Preserved for reference; not maintained. Superseded by the Tenodera v2 rebuild — see `docs/architecture/TENODERA_V2.md`.

---

# Security Audit Triage — ANALISE.md verified against v0.4.1

External AI produced `ANALISE.md` (deep static review, self-reported base **v0.2.13**).
This file records the **verification of every HIGH finding against the current code (v0.4.1)**,
done 2026-07-23 by reading the actual source — real vs. already-fixed vs. lower-priority.

Legend: 🔴 confirmed real & open · 🟢 already addressed · 🟡 valid hardening (lower priority)

---

## ✅ Progress (branch `harden/security-audit`)

**Done + verified on .10/.11:** HIGH-01/02/03 (authz + `Auth`/`AdminAuth` extractors +
audit log + name cap), session `get_valid` + id redaction, HIGH-04 (WS log redaction,
gw + frontend), HIGH-05 (no plaintext su pw), HIGH-06 (installers build latest tag +
`pacman -Syu` + HSTS guidance), P1 WS frame caps + duplicate-channel reject, P1/P2
reconnect jitter (agent + frontend).

**Remaining (next round — larger/riskier):** agent `util.rs` process timeouts + bounded
output + `env_clear`/PATH; `sudo sh -c` → dedicated file helper; per-IP pending limits;
token digest-at-rest; `ChannelId` `TryFrom`; len-prefix `try_from`; typed payloads;
generic login errors; trusted-proxy config for Origin/XFF.

---

## 🔴 P0 — confirmed real & open (block public exposure)

| # | Finding | Evidence (verified) | Fix |
|---|---------|---------------------|-----|
| **HIGH-01** | `GET /api/hosts` has **no authentication** — leaks host inventory (names, hostnames, IPs, os_id, online state) to any unauthenticated client. | `panel/crates/gateway/src/main.rs:732` `hosts_list` takes `headers` (added for the IP fix) but never checks a session or role. | Require a valid session; consider returning `remote_ip` only to admins. |
| **HIGH-02** | **Readonly user can DELETE hosts** — only checks that a session exists, not the role. | `main.rs:772-783` `hosts_remove`: `extract_bearer_token` + `sessions.get(...).is_none()` → then `config.hosts.retain(...)` + `save`. No `require_admin`. | Gate with `require_admin`; distinguish 401 (no session) vs 403 (wrong role); audit-log the removal (user, host_id, client IP, result, ts). |
| **HIGH-03** | **Readonly user can rename hosts**; no length cap on `display_name`. | `main.rs:809-831` `hosts_patch`: same session-only check; sets `host.display_name` unbounded. | `require_admin` + `MAX_DISPLAY_NAME_LEN` (e.g. 128) → 400 on overflow. |
| **HIGH-04** | **Raw WebSocket payloads are logged** — may contain sudo password, file contents, terminal output, tokens. | `panel/crates/gateway/src/ws.rs:71` `raw=%json`, `:225` `raw=%text` (TRACE), `:353` `raw=%text` (WARN on invalid JSON). | Log metadata only (direction, channel, byte count, message kind). Never `raw=`. |
| **HIGH-05** | **Sudo password stored plaintext** in `sessionStorage['su_plain']` on a non-secure context; the in-file comment wrongly calls it acceptable. | `panel/ui/src/api/secureStorage.ts:94-98` `saveSuperuserPassword` → `sessionStorage.setItem(PLAIN_KEY, password)`; read at `:126`. | Return `false` on non-secure context (don't persist) or keep the password in-memory only with a short TTL. |
| **HIGH-06** | Source installer builds the **mutable `main`** tarball with no checksum/signature/commit pin. | `tenodera.sh` → `TARBALL_URL=".../archive/refs/heads/${BRANCH}.tar.gz"` then `curl -sSfL | tar xz`. | **Applies to the curl/source installer only** — the `.deb`/`.rpm` path already ships minisign-signed `SHA256SUMS`. Pin a tag/commit and verify, or steer users to packages. |

**Note:** `require_admin()` already exists (`main.rs:642`) and is used for the token /
pending endpoints (`main.rs:482, 497, 513`). HIGH-01/02/03 are simply spots where it (or a
session check) was omitted — the fix matches the existing pattern and is small.

---

## 🟢 Already addressed by our v0.3.x–0.4.x work

- **Loopback bind default + Caddy HTTPS proxy** — the audit's headline "can't expose to the
  internet on plain HTTP" default is already the shipped default.
- **WS token via first auth-frame, not query string** — audit confirms UI does this; the old
  `?session_id=` docs were the drift, now corrected.
- **Doc drift on bind/TLS** — updated across README / DOCS / THREAT_MODEL / SECURITY and the
  website.
- **§6.4 — spoof `X-Forwarded-For: 127.0.0.1` → loopback auto-enroll:** **neutralized.** The
  `primary_ip()` override in `agent_ws.rs:49-54` replaces any loopback result (incl. a spoofed
  leftmost XFF) with the panel's own primary IP, so the auto-enroll check
  (`matches!(remote_ip, "127.0.0.1" | "::1")`, `agent_ws.rs:442`) does not fire for a proxied
  remote client.
  - ⚠️ **Open runtime puzzle:** by the same logic the *legitimate* local loopback agent should
    also be relabelled to the primary IP and fall through to pending — yet the journal shows it
    still auto-enrolls. Resolve this with a **live test** before changing the IP/enroll logic
    (risk of breaking local auto-enroll or re-opening the spoof).

---

## 🟡 P1 / P2 — valid hardening, lower priority

- `sudo sh -c` for file writes broadens the required sudo grant → dedicated `tenodera-file-helper`
  (allowlisted ops, `O_NOFOLLOW`, reject `..`, size limit, no shell). *(agent `util.rs`)*
- No timeouts / unbounded `wait_with_output()` on spawned commands → add `tokio::time::timeout`,
  process-group kill (SIGTERM→SIGKILL), and a bounded output reader (`MAX_OUTPUT`).
- WebSocket frame/message caps not set → `WebSocketUpgrade::max_frame_size` / `max_message_size`.
- Duplicate `ChannelId` on `Open` should be rejected (close `duplicate-channel-id`), not overwrite.
- Streaming channels: store the `JoinHandle` (not just a shutdown signal) and abort on close.
- Reconnect **jitter** — agent (`main.rs` backoff) and frontend (`transport.ts`).
- Bootstrap tokens stored plaintext in memory → store a keyed digest (blake3/HMAC), `subtle` for
  constant-time compare.
- Per-IP / per-subnet **pending limits** + shorter pending TTL + handshake rate-limit.
- `ChannelId: From<String>/From<&str>` rely on `debug_assert!` (no-op in release) → `TryFrom` +
  `new_unchecked` for internal use. *(protocol/src/channel.rs)*
- Length-prefix conversions `len() as u16` can truncate → `u16::try_from(...)`. *(protocol/src/auth.rs)*
- Generic login errors (don't reveal account-exists/locked). *(auth.rs)*
- `session get` should validate expiry inline (`get_valid`) rather than rely on the reaper window.
- Redact session id in `Session` `Debug` / logout / error paths.
- Installer: `pacman -Sy` → `-Syu` (partial-upgrade hazard on Arch/CachyOS); pin/validate Caddy
  version, back up + `caddy validate` before reload.
- Add `Strict-Transport-Security` (HSTS) in the generated Caddyfile.
- Central authz: Axum `Authenticated` / `Admin` extractors so a handler *can't* forget the check.

---

## Recommended fix order

1. **P0 batch** (small, no regression risk, matches existing `require_admin` pattern):
   `fix/api-authz` (HIGH-01/02/03 + control-plane audit log), `fix/log-redaction` (HIGH-04),
   `fix/no-plaintext-su-pw` (HIGH-05). HIGH-06: pin/verify or point to packages.
2. Then P1 (agent hardening: sudo helper, timeouts/output caps, WS frame caps, channel lifecycle).
3. P2 as ongoing quality (typed payloads, per-handler role/risk policy, jitter, token hashing).

Deploy-before-commit on .10/.11 as usual; the audit's §13 test snippets (401 on `/api/hosts`,
403 on readonly DELETE/PATCH, TRACE secret-leak grep, `su_plain` null check) make good
regression checks.

# ADR-0005 — Typed operation protocol & root-owned operation helper

- **Status:** Accepted (direction). Operation taxonomy & wire encoding are iterative.
- **Date:** 2026-07-24
- **Depends on:** [ADR-0004](0004-identity-and-credential-model.md) (helper-only
  `NOPASSWD`, step-up, argument-hash grants), [ADR-0001](0001-ssh-bridge-transport.md)
  (transport; this ADR resolves its open question #3).

## Context

ADR-0004 decided that privileged actions run through **one narrow, root-owned helper**
invoked via a single `NOPASSWD` rule, and that the helper executes **typed, validated
operations — never a shell, never a wildcard**. This ADR defines what that means: the
protocol, the helper contract, and how the control channel is framed over SSH.

The v0.x lessons this must not repeat (all concrete):
- **`sh -c` / injection** (audit A2, born `a3e18b1`) — arbitrary shell as the write path.
- **Missing/forgotten authz checks** (`hosts_list` had none; fixed with request
  extractors) — per-handler ad-hoc checks are error-prone.
- **Loose `serde_json::Value` everywhere** — validation scattered across handlers.
- **Control stream corruption** (`3e3bace`) — the protocol shared the SSH stdio pipe
  with PTY children that leaked FDs (no `CLOEXEC`), corrupting the JSON stream.

## Decision

### 1. Every privileged action is a typed operation — no shell, ever
A request names an **operation** and carries **structured arguments**:

```json
{ "v": 1, "request_id": "<uuid>", "actor": "<local-principal>",
  "op": "service.restart", "args": { "unit": "nginx.service" } }
```

The helper matches `op` to a handler that **validates `args` against a schema** and
**constructs the concrete command as an argv vector** it itself owns
(`["/usr/bin/systemctl","restart","nginx.service"]`) — never a shell string, never
interpolation. **No `op` maps to "run an arbitrary command."** Unknown `op` → denied.

### 2. Two boundaries, the helper re-validates
- **server ↔ bridge** — over SSH, the bridge running as the operator (ADR-0001/0003).
- **bridge ↔ op-helper** — local, via the single `NOPASSWD` sudo rule (ADR-0004).

The same typed operation crosses both. The **helper re-validates independently** — it
never trusts that the bridge validated anything. The helper is the last line and
assumes hostile input.

### 3. Declarative per-operation policy, enforced by the framework (not each handler)
Each operation declares, as data:

| Field | Purpose |
|-------|---------|
| `required_permission` | Tenodera RBAC gate (forthcoming ADR) |
| `risk` | `readonly` \| `mutating` \| `high_risk` |
| `args_schema` | typed schema + length/size bounds |
| `timeout`, `max_output_bytes` | reuse the v0.x agent-exec caps (900 s / 4 MiB, configurable) |
| `requires_stepup` | true for high-risk (ADR-0004 step-up + fresh MFA) |
| `run_as` | target user for the privileged action |

The **router enforces** role/risk/step-up/limits **before dispatch** — a handler
cannot forget the check (the v0.x `Auth`/`AdminAuth`-extractor lesson, made structural).

### 4. Control-channel framing — a dedicated, framed channel, PTY separate
Resolves **ADR-0001 Q#3**. The root cause of `3e3bace` was two things at once:
sharing the SSH **stdio pipe** between control and PTY, **and** children inheriting
FDs without `CLOEXEC`. v2 fixes both, structurally:

- The control protocol runs on a **dedicated framed channel**, isolated from PTY.
  Preferred mechanism: an **SSH subsystem** (`Subsystem tenodera /usr/lib/tenodera/bridge`)
  — like `sftp`, sshd gives the bridge its own channel per connection; a PTY is a
  **separate SSH channel** by construction. (Alternative: the bridge as a persistent
  **Unix-socket** server reached via streamlocal forwarding — confirmed available on
  the target OS. More isolated but adds socket-file lifecycle; evaluate in Phase 1.)
- **All spawned children get `CLOEXEC` on non-stdio FDs** (std `Command` + `pre_exec`
  does this — the v0.x fix). No child ever inherits the control channel.
- **Framing:** 4-byte big-endian length prefix + body, with a max frame size (reuse
  the WS caps: 1 MiB frame / 4 MiB message). No reliance on newline delimiting.

### 5. Argument hash for grants
The canonical **argument hash** bound into a high-risk grant (ADR-0004) is
`SHA-256` over a **canonical serialization of `(op, args)`** (args key-sorted,
canonical JSON/CBOR). A grant authorizes exactly that `(user, host, op, args-hash)` —
replay with different args fails.

### 6. Versioning
A `v` field; server and helper negotiate and reject unknown versions. Deny-by-default
for unknown `op` and out-of-range `v`.

## Rejected alternatives

- **Shell command as payload** — exactly the `sh -c` hole being eliminated. Rejected.
- **Untyped `serde_json::Value` passthrough** (v0.x style) — validation scattered,
  easy to miss. Rejected for typed per-op schemas.
- **Control protocol on the raw SSH stdio pipe** shared with PTY (v0.x `3e3bace`).
  Rejected for a dedicated framed channel + strict `CLOEXEC`.
- **Per-handler ad-hoc authz** (v0.x `hosts_list` bug). Rejected for framework-enforced
  declarative policy.

## Consequences

- The **helper's operation set is the privilege surface** — reviewed as carefully as
  sudoers once was. Adding an `op` = granting a new privileged capability; each needs
  a schema, risk class, limits and tests.
- More upfront typing than v0.x's loose `Value`, but it removes whole bug classes
  (injection, missing-check, unbounded output) by construction.
- The **bridge becomes thin** (auth context, framing, forwarding to the helper);
  privilege logic lives in the helper.
- **Reuses v0.x assets:** the 37 handlers' command-construction *logic* ports into
  typed helper handlers; the agent-exec limits (timeout / output cap / `env_clear` /
  fixed PATH) apply to the helper's spawns unchanged.

## Open questions

1. **Wire encoding:** JSON (debuggable, ship first) vs CBOR (compact, stricter).
2. **Operation taxonomy & schemas** — iterative; start with `service.*` for the
   Phase-2 vertical slice (`service.status` → `service.restart`), then port subsystems
   one at a time.
3. **Subsystem vs Unix-socket** for the control channel — validate both on a real
   bridge in Phase 1 (the streamlocal spike was deferred; subsystem is the current
   front-runner for simplicity).
4. **Bridge invocation** — `Subsystem` entry vs `ForceCommand` vs socket-activated
   server (deployment detail).

## Acceptance criteria

- No operation can cause a shell to run; `grep -r "sh -c\|Shell::"` over the helper is
  empty; every command is an argv vector built by the handler.
- An unknown `op`, an out-of-schema argument, an oversized argument, and an oversized
  output are each rejected with a distinct typed error.
- Opening a PTY and running control operations on the same SSH connection do **not**
  interfere (framed channel isolation) — the `3e3bace` regression test.
- A high-risk `op` without a valid step-up grant is refused; a grant is rejected when
  replayed with different arguments (argument-hash bound).
- The helper re-validates every request independently of the bridge (tested by
  feeding the helper a malformed request directly).
- Role/risk/limits are enforced by the router, provable by a handler that omits its
  own check still being gated.

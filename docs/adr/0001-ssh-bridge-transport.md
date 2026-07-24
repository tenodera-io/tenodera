# ADR-0001 — Host transport: SSH + per-user bridge

- **Status:** Accepted (direction). Sub-decisions marked *Open* below.
- **Date:** 2026-07-24
- **Context source:** [`../architecture/TENODERA_V2.md`](../architecture/TENODERA_V2.md),
  [`../architecture/SSH_BRIDGE_RETROSPECTIVE.md`](../architecture/SSH_BRIDGE_RETROSPECTIVE.md)
- **Supersedes:** the v0.x outbound reverse-WebSocket root agent.

## Context

v0.x runs a **persistent `tenodera-agent` daemon as root** on every managed host,
connected outbound to the gateway over WebSocket. This is the single largest
security liability: any memory-safety, parser, protocol, or handler bug in that
process is a direct path to root on the host, and no `sudoers`/HBAC boundary
applies to the agent itself (it is already root).

v2's primary goals are (1) a simpler, more understandable model, (2) top-tier
security, (3) a sellable B2B product. Removing the always-on root daemon serves
(1) and (2) more than any sandboxing of it could.

## Decision

Access managed hosts over **SSH**, executing a **`tenodera-bridge`** that runs **as
the operator's own system user** (not root). Privileged operations escalate through
that user's `sudo`/`polkit`, so the host's `sudoers`/PAM/SSSD/FreeIPA/HBAC remains
the authorization boundary — the same identity model as v0.x, minus the root daemon.

The Tenodera **server** (unprivileged) owns SSH connections; PostgreSQL is the source
of truth for hosts, host keys and connection leases (see ADR-0002).

```
server (no root) --SSH--> sshd --> tenodera-bridge (as user) --> sudo/polkit --> host
```

## Rejected alternatives

- **Keep the outbound root agent, add privilege separation** (unprivileged netd +
  root broker). Real improvement, but keeps a permanent root process on every host
  and is a large build; does not simplify. Rejected in favour of removing the root
  daemon outright.
- **Keep the outbound root agent, add systemd sandboxing only.** Sandbox directives
  are inherited by the broker's children (package managers, PTY, mount…), so a
  general admin broker can't be meaningfully confined. Not a substitute for
  privilege separation. Rejected.
- **Custom outbound transport (WS/gRPC) with a per-user, non-root remote process.**
  Re-implements what SSH already provides (auth, host identity, channels, PTY) with
  more code and a bespoke security surface. Rejected; SSH is the boring, auditable
  choice.

## Consequences

**Positive**
- No permanent root process on managed hosts; RCE in the server's protocol/TLS stack
  no longer equals root on every host.
- Reuses SSH's mature auth, host-key model, channels and PTY.
- Operator-identity + host-`sudo` boundary preserved unchanged.

**Negative / costs (all seen in the v0.x SSH era — see retrospective)**
- **Managed hosts must be reachable inbound on SSH (`:22`).** This *removes* v0.x's
  "no inbound ports / NAT-friendly" property — a headline feature today. Acceptable
  for datacenter/VPC fleets; a regression for edge/NAT/roadwarrior hosts.
- **Key distribution.** Naïve per-host `authorized_keys` does not scale and was the
  explicit reason SSH was dropped in v0.x.
- **`sudo` + file content on stdin** collides (`sudo -S` eats stdin). The base64-`sh
  -c` hack must **not** return; and "password+content on one stdin to `sudo -S tee`"
  leaks the password into the file (verified 2026-07-24) — forbidden.
- **Protocol framing** over a raw SSH pipe is fragile (a stray child FD corrupts the
  stream — `3e3bace`).
- Connection lifecycle (pooling, per-instance ownership) must be managed explicitly.

## Open questions (must be resolved before Phase 2 code)

1. **Key model:** SSH **certificate authority** with short-lived host+user certs
   (recommended — trust one CA, no per-host key copying, built-in expiry) vs. central
   per-host keys in PostgreSQL.
2. **Inbound `:22`:** accept as a documented requirement, and/or provide an optional
   **reverse-tunnel** mode for hosts that cannot accept inbound SSH.
3. **Bridge channel:** run the control protocol as a **length-framed** channel, ideally
   the bridge listening on a **Unix domain socket** reached via SSH, keeping PTY and
   control streams separate — rather than newline-JSON over the raw SSH stdio pipe.
4. **Privileged writes:** ship a **dedicated file-helper** (content on stdin;
   path/mode as typed args; `O_NOFOLLOW`; reject `..`; size cap; no shell) as the
   canonical write path from day one.

## Risks

- Re-discovering the exact v0.x SSH pains if the open questions are not answered
  up front. Mitigation: this ADR + the retrospective are gating for Phase 2.
- Loss of NAT-friendliness reduces the addressable market unless the reverse-tunnel
  escape hatch exists. Mitigation: decide (2) explicitly with product input.
- SSH-CA introduces a new high-value secret (the CA key). Mitigation: envelope
  encryption / external KMS-TPM for the CA key (see ADR-0002 secrets section).

## Acceptance criteria (definition of done for the transport layer)

- A host can be enrolled with **no manual per-host key copy** (CA path) OR with a
  clearly documented key-provisioning step.
- Opening a session, running `service.status`, and a PTY on the same host do **not**
  interfere on the wire (framed channels; PTY isolated).
- A privileged file write uses the file-helper; `grep -r "sh -c"` over the bridge is
  empty; no secret ever reaches a written file or a log.
- Host-key change is **refused** until an admin approves it, with the decision
  recorded in PostgreSQL.
- Killing a server instance mid-session releases its connection lease; another
  instance can take over queued work (see ADR-0002).
- Negative tests: unreachable host, wrong host key, expired cert, `sudo` denied,
  oversized output, timed-out command — each returns a distinct, typed error.

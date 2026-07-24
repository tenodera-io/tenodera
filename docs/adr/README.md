# Architecture Decision Records

Each ADR captures one architectural decision: its context, the decision, the
alternatives rejected, the consequences, the risks, and the acceptance criteria
that tell us it's done. ADRs are append-only — supersede, don't rewrite.

| # | Title | Status |
|---|-------|--------|
| [0001](0001-ssh-bridge-transport.md) | Host transport: SSH + per-user bridge | Accepted (direction) |
| [0002](0002-postgresql-control-plane.md) | PostgreSQL as the durable control plane | Accepted (direction) |

Background:
[TENODERA_V2.md](../architecture/TENODERA_V2.md) (target architecture) ·
[SSH_BRIDGE_RETROSPECTIVE.md](../architecture/SSH_BRIDGE_RETROSPECTIVE.md) (why the
previous SSH bridge was abandoned and what v2 must answer).

Planned next ADRs (not yet written): user identity & credential model · granular
RBAC · host enrollment & host-key lifecycle · typed operation protocol · audit &
event storage.

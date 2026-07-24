# Architecture Decision Records

Each ADR captures one architectural decision: its context, the decision, the
alternatives rejected, the consequences, the risks, and the acceptance criteria
that tell us it's done. ADRs are append-only — supersede, don't rewrite.

| # | Title | Status |
|---|-------|--------|
| [0001](0001-ssh-bridge-transport.md) | Host transport: SSH + per-user bridge | Accepted (direction) |
| [0002](0002-postgresql-control-plane.md) | PostgreSQL as the durable control plane | Accepted (direction) |
| [0003](0003-host-enrollment-ssh-ca.md) | Host enrollment & SSH certificate authority | Accepted — transport spike-validated |
| [0004](0004-identity-and-credential-model.md) | User identity & credential model | Accepted |
| [0005](0005-typed-operation-protocol.md) | Typed operation protocol & root-owned helper | Accepted (direction) |
| [0006](0006-rbac.md) | Role-based access control (RBAC) | Accepted (direction) |
| [0007](0007-audit-event-storage.md) | Audit & event storage (hash-chain) | Accepted (direction) |

Background:
[TENODERA_V2.md](../architecture/TENODERA_V2.md) (target architecture) ·
[SSH_BRIDGE_RETROSPECTIVE.md](../architecture/SSH_BRIDGE_RETROSPECTIVE.md) (why the
previous SSH bridge was abandoned and what v2 must answer).

The foundation ADR set (0001–0007) is complete. Further ADRs will be written per
subsystem as Phase-2 code lands (e.g. inventory model, terminal/PTY subsystem).

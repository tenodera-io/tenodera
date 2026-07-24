# Tenodera v2

The v2 rebuild lives here, **isolated from the v0.x product** (`../agent`, `../panel`,
`../protocol`) which stays shipping until v2 reaches release candidate. v0.x code is
removed **subsystem by subsystem, only once its v2 replacement works and is tested** —
never up front.

Architecture and decisions: [`../docs/architecture/TENODERA_V2.md`](../docs/architecture/TENODERA_V2.md)
and the ADRs in [`../docs/adr/`](../docs/adr/) (0001–0007).

## Planned layout

```
v2/
├── migrations/          # sqlx migrations — PostgreSQL control-plane schema
│   └── 0001_core.sql    # minimal ~16-table core (Phase 1) — DONE
└── crates/              # (next) Rust workspace
    ├── server/          #   unprivileged control plane: API, auth, sessions, RBAC,
    │                    #   SSH connection manager, job queue, audit  (no root)
    ├── bridge/          #   runs as the operator on the host over SSH; framing
    ├── op-helper/       #   root; executes TYPED operations (no shell, no wildcard)
    └── protocol/        #   shared typed operation protocol + types
```

## Build order (from TENODERA_V2 "Kolejność budowy")

- **Phase 1 — data foundation:** PostgreSQL + migrations + users/identities +
  sessions + hosts/host-keys + RBAC + audit. ← *schema landed (`0001_core.sql`)*
- **Phase 2 — first vertical slice:** login → pick host → permission check → SSH →
  bridge → `service.status` → job → result → audit.
- **Phase 3 — mutation:** `service.restart` end to end (authorize → queue → run →
  result → audit).
- **Phase 4 — subsystems:** systemd, journal, processes, packages, files, users,
  network, storage, terminal (port the v0.x handlers' command-construction logic).
- **Phase 5 — production:** upgrade/rollback, backup/restore, retention, metrics,
  rate limiting, load test, security review, pentest.

## Status

Phase 1 in progress — schema first (no build yet). Next: Rust workspace skeleton +
sqlx wiring + a PostgreSQL test instance on a VM.

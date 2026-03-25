# AGENTS.md — Tenodera Admin Panel

## Project Overview

Multi-component Linux server management panel:

| Component | Language | Framework | Location |
|-----------|----------|-----------|----------|
| **Panel Gateway** | Rust (edition 2024) | Axum 0.8 + Tokio | `panel/crates/gateway/` |
| **Bridge** | Rust (edition 2024) | Tokio + nix/libc | `bridge/` (standalone) |
| **Protocol (shared)** | Rust (edition 2024) | serde | `protocol/` (shared) |
| **UI** | TypeScript + React 19 | Vite 6, React Router 7 | `panel/ui/` |

### Architecture

Remote host management uses SSH transport — the gateway spawns
`tenodera-bridge` on remote hosts via SSH (stdin/stdout JSON protocol).
No daemon or open port is required on managed hosts, only the
`tenodera-bridge` binary and SSH access for FreeIPA users.

### Repository Structure

```
panel/              — Gateway + UI (Rust workspace + Vite)
  crates/gateway/   — Axum HTTP/WS gateway, PAM auth, SSH transport
  ui/               — React frontend
  Makefile          — Build/install gateway + UI
bridge/             — Standalone bridge binary (independent Cargo project)
  Makefile          — Build/install bridge on managed hosts
protocol/           — Shared protocol crate (path dependency for both)
```

Bridge and Panel are **independent Cargo projects** — each can be built
separately. Both depend on `protocol/` via `path` dependency.
This allows deploying bridge to hundreds of hosts without pulling the
entire panel codebase.

## Build & Run Commands

### Frontend (UI)
```bash
# Working directory: panel/ui/
npm ci                  # Install dependencies (use ci, not install)
npm run dev             # Dev server on :3000, proxies /api to :9090
npm run build           # Type-check (tsc -b) then bundle (vite build)
```

### Backend (Rust — Panel)
```bash
# Working directory: panel/
cargo build                              # Debug build (gateway only)
cargo build -p tenodera-gateway          # Build only gateway
cargo check                              # Type-check without compiling
cargo clippy                             # Lint (use defaults, no config files)
```

### Backend (Rust — Bridge)
```bash
# Working directory: bridge/
cargo build                              # Debug build
cargo build --release                    # Release build
cargo check                              # Type-check without compiling
cargo clippy                             # Lint
```

### Full Build via Make
```bash
# Panel (gateway + UI):
cd panel
make deps             # Install Rust + Node.js + system libs
make build            # backend + frontend
make build-backend    # Backend only (cargo build --release)
make build-frontend   # Frontend only (npm ci && npm run build)
make clean            # Remove build artifacts

# Bridge (standalone):
cd bridge
make deps             # Install Rust + system libs
make build            # cargo build --release
make install          # Install bridge binary to /usr/local/bin
make clean            # Remove build artifacts
```

### Tests
No test framework is configured yet. If adding tests:
- Frontend: add vitest (aligns with Vite)
- Backend: use standard `cargo test` with `#[cfg(test)]` modules

### Environment Variables (Runtime)
- `TENODERA_BIND_ADDR` / `TENODERA_BIND_PORT` — listen address/port
- `TENODERA_BRIDGE_BIN` — path to bridge binary
- `TENODERA_UI_DIR` — path to built UI assets
- `TENODERA_TLS_CERT` / `TENODERA_TLS_KEY` — TLS paths
- `TENODERA_ALLOW_UNENCRYPTED` — allow HTTP (default: false)
- `RUST_LOG` — tracing log filter (e.g., `info`, `debug`)

## Code Style — TypeScript / React

### Formatting
- **2-space indentation**, no tabs. **Semicolons**: always.
- **Quotes**: single for JS/TS strings, double for JSX attributes.
- No eslint or prettier config; follow existing patterns.

### Imports
Order (no blank lines between groups):
1. React hooks (`import { useState } from 'react'`)
2. Third-party (`react-router-dom`, `recharts`, `@tanstack/react-query`)
3. Local modules (`'../api/transport.ts'`, `'./pages/Login.tsx'`)
4. CSS (`'./index.css'`)

Always include explicit file extensions: `.ts`, `.tsx`. Use `import type` for type-only imports.

### Components & Functions
- **All components**: named `function` declarations, never arrow or `const`
- **All exports**: named exports only — no default exports anywhere
- **Event handlers** inside components: `const handler = () => { }` (arrow)
- **Helper/utility functions**: named `function` declarations

```tsx
export function Dashboard() { ... }           // Correct
function formatBytes(bytes: number): string {} // Correct
const handleClick = () => { ... };             // Correct (handler)
export default function Dashboard() { ... }    // WRONG
```

### Types
- **`interface`** for object shapes and component props
- **`type`** for unions, aliases, and simple types
- **Inline types** for small, single-use sub-component props

### Naming Conventions
- **PascalCase**: components, interfaces, types (`Dashboard`, `SystemInfo`, `Tab`)
- **camelCase**: functions, variables, hooks (`handleLogin`, `sessionId`, `useTransport`)
- **UPPER_SNAKE_CASE**: constants (`HISTORY_LEN`, `COLORS`, `API_BASE`)
- **snake_case**: JSON field names matching Rust backend (`uptime_secs`, `cpu_pct`)
- **Prefixed underscore**: intentionally unused params (`_sessionId`, `_data`)

### State & Styling
- `useState`, `useRef`, `useCallback`, `useMemo` + `createContext`/`useContext`
- `sessionStorage` for persistence. No Redux/Zustand. WebSocket is primary data transport.
- **Inline styles** via `Record<string, React.CSSProperties>` objects
- CSS variables in `index.css` (`--bg-primary`, `--text-secondary`, etc.)
- Tokyo Night palette: `#7aa2f7`, `#f7768e`, `#9ece6a`, `#e0af68`

### Error Handling
- `try/catch` with `err instanceof Error` guard for user-facing messages
- `.catch(() => ({}))` for fire-and-forget or fallback parsing
- Error state via dismissible UI banners. `@/*` path alias maps to `src/*`.

## Code Style — Rust

### Formatting & Linting
No `rustfmt.toml` or `clippy.toml` — use default `cargo fmt` and `cargo clippy`.

### Imports
Three groups separated by blank lines:
1. `std` library  2. External crates  3. Internal modules (`crate::...`)
```rust
use std::sync::Arc;

use axum::extract::{State, WebSocketUpgrade};
use tokio::sync::mpsc;

use crate::protocol::message;
```

### Error Handling
1. **`anyhow::Result`** for application-level (main, config loading)
2. **`thiserror::Error`** for protocol-level typed errors
3. **`serde_json::json!({ "error": ... })`** for handler responses to frontend

Graceful degradation: `.ok()` / `.unwrap_or_default()` — avoid `.unwrap()`.

### Async Patterns
- Tokio runtime (`#[tokio::main]`), `async_trait` for async trait methods
- `tokio::spawn` for background tasks, `tokio::select!` for concurrent waiting
- `mpsc` channels for handler-to-WS communication, `watch` for shutdown
- `tokio::process::Command` for async subprocess execution

### Naming Conventions
- **snake_case**: functions, variables, modules (`get_hostname`, `bind_addr`)
- **PascalCase**: types, structs, enums, enum variants (`AgentConfig`, `Message`)
- **Prefixed underscore**: unused params (`_state`, `_options`)

### Logging
`tracing` crate with structured fields — not `log`:
```rust
tracing::info!(addr = %config.bind_addr, "listening");
tracing::error!(error = %e, "channel closed");
```
Log level controlled by `RUST_LOG` via `tracing_subscriber::EnvFilter`.

### Serialization
- `serde` with `Serialize`/`Deserialize` derives
- Tagged enums: `#[serde(tag = "type", rename_all = "lowercase")]`
- `serde_json::Value` for dynamic channel data, `json!` macro for responses
- TOML deserialization for config (`toml::from_str`)

### Module Organization & Comments
- Flat `mod` declarations in `main.rs`; sub-modules use `mod.rs` barrel files
- Most modules are private (`mod`); items within are `pub` individually
- `///` doc comments on public items; `//` for inline; `// ----` section dividers

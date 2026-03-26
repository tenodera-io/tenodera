# tenodera-ui

React frontend for the Tenodera administration panel.
Communicates with the gateway via WebSocket using the channel protocol.

## Tech Stack

| Technology | Version | Role |
|------------|---------|------|
| React | 19 | UI framework |
| TypeScript | 5.7 | Type safety |
| Vite | 6 | Bundler + dev server |
| React Router | 7 | SPA routing |
| @tanstack/react-query | 5 | Async state management |
| Recharts | 2.15 | Charts (Dashboard, Storage, Networking) |
| @xterm/xterm | 5.5 | Terminal emulator |
| @xterm/addon-fit | 0.10 | Terminal auto-resize |

## Architecture

### Transport Layer (`src/api/`)

**`transport.ts`** -- Singleton WebSocket with channel multiplexing:

- `connect()` -- establishes WS to `/api/ws?session_id=...`
- `openChannel(payload, options)` -- opens a channel, returns handle with
  `onMessage()`, `send()`, `close()`
- `request(payload, options)` -- one-shot: opens channel, collects data,
  resolves on close

**`auth.ts`** -- Login client (`POST /api/auth/login`)

**`HostTransportContext.tsx`** -- React context for transparent multi-host
routing. When a `hostId` is set, all channel opens include
`{ host: hostId }` so the gateway routes to the remote bridge.

### Pages (`src/pages/`)

| Page | Channel Payload | Description |
|------|----------------|-------------|
| `Dashboard.tsx` | `system.info`, `metrics.stream` | System overview + real-time charts |
| `Services.tsx` | `systemd.manage` | systemd service management |
| `Users.tsx` | `users.manage` | User/group CRUD, lock/unlock, passwords |
| `Containers.tsx` | `container.manage` | Docker/Podman management |
| `Storage.tsx` | `storage.stream`, `disk.usage` | Block devices + I/O charts |
| `Networking.tsx` | `networking.stream`, `networking.manage` | Interfaces, firewall, traffic |
| `Packages.tsx` | `packages.manage` | Package management (apt/dnf/pacman) |
| `Logs.tsx` | `journal.query` | journald log viewer |
| `LogFiles.tsx` | `log.files` | `/var/log` file browser + search |
| `Terminal.tsx` | `terminal.pty` | Full terminal (xterm.js) |
| `Files.tsx` | `file.list` | Remote file browser |
| `Hosts.tsx` | `hosts.manage` | Remote host CRUD |
| `Kdump.tsx` | `kdump.info` | Kernel dump status + crash browser |
| `Login.tsx` | -- | Login form |
| `Shell.tsx` | -- | Main layout with sidebar navigation |

### Session Management

- `session_id` and `user` stored in `sessionStorage`
- WebSocket connects with `session_id` as query parameter
- On WS close or missing session: redirect to `/login`

## Development

```bash
npm ci              # install dependencies
npm run dev         # dev server on :3000 with HMR (proxies /api to :9090)
npm run build       # production build (tsc + vite build)
```

The Vite dev server proxies `/api` requests (including WebSocket) to
`http://127.0.0.1:9090`.

## File Structure

```
ui/
  index.html          HTML entry point
  vite.config.ts      Vite config + proxy
  tsconfig.json       TypeScript config
  public/             Static assets (logo, icon)
  src/
    main.tsx          React root
    App.tsx           Router
    index.css         Global styles (Tokyo Night palette)
    api/
      transport.ts    Channel WebSocket transport
      auth.ts         Login client
      HostTransportContext.tsx
    pages/
      Dashboard.tsx, Services.tsx, Users.tsx, Containers.tsx, ...
```

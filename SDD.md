# Software Design Document (SDD): AI Karaoke App

This document defines the technical architecture, directory structure, and deployment strategy for the AI Karaoke Web App. 

## Quick Path

1. **Monorepo**: Backend (Go) and Frontend (React/Vite) live in the same repository.
2. **Single Executable**: Go's `embed` package will bundle the compiled React app. In production, we deploy exactly one binary file to the VPS.
3. **Screaming Architecture**: The Go codebase uses a Hexagonal (Clean) Architecture pattern to strictly separate business logic from third-party APIs.

## Directory Structure

The repository is structured to separate concerns and make the architecture obvious at first glance:

```text
/
├── cmd/
│   └── server/
│       └── main.go         # Application entry point. Wires dependencies.
├── internal/
│   ├── core/               # Domain interfaces and business logic. Zero external dependencies.
│   ├── adapters/           # Infrastructure: Demucs Tunnel client, LRCLIB API client.
│   └── handlers/           # HTTP layer: API endpoints and WebSocket controllers.
├── frontend/               # Canonical React (Vite) Single Page Application and Go embed package.
│   ├── src/                # React components and hooks.
│   ├── embed.go            # Embeds the generated dist/ directory for Go.
│   └── package.json
├── build.sh                # Reproducible frontend-then-Go production build.
├── go.mod                  # Go module definition.
└── PRD.md                  # Product Requirements Document.
```

## Details

| Area | Decision | Rationale |
|------|----------|-----------|
| **Routing** | Go 1.22+ `net/http` | Go 1.22 introduced a powerful standard router. We avoid external frameworks (like Fiber or Gin) to focus on strong fundamentals. |
| **Asynchrony** | WebSockets / Polling | Audio processing via the Tunnel takes time. The backend uses Goroutines to avoid blocking and polls the Tunnel endpoint. |
| **Development** | Vite | Run `corepack pnpm --dir frontend run dev`; Vite serves `:5173` and proxies `/api` to Go on `:8080`. |
| **Deployment** | `//go:embed` | `frontend/embed.go` embeds the generated `frontend/dist` directory directly into the Go binary. Build the frontend before compiling Go. |
| **Memory Management** | Ephemeral | No database. Temporary audio files will be strictly cleaned up using Go's `defer` and background sweepers to protect the VPS RAM. |

## Checklist (Ready for Implementation)

- [x] Monorepo strategy defined.
- [x] Deployment strategy (Single Executable) defined.
- [x] Clean architecture skeleton designed.
- [ ] Initialize `go.mod` and `package.json`.
- [ ] Create basic routing and `embed` setup.

## Build Contract

The frontend is the only UI source. Its generated `frontend/dist/` is ignored by Git because Go embeds it at compile time.

```bash
./build.sh                 # writes the ignored ./gosing binary
./build.sh /tmp/gosing     # explicit alternate output; parent must exist
```

`build.sh` uses the `pnpm@11.21.0` version pinned by `frontend/package.json`, performs `install --frozen-lockfile`, builds Vite, then compiles `./cmd/server`. A direct `go run cmd/server/main.go` also requires `frontend/dist/` to have been built first. `start.sh` performs that build only when `frontend/dist/index.html` is missing, before it starts Vite, the worker, or Go.

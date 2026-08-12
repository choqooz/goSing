# GoSing Operational Baseline

This baseline captures the current local development flow without changing the frontend or audio API contracts.

## Start

Run the repository launcher from the repository root:

```bash
./start.sh
```

The confirmed manual commands and their fixed ports are:

| Service | Confirmed command | Address |
| --- | --- | --- |
| Frontend | `corepack pnpm --dir frontend run dev` | Vite default `:5173` |
| Worker | `uvicorn main:app --port 8000` from `worker/` | `127.0.0.1:8000` |
| Backend | `go run cmd/server/main.go` from the root | `:8080` |

The launcher runs the worker as `worker/venv/bin/python -m uvicorn main:app --port 8000` from `worker/`, with `worker/venv/bin` first in `PATH`. This is equivalent to the confirmed command when that virtualenv is activated, while ensuring both Uvicorn and Demucs resolve from the worker virtualenv.

Before launching, `start.sh` checks `go`, Corepack and the frontend-pinned pnpm, `curl`, `setsid`, the worker virtualenv Python, and Uvicorn and Demucs within that virtualenv. It creates the writable `worker/separated/` output directory when absent. If `frontend/dist/index.html` is missing, it builds the frontend before launching services because Go must compile its embedded static files. It waits up to 30 seconds for the worker and backend readiness checks; each curl request is capped at three seconds.

## Frontend Build Contract

`frontend/` is the sole canonical UI source and contains the Go embed package. Vite development uses `:5173` and proxies `/api` to Go on `:8080`; production Go serves the built `frontend/dist/` from the same `:8080` process.

```bash
./build.sh                 # frozen frontend install, Vite build, Go binary at ./gosing
./build.sh /tmp/gosing     # alternate output; its parent directory must already exist
```

`frontend/package.json` pins pnpm `11.21.0`; `build.sh` invokes it through Corepack and always runs `install --frozen-lockfile` before `run build`. For a direct backend command, first build the frontend, then run `go run cmd/server/main.go`. No generated `dist/` files are committed.

## Health Checks

| Service | Endpoint | Expected result |
| --- | --- | --- |
| Go backend | `GET http://127.0.0.1:8080/api/health` | `200` and the existing API JSON response |
| Worker liveness | `GET http://127.0.0.1:8000/health` | `200` with `{"status":"ok"}` |
| Worker readiness | `GET http://127.0.0.1:8000/ready` | `200` only when its directory, output directory, and `demucs` command are available |

Worker readiness does not run Demucs, load a model, or trigger downloads. A failed readiness response is `503` and identifies each lightweight check.

## Audio Job Lifecycle

The Go ingress and Python worker accept `.mp3`, `.wav`, `.m4a`, `.ogg`, and `.flac` uploads up to 20 MiB. Each worker job receives a UUID workspace under `worker/separated/jobs/`; the original upload is an ephemeral input, not a public asset.

| State | Retention and recovery |
| --- | --- |
| Processing | The input exists only until Demucs completes or fails. It never expires while active. |
| Completed | Non-empty separated outputs are public at `/audio/jobs/<job-id>/...` for 24 hours. |
| Failed | Inputs and partial outputs are removed; sanitized failure metadata remains for 24 hours. |
| Worker restart | Valid completed jobs are restored. Inherited processing jobs become `failed` with an interrupted message and their runtime files are removed. |

Cleanup runs at worker startup and before creating a job or returning its status. Only expired completed or failed workspaces with valid local metadata are removed. Job metadata is written atomically for local recovery; it is not a persistent queue or a guarantee that an interrupted process will resume.

## Capacity and Timeouts

The MVP admits at most one `processing` Demucs job at a time. This fixed, conservative limit protects GPU, CPU, and memory stability; this unit intentionally provides no partial environment override. The worker reserves that single slot before writing an upload. While occupied, `POST /api/process` returns `429` with `{"error":"Audio processing capacity is full.","retry_after_seconds":60}` and `Retry-After: 60`; it creates no job workspace or metadata. Clients must not retry automatically.

The Go request deadlines are 5 seconds for suggestions, 20 seconds for search, 5 minutes for downloads, 30 seconds for worker job submission, and 10 seconds for worker status polling. A `429` is propagated as capacity pressure, not retried by Go.

FastAPI `BackgroundTasks` starts best-effort in-process work after the response. It is not a durable queue and has no cancellation endpoint: a worker restart marks inherited processing work as failed/interrupted before accepting new jobs.

## Scope and Reproducibility Risk

The Go backend embeds `frontend/dist`, eliminating the split between development and production UI sources. The worker resolves `separated/` from `worker/main.py`, and its ASGI process is started by Uvicorn from `worker/`.

## Quick Diagnostics

```bash
curl -fsS http://127.0.0.1:8000/ready
curl -fsS http://127.0.0.1:8080/api/health
```

If the launcher exits before readiness, its service label identifies which process to inspect. Each service starts in a verified private session; cleanup signals only that service's process group, including descendants created by `pnpm` or `go run`, and never uses `kill 0`.

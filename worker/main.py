import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles


WORKER_DIR = Path(__file__).resolve().parent
SEPARATED_DIR = WORKER_DIR / "separated"
JOBS_DIR = SEPARATED_DIR / "jobs"
DEMUCS_COMMAND = "demucs"
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
UPLOAD_CHUNK_BYTES = 1024 * 1024
TTL_SECONDS = 24 * 60 * 60
MAX_PROCESSING_JOBS = 1
RETRY_AFTER_SECONDS = 60
ALLOWED_EXTENSIONS = {".mp3", ".wav", ".m4a", ".ogg", ".flac"}
EVENT_FIELDS = {"timestamp", "level", "component", "event", "request_id", "job_id", "operation", "outcome", "status", "duration_ms", "status_code", "size_bytes", "error_code"}
REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._~-]{1,64}$")

jobs = {}
jobs_lock = threading.RLock()
clock = time.time
command_runner = subprocess.run
event_writer = sys.stdout
event_clock = lambda: datetime.now(timezone.utc)

# StaticFiles requires this output directory at application construction time.
JOBS_DIR.mkdir(parents=True, exist_ok=True)
app = FastAPI()
app.mount("/audio", StaticFiles(directory=SEPARATED_DIR), name="audio")


def emit_event(writer=None, **fields):
    event = {key: value for key, value in fields.items() if key in EVENT_FIELDS and value is not None}
    event["timestamp"] = event_clock().astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    event["duration_ms"] = max(0, int(event.get("duration_ms", 0)))
    (writer or event_writer).write(json.dumps(event, separators=(",", ":")) + "\n")


def request_id_for(request):
    value = request.headers.get("X-Request-ID", "") if request is not None else ""
    return value if REQUEST_ID_PATTERN.fullmatch(value) else str(uuid.uuid4())


def readiness_checks():
    return {
        "worker_directory": WORKER_DIR.is_dir(),
        "output_directory": SEPARATED_DIR.is_dir()
        and os.access(SEPARATED_DIR, os.R_OK | os.W_OK),
        "demucs": shutil.which(DEMUCS_COMMAND) is not None,
    }


def workspace_for(job_id):
    try:
        if str(uuid.UUID(job_id)) != job_id:
            return None
    except (ValueError, TypeError, AttributeError):
        return None
    workspace = JOBS_DIR / job_id
    try:
        if workspace.parent.resolve() != JOBS_DIR.resolve() or workspace.is_symlink():
            return None
        if workspace.exists() and workspace.resolve().parent != JOBS_DIR.resolve():
            return None
    except OSError:
        return None
    return workspace


def metadata_path(workspace):
    return workspace / "metadata.json"


def save_metadata(workspace, metadata):
    temporary = workspace / "metadata.tmp"
    with temporary.open("w", encoding="utf-8") as file:
        json.dump(metadata, file, separators=(",", ":"))
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, metadata_path(workspace))


def load_metadata(workspace):
    try:
        with metadata_path(workspace).open(encoding="utf-8") as file:
            metadata = json.load(file)
        if (
            not isinstance(metadata, dict)
            or metadata.get("id") != workspace.name
            or metadata.get("status") not in {"processing", "completed", "failed"}
            or not isinstance(metadata.get("created_at"), (int, float))
            or (
                metadata.get("status") in {"completed", "failed"}
                and not isinstance(metadata.get("expires_at"), (int, float))
            )
        ):
            raise ValueError("invalid job metadata")
        return metadata
    except (OSError, ValueError, json.JSONDecodeError):
        emit_event(level="error", component="worker", event="worker.cleanup_error", operation="cleanup", outcome="failure", error_code="storage_failed")
        return None


def remove_path(path):
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.is_dir():
        shutil.rmtree(path)


def remove_runtime_files(workspace):
    for input_file in workspace.glob("input.*"):
        remove_path(input_file)
    remove_path(workspace / "output")


def public_job(metadata):
    return {
        key: metadata[key]
        for key in ("status", "error", "instrumental_url", "vocal_url")
        if key in metadata
    }


def capacity_available():
    return sum(job.get("status") == "processing" for job in jobs.values()) < MAX_PROCESSING_JOBS


def rate_limit_response():
    return JSONResponse(
        status_code=429,
        content={
            "error": "Audio processing capacity is full.",
            "retry_after_seconds": RETRY_AFTER_SECONDS,
        },
        headers={"Retry-After": str(RETRY_AFTER_SECONDS)},
    )


def fail_job(job_id, message, error_code="unknown"):
    workspace = workspace_for(job_id)
    metadata = jobs.get(job_id)
    if workspace is None or metadata is None:
        return
    metadata.update(status="failed", error=message, expires_at=clock() + TTL_SECONDS)
    metadata.pop("instrumental_url", None)
    metadata.pop("vocal_url", None)
    try:
        remove_runtime_files(workspace)
    except Exception:
        emit_event(level="error", component="worker", event="worker.cleanup_error", request_id=metadata.get("request_id"), job_id=job_id, operation="cleanup", outcome="failure", error_code="cleanup_failed")
    try:
        save_metadata(workspace, metadata)
    except Exception:
        emit_event(level="error", component="worker", event="worker.cleanup_error", request_id=metadata.get("request_id"), job_id=job_id, operation="metadata", outcome="failure", error_code="storage_failed")
    emit_event(level="error", component="worker", event="worker.failed", request_id=metadata.get("request_id"), job_id=job_id, operation="demucs", outcome="failure", status="failed", error_code=error_code)


def cleanup_expired():
    with jobs_lock:
        try:
            workspaces = list(JOBS_DIR.iterdir())
        except OSError:
            emit_event(level="error", component="worker", event="worker.cleanup_error", operation="cleanup", outcome="failure", error_code="storage_failed")
            return
        now = clock()
        for workspace in workspaces:
            if workspace_for(workspace.name) != workspace or workspace.is_symlink():
                emit_event(level="error", component="worker", event="worker.cleanup_error", operation="cleanup", outcome="failure", error_code="cleanup_failed")
                continue
            metadata = load_metadata(workspace)
            if metadata is None:
                continue
            if metadata.get("status") not in {"completed", "failed"}:
                continue
            if metadata.get("expires_at", 0) > now:
                continue
            try:
                shutil.rmtree(workspace)
                jobs.pop(workspace.name, None)
                emit_event(level="info", component="worker", event="worker.expired", request_id=metadata.get("request_id"), job_id=workspace.name, operation="cleanup", outcome="success", status="expired")
            except OSError:
                emit_event(level="error", component="worker", event="worker.cleanup_error", request_id=metadata.get("request_id"), job_id=workspace.name, operation="cleanup", outcome="failure", error_code="cleanup_failed")


def load_jobs():
    with jobs_lock:
        cleanup_expired()
        try:
            workspaces = list(JOBS_DIR.iterdir())
        except OSError:
            emit_event(level="error", component="worker", event="worker.cleanup_error", operation="load", outcome="failure", error_code="storage_failed")
            return
        for workspace in workspaces:
            if workspace_for(workspace.name) != workspace or workspace.is_symlink():
                emit_event(level="error", component="worker", event="worker.cleanup_error", operation="load", outcome="failure", error_code="cleanup_failed")
                continue
            metadata = load_metadata(workspace)
            if metadata is None:
                continue
            if metadata.get("status") == "processing":
                try:
                    remove_runtime_files(workspace)
                except Exception:
                    emit_event(level="error", component="worker", event="worker.cleanup_error", request_id=metadata.get("request_id"), job_id=workspace.name, operation="cleanup", outcome="failure", error_code="cleanup_failed")
                metadata.update(
                    status="failed",
                    error="Processing interrupted by worker restart.",
                    expires_at=clock() + TTL_SECONDS,
                )
                try:
                    save_metadata(workspace, metadata)
                except Exception:
                    emit_event(level="error", component="worker", event="worker.cleanup_error", request_id=metadata.get("request_id"), job_id=workspace.name, operation="metadata", outcome="failure", error_code="storage_failed")
                emit_event(level="error", component="worker", event="worker.interrupted", request_id=metadata.get("request_id"), job_id=workspace.name, operation="recovery", outcome="failure", status="failed", error_code="job_interrupted")
            jobs[workspace.name] = metadata
        cleanup_expired()


def output_files(workspace):
    result_dir = workspace / "output" / "htdemucs" / "input"
    vocals = result_dir / "vocals.mp3"
    instrumental = result_dir / "no_vocals.mp3"
    for file in (vocals, instrumental):
        if (
            any(
                path.is_symlink()
                for path in (workspace / "output", workspace / "output" / "htdemucs", result_dir, file)
            )
            or not file.is_file()
            or file.stat().st_size == 0
        ):
            raise RuntimeError("Demucs did not produce valid audio outputs.")
    return vocals, instrumental


def run_demucs(job_id):
    with jobs_lock:
        workspace = workspace_for(job_id)
        metadata = jobs.get(job_id)
        if workspace is None or metadata is None or metadata.get("status") != "processing":
            return
        input_path = workspace / metadata["input_name"]
        output_dir = workspace / "output"
    try:
        command_runner(
            [
                DEMUCS_COMMAND,
                "-n",
                "htdemucs",
                "--two-stems",
                "vocals",
                "--mp3",
                "--out",
                str(output_dir),
                str(input_path),
            ],
            check=True,
            cwd=WORKER_DIR,
        )
        vocals, instrumental = output_files(workspace)
        with jobs_lock:
            metadata.update(
                status="completed",
                expires_at=clock() + TTL_SECONDS,
                vocal_url=f"http://127.0.0.1:8000/audio/jobs/{job_id}/{vocals.relative_to(workspace)}",
                instrumental_url=(
                    f"http://127.0.0.1:8000/audio/jobs/{job_id}/{instrumental.relative_to(workspace)}"
                ),
            )
            try:
                save_metadata(workspace, metadata)
            except Exception:
                emit_event(level="error", component="worker", event="worker.cleanup_error", request_id=metadata.get("request_id"), job_id=job_id, operation="metadata", outcome="failure", error_code="storage_failed")
            emit_event(level="info", component="worker", event="worker.completed", request_id=metadata.get("request_id"), job_id=job_id, operation="demucs", outcome="success", status="completed")
    except Exception:
        with jobs_lock:
            fail_job(job_id, "Audio separation failed.", "command_failed")
    finally:
        with jobs_lock:
            if workspace is not None:
                try:
                    input_path.unlink(missing_ok=True)
                except OSError:
                    emit_event(level="error", component="worker", event="worker.cleanup_error", request_id=metadata.get("request_id") if metadata else None, job_id=job_id, operation="cleanup", outcome="failure", error_code="cleanup_failed")


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/ready")
async def ready():
    checks = readiness_checks()
    if all(checks.values()):
        return JSONResponse(content={"status": "ready", "checks": checks})
    return JSONResponse(status_code=503, content={"status": "not_ready", "checks": checks})


@app.post("/api/process")
async def process_audio(request: Request, file: UploadFile, background_tasks: BackgroundTasks):
    cleanup_expired()
    request_id = request_id_for(request)
    extension = Path(file.filename or "").suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        emit_event(level="error", component="worker", event="worker.rejected", request_id=request_id, operation="upload", outcome="failure", status_code=400, error_code="unsupported_format")
        raise HTTPException(status_code=400, detail="Unsupported audio format.", headers={"X-Request-ID": request_id})
    job_id = str(uuid.uuid4())
    workspace = workspace_for(job_id)
    input_name = f"input{extension}"
    input_path = workspace / input_name
    metadata = {
        "id": job_id,
        "request_id": request_id,
        "status": "processing",
        "created_at": clock(),
        "input_name": input_name,
    }
    try:
        with jobs_lock:
            if not capacity_available():
                emit_event(level="error", component="worker", event="worker.rejected", request_id=request_id, operation="upload", outcome="failure", status_code=429, error_code="capacity_full")
                response = rate_limit_response()
                response.headers["X-Request-ID"] = request_id
                return response
            workspace.mkdir()
            jobs[job_id] = metadata
            save_metadata(workspace, metadata)
        size = 0
        with input_path.open("wb") as buffer:
            while chunk := await file.read(UPLOAD_CHUNK_BYTES):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    emit_event(level="error", component="worker", event="worker.rejected", request_id=request_id, job_id=job_id, operation="upload", outcome="failure", status_code=413, size_bytes=size, error_code="payload_too_large")
                    raise HTTPException(status_code=413, detail="Upload exceeds 20 MiB limit.", headers={"X-Request-ID": request_id})
                buffer.write(chunk)
    except Exception:
        with jobs_lock:
            jobs.pop(job_id, None)
            remove_path(workspace)
        raise
    background_tasks.add_task(run_demucs, job_id)
    emit_event(level="info", component="worker", event="worker.accepted", request_id=request_id, job_id=job_id, operation="upload", outcome="success", status="processing", status_code=200, size_bytes=size)
    return JSONResponse(content={"job_id": job_id}, headers={"X-Request-ID": request_id})


@app.get("/api/status/{job_id}")
async def get_status(job_id: str):
    cleanup_expired()
    with jobs_lock:
        metadata = jobs.get(job_id)
        if metadata is None:
            return JSONResponse(status_code=404, content={"error": "Trabajo no encontrado"})
        return public_job(metadata)


load_jobs()

import json
import logging
import os
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, HTTPException, UploadFile
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

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
jobs = {}
jobs_lock = threading.RLock()
clock = time.time
command_runner = subprocess.run

# StaticFiles requires this output directory at application construction time.
JOBS_DIR.mkdir(parents=True, exist_ok=True)
app = FastAPI()
app.mount("/audio", StaticFiles(directory=SEPARATED_DIR), name="audio")


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
    except (OSError, ValueError, json.JSONDecodeError) as error:
        logger.warning("Ignoring corrupt job metadata in %s: %s", workspace.name, error)
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
    logger.info("Rejecting audio job: processing capacity is full")
    return JSONResponse(
        status_code=429,
        content={
            "error": "Audio processing capacity is full.",
            "retry_after_seconds": RETRY_AFTER_SECONDS,
        },
        headers={"Retry-After": str(RETRY_AFTER_SECONDS)},
    )


def fail_job(job_id, message):
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
        logger.warning("Could not remove failed job runtime files")
    try:
        save_metadata(workspace, metadata)
    except Exception:
        logger.warning("Could not persist failed job metadata")
    logger.info("Demucs job %s failed", job_id)


def cleanup_expired():
    with jobs_lock:
        try:
            workspaces = list(JOBS_DIR.iterdir())
        except OSError as error:
            logger.warning("Could not inspect job directory: %s", error)
            return
        now = clock()
        for workspace in workspaces:
            if workspace_for(workspace.name) != workspace or workspace.is_symlink():
                logger.warning("Ignoring unsafe job workspace: %s", workspace)
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
            except OSError as error:
                logger.warning("Could not remove expired job %s: %s", workspace.name, error)


def load_jobs():
    with jobs_lock:
        cleanup_expired()
        try:
            workspaces = list(JOBS_DIR.iterdir())
        except OSError as error:
            logger.warning("Could not load jobs: %s", error)
            return
        for workspace in workspaces:
            if workspace_for(workspace.name) != workspace or workspace.is_symlink():
                logger.warning("Ignoring unsafe job workspace: %s", workspace)
                continue
            metadata = load_metadata(workspace)
            if metadata is None:
                continue
            if metadata.get("status") == "processing":
                remove_runtime_files(workspace)
                metadata.update(
                    status="failed",
                    error="Processing interrupted by worker restart.",
                    expires_at=clock() + TTL_SECONDS,
                )
                try:
                    save_metadata(workspace, metadata)
                except Exception:
                    logger.warning("Could not persist interrupted job metadata")
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
                logger.warning("Could not persist completed job metadata")
            logger.info("Demucs job %s completed", job_id)
    except Exception:
        with jobs_lock:
            fail_job(job_id, "Audio separation failed.")
    finally:
        with jobs_lock:
            if workspace is not None:
                try:
                    input_path.unlink(missing_ok=True)
                except OSError:
                    logger.warning("Could not remove completed job input")


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
async def process_audio(file: UploadFile, background_tasks: BackgroundTasks):
    cleanup_expired()
    extension = Path(file.filename or "").suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Unsupported audio format.")
    job_id = str(uuid.uuid4())
    workspace = workspace_for(job_id)
    input_name = f"input{extension}"
    input_path = workspace / input_name
    metadata = {
        "id": job_id,
        "status": "processing",
        "created_at": clock(),
        "original_filename": file.filename,
        "input_name": input_name,
    }
    try:
        with jobs_lock:
            if not capacity_available():
                return rate_limit_response()
            workspace.mkdir()
            jobs[job_id] = metadata
            save_metadata(workspace, metadata)
        size = 0
        with input_path.open("wb") as buffer:
            while chunk := await file.read(UPLOAD_CHUNK_BYTES):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="Upload exceeds 20 MiB limit.")
                buffer.write(chunk)
    except Exception:
        with jobs_lock:
            jobs.pop(job_id, None)
            remove_path(workspace)
        raise
    background_tasks.add_task(run_demucs, job_id)
    return JSONResponse(content={"job_id": job_id})


@app.get("/api/status/{job_id}")
async def get_status(job_id: str):
    cleanup_expired()
    with jobs_lock:
        metadata = jobs.get(job_id)
        if metadata is None:
            return JSONResponse(status_code=404, content={"error": "Trabajo no encontrado"})
        return public_job(metadata)


load_jobs()

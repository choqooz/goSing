import asyncio
import io
import json
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import main


class WorkerHealthTests(unittest.TestCase):
    def test_health_reports_ok(self):
        self.assertEqual(asyncio.run(main.health()), {"status": "ok"})

    @patch("main.shutil.which", return_value="/mock/demucs")
    def test_ready_reports_all_lightweight_checks(self, _which):
        response = asyncio.run(main.ready())

        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.body), {
            "status": "ready",
            "checks": {
                "worker_directory": True,
                "output_directory": True,
                "demucs": True,
            },
        })

    @patch("main.shutil.which", return_value=None)
    def test_ready_reports_missing_demucs(self, _which):
        response = asyncio.run(main.ready())

        self.assertEqual(response.status_code, 503)
        self.assertEqual(json.loads(response.body)["checks"]["demucs"], False)


class Upload:
    def __init__(self, filename, content):
        self.filename = filename
        self.content = io.BytesIO(content)

    async def read(self, size):
        return self.content.read(size)


class Tasks:
    def __init__(self):
        self.tasks = []

    def add_task(self, task, *args):
        self.tasks.append((task, args))


class WorkerLifecycleTests(unittest.TestCase):
    now = 1_700_000_000

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name) / "separated"
        self.jobs_dir = self.root / "jobs"
        self.jobs_dir.mkdir(parents=True)
        self.previous = (main.SEPARATED_DIR, main.JOBS_DIR, main.jobs, main.clock, main.command_runner)
        main.SEPARATED_DIR = self.root
        main.JOBS_DIR = self.jobs_dir
        main.jobs = {}
        main.clock = lambda: self.now

    def tearDown(self):
        main.SEPARATED_DIR, main.JOBS_DIR, main.jobs, main.clock, main.command_runner = self.previous
        self.tempdir.cleanup()

    def upload(self, filename="song.mp3", content=b"audio"):
        tasks = Tasks()
        response = asyncio.run(main.process_audio(Upload(filename, content), tasks))
        return json.loads(response.body)["job_id"], tasks

    def process(self, filename="song.mp3", content=b"audio"):
        tasks = Tasks()
        return asyncio.run(main.process_audio(Upload(filename, content), tasks)), tasks

    def workspace(self, status="completed", expires_at=None):
        job_id = str(uuid.uuid4())
        workspace = main.workspace_for(job_id)
        workspace.mkdir()
        metadata = {"id": job_id, "status": status, "created_at": self.now}
        if expires_at is not None:
            metadata["expires_at"] = expires_at
        main.save_metadata(workspace, metadata)
        main.jobs[job_id] = metadata
        return job_id, workspace, metadata

    def test_upload_is_chunked_and_rejects_more_than_20_mib(self):
        job_id, tasks = self.upload(content=b"a" * (main.UPLOAD_CHUNK_BYTES + 1))
        workspace = main.workspace_for(job_id)
        self.assertEqual((workspace / "input.mp3").stat().st_size, main.UPLOAD_CHUNK_BYTES + 1)
        self.assertEqual(tasks.tasks[0][1], (job_id,))
        main.jobs[job_id]["status"] = "failed"

        with self.assertRaises(main.HTTPException) as error:
            self.upload(content=b"a" * (main.MAX_UPLOAD_BYTES + 1))
        self.assertEqual(error.exception.status_code, 413)
        self.assertEqual(list(self.jobs_dir.iterdir()), [workspace])

    def test_upload_rejects_extensions_and_isolates_matching_names(self):
        with self.assertRaises(main.HTTPException) as error:
            self.upload("song.txt")
        self.assertEqual(error.exception.status_code, 400)
        first, _ = self.upload("same name.mp3")
        main.jobs[first]["status"] = "failed"
        second, _ = self.upload("same name.mp3")
        self.assertNotEqual(first, second)
        self.assertTrue((main.workspace_for(first) / "input.mp3").is_file())
        self.assertTrue((main.workspace_for(second) / "input.mp3").is_file())

    def test_capacity_rejects_second_processing_job_without_residue(self):
        self.upload()
        response, tasks = self.process()

        self.assertEqual(response.status_code, 429)
        self.assertEqual(json.loads(response.body), {
            "error": "Audio processing capacity is full.",
            "retry_after_seconds": main.RETRY_AFTER_SECONDS,
        })
        self.assertEqual(response.headers["retry-after"], str(main.RETRY_AFTER_SECONDS))
        self.assertEqual(tasks.tasks, [])
        self.assertEqual(len(list(self.jobs_dir.iterdir())), 1)

    def test_completed_and_failed_jobs_release_capacity(self):
        completed, _ = self.upload()

        def successful_demucs(command, **_kwargs):
            output = Path(command[command.index("--out") + 1]) / "htdemucs" / "input"
            output.mkdir(parents=True)
            (output / "vocals.mp3").write_bytes(b"vocals")
            (output / "no_vocals.mp3").write_bytes(b"instrumental")

        main.command_runner = successful_demucs
        main.run_demucs(completed)
        failed, _ = self.upload()
        main.command_runner = lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError())
        main.run_demucs(failed)
        response, _ = self.process()

        self.assertEqual(response.status_code, 200)

    def test_terminal_metadata_failure_does_not_retain_capacity(self):
        job_id, _ = self.upload()

        def successful_demucs(command, **_kwargs):
            output = Path(command[command.index("--out") + 1]) / "htdemucs" / "input"
            output.mkdir(parents=True)
            (output / "vocals.mp3").write_bytes(b"vocals")
            (output / "no_vocals.mp3").write_bytes(b"instrumental")

        main.command_runner = successful_demucs
        with patch("main.save_metadata", side_effect=OSError("disk unavailable")):
            main.run_demucs(job_id)
        response, _ = self.process()

        self.assertEqual(main.jobs[job_id]["status"], "completed")
        self.assertEqual(response.status_code, 200)

    def test_concurrent_reservations_admit_exactly_one_job(self):
        barrier = threading.Barrier(2)
        responses = []

        def submit():
            barrier.wait()
            response, _ = self.process()
            responses.append(response.status_code)

        threads = [threading.Thread(target=submit) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertCountEqual(responses, [200, 429])
        self.assertEqual(len(main.jobs), 1)

    def test_success_keeps_nonempty_outputs_and_public_metadata(self):
        job_id, _ = self.upload()

        def successful_demucs(command, **_kwargs):
            output = Path(command[command.index("--out") + 1]) / "htdemucs" / "input"
            output.mkdir(parents=True)
            (output / "vocals.mp3").write_bytes(b"vocals")
            (output / "no_vocals.mp3").write_bytes(b"instrumental")

        main.command_runner = successful_demucs
        main.run_demucs(job_id)
        workspace = main.workspace_for(job_id)
        metadata = main.jobs[job_id]
        self.assertEqual(metadata["status"], "completed")
        self.assertEqual(metadata["expires_at"], self.now + main.TTL_SECONDS)
        self.assertFalse((workspace / "input.mp3").exists())
        self.assertTrue((workspace / "output/htdemucs/input/vocals.mp3").stat().st_size)
        self.assertTrue((workspace / "output/htdemucs/input/no_vocals.mp3").stat().st_size)
        self.assertTrue(metadata["vocal_url"].endswith(f"/jobs/{job_id}/output/htdemucs/input/vocals.mp3"))
        self.assertTrue(metadata["instrumental_url"].endswith(f"/jobs/{job_id}/output/htdemucs/input/no_vocals.mp3"))
        self.assertNotIn(str(workspace), metadata["vocal_url"])

    def test_failure_removes_runtime_files_and_sanitizes_error(self):
        job_id, _ = self.upload()

        def failing_demucs(command, **_kwargs):
            output = Path(command[command.index("--out") + 1])
            output.mkdir()
            (output / "partial.mp3").write_bytes(b"partial")
            raise RuntimeError("/private/model details")

        main.command_runner = failing_demucs
        main.run_demucs(job_id)
        workspace = main.workspace_for(job_id)
        metadata = main.jobs[job_id]
        self.assertEqual(metadata["status"], "failed")
        self.assertEqual(metadata["error"], "Audio separation failed.")
        self.assertFalse((workspace / "input.mp3").exists())
        self.assertFalse((workspace / "output").exists())
        self.assertEqual(main.load_metadata(workspace)["status"], "failed")

    def test_cleanup_only_removes_expired_terminal_jobs(self):
        processing, processing_workspace, _ = self.workspace("processing")
        completed, completed_workspace, _ = self.workspace("completed", self.now)
        failed, failed_workspace, _ = self.workspace("failed", self.now - 1)
        main.cleanup_expired()
        self.assertTrue(processing_workspace.exists())
        self.assertFalse(completed_workspace.exists())
        self.assertFalse(failed_workspace.exists())
        self.assertIn(processing, main.jobs)
        self.assertNotIn(completed, main.jobs)
        self.assertNotIn(failed, main.jobs)

    def test_cleanup_ignores_corrupt_metadata_and_workspace_symlinks(self):
        corrupt_id = str(uuid.uuid4())
        corrupt = self.jobs_dir / corrupt_id
        corrupt.mkdir()
        (corrupt / "metadata.json").write_text("not json", encoding="utf-8")
        target = Path(self.tempdir.name) / "target"
        target.mkdir()
        (target / "keep").write_text("safe", encoding="utf-8")
        link = self.jobs_dir / str(uuid.uuid4())
        link.symlink_to(target, target_is_directory=True)
        main.cleanup_expired()
        self.assertTrue(corrupt.exists())
        self.assertTrue(link.is_symlink())
        self.assertTrue((target / "keep").exists())

    def test_restart_recovers_completed_and_interrupts_processing(self):
        completed, _, completed_metadata = self.workspace("completed", self.now + main.TTL_SECONDS)
        interrupted, workspace, _ = self.workspace("processing")
        (workspace / "input.mp3").write_bytes(b"input")
        (workspace / "output").mkdir()
        main.jobs = {}
        main.load_jobs()
        self.assertEqual(main.jobs[completed], completed_metadata)
        recovered = main.jobs[interrupted]
        self.assertEqual(recovered["status"], "failed")
        self.assertEqual(recovered["error"], "Processing interrupted by worker restart.")
        self.assertFalse((workspace / "input.mp3").exists())
        self.assertFalse((workspace / "output").exists())

    def test_interrupted_restart_does_not_block_capacity(self):
        self.workspace("processing")
        main.jobs = {}
        main.load_jobs()

        response, _ = self.process()

        self.assertEqual(response.status_code, 200)

    def test_interrupted_restart_metadata_failure_does_not_block_capacity(self):
        self.workspace("processing")
        main.jobs = {}
        with patch("main.save_metadata", side_effect=OSError("disk unavailable")):
            main.load_jobs()

        response, _ = self.process()

        self.assertEqual(response.status_code, 200)

    def test_cleanup_preserves_active_capacity(self):
        processing, workspace, _ = self.workspace("processing")
        main.cleanup_expired()
        response, _ = self.process()

        self.assertTrue(workspace.exists())
        self.assertEqual(main.jobs[processing]["status"], "processing")
        self.assertEqual(response.status_code, 429)

    def test_status_hides_internal_paths_and_returns_404_after_expiry(self):
        job_id, workspace, metadata = self.workspace("completed", self.now + 1)
        metadata.update(input_name="/private/input.mp3", original_filename="/private/name.mp3")
        main.save_metadata(workspace, metadata)
        payload = asyncio.run(main.get_status(job_id))
        self.assertNotIn("/private", json.dumps(payload))
        self.now += 1
        self.assertEqual(asyncio.run(main.get_status(job_id)).status_code, 404)
        self.assertEqual(asyncio.run(main.get_status(str(uuid.uuid4()))).status_code, 404)

    def test_metadata_write_leaves_valid_final_file_without_temp_residue(self):
        _, workspace, metadata = self.workspace("completed", self.now + main.TTL_SECONDS)
        metadata["error"] = "saved"
        main.save_metadata(workspace, metadata)
        self.assertEqual(main.load_metadata(workspace)["error"], "saved")
        self.assertFalse((workspace / "metadata.tmp").exists())


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

from redis import Redis

from .config import Settings
from .jobs import STAGES, build_file_urls
from .store import InMemoryStore


def enqueue_worker_job(
    settings: Settings,
    job_id: str,
    session_id: str,
    model_spec: dict,
    printer_profile: str,
) -> None:
    if not settings.redis_url:
        raise RuntimeError("REDIS_URL is required when USE_EXTERNAL_WORKER=true")

    redis = Redis.from_url(settings.redis_url, decode_responses=True)
    payload = {
        "jobId": job_id,
        "sessionId": session_id,
        "modelSpec": model_spec,
        "printerProfile": printer_profile,
        "artifactDir": str(settings.artifacts_dir / job_id),
    }
    redis.lpush("stl:jobs", json.dumps(payload))


async def watch_worker_result(
    settings: Settings,
    store: InMemoryStore,
    job_id: str,
    timeout_s: int = 150,
) -> None:
    if not settings.redis_url:
        raise RuntimeError("REDIS_URL is required when USE_EXTERNAL_WORKER=true")

    redis = Redis.from_url(settings.redis_url, decode_responses=True)
    key = f"stl:job:{job_id}"
    deadline = time.time() + timeout_s

    while time.time() < deadline:
        raw_result = redis.hget(key, "result")
        if raw_result:
            result = json.loads(raw_result)
            existing = store.get_job(job_id)
            if existing is None:
                return

            has_3mf = bool(result.get("project3mfPath"))
            urls = build_file_urls(
                base_url=settings.public_base_url,
                job_id=job_id,
                token=existing.token,
                has_3mf=has_3mf,
            )

            updated_job = existing.model_copy(
                update={
                    "status": result.get("status", "completed"),
                    "stage": STAGES[4],
                    "error": result.get("error"),
                    "stlPath": result.get("stlPath"),
                    "project3mfPath": result.get("project3mfPath"),
                    "reportPath": result.get("reportPath"),
                    **urls,
                }
            )
            store.upsert_job(updated_job)

            session = store.get_session(updated_job.sessionId)
            if session:
                store.upsert_session(
                    session.model_copy(update={"status": "completed" if updated_job.status == "completed" else "failed"})
                )

            redis.delete(key)
            return

        await asyncio.sleep(1)

    existing = store.get_job(job_id)
    if existing:
        store.upsert_job(
            existing.model_copy(
                update={
                    "status": "failed",
                    "error": "Worker timeout: no completion result was reported.",
                }
            )
        )

from __future__ import annotations

import asyncio
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict

from .config import Settings
from .pipeline import (
    export_stl,
    slice_with_bambu_cli,
    validate_stl,
    write_placeholder_3mf,
    write_report,
)
from .schemas import JobRecord, ModelSpec, SessionRecord
from .store import InMemoryStore

STAGES = [
    "Understanding request",
    "Preparing geometry",
    "Validating printability",
    "Slicing for printer profile",
    "Packaging files",
]


def build_file_urls(
    base_url: str,
    job_id: str,
    token: str,
    has_3mf: bool,
) -> Dict[str, str]:
    prefix = f"{base_url}/api/v1/builds/{job_id}/files"
    data = {
        "stlUrl": f"{prefix}/model.stl?token={token}",
        "reportUrl": f"{prefix}/report.json?token={token}",
    }
    if has_3mf:
        data["project3mfUrl"] = f"{prefix}/model.3mf?token={token}"
    return data


def new_job(
    session_id: str,
    retention_hours: int,
) -> JobRecord:
    now = datetime.now(timezone.utc)
    return JobRecord(
        jobId=secrets.token_hex(12),
        sessionId=session_id,
        status="queued",
        token=secrets.token_urlsafe(24),
        stage=STAGES[0],
        createdAt=now,
        expiresAt=now + timedelta(hours=retention_hours),
    )


async def _update_job(store: InMemoryStore, job_id: str, **updates) -> JobRecord:
    existing = store.get_job(job_id)
    if existing is None:
        raise RuntimeError("Build job no longer exists")
    updated = existing.model_copy(update=updates)
    store.upsert_job(updated)
    return updated


async def run_build_job(
    settings: Settings,
    store: InMemoryStore,
    session: SessionRecord,
    job_id: str,
    profile: str,
) -> None:
    artifact_root = settings.artifacts_dir / job_id
    artifact_root.mkdir(parents=True, exist_ok=True)

    stl_path = artifact_root / "model.stl"
    project_3mf_path = artifact_root / "model.3mf"
    report_path = artifact_root / "report.json"

    await _update_job(store, job_id, status="running", stage=STAGES[0])

    try:
        spec: ModelSpec
        if session.modelSpec is None:
            raise RuntimeError("Session has no model spec")
        spec = session.modelSpec.model_copy(update={"printerProfile": profile})

        await _update_job(store, job_id, stage=STAGES[1])
        await asyncio.wait_for(asyncio.to_thread(export_stl, spec, stl_path), timeout=settings.cad_timeout_s)

        await _update_job(store, job_id, stage=STAGES[2])
        validation = await asyncio.to_thread(validate_stl, stl_path)

        await _update_job(store, job_id, stage=STAGES[3])
        slicing_meta: Dict[str, str] = {}
        slice_error: str | None = None

        for attempt in (1, 2):
            try:
                slicing_meta = await asyncio.wait_for(
                    asyncio.to_thread(
                        slice_with_bambu_cli,
                        stl_path,
                        project_3mf_path,
                        profile,
                        settings.profile_dir,
                        settings.slicing_timeout_s,
                    ),
                    timeout=settings.slicing_timeout_s + 5,
                )
                slice_error = None
                break
            except Exception as exc:  # pragma: no cover - depends on local binaries
                slice_error = str(exc)
                if attempt == 2:
                    break

        if slice_error:
            await asyncio.to_thread(write_placeholder_3mf, project_3mf_path, stl_path)

        await _update_job(store, job_id, stage=STAGES[4])

        report_payload = {
            "jobId": job_id,
            "sessionId": session.sessionId,
            "printerProfile": profile,
            "status": "completed",
            "stlBytes": validation["bytes"],
            "slicing": {
                "engine": slicing_meta.get("engine", "fallback_placeholder"),
                "fallbackReason": slice_error,
                "notes": "If fallback was used, load STL in Bambu Studio for final slicing.",
            },
            "adjustments": [item.model_dump(by_alias=True) for item in session.adjustments],
        }
        await asyncio.to_thread(write_report, report_path, report_payload)

        existing = store.get_job(job_id)
        if existing is None:
            raise RuntimeError("Build job expired during processing")

        urls = build_file_urls(
            base_url=settings.public_base_url,
            job_id=job_id,
            token=existing.token,
            has_3mf=project_3mf_path.exists(),
        )

        await _update_job(
            store,
            job_id,
            status="completed",
            stage=STAGES[4],
            stlPath=str(stl_path),
            project3mfPath=str(project_3mf_path) if project_3mf_path.exists() else None,
            reportPath=str(report_path),
            error=None,
            **urls,
        )

        current_session = store.get_session(session.sessionId)
        if current_session:
            store.upsert_session(current_session.model_copy(update={"status": "completed"}))
    except Exception as exc:
        await _update_job(
            store,
            job_id,
            status="failed",
            error=str(exc),
        )
        current_session = store.get_session(session.sessionId)
        if current_session:
            store.upsert_session(current_session.model_copy(update={"status": "failed"}))

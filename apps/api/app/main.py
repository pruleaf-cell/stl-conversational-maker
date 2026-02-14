from __future__ import annotations

import asyncio
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse

from .agents import orchestrate_prompt
from .config import get_settings
from .constraints import apply_printability_constraints
from .jobs import new_job, run_build_job
from .queue_worker import enqueue_worker_job, watch_worker_result
from .rate_limit import enforce_rate_limit, set_rate_limiter
from .schemas import (
    AnswersPayload,
    BuildRequest,
    BuildResult,
    CreateSessionRequest,
    JobRecord,
    PatchSpecPayload,
    SessionRecord,
    SessionState,
)
from .store import InMemoryStore

settings = get_settings()
store = InMemoryStore()


def _run_job_in_thread(*, session: SessionRecord, job_id: str, profile: str) -> None:
    asyncio.run(
        run_build_job(
            settings=settings,
            store=store,
            session=session,
            job_id=job_id,
            profile=profile,
        )
    )


def _watch_worker_job_in_thread(*, job_id: str) -> None:
    asyncio.run(watch_worker_result(settings=settings, store=store, job_id=job_id))


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings.artifacts_dir.mkdir(parents=True, exist_ok=True)
    set_rate_limiter(settings)
    yield


app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/v1/sessions", response_model=SessionState, dependencies=[Depends(enforce_rate_limit)])
async def create_session(payload: CreateSessionRequest) -> SessionState:
    try:
        orchestrated = await asyncio.wait_for(
            orchestrate_prompt(payload.prompt, max_dimensions_mm=settings.max_dimensions_mm),
            timeout=settings.agent_timeout_s,
        )
    except asyncio.TimeoutError as exc:
        raise HTTPException(status_code=504, detail="Timed out while analysing request") from exc

    now = datetime.now(timezone.utc)
    session = SessionRecord(
        sessionId=str(uuid4()),
        status="questions_ready" if orchestrated.questions else "ready_to_build",
        summary=orchestrated.summary,
        questions=orchestrated.questions,
        modelSpec=orchestrated.spec,
        adjustments=orchestrated.adjustments,
        prompt=payload.prompt,
        answers={},
        createdAt=now,
        expiresAt=now + timedelta(hours=settings.retention_hours),
    )

    store.upsert_session(session)
    return SessionState.model_validate(session)


@app.post("/api/v1/sessions/{session_id}/answers", response_model=SessionState)
async def answer_questions(session_id: str, payload: AnswersPayload) -> SessionState:
    current = store.get_session(session_id)
    if current is None:
        raise HTTPException(status_code=404, detail="Session not found or expired")

    merged_answers = dict(current.answers)
    merged_answers.update(payload.answers)

    try:
        orchestrated = await asyncio.wait_for(
            orchestrate_prompt(
                prompt=current.prompt,
                max_dimensions_mm=settings.max_dimensions_mm,
                existing_spec=current.modelSpec,
                existing_answers=merged_answers,
            ),
            timeout=settings.agent_timeout_s,
        )
    except asyncio.TimeoutError as exc:
        raise HTTPException(status_code=504, detail="Timed out while applying answers") from exc

    updated = current.model_copy(
        update={
            "answers": merged_answers,
            "summary": orchestrated.summary,
            "modelSpec": orchestrated.spec,
            "questions": orchestrated.questions,
            "adjustments": orchestrated.adjustments,
            "status": "questions_ready" if orchestrated.questions else "ready_to_build",
        }
    )
    store.upsert_session(updated)
    return SessionState.model_validate(updated)


@app.patch("/api/v1/sessions/{session_id}/spec", response_model=SessionState)
async def patch_spec(session_id: str, payload: PatchSpecPayload) -> SessionState:
    current = store.get_session(session_id)
    if current is None:
        raise HTTPException(status_code=404, detail="Session not found or expired")
    if current.modelSpec is None:
        raise HTTPException(status_code=400, detail="Session has no model spec yet")

    patched_spec = current.modelSpec.model_copy(
        update={"dimensionsMm": {**current.modelSpec.dimensionsMm, **payload.dimensionsMm}}
    )
    constrained, new_adjustments = apply_printability_constraints(
        patched_spec,
        max_dimensions_mm=settings.max_dimensions_mm,
    )

    updated = current.model_copy(
        update={
            "modelSpec": constrained,
            "adjustments": new_adjustments,
            "status": "ready_to_build",
            "questions": [],
            "summary": "Dimensions updated and optimised for printability.",
        }
    )
    store.upsert_session(updated)
    return SessionState.model_validate(updated)


@app.post("/api/v1/builds", response_model=BuildResult, dependencies=[Depends(enforce_rate_limit)])
async def create_build(payload: BuildRequest) -> BuildResult:
    session = store.get_session(payload.sessionId)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found or expired")
    if session.modelSpec is None:
        raise HTTPException(status_code=400, detail="Session is missing model spec")
    if session.questions:
        raise HTTPException(status_code=400, detail="Please answer clarification questions first")

    updated_session = session.model_copy(
        update={
            "status": "building",
            "modelSpec": session.modelSpec.model_copy(update={"printerProfile": payload.printerProfile}),
        }
    )
    store.upsert_session(updated_session)

    job = new_job(payload.sessionId, retention_hours=settings.retention_hours)
    store.upsert_job(job)

    if settings.use_external_worker:
        enqueue_worker_job(
            settings=settings,
            job_id=job.jobId,
            session_id=updated_session.sessionId,
            model_spec=updated_session.modelSpec.model_dump(),
            printer_profile=payload.printerProfile,
        )
        watch_thread = threading.Thread(
            target=_watch_worker_job_in_thread,
            kwargs={"job_id": job.jobId},
            daemon=True,
        )
        watch_thread.start()
    else:
        thread = threading.Thread(
            target=_run_job_in_thread,
            kwargs={
                "session": updated_session,
                "job_id": job.jobId,
                "profile": payload.printerProfile,
            },
            daemon=True,
        )
        thread.start()

    return BuildResult.model_validate(job)


def _job_or_404(job_id: str) -> JobRecord:
    job = store.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Build job not found or expired")
    return job


@app.get("/api/v1/builds/{job_id}")
async def get_build(job_id: str) -> dict:
    job = _job_or_404(job_id)
    payload = BuildResult.model_validate(job).model_dump()
    payload["stage"] = job.stage
    payload["error"] = job.error
    return payload


@app.get("/api/v1/builds/{job_id}/artifacts")
async def get_artifacts(job_id: str) -> dict:
    return await get_build(job_id)


@app.get("/api/v1/builds/{job_id}/files/{filename}")
async def download_artifact(job_id: str, filename: str, token: str = Query(min_length=8)):
    job = _job_or_404(job_id)
    if token != job.token:
        raise HTTPException(status_code=403, detail="Invalid download token")

    allowed = {
        "model.stl": job.stlPath,
        "model.3mf": job.project3mfPath,
        "report.json": job.reportPath,
    }

    resolved = allowed.get(filename)
    if not resolved:
        raise HTTPException(status_code=404, detail="Artifact not found")

    path = Path(resolved)
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Artifact missing from storage")

    media_type = "application/octet-stream"
    if filename.endswith(".json"):
        media_type = "application/json"
    elif filename.endswith(".stl"):
        media_type = "model/stl"
    elif filename.endswith(".3mf"):
        media_type = "application/vnd.ms-package.3dmanufacturing-3dmodel+xml"

    return FileResponse(path=path, media_type=media_type, filename=filename)

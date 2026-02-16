from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Optional

from .schemas import JobRecord, SessionRecord


class InMemoryStore:
    def __init__(self) -> None:
        self.sessions: Dict[str, SessionRecord] = {}
        self.jobs: Dict[str, JobRecord] = {}

    def _is_expired(self, expires_at: datetime) -> bool:
        return datetime.now(timezone.utc) > expires_at

    def _delete_job_artifacts(self, job: JobRecord) -> None:
        for candidate in (job.stlPath, job.project3mfPath, job.reportPath):
            if not candidate:
                continue
            path = Path(candidate)
            if path.exists() and path.is_file():
                path.unlink(missing_ok=True)
        parent = Path(job.stlPath).parent if job.stlPath else None
        if parent and parent.exists():
            try:
                parent.rmdir()
            except OSError:
                pass

    def upsert_session(self, session: SessionRecord) -> None:
        self.sessions[session.sessionId] = session

    def get_session(self, session_id: str) -> Optional[SessionRecord]:
        session = self.sessions.get(session_id)
        if session and self._is_expired(session.expiresAt):
            self.sessions.pop(session_id, None)
            return None
        return session

    def upsert_job(self, job: JobRecord) -> None:
        self.jobs[job.jobId] = job

    def get_job(self, job_id: str) -> Optional[JobRecord]:
        job = self.jobs.get(job_id)
        if job and self._is_expired(job.expiresAt):
            self.jobs.pop(job_id, None)
            self._delete_job_artifacts(job)
            return None
        return job

    def clear(self) -> None:
        self.sessions.clear()
        self.jobs.clear()

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from redis import Redis

ROOT = Path(__file__).resolve().parents[2]
sys.path.append(str(ROOT / "apps" / "api"))

from app.pipeline import (  # noqa: E402
    export_stl,
    slice_with_bambu_cli,
    validate_stl,
    write_placeholder_3mf,
    write_report,
)
from app.schemas import ModelSpec  # noqa: E402

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
QUEUE_NAME = os.getenv("WORKER_QUEUE", "stl:jobs")
PROFILE_DIR = Path(os.getenv("BAMBU_PROFILE_DIR", ROOT / "infra" / "bambu-profiles"))
SLICING_TIMEOUT_S = int(os.getenv("SLICING_TIMEOUT_S", "45"))


def process_job(payload: dict) -> dict:
    job_id = payload["jobId"]
    profile = payload.get("printerProfile", "A1_PLA_0.4")
    artifact_dir = Path(payload.get("artifactDir", ROOT / "artifacts" / job_id))
    artifact_dir.mkdir(parents=True, exist_ok=True)

    spec = ModelSpec.model_validate(payload["modelSpec"])
    stl_path = artifact_dir / "model.stl"
    mf3_path = artifact_dir / "model.3mf"
    report_path = artifact_dir / "report.json"

    export_stl(spec, stl_path)
    validation = validate_stl(stl_path)

    slice_error = None
    try:
        slice_with_bambu_cli(stl_path, mf3_path, profile, PROFILE_DIR, SLICING_TIMEOUT_S)
    except Exception as exc:  # pragma: no cover - CLI availability varies
        slice_error = str(exc)
        write_placeholder_3mf(mf3_path, stl_path)

    write_report(
        report_path,
        {
            "jobId": job_id,
            "status": "completed",
            "stlBytes": validation["bytes"],
            "fallbackReason": slice_error,
        },
    )

    return {
        "jobId": job_id,
        "status": "completed",
        "stlPath": str(stl_path),
        "project3mfPath": str(mf3_path),
        "reportPath": str(report_path),
        "sliceError": slice_error,
    }


def run() -> None:
    redis = Redis.from_url(REDIS_URL, decode_responses=True)
    print(f"Worker listening on {QUEUE_NAME}")

    while True:
        item = redis.brpop(QUEUE_NAME, timeout=5)
        if item is None:
            time.sleep(0.2)
            continue

        _, raw_payload = item
        try:
            payload = json.loads(raw_payload)
            result = process_job(payload)
            redis.hset(f"stl:job:{result['jobId']}", mapping={"result": json.dumps(result)})
        except Exception as exc:  # pragma: no cover
            failure = {
                "status": "failed",
                "error": str(exc),
                "payload": raw_payload,
            }
            redis.lpush("stl:dead-letter", json.dumps(failure))


if __name__ == "__main__":
    run()

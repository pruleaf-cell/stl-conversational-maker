from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    app_name: str
    environment: str
    public_base_url: str
    artifacts_dir: Path
    profile_dir: Path
    retention_hours: int
    agent_timeout_s: int
    cad_timeout_s: int
    slicing_timeout_s: int
    default_specialist_model: str
    default_merge_model: str
    redis_url: str
    use_external_worker: bool
    max_dimensions_mm: float
    max_feature_count: int
    rate_limit_per_minute: int


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    root = Path(__file__).resolve().parents[3]
    artifacts_dir = Path(os.getenv("ARTIFACTS_DIR", root / "artifacts"))
    profile_dir = Path(os.getenv("BAMBU_PROFILE_DIR", root / "infra" / "bambu-profiles"))

    return Settings(
        app_name="STL Conversational Maker API",
        environment=os.getenv("APP_ENV", "development"),
        public_base_url=os.getenv("PUBLIC_BASE_URL", "http://localhost:8000"),
        artifacts_dir=artifacts_dir,
        profile_dir=profile_dir,
        retention_hours=int(os.getenv("RETENTION_HOURS", "24")),
        agent_timeout_s=int(os.getenv("AGENT_TIMEOUT_S", "20")),
        cad_timeout_s=int(os.getenv("CAD_TIMEOUT_S", "20")),
        slicing_timeout_s=int(os.getenv("SLICING_TIMEOUT_S", "45")),
        default_specialist_model=os.getenv("OPENAI_SPECIALIST_MODEL", "gpt-5-mini"),
        default_merge_model=os.getenv("OPENAI_MERGE_MODEL", "gpt-5"),
        redis_url=os.getenv("REDIS_URL", ""),
        use_external_worker=os.getenv("USE_EXTERNAL_WORKER", "false").lower() == "true",
        max_dimensions_mm=float(os.getenv("MAX_DIMENSIONS_MM", "120")),
        max_feature_count=int(os.getenv("MAX_FEATURE_COUNT", "200")),
        rate_limit_per_minute=int(os.getenv("RATE_LIMIT_PER_MINUTE", "30")),
    )

from __future__ import annotations

import time
from collections import defaultdict, deque
from typing import Deque, Dict

from fastapi import HTTPException, Request

from .config import Settings


class InMemoryRateLimiter:
    def __init__(self, requests_per_minute: int) -> None:
        self.requests_per_minute = requests_per_minute
        self.history: Dict[str, Deque[float]] = defaultdict(deque)

    def check(self, key: str) -> None:
        now = time.time()
        window_start = now - 60
        records = self.history[key]
        while records and records[0] < window_start:
            records.popleft()

        if len(records) >= self.requests_per_minute:
            raise HTTPException(status_code=429, detail="Rate limit exceeded. Please wait one minute.")

        records.append(now)


_limiter: InMemoryRateLimiter | None = None


def set_rate_limiter(settings: Settings) -> None:
    global _limiter
    _limiter = InMemoryRateLimiter(settings.rate_limit_per_minute)


async def enforce_rate_limit(request: Request) -> None:
    if _limiter is None:
        return

    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        key = forwarded.split(",", maxsplit=1)[0].strip()
    else:
        key = request.client.host if request.client else "unknown"

    _limiter.check(key)

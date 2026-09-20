"""In-process token-bucket and concurrency limiters (no external deps).

Generous defaults; tune via ``PODCAST_*`` env vars. Process-local memory is
enough for a single ``podcast gui`` / relay worker.
"""

from __future__ import annotations

import os
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any


def env_flag(name: str, *, default: bool = True) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off", ""}


def env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return float(default)
    try:
        return float(raw)
    except ValueError:
        return float(default)


def env_int(name: str, default: int) -> int:
    return int(env_float(name, float(default)))


@dataclass(frozen=True)
class RateLimitDecision:
    allowed: bool
    bucket: str
    retry_after_sec: float = 0.0

    @property
    def retry_after_header(self) -> str:
        return str(max(1, int(self.retry_after_sec + 0.999)))


class TokenBucket:
    """Thread-safe token bucket: ``rate_per_min`` refill, ``burst`` capacity."""

    def __init__(
        self,
        rate_per_min: float,
        burst: float,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.rate_per_sec = max(0.0, float(rate_per_min)) / 60.0
        self.burst = max(1.0, float(burst))
        self._tokens = self.burst
        self._clock = clock
        self._updated = self._clock()
        self._lock = threading.Lock()

    def try_take(self, n: float = 1.0) -> tuple[bool, float]:
        """Return ``(allowed, retry_after_sec)``."""
        need = max(0.0, float(n))
        with self._lock:
            now = self._clock()
            elapsed = now - self._updated
            self._updated = now
            if self.rate_per_sec > 0:
                self._tokens = min(self.burst, self._tokens + elapsed * self.rate_per_sec)
            if self._tokens >= need:
                self._tokens -= need
                return True, 0.0
            deficit = need - self._tokens
            if self.rate_per_sec <= 0:
                return False, 60.0
            return False, deficit / self.rate_per_sec


class KeyedLimiter:
    """Per-key token buckets sharing the same rate/burst policy."""

    def __init__(
        self,
        *,
        rate_per_min: float,
        burst: float,
        bucket_name: str,
        max_keys: int = 10_000,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.rate_per_min = float(rate_per_min)
        self.burst = float(burst)
        self.bucket_name = bucket_name
        self.max_keys = max_keys
        self._clock = clock
        self._buckets: dict[str, TokenBucket] = {}
        self._lock = threading.Lock()

    def allow(self, key: str, n: float = 1.0) -> RateLimitDecision:
        bucket = self._bucket_for(key)
        ok, retry = bucket.try_take(n)
        return RateLimitDecision(
            allowed=ok,
            bucket=self.bucket_name,
            retry_after_sec=retry,
        )

    def _bucket_for(self, key: str) -> TokenBucket:
        with self._lock:
            b = self._buckets.get(key)
            if b is not None:
                return b
            if len(self._buckets) >= self.max_keys:
                # Drop an arbitrary old key to bound memory.
                self._buckets.pop(next(iter(self._buckets)))
            b = TokenBucket(self.rate_per_min, self.burst, clock=self._clock)
            self._buckets[key] = b
            return b

    def reset(self) -> None:
        with self._lock:
            self._buckets.clear()


class ConcurrencyGate:
    """Per-key in-flight counter with a hard max."""

    def __init__(self, *, limit: int, bucket_name: str) -> None:
        self.limit = max(1, int(limit))
        self.bucket_name = bucket_name
        self._counts: dict[str, int] = {}
        self._lock = threading.Lock()

    def try_enter(self, key: str) -> RateLimitDecision:
        with self._lock:
            cur = self._counts.get(key, 0)
            if cur >= self.limit:
                return RateLimitDecision(
                    allowed=False,
                    bucket=self.bucket_name,
                    retry_after_sec=1.0,
                )
            self._counts[key] = cur + 1
            return RateLimitDecision(allowed=True, bucket=self.bucket_name)

    def exit(self, key: str) -> None:
        with self._lock:
            cur = self._counts.get(key, 0)
            if cur <= 1:
                self._counts.pop(key, None)
            else:
                self._counts[key] = cur - 1

    def reset(self) -> None:
        with self._lock:
            self._counts.clear()


def rate_limit_detail(decision: RateLimitDecision) -> dict[str, Any]:
    return {
        "detail": "rate limit exceeded",
        "bucket": decision.bucket,
        "retry_after_sec": round(decision.retry_after_sec, 3),
    }

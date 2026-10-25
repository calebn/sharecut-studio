"""One place that builds ONNX Runtime sessions and picks their execution provider (#2249).

A model asks for acceleration (``accelerate=True``) only when the lab showed it is faster, within
the output tolerance and affordable in memory on that machine class (``scripts/benchmark_accelerators.py``);
everything else stays on the CPU, exactly as before. An accelerated session that will not load or
fails while running is rebuilt on the CPU, the failure is remembered for the process, and the job
carries on.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from podcast_mcp.util.hardware import (
    CPU_PROVIDER,
    HardwareProfile,
    accelerator_preference,
    hardware_profile,
)

log = logging.getLogger(__name__)

_failed: set[tuple[str, str]] = set()
_failed_lock = threading.Lock()


def provider_order(
    *,
    accelerate: bool,
    profile: HardwareProfile | None = None,
    preference: str | None = None,
) -> tuple[str, ...]:
    """The providers to try, CPU always last; just the CPU unless the model asked for more."""
    if not accelerate:
        return (CPU_PROVIDER,)
    profile = profile or hardware_profile()
    return profile.onnx_provider_order(preference or accelerator_preference())


def _providers_of(session: Any) -> tuple[str, ...]:
    get = getattr(session, "get_providers", None)
    return tuple(get()) if callable(get) else (CPU_PROVIDER,)


class OnnxModel:
    """An ``InferenceSession`` that rebuilds itself on the CPU if its accelerator fails."""

    def __init__(
        self,
        path: Path | str,
        *,
        accelerate: bool = False,
        threads: int | None = None,
        quiet: bool = False,
        profile: HardwareProfile | None = None,
        preference: str | None = None,
    ) -> None:
        self.path = str(path)
        self._threads = threads
        self._quiet = quiet
        self._lock = threading.Lock()
        order = provider_order(accelerate=accelerate, profile=profile, preference=preference)
        order = tuple(p for p in order if (self.path, p) not in _failed) or (CPU_PROVIDER,)
        self._session = self._build_or_fall_back(order)

    @property
    def providers(self) -> tuple[str, ...]:
        """What the session really runs on (the first entry does the work)."""
        return _providers_of(self._session)

    def get_inputs(self) -> list[Any]:
        return self._session.get_inputs()

    def run(self, output_names: Sequence[str] | None, feed: Mapping[str, Any]) -> list[Any]:
        session = self._session
        try:
            return session.run(output_names, feed)
        except Exception as exc:
            if not self._leave_accelerator(session, f"a run failed ({exc})", exc):
                raise
        return self._session.run(output_names, feed)

    def _build(self, order: tuple[str, ...]) -> Any:
        import onnxruntime as ort

        options = ort.SessionOptions()
        if self._threads is not None:
            options.intra_op_num_threads = self._threads
        if self._quiet:
            options.log_severity_level = 3
        return ort.InferenceSession(self.path, sess_options=options, providers=list(order))

    def _build_or_fall_back(self, order: tuple[str, ...]) -> Any:
        try:
            return self._build(order)
        except Exception as exc:
            if order[0] == CPU_PROVIDER:
                raise
            self._remember_failure(order[0], f"the session would not load ({exc})", exc)
            return self._build((CPU_PROVIDER,))

    def _remember_failure(self, provider: str, why: str, exc: BaseException | None) -> None:
        with _failed_lock:
            first = (self.path, provider) not in _failed
            _failed.add((self.path, provider))
        if first:
            log.warning(
                "%s runs on the CPU for this process: %s.", Path(self.path).name, why, exc_info=exc
            )

    def _leave_accelerator(self, session: Any, why: str, exc: BaseException) -> bool:
        with self._lock:
            if session is not self._session:
                return True
            active = _providers_of(session)[:1]
            if not active or active[0] == CPU_PROVIDER:
                return False
            self._remember_failure(active[0], why, exc)
            self._session = self._build((CPU_PROVIDER,))
            return True

"""Host bootstrap status and downloads for first-run ShareCut Studio UX.

CLI ``podcast bootstrap`` remains the contributor path. The GUI calls this
service so first-run never requires a terminal. Downloads stay opt-in (no
network on import or resolve) — same contract as ``util/binaries.py``.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from contextlib import ExitStack
from dataclasses import dataclass
from types import TracebackType
from typing import Any, Literal, TypedDict

from podcast_mcp.engines.models.registry import (
    MODELS,
    ModelSpec,
    model_base,
    model_record,
    model_spec,
    models_for,
    remove_model,
)
from podcast_mcp.engines.models.whisper import (
    catalog_payload,
    resolve_whisper_model,
    whisper_bootstrap_command,
)
from podcast_mcp.services.pipeline.install_failure import (
    InstallFailure,
    classify,
    unexpected_text,
)
from podcast_mcp.util import host_platform
from podcast_mcp.util.asset_sources import DOWNLOAD_TASK_ID, DownloadProgress, cdn_base_configured
from podcast_mcp.util.binaries import (
    FFmpegPairResolutionError,
    resolve_ffmpeg_pair,
)
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.progress import (
    CancelledProgress,
    ProgressReporter,
    ProgressTask,
    raise_if_cancel_requested,
    resolve_progress_task,
)

logger = logging.getLogger(__name__)

DEFAULT_FIRST_RUN_COMPONENTS: tuple[str, ...] = tuple(s.id for s in models_for("required"))
ALL_GUI_COMPONENTS: tuple[str, ...] = tuple(s.id for s in MODELS)


def model_status(
    model_id: str, variant: str | None = None, *, memoize: bool = True
) -> dict[str, Any]:
    """One model's readiness (no download): the record bootstrap status, Pipeline badges, the CLI
    and the diagnostics bundle all read.

    ``state`` is ``installed`` when the registry row reports no problem. A pin mismatch is
    ``update_needed`` with an ``--upgrade`` fix as ``bootstrap``; any other problem is
    ``missing`` with ``hint`` and ``bootstrap``. An unexpected error is reported, never raised.
    """
    spec = model_spec(model_id)
    base = model_base(model_id, variant)
    try:
        record = model_record(model_id, variant, memoize=memoize)
        path = str(spec.location())
    except Exception as exc:  # huggingface_hub / filesystem surprises: report, never raise
        return {**base, "state": "missing", "hint": str(exc), "bootstrap": spec.fix_command}
    return {**base, "path": path, **{k: v for k, v in record.items() if k not in base}}


class UninstallModelResult(TypedDict):
    ok: Literal[True]
    freed_bytes: int
    model: dict[str, Any]


def _model_row(
    model_id: str, variant: str | None, host: host_platform.HostPlatform
) -> dict[str, Any]:
    if model_id == "whisper" and host.transcription == "unavailable":
        return {
            **model_base(model_id, variant),
            "state": "unsupported",
            "hint": host_platform.TRANSCRIPTION_UNAVAILABLE,
        }
    return model_status(model_id, variant)


def uninstall_model(model_id: str, variant: str | None = None) -> UninstallModelResult:
    """Delete one model Studio downloaded and report the record after it, plus the bytes freed.

    Raises ``CodedValueError`` for an unknown id and ``ModelNotRemovable`` for a file the
    person supplied. The caller keeps it away from a running download or job.
    """
    try:
        freed = remove_model(model_id, variant)
    except KeyError as exc:
        raise CodedValueError(f"Unknown model {model_id!r}", code="invalid_request") from exc
    record = model_status(model_id, variant, memoize=False)
    return {"ok": True, "freed_bytes": freed, "model": record}


def component_status(*, whisper_model: str | None = None) -> dict[str, Any]:
    """Return GUI first-run readiness without downloads."""
    model = resolve_whisper_model(requested=whisper_model)
    host = host_platform.current()
    ffmpeg_error = None
    try:
        ffmpeg_pair = resolve_ffmpeg_pair(force_refresh=True)
    except FFmpegPairResolutionError as exc:
        ffmpeg_pair = None
        ffmpeg_error = str(exc)
    ffmpeg_ok = ffmpeg_pair is not None and ffmpeg_pair.is_available()
    ffmpeg_state = (
        "unsupported"
        if host.media_tools == "unavailable"
        else "installed"
        if ffmpeg_ok
        else "missing"
    )
    models = [_model_row(spec.id, model if spec.id == "whisper" else None, host) for spec in MODELS]
    ready = ffmpeg_ok and all(
        row["state"] == "installed" for row in models if row["id"] in DEFAULT_FIRST_RUN_COMPONENTS
    )
    return {
        "ready": ready,
        "cdn_base": cdn_base_configured(),
        "whisper_model": model,
        "whisper_models": catalog_payload(),
        "host": {
            "name": host.name,
            "can_spawn_processes": host.can_spawn_processes,
            "loopback_is_trusted": host.loopback_is_trusted,
            "media_tools": host.media_tools,
            "transcription": host.transcription,
        },
        "tools": {
            "ffmpeg": {
                "state": ffmpeg_state,
                "source": ffmpeg_pair.source if ffmpeg_pair else "not found",
                "hint": ffmpeg_error,
            }
        },
        "models": models,
    }


def _size_text(count: int) -> str:
    if count < 1_000_000:
        return f"{count // 1000} KB"
    if count < 1_000_000_000:
        return f"{count / 1_000_000:.0f} MB"
    return f"{count / 1_000_000_000:.1f} GB"


class _ByteRelay:
    """Turns a model's download progress into the ``bootstrap.bytes`` child task.

    Ticks may arrive on huggingface_hub worker threads, but a restart (bytes back to zero)
    is always reported by the thread running the install, so only that thread opens and
    closes the task. Raises ``CancelledProgress`` once ``cancel_check`` is true. An error that
    is neither cancel nor ``InstallFailure`` fails the open task with the generic text, never
    its own, since the task's fail event reaches every progress consumer.
    """

    def __init__(self, component: str, label: str, cancel_check: Callable[[], bool] | None) -> None:
        self._component = component
        self._label = label
        self._cancel_check = cancel_check
        self._lock = threading.Lock()
        self._stack = ExitStack()
        self._task: ProgressTask | None = None

    def __call__(self, progress: DownloadProgress) -> None:
        raise_if_cancel_requested(self._cancel_check, "Stopping after the current file")
        with self._lock:
            if self._task is None or (progress.bytes == 0 and self._task.current > 0):
                self._stack.close()
                self._task = self._stack.enter_context(
                    resolve_progress_task(DOWNLOAD_TASK_ID, self._component, total=progress.total)
                )
            text = "Downloading…" if progress.bytes == 0 else _size_text(progress.bytes)
            if progress.total is not None and progress.bytes:
                text = f"{text} of {_size_text(progress.total)}"
            self._task.advance_to(progress.bytes, message=text, total=progress.total)

    def __enter__(self) -> _ByteRelay:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if isinstance(exc, Exception) and not isinstance(exc, CancelledProgress | InstallFailure):
            generic = RuntimeError(unexpected_text(self._label))
            self._stack.__exit__(RuntimeError, generic, None)
        else:
            self._stack.__exit__(exc_type, exc, tb)


def install_model(
    spec: ModelSpec,
    *,
    whisper_model: str,
    force: bool = False,
    cancel_check: Callable[[], bool] | None = None,
    persist_preference: bool = True,
) -> dict[str, Any]:
    """Install one registry model; ``whisper_model`` is the variant only Whisper takes.

    ``persist_preference=False`` leaves the saved Whisper default alone (a one-run choice).

    Download progress runs as a ``bootstrap.bytes`` child of the current progress task.
    A known failure raises ``InstallFailure`` (the only place it is classified) after logging
    its cause with the traceback; anything else is a bug and raises as it was. ``cancel_check`` stops a download mid-stream.
    """
    install = spec.install
    if not persist_preference and spec.install_without_preference is not None:
        install = spec.install_without_preference
    with _ByteRelay(spec.id, spec.label, cancel_check) as relay:
        try:
            return install(whisper_model if spec.id == "whisper" else None, force, relay)
        except CancelledProgress:
            raise
        except Exception as exc:
            fix = (
                whisper_bootstrap_command(whisper_model)
                if spec.id == "whisper"
                else spec.fix_command
            )
            failure = classify(exc, label=spec.label, fix=f"{fix} --upgrade")
            if failure is None:
                raise
            logger.warning("bootstrap of %s failed: %s", spec.id, failure.plain, exc_info=exc)
            raise failure from exc


@dataclass(frozen=True)
class BootstrapRequest:
    """What one bootstrap run installs, normalized so two requests compare."""

    components: tuple[str, ...]
    whisper_model: str
    force: bool

    @classmethod
    def of(
        cls,
        components: list[str] | tuple[str, ...] | None = None,
        *,
        whisper_model: str | None = None,
        force: bool = False,
    ) -> BootstrapRequest:
        """Empty ``components`` means the first-run set; unknown ids are refused."""
        wanted = tuple(dict.fromkeys(components or DEFAULT_FIRST_RUN_COMPONENTS))
        unknown = [c for c in wanted if c not in ALL_GUI_COMPONENTS]
        if unknown:
            raise CodedValueError(
                f"unsupported bootstrap components {unknown!r}; "
                f"GUI allows {list(ALL_GUI_COMPONENTS)}",
                code="bootstrap_components_unsupported",
            )
        return cls(wanted, resolve_whisper_model(requested=whisper_model), force)

    def covered_by(self, live: BootstrapRequest) -> bool:
        """Whether a run of ``live`` already does everything this request asks."""
        return (
            set(self.components) <= set(live.components)
            and ("whisper" not in self.components or self.whisper_model == live.whisper_model)
            and (live.force or not self.force)
        )


def run_bootstrap(
    components: list[str] | tuple[str, ...] | None = None,
    *,
    whisper_model: str | None = None,
    force: bool = False,
    progress: ProgressReporter | None = None,
    cancel_check: Callable[[], bool] | None = None,
    on_result: Callable[[str, dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Download selected components; report ProgressReporter events.

    Torch extras are intentionally unsupported here. A bare call
    installs only the required set; every other model downloads when ``components`` names it
    (Studio's Get ready names them all). ``force``
    also re-downloads a pinned Whisper catalog snapshot. A failed component is reported in
    ``results`` (with ``failure`` when its cause is known) and the rest still run; a
    cancel raises ``CancelledProgress`` and ends the run. ``on_result`` hears each
    component's result as soon as it is known.
    """
    request = BootstrapRequest.of(components, whisper_model=whisper_model, force=force)
    results: dict[str, Any] = {}
    total = len(request.components)

    with resolve_progress_task(
        "bootstrap",
        "Bootstrap assets",
        total=total,
        prefer_parent=True,
        progress=progress,
    ) as task:
        for name in request.components:
            raise_if_cancel_requested(cancel_check)
            task.set_phase(name, f"Fetching {name}…")
            spec = model_spec(name)
            try:
                results[name] = install_model(
                    spec,
                    whisper_model=request.whisper_model,
                    force=request.force,
                    cancel_check=cancel_check,
                )
            except CancelledProgress:
                raise
            except InstallFailure as failure:
                results[name] = {
                    "ok": False,
                    "error": failure.plain,
                    "failure": {
                        "kind": failure.kind,
                        "status": failure.status,
                        "plain": failure.plain,
                    },
                }
            except Exception:
                logger.exception("bootstrap of %s failed", name)
                results[name] = {"ok": False, "error": unexpected_text(spec.label)}
            if on_result is not None:
                on_result(name, results[name])
            task.advance(1, message=f"Done {name}", total=total)
        task.message("Bootstrap complete")

    status = component_status(whisper_model=request.whisper_model)
    return {"ok": all(r.get("ok") for r in results.values()), "results": results, **status}

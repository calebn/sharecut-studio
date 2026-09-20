"""Host bootstrap status and downloads for first-run Sharecut Studio UX.

CLI ``podcast bootstrap`` remains the contributor path. The GUI calls this
service so first-run never requires a terminal. Downloads stay opt-in (no
network on import or resolve) — same contract as ``util/binaries.py``.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from podcast_mcp.config import whisper_cache_dir
from podcast_mcp.util.asset_sources import cdn_base_configured
from podcast_mcp.util.binaries import (
    bootstrap_ffmpeg,
    ffmpeg_source,
    resolve_ffmpeg,
    resolve_ffprobe,
)
from podcast_mcp.util.model_assets import bootstrap_rnnoise_model, rnnoise_model_path
from podcast_mcp.util.progress import ProgressReporter, resolve_progress_task
from podcast_mcp.whisper_models import (
    DEFAULT_WHISPER_MODEL,
    bootstrap_whisper_model,
    catalog_payload,
    resolve_whisper_model,
    whisper_model_is_cached,
)

# Consumer first-run defaults: never pull torch / NISQA.
DEFAULT_FIRST_RUN_COMPONENTS: tuple[str, ...] = ("ffmpeg", "whisper")
OPTIONAL_COMPONENTS: tuple[str, ...] = ("rnnoise",)
ALL_GUI_COMPONENTS: tuple[str, ...] = DEFAULT_FIRST_RUN_COMPONENTS + OPTIONAL_COMPONENTS


def _ffmpeg_ready() -> bool:
    if shutil.which("ffmpeg") and shutil.which("ffprobe"):
        return True
    resolved = resolve_ffmpeg()
    if resolved in ("ffmpeg", "ffprobe"):
        return False
    return Path(resolved).is_file() and Path(resolve_ffprobe()).is_file()


def _whisper_ready(model_size: str = DEFAULT_WHISPER_MODEL) -> bool:
    return whisper_model_is_cached(model_size)


def _rnnoise_ready() -> bool:
    return rnnoise_model_path().is_file()


def component_status(*, whisper_model: str | None = None) -> dict[str, Any]:
    """Return readiness for GUI first-run (no downloads)."""
    from podcast_mcp.engines.vad_silero import is_available as silero_available

    model = resolve_whisper_model(requested=whisper_model)
    ffmpeg_ok = _ffmpeg_ready()
    whisper_ok = _whisper_ready(model)
    rnnoise_ok = _rnnoise_ready()
    components = {
        "ffmpeg": {
            "ok": ffmpeg_ok,
            "source": ffmpeg_source(resolve_ffmpeg()) if ffmpeg_ok else "not found",
            "required_for_first_run": True,
        },
        "whisper": {
            "ok": whisper_ok,
            "model": model,
            "cache": str(whisper_cache_dir()),
            "required_for_first_run": True,
        },
        "rnnoise": {
            "ok": rnnoise_ok,
            "path": str(rnnoise_model_path()),
            "required_for_first_run": False,
        },
        "silero-vad": {
            "ok": silero_available(),
            "required_for_first_run": False,
            "note": "bundled with faster-whisper; no download",
        },
    }
    ready = all(
        components[name]["ok"] for name in DEFAULT_FIRST_RUN_COMPONENTS if name in components
    )
    return {
        "ready": ready,
        "cdn_base": cdn_base_configured(),
        "whisper_model": model,
        "whisper_models": catalog_payload(),
        "components": components,
        "default_components": list(DEFAULT_FIRST_RUN_COMPONENTS),
        "optional_components": list(OPTIONAL_COMPONENTS),
    }


def run_bootstrap(
    components: list[str] | tuple[str, ...] | None = None,
    *,
    whisper_model: str | None = None,
    force: bool = False,
    progress: ProgressReporter | None = None,
) -> dict[str, Any]:
    """Download selected components; report ProgressReporter events.

    Torch / NISQA / speaker extras are intentionally unsupported here.
    """
    model = resolve_whisper_model(requested=whisper_model)
    wanted = list(components) if components else list(DEFAULT_FIRST_RUN_COMPONENTS)
    unknown = [c for c in wanted if c not in ALL_GUI_COMPONENTS]
    if unknown:
        raise ValueError(
            f"unsupported bootstrap components {unknown!r}; GUI allows {list(ALL_GUI_COMPONENTS)}"
        )

    results: dict[str, Any] = {}
    total = len(wanted)

    with resolve_progress_task(
        "bootstrap",
        "Bootstrap assets",
        total=total,
        prefer_parent=True,
        progress=progress,
    ) as task:
        for name in wanted:
            task.set_phase(name, f"Fetching {name}…")
            if name == "ffmpeg":
                results[name] = _run_ffmpeg(force=force)
            elif name == "whisper":
                results[name] = _run_whisper(model)
            elif name == "rnnoise":
                results[name] = _run_rnnoise(force=force)
            task.advance(1, message=f"Done {name}", total=total)
        task.message("Bootstrap complete")

    status = component_status(whisper_model=model)
    return {"ok": all(r.get("ok") for r in results.values()), "results": results, **status}


def _run_ffmpeg(*, force: bool) -> dict[str, Any]:
    if not force and shutil.which("ffmpeg") and shutil.which("ffprobe"):
        return {"ok": True, "skipped": True, "reason": "system PATH"}
    try:
        ffmpeg_path, ffprobe_path = bootstrap_ffmpeg(force=force)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    return {
        "ok": True,
        "ffmpeg": str(ffmpeg_path),
        "ffprobe": str(ffprobe_path),
    }


def _run_whisper(model_size: str) -> dict[str, Any]:
    try:
        return bootstrap_whisper_model(model_size)
    except ImportError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _run_rnnoise(*, force: bool) -> dict[str, Any]:
    try:
        path = bootstrap_rnnoise_model(force=force)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "path": str(path)}

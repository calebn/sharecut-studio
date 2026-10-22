"""Host bootstrap status and downloads for first-run ShareCut Studio UX.

CLI ``podcast bootstrap`` remains the contributor path. The GUI calls this
service so first-run never requires a terminal. Downloads stay opt-in (no
network on import or resolve) — same contract as ``util/binaries.py``.
"""

from __future__ import annotations

from typing import Any

from podcast_mcp.engines.models.registry import (
    MODELS,
    ModelProblem,
    ModelSpec,
    model_spec,
    models_for,
)
from podcast_mcp.engines.models.whisper import catalog_payload, resolve_whisper_model
from podcast_mcp.util.asset_sources import cdn_base_configured
from podcast_mcp.util.binaries import (
    FFmpegPairResolutionError,
    resolve_ffmpeg_pair,
)
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.progress import ProgressReporter, resolve_progress_task

DEFAULT_FIRST_RUN_COMPONENTS: tuple[str, ...] = tuple(s.id for s in models_for("required"))
OPTIONAL_COMPONENTS: tuple[str, ...] = tuple(s.id for s in models_for("recommended"))
OPT_IN_COMPONENTS: tuple[str, ...] = tuple(s.id for s in models_for("offered"))
ALL_GUI_COMPONENTS: tuple[str, ...] = tuple(s.id for s in MODELS)


def model_status(
    model_id: str, variant: str | None = None, *, memoize: bool = True
) -> dict[str, Any]:
    """One model's readiness (no download) for bootstrap status and Pipeline badges.

    ``ok: True`` when the registry row reports no problem. A pin mismatch adds
    ``pin_mismatch: true`` and an ``--upgrade`` fix as ``bootstrap``; any other problem
    gets ``hint`` and ``bootstrap``. An unexpected error is reported, never raised.
    """
    spec = model_spec(model_id)
    base: dict[str, Any] = {
        "model": variant or spec.default_variant or spec.id,
        "label": spec.label,
        "size": spec.size,
        "required_for_first_run": spec.setup == "required",
        "opt_in": spec.setup == "offered",
    }
    try:
        problem = spec.problem(variant, memoize)
        base["path"] = str(spec.location())
    except Exception as exc:  # huggingface_hub / filesystem surprises: report, never raise
        problem = ModelProblem(str(exc), spec.fix_command)
    if problem is None:
        return {**base, "ok": True}
    return {
        **base,
        "ok": False,
        **({"pin_mismatch": True} if problem.pin_mismatch else {}),
        "hint": problem.hint,
        "bootstrap": problem.fix,
    }


def component_status(*, whisper_model: str | None = None) -> dict[str, Any]:
    """Return GUI first-run readiness without downloads."""
    model = resolve_whisper_model(requested=whisper_model)
    ffmpeg_error = None
    try:
        ffmpeg_pair = resolve_ffmpeg_pair(force_refresh=True)
    except FFmpegPairResolutionError as exc:
        ffmpeg_pair = None
        ffmpeg_error = str(exc)
    ffmpeg_ok = ffmpeg_pair is not None and ffmpeg_pair.is_available()
    components = {
        "ffmpeg": {
            "ok": ffmpeg_ok,
            "source": ffmpeg_pair.source if ffmpeg_pair else "not found",
            "required_for_first_run": True,
            "hint": ffmpeg_error,
        },
        **{
            spec.id: model_status(spec.id, model if spec.id == "whisper" else None)
            for spec in MODELS
        },
    }
    ready = ffmpeg_ok and all(
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
        "opt_in_components": list(OPT_IN_COMPONENTS),
    }


def install_model(spec: ModelSpec, *, whisper_model: str, force: bool = False) -> dict[str, Any]:
    """Install one registry model; ``whisper_model`` is the variant only Whisper takes."""
    return spec.install(whisper_model if spec.id == "whisper" else None, force)


def run_bootstrap(
    components: list[str] | tuple[str, ...] | None = None,
    *,
    whisper_model: str | None = None,
    force: bool = False,
    progress: ProgressReporter | None = None,
) -> dict[str, Any]:
    """Download selected components; report ProgressReporter events.

    Torch / speaker extras are intentionally unsupported here. Offered models (the word
    aligner, speaker recognition) download only when ``components`` names them. ``force``
    also re-downloads a pinned Whisper catalog snapshot.
    """
    model = resolve_whisper_model(requested=whisper_model)
    wanted = list(components) if components else list(DEFAULT_FIRST_RUN_COMPONENTS)
    unknown = [c for c in wanted if c not in ALL_GUI_COMPONENTS]
    if unknown:
        raise CodedValueError(
            f"unsupported bootstrap components {unknown!r}; GUI allows {list(ALL_GUI_COMPONENTS)}",
            code="bootstrap_components_unsupported",
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
            try:
                results[name] = install_model(model_spec(name), whisper_model=model, force=force)
            except Exception as exc:
                results[name] = {"ok": False, "error": str(exc)}
            task.advance(1, message=f"Done {name}", total=total)
        task.message("Bootstrap complete")

    status = component_status(whisper_model=model)
    return {"ok": all(r.get("ok") for r in results.values()), "results": results, **status}

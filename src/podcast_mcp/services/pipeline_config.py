"""Effective pipeline config, staging, merge, and heuristic Analyze suggestions."""

from __future__ import annotations

import copy
import threading
from pathlib import Path
from typing import Any

from podcast_mcp.config import load_defaults
from podcast_mcp.engines.audio_audit import clipping_indicated
from podcast_mcp.pipeline.meta import (
    ALLOWED_CONFIG_TOP_KEYS,
    PARAM_FIELDS,
    WorkingSet,
    cascade_disable,
    expand_enable,
    get_by_path,
    ordered_step_metas,
    param_fields_payload,
    set_by_path,
    step_meta,
)
from podcast_mcp.pipeline.runner import ORDERED_STEP_NAMES, STEP_NAMES


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for key, val in override.items():
        if key.startswith("_"):
            continue
        if isinstance(val, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], val)
        else:
            out[key] = copy.deepcopy(val)
    return out


def whitelist_overrides(overrides: dict[str, Any] | None) -> dict[str, Any]:
    if not overrides:
        return {}
    return {k: v for k, v in overrides.items() if k in ALLOWED_CONFIG_TOP_KEYS}


def merge_pipeline_config(
    overrides: dict[str, Any] | None = None,
    *,
    base: dict[str, Any] | None = None,
) -> dict[str, Any]:
    root = copy.deepcopy(base) if base is not None else load_defaults()
    return deep_merge(root, whitelist_overrides(overrides))


def default_enabled_steps(config: dict[str, Any] | None = None) -> list[str]:
    cfg = config if config is not None else load_defaults()
    focus_on = bool((cfg.get("focus") or {}).get("enabled"))
    tighten_on = bool((cfg.get("tighten") or {}).get("enabled"))
    enabled: set[str] = set()
    for name in ORDERED_STEP_NAMES:
        meta = step_meta(name)
        if name in ("analyze_focus_cuts", "focus_from_transcript"):
            if focus_on:
                enabled.add(name)
            continue
        if name in ("analyze_fillers_pauses", "tighten_from_transcript"):
            if tighten_on:
                enabled.add(name)
            continue
        if meta.enabled_by_default:
            enabled.add(name)
    ordered: list[str] = []
    seen: set[str] = set()
    for name in ORDERED_STEP_NAMES:
        if name in enabled and name not in seen:
            ordered.append(name)
            seen.add(name)
    return ordered


FOCUS_STEPS = ("analyze_focus_cuts", "focus_from_transcript")
TIGHTEN_STEPS = ("analyze_fillers_pauses", "tighten_from_transcript")


def order_enabled_steps(enabled: set[str]) -> list[str]:
    ordered: list[str] = []
    seen: set[str] = set()
    for name in ORDERED_STEP_NAMES:
        if name in enabled and name not in seen:
            ordered.append(name)
            seen.add(name)
    return ordered


def reconcile_enabled_steps(
    previous: set[str],
    requested: set[str],
) -> list[str]:
    """Honor checklist unchecks via cascade-disable, then expand remaining deps.

    If the client drops a dependency but still lists a dependent, the dependent
    is cascade-cleared so the uncheck sticks.
    """
    removed = previous - requested
    result = set(requested)
    for step_id in removed:
        result = cascade_disable(result | {step_id}, step_id)
    result = expand_enable(result)
    return order_enabled_steps(result)


def editorial_enabled_flags(config: dict[str, Any]) -> tuple[bool, bool]:
    """Return ``(focus.enabled, tighten.enabled)`` from a pipeline config."""
    focus_on = bool((config.get("focus") or {}).get("enabled"))
    tighten_on = bool((config.get("tighten") or {}).get("enabled"))
    return focus_on, tighten_on


def sync_editorial_enabled_steps(
    enabled: set[str],
    config: dict[str, Any],
) -> list[str]:
    """Keep focus/tighten checklist steps aligned with their enabled flags."""
    focus_on, tighten_on = editorial_enabled_flags(config)
    result = set(enabled)
    if focus_on:
        result = expand_enable(result | set(FOCUS_STEPS))
    else:
        for step_id in FOCUS_STEPS:
            result = cascade_disable(result, step_id)
    if tighten_on:
        result = expand_enable(result | set(TIGHTEN_STEPS))
    else:
        for step_id in TIGHTEN_STEPS:
            result = cascade_disable(result, step_id)
    return order_enabled_steps(result)


def skip_steps_from_enabled(enabled: list[str] | set[str]) -> list[str]:
    enabled_set = set(enabled)
    unique = []
    seen: set[str] = set()
    for name in ORDERED_STEP_NAMES:
        if name not in seen:
            seen.add(name)
            unique.append(name)
    return [n for n in unique if n not in enabled_set]


def _selected_whisper_model(config: dict[str, Any] | None) -> str:
    """Model id the runner would use for this config (merged defaults).

    Matches ``PipelineRunner`` / ``load_defaults``: YAML ``transcribe.model``
    wins when env/prefs are unset; env/prefs overlay when set.
    """
    from podcast_mcp.whisper_models import (
        DEFAULT_WHISPER_MODEL,
        validate_whisper_model,
    )

    merged = merge_pipeline_config(config)
    section = merged.get("transcribe")
    raw = section.get("model") if isinstance(section, dict) else None
    if raw is not None and str(raw).strip():
        try:
            return validate_whisper_model(str(raw))
        except ValueError:
            pass
    return DEFAULT_WHISPER_MODEL


def ensure_whisper_cached_for_run(
    *,
    config: dict[str, Any] | None = None,
    from_step: str | None = None,
    only_step: str | None = None,
    skip_steps: list[str] | None = None,
) -> None:
    """Fail fast when selected steps include transcription without weights.

    No-op when ``transcribe_tracks`` is not among the steps that would run.
    """
    from podcast_mcp.pipeline.runner import TRANSCRIBE_STEP, select_pipeline_steps
    from podcast_mcp.whisper_models import ensure_whisper_model_cached

    selected = select_pipeline_steps(from_step, only_step, set(skip_steps or []))
    if TRANSCRIBE_STEP not in {name for name, _ in selected}:
        return
    ensure_whisper_model_cached(_selected_whisper_model(config))


def component_status(*, whisper_model: str | None = None) -> dict[str, Any]:
    """Host component readiness for Pipeline badges.

    ``whisper.ok`` requires both the faster-whisper import **and** on-disk
    weights for ``whisper_model`` (working-set / resolved preference).
    """
    from podcast_mcp.whisper_models import resolve_whisper_model, whisper_model_is_cached

    out: dict[str, Any] = {}
    try:
        import shutil

        from podcast_mcp.util.binaries import resolve_ffmpeg

        path = resolve_ffmpeg()
        ok = Path(path).is_file() or shutil.which(path) is not None
        out["ffmpeg"] = {
            "ok": ok,
            "path": path,
            **(
                {}
                if ok
                else {"hint": "FFmpeg not found - run podcast bootstrap --component ffmpeg"}
            ),
        }
    except Exception as exc:
        out["ffmpeg"] = {"ok": False, "hint": str(exc)}

    try:
        import faster_whisper  # noqa: F401

        model = resolve_whisper_model(requested=whisper_model)
        cached = whisper_model_is_cached(model)
        out["whisper"] = {
            "ok": cached,
            "model": model,
            **(
                {}
                if cached
                else {
                    "hint": (
                        f"Whisper model {model!r} is not downloaded — "
                        "pick Download in the Pipeline tab or run "
                        f"podcast bootstrap --component whisper --whisper-model {model}"
                    ),
                    "bootstrap": "podcast bootstrap --component whisper",
                }
            ),
        }
    except Exception as exc:
        out["whisper"] = {
            "ok": False,
            "hint": f"faster-whisper unavailable: {exc}",
        }

    try:
        from podcast_mcp.util.model_assets import resolve_rnnoise_model

        rnnoise_path = resolve_rnnoise_model()
        out["rnnoise"] = {"ok": True, "path": str(rnnoise_path)}
    except Exception as exc:
        out["rnnoise"] = {
            "ok": False,
            "hint": str(exc),
            "bootstrap": "podcast bootstrap --component rnnoise",
        }
    return out


class PipelineConfigStore:
    """In-memory working-set staging keyed by resolved project path."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._by_path: dict[str, WorkingSet] = {}

    def _key(self, project_path: Path | str) -> str:
        return str(Path(project_path).expanduser().resolve())

    def get(self, project_path: Path | str) -> WorkingSet:
        key = self._key(project_path)
        with self._lock:
            ws = self._by_path.get(key)
            if ws is None:
                cfg = load_defaults()
                ws = WorkingSet(
                    config=copy.deepcopy(cfg),
                    enabled_steps=default_enabled_steps(cfg),
                    unattended=True,
                )
                self._by_path[key] = ws
            return ws

    def put(
        self,
        project_path: Path | str,
        *,
        config: dict[str, Any] | None = None,
        enabled_steps: list[str] | None = None,
        unattended: bool | None = None,
        reset: bool = False,
    ) -> WorkingSet:
        key = self._key(project_path)
        with self._lock:
            if reset or key not in self._by_path:
                base = load_defaults()
                self._by_path[key] = WorkingSet(
                    config=copy.deepcopy(base),
                    enabled_steps=default_enabled_steps(base),
                    unattended=True,
                )
            ws = self._by_path[key]
            if ws.enabled_steps is None:
                previous_enabled = set(default_enabled_steps(ws.config))
            else:
                previous_enabled = set(ws.enabled_steps)
            prev_editorial = editorial_enabled_flags(ws.config)
            if config is not None:
                ws.config = merge_pipeline_config(config, base=load_defaults())
            if enabled_steps is not None:
                ws.enabled_steps = reconcile_enabled_steps(
                    previous_enabled,
                    set(enabled_steps),
                )
            elif config is not None and prev_editorial != editorial_enabled_flags(ws.config):
                ws.enabled_steps = sync_editorial_enabled_steps(
                    previous_enabled,
                    ws.config,
                )
            if unattended is not None:
                ws.unattended = unattended
            return ws


_STORE = PipelineConfigStore()


def config_store() -> PipelineConfigStore:
    return _STORE


def build_config_payload(project_path: Path | str) -> dict[str, Any]:
    from podcast_mcp.whisper_models import catalog_payload

    ws = config_store().get(project_path)
    defaults = load_defaults()
    selected = _selected_whisper_model(ws.config)
    return {
        "defaults": defaults,
        "config": ws.config,
        "enabled_steps": list(
            ws.enabled_steps if ws.enabled_steps is not None else default_enabled_steps(ws.config)
        ),
        "unattended": ws.unattended,
        "steps": ordered_step_metas(),
        "params": param_fields_payload(),
        "components": component_status(whisper_model=selected),
        "whisper_models": catalog_payload(),
        "step_names": list(STEP_NAMES),
    }


def suggest_pipeline_tuning(
    project: Any,
    *,
    base_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Heuristic Analyze: propose config patches from cleanup/health signals."""
    from podcast_mcp.engines.audio_audit import AnalysisPolicy, analyze_cleanup

    defaults = load_defaults()
    base = copy.deepcopy(base_config) if base_config is not None else copy.deepcopy(defaults)
    report = analyze_cleanup(project, policy=AnalysisPolicy.from_defaults(defaults))
    proposed = copy.deepcopy(base)
    reasons: list[dict[str, str]] = []
    effects = dict(proposed.get("effects") or {})
    base_effects = dict(base.get("effects") or {})

    for row in report.get("tracks") or []:
        tid = row.get("track_id", "?")
        health = row.get("health") or {}
        hum_val = health.get("hum")
        hum: dict[str, Any] = hum_val if isinstance(hum_val, dict) else {}
        if hum.get("hum_detected"):
            reasons.append(
                {
                    "code": "hum",
                    "track_id": tid,
                    "message": (
                        f"{tid}: mains hum detected - prefer noise_reduction / higher HPF; "
                        f"{hum.get('recommendation') or ''}"
                    ).strip(),
                }
            )
            if "noise_reduction" not in effects:
                effects["noise_reduction"] = defaults.get("effects", {}).get("noise_reduction", [])

        noise_floor = health.get("noise_floor_db")
        if isinstance(noise_floor, (int, float)) and noise_floor > -50:
            reasons.append(
                {
                    "code": "noise_floor",
                    "track_id": tid,
                    "message": (
                        f"{tid}: elevated noise floor ({noise_floor} dB) - "
                        "consider noise_reduction or rnnoise preset"
                    ),
                }
            )

        gate = row.get("gate_analysis") or {}
        gate_issues = gate.get("issues") or []
        if gate_issues or gate.get("risk") in ("high", "medium"):
            reasons.append(
                {
                    "code": "gate_overreach",
                    "track_id": tid,
                    "message": f"{tid}: gate overreach findings - use milder gate or skip gate",
                }
            )
            if "gate" in effects:
                gate_fx = copy.deepcopy(effects.get("gate") or [])
                for node in gate_fx:
                    params = node.get("params") or {}
                    thr = params.get("threshold_db")
                    if isinstance(thr, (int, float)):
                        params["threshold_db"] = thr - 6.0
                        node["params"] = params
                effects["gate"] = gate_fx

        if row.get("high_bleed_warning"):
            reasons.append(
                {
                    "code": "bleed",
                    "track_id": tid,
                    "message": row["high_bleed_warning"],
                }
            )

        if clipping_indicated(health):
            reasons.append(
                {
                    "code": "clipping",
                    "track_id": tid,
                    "message": (f"{tid}: clipping indicators - keep compression.makeup_db at 0"),
                }
            )
            set_by_path(proposed, "compression.makeup_db", 0.0)

    proposed["effects"] = effects
    patches: dict[str, Any] = {}
    for pf in PARAM_FIELDS:
        before = get_by_path(base, pf.path)
        after = get_by_path(proposed, pf.path)
        if before != after:
            set_by_path(patches, pf.path, after)
    if effects != base_effects:
        patches["effects"] = effects

    return {
        "proposed_config": merge_pipeline_config(patches, base=base),
        "patches": patches,
        "reasons": reasons,
        "report_summary": {
            "track_count": len(report.get("tracks") or []),
            "reason_count": len(reasons),
        },
    }

"""Effective pipeline config, staging, merge, and heuristic Analyze suggestions."""

from __future__ import annotations

import copy
import json
import threading
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any

import yaml

from podcast_mcp.config import load_defaults
from podcast_mcp.effects.presets import resolve_presets
from podcast_mcp.engines.asr_options import AsrOptions
from podcast_mcp.engines.asr_silence import PEAK_BLOCK_SEC
from podcast_mcp.engines.audio_audit import CLIPPING_PEAK_LEVEL_DB, clipping_indicated
from podcast_mcp.pipeline.meta import (
    ALLOWED_CONFIG_TOP_KEYS,
    PARAM_FIELDS,
    WorkingSet,
    cascade_disable,
    expand_enable,
    ordered_step_metas,
    param_fields_payload,
    set_by_path,
    step_meta,
    step_noop_reason,
)
from podcast_mcp.pipeline.runner import ORDERED_STEP_NAMES, STEP_NAMES
from podcast_mcp.util.dicts import deep_merge, get_by_path


def whitelist_overrides(overrides: dict[str, Any] | None) -> dict[str, Any]:
    """Keep only ``ALLOWED_CONFIG_TOP_KEYS``. MCP ``config_json`` / GUI config PUT use this
    filter only; ``effects`` may name custom presets. CLI ``--set`` validates further
    (``parse_config_assignments``).
    """
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


def transcribe_run_config(
    config: dict[str, Any] | None,
    *,
    force: bool,
    overwrite_edited: bool = False,
) -> dict[str, Any] | None:
    """Run-only config for one pipeline run (never persisted); ``config`` unchanged unless ``force``.

    ``force`` re-runs ASR over existing transcripts. ``overwrite_edited`` also replaces
    hand-edited ones in Batch mode: only for an explicit user confirmation (Studio Re-transcribe).
    """
    if not force:
        return config
    override = {"transcribe": {"overwrite": True, "overwrite_edited": overwrite_edited}}
    return deep_merge(merge_pipeline_config(config), override)


FOCUS_STEPS = ("analyze_focus_cuts", "focus_from_transcript")
TIGHTEN_STEPS = ("analyze_fillers_pauses", "tighten_from_transcript")

# Analyze flags a track whose astats noise floor is above this (dBFS).
NOISE_FLOOR_WARN_DB = -50.0

# Analyze flags a dialogue source whose share of digital-silence blocks (from
# engines.asr_silence.peak_envelope) is at or above this as a gated stem, and
# argues for turning transcribe.vad.enabled on.
DIGITAL_SILENCE_VAD_FRACTION = 0.8


def default_enabled_steps(config: dict[str, Any] | None = None) -> list[str]:
    cfg = config if config is not None else load_defaults()
    focus_on, tighten_on = editorial_enabled_flags(cfg)
    enabled: set[str] = set()
    for name in ORDERED_STEP_NAMES:
        if name in FOCUS_STEPS:
            if focus_on:
                enabled.add(name)
            continue
        if name in TIGHTEN_STEPS:
            if tighten_on:
                enabled.add(name)
            continue
        if step_meta(name).enabled_by_default:
            enabled.add(name)
    return order_enabled_steps(enabled)


def pipeline_step_states(config: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """`ordered_step_metas()` rows plus `enabled` and `noop_reason` under `config`."""
    cfg = config if config is not None else load_defaults()
    enabled_ids = set(default_enabled_steps(cfg))
    rows = ordered_step_metas()
    out: list[dict[str, Any]] = []
    for row in rows:
        step_id = row["id"]
        out.append(
            {
                **row,
                "enabled": step_id in enabled_ids,
                "noop_reason": step_noop_reason(step_id, cfg),
            }
        )
    return out


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
    """Return ``(focus.enabled, tighten.enabled)``: each group's first step ``noop_unless`` gate."""
    focus_on = step_noop_reason(FOCUS_STEPS[0], config) is None
    tighten_on = step_noop_reason(TIGHTEN_STEPS[0], config) is None
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

    def peek(self, project_path: Path | str) -> WorkingSet | None:
        """The staged working set, or ``None`` when nothing is staged (never creates one)."""
        with self._lock:
            return self._by_path.get(self._key(project_path))

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


def asr_options_for(project_path: Path | str) -> AsrOptions:
    """ASR options ``pipeline_run`` would use: the staged working set, else shipped defaults.

    Read-only: an unstaged project gets no working-set entry.
    """
    staged = config_store().peek(project_path)
    return AsrOptions.from_defaults(staged.config if staged is not None else load_defaults())


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


def _reason(
    code: str,
    message: str,
    evidence: dict[str, Any],
    *,
    track_id: str | None = None,
    **extra: Any,
) -> dict[str, Any]:
    """One Analyze reason: what was found, why (``evidence``: measured values + thresholds)."""
    out: dict[str, Any] = {"code": code, "message": message, "evidence": evidence}
    if track_id is not None:
        out["track_id"] = track_id
    out.update(extra)
    return out


def _track_evidence(row: dict[str, Any]) -> dict[str, Any]:
    """Per-track numbers from one ``analyze_cleanup`` row (kept even when no reason fires)."""
    health = row.get("health") or {}
    hum_val = health.get("hum")
    hum: dict[str, Any] = hum_val if isinstance(hum_val, dict) else {}
    gate = row.get("gate_analysis") or {}
    return {
        "track_id": row.get("track_id", "?"),
        "noise_floor_db": health.get("noise_floor_db"),
        "peak_level_db": health.get("peak_level_db"),
        "rms_level_db": health.get("rms_level_db"),
        "flat_factor": health.get("flat_factor"),
        "dynamic_range_db": health.get("dynamic_range_db"),
        "hum_detected": bool(hum.get("hum_detected")),
        "gate_risk": gate.get("risk"),
        "gate_issue_count": len(gate.get("issues") or []),
        "bleed_ratio": row.get("bleed_ratio"),
    }


def _dialogue_silence_fractions(
    project: Any, *, peak_dbfs: float
) -> tuple[dict[str, tuple[Path, float]], dict[str, str]]:
    """Digital-silence fraction of each dialogue track's source audio.

    Returns ``(measured, skipped)``: ``skipped`` maps a track id to why it was not
    measured (``missing_audio`` or ``decode_failed``) so callers can report it.
    """
    from podcast_mcp.engines.asr_silence import digital_silence_fraction
    from podcast_mcp.util.tracks import dialogue_track_ids, track_audio_path

    measured: dict[str, tuple[Path, float]] = {}
    skipped: dict[str, str] = {}
    for tid in dialogue_track_ids(project):
        try:
            path = track_audio_path(project, tid)
        except ValueError:
            skipped[tid] = "missing_audio"
            continue
        if not path.is_file():
            skipped[tid] = "missing_audio"
            continue
        frac = digital_silence_fraction(path, peak_dbfs=peak_dbfs)
        if frac is None:
            skipped[tid] = "decode_failed"
            continue
        measured[tid] = (path, frac)
    return measured, skipped


def suggest_pipeline_tuning(
    project: Any,
    *,
    base_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Heuristic Analyze: propose config patches from cleanup/health signals."""
    from podcast_mcp.edits.conversation_align import DURATION_EPS_SEC, equal_duration_dialogue
    from podcast_mcp.engines.audio_audit import AnalysisPolicy, analyze_cleanup

    defaults = load_defaults()
    base = copy.deepcopy(base_config) if base_config is not None else copy.deepcopy(defaults)
    policy = AnalysisPolicy.from_defaults(defaults)
    report = analyze_cleanup(project, policy=policy)
    proposed = copy.deepcopy(base)
    reasons: list[dict[str, Any]] = []
    effects = dict(proposed.get("effects") or {})
    base_effects = dict(base.get("effects") or {})
    presets = resolve_presets(defaults)
    gate_overreach = False
    track_rows: dict[str, dict[str, Any]] = {}

    for row in report.get("tracks") or []:
        tid = row.get("track_id", "?")
        track_rows[tid] = _track_evidence(row)
        health = row.get("health") or {}
        hum_val = health.get("hum")
        hum: dict[str, Any] = hum_val if isinstance(hum_val, dict) else {}
        if hum.get("hum_detected"):
            reasons.append(
                _reason(
                    "hum",
                    (
                        f"{tid}: mains hum detected - prefer noise_reduction / higher HPF; "
                        f"{hum.get('recommendation') or ''}"
                    ).strip(),
                    {
                        "dominant_frequency": hum.get("dominant_frequency"),
                        "energy_ratios": hum.get("energy_ratios"),
                        "threshold_ratio": hum.get("threshold_ratio"),
                    },
                    track_id=tid,
                )
            )
            if "noise_reduction" not in effects:
                effects["noise_reduction"] = copy.deepcopy(presets["noise_reduction"])

        noise_floor = health.get("noise_floor_db")
        if isinstance(noise_floor, (int, float)) and noise_floor > NOISE_FLOOR_WARN_DB:
            reasons.append(
                _reason(
                    "noise_floor",
                    (
                        f"{tid}: elevated noise floor ({noise_floor} dB) - "
                        "consider noise_reduction or rnnoise preset"
                    ),
                    {"noise_floor_db": noise_floor, "threshold_db": NOISE_FLOOR_WARN_DB},
                    track_id=tid,
                )
            )

        gate = row.get("gate_analysis") or {}
        gate_issues = gate.get("issues") or []
        if gate_issues or gate.get("risk") in ("high", "medium"):
            reasons.append(
                _reason(
                    "gate_overreach",
                    f"{tid}: gate overreach findings - proposed a milder gate threshold (-6 dB)",
                    {
                        "risk": gate.get("risk"),
                        "issue_count": len(gate_issues),
                        "issues_sample": gate_issues[:3],
                    },
                    track_id=tid,
                )
            )
            gate_overreach = True

        if row.get("high_bleed_warning"):
            reasons.append(
                _reason(
                    "bleed",
                    row["high_bleed_warning"],
                    {
                        "bleed_ratio": row.get("bleed_ratio"),
                        "bleed_count": row.get("bleed_count"),
                        "warn_ratio": policy.bleed_ratio_warn_threshold,
                    },
                    track_id=tid,
                )
            )

        if clipping_indicated(health):
            reasons.append(
                _reason(
                    "clipping",
                    (
                        f"{tid}: clipping indicators - keep compression.makeup_db at 0 "
                        "(balance_tracks stages level after compression)"
                    ),
                    {
                        "peak_level_db": health.get("peak_level_db"),
                        "flat_factor": health.get("flat_factor"),
                        "peak_limit_db": CLIPPING_PEAK_LEVEL_DB,
                    },
                    track_id=tid,
                )
            )
            set_by_path(proposed, "compression.makeup_db", 0.0)

    pre = equal_duration_dialogue(project)
    if pre is not None:
        ids, dur = pre
        reasons.append(
            _reason(
                "pre_aligned",
                f"Dialogue tracks {', '.join(ids)} all run {dur:.2f}s - likely pre-aligned "
                "(e.g. Zoom per-person stems); uncheck Align tracks (align_tracks holds them "
                "at identity if it runs).",
                {
                    "track_ids": ids,
                    "duration_sec": round(dur, 3),
                    "tolerance_sec": DURATION_EPS_SEC,
                },
                suggested_skip_steps=["align_tracks"],
            )
        )

    # asr describes the *base* config: it is not re-read after the loop below sets
    # transcribe.vad.enabled on `proposed`, so later checks must not rely on it for
    # the proposed value.
    asr = AsrOptions.from_defaults(base)
    silence, silence_skipped = _dialogue_silence_fractions(project, peak_dbfs=asr.silence_peak_dbfs)
    for tid, why in silence_skipped.items():
        row = track_rows.setdefault(tid, {"track_id": tid})
        row["digital_silence_fraction"] = None
        row["digital_silence_skipped"] = why
    for tid, (path, frac) in silence.items():
        track_rows.setdefault(tid, {"track_id": tid})["digital_silence_fraction"] = round(frac, 3)
        if frac >= DIGITAL_SILENCE_VAD_FRACTION:
            reasons.append(
                _reason(
                    "digital_silence",
                    f"{tid}: {frac:.0%} of the source audio is digital silence (peak below "
                    f"{asr.silence_peak_dbfs:g} dBFS; a gated stem) - "
                    + (
                        "VAD at transcribe is on - keep it"
                        if asr.vad_enabled
                        else "proposed transcribe.vad.enabled=true so Whisper skips it"
                    ),
                    {
                        "silent_fraction": round(frac, 3),
                        "threshold_fraction": DIGITAL_SILENCE_VAD_FRACTION,
                        "peak_dbfs": asr.silence_peak_dbfs,
                        "block_sec": PEAK_BLOCK_SEC,
                        "audio": path.name,
                        "vad_enabled": asr.vad_enabled,
                    },
                    track_id=tid,
                )
            )
            if not asr.vad_enabled:
                set_by_path(proposed, "transcribe.vad.enabled", True)

    if gate_overreach:
        # effects.gate is one global chain: lower it by 6 dB once per Analyze
        # call, not once per offending track.
        gate_fx = copy.deepcopy(effects.get("gate") or presets["gate"])
        for node in gate_fx:
            params = node.get("params") or {}
            thr = params.get("threshold_db")
            if isinstance(thr, (int, float)):
                params["threshold_db"] = thr - 6.0
                node["params"] = params
        effects["gate"] = gate_fx

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
            "tracks": list(track_rows.values()),
        },
    }


def _defaults_have_path(defaults: Mapping[str, Any], path: str) -> bool:
    """True when the dotted ``path`` exists (as a key, not just a non-None value) in ``defaults``."""
    cur: Any = defaults
    for part in path.split("."):
        if not isinstance(cur, Mapping) or part not in cur:
            return False
        cur = cur[part]
    return True


def _require_known_presets(
    names: Sequence[str], known_presets: Mapping[str, Any], assignment: str
) -> None:
    """Raise ``ValueError`` naming the first of ``names`` that is not a known effect preset."""
    for name in names:
        if name not in known_presets:
            raise ValueError(
                f"unknown effect preset: {name!r} (in {assignment!r}); "
                f"known: {', '.join(sorted(known_presets))}"
            )


def _require_known_mapping_leaves(
    defaults: Mapping[str, Any], path: str, value: Mapping[str, Any], assignment: str
) -> None:
    """Raise ``ValueError`` naming the first leaf of a ``path={...}`` value missing from ``defaults``."""
    for leaf_path, _leaf in _config_leaves(value, path):
        if not _defaults_have_path(defaults, leaf_path):
            raise ValueError(f"unknown pipeline config key: {leaf_path!r} (in {assignment!r})")


def parse_config_assignments(assignments: Sequence[str]) -> dict[str, Any]:
    """Parse ``path=value`` CLI/agent overrides (``--set``) into a nested override dict.

    ``value`` is parsed as a YAML scalar or flow value (``true``, ``-36``, ``[0.0, 0.2]``,
    ``null``, JSON arrays/objects all parse as YAML). The top-level key must be one of
    ``ALLOWED_CONFIG_TOP_KEYS``; the dotted path, and every leaf key of a mapping value
    (``focus={...}``), must already exist in the shipped defaults, and under ``effects``
    every preset name (dotted ``effects.<preset>`` or the keys of an ``effects={...}``
    mapping) must be a known preset (builtin or the defaults ``effects:`` overlay), so a
    typo raises instead of silently doing nothing.
    """
    defaults = load_defaults()
    known_presets = resolve_presets(defaults)
    out: dict[str, Any] = {}
    for assignment in assignments:
        if "=" not in assignment:
            raise ValueError(f"expected path=value, got {assignment!r}")
        path, _, raw_value = assignment.partition("=")
        path = path.strip()
        if not path:
            raise ValueError(f"empty config key in {assignment!r}")
        parts = path.split(".")
        if not all(parts):
            raise ValueError(f"empty path segment in {assignment!r}")
        top = parts[0]
        if top not in ALLOWED_CONFIG_TOP_KEYS:
            raise ValueError(f"unknown pipeline config key: {top!r} (in {assignment!r})")
        if top != "effects" and not _defaults_have_path(defaults, path):
            raise ValueError(f"unknown pipeline config key: {path!r}")
        if top == "effects" and len(parts) > 1:
            _require_known_presets([parts[1]], known_presets, assignment)
        try:
            value = yaml.safe_load(raw_value) if raw_value else None
        except yaml.YAMLError as exc:
            raise ValueError(f"invalid value for {path!r}: {raw_value!r} ({exc})") from exc
        if top == "effects" and len(parts) == 1:
            if not isinstance(value, Mapping):
                raise ValueError(f"effects must be a mapping of preset names (in {assignment!r})")
            _require_known_presets([str(k) for k in value], known_presets, assignment)
        if top != "effects" and isinstance(value, Mapping):
            _require_known_mapping_leaves(defaults, path, value, assignment)
        set_by_path(out, path, value)
    return out


def _config_leaves(patches: Mapping[str, Any], prefix: str = "") -> Iterator[tuple[str, Any]]:
    """Yield ``(dotted_path, value)`` for each leaf of a nested patch dict."""
    for key, value in patches.items():
        path = f"{prefix}.{key}" if prefix else key
        if isinstance(value, Mapping) and value:
            yield from _config_leaves(value, path)
        else:
            yield path, value


def config_assignments(patches: Mapping[str, Any]) -> list[str]:
    """Flatten a nested patch dict into ``path=json_value`` assignments (inverse of parsing)."""
    return [f"{path}={json.dumps(value)}" for path, value in _config_leaves(patches)]


def config_assignment_paths(patches: Mapping[str, Any]) -> list[str]:
    """Dotted leaf paths of a nested patch dict (the keys ``config_assignments`` would emit)."""
    return [path for path, _value in _config_leaves(patches)]

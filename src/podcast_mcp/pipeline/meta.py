"""Pipeline step graph metadata and curated param field schema for GUI/MCP."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from podcast_mcp.pipeline.runner import ORDERED_STEP_NAMES
from podcast_mcp.whisper_models import DEFAULT_WHISPER_MODEL, WHISPER_SIZE_ENUM

StepKind = Literal["tooling", "gate", "heuristic"]
ParamType = Literal["number", "integer", "boolean", "string", "enum", "object"]


@dataclass(frozen=True)
class StepMeta:
    id: str
    group: str
    title: str
    summary: str
    kind: StepKind = "tooling"
    depends_on: tuple[str, ...] = ()
    requires_components: tuple[str, ...] = ()
    param_sections: tuple[str, ...] = ()
    enabled_by_default: bool = True


@dataclass(frozen=True)
class ParamField:
    path: str
    label: str
    description: str
    type: ParamType
    default: Any = None
    minimum: float | None = None
    maximum: float | None = None
    unit: str | None = None
    enum: tuple[str, ...] | None = None
    group: Literal["common", "advanced"] = "common"
    affects: tuple[str, ...] = ()
    section: str = ""


# Linear spine deps: each step depends on the previous unique logical prereq.
_STEP_DEFS: dict[str, StepMeta] = {
    "ingest_tracks": StepMeta(
        id="ingest_tracks",
        group="transcript",
        title="Ingest tracks",
        summary="Probe audio and validate track paths.",
        requires_components=("ffmpeg",),
    ),
    "transcribe_tracks": StepMeta(
        id="transcribe_tracks",
        group="transcript",
        title="Transcribe tracks",
        summary="faster-whisper ASR per dialogue track.",
        depends_on=("ingest_tracks",),
        requires_components=("whisper",),
        param_sections=("transcribe",),
    ),
    "align_tracks": StepMeta(
        id="align_tracks",
        group="transcript",
        title="Align tracks",
        summary="Place dialogue clips on a shared conversation clock (bleed/gaps).",
        depends_on=("transcribe_tracks",),
        requires_components=("ffmpeg",),
        param_sections=("align",),
    ),
    "require_align_accept": StepMeta(
        id="require_align_accept",
        group="transcript",
        title="Require align accept",
        summary="Gate until align is done, waived, or batch/unattended.",
        kind="gate",
        depends_on=("align_tracks",),
        param_sections=("align",),
    ),
    "merge_transcript": StepMeta(
        id="merge_transcript",
        group="transcript",
        title="Merge transcript",
        summary="Combine per-track transcripts into a time-ordered script.",
        depends_on=("transcribe_tracks",),
    ),
    "render_dialogue_stems": StepMeta(
        id="render_dialogue_stems",
        group="transcript",
        title="Render dialogue stems",
        summary="Pass-1 per-track stems for audibility analysis.",
        depends_on=("ingest_tracks",),
        requires_components=("ffmpeg",),
        param_sections=("performance",),
    ),
    "reconcile_transcript": StepMeta(
        id="reconcile_transcript",
        group="transcript",
        title="Reconcile transcript",
        summary="Audibility / bleed suppressions (runs twice: pre- and post-FX).",
        depends_on=("render_dialogue_stems", "merge_transcript"),
        param_sections=("analysis",),
    ),
    "precorrect_transcript": StepMeta(
        id="precorrect_transcript",
        group="transcript",
        title="Precorrect transcript",
        summary="Glossary replacements and cross-track text sync.",
        depends_on=("reconcile_transcript",),
    ),
    "require_transcript_refine": StepMeta(
        id="require_transcript_refine",
        group="transcript",
        title="Require transcript refine",
        summary="Gate until refine is done, waived, or batch/unattended.",
        kind="gate",
        depends_on=("precorrect_transcript",),
        param_sections=("analysis",),
    ),
    "analyze_focus_cuts": StepMeta(
        id="analyze_focus_cuts",
        group="editorial",
        title="Analyze focus cuts",
        summary="Narrative focus outline (no-op unless focus.enabled).",
        kind="heuristic",
        depends_on=("require_transcript_refine",),
        param_sections=("focus",),
        enabled_by_default=False,
    ),
    "focus_from_transcript": StepMeta(
        id="focus_from_transcript",
        group="editorial",
        title="Apply focus cuts",
        summary="Apply focus decisions (no-op unless focus.auto_apply).",
        kind="heuristic",
        depends_on=("analyze_focus_cuts",),
        param_sections=("focus",),
        enabled_by_default=False,
    ),
    "analyze_fillers_pauses": StepMeta(
        id="analyze_fillers_pauses",
        group="editorial",
        title="Analyze fillers & pauses",
        summary="Mark fillers/long pauses (no-op unless tighten.enabled).",
        kind="heuristic",
        depends_on=("require_transcript_refine",),
        param_sections=("tighten", "inaudible_cuts", "join_continuity"),
        enabled_by_default=False,
    ),
    "tighten_from_transcript": StepMeta(
        id="tighten_from_transcript",
        group="editorial",
        title="Apply tighten cuts",
        summary="Apply filler/pause edits (no-op unless tighten.enabled).",
        kind="heuristic",
        depends_on=("analyze_fillers_pauses",),
        param_sections=("tighten", "inaudible_cuts", "render"),
        enabled_by_default=False,
    ),
    "clean_audio": StepMeta(
        id="clean_audio",
        group="mix",
        title="Clean audio",
        summary="High-pass filter per dialogue track.",
        depends_on=("ingest_tracks",),
        requires_components=("ffmpeg",),
        param_sections=("effects",),
    ),
    "balance_tracks": StepMeta(
        id="balance_tracks",
        group="mix",
        title="Balance tracks",
        summary="Gain-stage dialogue toward target LUFS.",
        depends_on=("clean_audio",),
        requires_components=("ffmpeg",),
        param_sections=("balance",),
    ),
    "compress_tracks": StepMeta(
        id="compress_tracks",
        group="mix",
        title="Compress tracks",
        summary="Speech compression on dialogue stems.",
        depends_on=("balance_tracks",),
        requires_components=("ffmpeg",),
        param_sections=("compression",),
    ),
    "assemble_timeline": StepMeta(
        id="assemble_timeline",
        group="mix",
        title="Assemble timeline",
        summary="Final stems after edits and FX.",
        depends_on=("compress_tracks",),
        requires_components=("ffmpeg",),
        param_sections=("performance", "render"),
    ),
    "mix_with_music": StepMeta(
        id="mix_with_music",
        group="mix",
        title="Mix with music",
        summary="Intro/outro/beds with fade envelopes.",
        depends_on=("assemble_timeline",),
        requires_components=("ffmpeg",),
        param_sections=("mix",),
    ),
    "master_loudness": StepMeta(
        id="master_loudness",
        group="mix",
        title="Master loudness",
        summary="Two-pass loudnorm to podcast targets + QC.",
        depends_on=("mix_with_music",),
        requires_components=("ffmpeg",),
        param_sections=("master",),
    ),
    "export_deliverables": StepMeta(
        id="export_deliverables",
        group="mix",
        title="Export deliverables",
        summary="WAV/MP3 (and configured formats), SRT, markdown.",
        depends_on=("master_loudness",),
        requires_components=("ffmpeg",),
        param_sections=("export", "performance"),
    ),
}

PARAM_FIELDS: tuple[ParamField, ...] = (
    ParamField(
        path="performance.max_workers",
        label="Max workers",
        description="Parallel workers for stem render, filler analysis, and export (0 = auto).",
        type="integer",
        default=0,
        minimum=0,
        maximum=32,
        group="common",
        section="performance",
        affects=(
            "render_dialogue_stems",
            "assemble_timeline",
            "analyze_fillers_pauses",
            "export_deliverables",
        ),
    ),
    ParamField(
        path="transcribe.model",
        label="Whisper model",
        description="faster-whisper model (default large-v3-turbo; smaller sizes at setup).",
        type="enum",
        default=DEFAULT_WHISPER_MODEL,
        enum=WHISPER_SIZE_ENUM,
        group="common",
        section="transcribe",
        affects=("transcribe_tracks",),
    ),
    ParamField(
        path="transcribe.language",
        label="Language",
        description="ASR language code (e.g. en).",
        type="string",
        default="en",
        group="common",
        section="transcribe",
        affects=("transcribe_tracks",),
    ),
    ParamField(
        path="analysis.transcript_refine.mode",
        label="Refine gate mode",
        description="require = always block; waive_unattended = auto-waive in batch; off = skip gate.",
        type="enum",
        default="waive_unattended",
        enum=("require", "waive_unattended", "off"),
        group="common",
        section="analysis",
        affects=("require_transcript_refine",),
    ),
    ParamField(
        path="align.accept.mode",
        label="Align accept mode",
        description="require = always block; waive_unattended = auto-waive in batch; off = skip gate.",
        type="enum",
        default="waive_unattended",
        enum=("require", "waive_unattended", "off"),
        group="common",
        section="align",
        affects=("require_align_accept",),
    ),
    ParamField(
        path="align.max_offset_sec",
        label="Align max offset",
        description=(
            "Gap search range in seconds. 0 = auto from longest dialogue file. "
            "Coarse occupancy uses a hierarchical sweep (not a 0.5s walk of the "
            "full span). Late-join still uses this bound."
        ),
        type="number",
        default=0.0,
        minimum=0.0,
        maximum=7200.0,
        group="advanced",
        section="align",
        affects=("align_tracks",),
    ),
    ParamField(
        path="align.bleed_ngram",
        label="Bleed n-gram size",
        description="Phrase length for cross-track bleed clock matches.",
        type="integer",
        default=3,
        minimum=2,
        maximum=6,
        group="advanced",
        section="align",
        affects=("align_tracks",),
    ),
    ParamField(
        path="align.min_bleed_matches",
        label="Min bleed matches",
        description="Agreed bleed n-grams required before trusting the bleed clock.",
        type="integer",
        default=2,
        minimum=1,
        maximum=20,
        group="advanced",
        section="align",
        affects=("align_tracks",),
    ),
    ParamField(
        path="align.bleed_identity_sec",
        label="Bleed identity threshold",
        description=(
            "When |bleed Δt| is below this, confirm with waveform xcorr before "
            "applying or holding identity."
        ),
        type="number",
        default=1.0,
        minimum=0.0,
        maximum=30.0,
        group="advanced",
        section="align",
        affects=("align_tracks",),
    ),
    ParamField(
        path="align.acoustic_min_peak",
        label="Acoustic min peak",
        description="Minimum waveform correlation peak to trust acoustic confirm.",
        type="number",
        default=0.05,
        minimum=0.0,
        maximum=1.0,
        group="advanced",
        section="align",
        affects=("align_tracks",),
    ),
    ParamField(
        path="align.coarse_step_sec",
        label="Align coarse step",
        description="Coarse occupancy sweep step in seconds (hierarchical for large bounds).",
        type="number",
        default=0.5,
        minimum=0.05,
        maximum=8.0,
        group="advanced",
        section="align",
        affects=("align_tracks",),
    ),
    ParamField(
        path="align.fine_step_sec",
        label="Align fine step",
        description="Fine occupancy refine step in seconds around the coarse peak.",
        type="number",
        default=0.02,
        minimum=0.005,
        maximum=0.5,
        group="advanced",
        section="align",
        affects=("align_tracks",),
    ),
    ParamField(
        path="align.acoustic_floor_sec",
        label="Acoustic floor",
        description="Treat |acoustic lag| below this as already synced (hold identity).",
        type="number",
        default=0.05,
        minimum=0.0,
        maximum=1.0,
        group="advanced",
        section="align",
        affects=("align_tracks",),
    ),
    ParamField(
        path="align.acoustic_agree_sec",
        label="Acoustic agree window",
        description="Max |acoustic - bleed| to apply the acoustic offset.",
        type="number",
        default=0.25,
        minimum=0.0,
        maximum=2.0,
        group="advanced",
        section="align",
        affects=("align_tracks",),
    ),
    ParamField(
        path="align.max_word_audibility_sec",
        label="Align max word duration",
        description="Drop stretched ASR words longer than this from occupancy.",
        type="number",
        default=2.0,
        minimum=0.2,
        maximum=30.0,
        group="advanced",
        section="align",
        affects=("align_tracks",),
    ),
    ParamField(
        path="focus.enabled",
        label="Focus enabled",
        description="Run focus analyze step (outline). Apply still needs focus.auto_apply.",
        type="boolean",
        default=False,
        group="common",
        section="focus",
        affects=("analyze_focus_cuts", "focus_from_transcript"),
    ),
    ParamField(
        path="focus.auto_apply",
        label="Focus auto-apply",
        description="Apply focus cuts without review when focus.enabled.",
        type="boolean",
        default=False,
        group="advanced",
        section="focus",
        affects=("focus_from_transcript",),
    ),
    ParamField(
        path="tighten.enabled",
        label="Tighten enabled",
        description="Run filler/pause analyze and apply (off until join quality is trusted).",
        type="boolean",
        default=False,
        group="common",
        section="tighten",
        affects=("analyze_fillers_pauses", "tighten_from_transcript"),
    ),
    ParamField(
        path="tighten.edit_mode",
        label="Tighten edit mode",
        description="ripple = cut and close the gap; mute = silence in place (pause hits skipped).",
        type="enum",
        default="ripple",
        enum=("ripple", "mute"),
        group="common",
        section="tighten",
        affects=("analyze_fillers_pauses", "tighten_from_transcript"),
    ),
    ParamField(
        path="tighten.max_pause_sec",
        label="Max pause (sec)",
        description="Long pauses above this are candidates for tightening.",
        type="number",
        default=1.2,
        minimum=0.2,
        maximum=5.0,
        unit="sec",
        group="common",
        section="tighten",
        affects=("analyze_fillers_pauses", "tighten_from_transcript"),
    ),
    ParamField(
        path="tighten.min_retained_pause_sec",
        label="Min retained pause",
        description="Floor left after trimming a long pause (turn/dead-air).",
        type="number",
        default=0.18,
        minimum=0.0,
        maximum=2.0,
        unit="sec",
        group="advanced",
        section="tighten",
        affects=("tighten_from_transcript",),
    ),
    ParamField(
        path="tighten.crossfade_ms",
        label="Tighten crossfade",
        description="Crossfade at tighten joins.",
        type="integer",
        default=25,
        minimum=0,
        maximum=200,
        unit="ms",
        group="advanced",
        section="tighten",
        affects=("tighten_from_transcript",),
    ),
    ParamField(
        path="tighten.discourse_pause_sec",
        label="Discourse pause (sec)",
        description=(
            "Min pause on either side that lets a discourse marker become a cut "
            "candidate. Marker tokens (`tighten.discourse_markers`) are YAML-only — "
            "Advanced has no list widget."
        ),
        type="number",
        default=0.35,
        minimum=0.0,
        maximum=5.0,
        unit="sec",
        group="advanced",
        section="tighten",
        affects=("analyze_fillers_pauses", "tighten_from_transcript"),
    ),
    ParamField(
        path="tighten.discourse_confidence_max",
        label="Discourse ASR max",
        description=(
            "ASR confidence below this lets a discourse marker become a cut candidate. "
            "Marker tokens (`tighten.discourse_markers`) are YAML-only — Advanced has "
            "no list widget."
        ),
        type="number",
        default=0.6,
        minimum=0.0,
        maximum=1.0,
        group="advanced",
        section="tighten",
        affects=("analyze_fillers_pauses", "tighten_from_transcript"),
    ),
    ParamField(
        path="balance.dialogue_lufs",
        label="Dialogue LUFS",
        description="Target integrated loudness for dialogue gain staging.",
        type="number",
        default=-20.0,
        minimum=-30.0,
        maximum=-10.0,
        unit="LUFS",
        group="common",
        section="balance",
        affects=("balance_tracks",),
    ),
    ParamField(
        path="compression.threshold_db",
        label="Comp threshold",
        description="acompressor threshold.",
        type="number",
        default=-18.0,
        minimum=-40.0,
        maximum=0.0,
        unit="dB",
        group="common",
        section="compression",
        affects=("compress_tracks",),
    ),
    ParamField(
        path="compression.ratio",
        label="Comp ratio",
        description="acompressor ratio.",
        type="number",
        default=3.0,
        minimum=1.0,
        maximum=20.0,
        group="common",
        section="compression",
        affects=("compress_tracks",),
    ),
    ParamField(
        path="compression.attack_ms",
        label="Comp attack",
        description="Attack time in milliseconds.",
        type="number",
        default=15.0,
        minimum=0.1,
        maximum=200.0,
        unit="ms",
        group="advanced",
        section="compression",
        affects=("compress_tracks",),
    ),
    ParamField(
        path="compression.release_ms",
        label="Comp release",
        description="Release time in milliseconds.",
        type="number",
        default=150.0,
        minimum=1.0,
        maximum=2000.0,
        unit="ms",
        group="advanced",
        section="compression",
        affects=("compress_tracks",),
    ),
    ParamField(
        path="compression.makeup_db",
        label="Comp makeup",
        description="Makeup gain after compression (0 when balance already stages LUFS).",
        type="number",
        default=0.0,
        minimum=-12.0,
        maximum=12.0,
        unit="dB",
        group="common",
        section="compression",
        affects=("compress_tracks",),
    ),
    ParamField(
        path="master.integrated_lufs",
        label="Master LUFS",
        description="Target integrated loudness for two-pass loudnorm.",
        type="number",
        default=-16.0,
        minimum=-24.0,
        maximum=-8.0,
        unit="LUFS",
        group="common",
        section="master",
        affects=("master_loudness",),
    ),
    ParamField(
        path="master.true_peak_db",
        label="True peak",
        description="True-peak ceiling for loudnorm.",
        type="number",
        default=-1.5,
        minimum=-6.0,
        maximum=0.0,
        unit="dBTP",
        group="common",
        section="master",
        affects=("master_loudness",),
    ),
    ParamField(
        path="master.lra",
        label="Loudness range",
        description="loudnorm LRA ceiling.",
        type="number",
        default=11.0,
        minimum=1.0,
        maximum=20.0,
        unit="LU",
        group="advanced",
        section="master",
        affects=("master_loudness",),
    ),
    ParamField(
        path="mix.music_under_vo_db",
        label="Music under VO",
        description="Bed level under dialogue.",
        type="number",
        default=-18.0,
        minimum=-40.0,
        maximum=0.0,
        unit="dB",
        group="common",
        section="mix",
        affects=("mix_with_music",),
    ),
    ParamField(
        path="mix.fade_in_sec",
        label="Mix fade in",
        description="Intro fade-in length.",
        type="number",
        default=2.0,
        minimum=0.0,
        maximum=30.0,
        unit="sec",
        group="advanced",
        section="mix",
        affects=("mix_with_music",),
    ),
    ParamField(
        path="mix.fade_out_sec",
        label="Mix fade out",
        description="Outro fade-out length.",
        type="number",
        default=3.0,
        minimum=0.0,
        maximum=30.0,
        unit="sec",
        group="advanced",
        section="mix",
        affects=("mix_with_music",),
    ),
    ParamField(
        path="export.wav",
        label="Export WAV",
        description="Write mastered WAV deliverable.",
        type="boolean",
        default=True,
        group="common",
        section="export",
        affects=("export_deliverables",),
    ),
    ParamField(
        path="inaudible_cuts.enabled",
        label="Inaudible cuts",
        description="Snap cut boundaries with waveform heuristics.",
        type="boolean",
        default=True,
        group="advanced",
        section="inaudible_cuts",
        affects=("tighten_from_transcript",),
    ),
)

ALLOWED_CONFIG_TOP_KEYS = frozenset(
    {
        "performance",
        "master",
        "balance",
        "compression",
        "focus",
        "tighten",
        "render",
        "mix",
        "transcribe",
        "analysis",
        "inaudible_cuts",
        "export",
        "effects",
        "social_clips",
        "join_continuity",
        "align",
    }
)

GROUP_ORDER = ("transcript", "editorial", "mix", "global")


def step_meta(step_id: str) -> StepMeta:
    if step_id not in _STEP_DEFS:
        raise KeyError(step_id)
    return _STEP_DEFS[step_id]


def ordered_step_metas() -> list[dict[str, Any]]:
    """One entry per occurrence in ORDERED_STEP_NAMES (reconcile appears twice)."""
    out: list[dict[str, Any]] = []
    for i, name in enumerate(ORDERED_STEP_NAMES):
        meta = _STEP_DEFS[name]
        out.append(
            {
                "id": name,
                "index": i,
                "group": meta.group,
                "title": meta.title,
                "summary": meta.summary,
                "kind": meta.kind,
                "depends_on": list(meta.depends_on),
                "requires_components": list(meta.requires_components),
                "param_sections": list(meta.param_sections),
                "enabled_by_default": meta.enabled_by_default,
            }
        )
    return out


def param_fields_payload() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for p in PARAM_FIELDS:
        row: dict[str, Any] = {
            "path": p.path,
            "label": p.label,
            "description": p.description,
            "type": p.type,
            "default": p.default,
            "group": p.group,
            "section": p.section,
            "affects": list(p.affects),
        }
        if p.minimum is not None:
            row["minimum"] = p.minimum
        if p.maximum is not None:
            row["maximum"] = p.maximum
        if p.unit:
            row["unit"] = p.unit
        if p.enum:
            row["enum"] = list(p.enum)
        rows.append(row)
    return rows


def transitive_depends_on(step_id: str, *, seen: set[str] | None = None) -> set[str]:
    if seen is None:
        seen = set()
    if step_id in seen:
        return seen
    seen.add(step_id)
    meta = _STEP_DEFS.get(step_id)
    if not meta:
        return seen
    for dep in meta.depends_on:
        transitive_depends_on(dep, seen=seen)
    return seen


def dependents_of(step_id: str) -> set[str]:
    """Steps that list ``step_id`` in depends_on (direct + transitive via closure)."""
    direct = {sid for sid, m in _STEP_DEFS.items() if step_id in m.depends_on}
    out = set(direct)
    for d in list(direct):
        out |= dependents_of(d)
    return out


def expand_enable(step_ids: set[str]) -> set[str]:
    out = set(step_ids)
    for sid in list(step_ids):
        out |= transitive_depends_on(sid)
    return {s for s in out if s in _STEP_DEFS}


def cascade_disable(enabled: set[str], disabled_id: str) -> set[str]:
    drop = {disabled_id} | dependents_of(disabled_id)
    return {s for s in enabled if s not in drop}


@dataclass
class WorkingSet:
    """Session staging for GUI/agent shared pipeline config."""

    config: dict[str, Any] = field(default_factory=dict)
    enabled_steps: list[str] | None = None
    unattended: bool = True


def get_by_path(data: dict[str, Any], path: str) -> Any:
    cur: Any = data
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def set_by_path(data: dict[str, Any], path: str, value: Any) -> None:
    parts = path.split(".")
    cur = data
    for part in parts[:-1]:
        nxt = cur.get(part)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[part] = nxt
        cur = nxt
    cur[parts[-1]] = value

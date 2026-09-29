"""Pipeline step graph metadata and curated param field schema for GUI/MCP."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from podcast_mcp.config import DEFAULT_PREMIX_PEAK_CEILING_DB
from podcast_mcp.edits.tighten_intensity import DEFAULT_TIGHTEN_INTENSITY, TIGHTEN_INTENSITIES
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
    noop_unless: str | None = None


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
    # Depends on precorrect, not the require_transcript_refine gate (unlike its editorial
    # siblings): it only reads word timings and never mutates the timeline, and any later
    # refine edit changes the words fingerprint, so the profile reads stale until the next
    # run. Unchecking the gate therefore leaves this step enabled on purpose.
    "analyze_prosody": StepMeta(
        id="analyze_prosody",
        group="editorial",
        title="Analyze prosody",
        summary="Cache a per-track prosody profile (pitch, rate, energy, boundaries).",
        kind="tooling",
        depends_on=("precorrect_transcript",),
        param_sections=("prosody",),
        noop_unless="prosody.enabled",
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
        noop_unless="focus.enabled",
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
        noop_unless="focus.auto_apply",
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
        noop_unless="tighten.enabled",
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
        noop_unless="tighten.enabled",
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
    "compress_tracks": StepMeta(
        id="compress_tracks",
        group="mix",
        title="Compress tracks",
        summary="Speech compression on dialogue stems.",
        depends_on=("clean_audio",),
        requires_components=("ffmpeg",),
        param_sections=("compression",),
    ),
    "balance_tracks": StepMeta(
        id="balance_tracks",
        group="mix",
        title="Balance tracks",
        summary="Gain-stage dialogue to target LUFS, measured after FX on each speaker's own speech.",
        depends_on=("compress_tracks",),
        requires_components=("ffmpeg",),
        param_sections=("balance",),
    ),
    "assemble_timeline": StepMeta(
        id="assemble_timeline",
        group="mix",
        title="Assemble timeline",
        summary="Final stems after edits and FX.",
        depends_on=("balance_tracks",),
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
        path="transcribe.overwrite",
        label="Re-transcribe existing",
        description=(
            "Re-run ASR even when a transcript exists. Off reuses stored transcripts and "
            "keeps hand edits; changed audio always re-transcribes."
        ),
        type="boolean",
        default=False,
        group="advanced",
        section="transcribe",
        affects=("transcribe_tracks",),
    ),
    ParamField(
        path="transcribe.vad.enabled",
        label="Skip silence (VAD)",
        description="Run Silero VAD before Whisper so silent stretches are not transcribed (stops hallucinated text).",
        type="boolean",
        default=True,
        group="common",
        section="transcribe",
        affects=("transcribe_tracks",),
    ),
    ParamField(
        path="transcribe.vad.threshold",
        label="VAD threshold",
        description="Speech probability above which audio counts as speech.",
        type="number",
        default=0.4,
        group="advanced",
        section="transcribe",
        affects=("transcribe_tracks",),
        minimum=0.0,
        maximum=1.0,
    ),
    ParamField(
        path="transcribe.vad.min_silence_duration_ms",
        label="VAD min silence (ms)",
        description="Silence shorter than this does not split speech.",
        type="number",
        default=500,
        group="advanced",
        section="transcribe",
        affects=("transcribe_tracks",),
        minimum=0,
        maximum=60000,
    ),
    ParamField(
        path="transcribe.vad.speech_pad_ms",
        label="VAD speech pad (ms)",
        description="Padding kept around detected speech.",
        type="number",
        default=300,
        group="advanced",
        section="transcribe",
        affects=("transcribe_tracks",),
        minimum=0,
        maximum=10000,
    ),
    ParamField(
        path="transcribe.decode.condition_on_previous_text",
        label="Condition on previous text",
        description="Feed earlier text into later windows. Off avoids repetition loops; the vocabulary prompt then goes to hotwords.",
        type="boolean",
        default=True,
        group="advanced",
        section="transcribe",
        affects=("transcribe_tracks",),
    ),
    ParamField(
        path="transcribe.decode.hallucination_silence_threshold",
        label="Hallucination silence skip (s)",
        description="Skip silent gaps longer than this when a hallucination is suspected; 0 = off.",
        type="number",
        default=2.0,
        group="advanced",
        section="transcribe",
        affects=("transcribe_tracks",),
        minimum=0.0,
        maximum=60.0,
    ),
    ParamField(
        path="transcribe.silence_filter.enabled",
        label="Flag words over silence",
        description="Mark words whose own-track audio is digital silence as suspect_hallucination (never deleted).",
        type="boolean",
        default=True,
        group="advanced",
        section="transcribe",
        affects=("transcribe_tracks",),
    ),
    ParamField(
        path="transcribe.silence_filter.peak_dbfs",
        label="Silence peak (dBFS)",
        description="Words whose own-track peak is below this level are flagged suspect_hallucination.",
        type="number",
        default=-60.0,
        group="advanced",
        section="transcribe",
        affects=("transcribe_tracks",),
        minimum=-120.0,
        maximum=0.0,
    ),
    ParamField(
        path="transcribe.forced_alignment.enabled",
        label="Precise word boundaries",
        description=(
            "Re-time Whisper's words with a local forced aligner (English, ~360 MB). "
            "On by default once the aligner is downloaded (below this field or with "
            "podcast bootstrap --component word-aligner) and unavailable until then. "
            "Off keeps Whisper's timestamps. Re-time words re-times stored transcripts from "
            "the ASR cache without re-running Whisper."
        ),
        type="boolean",
        default=None,
        group="advanced",
        section="transcribe",
        affects=("transcribe_tracks",),
    ),
    ParamField(
        path="transcribe.forced_alignment.min_word_score",
        label="Aligner evidence floor",
        description=(
            "Words the forced aligner (precise word boundaries) placed with a mean character "
            "probability below this are flagged suspect_hallucination (never deleted). Stored "
            "scores keep flagging after precise word boundaries is turned off. 0 = off."
        ),
        type="number",
        default=0.01,
        group="advanced",
        section="transcribe",
        affects=("transcribe_tracks",),
        minimum=0.0,
        maximum=1.0,
    ),
    ParamField(
        path="transcribe.decode.no_speech_threshold",
        label="No-speech threshold",
        description="A window counts as silent when Whisper's no-speech probability is above this and its log probability is low.",
        type="number",
        default=0.6,
        group="advanced",
        section="transcribe",
        affects=("transcribe_tracks",),
        minimum=0.0,
        maximum=1.0,
    ),
    ParamField(
        path="transcribe.decode.log_prob_threshold",
        label="Log-prob threshold",
        description="Retry a window at a higher temperature when its average log probability is below this.",
        type="number",
        default=-1.0,
        group="advanced",
        section="transcribe",
        affects=("transcribe_tracks",),
        minimum=-10.0,
        maximum=0.0,
    ),
    ParamField(
        path="transcribe.decode.compression_ratio_threshold",
        label="Compression ratio threshold",
        description="Retry a window whose text compresses better than this (a repetition loop).",
        type="number",
        default=2.4,
        group="advanced",
        section="transcribe",
        affects=("transcribe_tracks",),
        minimum=0.0,
        maximum=20.0,
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
        path="align.realign",
        label="Re-align locked stems",
        description="Re-score equal-length and manifest-pinned stems instead of holding their placement.",
        type="boolean",
        default=False,
        group="advanced",
        section="align",
        affects=("align_tracks",),
    ),
    ParamField(
        path="align.large_move_sec",
        label="Large move threshold (s)",
        description=(
            "Moves above this need waveform confirmation, are never auto-waived unattended, "
            "and fail export QC until accepted."
        ),
        type="number",
        default=1.0,
        minimum=0.1,
        maximum=30,
        group="common",
        section="align",
        affects=("align_tracks", "require_align_accept", "export_deliverables"),
    ),
    ParamField(
        path="align.large_move_min_peak",
        label="Large move min xcorr peak",
        description="Minimum correlation peak when confirming a large move against the waveform.",
        type="number",
        default=0.1,
        minimum=0,
        maximum=1,
        group="advanced",
        section="align",
        affects=("align_tracks",),
    ),
    ParamField(
        path="align.min_bleed_matches",
        label="Min bleed matches",
        description="Agreed bleed n-grams required before trusting the bleed clock.",
        type="integer",
        default=5,
        minimum=1,
        maximum=20,
        group="advanced",
        section="align",
        affects=("align_tracks",),
    ),
    ParamField(
        path="align.bleed_min_share",
        label="Bleed agreement share",
        description="Weighted share of matched n-grams that must agree (common filler counts less).",
        type="number",
        default=0.3,
        minimum=0.0,
        maximum=1.0,
        group="advanced",
        section="align",
        affects=("align_tracks",),
    ),
    ParamField(
        path="align.bleed_identity_sec",
        label="Bleed identity threshold",
        description=(
            "When |bleed Δt| is below this, confirm with waveform xcorr before "
            "applying or holding identity. Capped at align.large_move_sec."
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
        path="prosody.enabled",
        label="Prosody enabled",
        description="Cache a per-track prosody profile (pitch, rate, energy, boundaries).",
        type="boolean",
        default=True,
        group="common",
        section="prosody",
        affects=("analyze_prosody",),
    ),
    ParamField(
        path="prosody.pitch_floor_hz",
        label="Pitch floor",
        description="Lower F0 bound for pitch tracking (Praat to_pitch_ac).",
        type="number",
        default=75.0,
        minimum=40.0,
        maximum=300.0,
        unit="Hz",
        group="advanced",
        section="prosody",
        affects=("analyze_prosody",),
    ),
    ParamField(
        path="prosody.pitch_ceiling_hz",
        label="Pitch ceiling",
        description="Upper F0 bound for pitch tracking (Praat to_pitch_ac).",
        type="number",
        default=500.0,
        minimum=150.0,
        maximum=1000.0,
        unit="Hz",
        group="advanced",
        section="prosody",
        affects=("analyze_prosody",),
    ),
    ParamField(
        path="prosody.segment_gap_sec",
        label="Prosody segment gap",
        description="Word gaps at or under this merge into one prosody segment.",
        type="number",
        default=1.0,
        minimum=0.1,
        maximum=10.0,
        unit="sec",
        group="advanced",
        section="prosody",
        affects=("analyze_prosody",),
    ),
    ParamField(
        path="prosody.pause_min_sec",
        label="Prosody pause floor",
        description="Shortest interior sub-floor run counted as a pause.",
        type="number",
        default=0.25,
        minimum=0.05,
        maximum=5.0,
        unit="sec",
        group="advanced",
        section="prosody",
        affects=("analyze_prosody",),
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
        path="tighten.intensity",
        label="Tighten intensity",
        description=(
            "light = clear um/uh only, keep at least 0.5 s of every pause; medium = "
            "defaults; aggressive = isolated fillers, borderline discourse markers, "
            "0.3 s solo pauses. light/aggressive override the tighten keys they name."
        ),
        type="enum",
        default=DEFAULT_TIGHTEN_INTENSITY,
        enum=TIGHTEN_INTENSITIES,
        group="common",
        section="tighten",
        affects=("analyze_fillers_pauses",),
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
        path="tighten.acoustic_gap_filler.enabled",
        label="Acoustic gap fillers",
        description=(
            "Propose review-only `filler:acoustic` cuts for voiced audio inside ASR "
            "word gaps (never auto-applied; listen first)."
        ),
        type="boolean",
        default=True,
        group="advanced",
        section="tighten",
        affects=("analyze_fillers_pauses", "tighten_from_transcript"),
    ),
    ParamField(
        path="tighten.acoustic_gap_filler.min_gap_sec",
        label="Acoustic min gap",
        description="Shortest inter-word gap scanned for voiced audio (floor 0.35 s).",
        type="number",
        default=0.35,
        minimum=0.35,
        maximum=10.0,
        unit="sec",
        group="advanced",
        section="tighten",
        affects=("analyze_fillers_pauses", "tighten_from_transcript"),
    ),
    ParamField(
        path="tighten.acoustic_gap_filler.max_run_sec",
        label="Acoustic max run",
        description="Longest voiced run proposed as one acoustic filler (ceiling 1.5 s).",
        type="number",
        default=1.5,
        minimum=0.1,
        maximum=1.5,
        unit="sec",
        group="advanced",
        section="tighten",
        affects=("analyze_fillers_pauses", "tighten_from_transcript"),
    ),
    ParamField(
        path="tighten.acoustic_gap_filler.max_frames",
        label="Acoustic max frames",
        description=(
            "10 ms analysis frames per gap (ceiling 600, about 6 s); longer gaps are skipped."
        ),
        type="integer",
        default=600,
        minimum=20,
        maximum=600,
        group="advanced",
        section="tighten",
        affects=("analyze_fillers_pauses", "tighten_from_transcript"),
    ),
    ParamField(
        path="tighten.acoustic_gap_filler.vad_backend",
        label="Acoustic breath VAD",
        description="Breath rejection backend for acoustic gap candidates (Silero is opt-in).",
        type="enum",
        default="heuristic",
        enum=("heuristic", "silero"),
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
        description=(
            "Makeup gain after compression; leave at 0: balance_tracks runs after "
            "compression and stages LUFS on the compressed signal."
        ),
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
        path="mix.premix_peak_ceiling_db",
        label="Premix peak ceiling",
        description="True-peak ceiling the unity-sum premix is trimmed under before mastering.",
        type="number",
        default=DEFAULT_PREMIX_PEAK_CEILING_DB,
        minimum=-12.0,
        maximum=0.0,
        unit="dBTP",
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
        "prosody",
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


def step_noop_reason(step_id: str, config: dict[str, Any]) -> str | None:
    """Why ``step_id`` is a no-op under ``config``, or None when it actually runs work."""
    from podcast_mcp.util.dicts import get_by_path

    meta = step_meta(step_id)
    path = meta.noop_unless
    if path is None:
        return None
    if not get_by_path(config, path):
        return f"{path}=false"
    return None


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
    edited: bool = False
    """True once something wrote this working set (``put`` / ``apply_patches``); ``get()``'s auto-created defaults stay False."""


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

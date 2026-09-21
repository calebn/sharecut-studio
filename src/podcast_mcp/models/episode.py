from __future__ import annotations

import json
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field, model_validator

from podcast_mcp.models.history import ProjectHistory
from podcast_mcp.models.project_format import SUPPORTED_PROJECT_VERSION, require_v2_document

EPISODE_PROJECT_FILENAME = "episode.project.json"


class TrackRole(StrEnum):
    DIALOGUE = "dialogue"
    MUSIC = "music"
    SFX = "sfx"
    INTRO = "intro"
    OUTRO = "outro"


class EditDecisionType(StrEnum):
    REMOVE = "remove"
    MUTE = "mute"
    # Blade / razor: start == end is the cut time; timebase is usually timeline.
    SPLIT = "split"


class ClipJoinMode(StrEnum):
    """How an incoming clip meets the previous clip at render time."""

    FADE = "fade"
    CROSSFADE = "crossfade"
    CUT = "cut"


class ClipMuteRegion(BaseModel):
    """Source-media span rendered as silence inside a clip (mute-in-place)."""

    start_s: float = Field(allow_inf_nan=False)
    end_s: float = Field(allow_inf_nan=False)

    @model_validator(mode="after")
    def _end_after_start(self) -> ClipMuteRegion:
        if self.end_s <= self.start_s:
            raise ValueError("end_s must be greater than start_s")
        return self


class MediaAsset(BaseModel):
    path: str
    duration_sec: float | None = None
    sample_rate: int | None = None
    channels: int | None = None


class TrackProxy(BaseModel):
    """Segmented FX source-clock guest proxy under artifacts/proxy/{id}/{hash}/."""

    hash: str
    chunk_sec: float = 60.0
    overlap_ms: int = 200
    chunk_count: int
    duration_sec: float
    codec: str = "mp3"
    bitrate_kbps: int = 64
    object_store_prefix: str | None = None
    object_store_uploaded_at: str | None = None


class Track(BaseModel):
    id: str
    label: str
    role: TrackRole = TrackRole.DIALOGUE
    speaker: str | None = None
    media: MediaAsset | None = None
    # Optional recorded quiet bed (raw/room-tone/{participant}.wav). Filler
    # pads prefer this over stolen stem air when filler_pad_mode is room_tone.
    room_tone: MediaAsset | None = None
    gain_db: float = 0.0
    muted: bool = False
    # When True, stems/segments mute outside non-suppressed word intervals
    # (acoustic bleed mute). Snapshotted in history so undo/play_ab work.
    transcript_gate: bool = False
    proxy: TrackProxy | None = None


class Clip(BaseModel):
    id: str
    track_id: str
    source_start: float
    source_end: float
    timeline_start: float
    source_id: str | None = None
    fade_in_ms: int = 0
    fade_out_ms: int = 0
    join_in_mode: ClipJoinMode = ClipJoinMode.FADE
    # Source-media mute holes honoured at render (tighten.edit_mode=mute).
    mute_regions: list[ClipMuteRegion] = Field(default_factory=list)

    @property
    def timeline_end(self) -> float:
        return self.timeline_start + (self.source_end - self.source_start)


class ChapterMarker(BaseModel):
    time: float
    title: str
    image_url: str | None = None


class TranscriptWord(BaseModel):
    text: str
    start: float
    end: float
    confidence: float | None = None
    suppressed: bool = False
    audibility_status: str | None = None
    dominant_track: str | None = None
    speaker_match_track: str | None = None
    speaker_match_score: float | None = None


class Transcript(BaseModel):
    track_id: str
    language: str = "en"
    words: list[TranscriptWord] = Field(default_factory=list)
    # When set, words are source-media seconds for that sources[] row (multi-file
    # speaker track). None = whole-track / primary media transcript.
    source_id: str | None = None


class CombinedUtterance(BaseModel):
    track_id: str
    speaker: str
    start: float
    end: float
    text: str


class CombinedTranscript(BaseModel):
    utterances: list[CombinedUtterance] = Field(default_factory=list)


class EditDecision(BaseModel):
    id: str
    track_id: str
    type: EditDecisionType = EditDecisionType.REMOVE
    start: float
    end: float
    crossfade_ms: int = 10
    reason: str | None = None
    review_required: bool = False
    applied: bool = True
    cut_confidence: float | None = None
    boundary_mode: str | None = None
    # When set, apply inserts this many seconds of paced pad at the join after
    # ripple (silence by default; room_tone when tighten.filler_pad_mode says so).
    # See tighten.filler_room_tone_replace / filler_pad_mode.
    replace_gap_sec: float | None = None
    # session = cross-track ripple (default). track = punch silence hole on
    # track_id only when peers are speaking (speech_energy_guard).
    scope: str = "session"
    # Multi-track ops (split); when None, use [track_id].
    track_ids: list[str] | None = None
    # Clock for start/end. remove/mute are source; blade split is timeline.
    timebase: str = "source"


class AppliedEditRecord(BaseModel):
    id: str
    applied_at: str
    operation: str
    decision_ids: list[str] = Field(default_factory=list)
    track_ids: list[str] = Field(default_factory=list)
    source_start: float | None = None
    source_end: float | None = None
    timeline_start: float | None = None
    timeline_end: float | None = None
    reason: str | None = None
    crossfade_ms: int | None = None
    boundary_mode: str | None = None
    cut_confidence: float | None = None
    params: dict[str, Any] = Field(default_factory=dict)


class SocialClipCandidate(BaseModel):
    id: str
    track_id: str
    start: float
    end: float
    score: float = 0.0
    reasons: list[str] = Field(default_factory=list)
    title_suggestion: str | None = None
    caption_suggestion: str | None = None
    transcript_excerpt: str | None = None
    speaker: str | None = None
    review_required: bool = True
    approved: bool = False
    exported_path: str | None = None


class AutomationPoint(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()), min_length=1, frozen=True)
    time: float
    value: float


class AutomationEnvelope(BaseModel):
    track_id: str
    parameter: str = "volume"
    points: list[AutomationPoint] = Field(default_factory=list)

    @model_validator(mode="after")
    def _unique_point_ids(self) -> AutomationEnvelope:
        ids = [point.id for point in self.points]
        if len(ids) != len(set(ids)):
            raise ValueError("automation envelope point IDs must be unique")
        return self


class ProcessingEffect(BaseModel):
    effect: str
    params: dict[str, Any] = Field(default_factory=dict)
    bypass: bool = False


class ProcessingChain(BaseModel):
    track_id: str
    effects: list[ProcessingEffect] = Field(default_factory=list)


class PipelineStepLog(BaseModel):
    step: str
    started_at: str
    finished_at: str | None = None
    status: str = "ok"
    message: str | None = None


class PipelineRun(BaseModel):
    id: str
    started_at: str
    steps: list[PipelineStepLog] = Field(default_factory=list)


class SpeakerIngestAlignment(BaseModel):
    session_start_in_file_sec: float = 0.0
    content_align_sec: float = 0.0
    align_method: str = "unknown"


class ProjectMeta(BaseModel):
    name: str
    workspace_dir: str
    created_at: str = Field(default_factory=lambda: datetime.now(UTC).isoformat())
    schema_id: str = "podcast-mcp/episode/2"
    ingest_alignment: dict[str, SpeakerIngestAlignment] | None = None


class SourceRecording(BaseModel):
    id: str
    path: str
    speaker: str | None = None
    label: str | None = None
    offset_sec: float = 0.0
    duration_sec: float | None = None
    sample_rate: int | None = None
    channels: int | None = None


class TimelineSection(BaseModel):
    duration_sec: float | None = None
    tracks: list[Track] = Field(default_factory=list)
    clips: list[Clip] = Field(default_factory=list)


class EditorialSection(BaseModel):
    edit_decisions: list[EditDecision] = Field(default_factory=list)
    edit_log: list[AppliedEditRecord] = Field(default_factory=list)
    chapters: list[ChapterMarker] = Field(default_factory=list)


class TranscriptsSection(BaseModel):
    per_track: list[Transcript] = Field(default_factory=list)
    combined: CombinedTranscript | None = None


class MixSection(BaseModel):
    processing_chains: list[ProcessingChain] = Field(default_factory=list)
    automation_envelopes: list[AutomationEnvelope] = Field(default_factory=list)


class RenderArtifacts(BaseModel):
    premix: str | None = None
    mastered: str | None = None


class RenderInvalidation(BaseModel):
    """Cause journal: what dirtied stems since last fresh render (diagnostic)."""

    id: str
    track_ids: list[str] = Field(default_factory=list)
    timeline_start: float | None = None
    timeline_end: float | None = None
    reason: str = "other"
    at: str


class RenderSection(BaseModel):
    last_completed_step: str | None = None
    pipeline_runs: list[PipelineRun] = Field(default_factory=list)
    artifacts: RenderArtifacts = Field(default_factory=RenderArtifacts)
    reconciliation_stale: bool = False
    last_reconciliation_hash: str | None = None
    invalidations: list[RenderInvalidation] = Field(default_factory=list)


class SocialSection(BaseModel):
    clip_candidates: list[SocialClipCandidate] = Field(default_factory=list)


class CommentActionItem(BaseModel):
    id: str
    text: str
    done: bool = False
    completed_at: str | None = None
    completed_by: str | None = None


class CommentReply(BaseModel):
    """Flat reply under a timeline comment (v1; no nested parent_reply_id)."""

    id: str
    body: str
    author: str
    created_at: str


class TimelineComment(BaseModel):
    """Review feedback anchored to the session/timeline clock."""

    id: str
    body: str
    author: str
    created_at: str
    updated_at: str | None = None
    timeline_start: float
    timeline_end: float | None = None
    track_ids: list[str] = Field(default_factory=list)
    action_items: list[CommentActionItem] = Field(default_factory=list)
    replies: list[CommentReply] = Field(default_factory=list)
    resolved: bool = False
    resolved_at: str | None = None
    resolved_by: str | None = None
    review_version_id: str | None = None
    # At most one thread per pending EditDecision (unique among comments).
    edit_decision_id: str | None = None


class ReviewMixVersion(BaseModel):
    """Frozen review mix snapshot under artifacts/review/{id}/."""

    id: str
    label: str
    created_at: str
    audio_relpath: str
    duration_sec: float | None = None
    sha256: str | None = None
    source: str | None = None
    mp3_relpath: str | None = None
    object_store_key: str | None = None
    object_store_uploaded_at: str | None = None


class ReviewSection(BaseModel):
    comments: list[TimelineComment] = Field(default_factory=list)
    versions: list[ReviewMixVersion] = Field(default_factory=list)
    active_version_id: str | None = None


class EpisodeProject(BaseModel):
    """Episode Project Format v2 - canonical on-disk representation."""

    version: str = "2.0"
    meta: ProjectMeta
    sources: list[SourceRecording] = Field(default_factory=list)
    timeline: TimelineSection = Field(default_factory=TimelineSection)
    editorial: EditorialSection = Field(default_factory=EditorialSection)
    transcript_data: TranscriptsSection = Field(
        default_factory=TranscriptsSection,
        validation_alias="transcripts",
        serialization_alias="transcripts",
    )
    mix: MixSection = Field(default_factory=MixSection)
    render: RenderSection = Field(default_factory=RenderSection)
    social: SocialSection = Field(default_factory=SocialSection)
    review: ReviewSection = Field(default_factory=ReviewSection)
    history: ProjectHistory | None = None

    @classmethod
    def create(cls, name: str, workspace_dir: str) -> EpisodeProject:
        return cls(
            meta=ProjectMeta(
                name=name,
                workspace_dir=str(Path(workspace_dir).resolve()),
            ),
        )

    @property
    def name(self) -> str:
        return self.meta.name

    @name.setter
    def name(self, value: str) -> None:
        self.meta.name = value

    @property
    def workspace_dir(self) -> str:
        return self.meta.workspace_dir

    @workspace_dir.setter
    def workspace_dir(self, value: str) -> None:
        self.meta.workspace_dir = value

    @property
    def created_at(self) -> str:
        return self.meta.created_at

    @property
    def tracks(self) -> list[Track]:
        return self.timeline.tracks

    @tracks.setter
    def tracks(self, value: list[Track]) -> None:
        self.timeline.tracks = value

    @property
    def clips(self) -> list[Clip]:
        return self.timeline.clips

    @clips.setter
    def clips(self, value: list[Clip]) -> None:
        self.timeline.clips = value

    @property
    def transcripts(self) -> list[Transcript]:
        return self.transcript_data.per_track

    @transcripts.setter
    def transcripts(self, value: list[Transcript]) -> None:
        self.transcript_data.per_track = value

    @property
    def combined_transcript(self) -> CombinedTranscript | None:
        return self.transcript_data.combined

    @combined_transcript.setter
    def combined_transcript(self, value: CombinedTranscript | None) -> None:
        self.transcript_data.combined = value

    @property
    def edit_decisions(self) -> list[EditDecision]:
        return self.editorial.edit_decisions

    @edit_decisions.setter
    def edit_decisions(self, value: list[EditDecision]) -> None:
        self.editorial.edit_decisions = value

    @property
    def chapters(self) -> list[ChapterMarker]:
        return self.editorial.chapters

    @chapters.setter
    def chapters(self, value: list[ChapterMarker]) -> None:
        self.editorial.chapters = value

    @property
    def social_clip_candidates(self) -> list[SocialClipCandidate]:
        return self.social.clip_candidates

    @social_clip_candidates.setter
    def social_clip_candidates(self, value: list[SocialClipCandidate]) -> None:
        self.social.clip_candidates = value

    @property
    def comments(self) -> list[TimelineComment]:
        return self.review.comments

    @comments.setter
    def comments(self, value: list[TimelineComment]) -> None:
        self.review.comments = value

    @property
    def automation_envelopes(self) -> list[AutomationEnvelope]:
        return self.mix.automation_envelopes

    @automation_envelopes.setter
    def automation_envelopes(self, value: list[AutomationEnvelope]) -> None:
        self.mix.automation_envelopes = value

    @property
    def processing_chains(self) -> list[ProcessingChain]:
        return self.mix.processing_chains

    @processing_chains.setter
    def processing_chains(self, value: list[ProcessingChain]) -> None:
        self.mix.processing_chains = value

    @property
    def pipeline_runs(self) -> list[PipelineRun]:
        return self.render.pipeline_runs

    @pipeline_runs.setter
    def pipeline_runs(self, value: list[PipelineRun]) -> None:
        self.render.pipeline_runs = value

    @property
    def last_completed_step(self) -> str | None:
        return self.render.last_completed_step

    @last_completed_step.setter
    def last_completed_step(self, value: str | None) -> None:
        self.render.last_completed_step = value

    @property
    def reconciliation_stale(self) -> bool:
        return self.render.reconciliation_stale

    @reconciliation_stale.setter
    def reconciliation_stale(self, value: bool) -> None:
        self.render.reconciliation_stale = value

    @property
    def last_reconciliation_hash(self) -> str | None:
        return self.render.last_reconciliation_hash

    @last_reconciliation_hash.setter
    def last_reconciliation_hash(self, value: str | None) -> None:
        self.render.last_reconciliation_hash = value

    def workspace_path(self) -> Path:
        return Path(self.meta.workspace_dir).resolve()

    def raw_dir(self) -> Path:
        return self.workspace_path() / "raw"

    def transcripts_dir(self) -> Path:
        return self.workspace_path() / "transcripts"

    def artifacts_dir(self) -> Path:
        return self.workspace_path() / "artifacts"

    def export_dir(self) -> Path:
        return self.workspace_path() / "export"

    def track_by_id(self, track_id: str) -> Track | None:
        return next((t for t in self.timeline.tracks if t.id == track_id), None)

    def transcript_for_track(self, track_id: str) -> Transcript | None:
        return next(
            (t for t in self.transcript_data.per_track if t.track_id == track_id),
            None,
        )

    def history_dir(self) -> Path:
        return self.workspace_path() / "history"

    def ensure_dirs(self) -> None:
        for d in (
            self.raw_dir(),
            self.transcripts_dir(),
            self.artifacts_dir(),
            self.export_dir(),
            self.history_dir(),
        ):
            d.mkdir(parents=True, exist_ok=True)


def project_file_path(workspace: Path) -> Path:
    return workspace / EPISODE_PROJECT_FILENAME


def load_project(path: Path) -> EpisodeProject:
    path = Path(path)
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("project file must be a JSON object")
    require_v2_document(data)
    project = EpisodeProject.model_validate(data)
    # Workspace is always the directory that contains episode.project.json.
    # Do not trust committed absolute paths (machine-specific / portable clones).
    project.meta.workspace_dir = str(path.parent.resolve())
    return project


def save_project(project: EpisodeProject, path: Path | None = None) -> Path:
    project.version = SUPPORTED_PROJECT_VERSION
    out = path or project_file_path(project.workspace_path())
    out.parent.mkdir(parents=True, exist_ok=True)
    # Persist portable workspace_dir; load_project remaps to the real directory.
    saved_ws = project.meta.workspace_dir
    project.meta.workspace_dir = "."
    try:
        tmp = out.with_suffix(".json.tmp")
        tmp.write_text(project.model_dump_json(indent=2, by_alias=True), encoding="utf-8")
        tmp.replace(out)
    finally:
        project.meta.workspace_dir = saved_ws
    return out

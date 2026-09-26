from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from podcast_mcp.services.document_sync.payloads import (
    COMMENT_BODY_MAX,
    DocumentCommandBody,
)
from podcast_mcp.services.transcript_precorrect import VOCABULARY_MAX_ENTRIES

# Discriminated union — source of truth in document_sync.payloads.
DocumentCommandRequest = DocumentCommandBody


class PipelineRunRequest(BaseModel):
    path: str
    from_step: str | None = None
    only_step: str | None = None
    skip_steps: list[str] | None = None
    enabled_steps: list[str] | None = None
    unattended: bool | None = None
    config: dict | None = None
    use_working_set: bool = True


class PipelineConfigPutRequest(BaseModel):
    path: str
    config: dict | None = None
    enabled_steps: list[str] | None = None
    unattended: bool | None = None
    reset: bool = False


class PipelineAnalyzeRequest(BaseModel):
    path: str
    apply: bool = False


class PipelineCancelRequest(BaseModel):
    job_id: str | None = None


class RenderPreviewRequest(BaseModel):
    path: str


class TranscriptRefineWaiveRequest(BaseModel):
    path: str
    reason: str = Field(min_length=1)


class TranscriptVocabularyPutRequest(BaseModel):
    path: str
    terms: list[str] = Field(max_length=VOCABULARY_MAX_ENTRIES)
    guest_names: list[str] = Field(max_length=VOCABULARY_MAX_ENTRIES)
    base_revision: str | None


class BootstrapRunRequest(BaseModel):
    """First-run asset download (ffmpeg / whisper / optional rnnoise)."""

    components: list[str] | None = None
    whisper_model: str | None = None
    force: bool = False


class BootstrapCancelRequest(BaseModel):
    job_id: str | None = None


class BounceRequestBody(BaseModel):
    path: str
    track_ids: list[str] | None = None
    start_s: float | None = None
    end_s: float | None = None
    formats: list[str] | None = None


class ExportDeliverablesRequest(BaseModel):
    path: str
    formats: list[dict] | None = None


class ViewerSessionSnapshot(BaseModel):
    """Partial DAW transport snapshot (compat POST → typed commands)."""

    playhead_sec: float | None = None
    is_playing: bool | None = None
    audition_mode: str | None = None
    region: dict[str, Any] | None = None
    source: str | None = None
    track_id: str | None = None
    query: str | None = None
    match_index: int | None = None
    selection: dict[str, Any] | None = None
    viewer_mute: dict[str, bool] | None = None
    solo_tracks: dict[str, bool] | None = None
    tier: str | None = None
    dry_run: bool | None = None
    wav: str | None = None
    compare_segments: list[dict[str, Any]] | None = None
    ack_command_id: str | None = None
    client_id: str | None = None
    label: str | None = None


class SessionCommandRequest(BaseModel):
    """Typed command submit - agent, viewer, and CLI use the same shape."""

    client_id: str
    client_seq: int
    role: str = "viewer"
    type: str
    payload: dict[str, Any] = Field(default_factory=dict)
    command_id: str | None = None
    causation_id: str | None = None
    label: str | None = None


class TrackView(BaseModel):
    id: str
    label: str
    role: str
    speaker: str | None = None
    gain_db: float = 0.0
    fader_db: float = 0.0
    muted: bool = False
    duration_sec: float | None = None
    fx_count: int = 0
    stem_is_fresh: bool | None = None
    has_source_audio: bool = False
    media_path: str | None = None
    # Longest edge fade (ms) a clip on this track may take; null = uncapped.
    fade_max_ms: int | None = None


class ProjectView(BaseModel):
    project_path: str
    meta: dict[str, Any]
    timeline_duration_sec: float
    tracks: list[TrackView]
    clips: dict[str, Any]
    chapters: list[dict[str, Any]]
    pending_edits: list[dict[str, Any]]
    edit_boundaries: list[dict[str, Any]] = Field(default_factory=list)
    applied_edits: dict[str, Any]
    effects_by_track: dict[str, list[dict[str, Any]]]
    envelopes: list[dict[str, Any]]
    social_clips: list[dict[str, Any]] = Field(default_factory=list)
    comments: list[dict[str, Any]] = Field(default_factory=list)
    render_status: dict[str, Any]
    edit_impact: dict[str, Any]
    history: dict[str, Any]
    transcript: dict[str, Any] | None = None


class CommentCreateRequest(BaseModel):
    path: str
    body: str = Field(max_length=COMMENT_BODY_MAX)
    author: str
    timeline_start: float
    timeline_end: float | None = None
    track_ids: list[str] = Field(default_factory=list)
    action_texts: list[str] = Field(default_factory=list)
    edit_decision_id: str | None = None


class CommentPatchRequest(BaseModel):
    path: str
    body: str | None = Field(default=None, max_length=COMMENT_BODY_MAX)
    resolved: bool | None = None
    by: str | None = None
    track_ids: list[str] | None = None
    timeline_start: float | None = None
    timeline_end: float | None = None


class CommentActionDoneRequest(BaseModel):
    path: str
    done: bool = True
    by: str


class CommentReplyRequest(BaseModel):
    path: str
    body: str = Field(max_length=COMMENT_BODY_MAX)
    author: str


class ShareActionDoneRequest(BaseModel):
    """Guest HTTP twin for MCP guest_set_action_done (no project path)."""

    done: bool = True
    by: str = "guest"


class ShareCreateRequest(BaseModel):
    path: str
    role: Literal["viewer", "commenter", "editor"] = "commenter"
    with_mcp: bool = False
    review_version_id: str | None = None


class ShareRevokeRequest(BaseModel):
    path: str


class RecordRoomCreateRequest(BaseModel):
    path: str
    expires_at: str | None = None


class RecordRoomRevokeRequest(BaseModel):
    path: str

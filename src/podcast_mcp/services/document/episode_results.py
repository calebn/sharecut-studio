from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class _EpisodeResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ProjectRenamedResult(_EpisodeResult):
    name: str


class RecordSessionRenamedResult(_EpisodeResult):
    session_id: str
    name: str | None


class EmptyTrackAddedResult(_EpisodeResult):
    track_id: str
    label: str
    role: str


class TrackMediaSetResult(_EpisodeResult):
    track_id: str
    media_path: str
    duration_sec: float | None


class TrackMetaResult(_EpisodeResult):
    track_id: str
    label: str
    role: str
    speaker: str | None


class TrackVolumeResult(_EpisodeResult):
    track_id: str
    fader_db: float
    output_gain_db: float


class TrackMuteResult(_EpisodeResult):
    track_id: str
    muted: bool


class TrackRemovedResult(_EpisodeResult):
    track_id: str
    removed: bool


class StreamsCurrentResult(_EpisodeResult):
    analysis_reads_first_audio_stream: bool


class TrackReorderedResult(_EpisodeResult):
    track_id: str
    index: int
    track_ids: list[str]


class StaleStreamFile(_EpisodeResult):
    path: str
    tracks: list[str]
    audio_streams: int
    old_pick: int | None


class StaleAudioStreams(_EpisodeResult):
    files: list[StaleStreamFile]
    rerun: str


class EpisodeSummary(_EpisodeResult):
    name: str
    duration_sec: float | None
    tracks: list[str]
    clip_count: int
    pending_edits: int
    chapters: int
    applied_edits: int
    reconciliation_stale: bool


class StaleEpisodeSummary(EpisodeSummary):
    stale_audio_streams: StaleAudioStreams

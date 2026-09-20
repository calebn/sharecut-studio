from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import BaseModel, Field


class SessionConfig(BaseModel):
    """Shared podcast session clock (remote recorders with different start/stop)."""

    reference_speaker: str | None = Field(
        default=None,
        description="Speaker whose file clock anchors session t=0 (default: first in list)",
    )
    hint_sec: float | None = Field(
        default=None,
        description="Session time (on reference file) near expected dialogue for auto-detect",
    )


class SpeakerGroup(BaseModel):
    name: str
    sources: list[str] = Field(min_length=1)
    session_start_in_file_sec: float | None = Field(
        default=None,
        description="File timestamp for session t=0; auto-detected vs reference if omitted",
    )
    session_offset_sec: float | None = Field(
        default=None,
        description="Fine-tune: shift this speaker later on session clock (subtract from trim)",
    )


class AlignAnchor(BaseModel):
    """Semantic anchor: place source phrase after reference phrase on the session clock."""

    reference_speaker: str
    reference_contains: str
    source_speaker: str
    source_contains: str
    gap_sec: float = 1.0
    align_to: str = Field(
        default="after_reference",
        description="after_reference (Q→A) or start (same moment on session clock)",
    )


class IngestManifest(BaseModel):
    """User-authored mapping from raw audio files to speakers (no DAW project files)."""

    session: SessionConfig | None = None
    speakers: list[SpeakerGroup] = Field(min_length=1)
    exclude: list[str] = Field(default_factory=list)
    align_anchors: list[AlignAnchor] = Field(default_factory=list)

    def reference_speaker_name(self) -> str:
        if self.session and self.session.reference_speaker:
            return self.session.reference_speaker
        return self.speakers[0].name

    def session_hint_sec(self, extract_start_sec: float | None) -> float:
        if self.session and self.session.hint_sec is not None:
            return self.session.hint_sec
        if extract_start_sec is not None:
            return extract_start_sec
        return 0.0

    @classmethod
    def load(cls, path: Path) -> IngestManifest:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        return cls.model_validate(data)

    def resolve_sources(self, audio_dir: Path) -> list[tuple[str, list[Path]]]:
        out: list[tuple[str, list[Path]]] = []
        for group in self.speakers:
            paths = [(audio_dir / name).resolve() for name in group.sources]
            for p in paths:
                if not p.is_file():
                    raise FileNotFoundError(f"missing source for {group.name}: {p}")
            out.append((group.name, paths))
        return out

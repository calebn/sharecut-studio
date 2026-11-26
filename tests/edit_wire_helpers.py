"""Shared fixtures for the EditService wire-pin modules: one project builder and a normalizer."""

from __future__ import annotations

import json
import re
import wave
from pathlib import Path
from typing import Any

from podcast_mcp.edits.edit_log import archive_timeline_op
from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.project.store import save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService

RATE = 16_000
_ISO = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?\+00:00")
_IDS = re.compile(r"\b(alog_[0-9a-f]{8}|cut_[0-9a-f]{8}|inv_[0-9a-f]{10})\b")
_HASH = re.compile(r'(?<=")[0-9a-f]{16}(?=")')
_WORDS = [("hello", 0.0), ("um", 1.0), ("there", 2.0), ("world", 3.0), ("again", 4.0)]


def write_wav(path: Path, seconds: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(b"\0\0" * int(RATE * seconds))


def _decision(edit_id, kind, start, reason, *, pending=False) -> EditDecision:
    return EditDecision(
        id=edit_id,
        track_id="host",
        type=kind,
        start=start,
        end=start + 0.4,
        reason=reason,
        applied=False,
        review_required=pending,
        boundary_mode="vocal_transcript_guided",
    )


def build_project(root: Path, *, words: bool = True) -> EpisodeProject:
    """Host (with words) and guest (none) dialogue tracks, six seconds each, no edits."""
    project = EpisodeProject.create("ep", str(root))
    project.ensure_dirs()
    for tid in ("host", "guest"):
        write_wav(root / "raw" / f"{tid}.wav", 6.0)
        project.timeline.tracks.append(
            Track(
                id=tid,
                label=tid.title(),
                role=TrackRole.DIALOGUE,
                speaker=tid.title(),
                media=MediaAsset(
                    path=f"raw/{tid}.wav", duration_sec=6.0, sample_rate=RATE, channels=1
                ),
            )
        )
        project.timeline.clips.append(
            Clip(id=f"c-{tid}", track_id=tid, source_start=0.0, source_end=6.0, timeline_start=0.0)
        )
    project.timeline.duration_sec = 6.0
    if words:
        project.transcripts = [
            Transcript(
                track_id="host",
                words=[
                    TranscriptWord(text=text, start=start, end=start + 0.4, confidence=0.9)
                    for text, start in _WORDS
                ],
            )
        ]
    return project


def build_workspace(
    root: Path,
    *,
    approve: tuple[str, ...] = (),
    pending: bool = False,
    trim: bool = False,
    words: bool = True,
) -> ProjectWorkspace:
    """A workspace with a mute ``m1`` (1.0-1.4), a cut ``r1`` (3.0-3.4) and optional pending ``p1``.

    ``approve`` names which of ``m1`` and ``r1`` to apply; ``trim`` adds a History-only record.
    """
    project = build_project(root, words=words)
    project.edit_decisions = [
        _decision("m1", EditDecisionType.MUTE, 1.0, "filler:um"),
        _decision("r1", EditDecisionType.REMOVE, 3.0, "filler:x"),
    ]
    if pending:
        project.edit_decisions.append(
            _decision("p1", EditDecisionType.REMOVE, 4.0, "pending", pending=True)
        )
    REFINE_GATE.mark_done(project, notes="Known synthetic fixture; no real-project acceptance")
    ws = ProjectWorkspace.open(save_project(project))
    if approve:
        assert EditService(ws).approve(list(approve)) == len(approve)
    if trim:
        ws.mutate(
            "before trim",
            "after trim",
            lambda p: archive_timeline_op(p, operation="trim_clip_edge", track_ids=["host"]),
        )
    return ws


def applied_ids(ws: ProjectWorkspace) -> list[str]:
    return [record.id for record in ProjectWorkspace.open(ws.path).project.editorial.edit_log]


def dump(value: Any) -> str:
    return json.dumps(value, sort_keys=True)


def normalize(value: Any, ws: ProjectWorkspace) -> Any:
    """Workspace paths become <ws>; ids, timestamps and 16-hex hashes become numbered tokens."""
    text = dump(value)
    for root in {str(ws.path.parent), str(ws.path.parent.resolve())}:
        text = text.replace(root, "<ws>")
    seen: dict[str, str] = {}

    def token(match: re.Match[str], kind: str) -> str:
        key = match.group(0)
        return seen.setdefault(key, f"<{kind}{len(seen)}>")

    text = _ISO.sub("<ts>", text)
    text = _IDS.sub(lambda m: token(m, m.group(0).split("_")[0] + ":"), text)
    text = _HASH.sub(lambda m: token(m, "hash:"), text)
    return json.loads(text)

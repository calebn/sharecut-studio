"""After any document command a guest's render hashes and clip rows are current.

For every command in the registry, on a project where a gated, transcribed track has audio to
change, the guest's view is advanced the way the client advances it (delta operations, or the
replacement snapshot, or a refetch on ``resync``). The render hashes and clip rows the proxy
match reads must then equal ``project_basis`` on the saved project, and still equal it after
Undo and Redo. Which commands move audio is not classified by hand.
"""

from __future__ import annotations

import copy
import json
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from podcast_mcp.edits.range_target import build_range_target
from podcast_mcp.edits.transcript_timing import WordTimingTarget
from podcast_mcp.gui.assembler import dump_project_projection
from podcast_mcp.mcp.tools import timeline
from podcast_mcp.models import (
    Clip,
    ClipOffSpeakerMuteRegion,
    EditMode,
    MediaAsset,
    Track,
    Transcript,
    TranscriptWord,
    save_project,
)
from podcast_mcp.models.episode import (
    InsertAnchor,
    RangeInterval,
    RecordSessionRecord,
    SessionSuggestion,
    SourceRecording,
    StagedTake,
)
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration import sanitize_guest_document_event
from podcast_mcp.services.document import TranscriptService
from podcast_mcp.services.document.bleed_inspection import inspect_clip_bleed
from podcast_mcp.services.document.boundary import (
    RollBoundaryTarget,
    TrimBoundaryTarget,
    boundary_context,
)
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.projection_delta import split
from podcast_mcp.services.document_sync.registry import COMMANDS
from podcast_mcp.services.media.proxy_variants import project_basis
from test_bleed_alignment_surfaces import _workspace as _bleed_surfaces_workspace
from test_room_tone_extract import SPEECH_THEN_ROOM, _host_audio, _project
from test_segments_insert import _save

Sections = dict[tuple[str, str | None], Any]


@dataclass
class Rig:
    ws: ProjectWorkspace
    root: Path
    seq: int = 0

    def host(self, command_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self.submit(command_type, payload, audience="host")

    def submit(self, command_type: str, payload: dict[str, Any], *, audience: str) -> dict:
        self.seq += 1
        return DocumentSyncService(self.ws).submit(
            DocumentCommand(
                type=command_type,
                payload=payload,
                client_id="freshness",
                role="host",
                client_seq=self.seq,
            ),
            audience=audience,
        )

    def head(self) -> str:
        return self.ws.project.history.head_id()


def _guest_sections(ws: ProjectWorkspace) -> Sections:
    view = dump_project_projection(ws, projection="shell", audience="guest")
    wire = sanitize_guest_document_event({"snapshot": {"project": view}})
    return split(wire["snapshot"]["project"])


def _apply_operations(sections: Sections, operations: list[dict[str, Any]]) -> Sections:
    sections = copy.deepcopy(sections)
    for op in operations:
        key = (op["section"], op.get("parent"))
        if op["type"] == "replace":
            sections[key] = op["value"]
        elif op["type"] == "remove":
            sections.pop(key, None)
        elif op["section"] in ("render_tracks", "clip_rows"):
            rows = list(sections.get(key, []))
            for splice in sorted(op["splices"], key=lambda s: -s["index"]):
                rows[splice["index"] : splice["index"] + splice["delete"]] = splice["insert"]
            for update in op["updates"]:
                rows[update["index"]] = update["value"]
            sections[key] = rows
    return sections


def _client_basis(sections: Sections) -> tuple[dict[str, str], dict[str, tuple]]:
    """What ``projectProxyBasis`` reads from the guest's displayed project."""
    hashes = {
        row["key"]: row["value"]["render_hash"]
        for row in sections.get(("render_tracks", None), [])
        if row["value"].get("render_hash")
    }
    clips: dict[str, tuple] = {}
    for (section, _parent), rows in sections.items():
        if section != "clip_rows":
            continue
        for row in rows:
            clips[row["id"]] = (
                row["track_id"],
                row.get("origin_track_id") or row["track_id"],
                row.get("source_id"),
                row["source_start"],
                row["source_end"],
                row["timeline_start"],
                row["timeline_end"],
            )
    return hashes, clips


def _truth(ws: ProjectWorkspace) -> tuple[dict[str, str], dict[str, tuple]]:
    basis = project_basis(ws.project, ws.effective_config())
    clips = {
        clip_id: (
            c.track_id,
            c.origin_track_id,
            c.source_id,
            c.source_start,
            c.source_end,
            c.timeline_start,
            c.timeline_end,
        )
        for clip_id, c in basis.clips.items()
    }
    return dict(basis.render_hashes), clips


def _same_clips(shown: dict[str, tuple], truth: dict[str, tuple]) -> bool:
    if shown.keys() != truth.keys():
        return False
    for clip_id, row in truth.items():
        for got, want in zip(shown[clip_id], row, strict=True):
            if isinstance(want, float) or isinstance(got, float):
                if abs((got or 0.0) - (want or 0.0)) > 1e-6:
                    return False
            elif got != want:
                return False
    return True


class Guest:
    def __init__(self, rig: Rig) -> None:
        self.rig = rig
        self.sections = _guest_sections(rig.ws)

    def step(self, command_type: str, payload: dict[str, Any]) -> str:
        reply = self.rig.submit(command_type, payload, audience="guest")
        snapshot = reply["snapshot"]
        if snapshot.get("resync"):
            self.sections = _guest_sections(self.rig.ws)
            return "resync"
        if "delta" in snapshot:
            self.sections = _apply_operations(self.sections, snapshot["delta"]["operations"])
            return "delta"
        assert "project" in snapshot, sorted(snapshot)
        self.sections = split(snapshot["project"])
        return "replacement"

    def assert_current(self, label: str) -> None:
        hashes, clips = _client_basis(self.sections)
        want_hashes, want_clips = _truth(self.rig.ws)
        assert hashes == want_hashes, f"{label}: the guest shows stale render hashes"
        assert _same_clips(clips, want_clips), f"{label}: the guest shows stale clip rows"


@dataclass(frozen=True)
class Case:
    payload: Callable[[Rig], dict[str, Any]]
    setup: Callable[[Rig], None] | None = None
    build: Callable[[Path], ProjectWorkspace] | None = None


def _template(root: Path) -> Path:
    """A gated, transcribed host with a splittable pair of clips, an ungated guest, a bed to cut."""
    project = _project(root, _host_audio(SPEECH_THEN_ROOM))
    shutil.copyfile(root / "raw" / "host.wav", root / "raw" / "guest.wav")
    host = project.tracks[0]
    host.speaker = "Host"
    host.transcript_gate = True
    project.tracks.append(
        Track(
            id="guest",
            label="Guest",
            speaker="Guest",
            media=MediaAsset(path="raw/guest.wav", duration_sec=10.0),
        )
    )
    project.clips = [
        Clip(id="h1", track_id="host", source_start=0.0, source_end=5.0, timeline_start=0.0),
        Clip(id="h2", track_id="host", source_start=5.0, source_end=10.0, timeline_start=5.0),
        Clip(
            id="g1",
            track_id="guest",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
            off_speaker_mute_regions=[ClipOffSpeakerMuteRegion(start_s=1.0, end_s=2.0)],
        ),
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=1.0, end=1.4, confidence=0.9),
                TranscriptWord(text="there", start=2.7, end=3.2, confidence=0.4),
                TranscriptWord(text="again", start=4.1, end=4.8, confidence=0.9),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[TranscriptWord(text="yes", start=1.0, end=1.4, confidence=0.9)],
        ),
    ]
    project.ensure_dirs()
    return save_project(project, root / "episode.sharecut")


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return _template(tmp_path_factory.mktemp("template"))


def _open(template: Path, tmp_path: Path, case: Case) -> Rig:
    root = tmp_path / "ws"
    if case.build is not None:
        ws = case.build(root)
        return Rig(ws, ws.path.parent)
    shutil.copytree(template.parent, root)
    return Rig(ProjectWorkspace.open(root / template.name), root)


EFFECT = {"track_id": "host", "effect": "highpass"}
COMMENT = {"body": "c", "author": "a", "timeline_start": 1.0}
CHAPTER = {"time": 1.0, "title": "One"}
SOCIAL_CLIP = {"track_id": "host", "start": 1.0, "end": 3.0}
STAGE_CUT = {"track_id": "host", "start": 6.0, "end": 6.5, "review_required": True}


def _add_comment(rig: Rig) -> None:
    rig.host("AddComment", COMMENT)


def _add_chapter(rig: Rig) -> None:
    rig.host("AddChapter", CHAPTER)


def _add_social_clip(rig: Rig) -> None:
    rig.host("AddSocialClip", SOCIAL_CLIP)


def _undone_chapter(rig: Rig) -> None:
    _add_chapter(rig)
    rig.host("UndoHistory", {"expected_head_id": rig.head()})


def _pending(rig: Rig) -> list[str]:
    rig.ws.reload()
    return [d.id for d in rig.ws.project.editorial.edit_decisions if not d.applied]


def _stage_cut(rig: Rig) -> None:
    rig.host("StageTimeRangeCut", STAGE_CUT)
    assert _pending(rig)


def _applied_edit(rig: Rig) -> None:
    _stage_cut(rig)
    rig.host("ApproveEdits", {"ids": _pending(rig)})


def _add_effect(rig: Rig) -> None:
    rig.host("AddEffect", EFFECT)


def _bed(rig: Rig) -> None:
    reply = rig.host("ExtractRoomToneBed", {"track_id": "host"})
    assert reply["command"]["payload"]["result"]["extracted"] is True


def _timing_token(rig: Rig) -> str:
    target = WordTimingTarget(track_id="host", source_id=None, word_index=0)
    return TranscriptService(rig.ws).word_timing_context(target)["expected_token"]


def _replace_preview(rig: Rig) -> str:
    preview = TranscriptService(rig.ws).preview_transcript_replacement("again", "once more")
    return preview["preview_token"]


def _bleed_target(rig: Rig) -> dict[str, Any]:
    inspection = inspect_clip_bleed(rig.ws, "g1", track_id="guest")
    target = inspection.regions[0].target
    assert target is not None
    return target.model_dump(mode="json")


def _segment(rig: Rig) -> str:
    return _save(rig.root.parent, "Warm Intro").id


def _session(rig: Rig) -> None:
    """An insert and a replace suggestion, staged the way the record room leaves them."""
    shutil.copyfile(rig.root / "raw" / "host.wav", rig.root / "raw" / "take.wav")

    def take(index: int, segment: int) -> StagedTake:
        return StagedTake(
            take_index=index,
            track_id="host",
            track_label="Host",
            segment_index=segment,
            source_id="take-src",
            offset_s=0.0,
            duration_s=2.0,
        )

    def stage(project):
        project.sources.append(
            SourceRecording(
                id="take-src",
                path="raw/take.wav",
                duration_sec=10.0,
                speaker="Host",
                sample_rate=16000,
                channels=1,
            )
        )
        project.editorial.record_sessions.append(
            RecordSessionRecord(session_id="s" * 12, number=1, target_kind="insert")
        )
        project.editorial.session_suggestions.extend(
            [
                SessionSuggestion(
                    id="sug1",
                    kind="insert",
                    session_id="s" * 12,
                    session_number=1,
                    at_sec=10.0,
                    anchor=InsertAnchor(kind="end", at_sec=10.0),
                    takes=[take(0, 0)],
                ),
                SessionSuggestion(
                    id="sug2",
                    kind="replace",
                    session_id="s" * 12,
                    session_number=2,
                    from_sec=1.0,
                    to_sec=3.0,
                    anchor=InsertAnchor(
                        kind="clip",
                        at_sec=1.0,
                        track_id="host",
                        source_sec=1.0,
                        side="before",
                    ),
                    end_anchor=InsertAnchor(
                        kind="clip",
                        at_sec=3.0,
                        track_id="host",
                        source_sec=3.0,
                        side="after",
                    ),
                    track_ids=["host"],
                    takes=[take(0, 0), take(1, 1)],
                ),
            ]
        )

    with write_grant(WriteGrantKind.LEGACY_MCP):
        rig.ws.mutate("before stage", "after stage", stage)


def _bleed_workspace(root: Path) -> ProjectWorkspace:
    root.mkdir()
    with write_grant(WriteGrantKind.LEGACY_MCP):
        return _bleed_surfaces_workspace(root)


def _alignment_decision(rig: Rig) -> str:
    window = {"track_id": "uncertain", "start_sec": 0.8, "end_sec": 3.5}
    preview = json.loads(
        timeline.align_retained_bleed_tool(str(rig.ws.path), **window, apply=False)
    )
    return preview["proposals"][0]["decision_id"]


CASES: dict[str, Case] = {
    "AcceptSessionSuggestion": Case(lambda r: {"suggestion_id": "sug1"}, _session),
    "AddAction": Case(
        lambda r: {"comment_id": r.ws.project.comments[0].id, "text": "x"},
        _add_comment,
    ),
    "AddChapter": Case(lambda r: CHAPTER),
    "AddComment": Case(lambda r: COMMENT),
    "AddEffect": Case(lambda r: EFFECT),
    "AddReply": Case(
        lambda r: {"comment_id": r.ws.project.comments[0].id, "body": "r", "author": "a"},
        _add_comment,
    ),
    "AddSocialClip": Case(lambda r: SOCIAL_CLIP),
    "AddTrack": Case(lambda r: {"track_id": "t3", "label": "T3"}),
    "ApplyAutoEdits": Case(lambda r: {}),
    "ApplyEditPlan": Case(
        lambda r: {
            "edits": [{"track_id": "host", "start": 6.0, "end": 6.5}],
            "review_required": False,
        }
    ),
    "ApplyFadeRecommendationList": Case(
        lambda r: {"recommendations": [{"clip_id": "h2", "fade_in_ms": 20, "fade_out_ms": 20}]}
    ),
    "ApplyFadeRecommendations": Case(lambda r: {"track_id": "host"}),
    "ApplySuggestedActions": Case(lambda r: {}),
    "ApplyTranscriptCleanup": Case(
        lambda r: {
            "track_id": "host",
            "words": [{"word_index": 1, "text": "there!"}],
            "phrases": [{"start_word_index": 0, "end_word_index": 0, "text": "hi there"}],
        }
    ),
    "ApproveEdits": Case(lambda r: {"ids": _pending(r)}, _stage_cut),
    "ClearExtractedRoomToneBed": Case(lambda r: {"track_id": "host"}, _bed),
    "ClearFeedField": Case(
        lambda r: {"key": "item.title"},
        lambda r: r.host("SetFeedField", {"key": "item.title", "value": "d"}),
    ),
    "CorrectTranscriptPhrase": Case(
        lambda r: {
            "track_id": "host",
            "start_word_index": 0,
            "end_word_index": 1,
            "text": "howdy you",
        }
    ),
    "CorrectTranscriptWord": Case(lambda r: {"track_id": "host", "word_index": 0, "text": "howdy"}),
    "CrossfadeJoins": Case(lambda r: {"track_id": "host"}),
    "CutRange": Case(lambda r: {"start": 6.0, "end": 6.4, "mode": "gap", "track_ids": ["host"]}),
    "DeleteChapter": Case(
        lambda r: {"time": 1.0, "title": "One"},
        _add_chapter,
    ),
    "DeleteClip": Case(lambda r: {"clip_id": "h2", "mode": "gap", "override_audio_checks": True}),
    "DeleteComment": Case(
        lambda r: {"comment_id": r.ws.project.comments[0].id},
        _add_comment,
    ),
    "DeleteSocialClip": Case(
        lambda r: {"id": r.ws.project.social_clip_candidates[0].id},
        _add_social_clip,
    ),
    "DuplicateSegment": Case(lambda r: {"source_start": 0.0, "source_end": 0.3, "insert_at": 3.0}),
    "EditSelectedRange": Case(
        lambda r: {
            "action": "cut",
            "targets": [
                build_range_target(
                    r.ws.project, [RangeInterval(start=6.0, end=6.5)], ["host"]
                ).model_dump(mode="json")
            ],
        }
    ),
    "ExtractRoomToneBed": Case(lambda r: {"track_id": "host"}),
    "FadeJoins": Case(lambda r: {"track_id": "host"}),
    "FillRoomTone": Case(lambda r: {"track_id": "host"}),
    "InsertGap": Case(lambda r: {"at_time": 1.0, "duration_sec": 0.5}),
    "InsertSegment": Case(lambda r: {"segment_id": _segment(r), "at": "start"}),
    "MoveByText": Case(
        lambda r: {"source_query": "hello", "destination_query": "again", "position": "after"}
    ),
    "MoveClips": Case(
        lambda r: {"clips": [{"clip_id": "g1", "timeline_start": 0.25, "track_id": "guest"}]}
    ),
    "MoveSegment": Case(lambda r: {"source_start": 0.0, "source_end": 0.3, "insert_at": 2.5}),
    "PasteSegment": Case(lambda r: {"insert_at": 1.0, "duration": 0.5, "mode": "gap"}),
    "ProposeSocialClips": Case(lambda r: {}),
    "ProposeTighten": Case(lambda r: {}),
    "ReconcileTranscript": Case(lambda r: {"track_id": "host"}),
    "RedoHistory": Case(
        lambda r: {"expected_head_id": r.head()},
        _undone_chapter,
    ),
    "RejectEdits": Case(lambda r: {"ids": _pending(r)}, _stage_cut),
    "RemoveEffect": Case(lambda r: EFFECT, _add_effect),
    "RemoveTrack": Case(lambda r: {"track_id": "guest"}),
    "RenameProject": Case(lambda r: {"name": "renamed"}),
    "ReorderTrack": Case(lambda r: {"track_id": "guest", "index": 0}),
    "ReplaceTranscriptMatches": Case(
        lambda r: {
            "search": "again",
            "replacement": "once more",
            "match_case": False,
            "preview_token": _replace_preview(r),
        }
    ),
    "ResolveComment": Case(
        lambda r: {"comment_id": r.ws.project.comments[0].id, "by": "a"},
        _add_comment,
    ),
    "RestoreAppliedEdit": Case(
        lambda r: {"ids": [r.ws.project.editorial.edit_log[-1].id]}, _applied_edit
    ),
    "RestoreClipBleed": Case(lambda r: {"target": _bleed_target(r)}),
    "RippleDeleteText": Case(lambda r: {"query": "there"}),
    "RollClipJoin": Case(
        lambda r: {
            "left_clip_id": "h1",
            "right_clip_id": "h2",
            "delta_sec": 0.1,
            "expected_token": boundary_context(
                r.ws.project,
                RollBoundaryTarget(left_clip_id="h1", right_clip_id="h2"),
                defaults=r.ws.effective_config(),
            ).token,
        }
    ),
    "SelectSessionTake": Case(lambda r: {"suggestion_id": "sug2", "take_index": 1}, _session),
    "SetActionDone": Case(
        lambda r: {
            "comment_id": r.ws.project.comments[0].id,
            "action_id": r.ws.project.comments[0].action_items[0].id,
            "by": "a",
        },
        lambda r: r.host(
            "AddComment",
            {"body": "c", "author": "a", "timeline_start": 1.0, "action_texts": ["do"]},
        ),
    ),
    "SetBleedAlignmentMode": Case(
        lambda r: {
            "decision_id": _alignment_decision(r),
            "mode": "declined",
            "track_id": "uncertain",
            "start_sec": 0.8,
            "end_sec": 3.5,
        },
        build=_bleed_workspace,
    ),
    "SetClipFade": Case(
        lambda r: {
            "clip_id": "h1",
            "fade_in_ms": 20,
            "fade_out_ms": 20,
            "expected": {"fade_in_ms": 0, "fade_out_ms": 0},
        }
    ),
    "SetClipGain": Case(lambda r: {"clip_id": "h1", "gain_db": 3.0, "expected": {"gain_db": 0.0}}),
    "SetClipJoin": Case(
        lambda r: {
            "left_clip_id": "h1",
            "right_clip_id": "h2",
            "mode": "crossfade",
            "length_ms": 30,
        }
    ),
    "SetClipsFade": Case(
        lambda r: {
            "fades": [
                {
                    "clip_id": "h2",
                    "fade_in_ms": 10,
                    "fade_out_ms": 10,
                    "expected": {"fade_in_ms": 0, "fade_out_ms": 0},
                }
            ]
        }
    ),
    "SetClipsGain": Case(
        lambda r: {"gains": [{"clip_id": "h2", "gain_db": -2.0, "expected": {"gain_db": 0.0}}]}
    ),
    "SetEffectBypass": Case(
        lambda r: {"track_id": "host", "effect_index": 0, "bypass": True}, _add_effect
    ),
    "SetEnvelope": Case(
        lambda r: {
            "track_id": "host",
            "points": [
                {"id": "p1", "time": 0.0, "value": 1.0},
                {"id": "p2", "time": 1.0, "value": 0.5},
            ],
            "expected_points": [],
        }
    ),
    "SetFeedField": Case(lambda r: {"key": "item.title", "value": "d"}),
    "SetJoinFadeLimit": Case(lambda r: {"ms": 100}),
    "SetJoinMode": Case(lambda r: {"clip_id": "h2", "join_in_mode": "cut"}),
    "SetRecordSessionName": Case(lambda r: {"session_id": "s" * 12, "name": "Cold open"}, _session),
    "SetTrackFader": Case(lambda r: {"track_id": "host", "fader_db": -3.0}),
    "SetTrackMedia": Case(lambda r: {"track_id": "guest", "rel_path": "raw/host.wav"}),
    "SetTrackMeta": Case(lambda r: {"track_id": "guest", "label": "G2"}),
    "SetTrackMute": Case(lambda r: {"track_id": "guest", "muted": True}),
    "SetTranscriptWordAutomatic": Case(
        lambda r: {"track_id": "host", "word_index": 0},
        lambda r: r.host(
            "SetTranscriptWordSuppressed", {"track_id": "host", "word_index": 0, "suppressed": True}
        ),
    ),
    "SetTranscriptWordSuppressed": Case(
        lambda r: {"track_id": "host", "word_index": 0, "suppressed": True}
    ),
    "SetTranscriptWordTiming": Case(
        lambda r: {
            "target": {"track_id": "host", "source_id": None, "word_index": 0},
            "expected_token": _timing_token(r),
            "start": 1.05,
            "end": 1.35,
        }
    ),
    "SetTranscriptWordsIgnored": Case(
        lambda r: {
            "track_id": "host",
            "start_word_index": 0,
            "end_word_index": 0,
            "ignored": True,
        }
    ),
    "ShortenWordGaps": Case(lambda r: {"expected_head_id": r.head()}),
    "SkipSessionSuggestion": Case(lambda r: {"suggestion_id": "sug1"}, _session),
    "SplitAtTime": Case(lambda r: {"at_time": 0.5, "track_ids": ["host"]}),
    "StageTextMatchCut": Case(lambda r: {"query": "there", "review_required": True}),
    "StageTimeRangeCut": Case(lambda r: STAGE_CUT),
    "StageUtteranceCut": Case(lambda r: {"utterance_index": 0, "review_required": True}),
    "StageWordsCut": Case(
        lambda r: {
            "track_id": "host",
            "start_word_index": 1,
            "end_word_index": 1,
            "review_required": True,
        }
    ),
    "StripSilence": Case(lambda r: {"track_id": "host"}),
    "SuggestPendingEdit": Case(lambda r: {"track_id": "host", "start": 6.0, "end": 6.5}),
    "SuppressBleed": Case(lambda r: {"track_id": "host"}),
    "SuppressLowAudibility": Case(lambda r: {}),
    "TrimClipEdge": Case(
        lambda r: {
            "clip_id": "h2",
            "edge": "in",
            "source_sec": 7.0,
            "mode": "gap",
            "override_audio_checks": True,
            "expected_token": boundary_context(
                r.ws.project,
                TrimBoundaryTarget(clip_id="h2", edge="in", mode=EditMode.GAP),
                defaults=r.ws.effective_config(),
            ).token,
        }
    ),
    "UndoHistory": Case(
        lambda r: {"expected_head_id": r.head()},
        _add_chapter,
    ),
    "UpdateChapter": Case(
        lambda r: {"old_time": 1.0, "old_title": "One", "time": 2.0, "title": "Two"},
        _add_chapter,
    ),
    "UpdateComment": Case(
        lambda r: {"comment_id": r.ws.project.comments[0].id, "body": "edited"},
        _add_comment,
    ),
    "UpdatePendingEdit": Case(
        lambda r: {"id": _pending(r)[0], "start": 6.1, "end": 6.4}, _stage_cut
    ),
    "UpdateSocialClip": Case(
        lambda r: {"id": r.ws.project.social_clip_candidates[0].id, "start": 1.5, "end": 3.0},
        _add_social_clip,
    ),
    "UpdateSocialClipDetails": Case(
        lambda r: {"id": r.ws.project.social_clip_candidates[0].id, "title": "T"},
        _add_social_clip,
    ),
    "VerifyTranscript": Case(
        lambda r: {"track_id": "host", "corrections": [{"word_index": 0, "text": "hello"}]}
    ),
}

# Commands that cannot run on any fixture here. Empty on purpose: add a name only with a reason.
EXCLUDED: dict[str, str] = {}


def test_every_registry_command_has_a_case_and_exclusions_are_real() -> None:
    assert set(EXCLUDED) <= set(COMMANDS), "an excluded command is not in the registry"
    missing = set(COMMANDS) - set(CASES) - set(EXCLUDED)
    assert not missing, f"give these commands a case: {sorted(missing)}"
    assert not set(CASES) - set(COMMANDS), "a case names a command the registry lacks"
    assert not set(CASES) & set(EXCLUDED)


@pytest.mark.parametrize("command_type", sorted(COMMANDS))
def test_a_guest_shows_current_audio_identity_after_the_command_and_its_undo_redo(
    template: Path, tmp_path: Path, command_type: str
) -> None:
    if command_type in EXCLUDED:
        pytest.skip(EXCLUDED[command_type])
    case = CASES[command_type]
    rig = _open(template, tmp_path, case)
    if case.setup is not None:
        case.setup(rig)
    payload = case.payload(rig)
    guest = Guest(rig)
    guest.assert_current("before")
    head = rig.head()
    guest.step(command_type, payload)
    guest.assert_current(command_type)
    if rig.head() == head or not rig.ws.project.history.can_undo():
        return
    guest.step("UndoHistory", {"expected_head_id": rig.head()})
    guest.assert_current(f"Undo({command_type})")
    guest.step("RedoHistory", {"expected_head_id": rig.head()})
    guest.assert_current(f"Redo({command_type})")

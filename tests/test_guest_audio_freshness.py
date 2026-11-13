"""A guest learns of every change to the proxy audio it plays.

Ground truth is the set of proxy artifacts a fresh manifest would reference: the (context track,
input hash) pairs of the inputs ``_ensure`` selects. For every command in the registry, on a
project with a gated, transcribed dialogue track and a track of every other role that owns its
own recording, the guest's view is advanced the way the client advances it (delta operations, or
the replacement snapshot, or a refetch on ``resync``). Whenever the artifacts change, the key the
client matches manifests on must change; and that key must always equal the manifest's own.
Commands that target a track or clip run once per track role. A case that cannot move the
artifacts proves nothing, so it must be listed in ``CANNOT_MOVE_AUDIO`` with the reason.
The fields the client's key reads are pinned by ``fixtures/proxy_basis/key.json``, which the
client's tests read too.
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

from podcast_mcp.edits.range_target import build_range_target
from podcast_mcp.edits.transcript_timing import WordTimingTarget
from podcast_mcp.engines import source_proxy_audio
from podcast_mcp.engines.ffmpeg import FFmpegEngine
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
    ProxyClipBasis,
    RangeInterval,
    RecordSessionRecord,
    SessionSuggestion,
    SourceRecording,
    StagedTake,
    TrackRole,
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
from podcast_mcp.services.media import proxy_variants
from podcast_mcp.util.batch_scope import batch_scope, frozen_state, unscoped
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.util.project_state import file_revision
from test_bleed_alignment_surfaces import _workspace as _bleed_surfaces_workspace
from test_room_tone_extract import SPEECH_THEN_ROOM, _host_audio, _project
from test_segments_insert import _save

Sections = dict[tuple[str, str | None], Any]
Key = tuple[tuple[tuple[str, str], ...], tuple[tuple[Any, ...], ...]]
Artifacts = frozenset[tuple[str, str]]

KEY = json.loads(
    (Path(__file__).parent / "fixtures" / "proxy_basis" / "key.json").read_text(encoding="utf-8")
)
ROLES = tuple(TrackRole)
_DIGESTS: dict[tuple[Path, tuple[int, int, int, int]], str] = {}


def _sha256_once(path: Path) -> str:
    key = (path.resolve(), file_revision(path))
    if key not in _DIGESTS:
        _DIGESTS[key] = sha256_file(path)
    return _DIGESTS[key]


@pytest.fixture(autouse=True)
def _hash_each_file_revision_once(monkeypatch: pytest.MonkeyPatch) -> None:
    # Capturing proxy inputs digests every file, ffmpeg included; a file revision's digest
    # does not change, so each is read once per session.
    monkeypatch.setattr(source_proxy_audio, "sha256_file", _sha256_once)


@dataclass(frozen=True)
class Target:
    role: TrackRole

    @property
    def track(self) -> str:
        return "host" if self.role is TrackRole.DIALOGUE else self.role.value

    @property
    def left(self) -> str:
        return "h1" if self.role is TrackRole.DIALOGUE else f"{self.role.value}1"

    @property
    def right(self) -> str:
        return "h2" if self.role is TrackRole.DIALOGUE else f"{self.role.value}2"


@dataclass
class Rig:
    ws: ProjectWorkspace
    root: Path
    seq: int = 0

    def host(self, command_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self.submit(command_type, payload, audience="host")

    def submit(self, command_type: str, payload: dict[str, Any], *, audience: str) -> dict:
        self.seq += 1
        # The command runs as it would outside the test's batch scope.
        with unscoped():
            return DocumentSyncService(self.ws).submit(
                DocumentCommand(
                    type=command_type,
                    payload=payload,
                    client_id="freshness",
                    role="host",
                    client_seq=self.seq,
                ),
                range_policy="apply",
                audience=audience,
            )

    def head(self) -> str:
        return self.ws.project.history.head_id()


def _artifacts(ws: ProjectWorkspace) -> Artifacts:
    defaults = ws.effective_config()
    inputs = proxy_variants.capture_manifest_inputs(ws.project, FFmpegEngine(), defaults)
    return inputs.artifacts(ws.project, defaults)


def _guest_sections(ws: ProjectWorkspace) -> Sections:
    view = dump_project_projection(ws, projection="shell", audience="guest")
    wire = sanitize_guest_document_event({"snapshot": {"project": view}})
    return split(wire["snapshot"]["project"])


def _apply_operations(sections: Sections, operations: list[dict[str, Any]]) -> Sections:
    # Operations replace sections and rows whole, so the earlier sections stay as they were.
    sections = dict(sections)
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


def _walk(value: Any, path: list[str]) -> Any:
    if not path:
        return value
    if not isinstance(value, dict):
        return None
    head, *rest = path
    if head == "*":
        return {k: v for k, item in value.items() if (v := _walk(item, rest))}
    return _walk(value.get(head), rest)


def _key(hashes: dict[str, str], clips: dict[str, tuple[Any, ...]]) -> Key:
    return tuple(sorted(hashes.items())), tuple(sorted((cid, *row) for cid, row in clips.items()))


def _client_key(sections: Sections) -> Key:
    """What ``proxyBasisKey(projectProxyBasis(project))`` reads from the guest's project."""
    status = dict(sections.get(("render_status", None)) or {})
    status["tracks"] = {
        row["key"]: row["value"] for row in sections.get(("render_tracks", None), [])
    }
    hashes = _walk({"render_status": status}, KEY["view_hashes"]) or {}
    clips: dict[str, tuple[Any, ...]] = {}
    for (section, _parent), rows in sections.items():
        if section != "clip_rows":
            continue
        for row in rows:
            clips[row["id"]] = tuple(
                row.get(name) or row["track_id"] if name == "origin_track_id" else row.get(name)
                for name in KEY["clip_fields"]
            )
    return _key(hashes, clips)


def _manifest_key(ws: ProjectWorkspace) -> Key:
    basis = proxy_variants.project_basis(ws.project, ws.effective_config()).model_dump(mode="json")
    hashes = _walk(basis, KEY["manifest_hashes"]) or {}
    clips = {
        cid: tuple(row[name] for name in KEY["clip_fields"]) for cid, row in basis["clips"].items()
    }
    return _key(hashes, clips)


def _observe(ws: ProjectWorkspace) -> tuple[Artifacts, Key]:
    with frozen_state():
        return _artifacts(ws), _manifest_key(ws)


@dataclass(frozen=True)
class Step:
    label: str
    artifacts_moved: bool
    key_moved: bool


class Guest:
    def __init__(self, rig: Rig) -> None:
        self.rig = rig
        self.sections = _guest_sections(rig.ws)
        self.artifacts, self.manifest_key = _observe(rig.ws)
        self.assert_matches_manifest("before")

    def step(self, command_type: str, payload: dict[str, Any], label: str) -> Step:
        key = _client_key(self.sections)
        artifacts = self.artifacts
        reply = self.rig.submit(command_type, payload, audience="guest")
        snapshot = reply["snapshot"]
        if snapshot.get("resync"):
            self.sections = _guest_sections(self.rig.ws)
        elif "delta" in snapshot:
            self.sections = _apply_operations(self.sections, snapshot["delta"]["operations"])
        else:
            assert "project" in snapshot, sorted(snapshot)
            self.sections = split(snapshot["project"])
        self.artifacts, self.manifest_key = _observe(self.rig.ws)
        return Step(label, self.artifacts != artifacts, _client_key(self.sections) != key)

    def assert_matches_manifest(self, label: str) -> None:
        assert _client_key(self.sections) == self.manifest_key, (
            f"{label}: the guest's key differs from the manifest's"
        )


Payload = Callable[[Rig, Target], dict[str, Any]]
Setup = Callable[[Rig, Target], None]


@dataclass(frozen=True)
class Case:
    payload: Payload
    setup: Setup | None = None
    build: Callable[[Path], ProjectWorkspace] | None = None
    # The roles whose track or clip the payload targets; empty for a command without a target.
    roles: tuple[TrackRole, ...] = ROLES


def _once(payload: Payload, setup: Setup | None = None, **kwargs: Any) -> Case:
    return Case(payload, setup, roles=(), **kwargs)


def _template(root: Path) -> Path:
    """A gated, transcribed host with a splittable pair of clips, an ungated guest, a bed to cut,
    and per other track role a track whose two clips play a recording of their own."""
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
    for role in ROLES:
        if role is TrackRole.DIALOGUE:
            continue
        target = Target(role)
        for name in (f"{role.value}.wav", f"{role.value}-take.wav"):
            shutil.copyfile(root / "raw" / "host.wav", root / "raw" / name)
        project.tracks.append(
            Track(
                id=target.track,
                label=role.value.title(),
                role=role,
                media=MediaAsset(path=f"raw/{role.value}.wav", duration_sec=10.0),
            )
        )
        project.sources.append(
            SourceRecording(
                id=f"{role.value}-src",
                path=f"raw/{role.value}-take.wav",
                duration_sec=10.0,
                sample_rate=16000,
                channels=1,
            )
        )
        project.clips += [
            Clip(
                id=clip_id,
                track_id=target.track,
                source_id=f"{role.value}-src",
                source_start=start,
                source_end=start + 5.0,
                timeline_start=start,
            )
            for clip_id, start in ((target.left, 0.0), (target.right, 5.0))
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


def _effect(t: Target) -> dict[str, Any]:
    return {"track_id": t.track, "effect": "highpass"}


COMMENT = {"body": "c", "author": "a", "timeline_start": 1.0}
CHAPTER = {"time": 1.0, "title": "One"}
SOCIAL_CLIP = {"track_id": "host", "start": 1.0, "end": 3.0}


def _stage_payload(t: Target) -> dict[str, Any]:
    start = 6.0 if t.role is TrackRole.DIALOGUE else 1.0
    return {"track_id": t.track, "start": start, "end": start + 0.5, "review_required": True}


FIRST_WORD = [{"track_id": "host", "word_index": 0}]


def _set_feed_field(rig: Rig, t: Target) -> None:
    rig.host("SetFeedField", {"key": "item.title", "value": "d"})


def _add_action_item(rig: Rig, t: Target) -> None:
    rig.host("AddComment", {**COMMENT, "action_texts": ["do"]})


def _suppressed_word(rig: Rig, t: Target) -> None:
    rig.host(
        "SetTranscriptWordSuppressed", {"track_id": "host", "word_index": 0, "suppressed": True}
    )


def _staged_filler(*, review_required: bool) -> Setup:
    def stage(rig: Rig, t: Target) -> None:
        payload = {**_stage_payload(t), "reason": "filler:um", "review_required": review_required}
        rig.host("StageTimeRangeCut", payload)
        assert _pending(rig)

    return stage


def _gap(rig: Rig, t: Target) -> None:
    rig.host(
        "MoveClips", {"clips": [{"clip_id": t.right, "timeline_start": 5.5, "track_id": t.track}]}
    )


def _add_comment(rig: Rig, t: Target) -> None:
    rig.host("AddComment", COMMENT)


def _add_chapter(rig: Rig, t: Target) -> None:
    rig.host("AddChapter", CHAPTER)


def _add_social_clip(rig: Rig, t: Target) -> None:
    rig.host("AddSocialClip", SOCIAL_CLIP)


def _undone_effect(rig: Rig, t: Target) -> None:
    _add_effect(rig, t)
    rig.host("UndoHistory", {"expected_head_id": rig.head()})


def _pending(rig: Rig) -> list[str]:
    rig.ws.reload()
    return [d.id for d in rig.ws.project.editorial.edit_decisions if not d.applied]


def _stage_cut(rig: Rig, t: Target) -> None:
    rig.host("StageTimeRangeCut", _stage_payload(t))
    assert _pending(rig)


def _applied_edit(rig: Rig, t: Target) -> None:
    _stage_cut(rig, t)
    rig.host("ApproveEdits", {"ids": _pending(rig)})


def _add_effect(rig: Rig, t: Target) -> None:
    rig.host("AddEffect", _effect(t))


def _bed(rig: Rig, t: Target) -> None:
    reply = rig.host("ExtractRoomToneBed", {"track_id": t.track})
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


def _session(rig: Rig, t: Target) -> None:
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


def _applied_alignment(rig: Rig, t: Target) -> None:
    window = {"track_id": "uncertain", "start_sec": 0.8, "end_sec": 3.5}
    with write_grant(WriteGrantKind.LEGACY_MCP):
        applied = json.loads(timeline.align_retained_bleed_tool(str(rig.ws.path), **window))
    assert applied["applied_count"] == 1
    rig.ws.reload()


def _alignment_decision(rig: Rig) -> str:
    return rig.ws.project.editorial.retained_bleed_alignments[0].id


def _first_comment(rig: Rig) -> str:
    return rig.ws.project.comments[0].id


def _first_social_clip(rig: Rig) -> str:
    return rig.ws.project.social_clip_candidates[0].id


DIALOGUE = (TrackRole.DIALOGUE,)
NON_DIALOGUE = tuple(role for role in ROLES if role is not TrackRole.DIALOGUE)
# A cut staged on the fixture's other lanes, whose two clips play one recording, is refused
# as having no single continuous placement; CutRange covers a cut on those lanes.
STAGED_CUT_ROLES = DIALOGUE

CASES: dict[str, Case] = {
    "AcceptSessionSuggestion": _once(lambda r, t: {"suggestion_id": "sug1"}, _session),
    "AddAction": _once(lambda r, t: {"comment_id": _first_comment(r), "text": "x"}, _add_comment),
    "AddChapter": _once(lambda r, t: CHAPTER),
    "AddComment": _once(lambda r, t: COMMENT),
    "AddEffect": Case(lambda r, t: _effect(t)),
    "AddReply": _once(
        lambda r, t: {"comment_id": _first_comment(r), "body": "r", "author": "a"}, _add_comment
    ),
    "AddSocialClip": _once(lambda r, t: SOCIAL_CLIP),
    "AddTrack": _once(lambda r, t: {"track_id": "t3", "label": "T3", "role": "music"}),
    "ApplyAutoEdits": _once(lambda r, t: {}, _staged_filler(review_required=False)),
    "ApplyEditPlan": Case(
        lambda r, t: {
            "edits": [{k: _stage_payload(t)[k] for k in ("track_id", "start", "end")}],
            "review_required": False,
        },
        roles=STAGED_CUT_ROLES,
    ),
    "ApplyFadeRecommendationList": Case(
        lambda r, t: {
            "recommendations": [{"clip_id": t.right, "fade_in_ms": 20, "fade_out_ms": 20}]
        }
    ),
    "ApplyFadeRecommendations": Case(lambda r, t: {"track_id": t.track}),
    "ApplySuggestedActions": _once(lambda r, t: {}, _staged_filler(review_required=True)),
    "ApplyTranscriptCleanup": Case(
        lambda r, t: {
            "track_id": "host",
            "words": [{"word_index": 1, "text": "there!"}],
            "phrases": [{"start_word_index": 0, "end_word_index": 0, "text": "hi there"}],
        },
        roles=DIALOGUE,
    ),
    "ApproveEdits": Case(lambda r, t: {"ids": _pending(r)}, _stage_cut, roles=STAGED_CUT_ROLES),
    "ClearExtractedRoomToneBed": Case(lambda r, t: {"track_id": t.track}, _bed, roles=DIALOGUE),
    "ClearFeedField": _once(
        lambda r, t: {"key": "item.title"},
        _set_feed_field,
    ),
    "CorrectTranscriptPhrase": Case(
        lambda r, t: {
            "track_id": "host",
            "start_word_index": 0,
            "end_word_index": 1,
            "text": "howdy you",
        },
        roles=DIALOGUE,
    ),
    "CorrectTranscriptWord": Case(
        lambda r, t: {"track_id": "host", "word_index": 0, "text": "howdy"}, roles=DIALOGUE
    ),
    "CrossfadeJoins": Case(lambda r, t: {"track_id": t.track}),
    "CutRange": Case(
        lambda r, t: {"start": 6.0, "end": 6.4, "mode": "gap", "track_ids": [t.track]}
    ),
    "DeleteChapter": _once(lambda r, t: {"time": 1.0, "title": "One"}, _add_chapter),
    "DeleteClip": Case(
        lambda r, t: {"clip_id": t.right, "mode": "gap", "override_audio_checks": True}
    ),
    "DeleteComment": _once(lambda r, t: {"comment_id": _first_comment(r)}, _add_comment),
    "DeleteSocialClip": _once(lambda r, t: {"id": _first_social_clip(r)}, _add_social_clip),
    "DuplicateSegment": _once(
        lambda r, t: {"source_start": 0.0, "source_end": 0.3, "insert_at": 3.0}
    ),
    "EditSelectedRange": Case(
        lambda r, t: {
            "action": "cut",
            "targets": [
                build_range_target(
                    r.ws.project,
                    [RangeInterval(start=_stage_payload(t)["start"], end=_stage_payload(t)["end"])],
                    [t.track],
                ).model_dump(mode="json")
            ],
        },
        roles=STAGED_CUT_ROLES,
    ),
    "ExtractRoomToneBed": Case(lambda r, t: {"track_id": t.track}, roles=DIALOGUE),
    "FadeJoins": Case(lambda r, t: {"track_id": t.track}),
    "FillRoomTone": Case(lambda r, t: {"track_id": t.track}, _gap),
    "InsertGap": _once(lambda r, t: {"at_time": 1.0, "duration_sec": 0.5}),
    "InsertSegment": _once(lambda r, t: {"segment_id": _segment(r), "at": "start"}),
    "MoveByText": _once(
        lambda r, t: {"source_query": "hello", "destination_query": "again", "position": "after"}
    ),
    "MoveClips": Case(
        lambda r, t: {"clips": [{"clip_id": t.right, "timeline_start": 5.25, "track_id": t.track}]}
    ),
    "MoveSegment": _once(lambda r, t: {"source_start": 0.0, "source_end": 0.3, "insert_at": 2.5}),
    "PasteSegment": _once(
        lambda r, t: {
            "insert_at": 1.0,
            "duration": 0.5,
            "mode": "gap",
            "extracts": [
                {"track_id": "host", "source_start": 6.0, "source_end": 6.5, "offset": 0.0}
            ],
        }
    ),
    "ProposeSocialClips": _once(lambda r, t: {}),
    "ProposeTighten": _once(lambda r, t: {}),
    "ReconcileTranscript": Case(lambda r, t: {"track_id": t.track}, roles=DIALOGUE),
    "RedoHistory": Case(lambda r, t: {"expected_head_id": r.head()}, _undone_effect),
    "RejectEdits": Case(lambda r, t: {"ids": _pending(r)}, _stage_cut, roles=STAGED_CUT_ROLES),
    "RemoveEffect": Case(lambda r, t: _effect(t), _add_effect),
    "RemoveTrack": Case(lambda r, t: {"track_id": t.track}),
    "RenameProject": _once(lambda r, t: {"name": "renamed"}),
    "ReorderTrack": Case(lambda r, t: {"track_id": t.track, "index": 0}),
    "ReplaceTranscriptMatches": _once(
        lambda r, t: {
            "search": "again",
            "replacement": "once more",
            "match_case": False,
            "preview_token": _replace_preview(r),
        }
    ),
    "ResolveComment": _once(
        lambda r, t: {"comment_id": _first_comment(r), "by": "a"}, _add_comment
    ),
    "RestoreAppliedEdit": Case(
        lambda r, t: {"ids": [r.ws.project.editorial.edit_log[-1].id]},
        _applied_edit,
        roles=STAGED_CUT_ROLES,
    ),
    "RestoreClipBleed": Case(lambda r, t: {"target": _bleed_target(r)}, roles=DIALOGUE),
    "RippleDeleteText": _once(lambda r, t: {"query": "there", "override_audio_checks": True}),
    "RollClipJoin": Case(
        lambda r, t: {
            "left_clip_id": t.left,
            "right_clip_id": t.right,
            "delta_sec": 0.1,
            "expected_token": boundary_context(
                r.ws.project,
                RollBoundaryTarget(left_clip_id=t.left, right_clip_id=t.right),
                defaults=r.ws.effective_config(),
            ).token,
        }
    ),
    "SelectSessionTake": _once(lambda r, t: {"suggestion_id": "sug2", "take_index": 1}, _session),
    "SetActionDone": _once(
        lambda r, t: {
            "comment_id": _first_comment(r),
            "action_id": r.ws.project.comments[0].action_items[0].id,
            "by": "a",
        },
        _add_action_item,
    ),
    "SetBleedAlignmentMode": _once(
        lambda r, t: {
            "decision_id": _alignment_decision(r),
            "mode": "declined",
            "track_id": "uncertain",
            "start_sec": 0.8,
            "end_sec": 3.5,
        },
        _applied_alignment,
        build=_bleed_workspace,
    ),
    "SetClipFade": Case(
        lambda r, t: {
            "clip_id": t.left,
            "fade_in_ms": 20,
            "fade_out_ms": 20,
            "expected": {"fade_in_ms": 0, "fade_out_ms": 0},
        }
    ),
    "SetClipGain": Case(
        lambda r, t: {"clip_id": t.left, "gain_db": 3.0, "expected": {"gain_db": 0.0}}
    ),
    "SetClipJoin": Case(
        lambda r, t: {
            "left_clip_id": t.left,
            "right_clip_id": t.right,
            "mode": "crossfade",
            "length_ms": 30,
        }
    ),
    "SetClipsFade": Case(
        lambda r, t: {
            "fades": [
                {
                    "clip_id": t.right,
                    "fade_in_ms": 10,
                    "fade_out_ms": 10,
                    "expected": {"fade_in_ms": 0, "fade_out_ms": 0},
                }
            ]
        }
    ),
    "SetClipsGain": Case(
        lambda r, t: {
            "gains": [{"clip_id": t.right, "gain_db": -2.0, "expected": {"gain_db": 0.0}}]
        }
    ),
    "SetEffectBypass": Case(
        lambda r, t: {"track_id": t.track, "effect_index": 0, "bypass": True}, _add_effect
    ),
    "SetEnvelope": Case(
        lambda r, t: {
            "track_id": t.track,
            "points": [
                {"id": "p1", "time": 0.0, "value": 1.0},
                {"id": "p2", "time": 1.0, "value": 0.5},
            ],
            "expected_points": [],
        }
    ),
    "SetFeedField": _once(lambda r, t: {"key": "item.title", "value": "d"}),
    "SetJoinFadeLimit": _once(lambda r, t: {"ms": 100}),
    "SetJoinMode": Case(lambda r, t: {"clip_id": t.right, "join_in_mode": "cut"}),
    "SetRecordSessionName": _once(
        lambda r, t: {"session_id": "s" * 12, "name": "Cold open"}, _session
    ),
    "SetTrackFader": Case(lambda r, t: {"track_id": t.track, "fader_db": -3.0}),
    "SetTrackMedia": Case(lambda r, t: {"track_id": t.track, "rel_path": "raw/guest.wav"}),
    "SetTrackMeta": Case(
        lambda r, t: {
            "track_id": t.track,
            "role": "music" if t.role is TrackRole.DIALOGUE else "dialogue",
        }
    ),
    "SetTrackMute": Case(lambda r, t: {"track_id": t.track, "muted": True}),
    "SetTranscriptWordAutomatic": Case(
        lambda r, t: {"track_id": "host", "word_index": 0},
        _suppressed_word,
        roles=DIALOGUE,
    ),
    "SetTranscriptWordSuppressed": Case(
        lambda r, t: {"track_id": "host", "word_index": 0, "suppressed": True}, roles=DIALOGUE
    ),
    "SetTranscriptWordTiming": Case(
        lambda r, t: {
            "target": {"track_id": "host", "source_id": None, "word_index": 0},
            "expected_token": _timing_token(r),
            "start": 1.05,
            "end": 1.35,
        },
        roles=DIALOGUE,
    ),
    "SetTranscriptWordsIgnored": Case(
        lambda r, t: {
            "track_id": "host",
            "start_word_index": 0,
            "end_word_index": 0,
            "ignored": True,
        },
        roles=DIALOGUE,
    ),
    "ShortenWordGaps": _once(lambda r, t: {"max_gap_sec": 0.3, "override_audio_checks": True}),
    "SkipSessionSuggestion": _once(lambda r, t: {"suggestion_id": "sug1"}, _session),
    "SplitAtTime": Case(lambda r, t: {"at_time": 0.5, "track_ids": [t.track]}),
    "StageTextMatchCut": _once(lambda r, t: {"query": "there", "review_required": True}),
    "StageTimeRangeCut": Case(lambda r, t: _stage_payload(t), roles=STAGED_CUT_ROLES),
    "StageUtteranceCut": _once(lambda r, t: {"utterance_index": 0, "review_required": True}),
    "StageWordsCut": Case(
        lambda r, t: {
            "track_id": "host",
            "start_word_index": 1,
            "end_word_index": 1,
            "review_required": True,
        },
        roles=DIALOGUE,
    ),
    "StripSilence": Case(lambda r, t: {"track_id": t.track}),
    "SuggestPendingEdit": Case(
        lambda r, t: {"track_id": t.track, "start": 6.0, "end": 6.5}, roles=STAGED_CUT_ROLES
    ),
    "SuppressBleed": Case(lambda r, t: {"track_id": "host", "words": FIRST_WORD}, roles=DIALOGUE),
    "SuppressLowAudibility": Case(lambda r, t: {"words": FIRST_WORD}, roles=DIALOGUE),
    "TrimClipEdge": Case(
        lambda r, t: {
            "clip_id": t.right,
            "edge": "in",
            "source_sec": 7.0,
            "mode": "gap",
            "override_audio_checks": True,
            "expected_token": boundary_context(
                r.ws.project,
                TrimBoundaryTarget(clip_id=t.right, edge="in", mode=EditMode.GAP),
                defaults=r.ws.effective_config(),
            ).token,
        }
    ),
    "UndoHistory": Case(lambda r, t: {"expected_head_id": r.head()}, _add_effect),
    "UpdateChapter": _once(
        lambda r, t: {"old_time": 1.0, "old_title": "One", "time": 2.0, "title": "Two"},
        _add_chapter,
    ),
    "UpdateComment": _once(
        lambda r, t: {"comment_id": _first_comment(r), "body": "edited"}, _add_comment
    ),
    "UpdatePendingEdit": Case(
        lambda r, t: {"id": _pending(r)[0], "start": 6.1, "end": 6.4},
        _stage_cut,
        roles=STAGED_CUT_ROLES,
    ),
    "UpdateSocialClip": _once(
        lambda r, t: {"id": _first_social_clip(r), "start": 1.5, "end": 3.0}, _add_social_clip
    ),
    "UpdateSocialClipDetails": _once(
        lambda r, t: {"id": _first_social_clip(r), "title": "T"}, _add_social_clip
    ),
    "VerifyTranscript": Case(
        lambda r, t: {"track_id": "host", "corrections": [{"word_index": 0, "text": "hello"}]},
        roles=DIALOGUE,
    ),
}


@dataclass(frozen=True)
class Cannot:
    reason: str
    roles: tuple[TrackRole, ...] = field(default=ROLES)


# Commands, or roles of a command, that leave every proxy artifact as it was, and why.
PLACEMENT = (
    "a non-dialogue track's artifact is its whole recording; the player cuts, places, fades "
    "and gains its clips from the clip rows"
)
METADATA = "review, chapter, social, feed or naming metadata; no audio input"
PENDING = "stages or reviews edit decisions; nothing plays until one is applied"
CANNOT_MOVE_AUDIO: dict[str, Cannot] = {
    **dict.fromkeys(
        [
            "AddAction",
            "AddChapter",
            "AddComment",
            "AddReply",
            "AddSocialClip",
            "ClearFeedField",
            "DeleteChapter",
            "DeleteComment",
            "DeleteSocialClip",
            "ProposeSocialClips",
            "RenameProject",
            "ResolveComment",
            "SetActionDone",
            "SetFeedField",
            "SetRecordSessionName",
            "UpdateChapter",
            "UpdateComment",
            "UpdateSocialClip",
            "UpdateSocialClipDetails",
        ],
        Cannot(METADATA),
    ),
    **dict.fromkeys(
        [
            "ApplyEditPlan",
            "ProposeTighten",
            "RejectEdits",
            "SelectSessionTake",
            "SkipSessionSuggestion",
            "StageTextMatchCut",
            "StageTimeRangeCut",
            "StageUtteranceCut",
            "StageWordsCut",
            "SuggestPendingEdit",
            "UpdatePendingEdit",
        ],
        Cannot(PENDING),
    ),
    **dict.fromkeys(
        [
            "ApplyFadeRecommendationList",
            "ApplyFadeRecommendations",
            "CrossfadeJoins",
            "CutRange",
            "DeleteClip",
            "FadeJoins",
            "FillRoomTone",
            "MoveClips",
            "RollClipJoin",
            "SetClipFade",
            "SetClipGain",
            "SetClipJoin",
            "SetClipsFade",
            "SetClipsGain",
            "SetJoinMode",
            "SplitAtTime",
            "TrimClipEdge",
        ],
        Cannot(PLACEMENT, NON_DIALOGUE),
    ),
    "AddTrack": Cannot("a new track has no media and no clips, so no artifact reads it"),
    "CorrectTranscriptWord": Cannot("word text and confidence only; the gate reads neither"),
    "ReorderTrack": Cannot("track order is no artifact's input"),
    "SetBleedAlignmentMode": Cannot(
        "records a choice the next bleed alignment pass reads; no render reads the record"
    ),
    "SetEnvelope": Cannot("the player applies volume envelopes over the artifacts"),
    "SetJoinFadeLimit": Cannot("caps only fades the automatic join writers pick later"),
    "SetTrackFader": Cannot("the player applies the mix fader"),
    "SetTrackMute": Cannot("the player applies the mix mute"),
    "VerifyTranscript": Cannot("word text and confidence only; the gate reads neither"),
}


def _cannot(command_type: str, role: TrackRole | None) -> Cannot | None:
    cannot = CANNOT_MOVE_AUDIO.get(command_type)
    if cannot is None or (role is not None and role not in cannot.roles):
        return None
    return cannot


def _params() -> list[Any]:
    return [
        pytest.param(name, role, id=name if role is None else f"{name}-{role.value}")
        for name in sorted(COMMANDS)
        if name in CASES
        for role in (CASES[name].roles or (None,))
    ]


def test_every_registry_command_has_a_case_and_every_listing_is_real() -> None:
    missing = set(COMMANDS) - set(CASES)
    assert not missing, f"give these commands a case: {sorted(missing)}"
    assert not set(CASES) - set(COMMANDS), "a case names a command the registry lacks"
    assert set(CANNOT_MOVE_AUDIO) <= set(COMMANDS), "CANNOT_MOVE_AUDIO names an unknown command"


def test_the_manifest_key_reads_every_clip_field_the_manifest_carries() -> None:
    assert set(ProxyClipBasis.model_fields) == set(KEY["clip_fields"])


def run_case(template: Path, tmp_path: Path, command_type: str, role: TrackRole | None) -> list:
    # The scope decodes each recording once for every artifact capture the case makes.
    with batch_scope():
        return _run_case(template, tmp_path, command_type, role)


def _run_case(template: Path, tmp_path: Path, command_type: str, role: TrackRole | None) -> list:
    case = CASES[command_type]
    target = Target(role or TrackRole.DIALOGUE)
    rig = _open(template, tmp_path, case)
    if case.setup is not None:
        case.setup(rig, target)
    payload = case.payload(rig, target)
    guest = Guest(rig)
    head = rig.head()
    steps = [guest.step(command_type, payload, command_type)]
    guest.assert_matches_manifest(command_type)
    if rig.head() == head or not rig.ws.project.history.can_undo():
        return steps
    for name in ("UndoHistory", "RedoHistory"):
        label = f"{name}({command_type})"
        steps.append(guest.step(name, {"expected_head_id": rig.head()}, label))
        guest.assert_matches_manifest(label)
    return steps


@pytest.mark.parametrize(("command_type", "role"), _params())
def test_a_guest_learns_of_every_proxy_artifact_change(
    template: Path, tmp_path: Path, command_type: str, role: TrackRole | None
) -> None:
    steps = run_case(template, tmp_path, command_type, role)
    for step in steps:
        assert step.key_moved or not step.artifacts_moved, (
            f"{step.label}: the proxy artifacts changed but the guest's key did not"
        )
    cannot = _cannot(command_type, role)
    if cannot is None:
        assert steps[0].artifacts_moved, (
            f"{command_type}: the case leaves every proxy artifact as it was, so it proves "
            "nothing; give it a fixture where it changes audio or list it in CANNOT_MOVE_AUDIO"
        )
    else:
        assert not steps[0].artifacts_moved, (
            f"{command_type} is in CANNOT_MOVE_AUDIO ({cannot.reason}) but changed audio"
        )

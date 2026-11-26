"""Pin the exact wire output of reconcile_transcript and preview_reconcile_transcript."""

from __future__ import annotations

import json
from contextlib import nullcontext
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from audibility_floors import floors_at
from podcast_mcp.cli.main import app
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines.analysis_policy import AnalysisPolicy
from podcast_mcp.engines.bleed_echo import EchoPairProfile
from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.mcp.tools import transcript
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.project.store import save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import AnalysisService
from podcast_mcp.services.document_sync import (
    DocumentSyncService,
    host_command_result,
    submit_host_document_command,
)
from podcast_mcp.services.document_sync.handlers import edits as edit_handlers
from podcast_mcp.util.coded_error import CodedError

pytestmark = pytest.mark.unscoped_ok

_GUEST_TO_HOST_MEASURED = patch(
    "podcast_mcp.engines.pcm_cache.TrackRmsCacheSet.echo_pairs",
    new=lambda self: [
        EchoPairProfile(
            source_track_id="guest",
            bleed_track_id="host",
            span_start=0.0,
            span_end=10.0,
            dominated_frames=100,
            copy_frames=40,
            consistent_frames=30,
            lag_ms=3.0,
            level_db=-18.0,
            examples=(1.0,),
            null_runs=8,
            null_copy_rate=0.05,
            null_consistent_rate=0.02,
        )
    ],
)
_FP = '"<fp>"'
_FLAGS = {"track_id": "--track", "speaker": "--speaker", "start_sec": "--start", "end_sec": "--end"}


def _fake_rms(project, track_id, t_start, t_end, **kwargs):
    host_bleed = (1.0, 3.0, 5.0)
    if any(a <= t_start < a + 0.6 for a in host_bleed) or 3.0 <= t_start < 4.0:
        return -40.0 if track_id == "host" else -30.0
    if track_id == "host" and 2.0 <= t_start < 2.6:
        return -55.0
    if track_id == "guest" and 2.0 <= t_start < 2.6:
        return -60.0
    return -30.0


@pytest.fixture(autouse=True)
def _synthetic_audio():
    with (
        floors_at(-42.0),
        _GUEST_TO_HOST_MEASURED,
        patch("podcast_mcp.engines.audio_audit._rms_for_track_at_timeline", side_effect=_fake_rms),
    ):
        yield


def _bleed(text: str, start: float, end: float) -> TranscriptWord:
    return TranscriptWord(
        text=text,
        start=start,
        end=end,
        confidence=0.9,
        audibility_status="bleed",
        dominant_track="guest",
    )


def _build(tmp_path: Path, kind: str) -> ProjectWorkspace:
    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    for tid, speaker in (("host", "Host"), ("guest", "Guest")):
        raw = tmp_path / "raw" / f"{tid}.wav"
        raw.parent.mkdir(exist_ok=True)
        raw.write_bytes(b"\x00" * 100)
        project.timeline.tracks.append(
            Track(
                id=tid,
                label=speaker,
                role=TrackRole.DIALOGUE,
                speaker=speaker,
                media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=10.0),
            )
        )
        project.timeline.clips.append(
            Clip(id=f"c-{tid}", track_id=tid, source_start=0.0, source_end=10.0, timeline_start=0.0)
        )
    host_words = [
        TranscriptWord(text="hello", start=0.0, end=0.5, confidence=0.9),
        _bleed("bleed", 1.0, 1.5),
        TranscriptWord(
            text="quiet", start=2.0, end=2.5, confidence=0.9, audibility_status="inaudible"
        ),
        _bleed("loud", 3.0, 4.0),
        _bleed("later", 5.0, 5.5),
    ]
    host_words[0].suppressed = kind == "wrongly_suppressed"
    guest_words = [
        TranscriptWord(text="bleed", start=1.0, end=1.5, confidence=0.9),
        TranscriptWord(text="loud", start=3.0, end=4.0, confidence=0.9),
        TranscriptWord(text="later", start=5.0, end=5.5, confidence=0.9),
    ]
    project.transcripts = [
        Transcript(track_id="host", words=host_words),
        Transcript(track_id="guest", words=guest_words),
    ]
    project.combined_transcript = TranscriptionEngine(defaults=load_defaults()).merge_transcripts(
        project
    )
    ws = ProjectWorkspace.open(save_project(project))
    if kind == "reconciled":
        AnalysisService(ws).reconcile_transcript()
    return ws


def _dump(value: Any) -> str:
    return json.dumps(value, sort_keys=True)


def _norm(text: str, ws: ProjectWorkspace) -> dict[str, Any]:
    text = text.replace(str(ws.path.parent), "<ws>")
    out = json.loads(text)
    status = out["reconciliation"]
    for key in ("fingerprint", "last_reconciliation_hash"):
        status[key] = "<fp>" if status[key] is not None else None
    return out


def _payload(kwargs: dict[str, Any]) -> dict[str, Any]:
    keys = ("track_id", "speaker", "dry_run", "start_sec", "end_sec")
    return {key: kwargs.get(key) for key in keys}


def _cli_args(ws: ProjectWorkspace, kwargs: dict[str, Any]) -> list[str]:
    args = ["edit", "reconcile-transcript", "--project", str(ws.path)]
    for key, flag in _FLAGS.items():
        if kwargs.get(key) is not None:
            args += [flag, str(kwargs[key])]
    if kwargs.get("dry_run") is True:
        args.append("--dry-run")
    if kwargs.get("dry_run") is False:
        args.append("--apply")
    return args


def _invoke(surface: str, ws: ProjectWorkspace, kwargs: dict[str, Any]) -> str:
    service = AnalysisService(ws)
    if surface == "service":
        return _dump(service.reconcile_transcript(**kwargs))
    if surface == "preview":
        return _dump(service.preview_reconcile_transcript(**kwargs))
    if surface == "mcp":
        return transcript.reconcile_transcript_tool(str(ws.path), **kwargs)
    if surface == "cli":
        result = CliRunner().invoke(app, _cli_args(ws, kwargs))
        assert result.exit_code == 0, result.output
        return result.output
    if surface == "handler":
        return _dump(edit_handlers.reconcile_transcript(ws, _payload(kwargs)))
    reply = submit_host_document_command(ws.path, "ReconcileTranscript", _payload(kwargs))
    return _dump(host_command_result(reply))


def _row(index, text, start, end, status, dominant, reason, **extra):
    return {
        "audibility_status": status,
        "dominant_track": dominant,
        "end": end,
        "reason": reason,
        "source_id": None,
        "start": start,
        "text": text,
        "track_id": "host",
        "word_index": index,
        **extra,
    }


def _bleed_row(index, text, start, end, **extra):
    return _row(index, text, start, end, "bleed", "guest", "cross_track_bleed", **extra)


_QUIET = _row(2, "quiet", 2.0, 2.5, "inaudible", None, "below_audibility_threshold")
_BLEED = _bleed_row(1, "bleed", 1.0, 1.5)
_LOUD = _bleed_row(3, "loud", 3.0, 4.0)
_LATER = _bleed_row(4, "later", 5.0, 5.5)
_SUPPRESS = [_BLEED, _QUIET, _LOUD, _LATER]
_REATTRIBUTE = [{**row, "attributed_to_track": "guest"} for row in (_BLEED, _LOUD, _LATER)]
_HELLO = {
    "audibility_status": "audible",
    "end": 0.5,
    "source_id": None,
    "start": 0.0,
    "text": "hello",
    "track_id": "host",
    "word_index": 0,
}
_STATUS = {
    "fingerprint": "<fp>",
    "last_reconciliation_hash": None,
    "reconciliation_stale_flag": False,
    "stale": True,
}
_FRESH = {**_STATUS, "last_reconciliation_hash": "<fp>", "stale": False}


def _report(suppress, reattribute, *, applied, status_updates, status, unsuppress=()):
    return {
        "applied": applied,
        "reattribute": reattribute,
        "reattribute_count": len(reattribute),
        "reconciliation": status,
        "status_updates": status_updates,
        "suppress": suppress,
        "suppress_count": len(suppress),
        "unsuppress": list(unsuppress),
        "unsuppress_count": len(unsuppress),
    }


_PREVIEW = _report(_SUPPRESS, _REATTRIBUTE, applied=False, status_updates=4, status=_STATUS)
_APPLIED = _report(_SUPPRESS, _REATTRIBUTE, applied=True, status_updates=4, status=_FRESH)
_NOTHING = _report([], [], applied=True, status_updates=0, status=_FRESH)
_OFF = _report([], [], applied=False, status_updates=0, status=_STATUS)
_WINDOW = _report(
    [_QUIET, _LOUD],
    [{**_LOUD, "attributed_to_track": "guest"}],
    applied=False,
    status_updates=1,
    status=_STATUS,
)
_HOST_DRY = {**_PREVIEW, "status_updates": 1}
_HOST_APPLIED = {**_APPLIED, "status_updates": 1}
_GUEST = _report([], [], applied=True, status_updates=3, status=_FRESH)
_UNSUPPRESS = {**_PREVIEW, "unsuppress": [_HELLO], "unsuppress_count": 1}
_MODES = ("flag", "suggest", "off")

_CASES = {
    "default": ("base", None, {}, _APPLIED),
    "dry_run": ("base", None, {"dry_run": True}, _PREVIEW),
    "explicit_apply": ("base", None, {"dry_run": False}, _APPLIED),
    "host_track_dry_run": ("base", None, {"track_id": "host", "dry_run": True}, _HOST_DRY),
    "host_speaker_apply": ("base", None, {"speaker": "Host", "dry_run": False}, _HOST_APPLIED),
    "guest_track_has_nothing_to_change": ("base", None, {"track_id": "guest"}, _GUEST),
    "window_dry_run": ("base", None, {"dry_run": True, "start_sec": 1.2, "end_sec": 3.5}, _WINDOW),
    "wrongly_suppressed_dry_run": ("wrongly_suppressed", None, {"dry_run": True}, _UNSUPPRESS),
    "wrongly_suppressed_apply": (
        "wrongly_suppressed",
        None,
        {},
        {**_UNSUPPRESS, "applied": True, "reconciliation": _FRESH},
    ),
    "already_reconciled": ("reconciled", None, {}, _NOTHING),
    "already_reconciled_dry_run": (
        "reconciled",
        None,
        {"dry_run": True},
        {**_NOTHING, "applied": False},
    ),
    "flag_mode_tags_only": ("base", "flag", {}, {**_APPLIED}),
    "suggest_mode_tags_only": ("base", "suggest", {}, {**_APPLIED}),
    "off_mode": ("base", "off", {}, _OFF),
    "off_mode_forced_apply": ("base", "off", {"dry_run": False}, _OFF),
}


def _surfaces_for(kwargs: dict[str, Any]) -> list[str]:
    if kwargs.get("dry_run") is True:
        return ["service", "preview", "mcp", "cli", "handler"]
    return ["service", "mcp", "cli", "handler", "host"]


_PARAMS = [
    pytest.param(name, surface, id=f"{name}-{surface}")
    for name, case in _CASES.items()
    for surface in _surfaces_for(case[2])
]


@pytest.mark.parametrize(("name", "surface"), _PARAMS)
def test_reconcile_wire(tmp_path, name, surface):
    kind, mode, kwargs, expected = _CASES[name]
    ws = _build(tmp_path, kind)
    call_kwargs = {k: v for k, v in kwargs.items() if surface != "preview" or k != "dry_run"}
    scope = (
        patch.object(
            AnalysisPolicy, "from_defaults", return_value=AnalysisPolicy(transcript_mode=mode)
        )
        if mode
        else nullcontext()
    )
    with scope:
        text = _invoke(surface, ws, call_kwargs)
    assert _dump(_norm(text, ws)) == _dump(expected)


def _suppressed(ws: ProjectWorkspace) -> list[tuple[str, int]]:
    saved = ProjectWorkspace.open(ws.path).project
    return [
        (tr.track_id, i) for tr in saved.transcripts for i, w in enumerate(tr.words) if w.suppressed
    ]


def _journal(ws: ProjectWorkspace) -> list[dict]:
    return DocumentSyncService.open(ws.path).store.commands_after(0)


@pytest.mark.parametrize("surface", ["service", "preview", "mcp", "cli", "handler"])
def test_dry_run_writes_nothing(tmp_path, surface):
    ws = _build(tmp_path, "base")
    before = ws.path.read_bytes()
    kwargs = {} if surface == "preview" else {"dry_run": True}
    assert _norm(_invoke(surface, ws, kwargs), ws)["applied"] is False
    assert ws.path.read_bytes() == before
    assert _journal(ws) == []


@pytest.mark.parametrize("surface", ["service", "mcp", "cli", "handler", "host"])
def test_apply_suppresses_the_listed_words(tmp_path, surface):
    ws = _build(tmp_path, "base")
    _invoke(surface, ws, {})
    assert _suppressed(ws) == [("host", 1), ("host", 2), ("host", 3), ("host", 4)]


@pytest.mark.parametrize("mode", ["flag", "suggest", "off"])
def test_non_reconcile_modes_suppress_nothing(tmp_path, mode):
    ws = _build(tmp_path, "base")
    policy = AnalysisPolicy(transcript_mode=mode)
    with patch.object(AnalysisPolicy, "from_defaults", return_value=policy):
        AnalysisService(ws).reconcile_transcript()
    assert _suppressed(ws) == []


def test_mcp_apply_is_journaled_as_one_command_and_dry_run_is_not(tmp_path):
    ws = _build(tmp_path, "base")
    transcript.reconcile_transcript_tool(str(ws.path), dry_run=True)
    assert _journal(ws) == []
    transcript.reconcile_transcript_tool(str(ws.path))
    assert [row["type"] for row in _journal(ws)] == ["ReconcileTranscript"]


_UNKNOWN_TRACK = "unknown track_id: 'nobody'"
_UNKNOWN_SPEAKER = "no track for speaker 'nobody'; available: host (Host), guest (Guest)"
_RAISES = {
    "service": ("CodedValueError", lambda ws: AnalysisService(ws).reconcile_transcript),
    "preview": ("CodedValueError", lambda ws: AnalysisService(ws).preview_reconcile_transcript),
    "mcp_dry_run": (
        "CodedValueError",
        lambda ws: (
            lambda **kw: transcript.reconcile_transcript_tool(str(ws.path), dry_run=True, **kw)
        ),
    ),
    "mcp_apply": (
        "DocumentConflictError",
        lambda ws: lambda **kw: transcript.reconcile_transcript_tool(str(ws.path), **kw),
    ),
    "handler": (
        "CodedValueError",
        lambda ws: lambda **kw: edit_handlers.reconcile_transcript(ws, kw),
    ),
    "host": (
        "DocumentConflictError",
        lambda ws: lambda **kw: submit_host_document_command(ws.path, "ReconcileTranscript", kw),
    ),
}


@pytest.mark.parametrize("surface", list(_RAISES))
@pytest.mark.parametrize(
    ("kwargs", "message"),
    [({"track_id": "nobody"}, _UNKNOWN_TRACK), ({"speaker": "nobody"}, _UNKNOWN_SPEAKER)],
    ids=["track", "speaker"],
)
def test_unknown_selector_is_coded_and_changes_nothing(tmp_path, surface, kwargs, message):
    ws = _build(tmp_path, "base")
    before = ws.path.read_bytes()
    error_class, build = _RAISES[surface]
    with pytest.raises(CodedError) as caught:
        build(ws)(**kwargs)
    assert type(caught.value).__name__ == error_class
    assert caught.value.code == "track_not_found"
    assert str(caught.value) == message
    assert ws.path.read_bytes() == before


@pytest.mark.parametrize(
    ("flags", "message"),
    [
        (["--track", "nobody"], _UNKNOWN_TRACK),
        (["--track", "nobody", "--dry-run"], _UNKNOWN_TRACK),
        (["--speaker", "nobody"], _UNKNOWN_SPEAKER),
    ],
)
def test_cli_unknown_selector_error_text(tmp_path, flags, message):
    ws = _build(tmp_path, "base")
    result = CliRunner().invoke(
        app, ["edit", "reconcile-transcript", "--project", str(ws.path), *flags]
    )
    assert result.exit_code == 1
    assert result.output == (
        f"Error: {message} (code track_not_found) (set PODCAST_DEBUG=1 for the traceback)\n"
    )

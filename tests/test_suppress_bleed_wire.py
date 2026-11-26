"""Pin the exact wire output of suppress-bleed and suppress-low-audibility on every surface."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from audibility_floors import floors_at
from podcast_mcp.cli.main import app
from podcast_mcp.config.defaults import load_defaults
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


def _build(tmp_path: Path, kind: str = "base") -> ProjectWorkspace:
    """A host mic carrying the guest's voice.

    ``base``: host words hello / bleed / quiet / bleed (3.0-4.0, integral floats) /
    bleed, plus the guest's copies. ``clean``: no bleed at all. ``locked``: the
    first bleed word is locked unsuppressed. ``done``: the first bleed word is
    already suppressed.
    """
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
            Clip(
                id=f"c-{tid}",
                track_id=tid,
                source_start=0.0,
                source_end=10.0,
                timeline_start=0.0,
            )
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
    guest_words = [
        TranscriptWord(text="bleed", start=1.0, end=1.5, confidence=0.9),
        TranscriptWord(text="loud", start=3.0, end=4.0, confidence=0.9),
        TranscriptWord(text="later", start=5.0, end=5.5, confidence=0.9),
    ]
    if kind == "clean":
        host_words = [
            w.model_copy(update={"audibility_status": None, "dominant_track": None})
            for w in host_words
        ]
        host_words = [host_words[0], host_words[2]]
        guest_words = guest_words[:1]
    if kind == "locked":
        host_words[1] = host_words[1].model_copy(update={"audibility_locked": True})
    if kind == "done":
        host_words[1] = host_words[1].model_copy(update={"suppressed": True})
    project.transcripts = [
        Transcript(track_id="host", words=host_words),
        Transcript(track_id="guest", words=guest_words),
    ]
    project.combined_transcript = TranscriptionEngine(defaults=load_defaults()).merge_transcripts(
        project
    )
    return ProjectWorkspace.open(save_project(project))


# ------------------------------------------------------------------ scenarios

_FLAGGED_ROWS = [("host", 0), ("host", 1), ("host", 2), ("guest", 0)]


class _Low:
    """What the (audio-measuring) low-audibility heuristic flags, when switched on."""

    on = False


def _fake_low_audibility(project, *, track_id=None, **kwargs):
    if not _Low.on:
        return []
    return [
        {"track_id": tid, "source_id": None, "word_index": i}
        for tid, i in _FLAGGED_ROWS
        if track_id is None or tid == track_id
    ]


@pytest.fixture(autouse=True)
def _low_audibility_off():
    _Low.on = False
    with patch(
        "podcast_mcp.edits.audio_quality.list_low_audibility_words", new=_fake_low_audibility
    ):
        yield
    _Low.on = False


def _key(track: str, index: int) -> dict[str, Any]:
    return {"track_id": track, "word_index": index}


# id -> (project kind, service kwargs)
_BLEED_SCENARIOS: dict[str, tuple[str, dict[str, Any]]] = {
    "all": ("base", {}),
    "track-host": ("base", {"track_id": "host"}),
    "speaker-host": ("base", {"speaker": "Host"}),
    "track-guest-none": ("base", {"track_id": "guest"}),
    "keys-incl-non-bleed": ("base", {"word_keys": [_key("host", 0), _key("host", 3)]}),
    "keys-unmatched": ("base", {"word_keys": [_key("host", 99)]}),
    "keys-empty-list": ("base", {"word_keys": []}),
    "exclude": ("base", {"exclude_word_keys": [_key("host", 1)]}),
    "keys-and-exclude": (
        "base",
        {"word_keys": [_key("host", 1), _key("host", 3)], "exclude_word_keys": [_key("host", 3)]},
    ),
    "window-start-inclusive": ("base", {"start_sec": 3.0, "end_sec": 5.0}),
    "window-start-only": ("base", {"start_sec": 3.5}),
    "window-end-only": ("base", {"end_sec": 3.0}),
    "window-empty": ("base", {"start_sec": 6.0, "end_sec": 9.0}),
    "no-bleed": ("clean", {}),
    "first-already-suppressed": ("done", {}),
    "keys-already-suppressed": ("done", {"word_keys": [_key("host", 1)]}),
    "heuristic-skips-locked": ("locked", {}),
    "keys-take-locked": ("locked", {"word_keys": [_key("host", 1)]}),
}

# id -> (project kind, flagged by the heuristic, service kwargs)
_LOW_SCENARIOS: dict[str, tuple[str, bool, dict[str, Any]]] = {
    "heuristic": ("base", True, {}),
    "heuristic-track-host": ("base", True, {"track_id": "host"}),
    "heuristic-speaker-guest": ("base", True, {"speaker": "Guest"}),
    "heuristic-flags-nothing": ("base", False, {}),
    "heuristic-skips-locked": ("locked", True, {}),
    "heuristic-skips-suppressed": ("done", True, {}),
    "keys": ("base", True, {"word_keys": [_key("host", 0), _key("host", 1)]}),
    "keys-empty-list": ("base", True, {"word_keys": []}),
    "keys-unmatched": ("base", True, {"word_keys": [_key("host", 99)]}),
    "keys-take-locked": ("locked", False, {"word_keys": [_key("host", 1)]}),
    "keys-already-suppressed": ("done", False, {"word_keys": [_key("host", 1)]}),
}
_LOW_CLI_IDS = [name for name, (_, _, kw) in _LOW_SCENARIOS.items() if "word_keys" not in kw]


def _dump(value: Any) -> str:
    return json.dumps(value, indent=2)


def _t(text: str) -> str:
    return text.strip("\n")


def _payload(kwargs: dict[str, Any]) -> dict[str, Any]:
    """The document-command payload for service kwargs."""
    return {
        "track_id": kwargs.get("track_id"),
        "speaker": kwargs.get("speaker"),
        "words": kwargs.get("word_keys"),
        "exclude_words": kwargs.get("exclude_word_keys"),
        "start_sec": kwargs.get("start_sec"),
        "end_sec": kwargs.get("end_sec"),
    }


def _mcp_kwargs(kwargs: dict[str, Any]) -> dict[str, Any]:
    return {
        "track_id": kwargs.get("track_id"),
        "speaker": kwargs.get("speaker"),
        "words": kwargs.get("word_keys"),
        "exclude_words": kwargs.get("exclude_word_keys"),
        "start_sec": kwargs.get("start_sec"),
        "end_sec": kwargs.get("end_sec"),
    }


def _cli_flags(kwargs: dict[str, Any]) -> list[str]:
    flags: list[str] = []
    for name, flag in (
        ("track_id", "--track"),
        ("speaker", "--speaker"),
        ("start_sec", "--start"),
        ("end_sec", "--end"),
    ):
        if kwargs.get(name) is not None:
            flags += [flag, str(kwargs[name])]
    if kwargs.get("word_keys") is not None:
        flags += ["--words-json", json.dumps(kwargs["word_keys"])]
    if kwargs.get("exclude_word_keys") is not None:
        flags += ["--exclude-words-json", json.dumps(kwargs["exclude_word_keys"])]
    return flags


def _cli_text(result) -> str:
    assert result.exit_code == 0, result.output
    assert result.output.endswith("\n")
    return result.output[:-1]


def _journal(path: Path) -> list[dict]:
    return DocumentSyncService.open(path).store.commands_after(0)


def _flags(ws: ProjectWorkspace) -> list[tuple[str, int, bool, bool]]:
    saved = ProjectWorkspace.open(ws.path).project
    return [
        (tr.track_id, i, w.suppressed, w.audibility_locked)
        for tr in saved.transcripts
        for i, w in enumerate(tr.words)
        if w.suppressed or w.audibility_locked
    ]


def _bleed_preview(surface: str, ws: ProjectWorkspace, kwargs: dict[str, Any]) -> str:
    svc = AnalysisService(ws)
    if surface == "service":
        return _dump(svc.preview_suppress_bleed(**kwargs))
    if surface == "service_apply_false":
        return _dump(svc.suppress_bleed(apply=False, **kwargs))
    if surface == "cli":
        args = ["edit", "suppress-bleed", "--project", str(ws.path), "--dry-run"]
        return _cli_text(CliRunner().invoke(app, [*args, *_cli_flags(kwargs)]))
    if surface == "mcp_apply_false":
        return transcript.apply_bleed_suppression_tool(
            str(ws.path), apply=False, **_mcp_kwargs(kwargs)
        )
    return transcript.apply_bleed_suppression_tool(
        str(ws.path), dry_run=True, **_mcp_kwargs(kwargs)
    )


def _bleed_apply(surface: str, ws: ProjectWorkspace, kwargs: dict[str, Any]) -> str:
    if surface == "service":
        return _dump(AnalysisService(ws).suppress_bleed(**kwargs))
    if surface == "service_apply_true":
        return _dump(AnalysisService(ws).suppress_bleed(apply=True, **kwargs))
    if surface == "cli":
        args = ["edit", "suppress-bleed", "--project", str(ws.path)]
        return _cli_text(CliRunner().invoke(app, [*args, *_cli_flags(kwargs)]))
    if surface == "mcp":
        return transcript.apply_bleed_suppression_tool(str(ws.path), **_mcp_kwargs(kwargs))
    if surface == "handler":
        result = edit_handlers.suppress_bleed(ws, _payload(kwargs))
        assert type(result) is dict
        return _dump(result)
    reply = submit_host_document_command(ws.path, "SuppressBleed", _payload(kwargs))
    result = host_command_result(reply)
    assert type(result) is dict
    return _dump(result)


def _low_apply(surface: str, ws: ProjectWorkspace, kwargs: dict[str, Any]) -> str:
    payload = {
        "track_id": kwargs.get("track_id"),
        "speaker": kwargs.get("speaker"),
        "words": kwargs.get("word_keys"),
    }
    if surface == "service":
        return _dump(AnalysisService(ws).suppress_low_audibility(**kwargs))
    if surface == "cli":
        args = ["edit", "suppress-low-audibility", "--project", str(ws.path)]
        return _cli_text(CliRunner().invoke(app, [*args, *_cli_flags(kwargs)]))
    if surface == "mcp":
        return transcript.apply_low_audibility_suppression_tool(
            str(ws.path), **{k: v for k, v in payload.items()}
        )
    if surface == "handler":
        result = edit_handlers.suppress_low_audibility(ws, payload)
        assert type(result) is dict
        return _dump(result)
    reply = submit_host_document_command(ws.path, "SuppressLowAudibility", payload)
    result = host_command_result(reply)
    assert type(result) is dict
    return _dump(result)


_PREVIEW_SURFACES = ["service", "service_apply_false", "cli", "mcp_apply_false", "mcp_dry_run"]
_APPLY_SURFACES = ["service", "service_apply_true", "cli", "mcp", "handler", "host"]
_LOW_SURFACES = ["service", "cli", "mcp", "handler", "host"]
# The CLI command takes no word keys.
_LOW_CASES = [
    (surface, name)
    for surface in _LOW_SURFACES
    for name in _LOW_SCENARIOS
    if surface != "cli" or name in _LOW_CLI_IDS
]


# ------------------------------------------------------------------ pinned wire text

_BLEED_PREVIEW = {
    "all": """
{
  "dry_run": true,
  "candidate_count": 3,
  "candidates": [
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 1,
      "text": "bleed",
      "start": 1.0,
      "end": 1.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    },
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 3,
      "text": "loud",
      "start": 3.0,
      "end": 4.0,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    },
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 4,
      "text": "later",
      "start": 5.0,
      "end": 5.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    }
  ]
}
""",
    "track-host": """
{
  "dry_run": true,
  "candidate_count": 3,
  "candidates": [
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 1,
      "text": "bleed",
      "start": 1.0,
      "end": 1.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    },
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 3,
      "text": "loud",
      "start": 3.0,
      "end": 4.0,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    },
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 4,
      "text": "later",
      "start": 5.0,
      "end": 5.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    }
  ]
}
""",
    "speaker-host": """
{
  "dry_run": true,
  "candidate_count": 3,
  "candidates": [
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 1,
      "text": "bleed",
      "start": 1.0,
      "end": 1.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    },
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 3,
      "text": "loud",
      "start": 3.0,
      "end": 4.0,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    },
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 4,
      "text": "later",
      "start": 5.0,
      "end": 5.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    }
  ]
}
""",
    "track-guest-none": """
{
  "dry_run": true,
  "candidate_count": 0,
  "candidates": []
}
""",
    "keys-incl-non-bleed": """
{
  "dry_run": true,
  "candidate_count": 2,
  "candidates": [
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 0,
      "text": "hello",
      "start": 0.0,
      "end": 0.5,
      "audibility_status": null,
      "dominant_track": null,
      "already_suppressed": false
    },
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 3,
      "text": "loud",
      "start": 3.0,
      "end": 4.0,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    }
  ]
}
""",
    "keys-unmatched": """
{
  "dry_run": true,
  "candidate_count": 0,
  "candidates": []
}
""",
    "keys-empty-list": """
{
  "dry_run": true,
  "candidate_count": 0,
  "candidates": []
}
""",
    "exclude": """
{
  "dry_run": true,
  "candidate_count": 2,
  "candidates": [
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 3,
      "text": "loud",
      "start": 3.0,
      "end": 4.0,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    },
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 4,
      "text": "later",
      "start": 5.0,
      "end": 5.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    }
  ]
}
""",
    "keys-and-exclude": """
{
  "dry_run": true,
  "candidate_count": 1,
  "candidates": [
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 1,
      "text": "bleed",
      "start": 1.0,
      "end": 1.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    }
  ]
}
""",
    "window-start-inclusive": """
{
  "dry_run": true,
  "candidate_count": 1,
  "candidates": [
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 3,
      "text": "loud",
      "start": 3.0,
      "end": 4.0,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    }
  ]
}
""",
    "window-start-only": """
{
  "dry_run": true,
  "candidate_count": 1,
  "candidates": [
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 4,
      "text": "later",
      "start": 5.0,
      "end": 5.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    }
  ]
}
""",
    "window-end-only": """
{
  "dry_run": true,
  "candidate_count": 1,
  "candidates": [
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 1,
      "text": "bleed",
      "start": 1.0,
      "end": 1.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    }
  ]
}
""",
    "window-empty": """
{
  "dry_run": true,
  "candidate_count": 0,
  "candidates": []
}
""",
    "no-bleed": """
{
  "dry_run": true,
  "candidate_count": 0,
  "candidates": []
}
""",
    "first-already-suppressed": """
{
  "dry_run": true,
  "candidate_count": 2,
  "candidates": [
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 3,
      "text": "loud",
      "start": 3.0,
      "end": 4.0,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    },
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 4,
      "text": "later",
      "start": 5.0,
      "end": 5.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    }
  ]
}
""",
    "keys-already-suppressed": """
{
  "dry_run": true,
  "candidate_count": 0,
  "candidates": []
}
""",
    "heuristic-skips-locked": """
{
  "dry_run": true,
  "candidate_count": 2,
  "candidates": [
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 3,
      "text": "loud",
      "start": 3.0,
      "end": 4.0,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    },
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 4,
      "text": "later",
      "start": 5.0,
      "end": 5.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    }
  ]
}
""",
    "keys-take-locked": """
{
  "dry_run": true,
  "candidate_count": 1,
  "candidates": [
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 1,
      "text": "bleed",
      "start": 1.0,
      "end": 1.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    }
  ]
}
""",
}

_BLEED_APPLY = {
    "all": """
{
  "dry_run": false,
  "applied": true,
  "suppressed_count": 3,
  "candidates": [
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 1,
      "text": "bleed",
      "start": 1.0,
      "end": 1.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    },
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 3,
      "text": "loud",
      "start": 3.0,
      "end": 4.0,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    },
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 4,
      "text": "later",
      "start": 5.0,
      "end": 5.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    }
  ]
}
""",
    "track-host": """
{
  "dry_run": false,
  "applied": true,
  "suppressed_count": 3,
  "candidates": [
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 1,
      "text": "bleed",
      "start": 1.0,
      "end": 1.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    },
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 3,
      "text": "loud",
      "start": 3.0,
      "end": 4.0,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    },
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 4,
      "text": "later",
      "start": 5.0,
      "end": 5.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    }
  ]
}
""",
    "speaker-host": """
{
  "dry_run": false,
  "applied": true,
  "suppressed_count": 3,
  "candidates": [
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 1,
      "text": "bleed",
      "start": 1.0,
      "end": 1.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    },
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 3,
      "text": "loud",
      "start": 3.0,
      "end": 4.0,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    },
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 4,
      "text": "later",
      "start": 5.0,
      "end": 5.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    }
  ]
}
""",
    "track-guest-none": """
{
  "dry_run": false,
  "applied": true,
  "suppressed_count": 0,
  "candidates": []
}
""",
    "keys-incl-non-bleed": """
{
  "dry_run": false,
  "applied": true,
  "suppressed_count": 2,
  "candidates": [
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 0,
      "text": "hello",
      "start": 0.0,
      "end": 0.5,
      "audibility_status": null,
      "dominant_track": null,
      "already_suppressed": false
    },
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 3,
      "text": "loud",
      "start": 3.0,
      "end": 4.0,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    }
  ]
}
""",
    "keys-unmatched": """
{
  "dry_run": false,
  "applied": true,
  "suppressed_count": 0,
  "candidates": []
}
""",
    "keys-empty-list": """
{
  "dry_run": false,
  "applied": true,
  "suppressed_count": 0,
  "candidates": []
}
""",
    "exclude": """
{
  "dry_run": false,
  "applied": true,
  "suppressed_count": 2,
  "candidates": [
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 3,
      "text": "loud",
      "start": 3.0,
      "end": 4.0,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    },
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 4,
      "text": "later",
      "start": 5.0,
      "end": 5.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    }
  ]
}
""",
    "keys-and-exclude": """
{
  "dry_run": false,
  "applied": true,
  "suppressed_count": 1,
  "candidates": [
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 1,
      "text": "bleed",
      "start": 1.0,
      "end": 1.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    }
  ]
}
""",
    "window-start-inclusive": """
{
  "dry_run": false,
  "applied": true,
  "suppressed_count": 1,
  "candidates": [
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 3,
      "text": "loud",
      "start": 3.0,
      "end": 4.0,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    }
  ]
}
""",
    "window-start-only": """
{
  "dry_run": false,
  "applied": true,
  "suppressed_count": 1,
  "candidates": [
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 4,
      "text": "later",
      "start": 5.0,
      "end": 5.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    }
  ]
}
""",
    "window-end-only": """
{
  "dry_run": false,
  "applied": true,
  "suppressed_count": 1,
  "candidates": [
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 1,
      "text": "bleed",
      "start": 1.0,
      "end": 1.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    }
  ]
}
""",
    "window-empty": """
{
  "dry_run": false,
  "applied": true,
  "suppressed_count": 0,
  "candidates": []
}
""",
    "no-bleed": """
{
  "dry_run": false,
  "applied": true,
  "suppressed_count": 0,
  "candidates": []
}
""",
    "first-already-suppressed": """
{
  "dry_run": false,
  "applied": true,
  "suppressed_count": 2,
  "candidates": [
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 3,
      "text": "loud",
      "start": 3.0,
      "end": 4.0,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    },
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 4,
      "text": "later",
      "start": 5.0,
      "end": 5.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    }
  ]
}
""",
    "keys-already-suppressed": """
{
  "dry_run": false,
  "applied": true,
  "suppressed_count": 0,
  "candidates": []
}
""",
    "heuristic-skips-locked": """
{
  "dry_run": false,
  "applied": true,
  "suppressed_count": 2,
  "candidates": [
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 3,
      "text": "loud",
      "start": 3.0,
      "end": 4.0,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    },
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 4,
      "text": "later",
      "start": 5.0,
      "end": 5.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    }
  ]
}
""",
    "keys-take-locked": """
{
  "dry_run": false,
  "applied": true,
  "suppressed_count": 1,
  "candidates": [
    {
      "track_id": "host",
      "source_id": null,
      "word_index": 1,
      "text": "bleed",
      "start": 1.0,
      "end": 1.5,
      "audibility_status": "bleed",
      "dominant_track": "guest",
      "already_suppressed": false
    }
  ]
}
""",
}

_BLEED_STATE = {
    "all": [("host", 1, True, False), ("host", 3, True, False), ("host", 4, True, False)],
    "track-host": [("host", 1, True, False), ("host", 3, True, False), ("host", 4, True, False)],
    "speaker-host": [("host", 1, True, False), ("host", 3, True, False), ("host", 4, True, False)],
    "track-guest-none": [],
    "keys-incl-non-bleed": [("host", 0, True, True), ("host", 3, True, True)],
    "keys-unmatched": [],
    "keys-empty-list": [],
    "exclude": [("host", 3, True, False), ("host", 4, True, False)],
    "keys-and-exclude": [("host", 1, True, True)],
    "window-start-inclusive": [("host", 3, True, False)],
    "window-start-only": [("host", 4, True, False)],
    "window-end-only": [("host", 1, True, False)],
    "window-empty": [],
    "no-bleed": [],
    "first-already-suppressed": [
        ("host", 1, True, False),
        ("host", 3, True, False),
        ("host", 4, True, False),
    ],
    "keys-already-suppressed": [("host", 1, True, False)],
    "heuristic-skips-locked": [
        ("host", 1, False, True),
        ("host", 3, True, False),
        ("host", 4, True, False),
    ],
    "keys-take-locked": [("host", 1, True, True)],
}

_LOW_APPLY = {
    "heuristic": """
{
  "suppressed_count": 4
}
""",
    "heuristic-track-host": """
{
  "suppressed_count": 3
}
""",
    "heuristic-speaker-guest": """
{
  "suppressed_count": 1
}
""",
    "heuristic-flags-nothing": """
{
  "suppressed_count": 0
}
""",
    "heuristic-skips-locked": """
{
  "suppressed_count": 3
}
""",
    "heuristic-skips-suppressed": """
{
  "suppressed_count": 3
}
""",
    "keys": """
{
  "suppressed_count": 2
}
""",
    "keys-empty-list": """
{
  "suppressed_count": 0
}
""",
    "keys-unmatched": """
{
  "suppressed_count": 0
}
""",
    "keys-take-locked": """
{
  "suppressed_count": 1
}
""",
    "keys-already-suppressed": """
{
  "suppressed_count": 1
}
""",
}

_LOW_STATE = {
    "heuristic": [
        ("host", 0, True, False),
        ("host", 1, True, False),
        ("host", 2, True, False),
        ("guest", 0, True, False),
    ],
    "heuristic-track-host": [
        ("host", 0, True, False),
        ("host", 1, True, False),
        ("host", 2, True, False),
    ],
    "heuristic-speaker-guest": [("guest", 0, True, False)],
    "heuristic-flags-nothing": [],
    "heuristic-skips-locked": [
        ("host", 0, True, False),
        ("host", 1, False, True),
        ("host", 2, True, False),
        ("guest", 0, True, False),
    ],
    "heuristic-skips-suppressed": [
        ("host", 0, True, False),
        ("host", 1, True, False),
        ("host", 2, True, False),
        ("guest", 0, True, False),
    ],
    "keys": [("host", 0, True, True), ("host", 1, True, True)],
    "keys-empty-list": [],
    "keys-unmatched": [],
    "keys-take-locked": [("host", 1, True, True)],
    "keys-already-suppressed": [("host", 1, True, True)],
}


_REAPPLY_ALL = """
{
  "dry_run": false,
  "applied": true,
  "suppressed_count": 0,
  "candidates": []
}
"""

_PREVIEW_AFTER_APPLY = """
{
  "dry_run": true,
  "candidate_count": 0,
  "candidates": []
}
"""

_ROW_KEYS = [
    "track_id",
    "source_id",
    "word_index",
    "text",
    "start",
    "end",
    "audibility_status",
    "dominant_track",
    "already_suppressed",
]


# ------------------------------------------------------------------ suppress-bleed wire text


@pytest.mark.parametrize("surface", _PREVIEW_SURFACES)
@pytest.mark.parametrize("name", list(_BLEED_SCENARIOS))
def test_preview_wire_text(tmp_path, surface, name):
    kind, kwargs = _BLEED_SCENARIOS[name]
    ws = _build(tmp_path, kind)
    before = ws.path.read_bytes()
    assert _bleed_preview(surface, ws, kwargs) == _t(_BLEED_PREVIEW[name])
    assert ws.path.read_bytes() == before
    assert _flags(ws) == _flags_of_kind(kind)
    assert _journal(ws.path) == []


def _flags_of_kind(kind: str) -> list[tuple[str, int, bool, bool]]:
    return {
        "base": [],
        "clean": [],
        "locked": [("host", 1, False, True)],
        "done": [("host", 1, True, False)],
    }[kind]


@pytest.mark.parametrize("surface", _APPLY_SURFACES)
@pytest.mark.parametrize("name", list(_BLEED_SCENARIOS))
def test_apply_wire_text_and_saved_flags(tmp_path, surface, name):
    kind, kwargs = _BLEED_SCENARIOS[name]
    ws = _build(tmp_path, kind)
    assert _bleed_apply(surface, ws, kwargs) == _t(_BLEED_APPLY[name])
    assert _flags(ws) == _BLEED_STATE[name]


@pytest.mark.parametrize("surface", ["cli", "mcp", "host"])
@pytest.mark.parametrize("name", list(_BLEED_SCENARIOS))
def test_apply_journals_one_plain_dict_result_row(tmp_path, surface, name):
    kind, kwargs = _BLEED_SCENARIOS[name]
    ws = _build(tmp_path, kind)
    _bleed_apply(surface, ws, kwargs)
    rows = _journal(ws.path)
    assert [row["type"] for row in rows] == ["SuppressBleed"]
    result = rows[0]["payload"]["result"]
    assert type(result) is dict
    assert _dump(result) == _t(_BLEED_APPLY[name])
    assert list(result) == ["dry_run", "applied", "suppressed_count", "candidates"]
    assert all(type(row) is dict for row in result["candidates"])


@pytest.mark.parametrize("surface", ["service", "handler"])
def test_service_and_handler_apply_return_a_plain_dict(tmp_path, surface):
    ws = _build(tmp_path)
    if surface == "service":
        result = AnalysisService(ws).suppress_bleed()
    else:
        result = edit_handlers.suppress_bleed(ws, _payload({}))
    assert type(result) is dict
    assert all(type(row) is dict for row in result["candidates"])
    assert _dump(result) == _t(_BLEED_APPLY["all"])


@pytest.mark.parametrize("surface", ["service", "preview"])
def test_dry_run_results_are_plain_dicts(tmp_path, surface):
    ws = _build(tmp_path)
    svc = AnalysisService(ws)
    result = (
        svc.suppress_bleed(apply=False) if surface == "service" else svc.preview_suppress_bleed()
    )
    assert type(result) is dict
    assert all(type(row) is dict for row in result["candidates"])


@pytest.mark.parametrize("surface", _APPLY_SURFACES)
def test_reapply_finds_nothing_more(tmp_path, surface):
    ws = _build(tmp_path)
    assert _bleed_apply(surface, ws, {}) == _t(_BLEED_APPLY["all"])
    assert _bleed_apply(surface, ws, {}) == _t(_REAPPLY_ALL)
    assert _flags(ws) == _BLEED_STATE["all"]
    assert _bleed_preview("service", ProjectWorkspace.open(ws.path), {}) == _t(_PREVIEW_AFTER_APPLY)


def test_apply_after_preview_applies_what_the_preview_listed(tmp_path):
    ws = _build(tmp_path)
    previewed = json.loads(_bleed_preview("service", ws, {}))
    applied = json.loads(_bleed_apply("service", ws, {}))
    assert previewed["candidates"] == applied["candidates"]
    assert applied["suppressed_count"] == previewed["candidate_count"] == 3


def test_cli_without_dry_run_applies_and_with_dry_run_only_previews(tmp_path):
    ws = _build(tmp_path)
    dry = json.loads(_bleed_preview("cli", ws, {}))
    assert dry["dry_run"] is True
    assert _flags(ws) == []
    assert _journal(ws.path) == []
    applied = json.loads(_bleed_apply("cli", ws, {}))
    assert applied["dry_run"] is False
    assert applied["suppressed_count"] == 3


def test_mcp_apply_false_and_dry_run_win_over_the_default_apply(tmp_path):
    ws = _build(tmp_path)
    for flags in ({"apply": False}, {"dry_run": True}, {"apply": False, "dry_run": True}):
        text = transcript.apply_bleed_suppression_tool(str(ws.path), **flags)
        assert text == _t(_BLEED_PREVIEW["all"])
    assert _flags(ws) == []
    assert _journal(ws.path) == []
    explicit = transcript.apply_bleed_suppression_tool(str(ws.path), apply=True, dry_run=False)
    assert explicit == _t(_BLEED_APPLY["all"])


def test_cli_dry_run_with_words_json_does_not_journal(tmp_path):
    ws = _build(tmp_path)
    kwargs = {"word_keys": [_key("host", 3)]}
    text = _bleed_preview("cli", ws, kwargs)
    assert json.loads(text)["candidate_count"] == 1
    assert _journal(ws.path) == []


# ------------------------------------------------------------------ shapes and types


def test_key_order_is_pinned(tmp_path):
    ws = _build(tmp_path)
    preview = json.loads(_bleed_preview("service", ws, {}))
    assert list(preview) == ["dry_run", "candidate_count", "candidates"]
    assert all(list(row) == _ROW_KEYS for row in preview["candidates"])
    applied = json.loads(_bleed_apply("service", ws, {}))
    assert list(applied) == ["dry_run", "applied", "suppressed_count", "candidates"]
    assert all(list(row) == _ROW_KEYS for row in applied["candidates"])


def _kinds(value: dict[str, Any], *names: str) -> dict[str, str]:
    return {name: type(value[name]).__name__ for name in names}


def test_value_types_of_a_preview(tmp_path):
    ws = _build(tmp_path)
    result = AnalysisService(ws).preview_suppress_bleed()
    assert _kinds(result, "dry_run", "candidate_count", "candidates") == {
        "dry_run": "bool",
        "candidate_count": "int",
        "candidates": "list",
    }
    loud = result["candidates"][1]
    assert loud["text"] == "loud"
    # Integral seconds stay floats; the word index stays an int.
    assert _kinds(loud, *_ROW_KEYS) == {
        "track_id": "str",
        "source_id": "NoneType",
        "word_index": "int",
        "text": "str",
        "start": "float",
        "end": "float",
        "audibility_status": "str",
        "dominant_track": "str",
        "already_suppressed": "bool",
    }
    assert loud["start"] == 3.0
    assert loud["end"] == 4.0


def test_value_types_of_an_apply_with_a_non_bleed_word(tmp_path):
    ws = _build(tmp_path)
    result = AnalysisService(ws).suppress_bleed(word_keys=[_key("host", 0)])
    assert _kinds(result, "dry_run", "applied", "suppressed_count", "candidates") == {
        "dry_run": "bool",
        "applied": "bool",
        "suppressed_count": "int",
        "candidates": "list",
    }
    hello = result["candidates"][0]
    assert _kinds(hello, "start", "end", "audibility_status", "dominant_track") == {
        "start": "float",
        "end": "float",
        "audibility_status": "NoneType",
        "dominant_track": "NoneType",
    }
    assert hello["start"] == 0.0
    assert hello["already_suppressed"] is False


def test_value_types_when_nothing_matches(tmp_path):
    ws = _build(tmp_path, "clean")
    preview = AnalysisService(ws).preview_suppress_bleed()
    assert _kinds(preview, "candidate_count") == {"candidate_count": "int"}
    assert preview["candidate_count"] == 0
    assert preview["candidates"] == []
    applied = AnalysisService(ws).suppress_bleed()
    assert _kinds(applied, "suppressed_count", "applied", "dry_run") == {
        "suppressed_count": "int",
        "applied": "bool",
        "dry_run": "bool",
    }
    assert applied["suppressed_count"] == 0
    assert applied["applied"] is True


def test_apply_candidate_rows_never_report_already_suppressed(tmp_path):
    ws = _build(tmp_path, "done")
    result = AnalysisService(ws).suppress_bleed(word_keys=[_key("host", 1), _key("host", 3)])
    assert [row["word_index"] for row in result["candidates"]] == [3]
    assert [row["already_suppressed"] for row in result["candidates"]] == [False]


# ------------------------------------------------------------------ suppress-low-audibility


@pytest.mark.parametrize(("surface", "name"), _LOW_CASES)
def test_low_audibility_wire_text_and_saved_flags(tmp_path, surface, name):
    kind, flagged, kwargs = _LOW_SCENARIOS[name]
    _Low.on = flagged
    ws = _build(tmp_path, kind)
    assert _low_apply(surface, ws, kwargs) == _t(_LOW_APPLY[name])
    assert _flags(ws) == _LOW_STATE[name]


@pytest.mark.parametrize(
    ("surface", "name"), [c for c in _LOW_CASES if c[0] in ("cli", "mcp", "host")]
)
def test_low_audibility_journals_one_plain_dict_result_row(tmp_path, surface, name):
    kind, flagged, kwargs = _LOW_SCENARIOS[name]
    _Low.on = flagged
    ws = _build(tmp_path, kind)
    _low_apply(surface, ws, kwargs)
    rows = _journal(ws.path)
    assert [row["type"] for row in rows] == ["SuppressLowAudibility"]
    result = rows[0]["payload"]["result"]
    assert type(result) is dict
    assert _dump(result) == _t(_LOW_APPLY[name])


@pytest.mark.parametrize("name", list(_LOW_SCENARIOS))
def test_low_audibility_service_and_handler_return_plain_dicts(tmp_path, name):
    kind, flagged, kwargs = _LOW_SCENARIOS[name]
    _Low.on = flagged
    result = AnalysisService(_build(tmp_path / "a", kind)).suppress_low_audibility(**kwargs)
    assert type(result) is dict
    assert list(result) == ["suppressed_count"]
    assert type(result["suppressed_count"]) is int
    handled = edit_handlers.suppress_low_audibility(
        _build(tmp_path / "b", kind),
        {
            "track_id": kwargs.get("track_id"),
            "speaker": kwargs.get("speaker"),
            "words": kwargs.get("word_keys"),
        },
    )
    assert type(handled) is dict
    assert handled == result


def test_low_audibility_second_run_changes_nothing(tmp_path):
    _Low.on = True
    ws = _build(tmp_path)
    assert _low_apply("service", ws, {}) == _t(_LOW_APPLY["heuristic"])
    assert _low_apply("service", ws, {}) == '{\n  "suppressed_count": 0\n}'
    assert _flags(ws) == _LOW_STATE["heuristic"]


# ------------------------------------------------------------------ errors

_UNKNOWN_TRACK = "unknown track_id: 'nobody'"
_UNKNOWN_SPEAKER = "no track for speaker 'nobody'; available: host (Host), guest (Guest)"


def _raise_surface(surface: str, ws: ProjectWorkspace) -> None:
    svc = AnalysisService(ws)
    path = str(ws.path)
    if surface == "service_preview":
        svc.preview_suppress_bleed(track_id="nobody")
    elif surface == "service_apply_false":
        svc.suppress_bleed(track_id="nobody", apply=False)
    elif surface == "service_apply":
        svc.suppress_bleed(track_id="nobody")
    elif surface == "service_low":
        svc.suppress_low_audibility(track_id="nobody")
    elif surface == "mcp_apply":
        transcript.apply_bleed_suppression_tool(path, track_id="nobody")
    elif surface == "mcp_dry_run":
        transcript.apply_bleed_suppression_tool(path, track_id="nobody", dry_run=True)
    elif surface == "mcp_apply_false":
        transcript.apply_bleed_suppression_tool(path, track_id="nobody", apply=False)
    elif surface == "mcp_low":
        transcript.apply_low_audibility_suppression_tool(path, track_id="nobody")
    elif surface == "handler":
        edit_handlers.suppress_bleed(ws, {"track_id": "nobody"})
    elif surface == "handler_low":
        edit_handlers.suppress_low_audibility(ws, {"track_id": "nobody"})
    elif surface == "host":
        submit_host_document_command(ws.path, "SuppressBleed", {"track_id": "nobody"})
    else:
        submit_host_document_command(ws.path, "SuppressLowAudibility", {"track_id": "nobody"})


_ERROR_CLASSES = {
    "service_preview": "CodedValueError",
    "service_apply_false": "CodedValueError",
    "service_apply": "CodedValueError",
    "service_low": "CodedValueError",
    "mcp_apply": "DocumentConflictError",
    "mcp_dry_run": "CodedValueError",
    "mcp_apply_false": "CodedValueError",
    "mcp_low": "DocumentConflictError",
    "handler": "CodedValueError",
    "handler_low": "CodedValueError",
    "host": "DocumentConflictError",
    "host_low": "DocumentConflictError",
}


@pytest.mark.parametrize("surface", list(_ERROR_CLASSES))
def test_unknown_track_is_coded_and_changes_nothing(tmp_path, surface):
    ws = _build(tmp_path)
    before = ws.path.read_bytes()
    with pytest.raises(CodedError) as caught:
        _raise_surface(surface, ws)
    assert type(caught.value).__name__ == _ERROR_CLASSES[surface]
    assert caught.value.code == "track_not_found"
    assert str(caught.value) == _UNKNOWN_TRACK
    assert ws.path.read_bytes() == before
    assert _journal(ws.path) == []


def test_unknown_speaker_is_coded(tmp_path):
    ws = _build(tmp_path)
    for call in (
        lambda: AnalysisService(ws).suppress_bleed(speaker="nobody"),
        lambda: AnalysisService(ws).preview_suppress_bleed(speaker="nobody"),
        lambda: AnalysisService(ws).suppress_low_audibility(speaker="nobody"),
    ):
        with pytest.raises(CodedError) as caught:
            call()
        assert caught.value.code == "track_not_found"
        assert str(caught.value) == _UNKNOWN_SPEAKER


@pytest.mark.parametrize(
    "args",
    [
        ["suppress-bleed", "--track", "nobody"],
        ["suppress-bleed", "--track", "nobody", "--dry-run"],
        ["suppress-low-audibility", "--track", "nobody"],
    ],
)
def test_cli_unknown_track_error_text(tmp_path, args):
    ws = _build(tmp_path)
    before = ws.path.read_bytes()
    result = CliRunner().invoke(app, ["edit", *args, "--project", str(ws.path)])
    assert result.exit_code == 1
    assert result.output == (
        "Error: unknown track_id: 'nobody' (code track_not_found) "
        "(set PODCAST_DEBUG=1 for the traceback)\n"
    )
    assert ws.path.read_bytes() == before
    assert _journal(ws.path) == []


def test_cli_unknown_speaker_error_text(tmp_path):
    ws = _build(tmp_path)
    result = CliRunner().invoke(
        app, ["edit", "suppress-bleed", "--speaker", "nobody", "--project", str(ws.path)]
    )
    assert result.exit_code == 1
    assert result.output == (
        "Error: no track for speaker 'nobody'; available: host (Host), guest (Guest) "
        "(code track_not_found) (set PODCAST_DEBUG=1 for the traceback)\n"
    )


def test_unknown_track_in_word_keys_matches_nothing(tmp_path):
    ws = _build(tmp_path)
    keys = [_key("nobody", 0)]
    result = AnalysisService(ws).suppress_bleed(word_keys=keys)
    assert _dump(result) == _t(_BLEED_APPLY["keys-unmatched"])
    low = AnalysisService(ws).suppress_low_audibility(word_keys=keys)
    assert low == {"suppressed_count": 0}

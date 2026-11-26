"""Pin the exact wire output of suggest_handoff_cut on every surface."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import numpy as np
import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.engines.pcm_cache import TrackRmsCacheSet
from podcast_mcp.mcp.tools import edits
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, TrackRole
from podcast_mcp.project.store import save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import AnalysisService
from podcast_mcp.util.coded_error import CodedError

pytestmark = pytest.mark.unscoped_ok


def _workspace(tmp_path: Path) -> ProjectWorkspace:
    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    for tid in ("direct", "uncertain"):
        raw = tmp_path / "raw" / f"{tid}.wav"
        raw.parent.mkdir(exist_ok=True)
        raw.write_bytes(b"\x00" * 100)
        project.timeline.tracks.append(
            Track(
                id=tid,
                label=tid,
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=6.0),
            )
        )
        project.timeline.clips.append(
            Clip(id=f"c-{tid}", track_id=tid, source_start=0.0, source_end=6.0, timeline_start=0.0)
        )
    return ProjectWorkspace.open(save_project(project))


def _dump(value: Any) -> str:
    return json.dumps(value, sort_keys=True)


def _norm(text: str, ws: ProjectWorkspace) -> dict[str, Any]:
    return json.loads(text.replace(str(ws.path.parent), "<ws>"))


class _Lane:
    sample_rate = 16000
    timeline_offset_sec = 0.0
    samples = np.zeros(6 * 16000)
    profile = SimpleNamespace(voice_floor_db=-50.0)

    def __init__(self, track_id, level):
        self._track_id = track_id
        self._level = level

    def rms_db(self, start, end, *, floor_db):
        return self._level(self._track_id, (start + end) / 2)


def _quiet_pockets(track_id, mid):
    pockets = [(1.5, 2.5), (3.5, 4.5)] if track_id == "direct" else [(1.6, 2.4), (3.7, 4.6)]
    return -60.0 if any(lo <= mid < hi for lo, hi in pockets) else -20.0


def _lanes(level):
    lanes = {tid: _Lane(tid, level) for tid in _BOTH} if level else {}
    caches = TrackRmsCacheSet(lanes)
    return patch("podcast_mcp.edits.silence_islands.build_track_rms_caches", return_value=caches)


_HINT = (
    "Ripple-delete [cut_start, cut_end] with use_inaudible_opt=false so local snap does not "
    "pull bounds onto speech; audition the join before resolving review comments. Prefer "
    "existing room tone over insert_gap unless the user asks for artificial silence."
)
_BOTH = ["direct", "uncertain"]
_HANDOFF_FLAGS = {
    "keep_left_end": "--keep-left-end",
    "keep_right_start": "--keep-right-start",
    "track_id": "--track",
    "speaker": "--speaker",
    "min_island_sec": "--min-island-sec",
    "hop_ms": "--hop-ms",
    "retain_sec": "--retain-sec",
}


def _island(start, end, midpoint):
    return {"duration": round(end - start, 2), "end": end, "midpoint": midpoint, "start": start}


def _handoff(left, right, tracks=_BOTH, **fields):
    return {
        "cut_end": None,
        "cut_start": None,
        "hint": _HINT,
        "in_island": None,
        "islands": [],
        "keep_left_end": left,
        "keep_right_start": right,
        "ok": False,
        "out_island": None,
        "retained_air_after_left_sec": None,
        "retained_air_before_right_sec": None,
        "timebase": "timeline",
        "track_id": tracks[0] if len(tracks) == 1 else None,
        "track_ids": tracks,
        "use_inaudible_opt": False,
        "warnings": [],
        **fields,
    }


def _handoff_invoke(surface, ws, kwargs):
    if surface == "service":
        return _dump(AnalysisService(ws).suggest_handoff_cut(**kwargs))
    if surface == "mcp":
        return edits.suggest_handoff_cut_tool(str(ws.path), **kwargs)
    flags = [part for key, value in kwargs.items() for part in (_HANDOFF_FLAGS[key], str(value))]
    result = CliRunner().invoke(
        app, ["edit", "suggest-handoff-cut", "--project", str(ws.path), *flags]
    )
    assert result.exit_code == 0, result.output
    return result.output


def _all_quiet(track_id, mid):
    return -60.0


def _all_loud(track_id, mid):
    return -20.0


_COMMON = [_island(1.6, 2.38, 1.99), _island(3.7, 4.48, 4.09)]
_DIRECT_ONLY = [_island(1.5, 2.48, 1.99), _island(3.5, 4.48, 3.99)]
_UNC_ONLY = [_island(1.6, 2.38, 1.99), _island(3.7, 4.58, 4.14)]
_SPAN = [_island(1.0, 4.98, 2.99)]
_SHORT_AIR = ["retained_air_after_left_short", "retained_air_before_right_short"]


def _found(left, right, islands, start, end, air, tracks=_BOTH, **fields):
    fields.setdefault("out_island", next(i for i in islands if i["start"] <= start <= i["end"]))
    fields.setdefault("in_island", next(i for i in islands if i["start"] <= end <= i["end"]))
    return _handoff(
        left,
        right,
        tracks,
        cut_start=start,
        cut_end=end,
        islands=islands,
        retained_air_after_left_sec=air[0],
        retained_air_before_right_sec=air[1],
        ok=True,
        **fields,
    )


_WINDOW_KW = {"keep_left_end": 1.0, "keep_right_start": 5.0}
_NOT_QUIET = ["cut_start_not_quiet", "cut_end_not_quiet"]
_HANDOFF_CASES = {
    "default": (_quiet_pockets, _WINDOW_KW, _found(1.0, 5.0, _COMMON, 2.0, 4.0, (1.0, 1.0))),
    "custom_island_hop_retain": (
        _quiet_pockets,
        {**_WINDOW_KW, "min_island_sec": 0.6, "hop_ms": 50, "retain_sec": 0.5},
        _found(
            1.0, 5.0, [_island(1.6, 2.35, 1.975), _island(3.7, 4.45, 4.075)], 1.6, 4.45, (0.6, 0.55)
        ),
    ),
    "track_id": (
        _quiet_pockets,
        {**_WINDOW_KW, "track_id": "direct"},
        _found(1.0, 5.0, _DIRECT_ONLY, 2.0, 4.0, (1.0, 1.0), ["direct"]),
    ),
    "speaker": (
        _quiet_pockets,
        {**_WINDOW_KW, "speaker": "uncertain"},
        _found(1.0, 5.0, _UNC_ONLY, 2.0, 4.0, (1.0, 1.0), ["uncertain"]),
    ),
    "no_quiet_anywhere": (_all_loud, _WINDOW_KW, _handoff(1.0, 5.0, warnings=_NOT_QUIET)),
    "short_retained_air": (
        _all_quiet,
        {**_WINDOW_KW, "retain_sec": 0.4},
        _found(1.0, 5.0, _SPAN, 1.4, 4.6, (0.4, 0.4), warnings=_SHORT_AIR),
    ),
    "keep_gap_too_short": (
        _all_quiet,
        {"keep_left_end": 1.0, "keep_right_start": 1.1},
        _handoff(1.0, 1.1, warnings=["keep_gap_too_short"]),
    ),
    "tight_gap": (
        _all_quiet,
        {"keep_left_end": 1.0, "keep_right_start": 1.6, "retain_sec": 0.3},
        _found(1.0, 1.6, [_island(1.0, 1.58, 1.29)], 1.26, 1.32, (0.26, 0.28), warnings=_SHORT_AIR),
    ),
    "unusable_no_measurements": (None, _WINDOW_KW, _handoff(1.0, 5.0, warnings=_NOT_QUIET)),
}


def _handoff_run(tmp_path, name, surface):
    level, kwargs, _ = _HANDOFF_CASES[name]
    ws = _workspace(tmp_path)
    with _lanes(level):
        return _norm(_handoff_invoke(surface, ws, kwargs), ws)


@pytest.mark.parametrize("surface", ["service", "mcp", "cli"])
@pytest.mark.parametrize("name", list(_HANDOFF_CASES))
def test_suggest_handoff_cut_wire(tmp_path, name, surface):
    assert _dump(_handoff_run(tmp_path, name, surface)) == _dump(_HANDOFF_CASES[name][2])


_HANDOFF_ERRORS = {
    "inverted_keeps": (
        {"keep_left_end": 5.0, "keep_right_start": 4.0},
        "range_end_before_start",
        "keep_right_start must be after keep_left_end. Pick a later keep_right_start.",
    ),
    "unknown_track": (
        {**_WINDOW_KW, "track_id": "nobody"},
        "track_not_found",
        "unknown track_id: 'nobody'",
    ),
    "unknown_speaker": (
        {**_WINDOW_KW, "speaker": "nobody"},
        "track_not_found",
        "no track for speaker 'nobody'; available: direct (direct), uncertain (uncertain)",
    ),
}


@pytest.mark.parametrize("surface", ["service", "mcp"])
@pytest.mark.parametrize("name", list(_HANDOFF_ERRORS))
def test_suggest_handoff_cut_error_is_coded(tmp_path, name, surface):
    kwargs, code, message = _HANDOFF_ERRORS[name]
    ws = _workspace(tmp_path)
    with _lanes(_quiet_pockets), pytest.raises(CodedError) as caught:
        _handoff_invoke(surface, ws, kwargs)
    assert type(caught.value).__name__ == "CodedValueError"
    assert caught.value.code == code
    assert str(caught.value) == message


@pytest.mark.parametrize("name", list(_HANDOFF_ERRORS))
def test_suggest_handoff_cut_cli_error_text(tmp_path, name):
    kwargs, code, message = _HANDOFF_ERRORS[name]
    ws = _workspace(tmp_path)
    flags = [part for key, value in kwargs.items() for part in (_HANDOFF_FLAGS[key], str(value))]
    with _lanes(_quiet_pockets):
        result = CliRunner().invoke(
            app, ["edit", "suggest-handoff-cut", "--project", str(ws.path), *flags]
        )
    assert result.exit_code == 1
    assert result.output == (
        f"Error: {message} (code {code}) (set PODCAST_DEBUG=1 for the traceback)\n"
    )


def test_suggest_handoff_cut_writes_nothing(tmp_path):
    ws = _workspace(tmp_path)
    before = ws.path.read_bytes()
    with _lanes(_quiet_pockets):
        _handoff_invoke("service", ws, _WINDOW_KW)
        _handoff_invoke("cli", ws, _WINDOW_KW)
    assert ws.path.read_bytes() == before

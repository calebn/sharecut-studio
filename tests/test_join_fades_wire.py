"""Pin the wire output of ``fade_joins`` and ``crossfade_joins`` (#1811).

The service, the ``fade_joins`` / ``crossfade_joins`` document handlers, the ``FadeJoins`` and
``CrossfadeJoins`` document commands, the ``edit fade-joins`` / ``edit crossfade-joins`` CLI
commands (``json.dumps(indent=2)``) and the two MCP tools (``to_json``) return the same keys in
the same order. Nothing is normalized: the project is built in code with explicit clip times and
each expectation is a literal in wire order. ``_as_dict`` lets the same expectations hold if the
service returns a model instead of a bare dict.
"""

from __future__ import annotations

import json
import re
from functools import partial
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from history_helpers import history_move
from podcast_mcp.cli.main import app
from podcast_mcp.mcp.tools.timeline import crossfade_joins_tool, fade_joins_tool
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole, load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import TimelineService
from podcast_mcp.services.document_sync import DocumentCommand, DocumentSyncService
from podcast_mcp.services.document_sync.errors import DocumentConflictError
from podcast_mcp.services.document_sync.handlers import edits as handlers
from podcast_mcp.util.coded_error import CodedValueError

pytestmark = pytest.mark.unscoped_ok

runner = CliRunner()

FADE_KEYS = [
    "operation",
    "join_count",
    "fade_ms",
    "requested_fade_ms",
    "cap_ms",
    "kept_longer_joins",
    "dry_run",
    "affected_tracks",
]
CROSSFADE_KEYS = [
    "operation",
    "join_count",
    "fade_ms",
    "requested_fade_ms",
    "clamped_joins",
    "dry_run",
    "affected_tracks",
]
KEYS = {"fade_joins": FADE_KEYS, "crossfade_joins": CROSSFADE_KEYS}
COMMANDS = {"fade_joins": "FadeJoins", "crossfade_joins": "CrossfadeJoins"}
CLI_NAMES = {"fade_joins": "fade-joins", "crossfade_joins": "crossfade-joins"}
TOOLS = {"fade_joins": fade_joins_tool, "crossfade_joins": crossfade_joins_tool}
ALL_TRACKS = ["host", "guest", "solo", "short", "zero", "héte"]

TRACKS = {
    "host": ("Host", [(0.0, 3.0, 0.0), (5.0, 8.0, 3.0), (9.0, 10.0, 6.0)]),
    "guest": ("Guest", [(0.0, 2.0, 0.0), (4.0, 6.0, 2.0)]),
    "solo": (None, [(0.0, 2.0, 0.0)]),
    "short": (None, [(0.0, 0.02, 0.0), (1.0, 1.02, 0.02)]),
    "zero": (None, [(0.0, 2.0, 0.0), (5.0, 5.0005, 2.0), (7.0, 9.0, 2.0005)]),
    "héte": (None, [(0.0, 2.0, 0.0), (4.0, 6.0, 2.0)]),
}


def _as_dict(result: Any) -> dict:
    return result.model_dump(mode="json") if hasattr(result, "model_dump") else result


def _wire(value: Any) -> str:
    return json.dumps(value, indent=2)


@pytest.fixture
def built(minimal_project) -> Path:
    project = load_project(minimal_project)
    for tid, (speaker, spans) in TRACKS.items():
        project.tracks.append(
            Track(
                id=tid,
                label=tid,
                role=TrackRole.DIALOGUE,
                speaker=speaker,
                media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=100.0),
            )
        )
        for index, (start, end, at) in enumerate(spans):
            project.clips.append(
                Clip(
                    id=f"{tid}-{index}",
                    track_id=tid,
                    source_start=start,
                    source_end=end,
                    timeline_start=at,
                )
            )
    save_project(project)
    return minimal_project


def _fade(
    join_count: int,
    fade_ms: int | None,
    requested: int | None,
    *,
    kept: int = 0,
    dry_run: bool = False,
    tracks: list[str],
) -> dict:
    return {
        "operation": "fade_joins",
        "join_count": join_count,
        "fade_ms": fade_ms,
        "requested_fade_ms": requested,
        "cap_ms": 40,
        "kept_longer_joins": kept,
        "dry_run": dry_run,
        "affected_tracks": tracks,
    }


def _crossfade(
    join_count: int,
    fade_ms: int,
    requested: int | None,
    *,
    clamped: int = 0,
    dry_run: bool = False,
    tracks: list[str],
) -> dict:
    return {
        "operation": "crossfade_joins",
        "join_count": join_count,
        "fade_ms": fade_ms,
        "requested_fade_ms": requested,
        "clamped_joins": clamped,
        "dry_run": dry_run,
        "affected_tracks": tracks,
    }


def _case(name: str, operation: str, kwargs: dict, expected: dict, preset: dict | None = None):
    return pytest.param(operation, kwargs, expected, preset or {}, id=name)


CASES = [
    _case(
        "fade-host-50",
        "fade_joins",
        {"track_id": "host", "fade_ms": 50},
        _fade(2, 40, 50, tracks=["host"]),
    ),
    _case(
        "fade-host-10",
        "fade_joins",
        {"track_id": "host", "fade_ms": 10},
        _fade(2, 10, 10, tracks=["host"]),
    ),
    _case(
        "fade-host-per-join",
        "fade_joins",
        {"track_id": "host"},
        _fade(2, 40, None, tracks=["host"]),
    ),
    _case(
        "fade-over-cap",
        "fade_joins",
        {"track_id": "host", "fade_ms": 5000},
        _fade(2, 40, 5000, tracks=["host"]),
    ),
    _case(
        "fade-negative",
        "fade_joins",
        {"track_id": "host", "fade_ms": -5},
        _fade(2, 0, -5, tracks=["host"]),
    ),
    _case(
        "fade-no-joins-request",
        "fade_joins",
        {"track_id": "solo", "fade_ms": 50},
        _fade(0, 40, 50, tracks=["solo"]),
    ),
    _case(
        "fade-no-joins-low-request",
        "fade_joins",
        {"track_id": "solo", "fade_ms": 12},
        _fade(0, 12, 12, tracks=["solo"]),
    ),
    _case(
        "fade-no-joins-no-request",
        "fade_joins",
        {"track_id": "solo"},
        _fade(0, None, None, tracks=["solo"]),
    ),
    _case(
        "fade-kept-longer",
        "fade_joins",
        {"track_id": "host", "fade_ms": 10},
        _fade(2, 10, 10, kept=1, tracks=["host"]),
        {"host-0": 300},
    ),
    _case(
        "fade-speaker",
        "fade_joins",
        {"speaker": "Guest", "fade_ms": 10},
        _fade(1, 10, 10, tracks=["guest"]),
    ),
    _case("fade-all-tracks", "fade_joins", {"fade_ms": 10}, _fade(7, 10, 10, tracks=ALL_TRACKS)),
    _case(
        "fade-non-ascii-track",
        "fade_joins",
        {"track_id": "héte", "fade_ms": 10},
        _fade(1, 10, 10, tracks=["héte"]),
    ),
    _case(
        "crossfade-host-50",
        "crossfade_joins",
        {"track_id": "host", "fade_ms": 50},
        _crossfade(2, 50, 50, tracks=["host"]),
    ),
    _case(
        "crossfade-host-default",
        "crossfade_joins",
        {"track_id": "host"},
        _crossfade(2, 25, None, tracks=["host"]),
    ),
    _case(
        "crossfade-no-joins-default",
        "crossfade_joins",
        {"track_id": "solo"},
        _crossfade(0, 25, None, tracks=["solo"]),
    ),
    _case(
        "crossfade-no-joins-request",
        "crossfade_joins",
        {"track_id": "solo", "fade_ms": 50},
        _crossfade(0, 50, 50, tracks=["solo"]),
    ),
    _case(
        "crossfade-clamped",
        "crossfade_joins",
        {"track_id": "short", "fade_ms": 50},
        _crossfade(1, 20, 50, clamped=1, tracks=["short"]),
    ),
    _case(
        "crossfade-short-fits",
        "crossfade_joins",
        {"track_id": "short", "fade_ms": 5},
        _crossfade(1, 5, 5, tracks=["short"]),
    ),
    _case(
        "crossfade-zero-edge-skipped",
        "crossfade_joins",
        {"track_id": "zero", "fade_ms": 50},
        _crossfade(2, 0, 50, clamped=2, tracks=["zero"]),
    ),
    _case(
        "crossfade-speaker",
        "crossfade_joins",
        {"speaker": "Guest", "fade_ms": 30},
        _crossfade(1, 30, 30, tracks=["guest"]),
    ),
    _case(
        "crossfade-all-tracks",
        "crossfade_joins",
        {"fade_ms": 30},
        _crossfade(7, 30, 30, clamped=3, tracks=ALL_TRACKS),
    ),
    _case(
        "crossfade-non-ascii-track",
        "crossfade_joins",
        {"track_id": "héte", "fade_ms": 30},
        _crossfade(1, 30, 30, tracks=["héte"]),
    ),
]

DRY_CASES = [
    _case(
        "fade-per-join-is-null",
        "fade_joins",
        {"track_id": "host"},
        _fade(2, None, None, dry_run=True, tracks=["host"]),
    ),
    _case(
        "fade-request",
        "fade_joins",
        {"track_id": "host", "fade_ms": 10},
        _fade(2, 10, 10, dry_run=True, tracks=["host"]),
    ),
    _case(
        "fade-over-cap",
        "fade_joins",
        {"track_id": "host", "fade_ms": 5000},
        _fade(2, 40, 5000, dry_run=True, tracks=["host"]),
    ),
    _case(
        "fade-kept-longer",
        "fade_joins",
        {"track_id": "host", "fade_ms": 10},
        _fade(2, 10, 10, kept=1, dry_run=True, tracks=["host"]),
        {"host-0": 300},
    ),
    _case(
        "fade-no-joins-no-request",
        "fade_joins",
        {"track_id": "solo"},
        _fade(0, None, None, dry_run=True, tracks=["solo"]),
    ),
    _case(
        "fade-no-joins-request",
        "fade_joins",
        {"track_id": "solo", "fade_ms": 50},
        _fade(0, 40, 50, dry_run=True, tracks=["solo"]),
    ),
    _case(
        "fade-all-tracks",
        "fade_joins",
        {},
        _fade(7, None, None, dry_run=True, tracks=ALL_TRACKS),
    ),
    _case(
        "fade-non-ascii-track",
        "fade_joins",
        {"track_id": "héte", "fade_ms": 10},
        _fade(1, 10, 10, dry_run=True, tracks=["héte"]),
    ),
    _case(
        "crossfade-default",
        "crossfade_joins",
        {"track_id": "host"},
        _crossfade(2, 25, None, dry_run=True, tracks=["host"]),
    ),
    _case(
        "crossfade-no-joins",
        "crossfade_joins",
        {"track_id": "solo"},
        _crossfade(0, 25, None, dry_run=True, tracks=["solo"]),
    ),
    _case(
        "crossfade-clamped",
        "crossfade_joins",
        {"track_id": "short", "fade_ms": 50},
        _crossfade(1, 20, 50, clamped=1, dry_run=True, tracks=["short"]),
    ),
    _case(
        "crossfade-zero-edge-skipped",
        "crossfade_joins",
        {"track_id": "zero", "fade_ms": 50},
        _crossfade(2, 0, 50, clamped=2, dry_run=True, tracks=["zero"]),
    ),
    _case(
        "crossfade-non-ascii-track",
        "crossfade_joins",
        {"track_id": "héte", "fade_ms": 30},
        _crossfade(1, 30, 30, dry_run=True, tracks=["héte"]),
    ),
]

ERRORS = [
    pytest.param("crossfade_joins", {"fade_ms": 0}, "out_of_range", id="crossfade-zero"),
    pytest.param("crossfade_joins", {"fade_ms": -5}, "out_of_range", id="crossfade-negative"),
    pytest.param(
        "crossfade_joins",
        {"track_id": "nope", "fade_ms": 0},
        "out_of_range",
        id="crossfade-range-before-track",
    ),
    pytest.param("crossfade_joins", {"track_id": "nope"}, "track_not_found", id="crossfade-track"),
    pytest.param("fade_joins", {"track_id": "nope"}, "track_not_found", id="fade-track"),
    pytest.param(
        "fade_joins", {"speaker": "Nobody", "fade_ms": 10}, "track_not_found", id="fade-speaker"
    ),
]

_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_BOX = re.compile(r"[│╭╮╰╯─]")


def _error_text(text: str) -> str:
    return " ".join(_BOX.sub(" ", _ANSI.sub("", text)).split())


def _preset(path: Path, fade_outs: dict[str, int]) -> None:
    if not fade_outs:
        return
    project = load_project(path)
    for clip in project.clips:
        if clip.id in fade_outs:
            clip.fade_out_ms = fade_outs[clip.id]
    save_project(project)


def _effects(path: Path) -> list[tuple]:
    return sorted(
        (c.id, c.fade_in_ms, c.fade_out_ms, c.join_in_mode.value) for c in load_project(path).clips
    )


def _history_len(path: Path) -> int:
    return len(load_project(path).history.entries)


def _service(path: Path, operation: str, kwargs: dict, *, dry_run: bool = False) -> Any:
    return getattr(TimelineService(ProjectWorkspace.open(path)), operation)(
        **kwargs, dry_run=dry_run
    )


def _preview(path: Path, operation: str, kwargs: dict) -> Any:
    return getattr(TimelineService(ProjectWorkspace.open(path)), f"preview_{operation}")(**kwargs)


def _handler(path: Path, operation: str, kwargs: dict) -> Any:
    payload = {"track_id": None, "speaker": None, "fade_ms": None, **kwargs}
    return getattr(handlers, operation)(ProjectWorkspace.open(path), payload)


def _submit(path: Path, command_type: str, payload: dict) -> dict:
    return DocumentSyncService.open(path).submit(
        DocumentCommand(
            type=command_type, payload=payload, client_id="t", client_seq=None, role="viewer"
        )
    )


def _command(path: Path, operation: str, kwargs: dict) -> Any:
    payload = {"track_id": None, "speaker": None, "fade_ms": None, **kwargs}
    reply = _submit(path, COMMANDS[operation], payload)
    assert reply["ok"] is True
    assert reply["type"] == "Applied"
    return reply["command"]["payload"]["result"]


def _cli(path: Path, operation: str, kwargs: dict, *, dry_run: bool = False):
    args = ["edit", CLI_NAMES[operation], "--project", str(path)]
    if "track_id" in kwargs:
        args += ["--track", kwargs["track_id"]]
    if "speaker" in kwargs:
        args += ["--speaker", kwargs["speaker"]]
    if "fade_ms" in kwargs:
        args += [f"--fade-ms={kwargs['fade_ms']}"]
    if dry_run:
        args.append("--dry-run")
    return runner.invoke(app, args)


def _tool(path: Path, operation: str, kwargs: dict, *, dry_run: bool = False) -> str:
    return TOOLS[operation](str(path), **kwargs, dry_run=dry_run)


def _raised(call) -> pytest.ExceptionInfo:
    with pytest.raises(Exception) as raised:
        call()
    return raised


def _snapshot(path: Path) -> tuple[bytes, int]:
    return path.read_bytes(), _history_len(path)


@pytest.mark.parametrize(("operation", "kwargs", "expected", "preset"), CASES)
def test_service_apply(built, operation, kwargs, expected, preset):
    _preset(built, preset)
    result = _as_dict(_service(built, operation, kwargs))
    assert list(result) == KEYS[operation]
    assert _wire(result) == _wire(expected)
    assert result["dry_run"] is False


@pytest.mark.parametrize(("operation", "kwargs", "expected", "preset"), DRY_CASES)
def test_service_dry_run_and_preview(built, operation, kwargs, expected, preset):
    _preset(built, preset)
    before = _snapshot(built)
    via_flag = _as_dict(_service(built, operation, kwargs, dry_run=True))
    via_preview = _as_dict(_preview(built, operation, kwargs))
    for result in (via_flag, via_preview):
        assert list(result) == KEYS[operation]
        assert _wire(result) == _wire(expected)
        assert result["dry_run"] is True
    assert _snapshot(built) == before


def test_service_apply_text_is_pinned(built):
    result = _as_dict(_service(built, "fade_joins", {"track_id": "host", "fade_ms": 10}))
    assert json.dumps(result) == (
        '{"operation": "fade_joins", "join_count": 2, "fade_ms": 10, "requested_fade_ms": 10, '
        '"cap_ms": 40, "kept_longer_joins": 0, "dry_run": false, "affected_tracks": ["host"]}'
    )
    result = _as_dict(_service(built, "crossfade_joins", {"track_id": "short", "fade_ms": 50}))
    assert json.dumps(result) == (
        '{"operation": "crossfade_joins", "join_count": 1, "fade_ms": 20, '
        '"requested_fade_ms": 50, "clamped_joins": 1, "dry_run": false, '
        '"affected_tracks": ["short"]}'
    )


def test_service_value_types(built):
    fade = _as_dict(_service(built, "fade_joins", {"track_id": "host", "fade_ms": 10}))
    assert all(type(fade[key]) is int for key in ("join_count", "fade_ms", "cap_ms"))
    assert type(fade["kept_longer_joins"]) is int
    unset = _as_dict(_service(built, "fade_joins", {"track_id": "solo"}))
    assert unset["fade_ms"] is None
    assert unset["requested_fade_ms"] is None
    cross = _as_dict(_service(built, "crossfade_joins", {"track_id": "host"}))
    assert type(cross["fade_ms"]) is int
    assert cross["requested_fade_ms"] is None
    assert type(cross["clamped_joins"]) is int


@pytest.mark.parametrize(("operation", "kwargs", "code"), ERRORS)
def test_service_errors(built, operation, kwargs, code):
    before = _snapshot(built)
    raised = _raised(lambda: _service(built, operation, kwargs))
    assert type(raised.value) is CodedValueError
    assert raised.value.code == code
    assert _snapshot(built) == before
    raised = _raised(lambda: _preview(built, operation, kwargs))
    assert raised.value.code == code
    assert _snapshot(built) == before


@pytest.mark.parametrize(
    ("operation", "kwargs", "message"),
    [
        ("crossfade_joins", {"fade_ms": 0}, "crossfade fade_ms must be > 0. Pass more than 0."),
        ("crossfade_joins", {"fade_ms": -5}, "crossfade fade_ms must be > 0. Pass more than 0."),
    ],
)
def test_service_out_of_range_message(built, operation, kwargs, message):
    raised = _raised(lambda: _service(built, operation, kwargs))
    assert str(raised.value) == message


@pytest.mark.parametrize(
    ("operation", "kwargs"),
    [
        ("fade_joins", {"fade_ms": 10}),
        ("fade_joins", {}),
        ("crossfade_joins", {"fade_ms": 30}),
        ("crossfade_joins", {"track_id": "short", "fade_ms": 50}),
    ],
    ids=["fade", "fade-per-join", "crossfade", "crossfade-clamped"],
)
def test_undo_and_redo_restore_the_project(built, operation, kwargs):
    before_bytes = built.read_bytes()
    before = _effects(built)
    result = _as_dict(_service(built, operation, kwargs))
    after_bytes = built.read_bytes()
    after = _effects(built)
    assert after != before
    assert after_bytes != before_bytes

    _submit(built, "UndoHistory", history_move(built))
    assert _effects(built) == before

    _submit(built, "RedoHistory", history_move(built))
    assert _effects(built) == after
    assert list(result) == KEYS[operation]
    assert result["dry_run"] is False


@pytest.mark.parametrize("operation", ["fade_joins", "crossfade_joins"])
def test_workspace_undo_and_redo_restore_the_clip_fades(built, operation):
    before = _effects(built)
    _service(built, operation, {"fade_ms": 10})
    after = _effects(built)
    ws = ProjectWorkspace.open(built)
    ws.undo()
    assert _effects(built) == before
    ws = ProjectWorkspace.open(built)
    ws.redo()
    assert _effects(built) == after


def test_applies_record_history_entries(built):
    entries = _history_len(built)
    _service(built, "fade_joins", {"fade_ms": 10})
    assert _history_len(built) == entries + 2
    _service(built, "crossfade_joins", {"fade_ms": 30})
    assert _history_len(built) == entries + 3


@pytest.mark.parametrize(("operation", "kwargs", "expected", "preset"), CASES)
def test_handler_apply_is_a_plain_dict_equal_to_the_service(
    built, operation, kwargs, expected, preset
):
    _preset(built, preset)
    result = _handler(built, operation, kwargs)
    assert type(result) is dict
    assert list(result) == KEYS[operation]
    assert _wire(result) == _wire(expected)


@pytest.mark.parametrize(("operation", "kwargs", "code"), ERRORS)
def test_handler_errors(built, operation, kwargs, code):
    before = _snapshot(built)
    raised = _raised(lambda: _handler(built, operation, kwargs))
    assert type(raised.value) is CodedValueError
    assert raised.value.code == code
    assert _snapshot(built) == before


@pytest.mark.parametrize(("operation", "kwargs", "expected", "preset"), CASES)
def test_document_command_result(built, operation, kwargs, expected, preset):
    _preset(built, preset)
    result = _command(built, operation, kwargs)
    assert type(result) is dict
    assert list(result) == KEYS[operation]
    assert _wire(result) == _wire(expected)


@pytest.mark.parametrize(("operation", "kwargs", "code"), ERRORS)
def test_document_command_errors(built, operation, kwargs, code):
    before = _snapshot(built)
    raised = _raised(lambda: _command(built, operation, kwargs))
    assert raised.value.code == code
    assert [r["type"] for r in DocumentSyncService.open(built).store.commands_after(0)] == []
    assert _snapshot(built) == before


@pytest.mark.parametrize(("operation", "kwargs", "expected", "preset"), CASES)
def test_every_surface_leaves_the_same_clip_fades(
    built, tmp_path, operation, kwargs, expected, preset
):
    _preset(built, preset)
    through_service = Path(tmp_path / "service.json")
    through_service.write_bytes(built.read_bytes())
    _service(built, operation, kwargs)
    reference = _effects(built)

    for runner_name in ("handler", "command", "cli", "mcp"):
        fresh = tmp_path / runner_name
        fresh.mkdir()
        target = fresh / "project.json"
        target.write_bytes(through_service.read_bytes())
        if runner_name == "handler":
            _handler(target, operation, kwargs)
        elif runner_name == "command":
            _command(target, operation, kwargs)
        elif runner_name == "cli":
            assert _cli(target, operation, kwargs).exit_code == 0
        else:
            _tool(target, operation, kwargs)
        assert _effects(target) == reference, runner_name


@pytest.mark.parametrize(("operation", "kwargs", "expected", "preset"), CASES)
def test_cli_apply(built, operation, kwargs, expected, preset):
    _preset(built, preset)
    result = _cli(built, operation, kwargs)
    assert result.exit_code == 0, result.output
    assert result.stdout == _wire(expected) + "\n"


@pytest.mark.parametrize(("operation", "kwargs", "expected", "preset"), DRY_CASES)
def test_cli_dry_run(built, operation, kwargs, expected, preset):
    _preset(built, preset)
    before = _snapshot(built)
    result = _cli(built, operation, kwargs, dry_run=True)
    assert result.exit_code == 0, result.output
    assert result.stdout == _wire(expected) + "\n"
    assert _snapshot(built) == before


def test_cli_apply_pinned_text(built):
    result = _cli(built, "fade_joins", {"track_id": "host", "fade_ms": 10})
    assert result.exit_code == 0, result.output
    assert result.stdout == (
        "{\n"
        '  "operation": "fade_joins",\n'
        '  "join_count": 2,\n'
        '  "fade_ms": 10,\n'
        '  "requested_fade_ms": 10,\n'
        '  "cap_ms": 40,\n'
        '  "kept_longer_joins": 0,\n'
        '  "dry_run": false,\n'
        '  "affected_tracks": [\n'
        '    "host"\n'
        "  ]\n"
        "}\n"
    )


def test_cli_dry_run_pinned_text_keeps_a_null_fade(built):
    result = _cli(built, "fade_joins", {"track_id": "host"}, dry_run=True)
    assert result.exit_code == 0, result.output
    assert result.stdout == (
        "{\n"
        '  "operation": "fade_joins",\n'
        '  "join_count": 2,\n'
        '  "fade_ms": null,\n'
        '  "requested_fade_ms": null,\n'
        '  "cap_ms": 40,\n'
        '  "kept_longer_joins": 0,\n'
        '  "dry_run": true,\n'
        '  "affected_tracks": [\n'
        '    "host"\n'
        "  ]\n"
        "}\n"
    )


@pytest.mark.parametrize("operation", ["fade_joins", "crossfade_joins"])
def test_cli_escapes_a_non_ascii_track_id(built, operation):
    result = _cli(built, operation, {"track_id": "héte", "fade_ms": 10}, dry_run=True)
    assert result.exit_code == 0, result.output
    assert '"h\\u00e9te"' in result.stdout
    assert "é" not in result.stdout


@pytest.mark.parametrize(("operation", "kwargs", "code"), ERRORS)
def test_cli_errors(built, operation, kwargs, code):
    before = _snapshot(built)
    result = _cli(built, operation, kwargs)
    assert result.exit_code == 1
    assert result.stdout == ""
    assert f"(code {code})" in _error_text(result.stderr)
    assert isinstance(result.exception, SystemExit)
    assert _snapshot(built) == before
    dry = _cli(built, operation, kwargs, dry_run=True)
    assert dry.exit_code == 1
    assert dry.stdout == ""
    assert f"(code {code})" in _error_text(dry.stderr)
    assert _snapshot(built) == before


@pytest.mark.parametrize(("operation", "kwargs", "expected", "preset"), CASES)
def test_mcp_apply(built, operation, kwargs, expected, preset):
    _preset(built, preset)
    out = _tool(built, operation, kwargs)
    assert out == _wire(expected)
    assert list(json.loads(out)) == KEYS[operation]


@pytest.mark.parametrize(("operation", "kwargs", "expected", "preset"), DRY_CASES)
def test_mcp_dry_run(built, operation, kwargs, expected, preset):
    _preset(built, preset)
    before = _snapshot(built)
    out = _tool(built, operation, kwargs, dry_run=True)
    assert out == _wire(expected)
    assert list(json.loads(out)) == KEYS[operation]
    assert _snapshot(built) == before
    assert DocumentSyncService.open(built).store.commands_after(0) == []


@pytest.mark.parametrize("operation", ["fade_joins", "crossfade_joins"])
@pytest.mark.parametrize("dry_run", [False, True])
def test_mcp_escapes_a_non_ascii_track_id(built, operation, dry_run):
    out = _tool(built, operation, {"track_id": "héte", "fade_ms": 10}, dry_run=dry_run)
    assert '"h\\u00e9te"' in out
    assert "é" not in out


def test_mcp_dry_run_pinned_text_keeps_a_null_fade(built):
    assert _tool(built, "fade_joins", {"track_id": "host"}, dry_run=True) == (
        "{\n"
        '  "operation": "fade_joins",\n'
        '  "join_count": 2,\n'
        '  "fade_ms": null,\n'
        '  "requested_fade_ms": null,\n'
        '  "cap_ms": 40,\n'
        '  "kept_longer_joins": 0,\n'
        '  "dry_run": true,\n'
        '  "affected_tracks": [\n'
        '    "host"\n'
        "  ]\n"
        "}"
    )


@pytest.mark.parametrize(("operation", "kwargs", "code"), ERRORS)
def test_mcp_errors(built, operation, kwargs, code):
    before = _snapshot(built)
    applied_type = CodedValueError if code == "out_of_range" else DocumentConflictError
    expected_type = {False: applied_type, True: CodedValueError}
    for dry_run in (False, True):
        raised = _raised(partial(_tool, built, operation, kwargs, dry_run=dry_run))
        assert type(raised.value) is expected_type[dry_run]
        assert raised.value.code == code
    assert _snapshot(built) == before

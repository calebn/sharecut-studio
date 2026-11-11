"""Per-edge clip fade curves (#3370): linear (default), equal power, S.

The curve rides beside each fade length on a clip. It renders as ffmpeg's ``afade`` ``curve=``
(``tri`` / ``qsin`` / ``hsin``), the fade-out being the mirror of the fade-in, and the numpy
evaluator reproduces the same samples.
"""

from __future__ import annotations

import math
import subprocess
from pathlib import Path

import numpy as np
import pytest
from pydantic import ValidationError

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.clip_fades import ClipFadeBaseline, ClipFadeChangedError, ClipFadeEdit
from podcast_mcp.engines.audio import SourceAudio, sources
from podcast_mcp.engines.audio_eval import evaluate_audio
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.timeline_render import (
    placed_track_audio,
    render_track_from_timeline,
    track_grid,
)
from podcast_mcp.engines.ungated_audio import load_mono_full
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    FadeCurve,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.binaries import resolve_ffmpeg

DEFAULTS = load_defaults()
LINEAR, EQUAL_POWER, S = FadeCurve.LINEAR, FadeCurve.EQUAL_POWER, FadeCurve.S
RATE = 8000
SAMPLES_AT = (0.25, 0.5, 0.75)


@pytest.fixture(autouse=True)
def _dispatcher_grant():
    with write_grant(WriteGrantKind.DISPATCHER):
        yield


def _clip(cid="a", start=0.0, end=1.0, at=0.0, **extra) -> Clip:
    return Clip(
        id=cid, track_id="host", source_start=start, source_end=end, timeline_start=at, **extra
    )


def _seed(minimal_project: Path, *clips: Clip) -> ProjectWorkspace:
    ws = ProjectWorkspace.open(minimal_project)
    if not ws.project.tracks:
        ws.project.timeline.tracks = [
            Track(
                id="host",
                label="Host",
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
            )
        ]
    ws.project.timeline.clips = list(clips) or [_clip("a"), _clip("b", 1.0, 2.0, 1.0)]
    ws.save()
    return ProjectWorkspace.open(minimal_project)


def _saved(minimal_project: Path) -> list[Clip]:
    return load_project(minimal_project).clips


def _curves(clip: Clip) -> tuple[FadeCurve, FadeCurve]:
    return clip.fade_in_curve, clip.fade_out_curve


def _entries(ws: ProjectWorkspace) -> int:
    from podcast_mcp.services.document import HistoryService

    return len(HistoryService(ws).list_entries().entries)


def _fade_in_gain(curve: FadeCurve, x: float) -> float:
    return {
        LINEAR: x,
        EQUAL_POWER: math.sin(math.pi * x / 2),
        S: (1 - math.cos(math.pi * x)) / 2,
    }[curve]


def _fade_out_gain(curve: FadeCurve, x: float) -> float:
    return _fade_in_gain(curve, 1 - x)


def test_curves_default_to_linear_and_are_omitted_from_the_dump() -> None:
    clip = _clip()
    assert _curves(clip) == (LINEAR, LINEAR)
    dumped = clip.model_dump(mode="json")
    assert "fade_in_curve" not in dumped and "fade_out_curve" not in dumped
    both = _clip(fade_in_curve=EQUAL_POWER, fade_out_curve=S).model_dump(mode="json")
    assert (both["fade_in_curve"], both["fade_out_curve"]) == ("equal_power", "s")
    one = _clip(fade_out_curve=S).model_dump(mode="json")
    assert "fade_in_curve" not in one and one["fade_out_curve"] == "s"


def test_resetting_a_curve_to_linear_removes_the_key_again() -> None:
    clip = _clip(fade_in_curve=S)
    clip.fade_in_curve = LINEAR
    assert "fade_in_curve" not in clip.model_dump(mode="json")
    assert "fade_in_curve" not in clip.model_dump_json()


def test_unknown_curves_are_rejected_and_old_json_loads_linear() -> None:
    with pytest.raises(ValidationError):
        _clip(fade_in_curve="logarithmic")
    old = {"id": "a", "track_id": "host", "source_start": 0, "source_end": 1, "timeline_start": 0}
    assert _curves(Clip.model_validate(old)) == (LINEAR, LINEAR)
    assert Clip.model_validate({**old, "fade_out_curve": "s"}).fade_out_curve is S


def test_curve_free_project_bytes_are_unchanged_by_a_save(minimal_project: Path) -> None:
    project = load_project(minimal_project)
    project.timeline.clips = [_clip(fade_in_ms=20)]
    save_project(project)
    first = minimal_project.read_bytes()
    assert b"_curve" not in first
    save_project(load_project(minimal_project))
    assert minimal_project.read_bytes() == first


def test_curves_round_trip_through_save_and_load(minimal_project: Path) -> None:
    project = load_project(minimal_project)
    project.timeline.clips = [_clip(fade_in_ms=20, fade_in_curve=S, fade_out_curve=EQUAL_POWER)]
    save_project(project)
    assert _curves(load_project(minimal_project).clips[0]) == (S, EQUAL_POWER)


def _ffmpeg_unit(
    fade_in: float,
    fade_out: float,
    in_curve: FadeCurve = LINEAR,
    out_curve: FadeCurve = LINEAR,
) -> np.ndarray:
    engine = FFmpegEngine()
    if not engine.check_available()[0]:
        pytest.skip("ffmpeg not available")
    filters = engine._fade_chain(1.0, fade_in, fade_out, in_curve, out_curve)
    raw = subprocess.run(
        [
            resolve_ffmpeg(),
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"aevalsrc=1:d=1:s={RATE}",
            "-af",
            ",".join(filters) or "anull",
            "-f",
            "f32le",
            "-",
        ],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(raw, dtype="<f4")


def _evaluated_unit(
    fade_in: float,
    fade_out: float,
    in_curve: FadeCurve = LINEAR,
    out_curve: FadeCurve = LINEAR,
) -> np.ndarray:
    leaf = SourceAudio(
        Path("a"),
        0.0,
        1.0,
        fade_in_sec=fade_in,
        fade_out_sec=fade_out,
        fade_in_curve=in_curve,
        fade_out_curve=out_curve,
    )
    ones = np.ones(2 * RATE, dtype=np.float32)
    result = evaluate_audio(leaf, crossfade_curve="tri", load_source=lambda _: ones)
    assert result is not None
    return result


def _tone_project(tmp_path: Path, sample_wav: Path, clips: list[Clip]) -> EpisodeProject:
    ws = tmp_path / "ws"
    (ws / "raw").mkdir(parents=True)
    (ws / "raw" / "host.wav").write_bytes(sample_wav.read_bytes())
    project = EpisodeProject.create("curves", str(ws))
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    project.timeline.clips = clips
    return project


def _render_track(project: EpisodeProject, name: str) -> np.ndarray:
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    out = Path(project.workspace_path()) / name
    render_track_from_timeline(project, project.tracks[0], out, DEFAULTS, engine=eng)
    return load_mono_full(out)


def _leaves(project: EpisodeProject, *, fills: bool = False) -> list[SourceAudio]:
    track = project.tracks[0]
    graph = placed_track_audio(
        project,
        track,
        project.clips,
        grid=track_grid(project, track, project.clips, FFmpegEngine()),
    )
    return [leaf for leaf in sources(graph.audio) if leaf.is_fill is fills]


def _hash_project(tmp_path: Path, **clip_extra) -> EpisodeProject:
    project = EpisodeProject.create("hash", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE),
        Track(id="guest", label="Guest", role=TrackRole.DIALOGUE),
    ]
    project.timeline.clips = [
        _clip("a", 0.0, 1.0, 0.0, fade_in_ms=20, fade_out_ms=20, **clip_extra),
        Clip(id="g", track_id="guest", source_start=0.0, source_end=1.0, timeline_start=0.0),
    ]
    return project


def test_service_sets_curves_and_a_length_only_write_keeps_them(minimal_project: Path) -> None:
    from podcast_mcp.services.document import TimelineService

    service = TimelineService(_seed(minimal_project))
    service.set_clip_fade(
        "a", 10, 20, expected=ClipFadeBaseline(0, 0), fade_in_curve=EQUAL_POWER, fade_out_curve=S
    )
    assert _curves(_saved(minimal_project)[0]) == (EQUAL_POWER, S)
    service.set_clip_fade("a", 15, 25, expected=ClipFadeBaseline(10, 20, EQUAL_POWER, S))
    clip = _saved(minimal_project)[0]
    assert (clip.fade_in_ms, clip.fade_out_ms) == (15, 25)
    assert _curves(clip) == (EQUAL_POWER, S)
    service.set_clip_fade(
        "a", 15, 25, expected=ClipFadeBaseline(15, 25, EQUAL_POWER, S), fade_out_curve=LINEAR
    )
    assert _curves(_saved(minimal_project)[0]) == (EQUAL_POWER, LINEAR)
    assert "fade_out_curve" not in _saved(minimal_project)[0].model_dump(mode="json")


def test_a_curve_only_change_keeps_both_lengths(minimal_project: Path) -> None:
    from podcast_mcp.services.document import TimelineService

    ws = _seed(minimal_project, _clip("a", fade_in_ms=40, fade_out_ms=40))
    TimelineService(ws).set_clip_fade(
        "a", 40, 40, expected=ClipFadeBaseline(40, 40), fade_in_curve=S
    )
    clip = _saved(minimal_project)[0]
    assert (clip.fade_in_ms, clip.fade_out_ms, clip.fade_in_curve) == (40, 40, S)


def test_a_stale_curve_only_baseline_is_refused_without_saving_or_a_history_row(
    minimal_project: Path,
) -> None:
    from podcast_mcp.services.document import TimelineService

    ws = _seed(minimal_project)
    stale = TimelineService(ProjectWorkspace.open(minimal_project))
    TimelineService(ws).set_clip_fade("a", 0, 0, expected=ClipFadeBaseline(0, 0), fade_in_curve=S)
    before = minimal_project.read_bytes()
    rows = _entries(ProjectWorkspace.open(minimal_project))
    with pytest.raises(ClipFadeChangedError, match="Nothing was saved") as refusal:
        stale.set_clip_fade("a", 25, 0, expected=ClipFadeBaseline(0, 0))
    assert refusal.value.code == "clip_fade_changed"
    with pytest.raises(ClipFadeChangedError):
        stale.set_clip_fade(
            "a", 0, 0, expected=ClipFadeBaseline(0, 0, fade_in_curve=EQUAL_POWER), fade_out_curve=S
        )
    assert minimal_project.read_bytes() == before
    assert _entries(ProjectWorkspace.open(minimal_project)) == rows


def test_an_omitted_baseline_curve_means_linear_and_matching_curves_are_accepted(
    minimal_project: Path,
) -> None:
    from podcast_mcp.services.document import TimelineService

    baseline = ClipFadeBaseline(10, 20)
    assert (baseline.fade_in_curve, baseline.fade_out_curve) == (LINEAR, LINEAR)
    ws = _seed(minimal_project, _clip("a", fade_in_ms=10, fade_out_ms=20, fade_out_curve=S))
    service = TimelineService(ws)
    with pytest.raises(ClipFadeChangedError):
        service.set_clip_fade("a", 11, 20, expected=baseline)
    service.set_clip_fade("a", 11, 20, expected=ClipFadeBaseline(10, 20, LINEAR, S))
    assert _saved(minimal_project)[0].fade_in_ms == 11


def test_undo_restores_the_previous_curve_and_redo_reapplies_it(minimal_project: Path) -> None:
    from podcast_mcp.services.document import HistoryService, TimelineService

    ws = _seed(minimal_project, _clip("a", fade_in_ms=30, fade_in_curve=EQUAL_POWER))
    TimelineService(ws).set_clip_fade(
        "a", 30, 0, expected=ClipFadeBaseline(30, 0, EQUAL_POWER), fade_in_curve=S, fade_out_curve=S
    )
    assert _curves(_saved(minimal_project)[0]) == (S, S)
    HistoryService(ProjectWorkspace.open(minimal_project)).undo()
    assert _curves(_saved(minimal_project)[0]) == (EQUAL_POWER, LINEAR)
    HistoryService(ProjectWorkspace.open(minimal_project)).redo()
    assert _curves(_saved(minimal_project)[0]) == (S, S)


def test_history_params_record_curves_only_when_set(
    minimal_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.document import TimelineService

    ws = _seed(minimal_project)
    recorded: list[dict] = []
    real = ProjectWorkspace.mutate

    def spy(self, *args, **kwargs):
        recorded.append(kwargs["params"])
        return real(self, *args, **kwargs)

    monkeypatch.setattr(ProjectWorkspace, "mutate", spy)
    service = TimelineService(ws)
    service.set_clip_fade("a", 10, 10, expected=ClipFadeBaseline(0, 0))
    service.set_clip_fade("a", 10, 10, expected=ClipFadeBaseline(10, 10), fade_in_curve=S)
    plain, curved = recorded
    assert not {"fade_in_curve", "fade_out_curve"} & set(plain)
    assert curved["fade_in_curve"] == "s" and "fade_out_curve" not in curved


def test_clips_fade_sets_per_clip_curves_in_one_history_step(minimal_project: Path) -> None:
    from podcast_mcp.services.document import TimelineService

    ws = _seed(minimal_project)
    rows = _entries(ws)
    TimelineService(ws).set_clips_fade(
        [
            ClipFadeEdit("a", 30, 0, ClipFadeBaseline(0, 0), fade_in_curve=S),
            ClipFadeEdit("b", 0, 40, ClipFadeBaseline(0, 0), fade_out_curve=EQUAL_POWER),
        ]
    )
    a, b = _saved(minimal_project)
    assert _curves(a) == (S, LINEAR)
    assert _curves(b) == (LINEAR, EQUAL_POWER)
    assert _entries(ProjectWorkspace.open(minimal_project)) - rows == 2


def test_clips_fade_is_all_or_nothing_on_a_curve_conflict(minimal_project: Path) -> None:
    from podcast_mcp.services.document import TimelineService

    ws = _seed(minimal_project, _clip("a"), _clip("b", 1.0, 2.0, 1.0, fade_in_curve=S))
    before = minimal_project.read_bytes()
    with pytest.raises(ClipFadeChangedError):
        TimelineService(ws).set_clips_fade(
            [
                ClipFadeEdit("a", 10, 0, ClipFadeBaseline(0, 0), fade_in_curve=S),
                ClipFadeEdit("b", 10, 0, ClipFadeBaseline(0, 0)),
            ]
        )
    assert minimal_project.read_bytes() == before


def test_an_unknown_clip_changes_nothing_even_with_curves(minimal_project: Path) -> None:
    from podcast_mcp.services.document import TimelineService

    ws = _seed(minimal_project)
    before = minimal_project.read_bytes()
    with pytest.raises(ClipFadeChangedError):
        TimelineService(ws).set_clips_fade(
            [
                ClipFadeEdit("a", 10, 0, ClipFadeBaseline(0, 0), fade_in_curve=S),
                ClipFadeEdit("gone", 10, 0, ClipFadeBaseline(0, 0)),
            ]
        )
    assert minimal_project.read_bytes() == before


def test_payloads_accept_optional_curves_and_reject_unknown_ones() -> None:
    from podcast_mcp.services.document_sync.payloads import validate_payload

    ok = {
        "clip_id": "a",
        "fade_in_ms": 5,
        "fade_out_ms": 5,
        "expected": {"fade_in_ms": 0, "fade_out_ms": 0},
    }
    plain = validate_payload("SetClipFade", ok)
    assert plain["fade_in_curve"] is None and plain["fade_out_curve"] is None
    assert plain["expected"]["fade_in_curve"] == LINEAR
    curved = validate_payload(
        "SetClipFade",
        {
            **ok,
            "fade_in_curve": "equal_power",
            "fade_out_curve": "s",
            "expected": {"fade_in_ms": 0, "fade_out_ms": 0, "fade_out_curve": "s"},
        },
    )
    assert (curved["fade_in_curve"], curved["fade_out_curve"]) == (EQUAL_POWER, S)
    for bad in (
        {**ok, "fade_in_curve": "log"},
        {**ok, "fade_out_curve": 3},
        {**ok, "expected": {"fade_in_ms": 0, "fade_out_ms": 0, "fade_in_curve": "log"}},
    ):
        with pytest.raises(ValidationError):
            validate_payload("SetClipFade", bad)
    validate_payload("SetClipsFade", {"fades": [{**ok, "fade_in_curve": "s"}]})
    with pytest.raises(ValidationError):
        validate_payload("SetClipsFade", {"fades": [{**ok, "fade_in_curve": "nope"}]})


def _sync(minimal_project: Path):
    from podcast_mcp.services.document_sync import DocumentSyncService
    from podcast_mcp.services.document_sync.commands import DocumentCommand

    svc = DocumentSyncService.open(minimal_project)

    def command(seq, kind, payload):
        return DocumentCommand(
            type=kind, client_id="curve-client", role="editor", client_seq=seq, payload=payload
        )

    return svc, command


def test_document_commands_set_curves_and_refuse_a_curve_only_stale_baseline(
    minimal_project: Path,
) -> None:
    from podcast_mcp.services.document_sync.errors import DocumentConflictError

    _seed(minimal_project)
    svc, command = _sync(minimal_project)
    one = {
        "clip_id": "a",
        "fade_in_ms": 0,
        "fade_out_ms": 0,
        "fade_in_curve": "equal_power",
        "expected": {"fade_in_ms": 0, "fade_out_ms": 0},
    }
    assert svc.submit(command(1, "SetClipFade", one))["ok"] is True
    assert _saved(minimal_project)[0].fade_in_curve is EQUAL_POWER
    many = {
        "fades": [
            {
                "clip_id": "a",
                "fade_in_ms": 10,
                "fade_out_ms": 0,
                "fade_out_curve": "s",
                "expected": {"fade_in_ms": 0, "fade_out_ms": 0, "fade_in_curve": "equal_power"},
            },
            {
                "clip_id": "b",
                "fade_in_ms": 0,
                "fade_out_ms": 10,
                "expected": {"fade_in_ms": 0, "fade_out_ms": 0},
            },
        ]
    }
    assert svc.submit(command(2, "SetClipsFade", many))["ok"] is True
    a, b = _saved(minimal_project)
    assert _curves(a) == (EQUAL_POWER, S)
    assert _curves(b) == (LINEAR, LINEAR)
    before = minimal_project.read_bytes()
    from_a_client_that_predates_curves = {
        "clip_id": "a",
        "fade_in_ms": 10,
        "fade_out_ms": 0,
        "expected": {"fade_in_ms": 10, "fade_out_ms": 0},
    }
    with pytest.raises(DocumentConflictError) as refusal:
        svc.submit(command(3, "SetClipFade", from_a_client_that_predates_curves))
    assert refusal.value.code == "clip_fade_changed"
    assert minimal_project.read_bytes() == before


def test_the_registry_rows_still_name_their_tools() -> None:
    from podcast_mcp.services.document_sync.registry import COMMANDS, GENERIC_CLI, named

    assert COMMANDS["SetClipFade"].mcp == named("set_clip_fade_tool")
    assert COMMANDS["SetClipsFade"].mcp == named("set_clips_fade_tool")
    assert COMMANDS["SetClipFade"].cli == named(GENERIC_CLI)

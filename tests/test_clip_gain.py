from __future__ import annotations

import json
import math
import wave
from pathlib import Path

import numpy as np
import pytest
from pydantic import ValidationError

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.clip_gain import ClipGainBaseline, ClipGainChangedError
from podcast_mcp.engines.audio import sources
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.play_audit import (
    stem_is_fresh,
    track_render_hash,
)
from podcast_mcp.engines.reconciliation_state import audio_state_fingerprint
from podcast_mcp.engines.timeline_render import (
    placed_track_audio,
    render_track_from_timeline,
    track_grid,
)
from podcast_mcp.models import (
    Clip,
    ClipMuteRegion,
    ClipOffSpeakerMuteRegion,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)
from podcast_mcp.models.episode import EditMode, RoomToneFill
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.coded_error import CodedValueError

DEFAULTS = load_defaults()


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


def _gains(minimal_project: Path) -> list[float]:
    return [c.gain_db for c in load_project(minimal_project).clips]


def _entries(ws: ProjectWorkspace) -> int:
    from podcast_mcp.services.document import HistoryService

    return len(HistoryService(ws).list_entries().entries)


def test_clip_gain_defaults_to_zero_and_is_omitted_from_the_dump() -> None:
    clip = _clip()
    assert clip.gain_db == 0.0
    assert "gain_db" not in clip.model_dump(mode="json")
    assert _clip(gain_db=-6).model_dump(mode="json")["gain_db"] == -6


@pytest.mark.parametrize("bad", [-61, 13, math.nan, math.inf, -math.inf])
def test_clip_gain_rejects_out_of_range_and_non_finite(bad) -> None:
    with pytest.raises(ValidationError):
        _clip(gain_db=bad)


def test_clip_gain_accepts_both_rails_and_old_json_loads() -> None:
    assert _clip(gain_db=-60).gain_db == -60
    assert _clip(gain_db=12).gain_db == 12
    old = {"id": "a", "track_id": "host", "source_start": 0, "source_end": 1, "timeline_start": 0}
    assert Clip.model_validate(old).gain_db == 0.0


def test_gain_free_project_bytes_are_unchanged_by_a_save(minimal_project: Path) -> None:
    project = load_project(minimal_project)
    project.timeline.clips = [_clip()]
    save_project(project)
    first = minimal_project.read_bytes()
    assert b"gain_db" not in first.split(b'"clips"')[1].split(b"]")[0]
    save_project(load_project(minimal_project))
    assert minimal_project.read_bytes() == first


def test_project_schema_accepts_clip_gain_db() -> None:
    schema = json.loads(
        (Path(__file__).parents[1] / "schemas" / "episode.project.schema.json").read_text()
    )
    prop = schema["$defs"]["Clip"]["properties"]["gain_db"]
    assert (prop["type"], prop["minimum"], prop["maximum"], prop["default"]) == (
        "number",
        -60,
        12,
        0,
    )


def _hash_project(tmp_path: Path, **clip_extra) -> EpisodeProject:
    project = EpisodeProject.create("hash", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE),
        Track(id="guest", label="Guest", role=TrackRole.DIALOGUE),
    ]
    project.timeline.clips = [
        _clip("a", 0.0, 1.0, 0.0, **clip_extra),
        Clip(id="g", track_id="guest", source_start=0.0, source_end=1.0, timeline_start=0.0),
    ]
    return project


def test_zero_gain_leaves_the_render_hash_byte_identical(tmp_path: Path) -> None:
    project = _hash_project(tmp_path)
    assert track_render_hash(project, "host", defaults=DEFAULTS) == "f602d16f64445e84"
    assert track_render_hash(project, "guest", defaults=DEFAULTS) == "1f11cf02970cc948"
    assert audio_state_fingerprint(project, defaults=DEFAULTS) == "ee374dbfa04e1340"


def test_nonzero_gain_changes_only_its_own_tracks_hash_and_the_fingerprint(
    tmp_path: Path,
) -> None:
    project = _hash_project(tmp_path)
    host = track_render_hash(project, "host", defaults=DEFAULTS)
    guest = track_render_hash(project, "guest", defaults=DEFAULTS)
    fingerprint = audio_state_fingerprint(project, defaults=DEFAULTS)
    project.clips[0].gain_db = 3.0
    assert track_render_hash(project, "host", defaults=DEFAULTS) != host
    assert track_render_hash(project, "guest", defaults=DEFAULTS) == guest
    assert audio_state_fingerprint(project, defaults=DEFAULTS) != fingerprint
    project.clips[0].gain_db = 0.0
    assert track_render_hash(project, "host", defaults=DEFAULTS) == host
    assert audio_state_fingerprint(project, defaults=DEFAULTS) == fingerprint


def test_service_sets_clamps_and_stores_two_decimals(minimal_project: Path) -> None:
    from podcast_mcp.services.document import TimelineService

    ws = _seed(minimal_project)
    result = TimelineService(ws).set_clip_gain("a", -6.256, expected=ClipGainBaseline(0.0))
    assert result["operation"] == "set_clip_gain"
    assert _gains(minimal_project) == [-6.26, 0.0]


def test_service_refuses_an_unknown_clip(minimal_project: Path) -> None:
    from podcast_mcp.services.document import TimelineService

    ws = _seed(minimal_project)
    before = minimal_project.read_bytes()
    with pytest.raises(CodedValueError, match="unknown clip_id"):
        TimelineService(ws).set_clip_gain("gone", 1.0)
    assert minimal_project.read_bytes() == before


def test_stale_baseline_refuses_without_saving_or_a_history_row(minimal_project: Path) -> None:
    from podcast_mcp.services.document import TimelineService

    ws = _seed(minimal_project)
    stale = TimelineService(ProjectWorkspace.open(minimal_project))
    TimelineService(ws).set_clip_gain("a", 2.0)
    before = minimal_project.read_bytes()
    rows = _entries(ProjectWorkspace.open(minimal_project))
    with pytest.raises(ClipGainChangedError, match="Nothing was saved") as refusal:
        stale.set_clip_gain("a", 5.0, expected=ClipGainBaseline(0.0))
    assert refusal.value.code == "clip_gain_changed"
    assert minimal_project.read_bytes() == before
    assert _entries(ProjectWorkspace.open(minimal_project)) == rows


def test_baseline_compares_rounded_values_and_refuses_a_missing_clip(
    minimal_project: Path,
) -> None:
    from podcast_mcp.services.document import TimelineService

    ws = _seed(minimal_project, _clip("a", gain_db=-3.5))
    service = TimelineService(ws)
    service.set_clip_gain("a", -4.0, expected=ClipGainBaseline(-3.5000001))
    with pytest.raises(ClipGainChangedError):
        service.set_clip_gain("gone", 1.0, expected=ClipGainBaseline(0.0))


def test_one_command_is_one_undo_step(minimal_project: Path) -> None:
    from podcast_mcp.services.document import HistoryService, TimelineService

    ws = _seed(minimal_project)
    before = _entries(ws)
    TimelineService(ws).set_clip_gain("a", -9.0)
    assert _entries(ws) == before + 2
    assert _gains(minimal_project) == [-9.0, 0.0]
    HistoryService(ProjectWorkspace.open(minimal_project)).undo()
    assert _gains(minimal_project) == [0.0, 0.0]


def test_clips_gain_sets_absolute_targets_in_one_history_step(
    minimal_project: Path,
) -> None:
    from podcast_mcp.services.document import HistoryService, TimelineService

    ws = _seed(minimal_project, _clip("a", gain_db=2.0), _clip("b", 1.0, 2.0, 1.0))
    before = _entries(ws)
    result = TimelineService(ws).set_clips_gain(
        [("a", -60.0, ClipGainBaseline(2.0)), ("b", 12.0, ClipGainBaseline(0.0))]
    )
    assert result["operation"] == "set_clips_gain"
    assert _gains(minimal_project) == [-60.0, 12.0]
    assert _entries(ws) == before + 2
    HistoryService(ProjectWorkspace.open(minimal_project)).undo()
    assert _gains(minimal_project) == [2.0, 0.0]


def test_clips_gain_is_all_or_nothing(minimal_project: Path) -> None:
    from podcast_mcp.services.document import TimelineService

    ws = _seed(minimal_project)
    before = minimal_project.read_bytes()
    with pytest.raises(ClipGainChangedError):
        TimelineService(ws).set_clips_gain(
            [("a", 1.0, ClipGainBaseline(0.0)), ("b", 1.0, ClipGainBaseline(0.5))]
        )
    assert minimal_project.read_bytes() == before
    with pytest.raises(CodedValueError, match="unknown clip_id"):
        from podcast_mcp.edits.timeline_ops import set_clips_gain

        set_clips_gain(ws.project, [("a", 1.0), ("gone", 1.0)])
    assert ws.project.clips[0].gain_db == 0.0


def test_payloads_validate_range_baseline_and_distinct_targets() -> None:
    from podcast_mcp.services.document_sync.payloads import validate_payload

    ok = {"clip_id": "a", "gain_db": -6, "expected": {"gain_db": 0}}
    validate_payload("SetClipGain", ok)
    for bad in (
        {**ok, "gain_db": -61},
        {**ok, "gain_db": 13},
        {**ok, "gain_db": math.nan},
        {"clip_id": "a", "gain_db": 1},
        {**ok, "expected": {}},
    ):
        with pytest.raises(ValidationError):
            validate_payload("SetClipGain", bad)
    target = {"clip_id": "a", "gain_db": 1, "expected": {"gain_db": 0}}
    validate_payload("SetClipsGain", {"gains": [target]})
    for gain in (-61, 13, math.nan, math.inf):
        with pytest.raises(ValidationError):
            validate_payload("SetClipsGain", {"gains": [{**target, "gain_db": gain}]})
    for gains in ([], [target, target]):
        with pytest.raises(ValidationError):
            validate_payload("SetClipsGain", {"gains": gains})


def test_document_commands_apply_clip_gain_and_refuse_stale(minimal_project: Path) -> None:
    from podcast_mcp.services.document_sync import DocumentSyncService
    from podcast_mcp.services.document_sync.commands import DocumentCommand
    from podcast_mcp.services.document_sync.errors import DocumentConflictError

    _seed(minimal_project)
    svc = DocumentSyncService.open(minimal_project)

    def command(seq, kind, payload):
        return DocumentCommand(
            type=kind, client_id="gain-client", role="editor", client_seq=seq, payload=payload
        )

    one = {"clip_id": "a", "gain_db": -6.0, "expected": {"gain_db": 0.0}}
    assert svc.submit(command(1, "SetClipGain", one))["ok"] is True
    many = {
        "gains": [
            {"clip_id": "a", "gain_db": 3.0, "expected": {"gain_db": -6.0}},
            {"clip_id": "b", "gain_db": 3.0, "expected": {"gain_db": 0.0}},
        ]
    }
    assert svc.submit(command(2, "SetClipsGain", many))["ok"] is True
    assert _gains(minimal_project) == [3.0, 3.0]
    before = minimal_project.read_bytes()
    with pytest.raises(DocumentConflictError) as refusal:
        svc.submit(command(3, "SetClipGain", one))
    assert refusal.value.code == "clip_gain_changed"
    assert minimal_project.read_bytes() == before


def test_registry_rows_name_the_tools_and_the_gui_sender() -> None:
    from podcast_mcp.services.collaboration import ReviewRole
    from podcast_mcp.services.document_sync.registry import COMMANDS, GENERIC_CLI, GUI_SENT, named

    for name, tool in (
        ("SetClipGain", "set_clip_gain_tool"),
        ("SetClipsGain", "set_clips_gain_tool"),
    ):
        spec = COMMANDS[name]
        assert spec.guest is ReviewRole.EDITOR
        assert spec.mcp == named(tool)
        assert spec.cli == named(GENERIC_CLI)
        assert spec.gui == GUI_SENT


def test_list_clips_reports_gain_db(minimal_project: Path) -> None:
    from podcast_mcp.edits.timeline_ops import list_clips

    ws = _seed(minimal_project, _clip("a", gain_db=-4.5), _clip("b", 1.0, 2.0, 1.0))
    rows = list_clips(ws.project, secret=b"s")
    assert [row.get("gain_db") for row in rows["tracks"]["host"]] == [-4.5, None]


def test_clip_slice_commands_refresh_on_gain() -> None:
    from podcast_mcp.services.document_sync.projections import CLIP_SLICE_COMMANDS

    assert {"SetClipGain", "SetClipsGain"} <= set(CLIP_SLICE_COMMANDS)


def test_mcp_tools_set_one_clip_and_many_absolute(minimal_project: Path) -> None:
    from podcast_mcp.mcp.tools.timeline import set_clip_gain_tool, set_clips_gain_tool

    _seed(minimal_project)
    assert json.loads(set_clip_gain_tool(str(minimal_project), "a", -6.0))["operation"] == (
        "set_clip_gain"
    )
    assert _gains(minimal_project) == [-6.0, 0.0]
    out = json.loads(set_clips_gain_tool(str(minimal_project), ["a", "b"], 4.0))
    assert out["operation"] == "set_clips_gain"
    assert _gains(minimal_project) == [4.0, 4.0]
    with pytest.raises(ValidationError):
        set_clips_gain_tool(str(minimal_project), ["a", "b"], 99.0)
    assert _gains(minimal_project) == [4.0, 4.0]


def test_mcp_tools_refuse_unknown_clips_and_bad_values(minimal_project: Path) -> None:
    from podcast_mcp.mcp.tools.timeline import set_clip_gain_tool, set_clips_gain_tool

    _seed(minimal_project)
    with pytest.raises(CodedValueError, match="unknown clip_id"):
        set_clip_gain_tool(str(minimal_project), "gone", 1.0)
    with pytest.raises(CodedValueError, match="unknown clip_id"):
        set_clips_gain_tool(str(minimal_project), ["a", "gone"], 1.0)
    with pytest.raises(ValidationError):
        set_clip_gain_tool(str(minimal_project), "a", 61.0)
    assert _gains(minimal_project) == [0.0, 0.0]


def test_mcp_tools_are_registered() -> None:
    from podcast_mcp.mcp.server import mcp

    names = {tool.name for tool in mcp._tool_manager.list_tools()}
    assert {"set_clip_gain_tool", "set_clips_gain_tool"} <= names


def test_list_clips_tool_reports_the_gain_it_set(minimal_project: Path) -> None:
    from podcast_mcp.mcp.tools.timeline import list_clips_tool, set_clip_gain_tool

    _seed(minimal_project)
    set_clip_gain_tool(str(minimal_project), "b", -2.0)
    rows = json.loads(list_clips_tool(str(minimal_project)))
    assert [row.get("gain_db") for row in rows["tracks"]["host"]] == [None, -2.0]


def _tone_project(tmp_path: Path, sample_wav: Path, clips: list[Clip]) -> EpisodeProject:
    ws = tmp_path / "ws"
    (ws / "raw").mkdir(parents=True)
    (ws / "raw" / "host.wav").write_bytes(sample_wav.read_bytes())
    project = EpisodeProject.create("gain", str(ws))
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


def _render(project: EpisodeProject, name: str) -> np.ndarray:
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    out = Path(project.workspace_path()) / name
    render_track_from_timeline(project, project.tracks[0], out, DEFAULTS, engine=eng)
    with wave.open(str(out), "rb") as stream:
        return np.frombuffer(stream.readframes(stream.getnframes()), dtype="<i2").astype(np.float64)


def _rms(samples: np.ndarray) -> float:
    return float(np.sqrt(np.mean(samples**2)))


def test_minus_six_db_scales_the_render_by_the_linear_ratio(
    tmp_path: Path, sample_wav: Path
) -> None:
    plain = _render(_tone_project(tmp_path / "p", sample_wav, [_clip()]), "plain.wav")
    gained = _render(_tone_project(tmp_path / "g", sample_wav, [_clip(gain_db=-6.0)]), "gained.wav")
    assert abs(20 * math.log10(_rms(gained) / _rms(plain)) + 6.0) < 0.1
    boosted = _render(
        _tone_project(tmp_path / "b", sample_wav, [_clip(gain_db=3.0)]), "boosted.wav"
    )
    assert abs(20 * math.log10(_rms(boosted) / _rms(plain)) - 3.0) < 0.1


def test_gain_composes_with_the_edge_fade_without_changing_its_shape(
    tmp_path: Path, sample_wav: Path
) -> None:
    plain = _render(
        _tone_project(tmp_path / "p", sample_wav, [_clip(end=1.0, fade_in_ms=200)]), "p.wav"
    )
    gained = _render(
        _tone_project(tmp_path / "g", sample_wav, [_clip(end=1.0, fade_in_ms=200, gain_db=-6.0)]),
        "g.wav",
    )
    size = min(plain.size, gained.size)
    ramp = plain[: size // 4]
    assert np.allclose(gained[: size // 4], ramp * 10 ** (-6 / 20), atol=2.0)


def test_each_clip_keeps_its_own_gain_across_a_crossfade_join(
    tmp_path: Path, sample_wav: Path
) -> None:
    from podcast_mcp.models import ClipJoinMode

    clips = [
        _clip("a", 0.0, 0.5, 0.0, gain_db=-12.0, fade_out_ms=50),
        _clip("b", 0.5, 1.0, 0.5, gain_db=0.0, fade_in_ms=50, join_in_mode=ClipJoinMode.CROSSFADE),
    ]
    project = _tone_project(tmp_path, sample_wav, clips)
    audio = _render(project, "join.wav")
    quarter = audio.size // 4
    assert _rms(audio[3 * quarter :]) > 3 * _rms(audio[:quarter])


def test_graph_leaf_carries_gain_and_timed_pieces_keep_it(tmp_path: Path, sample_wav: Path) -> None:
    from podcast_mcp.models.clip_timing import ClipTiming, TimingStep

    clip = _clip(end=2.0, gain_db=-3.0)
    project = _tone_project(tmp_path, sample_wav, [clip])
    track = project.tracks[0]
    eng = FFmpegEngine()
    graph = placed_track_audio(
        project, track, project.clips, grid=track_grid(project, track, project.clips, eng)
    )
    assert {leaf.gain_db for leaf in sources(graph.audio)} == {-3.0}
    project.clips[0].timing = ClipTiming(steps=[TimingStep(at=1.0, delta_sec=0.25)])
    timed = placed_track_audio(
        project, track, project.clips, grid=track_grid(project, track, project.clips, eng)
    )
    leaves = [leaf for leaf in sources(timed.audio) if not leaf.is_fill]
    assert len(leaves) >= 2
    assert {leaf.gain_db for leaf in leaves} == {-3.0}


def test_room_tone_under_a_mute_takes_the_clips_gain_but_gaps_between_clips_do_not(
    tmp_path: Path, sample_wav: Path
) -> None:
    clip = _clip(
        end=1.5,
        gain_db=-6.0,
        mute_regions=[
            ClipMuteRegion(start_s=0.4, end_s=0.7, fill=RoomToneFill(start_s=1.0, end_s=1.2))
        ],
    )
    project = _tone_project(tmp_path, sample_wav, [clip, _clip("far", 0.0, 0.5, 3.0)])
    track = project.tracks[0]
    eng = FFmpegEngine()
    graph = placed_track_audio(
        project, track, project.clips, grid=track_grid(project, track, project.clips, eng)
    )
    leaves = sources(graph.audio)
    fills = [leaf for leaf in leaves if leaf.is_fill and leaf.clip_id == clip.id]
    assert fills
    assert {leaf.gain_db for leaf in fills} == {-6.0}
    assert {leaf.gain_db for leaf in leaves if leaf.clip_id == "far"} == {0.0}
    assert {leaf.gain_db for leaf in leaves if leaf.is_fill and leaf.clip_id is None} <= {0.0}


def test_gain_is_a_compared_leaf_field(tmp_path: Path, sample_wav: Path) -> None:
    from podcast_mcp.engines.audio import SourceAudio

    path = tmp_path / "x.wav"
    assert SourceAudio(path, 0.0, 1.0) == SourceAudio(path, 0.0, 1.0, gain_db=0.0)
    assert SourceAudio(path, 0.0, 1.0) != SourceAudio(path, 0.0, 1.0, gain_db=-1.0)


def test_off_speaker_mute_still_works_under_clip_gain(tmp_path: Path, sample_wav: Path) -> None:
    clip = _clip(
        end=1.5,
        gain_db=-6.0,
        off_speaker_mute_regions=[ClipOffSpeakerMuteRegion(start_s=0.5, end_s=0.9)],
    )
    project = _tone_project(tmp_path, sample_wav, [clip])
    track = project.tracks[0]
    eng = FFmpegEngine()
    graph = placed_track_audio(
        project, track, project.clips, grid=track_grid(project, track, project.clips, eng)
    )
    from podcast_mcp.engines.audio import OffSpeakerAudio

    node = graph.audio
    found = []

    def walk(item):
        if isinstance(item, OffSpeakerAudio):
            found.append(item)
        for child in getattr(item, "__dict__", {}).values():
            if hasattr(child, "__dataclass_fields__"):
                walk(child)
            elif isinstance(child, tuple):
                for part in child:
                    if hasattr(part, "__dataclass_fields__"):
                        walk(part)

    walk(node)
    assert found
    assert all(item.primary.gain_db == -6.0 for item in found)
    assert all(item.body is item.primary for item in found)


def test_evaluator_matches_the_ffmpeg_render_for_a_gained_clip(
    tmp_path: Path, sample_wav: Path
) -> None:
    from podcast_mcp.engines.audio_eval import evaluate_audio
    from podcast_mcp.engines.timeline_render import unfiltered_track_audio
    from podcast_mcp.engines.ungated_audio import load_mono_full

    clip = _clip(end=1.0, gain_db=-7.5, fade_in_ms=40, fade_out_ms=40)
    late = _clip("b", 1.2, 1.8, 1.4, gain_db=4.0, fade_in_ms=20, fade_out_ms=20)
    project = _tone_project(tmp_path, sample_wav, [clip, late])
    rendered_path = Path(project.workspace_path()) / "eval.wav"
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    render_track_from_timeline(project, project.tracks[0], rendered_path, DEFAULTS, engine=eng)
    rendered = load_mono_full(rendered_path)
    audio, curve = unfiltered_track_audio(project, project.tracks[0], DEFAULTS)
    evaluated = evaluate_audio(audio, crossfade_curve=curve, load_source=load_mono_full)
    assert evaluated is not None
    common = min(evaluated.size, rendered.size)
    assert abs(evaluated.size - rendered.size) <= 3
    assert np.abs(evaluated[:common] - rendered[:common]).max() < 1e-3


def test_gain_operations_journal_as_clip_changes() -> None:
    from podcast_mcp.engines.render_invalidations import reason_for_operation

    assert reason_for_operation("set_clip_gain") == "clip"
    assert reason_for_operation("set_clips_gain") == "clip"


def test_a_gain_edit_stales_the_stem_and_journals_a_clip_invalidation(
    minimal_project: Path, sample_wav: Path, tmp_workspace: Path
) -> None:
    from podcast_mcp.engines.render_status import render_status_report
    from podcast_mcp.pipeline import steps
    from podcast_mcp.services.document import TimelineService

    if not FFmpegEngine().check_available()[0]:
        pytest.skip("ffmpeg not available")
    project = load_project(minimal_project)
    (tmp_workspace / "raw").mkdir(exist_ok=True)
    (tmp_workspace / "raw" / "host.wav").write_bytes(sample_wav.read_bytes())
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    project.clips = [_clip("c1", 0.0, 2.0)]
    save_project(project, minimal_project)
    project = load_project(minimal_project)
    steps.render_dialogue_stems(project, DEFAULTS)
    assert stem_is_fresh(project, "host", defaults=DEFAULTS)

    TimelineService(ProjectWorkspace.open(minimal_project)).set_clip_gain("c1", 3.0)

    after = load_project(minimal_project)
    assert not stem_is_fresh(after, "host", defaults=DEFAULTS)
    report = render_status_report(after, defaults=DEFAULTS)
    assert report["tracks"]["host"]["stem_is_fresh"] is False
    assert any(inv.reason == "clip" for inv in after.render.invalidations)


def test_copy_and_paste_keep_clip_gain(minimal_project: Path) -> None:
    from podcast_mcp.edits.timeline_ops import copy_segment, paste_segment

    ws = _seed(minimal_project, _clip("a", 0.0, 1.0, 0.0, gain_db=-4.5))
    clipboard = copy_segment(ws.project, 0.0, 1.0)
    assert clipboard["extracts"][0]["gain_db"] == -4.5
    paste_segment(
        ws.project,
        5.0,
        clipboard["duration"],
        clipboard["extracts"],
        mode=EditMode.GAP,
        defaults=DEFAULTS,
    )
    pasted = [c for c in ws.project.clips if c.id != "a"]
    assert [c.gain_db for c in pasted] == [-4.5]


def test_an_older_clipboard_without_gain_pastes_at_unity(minimal_project: Path) -> None:
    from podcast_mcp.edits.timeline_ops import copy_segment, paste_segment

    ws = _seed(minimal_project, _clip("a", 0.0, 1.0, 0.0))
    clipboard = copy_segment(ws.project, 0.0, 1.0)
    assert "gain_db" not in clipboard["extracts"][0]
    paste_segment(
        ws.project,
        5.0,
        clipboard["duration"],
        clipboard["extracts"],
        mode=EditMode.GAP,
        defaults=DEFAULTS,
    )
    assert [c.gain_db for c in ws.project.clips if c.id != "a"] == [0.0]


@pytest.mark.parametrize("raw", [math.nan, math.inf, 99, -99, "loud"])
def test_a_bad_clipboard_gain_does_not_reject_the_paste(minimal_project: Path, raw) -> None:
    from podcast_mcp.edits.timeline_ops import copy_segment, paste_segment

    ws = _seed(minimal_project, _clip("a", 0.0, 1.0, 0.0))
    clipboard = copy_segment(ws.project, 0.0, 1.0)
    clipboard["extracts"][0]["gain_db"] = raw
    paste_segment(
        ws.project,
        5.0,
        clipboard["duration"],
        clipboard["extracts"],
        mode=EditMode.GAP,
        defaults=DEFAULTS,
    )
    pasted = [c for c in ws.project.clips if c.id != "a"]
    assert len(pasted) == 1
    assert -60.0 <= pasted[0].gain_db <= 12.0


def test_extract_clips_in_range_and_split_keep_gain(minimal_project: Path) -> None:
    from podcast_mcp.edits.timeline_ops import split_clip
    from podcast_mcp.engines.clips_ops import extract_clips_in_timeline_range

    ws = _seed(minimal_project, _clip("a", 0.0, 2.0, 0.0, gain_db=-8.0))
    extracted = extract_clips_in_timeline_range(ws.project.clips, 0.5, 1.5, cut_fade_ms=None)
    assert [c.gain_db for c in extracted] == [-8.0]
    split_clip(ws.project, "host", 1.0, defaults=DEFAULTS)
    assert {c.gain_db for c in ws.project.clips} == {-8.0}
    assert len(ws.project.clips) == 2


def test_a_saved_segment_bakes_the_clip_gain_into_its_audio(
    minimal_project: Path, sample_wav: Path, tmp_path: Path
) -> None:
    from podcast_mcp.engines.ungated_audio import load_mono_full
    from podcast_mcp.services.document.segment_capture import capture_segment

    if not FFmpegEngine().check_available()[0]:
        pytest.skip("ffmpeg not available")
    project = load_project(minimal_project)
    raw = Path(project.workspace_path()) / "raw"
    raw.mkdir(exist_ok=True)
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    project.tracks = [
        Track(id="host", label="Host", role=TrackRole.MUSIC, media=MediaAsset(path="raw/host.wav"))
    ]
    project.clips = [_clip("plain", 0.0, 1.0, 0.0), _clip("quiet", 0.0, 1.0, 5.0, gain_db=-6.0)]
    save_project(project, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    segment = capture_segment(
        ws, name="Gained", directory=tmp_path / "seg", clip_ids=["plain", "quiet"], kind="sting"
    )
    plain = load_mono_full(tmp_path / "seg" / segment.clips[0].audio)
    quiet = load_mono_full(tmp_path / "seg" / segment.clips[1].audio)
    ratio = 20 * math.log10(float(np.sqrt(np.mean(quiet**2)) / np.sqrt(np.mean(plain**2))))
    assert abs(ratio + 6.0) < 0.2
    assert not hasattr(segment.clips[0], "gain_db")


def test_extract_segment_applies_gain_through_the_graph(tmp_path: Path, sample_wav: Path) -> None:
    from podcast_mcp.engines.ungated_audio import load_mono_full

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    plain = eng.extract_segment(sample_wav, tmp_path / "plain.wav", 0.0, 1.0)
    gained = eng.extract_segment(sample_wav, tmp_path / "gained.wav", 0.0, 1.0, gain_db=-6.0)
    a, b = load_mono_full(plain), load_mono_full(gained)
    assert abs(20 * math.log10(np.sqrt(np.mean(b**2)) / np.sqrt(np.mean(a**2))) + 6.0) < 0.1


def test_occurrence_proxy_identity_ignores_clip_gain(tmp_path: Path) -> None:
    import wave as wave_module

    from podcast_mcp.engines import source_proxy_audio as proxy
    from podcast_mcp.models import ClipBleedRestore
    from podcast_mcp.models.episode import SourceSpan
    from podcast_mcp.util.hashing import sha256_file

    root = tmp_path
    with wave_module.open(str(root / "primary.wav"), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(16000)
        stream.writeframes(np.full(16000, 1000, dtype="<i2").tobytes())
    project = EpisodeProject.create("Inputs", str(root))
    project.tracks = [Track(id="origin", label="Origin", media=MediaAsset(path="primary.wav"))]
    project.clips = [
        Clip(
            id="choice",
            track_id="origin",
            source_start=0.1,
            source_end=0.9,
            timeline_start=5,
            bleed_restore=ClipBleedRestore(
                source_sha256=sha256_file(root / "primary.wav"),
                regions=[SourceSpan(start_s=0.3, end_s=0.7)],
            ),
        )
    ]
    engine = FFmpegEngine()

    def capture():
        return proxy.SourceProxyInputs.capture_occurrence(
            project, "choice", engine, defaults=DEFAULTS
        )

    original = capture().input_hash
    project.clips[0].gain_db = -9.0
    assert capture().input_hash == original


def test_timing_hole_room_tone_takes_the_parent_clips_gain(tmp_path: Path) -> None:
    from test_timed_clip_holes import _fills, _lane, _pool
    from test_timed_clip_render import _project, _source

    clip = _lane([{"at": 2.0, "delta_sec": 0.5}], gain_db=-6.0)
    project = _project(tmp_path, [clip], _source(room=0.02))
    with _pool((5.0, 7.0)):
        fills = _fills(clip, project)
    assert fills
    assert {leaf.gain_db for leaf in fills} == {-6.0}


def test_gate_row_gain_does_not_move_the_occurrence_proxy_identity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import wave as wave_module

    from podcast_mcp.engines import source_proxy_audio as proxy
    from podcast_mcp.engines.bleed_gate import BleedGatePlan
    from podcast_mcp.models import ClipBleedRestore
    from podcast_mcp.models.episode import SourceSpan
    from podcast_mcp.util.hashing import sha256_file

    for name in ("primary.wav", "peer.wav"):
        with wave_module.open(str(tmp_path / name), "wb") as stream:
            stream.setnchannels(1)
            stream.setsampwidth(2)
            stream.setframerate(16000)
            stream.writeframes(np.full(16000, 1000, dtype="<i2").tobytes())
    project = EpisodeProject.create("Inputs", str(tmp_path))
    project.tracks = [
        Track(
            id="origin",
            label="Origin",
            media=MediaAsset(path="primary.wav"),
            transcript_gate=True,
        ),
        Track(id="peer", label="Peer", media=MediaAsset(path="peer.wav")),
    ]
    project.clips = [
        Clip(
            id="choice",
            track_id="origin",
            source_start=0.1,
            source_end=0.9,
            timeline_start=5,
            bleed_restore=ClipBleedRestore(
                source_sha256=sha256_file(tmp_path / "primary.wav"),
                regions=[SourceSpan(start_s=0.3, end_s=0.7)],
            ),
        )
    ]
    plan = BleedGatePlan(attenuation_spans=((0.2, 0.4),))
    monkeypatch.setattr(proxy, "build_bleed_gate_plan", lambda *_a, **_k: plan)
    engine = FFmpegEngine()

    def capture():
        return proxy.SourceProxyInputs.capture_occurrence(
            project, "choice", engine, defaults=DEFAULTS
        )

    original = capture().input_hash
    project.clips[0].gain_db = -9.0
    assert capture().input_hash == original


def test_verdict_cache_key_sees_a_gain_only_edit_and_stays_put_without_one() -> None:
    from podcast_mcp.edits.verdict_cache import _heard, _outside_ramps

    plain = _clip("a", 0.0, 4.0, 1.0, fade_in_ms=20, fade_out_ms=20)
    gained = plain.model_copy(update={"gain_db": -6.0})
    zero = plain.model_copy(update={"gain_db": 0.0})
    window = (-math.inf, math.inf)
    assert _heard(zero, *window) == _heard(plain, *window)
    base = _heard(plain, *window)
    moved = _heard(gained, *window)
    assert moved[: len(base)] == base
    assert moved != base
    quiet = _heard(plain.model_copy(update={"gain_db": -12.0}), *window)
    assert quiet != moved

    def near(*_args):
        return []

    assert _outside_ramps(plain, near, True, True) is not None
    assert _outside_ramps(gained, near, True, True) != _outside_ramps(plain, near, True, True)
    assert _outside_ramps(zero, near, True, True) == _outside_ramps(plain, near, True, True)

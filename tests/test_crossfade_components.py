from __future__ import annotations

import struct
import wave
from pathlib import Path

import pytest

from podcast_mcp.engines.audio import (
    At,
    CrossfadeAudio,
    MixAudio,
    SourceAudio,
    duration,
)
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.timeline_render import (
    _ClipContent,
    _place_clips,
    _PreparedClip,
    render_track_from_timeline,
    render_track_segment,
)
from podcast_mcp.models import (
    Clip,
    ClipJoinMode,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    Track,
    load_project,
    save_project,
)


def _constant(path: Path, seconds: float, pcm: int, *, floating: bool = False) -> SourceAudio:
    if floating:
        from podcast_mcp.util.process import run

        run(
            [
                FFmpegEngine().ffmpeg,
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"aevalsrc={pcm}/32768:s=48000:d={seconds}",
                "-c:a",
                "pcm_f64le",
                str(path),
            ],
            check=True,
            capture_output=True,
        )
        return SourceAudio(path, 0.0, seconds)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(48000)
        output.writeframes(struct.pack("<h", pcm) * round(seconds * 48000))
    return SourceAudio(path, 0.0, seconds)


def _read(path: Path) -> tuple[int, ...]:
    with wave.open(str(path), "rb") as source:
        frames = source.getnframes()
        assert source.getframerate() == 48000
        assert source.getnchannels() == 1
        return struct.unpack(f"<{frames}h", source.readframes(frames))


def _prepared(name: str, start: float, end: float, source: SourceAudio, *, join=False):
    clip = Clip(
        id=name,
        track_id="host",
        source_start=source.src_start,
        source_end=source.src_end,
        timeline_start=start,
        fade_in_ms=100,
        fade_out_ms=100,
        join_in_mode=ClipJoinMode.CROSSFADE if join else ClipJoinMode.CUT,
    )
    return _PreparedClip(clip, _ClipContent(start, end, source, ()))


def test_plan_names_saved_partner_and_preserves_enclosing_actor(tmp_path: Path):
    follower = SourceAudio(tmp_path / "follower.wav", 0.0, 20.0)
    anchor = SourceAudio(tmp_path / "anchor.wav", 0.0, 6.0)
    later = SourceAudio(tmp_path / "later.wav", 0.0, 2.0)
    plan = _place_clips(
        [
            _prepared("follower", 2, 22, follower),
            _prepared("anchor", 5, 11, anchor),
            _prepared("later", 11, 13, later, join=True),
        ]
    )
    assert plan == MixAudio(At(2, follower), (At(5, CrossfadeAudio(anchor, later, 0.1)),))
    assert duration(plan) == 22


@pytest.mark.parametrize(
    "curve, midpoint, mixed_midpoint", [("tri", 12497, 14498), ("qsin", 17675, 19675)]
)
def test_native_curve_and_independent_actor_pcm(
    tmp_path: Path, curve: str, midpoint: int, mixed_midpoint: int
):
    left = _constant(tmp_path / "left.wav", 1, 10000)
    right = _constant(tmp_path / "right.wav", 1, 15000)
    actor = _constant(tmp_path / "actor.wav", 2, 2000)
    pair = CrossfadeAudio(left, right, 0.1)
    engine = FFmpegEngine()
    plain = tmp_path / "pair.wav"
    mixed = tmp_path / "mixed.wav"
    engine.render_timeline(plain, pair, "anull", crossfade_curve=curve)
    engine.render_timeline(
        mixed, MixAudio(At(0, pair), (At(0, actor),)), "anull", crossfade_curve=curve
    )
    samples = _read(plain)
    summed = _read(mixed)
    assert len(samples) == 91200
    assert len(summed) == 96000
    assert samples[45600] == midpoint
    assert summed[45600] == mixed_midpoint
    assert all(
        abs(total - value - 2000) <= 1 for total, value in zip(summed, samples, strict=False)
    )
    assert summed[95000] == 2000


@pytest.mark.parametrize(
    "floating, expected",
    [(True, [5700, 5998, 7799, 8549, 9000]), (False, [5699, 5997, 7799, 8549, 9000])],
)
def test_short_middle_keeps_sequential_native_chain(tmp_path: Path, floating: bool, expected):
    a = _constant(tmp_path / "a.wav", 1, 3000, floating=floating)
    b = _constant(tmp_path / "b.wav", 0.1, 6000, floating=floating)
    c = _constant(tmp_path / "c.wav", 1, 9000, floating=floating)
    prepared = [
        _prepared("a", 0, 1, a),
        _prepared("b", 1, 1.1, b, join=True),
        _prepared("c", 1.1, 2.1, c, join=True),
    ]
    prepared[0].clip.fade_out_ms = 20
    prepared[1].clip.fade_in_ms = 20
    prepared[1].clip.fade_out_ms = 200
    prepared[2].clip.fade_in_ms = 200
    chain = _place_clips(prepared)
    assert chain == MixAudio(At(0, CrossfadeAudio(CrossfadeAudio(a, b, 0.02), c, 0.2)), ())
    out = tmp_path / "chain.wav"
    FFmpegEngine().render_timeline(out, chain, "anull")
    pcm = _read(out)
    assert len(pcm) == 90240
    assert [pcm[round(t * 48000)] for t in (0.97, 0.98, 1.0, 1.05, 1.5)] == expected


def _project(tmp_path: Path, clips: list[Clip]) -> EpisodeProject:
    project = EpisodeProject.create("components", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", media=MediaAsset(path="host.wav", duration_sec=8))
    ]
    project.timeline.clips = clips
    return project


def _pair_clips() -> list[Clip]:
    return [
        Clip(
            id="a",
            track_id="host",
            source_start=0,
            source_end=6,
            timeline_start=5,
            fade_in_ms=0,
            fade_out_ms=100,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=6,
            source_end=8,
            timeline_start=11,
            fade_in_ms=100,
            fade_out_ms=0,
            join_in_mode=ClipJoinMode.CROSSFADE,
        ),
    ]


def test_production_first_retained_piece_caps_crossfade(tmp_path: Path):
    project = _project(tmp_path, _pair_clips())
    project.edit_decisions = [
        EditDecision(
            id="cut",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=6.04,
            end=6.06,
            applied=True,
        )
    ]
    with wave.open(str(tmp_path / "host.wav"), "wb") as source:
        source.setnchannels(1)
        source.setsampwidth(2)
        source.setframerate(48000)
        source.writeframes(bytes(6 * 48000 * 2) + struct.pack("<h", 15000) * 96000)
    project = load_project(save_project(project))
    out = tmp_path / "cap.wav"
    render_track_from_timeline(project, project.tracks[0], out, {})
    pcm = _read(out)
    assert len(pcm) == 622080
    assert pcm[527520] == 7500


@pytest.mark.parametrize(
    "kind, start, end, frames, first, middle",
    [
        ("crossfade", 10.92, 11.02, 4320, 0, 0),
        ("fade", 0.02, 0.08, 2880, 15000, 15000),
    ],
)
def test_authored_windows_keep_selected_piece_cap_and_local_fades(
    tmp_path: Path,
    kind: str,
    start: float,
    end: float,
    frames: int,
    first: int,
    middle: int,
):
    with wave.open(str(tmp_path / "host.wav"), "wb") as source:
        source.setnchannels(1)
        source.setsampwidth(2)
        source.setframerate(48000)
        source.writeframes(bytes(6 * 48000 * 2) + struct.pack("<h", 15000) * 96000)
    clips = (
        _pair_clips()
        if kind == "crossfade"
        else [
            Clip(
                id="fade",
                track_id="host",
                source_start=6,
                source_end=8,
                timeline_start=0,
                fade_in_ms=100,
                fade_out_ms=0,
            )
        ]
    )
    project = load_project(save_project(_project(tmp_path, clips)))
    full = tmp_path / "full.wav"
    out = tmp_path / "window.wav"
    render_track_from_timeline(project, project.tracks[0], full, {})
    render_track_segment(project, "host", start, end, out, {})
    pcm = _read(out)
    assert (len(pcm), pcm[0], pcm[len(pcm) // 2]) == (frames, first, middle)
    assert _read(full)[round(start * 48000)] == 3000


@pytest.mark.parametrize(
    "start, end, frames", [(0, 1.5, 48000), (1.2, 1.8, 28800), (0.8, 1.5, 24000), (0.2, 1.5, 38400)]
)
def test_authored_windows_contract_only_selected_source_removes(
    tmp_path: Path,
    start: float,
    end: float,
    frames: int,
):
    _constant(tmp_path / "host.wav", 2, 15000)
    project = _project(
        tmp_path,
        [
            Clip(
                id="a",
                track_id="host",
                source_start=0,
                source_end=2,
                timeline_start=0,
                fade_in_ms=0,
                fade_out_ms=0,
            )
        ],
    )
    project.edit_decisions = [
        EditDecision(
            id="cut", track_id="host", type=EditDecisionType.REMOVE, start=0.5, end=1, applied=True
        )
    ]
    project = load_project(save_project(project))
    out = tmp_path / "window.wav"
    render_track_segment(project, "host", start, end, out, {})
    pcm = _read(out)
    assert (len(pcm), pcm[len(pcm) // 2]) == (frames, 15000)


def test_unselected_saved_predecessor_cannot_borrow_another_actor(tmp_path: Path):
    follower = SourceAudio(tmp_path / "follower.wav", 0.0, 20.0)
    anchor = SourceAudio(tmp_path / "unused.wav", 0.0, 6.0)
    later = SourceAudio(tmp_path / "later.wav", 0.0, 2.0)
    missing = _prepared("anchor", 5, 11, anchor)
    plan = _place_clips(
        [
            _prepared("follower", 2, 22, follower),
            _PreparedClip(missing.clip, None),
            _prepared("later", 11, 13, later, join=True),
        ]
    )
    assert plan == MixAudio(At(2, follower), (At(11, later),))
    assert duration(plan) == 22


def test_no_retained_content_has_no_render_expression(tmp_path: Path):
    clip = _prepared("empty", 0, 1, SourceAudio(tmp_path / "unused.wav", 0, 1)).clip
    with pytest.raises(ValueError, match="no clips to render"):
        _place_clips([_PreparedClip(clip, None)])


def test_silence_expression_uses_default_engine_format(tmp_path: Path):
    from podcast_mcp.engines.audio import SilenceAudio

    out = tmp_path / "zero.wav"
    FFmpegEngine().render_timeline(out, SilenceAudio(0.25), "anull")
    with wave.open(str(out), "rb") as source:
        assert (source.getframerate(), source.getnchannels(), source.getnframes()) == (
            48000,
            2,
            12000,
        )
        assert source.readframes(12000) == bytes(12000 * 2 * 2)

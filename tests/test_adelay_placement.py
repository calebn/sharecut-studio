"""A delayed slice lands on sample ``ms * rate // 1000``, as the evaluation places it (#2025)."""

from __future__ import annotations

import errno
import os
import subprocess
import wave
from collections.abc import Callable
from itertools import pairwise
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

import numpy as np
import pytest

import multistream_media as media
from podcast_mcp.engines import ffmpeg as ff
from podcast_mcp.engines import render_clock
from podcast_mcp.engines.audio import (
    At,
    Audio,
    CrossfadeAudio,
    MixAudio,
    SequenceAudio,
    SourceAudio,
    rendered_sources,
)
from podcast_mcp.engines.ffmpeg import FFmpegEngine, _delay_filter
from podcast_mcp.util.coded_error import CodedValueError
from test_render_wav_header import _UNDECODABLE

_IMPULSE = 16384
_IMPULSE_FRAMES = 64


def _write_wav(path: Path, samples: np.ndarray, rate: int) -> Path:
    with wave.open(str(path), "wb") as audio_file:
        audio_file.setnchannels(1)
        audio_file.setsampwidth(2)
        audio_file.setframerate(rate)
        audio_file.writeframes(samples.astype("<i2").tobytes())
    return path


def _impulse(path: Path, rate: int) -> Path:
    samples = np.zeros(_IMPULSE_FRAMES, dtype="<i2")
    samples[0] = _IMPULSE
    return _write_wav(path, samples, rate)


def _read_wav(path: Path) -> tuple[int, np.ndarray]:
    with wave.open(str(path), "rb") as audio_file:
        rate = audio_file.getframerate()
        return rate, np.frombuffer(audio_file.readframes(audio_file.getnframes()), dtype="<i2")


def _filter_impulse_frame(tmp_path: Path, rate: int, chain: str) -> tuple[int, int]:
    source = _impulse(tmp_path / "impulse.wav", rate)
    out = tmp_path / "out.wav"
    subprocess.run(
        [FFmpegEngine().ffmpeg, "-y", "-i", str(source), "-af", chain, str(out)],
        check=True,
        capture_output=True,
    )
    out_rate, samples = _read_wav(out)
    return out_rate, int(np.argmax(np.abs(samples)))


def _placed_frames(tmp_path: Path, rate: int, delays_ms: list[int]) -> list[int]:
    source = _impulse(tmp_path / f"impulse_{rate}.wav", rate)
    duration = _IMPULSE_FRAMES / rate
    placed = [At(ms / 1000, SourceAudio(source, 0.0, duration)) for ms in sorted(delays_ms)]
    out = tmp_path / f"placed_{rate}.wav"
    FFmpegEngine().render_timeline(out, MixAudio(placed[0], tuple(placed[1:])), "anull")
    _, samples = _read_wav(out)
    return [int(i) for i in np.flatnonzero(samples)]


# First ms values where adelay's float32 multiply lands a sample early (checked against FFmpeg 9).
_FLOAT32_SHORT_MS = {8000: [], 22050: [6100, 6180, 6260], 44100: [3050, 3090, 3130], 48000: []}


def test_delay_filter_places_an_impulse_on_the_exact_sample(tmp_path: Path) -> None:
    rate, frame = _filter_impulse_frame(tmp_path, 44100, _delay_filter(10.9, 44100))
    assert rate == 44100
    assert frame == 480690
    rate, frame = _filter_impulse_frame(tmp_path, 44100, _delay_filter(10.875, 44100))
    assert frame == 479587


def _zeros(path: Path, rate: int, seconds: float) -> SourceAudio:
    _write_wav(path, np.zeros(int(seconds * rate), dtype="<i2"), rate)
    return SourceAudio(path, 0.0, seconds)


def _impulse_at(path: Path, rate: int) -> SourceAudio:
    samples = np.zeros(rate // 2, dtype="<i2")
    samples[0] = _IMPULSE
    _write_wav(path, samples, rate)
    return SourceAudio(path, 0.0, 0.5)


def _peak_near(samples: np.ndarray, frame: int) -> int:
    window = np.abs(samples[frame - 50 : frame + 50])
    return frame - 50 + int(np.argmax(window))


def _delayed(tmp_path: Path, head_rate: int, delayed: list[tuple[int, float]]) -> Audio:
    head = _zeros(tmp_path / "head.wav", head_rate, 4.0)
    placed = tuple(
        At(start, _impulse_at(tmp_path / f"delayed_{rate}_{k}.wav", rate))
        for k, (rate, start) in enumerate(delayed)
    )
    return MixAudio(At(0.0, head), placed)


def _all_delayed(tmp_path: Path) -> Audio:
    return MixAudio(
        At(0.5, _impulse_at(tmp_path / "a44.wav", 44100)),
        (At(2.5, _impulse_at(tmp_path / "a48.wav", 48000)),),
    )


def _noise(path: Path, rate: int, seconds: float) -> Path:
    rng = np.random.default_rng(rate)
    return _write_wav(path, rng.integers(-3000, 3000, int(seconds * rate)), rate)


def _room_tone(tmp_path: Path, bed_rate: int) -> tuple[Audio, Path]:
    main = _noise(tmp_path / "main.wav", 48000, 6.0)
    bed = _noise(tmp_path / "bed.wav", bed_rate, 0.5)
    fill = SourceAudio(bed, 0.0, 0.4, is_fill=True)
    body = SequenceAudio(
        SourceAudio(main, 0.0, 2.0),
        (
            MixAudio(At(0.0, SourceAudio(main, 2.0, 4.0)), (At(0.5, fill),)),
            SourceAudio(main, 4.0, 6.0),
        ),
    )
    return MixAudio(At(0.0, body), ()), main


def _nested(tmp_path: Path, shape: str) -> Audio:
    if shape == "seq_44_mix_48":
        outer, inner, delayed_rate = 44100, 48000, 48000
    elif shape == "seq_48_mix_44":
        outer, inner, delayed_rate = 48000, 44100, 48000
    else:
        outer, inner, delayed_rate = 44100, 48000, 16000
    front = _zeros(tmp_path / "front.wav", outer, 1.0)
    inner_head = _zeros(tmp_path / "inner.wav", inner, 1.0)
    mix = MixAudio(
        At(0.0, inner_head), (At(0.5, _impulse_at(tmp_path / "late.wav", delayed_rate)),)
    )
    if shape == "xf_44_mix_16":
        return CrossfadeAudio(front, mix, 0.02)
    return SequenceAudio(front, (mix,))


_TRUNK_RATE_CASES = {
    "h44.1+d48": (lambda p: _delayed(p, 44100, [(48000, 2.5)]), 44100, [110250]),
    "h48+d44.1": (lambda p: _delayed(p, 48000, [(44100, 3.05)]), 48000, [146400]),
    "h48+d16": (lambda p: _delayed(p, 48000, [(16000, 3.05)]), 48000, [146400]),
    "h16+d48": (lambda p: _delayed(p, 16000, [(48000, 3.05)]), 16000, [48800]),
    "h44.1+d22.05+d48": (
        lambda p: _delayed(p, 44100, [(22050, 1.0009), (48000, 2.5)]),
        44100,
        [44144, 110250],
    ),
    "all-delayed": (_all_delayed, 44100, [22050, 110250]),
}


@pytest.mark.parametrize("name", list(_TRUNK_RATE_CASES))
def test_render_keeps_the_rate_the_mix_ran_at_and_places_each_delay_exactly(
    tmp_path: Path, name: str
) -> None:
    build, expected_rate, expected_frames = _TRUNK_RATE_CASES[name]
    out = tmp_path / "out.wav"
    FFmpegEngine().render_timeline(out, build(tmp_path), "anull")
    rate, samples = _read_wav(out)
    assert rate == expected_rate
    assert [_peak_near(samples, frame) for frame in expected_frames] == expected_frames


@pytest.mark.parametrize("bed_rate", [16000, 44100])
def test_room_tone_fill_leaves_the_main_lane_unresampled(tmp_path: Path, bed_rate: int) -> None:
    audio, main = _room_tone(tmp_path, bed_rate)
    out = tmp_path / "out.wav"
    FFmpegEngine().render_timeline(out, audio, "anull")
    rate, samples = _read_wav(out)
    assert (rate, len(samples)) == (48000, 288000)
    np.testing.assert_array_equal(samples[:48000], _read_wav(main)[1][:48000])


@pytest.mark.parametrize(
    ("shape", "expected_rate"),
    [("seq_44_mix_48", 44100), ("seq_48_mix_44", 48000), ("xf_44_mix_16", 44100)],
)
def test_render_keeps_a_nested_mixes_rate(tmp_path: Path, shape: str, expected_rate: int) -> None:
    out = tmp_path / "out.wav"
    FFmpegEngine().render_timeline(out, _nested(tmp_path, shape), "anull")
    assert _read_wav(out)[0] == expected_rate


_FORCED_MS = [1000, 3050, 3090, 3130, 10900, 10875, 15000, 123457, 360100]


@pytest.mark.parametrize("ms", _FORCED_MS)
def test_render_places_a_44k_source_on_the_forced_48k_output_exactly(
    tmp_path: Path, ms: int
) -> None:
    audio = MixAudio(
        At(0.0, _zeros(tmp_path / "quiet.wav", 44100, 0.2)),
        (At(ms / 1000, _impulse_at(tmp_path / "impulse.wav", 44100)),),
    )
    expected = ms * 48000 // 1000
    out = tmp_path / "out.wav"
    FFmpegEngine().render_timeline(
        out,
        audio,
        f"aformat=sample_rates=48000,atrim=start_sample={expected - 1000}:end_sample={expected + 1000}",
    )
    rate, samples = _read_wav(out)
    assert rate == 48000
    assert int(np.argmax(np.abs(samples))) == 1000


def test_render_pins_the_forced_rate_not_the_source_rate(tmp_path: Path) -> None:
    audio = MixAudio(
        At(0.0, _zeros(tmp_path / "quiet.wav", 44100, 0.2)),
        (At(3.05, _impulse_at(tmp_path / "impulse.wav", 44100)),),
    )
    commands: list[str] = []
    real_run = ff.run

    def capture_run(cmd, *args, **kwargs):
        commands.append(" ".join(str(x) for x in cmd))
        return real_run(cmd, *args, **kwargs)

    with patch.object(ff, "run", side_effect=capture_run):
        FFmpegEngine().render_timeline(tmp_path / "out.wav", audio, "aformat=sample_rates=48000")
    assert any(
        "aformat=sample_rates=48000,adelay=delays=146400S" in command for command in commands
    )


def test_render_places_a_long_delay_on_the_exact_sample(tmp_path: Path) -> None:
    audio = MixAudio(
        At(0.0, _zeros(tmp_path / "quiet.wav", 48000, 0.01)),
        (At(3000.0, _impulse_at(tmp_path / "impulse.wav", 48000)),),
    )
    out = tmp_path / "long.wav"
    FFmpegEngine().render_timeline(out, audio, "atrim=start_sample=143999000:end_sample=144001000")
    assert int(np.argmax(np.abs(_read_wav(out)[1]))) == 1000


def _clocked(tmp_path: Path, audio: Audio, chain: str) -> tuple[int, np.ndarray, list[int]]:
    out = tmp_path / "clocked.wav"
    clock_path = tmp_path / "clock.json"
    FFmpegEngine().render_timeline(out, audio, chain, clock_path=clock_path)
    rate, samples = _read_wav(out)
    clock = render_clock.read_render_clock(clock_path)
    assert clock.output.sample_rate == rate
    assert {boundary.producer.sample_rate for _, _, boundary in clock.delays} == {rate}
    rendered = rendered_sources(audio, clock)
    return (
        rate,
        samples,
        [
            source.frame(source.source_first_frame)
            for source in rendered
            if np.any(_read_wav(source.source.path)[1])
        ],
    )


@pytest.mark.parametrize("name", ["h44.1+d48", "h48+d44.1", "all-delayed"])
def test_clock_follows_the_pinned_delay(tmp_path: Path, name: str) -> None:
    build, expected_rate, expected_frames = _TRUNK_RATE_CASES[name]
    rate, samples, frames = _clocked(tmp_path, build(tmp_path), "anull")
    assert rate == expected_rate
    assert frames[-1] == _peak_near(samples, expected_frames[-1])


@pytest.mark.parametrize("shape", ["seq_44_mix_48", "seq_48_mix_44"])
def test_clock_follows_a_nested_mixes_delay(tmp_path: Path, shape: str) -> None:
    rate, samples, frames = _clocked(tmp_path, _nested(tmp_path, shape), "anull")
    assert frames == [_peak_near(samples, frames[0])]
    assert rate == (44100 if shape == "seq_44_mix_48" else 48000)


def test_clock_follows_the_room_tone_fill(tmp_path: Path) -> None:
    audio, _ = _room_tone(tmp_path, 16000)
    out = tmp_path / "out.wav"
    clock_path = tmp_path / "clock.json"
    FFmpegEngine().render_timeline(out, audio, "anull", clock_path=clock_path)
    clock = render_clock.read_render_clock(clock_path)
    assert {boundary.producer.sample_rate for _, _, boundary in clock.delays} == {48000}
    rendered_sources(audio, clock)


def test_clock_follows_the_forced_rate_delay(tmp_path: Path) -> None:
    audio = MixAudio(
        At(0.0, _zeros(tmp_path / "quiet.wav", 44100, 0.2)),
        (At(3.05, _impulse_at(tmp_path / "delayed.wav", 44100)),),
    )
    rate, samples, frames = _clocked(tmp_path, audio, "aformat=sample_rates=48000")
    assert rate == 48000
    assert frames == [146400] == [_peak_near(samples, 146400)]


def test_negotiated_rates_refuses_a_missing_port(tmp_path: Path) -> None:
    engine = FFmpegEngine()
    source = _impulse(tmp_path / "impulse.wav", 48000)
    filters = ["[0:a]adelay@pin_0=1000:all=1[out]"]
    rates = render_clock.negotiated_rates(
        engine.ffmpeg, engine.ffprobe, filters, (source,), ["adelay@pin_0"]
    )
    assert rates == {"adelay@pin_0": 48000}
    with pytest.raises(CodedValueError) as error:
        render_clock.negotiated_rates(
            engine.ffmpeg, engine.ffprobe, filters, (source,), ["adelay@pin_1"]
        )
    assert error.value.code == "render_rate_unresolved"


def test_negotiated_rates_refuses_a_missing_input(tmp_path: Path) -> None:
    engine = FFmpegEngine()
    with pytest.raises(CodedValueError) as error:
        render_clock.negotiated_rates(
            engine.ffmpeg,
            engine.ffprobe,
            ["[0:a]adelay@pin_0=1000:all=1[out]"],
            (tmp_path / "missing.m4a",),
            ["adelay@pin_0"],
        )
    assert error.value.code == "render_rate_unresolved"


@pytest.mark.parametrize("rate", [8000, 22050, 44100, 48000])
def test_render_places_every_delay_on_ms_times_rate_floor_1000(tmp_path: Path, rate: int) -> None:
    delays = [*_FLOAT32_SHORT_MS[rate], 10900, 15000]
    expected = sorted({ms * rate // 1000 for ms in delays})
    assert _placed_frames(tmp_path, rate, delays) == expected


def _empty_wav(path: Path, rate: int) -> SourceAudio:
    _write_wav(path, np.zeros(0), rate)
    return SourceAudio(path, 0.0, 0.1)


def _with_child(tmp_path: Path, child: SourceAudio) -> Audio:
    return MixAudio(At(0.0, _zeros(tmp_path / "head.wav", 48000, 0.2)), (At(0.3, child),))


def test_plain_render_accepts_an_empty_wav_child(tmp_path: Path) -> None:
    out = tmp_path / "out.wav"
    FFmpegEngine().render_timeline(
        out, _with_child(tmp_path, _empty_wav(tmp_path / "empty.wav", 48000)), "anull"
    )
    rate, samples = _read_wav(out)
    assert (rate, len(samples)) == (48000, 14400)


def test_restore_render_of_empty_wav_keeps_bleed_code(tmp_path: Path) -> None:
    audio = _with_child(tmp_path, _empty_wav(tmp_path / "empty.wav", 48000))
    with pytest.raises(CodedValueError) as error:
        FFmpegEngine().render_timeline(
            tmp_path / "out.wav", audio, "anull", clock_path=tmp_path / "clock.json"
        )
    assert error.value.code == "bleed_restore_clock_invalid"


def test_restore_native_format_of_an_empty_wav_is_the_clock_error(tmp_path: Path) -> None:
    empty = _empty_wav(tmp_path / "empty.wav", 48000).path
    with pytest.raises(CodedValueError) as error:
        render_clock.native_format(FFmpegEngine().ffmpeg, empty)
    assert error.value.code == "bleed_restore_clock_invalid"


def test_plain_render_unreadable_non_wav_raises_render_rate_unresolved(tmp_path: Path) -> None:
    child = tmp_path / "silent.aiff"
    subprocess.run(
        [
            FFmpegEngine().ffmpeg,
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=16000:cl=mono",
            "-t",
            "0",
            "-c:a",
            "pcm_s16be",
            str(child),
        ],
        check=True,
        capture_output=True,
    )
    with pytest.raises(CodedValueError) as error:
        FFmpegEngine().render_timeline(
            tmp_path / "out.wav",
            _with_child(tmp_path, SourceAudio(child, 0.0, 0.1)),
            "anull",
        )
    assert error.value.code == "render_rate_unresolved"


def test_multistream_head_renders_at_first_stream_rate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    head = SourceAudio(media.multistream(tmp_path, "kid.ogg"), 0.0, 1.0)
    audio = MixAudio(At(0.0, head), (At(0.25, _zeros(tmp_path / "child.wav", 44100, 1.0)),))
    graphs: list[str] = []
    real_run = ff.run

    def capture_run(cmd, *args, **kwargs):
        if "-map" in cmd:
            graphs.append(cmd[cmd.index("-filter_complex") + 1])
        return real_run(cmd, *args, **kwargs)

    monkeypatch.setattr(ff, "run", capture_run)
    plain = FFmpegEngine().render_timeline(tmp_path / "plain.wav", audio, "anull")
    assert "aformat=sample_rates=22050,adelay=delays=5512S" in graphs[-1]
    rate, samples = _read_wav(plain)
    assert (rate, len(samples)) == (22050, 27562)
    restored = FFmpegEngine().render_timeline(
        tmp_path / "restored.wav", audio, "anull", clock_path=tmp_path / "clock.json"
    )
    assert restored.read_bytes() == plain.read_bytes()


def _undecodable_child(tmp_path: Path, name: str) -> Path:
    child = tmp_path / "child.wav"
    child.write_bytes(_UNDECODABLE[name]())
    decode = subprocess.run(
        [FFmpegEngine().ffmpeg, "-v", "error", "-i", str(child), "-f", "null", "-"],
        capture_output=True,
    )
    assert decode.returncode != 0
    return child


def _plain_error(tmp_path: Path, child: Path) -> CodedValueError:
    audio = _with_child(tmp_path, SourceAudio(child, 0.0, 0.1))
    with pytest.raises(CodedValueError) as error:
        FFmpegEngine().render_timeline(tmp_path / "out.wav", audio, "anull")
    return error.value


def _observer_error(child: Path) -> CodedValueError:
    engine = FFmpegEngine()
    with pytest.raises(CodedValueError) as error:
        render_clock.configure_observers(
            engine.ffmpeg, engine.ffprobe, ["[0:a]anull[out]"], (child,), {}, []
        )
    return error.value


@pytest.mark.parametrize("name", list(_UNDECODABLE))
def test_header_valid_undecodable_wav_is_render_rate_unresolved(tmp_path: Path, name: str) -> None:
    child = _undecodable_child(tmp_path, name)
    plain = _plain_error(tmp_path, child)
    assert plain.code == "render_rate_unresolved"
    assert child.name in str(plain)
    assert _observer_error(child).code == "bleed_restore_clock_invalid"


def test_unopenable_file_is_coded_on_the_restore_route(tmp_path: Path) -> None:
    child = tmp_path / "child.wav"
    child.write_bytes(np.random.default_rng(0).bytes(256))
    with pytest.raises(CodedValueError) as error:
        render_clock.native_format(FFmpegEngine().ffmpeg, child)
    assert error.value.code == "bleed_restore_clock_invalid"
    assert _observer_error(child).code == "bleed_restore_clock_invalid"


@pytest.mark.parametrize("build", [media.video_only, media.cover_image])
def test_input_without_audio_keeps_its_coded_errors(
    tmp_path: Path, build: Callable[[Path], Path]
) -> None:
    child = build(tmp_path)
    plain = _plain_error(tmp_path, child)
    assert plain.code == "render_rate_unresolved"
    assert child.name in str(plain)
    assert _observer_error(child).code == "bleed_restore_clock_invalid"


def test_a_failing_final_render_with_a_delay_stays_a_process_error(tmp_path: Path) -> None:
    out = tmp_path / "out.wav"
    out.mkdir()
    with pytest.raises(subprocess.CalledProcessError):
        FFmpegEngine().render_timeline(out, _delayed(tmp_path, 48000, [(48000, 1.0)]), "anull")


def _m4a(path: Path, rate: int) -> SourceAudio:
    subprocess.run(
        [
            FFmpegEngine().ffmpeg,
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:sample_rate={rate}:duration=0.5",
            "-c:a",
            "aac",
            str(path),
        ],
        check=True,
        capture_output=True,
    )
    return SourceAudio(path, 0.0, 0.3)


def _spawns(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    spawned: list[str] = []
    real_run = ff.run

    def counting_run(cmd, *args, **kwargs):
        spawned.append(Path(cmd[0]).name)
        return real_run(cmd, *args, **kwargs)

    monkeypatch.setattr(ff, "run", counting_run)
    monkeypatch.setattr(render_clock, "run", counting_run)
    return spawned


def test_plain_render_spawn_count(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    spawned = _spawns(monkeypatch)
    head = _zeros(tmp_path / "head.wav", 48000, 0.2)
    wavs = MixAudio(
        At(0.0, head),
        tuple(
            At(0.05 * (k + 1), _impulse_at(tmp_path / f"child_{k}.wav", 48000)) for k in range(20)
        ),
    )
    FFmpegEngine().render_timeline(tmp_path / "wavs.wav", wavs, "anull")
    assert spawned == ["ffprobe", "ffmpeg"]

    spawned.clear()
    first, second = _m4a(tmp_path / "a.m4a", 22050), _m4a(tmp_path / "b.m4a", 16000)
    compressed = MixAudio(At(0.0, head), (At(0.3, first), At(0.6, second)))
    engine = FFmpegEngine()
    engine.render_timeline(tmp_path / "first.wav", compressed, "anull")
    assert len(spawned) == 4
    spawned.clear()
    engine.render_timeline(tmp_path / "second.wav", compressed, "anull")
    assert len(spawned) == 2
    spawned.clear()
    stamp = first.path.stat()
    os.utime(first.path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns + 1_000_000_000))
    engine.render_timeline(tmp_path / "third.wav", compressed, "anull")
    assert len(spawned) == 3


def _failing_run(
    monkeypatch: pytest.MonkeyPatch, fails: Callable[[list[str]], bool], error: OSError
) -> None:
    real_run = ff.run

    def run(cmd, *args, **kwargs):
        if fails([str(part) for part in cmd]):
            raise error
        return real_run(cmd, *args, **kwargs)

    monkeypatch.setattr(ff, "run", run)
    monkeypatch.setattr(render_clock, "run", run)


def _is_dry_run(cmd: list[str]) -> bool:
    return "-dumpgraph" in cmd


def _is_render(cmd: list[str]) -> bool:
    return "-map" in cmd


@pytest.mark.parametrize("fails", [_is_dry_run, _is_render], ids=["dry-run", "render"])
def test_e2big_is_render_command_too_long(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fails: Callable[[list[str]], bool]
) -> None:
    refusal = OSError(errno.E2BIG, "Argument list too long")
    _failing_run(monkeypatch, fails, refusal)
    with pytest.raises(CodedValueError) as error:
        FFmpegEngine().render_timeline(tmp_path / "out.wav", _all_delayed(tmp_path), "anull")
    assert error.value.code == "render_command_too_long"
    assert error.value.__cause__ is refusal


class _WindowsTooLong(FileNotFoundError):
    winerror = 206


def test_winerror_206_is_render_command_too_long(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    too_long = _WindowsTooLong(errno.ENOENT, "The filename or extension is too long")
    _failing_run(monkeypatch, _is_dry_run, too_long)
    with pytest.raises(CodedValueError) as error:
        FFmpegEngine().render_timeline(tmp_path / "out.wav", _all_delayed(tmp_path), "anull")
    assert error.value.code == "render_command_too_long"
    assert error.value.__cause__ is too_long

    missing = FileNotFoundError(errno.ENOENT, "No such file or directory")
    _failing_run(monkeypatch, _is_dry_run, missing)
    with pytest.raises(FileNotFoundError) as unchanged:
        FFmpegEngine().render_timeline(tmp_path / "out.wav", _all_delayed(tmp_path), "anull")
    assert unchanged.value is missing


def _slices(tmp_path: Path, count: int) -> Audio:
    tiny = _zeros(tmp_path / "tiny.wav", 48000, 0.01)
    return MixAudio(At(0.0, tiny), tuple(At(0.02 * (k + 1), tiny) for k in range(count)))


def _render_long_graph(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, render_fails: bool
) -> tuple[list[list[str]], list[tuple[Path, bytes]]]:
    real_run = render_clock.run
    argvs: list[list[str]] = []
    files: list[tuple[Path, bytes]] = []

    def run(cmd, *args, **kwargs):
        argv = [str(part) for part in cmd]
        argvs.append(argv)
        for option, value in pairwise(argv):
            if option in ("-/filter_complex", "-graph_file"):
                files.append((Path(value), Path(value).read_bytes()))
        if "-map" not in argv:
            return real_run(cmd, *args, **kwargs)
        if render_fails:
            raise RuntimeError("render failed")
        return CompletedProcess(argv, 0)

    monkeypatch.setattr(ff, "run", run)
    monkeypatch.setattr(render_clock, "run", run)
    render = FFmpegEngine().render_timeline
    if render_fails:
        with pytest.raises(RuntimeError):
            render(tmp_path / "out.wav", _slices(tmp_path, 700), "anull")
    else:
        render(tmp_path / "out.wav", _slices(tmp_path, 700), "anull")
    return argvs, files


@pytest.mark.parametrize("render_fails", [False, True], ids=["returned", "raised"])
def test_long_graph_goes_by_file_unit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, render_fails: bool
) -> None:
    argvs, files = _render_long_graph(tmp_path, monkeypatch, render_fails=render_fails)
    dry = next(argv for argv in argvs if "-dumpgraph" in argv)
    render = next(argv for argv in argvs if "-map" in argv)
    at = dry.index("-graph_file")
    assert dry[at + 2 : at + 4] == ["-i", "dummy"]
    assert "-/filter_complex" in render
    assert max(len(part) for argv in argvs for part in argv) <= 8000
    assert len(files) == 2
    for path, content in files:
        assert not content.startswith(b"\xef\xbb\xbf")
        assert not path.parent.exists()


@pytest.mark.slow
@pytest.mark.timeout(300)
def test_620_delays_render(tmp_path: Path) -> None:
    out = tmp_path / "out.wav"
    FFmpegEngine().render_timeline(out, _slices(tmp_path, 620), "anull")
    assert _read_wav(out)[0] == 48000


def test_render_holds_the_dry_run_rate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        ff,
        "negotiated_rates",
        lambda ffmpeg, ffprobe, filters, input_paths, names: dict.fromkeys(names, 44100),
    )
    out = tmp_path / "out.wav"
    FFmpegEngine().render_timeline(out, _delayed(tmp_path, 48000, [(48000, 2.5)]), "anull")
    rate, samples = _read_wav(out)
    assert rate == 44100
    assert _peak_near(samples, 2500 * 44100 // 1000) == 2500 * 44100 // 1000


@pytest.mark.parametrize(("source_rate", "forced_rate"), [(44100, 48000), (48000, 44100)])
def test_trailing_pin_holds_rate_after_a_downstream_fixed_rate(
    tmp_path: Path, source_rate: int, forced_rate: int
) -> None:
    graph = (
        f"[1:a]{_delay_filter(1.0, source_rate)}[d];"
        "[0:a][d]amix=inputs=2:duration=longest:normalize=0,"
        f"aformat=sample_rates={forced_rate}[out]"
    )
    out = tmp_path / "out.wav"
    subprocess.run(
        [
            FFmpegEngine().ffmpeg,
            "-y",
            "-i",
            str(_zeros(tmp_path / "head.wav", source_rate, 0.2).path),
            "-i",
            str(_impulse(tmp_path / "child.wav", source_rate)),
            "-filter_complex",
            graph,
            "-map",
            "[out]",
            str(out),
        ],
        check=True,
        capture_output=True,
    )
    rate, samples = _read_wav(out)
    assert rate == forced_rate
    assert abs(int(np.argmax(np.abs(samples))) - forced_rate) < 64


_CLOCK_CASES = {
    **{name: case[0] for name, case in _TRUNK_RATE_CASES.items()},
    "seq_44_mix_48": lambda p: _nested(p, "seq_44_mix_48"),
    "seq_48_mix_44": lambda p: _nested(p, "seq_48_mix_44"),
    "room-tone": lambda p: _room_tone(p, 16000)[0],
}


@pytest.mark.parametrize("name", list(_CLOCK_CASES))
def test_clock_suite_file_form(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    audio = _CLOCK_CASES[name](tmp_path)
    inline_out, inline_clock = tmp_path / "inline.wav", tmp_path / "inline.json"
    FFmpegEngine().render_timeline(inline_out, audio, "anull", clock_path=inline_clock)
    monkeypatch.setattr(render_clock, "_INLINE_GRAPH_MAX_CHARS", 0)
    file_out, file_clock = tmp_path / "file.wav", tmp_path / "file.json"
    FFmpegEngine().render_timeline(file_out, audio, "anull", clock_path=file_clock)
    assert file_clock.read_bytes() == inline_clock.read_bytes()
    assert file_out.read_bytes() == inline_out.read_bytes()


def test_small_graph_argv_unchanged(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    audio = _delayed(tmp_path, 48000, [(48000, 1.0), (48000, 2.0), (48000, 3.05)])
    renders: list[list[str]] = []
    real_run = ff.run

    def capture_run(cmd, *args, **kwargs):
        if "-map" in cmd:
            renders.append([str(part) for part in cmd])
        return real_run(cmd, *args, **kwargs)

    monkeypatch.setattr(ff, "run", capture_run)
    out = tmp_path / "out.wav"
    FFmpegEngine().render_timeline(out, audio, "anull")
    pin = "aformat=sample_rates=48000"
    delayed = [
        f"[a{k}]{pin},adelay=delays={frames}S:all=1,asetpts=N/SR/TB,{pin}[node{k - 1}]"
        for k, frames in ((1, 48000), (2, 96000), (3, 146400))
    ]
    graph = ";".join(
        [
            "[0:a]anull[src_in0_0]",
            "[1:a]anull[src_in1_0]",
            "[2:a]anull[src_in2_0]",
            "[3:a]anull[src_in3_0]",
            "[src_in0_0]atrim=start=0.000000:end=4.000000,asetpts=PTS-STARTPTS[src0]",
            "[src_in1_0]atrim=start=0.000000:end=0.500000,asetpts=PTS-STARTPTS[src1]",
            "[src_in2_0]atrim=start=0.000000:end=0.500000,asetpts=PTS-STARTPTS[src2]",
            "[src_in3_0]atrim=start=0.000000:end=0.500000,asetpts=PTS-STARTPTS[src3]",
            "[src0]anull[a0]",
            "[src1]anull[a1]",
            "[src2]anull[a2]",
            "[src3]anull[a3]",
            *delayed,
            "[a0][node0][node1][node2]amix=inputs=4:duration=longest:normalize=0,"
            "asetpts=N/SR/TB,asetnsamples=n=1024:p=0[node3]",
            "[node3]anull[out]",
        ]
    )
    sources = [tmp_path / "head.wav", *(tmp_path / f"delayed_48000_{k}.wav" for k in range(3))]
    inputs = [
        part
        for k, path in enumerate(sources)
        for part in ("-t", "4.000000" if k == 0 else "0.500000", "-i", str(path.resolve()))
    ]
    assert renders == [
        [FFmpegEngine().ffmpeg, "-y", *inputs, "-filter_complex", graph, "-map", "[out]", str(out)]
    ]


def test_negotiated_inputs_follow_the_render_input_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    audio, main = _room_tone(tmp_path, 16000)
    dry_run: list[tuple[Path, ...]] = []
    renders: list[list[str]] = []
    real_rates = ff.negotiated_rates
    real_run = ff.run

    def capture_rates(ffmpeg, ffprobe, filters, input_paths, names):
        dry_run.append(input_paths)
        return real_rates(ffmpeg, ffprobe, filters, input_paths, names)

    def capture_run(cmd, *args, **kwargs):
        renders.append([str(part) for part in cmd])
        return real_run(cmd, *args, **kwargs)

    monkeypatch.setattr(ff, "negotiated_rates", capture_rates)
    monkeypatch.setattr(ff, "run", capture_run)
    FFmpegEngine().render_timeline(tmp_path / "out.wav", audio, "anull")
    argv = renders[-1]
    inputs = tuple(Path(argv[i + 1]) for i, option in enumerate(argv) if option == "-i")
    assert dry_run == [inputs]
    assert len(inputs) == 2
    assert inputs[0] == main.resolve()

"""Synthetic tests for Layer-1 join continuity scoring."""

from __future__ import annotations

import wave
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from podcast_mcp.edits.join_continuity import (
    JoinContinuityConfig,
    assess_project_joins,
    assess_proposed_cut,
    score_splice_samples,
)
from podcast_mcp.models import (
    Clip,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)


def _cfg(**kwargs) -> JoinContinuityConfig:
    base = dict(
        calibrate=False,
        neural=False,
        force_review_multi_hot=False,
        side_sec=0.045,
        sample_rate=16000,
    )
    base.update(kwargs)
    return JoinContinuityConfig(**base)


def test_click_splice_fails() -> None:
    sr = 16000
    n = int(0.05 * sr)
    left = np.zeros(n)
    right = np.zeros(n)
    right[0] = 1.0
    risk, hits = score_splice_samples(left, right, sample_rate=sr, config=_cfg())
    click = next(h for h in hits if h.name == "click")
    assert click.score > 0.5
    assert risk > 0.28


def test_smooth_tone_passes() -> None:
    sr = 16000
    n = int(0.08 * sr)
    t = np.arange(n) / sr
    tone = 0.2 * np.sin(2 * np.pi * 220 * t)
    risk, hits = score_splice_samples(tone, tone.copy(), sample_rate=sr, config=_cfg())
    assert risk < 0.48
    assert all(h.name != "insufficient_audio" for h in hits)


def test_level_jump_elevates() -> None:
    sr = 16000
    n = int(0.05 * sr)
    left = 0.01 * np.sin(2 * np.pi * 200 * np.arange(n) / sr)
    right = 0.5 * np.sin(2 * np.pi * 200 * np.arange(n) / sr)
    risk, _ = score_splice_samples(left, right, sample_rate=sr, config=_cfg())
    quiet = 0.2 * np.sin(2 * np.pi * 200 * np.arange(n) / sr)
    risk_ok, _ = score_splice_samples(quiet, quiet.copy(), sample_rate=sr, config=_cfg())
    assert risk > risk_ok


def test_spectral_jump_elevates() -> None:
    sr = 16000
    n = int(0.06 * sr)
    left = 0.3 * np.sin(2 * np.pi * 180 * np.arange(n) / sr)
    right = np.random.default_rng(0).normal(0, 0.25, n)
    risk, hits = score_splice_samples(left, right, sample_rate=sr, config=_cfg())
    flux = next(h for h in hits if h.name == "spectral_flux")
    assert flux.score > 0.2
    assert risk > 0.2


def test_hot_onset_scores() -> None:
    sr = 16000
    n = int(0.05 * sr)
    left = 0.05 * np.sin(2 * np.pi * 200 * np.arange(n) / sr)
    right = np.zeros(n)
    right[: n // 4] = 0.8
    _, hits = score_splice_samples(left, right, sample_rate=sr, config=_cfg())
    onset = next(h for h in hits if h.name == "onset_collision")
    assert onset.score > 0.3


def test_short_audio_fail_closed() -> None:
    risk, hits = score_splice_samples(np.zeros(4), np.zeros(4), sample_rate=16000, config=_cfg())
    assert risk == 1.0
    assert hits[0].name == "insufficient_audio"


def test_verdict_thresholds() -> None:
    from podcast_mcp.edits.join_continuity import _finalize

    cfg = _cfg(pass_below=0.28, review_below=0.48)
    samples = np.random.default_rng(0).normal(0, 0.1, 16000)
    for risk, expected in ((0.1, "pass"), (0.35, "review"), (0.7, "fail")):
        rep = _finalize(
            track_id="t",
            mode="test",
            join_sec=1.0,
            timebase="source",
            risk=risk,
            hits=[],
            samples=samples,
            cfg=cfg,
        )
        assert rep.verdict == expected
        assert "disclaimer" in rep.to_dict()
        assert rep.disclaimer


def test_short_audio_skips_calibration() -> None:
    from podcast_mcp.edits.join_continuity import _apply_calibration

    cfg = _cfg(calibrate=True)
    risk, cal, nat = _apply_calibration(0.4, [], np.zeros(100), cfg)
    assert cal is False
    assert nat is None
    assert risk == 0.4


def test_multi_hot_forces_review() -> None:
    from podcast_mcp.edits.join_continuity import DetectorHit, _verdict

    cfg = _cfg(force_review_multi_hot=True, pass_below=0.28, review_below=0.48)
    hits = [
        DetectorHit("a", 0.7, 1.0),
        DetectorHit("b", 0.7, 1.0),
    ]
    verdict, reasons, adj = _verdict(0.1, cfg, hits)
    assert verdict == "review"
    assert any("multi_hot" in r for r in reasons)
    assert adj >= cfg.pass_below


def test_forensic_detectors_present() -> None:
    sr = 16000
    n = int(0.1 * sr)
    left = 0.2 * np.sin(2 * np.pi * 250 * np.arange(n) / sr)
    right = np.random.default_rng(4).normal(0, 0.2, n)
    _, hits = score_splice_samples(left, right, sample_rate=sr, config=_cfg())
    names = {h.name for h in hits}
    assert "bicoherence_proxy" in names
    assert "late_energy_ratio" in names
    assert "lsf_mahalanobis" in names
    assert "mca_join_cost" in names
    assert "weighted_spectral_join" in names


def test_weighted_fusion_in_hits() -> None:
    sr = 16000
    n = int(0.06 * sr)
    left = np.sin(2 * np.pi * 200 * np.arange(n) / sr)
    right = np.random.default_rng(5).normal(0, 0.3, n)
    risk, hits = score_splice_samples(left, right, sample_rate=sr, config=_cfg())
    w = next(h for h in hits if h.name == "weighted_spectral_join")
    assert 0.0 <= w.score <= 1.0
    assert 0.0 <= risk <= 1.0


def _tiny_project(minimal_project: Path, sample_wav: Path):
    project = load_project(minimal_project)
    raw = project.workspace_path() / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    project.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=0.5,
            timeline_start=0.0,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=1.0,
            source_end=1.5,
            timeline_start=0.5,
        ),
    ]
    save_project(project, minimal_project)
    return load_project(minimal_project)


def test_assess_proposed_cut_and_project_joins(minimal_project: Path, sample_wav: Path) -> None:
    project = _tiny_project(minimal_project, sample_wav)
    cfg = _cfg(calibrate=False, neural=False)
    rep = assess_proposed_cut(project, "host", 0.2, 0.4, timebase="source", config=cfg)
    assert rep.mode == "proposed_cut"
    assert rep.verdict in ("pass", "review", "fail")
    assert "cut " in " ".join(rep.reasons)

    sweep = assess_project_joins(project, track_id="host", config=cfg)
    assert sweep["join_count"] == 1
    assert sweep["worst"] is not None
    assert "disclaimer" in sweep


def test_existing_join_scores_the_splice_sides(minimal_project: Path) -> None:
    """A timeline join on a clip splice abuts the left clip's end and the right clip's
    start; the raw audio around the resume point alone is not the join (#775)."""
    project = load_project(minimal_project)
    raw = project.workspace_path() / "raw" / "host.wav"
    sr = 16000
    t = np.arange(2 * sr) / sr
    samples = np.where(t < 1.0, 0.5 * np.sin(2 * np.pi * 220.0 * t), 0.0).astype(np.float32)
    pcm = (samples * 32767).astype("<i2")
    with wave.open(str(raw), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sr)
        handle.writeframes(pcm.tobytes())
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    # Left clip ends inside the tone; right clip resumes in the silent half.
    project.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=0.5, timeline_start=0.0),
        Clip(id="c2", track_id="host", source_start=1.5, source_end=2.0, timeline_start=0.5),
    ]
    save_project(project, minimal_project)
    project = load_project(minimal_project)

    from podcast_mcp.edits.join_continuity import assess_existing_join

    rep = assess_existing_join(project, "host", 0.5, timebase="timeline", config=_cfg())
    level = next(h for h in rep.detectors if h.name == "level_jump")
    assert level.detail["pre_db"] > -12.0
    assert level.detail["post_db"] < -100.0
    assert level.score == 1.0

    sweep = assess_project_joins(project, track_id="host", config=_cfg())
    assert sweep["join_count"] == 1
    assert sweep["joins"][0]["source_gap_sec"] == 1.0
    (join,) = sweep["joins"]
    skipped = ("source_gap_sec", "speech", "verdict", "reasons")
    assert {k: v for k, v in join.items() if k not in skipped} == {
        k: v for k, v in rep.to_dict().items() if k not in ("verdict", "reasons")
    }
    # The left clip ends 500 ms before the tone stops: a clipped tail on the sweep too,
    # and a row with a crossing never reads pass.
    assert sweep["speech_cross_count"] == 1
    assert join["speech"][0]["direction"] == "clipped_tail"
    assert join["speech"][0]["removed_ms"] == pytest.approx(500.0, abs=20.0)
    assert rep.verdict == "fail"
    assert join["verdict"] == "fail"
    assert join["reasons"] == rep.reasons


def test_inaudible_splice_passes_with_its_levels(minimal_project: Path) -> None:
    """Room tone against gated digital silence is below the audibility floor on both
    sides: no level-jump fail, one ``inaudible_splice`` hit, verdict pass."""
    project = load_project(minimal_project)
    raw = project.workspace_path() / "raw" / "host.wav"
    sr = 16000
    rng = np.random.default_rng(3)
    samples = np.concatenate(
        [rng.normal(0, 10 ** (-75 / 20), sr).astype(np.float32), np.zeros(sr, dtype=np.float32)]
    )
    pcm = (samples * 32767).astype("<i2")
    with wave.open(str(raw), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sr)
        handle.writeframes(pcm.tobytes())
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    project.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=0.5, timeline_start=0.0),
        Clip(id="c2", track_id="host", source_start=1.5, source_end=2.0, timeline_start=0.5),
    ]
    save_project(project, minimal_project)
    project = load_project(minimal_project)

    from podcast_mcp.edits.join_continuity import assess_existing_join

    rep = assess_existing_join(project, "host", 0.5, timebase="timeline", config=_cfg())
    assert rep.verdict == "pass"
    assert rep.risk == 0.0
    assert [h.name for h in rep.detectors] == ["inaudible_splice"]
    assert rep.detectors[0].detail["floor_db"] == -60.0
    assert rep.detectors[0].detail["left_db"] < -60.0
    assert rep.detectors[0].detail["right_db"] == -200.0
    assert "inaudible splice: both sides below -60 dBFS" in rep.reasons
    proposed = assess_proposed_cut(project, "host", 0.5, 1.5, timebase="source", config=_cfg())
    assert proposed.verdict == "pass"
    assert [h.name for h in proposed.detectors] == ["inaudible_splice"]
    sweep = assess_project_joins(project, track_id="host", config=_cfg())
    assert sweep["pass_count"] == 1 and sweep["fail_count"] == 0


def test_sweep_row_with_a_speech_crossing_is_never_a_pass(
    minimal_project: Path, sample_wav: Path
) -> None:
    """The continuity detectors score the splice's texture; a cut through the track's own
    voice at that join is a defect whatever they score, so the row reads review. The
    tiny fixture cuts 0.5 s out of a steady tone, which the crossing detector reads as a
    clipped onset and tail, while the splice itself scores pass."""
    from podcast_mcp.edits.join_continuity import assess_existing_join

    project = _tiny_project(minimal_project, sample_wav)
    cfg = _cfg()
    rep = assess_existing_join(project, "host", 0.5, timebase="timeline", config=cfg)
    assert rep.verdict == "pass"

    sweep = assess_project_joins(project, track_id="host", config=cfg)
    (row,) = sweep["joins"]
    assert [c["direction"] for c in row["speech"]] == ["clipped_tail", "clipped_onset"]
    assert row["verdict"] == "review"
    assert row["risk"] == rep.to_dict()["risk"]
    assert row["reasons"] == [
        *rep.reasons,
        "voiced speech cut through this join (see speech); never a pass",
    ]
    assert sweep["pass_count"] == 0 and sweep["review_count"] == 1
    assert sweep["speech_cross_count"] == 2


def test_project_join_sweep_shares_decode_and_baseline(
    minimal_project: Path, sample_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.edits import join_continuity as jc

    project = _tiny_project(minimal_project, sample_wav)
    project.clips.append(
        Clip(id="c3", track_id="host", source_start=1.6, source_end=1.9, timeline_start=1.0)
    )
    cfg = _cfg(calibrate=True, neural=False)
    individual = [
        jc.assess_existing_join(project, "host", t, config=cfg).to_dict() for t in (0.5, 1.0)
    ]
    counts = {"decode": 0, "baseline": 0}
    decode = jc._resolve_source_samples
    baseline = jc._natural_baseline_p95

    def counted_decode(*args, **kwargs):
        counts["decode"] += 1
        return decode(*args, **kwargs)

    def counted_baseline(*args, **kwargs):
        counts["baseline"] += 1
        return baseline(*args, **kwargs)

    monkeypatch.setattr(jc, "_resolve_source_samples", counted_decode)
    monkeypatch.setattr(jc, "_natural_baseline_p95", counted_baseline)
    sweep = jc.assess_project_joins(project, track_id="host", config=cfg)
    assert counts == {"decode": 1, "baseline": 1}
    for actual, expected in zip(sweep["joins"], individual, strict=True):
        skipped = ("source_gap_sec", "speech", "verdict", "reasons")
        assert {k: v for k, v in actual.items() if k not in skipped} == {
            k: v for k, v in expected.items() if k not in ("verdict", "reasons")
        }
        if actual["speech"] and expected["verdict"] == "pass":
            assert actual["verdict"] == "review"
            assert actual["reasons"][:-1] == expected["reasons"]
        else:
            assert actual["verdict"] == expected["verdict"]
            assert actual["reasons"] == expected["reasons"]


def test_project_join_sweep_keeps_one_bounded_wav_reader(
    minimal_project: Path, sample_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.edits import join_continuity as jc

    project = _tiny_project(minimal_project, sample_wav)
    project.clips.append(
        Clip(id="c3", track_id="host", source_start=1.6, source_end=1.9, timeline_start=1.0)
    )
    opened: list[str] = []
    real_open = wave.open

    def counted_open(path, mode):
        opened.append(str(path))
        return real_open(path, mode)

    monkeypatch.setattr(jc, "wave", SimpleNamespace(open=counted_open, Error=wave.Error))
    monkeypatch.setattr(
        jc,
        "_click_check_hires",
        lambda *_args: pytest.fail("the sweep must reuse its high-rate reader"),
    )
    sweep = jc.assess_project_joins(project, track_id="host", config=_cfg())
    assert sweep["join_count"] == 2
    assert len(opened) == 1


def test_project_join_sweep_batches_unsupported_container_windows(
    minimal_project: Path, sample_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.edits import join_continuity as jc
    from podcast_mcp.util.binaries import resolve_ffmpeg
    from podcast_mcp.util.process import run

    project = _tiny_project(minimal_project, sample_wav)
    project.clips.append(
        Clip(id="c3", track_id="host", source_start=1.6, source_end=1.9, timeline_start=1.0)
    )
    flac = project.workspace_path() / "raw" / "host.flac"
    run([resolve_ffmpeg(), "-y", "-v", "error", "-i", str(sample_wav), str(flac)], check=True)
    project.tracks[0].media.path = "raw/host.flac"
    cfg = _cfg()
    individual = [
        jc.assess_existing_join(project, "host", join_t, config=cfg).to_dict()
        for join_t in (0.5, 1.0)
    ]
    commands = []
    temporary_dirs = []
    temporary_directory = jc.tempfile.TemporaryDirectory

    @contextmanager
    def tracked_temporary_directory(*args, **kwargs):
        with temporary_directory(*args, **kwargs) as directory:
            temporary_dirs.append(Path(directory))
            yield directory

    def counted_run(*args, **kwargs):
        commands.append(args[0])
        return run(*args, **kwargs)

    monkeypatch.setattr(jc, "run", counted_run)
    monkeypatch.setattr(jc.tempfile, "TemporaryDirectory", tracked_temporary_directory)
    sweep = jc.assess_project_joins(project, track_id="host", config=cfg)
    assert len([cmd for cmd in commands if Path(cmd[0]).name == "ffmpeg"]) == 1
    assert len(temporary_dirs) == 1 and not temporary_dirs[0].exists()
    for actual, expected in zip(sweep["joins"], individual, strict=True):
        if actual["speech"] and expected["verdict"] == "pass":
            assert actual["verdict"] == "review"
        else:
            assert actual["verdict"] == expected["verdict"]
        assert actual["risk"] == pytest.approx(expected["risk"], abs=0.01)


def test_unsupported_click_windows_match_individual_flac(tmp_path: Path, sample_wav: Path) -> None:
    from podcast_mcp.edits import join_continuity as jc
    from podcast_mcp.util.binaries import resolve_ffmpeg
    from podcast_mcp.util.process import run

    flac = tmp_path / "source.flac"
    run([resolve_ffmpeg(), "-y", "-v", "error", "-i", str(sample_wav), str(flac)], check=True)
    joins = [(1.2, 1.2), (0.01, 0.01), (0.3, 0.8), (1.2, 1.2), (100.0, 100.0)]
    with jc._highrate_click_scorer(flac, source_joins=joins) as score:
        actual = [score(join) for join in joins]
    expected = [jc._score_single_highrate_window(flac, join, side_sec=0.02) for join in joins]
    for got, want in zip(actual, expected, strict=True):
        if want is None:
            assert got is None
        else:
            assert got == pytest.approx(want, rel=1e-5)


def test_click_batch_matches_ffmpeg_audio_stream_selection(tmp_path: Path) -> None:
    from podcast_mcp.edits import join_continuity as jc
    from podcast_mcp.util.binaries import resolve_ffmpeg
    from podcast_mcp.util.process import run

    first = tmp_path / "two_audio.mka"
    run(
        [
            resolve_ffmpeg(),
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=8000",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:sample_rate=48000",
            "-t",
            "1",
            "-map",
            "0:a",
            "-map",
            "1:a",
            "-c:a",
            "pcm_s16le",
            str(first),
        ],
        check=True,
    )
    second = tmp_path / "second_default.mka"
    run(
        [
            resolve_ffmpeg(),
            "-y",
            "-v",
            "error",
            "-i",
            str(first),
            "-map",
            "0:a",
            "-c",
            "copy",
            "-disposition:a:0",
            "0",
            "-disposition:a:1",
            "default",
            str(second),
        ],
        check=True,
    )
    assert jc._preferred_audio_stream(first) == 0
    assert jc._preferred_audio_stream(second) == 1
    for path in (first, second):
        join = (0.5, 0.5)
        with jc._highrate_click_scorer(path, source_joins=[join, (0.8, 0.8)]) as score:
            actual = score(join)
        expected = jc._score_single_highrate_window(path, join, side_sec=0.02)
        assert actual == pytest.approx(expected, rel=1e-5)


def test_click_batch_bounds_temporary_bytes_for_long_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.edits import join_continuity as jc

    path = tmp_path / "long.flac"
    path.write_bytes(b"fixture")
    joins = [(float(7200 + i), float(9000 + i)) for i in range(18)]
    sizes: list[int] = []
    commands: list[list[str]] = []
    directories: list[Path] = []
    temporary_directory = jc.tempfile.TemporaryDirectory

    @contextmanager
    def tracked_temporary_directory(*args, **kwargs):
        with temporary_directory(*args, **kwargs) as directory:
            directories.append(Path(directory))
            yield directory

    def fake_run(command, **_kwargs):
        commands.append(command)
        outputs = [Path(word) for word in command if str(word).endswith(".f32le")]
        for output in outputs:
            np.zeros(4800, dtype=np.float32).tofile(output)
        sizes.append(sum(output.stat().st_size for output in outputs))

    monkeypatch.setattr(jc, "_preferred_audio_stream", lambda _path: 0)
    monkeypatch.setattr(jc, "run", fake_run)
    monkeypatch.setattr(jc.tempfile, "TemporaryDirectory", tracked_temporary_directory)
    scores = jc._score_highrate_batches(path, joins, side_sec=0.02)
    assert list(scores) == joins
    assert len(commands) == 2
    # Two seeked side windows per join, so a batch of 16 joins holds 32 short outputs.
    assert sizes == [16 * 2 * 4800 * 4, 2 * 2 * 4800 * 4]
    assert all("-ss" in command and "-t" in command for command in commands)
    assert all(not directory.exists() for directory in directories)


def test_click_batch_failure_falls_back_per_join_and_cleans_up(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.edits import join_continuity as jc

    path = tmp_path / "source.flac"
    path.write_bytes(b"fixture")
    calls: list[float] = []
    directories: list[Path] = []
    temporary_directory = jc.tempfile.TemporaryDirectory

    @contextmanager
    def tracked_temporary_directory(*args, **kwargs):
        with temporary_directory(*args, **kwargs) as directory:
            directories.append(Path(directory))
            yield directory

    def fail_batch(*_args, **_kwargs):
        raise RuntimeError("one output failed")

    def fallback(_path, join, *, side_sec):
        calls.append(join)
        return join[1] if join != (2.0, 2.5) else None

    monkeypatch.setattr(jc, "_preferred_audio_stream", lambda _path: 0)
    monkeypatch.setattr(jc, "run", fail_batch)
    monkeypatch.setattr(jc, "_score_single_highrate_window", fallback)
    monkeypatch.setattr(jc.tempfile, "TemporaryDirectory", tracked_temporary_directory)
    joins = [(1.0, 1.0), (2.0, 2.5), (3.0, 3.0)]
    scores = jc._score_highrate_batches(path, joins, side_sec=0.02)
    assert scores == {(1.0, 1.0): 1.0, (2.0, 2.5): None, (3.0, 3.0): 3.0}
    assert calls == joins
    assert len(directories) == 1 and not directories[0].exists()


def test_assess_proposed_cut_rejects_inverted(minimal_project: Path) -> None:
    project = load_project(minimal_project)
    with pytest.raises(ValueError, match="cut_end"):
        assess_proposed_cut(project, "host", 1.0, 0.5, config=_cfg())

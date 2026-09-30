from __future__ import annotations

import os
import shutil

import numpy as np
import pytest

from podcast_mcp.engines import bleed_gate
from test_bleed_gate_regression import RATE, _episode, _read_pcm, _write_pcm


def test_owner_activity_analysis_bounds_each_rms_allocation(monkeypatch):
    shapes = []
    original = np.square

    def measured(values, *args, **kwargs):
        if values.ndim == 2:
            shapes.append(values.shape)
        return original(values, *args, **kwargs)

    monkeypatch.setattr(np, "square", measured)
    samples = np.ones(60 * bleed_gate.EVIDENCE_RATE, dtype=np.float32) * 0.01
    bleed_gate._owner_protection(samples, [(1, 2)])
    assert shapes
    assert max(rows for rows, _ in shapes) <= 1000


def test_repeated_audition_planning_reuses_evidence_until_media_changes(tmp_path, monkeypatch):
    project = _episode(tmp_path)
    reads = []
    original = bleed_gate.raw_timeline_samples

    def measured(*args, **kwargs):
        reads.append(args[1])
        return original(*args, **kwargs)

    monkeypatch.setattr(bleed_gate, "raw_timeline_samples", measured)
    first = bleed_gate.build_bleed_gate_plan(project, "host")
    count = len(reads)
    assert count > 0 and first.attenuation_spans
    assert bleed_gate.build_bleed_gate_plan(project, "host") == first
    assert len(reads) == count
    media = tmp_path / "raw" / "host.wav"
    stat = media.stat()
    os.utime(media, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
    assert bleed_gate.build_bleed_gate_plan(project, "host") == first
    assert len(reads) > count
    project.transcripts[0].words[1].audibility_locked = True
    assert bleed_gate.build_bleed_gate_plan(project, "host").attenuation_spans == ()


def test_unavailable_evidence_is_retried_without_changing_project_or_media(tmp_path, monkeypatch):
    project = _episode(tmp_path)
    original = bleed_gate.raw_timeline_window

    def unavailable(*args, **kwargs):
        raise OSError("temporary read failure")

    monkeypatch.setattr(bleed_gate, "raw_timeline_window", unavailable)
    failed = bleed_gate.build_bleed_gate_plan(project, "host")
    assert failed.attenuation_spans == ()
    assert "unavailable_full_band_evidence" in failed.reasons
    monkeypatch.setattr(bleed_gate, "raw_timeline_window", original)
    assert bleed_gate.build_bleed_gate_plan(project, "host").attenuation_spans


@pytest.mark.parametrize("replaced_track", ["host", "guest"])
def test_atomic_media_replacement_preserving_time_and_size_rechecks_owner_and_peer(
    tmp_path, replaced_track
):
    from podcast_mcp.engines.play_audit import track_render_hash
    from podcast_mcp.engines.transcript_gated_play import apply_track_transcript_gate

    project = _episode(tmp_path)
    first = bleed_gate.build_bleed_gate_plan(project, "host")
    assert first.attenuation_spans
    previous_hash = track_render_hash(project, "host")
    path = tmp_path / "raw" / f"{replaced_track}.wav"
    before = path.stat()
    samples = _read_pcm(path).astype(np.float64) / 32767
    lo, hi = round(2 * RATE), round(2.6 * RATE)
    if replaced_track == "host":
        clock = np.arange(hi - lo) / RATE
        samples[lo:hi] += 0.06 * np.sin(2 * np.pi * 11003 * clock)
    else:
        samples[lo:hi] = np.random.default_rng(497).normal(0, 0.15, hi - lo)
    replacement = path.with_name("replacement.wav")
    _write_pcm(replacement, samples)
    os.utime(replacement, ns=(before.st_atime_ns, before.st_mtime_ns))
    os.replace(replacement, path)
    after = path.stat()
    assert (after.st_size, after.st_mtime_ns) == (before.st_size, before.st_mtime_ns)
    assert after.st_ino != before.st_ino
    assert bleed_gate.build_bleed_gate_plan(project, "host").attenuation_spans == ()
    assert track_render_hash(project, "host") != previous_hash
    source = tmp_path / "raw" / "host.wav"
    output = tmp_path / "replacement-gated.wav"
    shutil.copyfile(source, output)
    apply_track_transcript_gate(project, "host", output, timeline_start=0, timeline_end=4)
    np.testing.assert_array_equal(_read_pcm(output), _read_pcm(source))


@pytest.mark.parametrize("state", ["fresh", "stale", "gated"])
def test_pregate_reconcile_reuses_only_fresh_ungated_stems(tmp_path, monkeypatch, state):
    from podcast_mcp.config import load_defaults
    from podcast_mcp.engines import timeline_render
    from podcast_mcp.engines.audio_audit import TrackRmsCache, build_track_rms_caches
    from podcast_mcp.engines.play_audit import write_stem_hash

    project = _episode(tmp_path)
    project.tracks = [project.track_by_id("guest")]
    project.clips = [clip for clip in project.clips if clip.track_id == "guest"]
    project.transcripts = [project.transcript_for_track("guest")]
    track = project.track_by_id("guest")
    stem = project.artifacts_dir() / "tracks" / "guest.wav"
    timeline_render.render_track_from_timeline(project, track, stem, load_defaults())
    write_stem_hash(project, "guest")
    baseline_rms = TrackRmsCache.from_timeline_stem(stem).rms_db(2.1, 2.5)
    assert baseline_rms is not None
    if state == "stale":
        source = tmp_path / "raw" / "guest.wav"
        _write_pcm(source, _read_pcm(source).astype(float) / 32767 * 10 ** (-12 / 20))
    elif state == "gated":
        track.transcript_gate = True
    renders = []
    original = timeline_render.render_track_from_timeline

    def measured(*args, **kwargs):
        renders.append(args[1].id)
        return original(*args, **kwargs)

    monkeypatch.setattr(timeline_render, "render_track_from_timeline", measured)
    caches = build_track_rms_caches(project, before_transcript_gate=True)
    assert set(caches.caches) == {"guest"}
    assert renders == ([] if state == "fresh" else ["guest"])
    measured_rms = caches.caches["guest"].rms_db(2.1, 2.5)
    assert measured_rms is not None
    assert measured_rms == pytest.approx(baseline_rms - (12 if state == "stale" else 0), abs=0.01)

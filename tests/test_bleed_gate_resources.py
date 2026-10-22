from __future__ import annotations

import os
import shutil

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import bleed_gate
from podcast_mcp.util import dsp
from test_bleed_gate_regression import RATE, _episode, _read_pcm, _write_pcm

pytestmark = pytest.mark.usefixtures("one_phrase_copy_evidence")


def test_owner_activity_analysis_bounds_each_rms_allocation(monkeypatch):
    allocation_bytes = []
    frame_counts = []
    original = np.square
    original_rms = dsp.frame_rms_db

    def measured(values, *args, **kwargs):
        result = original(values, *args, **kwargs)
        allocation_bytes.append(result.nbytes)
        return result

    def measured_rms(*args, **kwargs):
        result = original_rms(*args, **kwargs)
        frame_counts.append(result.size)
        return result

    monkeypatch.setattr(np, "square", measured)
    monkeypatch.setattr(dsp, "frame_rms_db", measured_rms)
    samples = np.ones(60 * bleed_gate.EVIDENCE_RATE, dtype=np.float32) * 0.01
    bleed_gate._owner_protection(samples, [(1, 2)], [])
    assert allocation_bytes
    assert frame_counts
    assert max(frame_counts) <= 1000
    owner_frame = round(bleed_gate._OWNER_FRAME_SEC * bleed_gate.EVIDENCE_RATE)
    assert max(allocation_bytes) <= 1000 * owner_frame * np.dtype(np.float64).itemsize


def test_repeated_audition_planning_reuses_evidence_until_media_changes(tmp_path, monkeypatch):
    project = _episode(tmp_path)
    reads = []
    original = bleed_gate.raw_timeline_samples

    def measured(*args, **kwargs):
        reads.append(args[1])
        return original(*args, **kwargs)

    monkeypatch.setattr(bleed_gate, "raw_timeline_samples", measured)
    first = bleed_gate.build_bleed_gate_plan(project, "host", defaults=load_defaults())
    count = len(reads)
    assert count > 0 and first.attenuation_spans
    assert bleed_gate.build_bleed_gate_plan(project, "host", defaults=load_defaults()) == first
    assert len(reads) == count
    media = tmp_path / "raw" / "host.wav"
    stat = media.stat()
    os.utime(media, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
    assert bleed_gate.build_bleed_gate_plan(project, "host", defaults=load_defaults()) == first
    assert len(reads) > count
    project.transcripts[0].words[1].suppressed = False
    assert (
        bleed_gate.build_bleed_gate_plan(
            project, "host", defaults=load_defaults()
        ).attenuation_spans
        == ()
    )


def test_unavailable_evidence_is_retried_without_changing_project_or_media(tmp_path, monkeypatch):
    project = _episode(tmp_path)
    original = bleed_gate.raw_timeline_samples

    def peer_unavailable(project, track_id, **kwargs):
        if track_id == "guest":
            raise OSError("temporary read failure")
        return original(project, track_id, **kwargs)

    monkeypatch.setattr(bleed_gate, "raw_timeline_samples", peer_unavailable)
    failed = bleed_gate.build_bleed_gate_plan(project, "host", defaults=load_defaults())
    assert failed.attenuation_spans == ()
    assert failed.reasons == ("unavailable_peer_source",)
    monkeypatch.setattr(bleed_gate, "raw_timeline_samples", original)
    assert bleed_gate.build_bleed_gate_plan(
        project, "host", defaults=load_defaults()
    ).attenuation_spans == ((1.7, 2.75),)


@pytest.mark.parametrize("replaced_track", ["host", "guest"])
def test_atomic_media_replacement_preserving_time_and_size_rechecks_owner_and_peer(
    tmp_path, replaced_track
):
    from podcast_mcp.engines.play_audit import track_render_hash
    from podcast_mcp.engines.transcript_gated_play import apply_track_transcript_gate

    project = _episode(tmp_path)
    first = bleed_gate.build_bleed_gate_plan(project, "host", defaults=load_defaults())
    assert first.attenuation_spans
    previous_hash = track_render_hash(project, "host", defaults=load_defaults())
    path = tmp_path / "raw" / f"{replaced_track}.wav"
    before = path.stat()
    samples = _read_pcm(path).astype(np.float64) / 32767
    lo, hi = round(2 * RATE), round(2.6 * RATE)
    samples[lo:hi] = 0.0
    replacement = path.with_name("replacement.wav")
    _write_pcm(replacement, samples)
    os.utime(replacement, ns=(before.st_atime_ns, before.st_mtime_ns))
    os.replace(replacement, path)
    after = path.stat()
    assert (after.st_size, after.st_mtime_ns) == (before.st_size, before.st_mtime_ns)
    assert after.st_ino != before.st_ino
    assert (
        bleed_gate.build_bleed_gate_plan(
            project, "host", defaults=load_defaults()
        ).attenuation_spans
        == ()
    )
    assert track_render_hash(project, "host", defaults=load_defaults()) != previous_hash
    source = tmp_path / "raw" / "host.wav"
    output = tmp_path / "replacement-gated.wav"
    shutil.copyfile(source, output)
    apply_track_transcript_gate(
        project, "host", output, timeline_start=0, timeline_end=4, defaults=load_defaults()
    )
    np.testing.assert_array_equal(_read_pcm(output), _read_pcm(source))


@pytest.mark.parametrize("state", ["fresh", "stale", "gated"])
def test_pregate_reconcile_reuses_only_fresh_ungated_stems(tmp_path, monkeypatch, state):
    from podcast_mcp.config.defaults import load_defaults
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
    write_stem_hash(project, "guest", defaults=load_defaults())
    baseline_rms = TrackRmsCache.from_timeline_stem(stem).rms_db(2.1, 2.5)
    assert baseline_rms is not None
    if state == "stale":
        source = tmp_path / "raw" / "guest.wav"
        _write_pcm(source, _read_pcm(source).astype(float) / 32767 * 10 ** (-12 / 20))
    elif state == "gated":
        track.transcript_gate = True
        timeline_render.render_track_from_timeline(project, track, stem, load_defaults())
        write_stem_hash(project, "guest", defaults=load_defaults())
    renders = []
    original = timeline_render.render_track_from_timeline

    def measured(*args, **kwargs):
        renders.append(args[1].id)
        return original(*args, **kwargs)

    monkeypatch.setattr(timeline_render, "render_track_from_timeline", measured)
    caches = build_track_rms_caches(project, before_transcript_gate=True, defaults=load_defaults())
    assert set(caches.caches) == {"guest"}
    assert renders == ([] if state == "fresh" else ["guest"])
    measured_rms = caches.caches["guest"].rms_db(2.1, 2.5)
    assert measured_rms is not None
    assert measured_rms == pytest.approx(baseline_rms - (12 if state == "stale" else 0), abs=0.01)


def test_source_clock_spans_match_mapping_each_span_through_each_clip():
    import numpy as np

    from podcast_mcp.engines.bleed_gate import _source_clock_spans
    from podcast_mcp.engines.session_timeline import clip_timeline_overlap_to_source
    from podcast_mcp.models import Clip
    from podcast_mcp.util.intervals import merge_intervals

    rng = np.random.default_rng(1620)
    clips = []
    at = 0.0
    source = 5.0
    for i in range(40):
        length = float(rng.uniform(0.2, 6.0))
        source += float(rng.uniform(0.0, 3.0))
        clips.append(
            Clip(
                id=f"c{i}",
                track_id="t",
                source_start=source,
                source_end=source + length,
                timeline_start=at,
            )
        )
        source += length
        at += length
    spans = []
    for _ in range(300):
        start = float(rng.uniform(-1.0, at + 1.0))
        spans.append((start, start + float(rng.choice([0.0, 1e-10, 0.02, 0.4, 3.0, 25.0]))))
    expected = merge_intervals(
        (float(mapped[0]), float(mapped[1]))
        for lo, hi in spans
        for clip in clips
        if (mapped := clip_timeline_overlap_to_source(clip, lo, hi)) is not None
    )
    assert _source_clock_spans(clips, spans) == expected
    assert expected

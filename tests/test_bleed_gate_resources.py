from __future__ import annotations

import os

import numpy as np

from podcast_mcp.engines import bleed_gate
from test_bleed_gate_regression import _episode


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

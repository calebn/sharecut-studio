from __future__ import annotations

import numpy as np
import pytest

from pause_policy_public_helpers import (
    RATE,
    add_bed,
    configure,
    defaults,
    pause,
    project,
    room,
    voice,
    write_wav,
)
from podcast_mcp.edits.breath_detect import PauseAir, pause_air_span
from podcast_mcp.edits.gate_fill import fill_gate_holes
from podcast_mcp.edits.source_removals import _apply_replace_gap_pad
from podcast_mcp.edits.tighten import propose_tighten_edits
from podcast_mcp.models import Clip, GateFillSource, Transcript, TranscriptWord


def _calibrated_project(tmp_path, *, topology="intact", guest=None):
    result = project(tmp_path, topology=topology, guest=guest)
    result.transcripts = []
    for index, track in enumerate(result.tracks):
        audio = room(seed=1220 + index)
        for start, end in ((0, 0.2), (5, 5.2), (5.4, 5.8)):
            voice(audio, start, end)
        write_wav(tmp_path / "raw" / f"{track.id}.wav", audio)
        result.transcripts.append(
            Transcript(
                track_id=track.id,
                words=[
                    TranscriptWord(text="before", start=0, end=0.2),
                    TranscriptWord(text="after", start=5, end=5.2),
                    TranscriptWord(text="reference", start=5.4, end=5.8),
                ],
            )
        )
    return result


@pytest.mark.parametrize("topology", ["intact", "split"])
def test_enabled_acoustics_preserves_original_suffix_across_a_real_split(
    tmp_path, monkeypatch, topology
):
    cfg = defaults(acoustic=True)
    configure(monkeypatch, cfg)
    result = _calibrated_project(tmp_path, topology=topology)

    proposal = propose_tighten_edits(result, cfg, intensity="medium")

    assert len(proposal.decisions) == 1
    decision = proposal.decisions[0]
    assert decision.end == pytest.approx(4.45)
    assert 0.2 <= decision.start <= 0.3
    assert decision.replace_gap_sec is None
    assert decision.scope == "session"
    assert [(w.text, w.start, w.end) for w in result.transcripts[0].words] == [
        ("before", 0, 0.2),
        ("after", 5, 5.2),
        ("reference", 5.4, 5.8),
    ]


@pytest.mark.parametrize("lane", ["host", "guest"])
@pytest.mark.parametrize("kind", ["word", "breath"])
def test_enabled_air_keeps_two_edge_sounds_whole_in_each_live_recording(
    tmp_path, monkeypatch, lane, kind
):
    cfg = defaults(acoustic=True)
    configure(monkeypatch, cfg)
    result = _calibrated_project(tmp_path, guest="quiet")
    audio = room(seed=1220)
    voice(audio, 0, 0.2)
    voice(audio, 5, 5.2)
    voice(audio, 5.4, 5.8)
    write_wav(tmp_path / "raw" / f"{lane}.wav", audio)
    quiet = pause_air_span(result, "host", 3, 4, defaults=cfg)
    assert isinstance(quiet, PauseAir)
    assert quiet.span == pytest.approx((3, 4))
    if kind == "word":
        voice(audio, 2.9, 3.15)
        voice(audio, 3.85, 4.1)
    else:
        rng = np.random.default_rng(1221)
        for lo, hi in ((2.9, 3.15), (3.85, 4.1)):
            start, end = round(lo * RATE), round(hi * RATE)
            audio[start:end] += rng.normal(0, 10 ** (-50 / 20), end - start)
    write_wav(tmp_path / "raw" / f"{lane}.wav", audio)

    protected = pause_air_span(result, "host", 3, 4, defaults=cfg)

    assert isinstance(protected, PauseAir)
    assert 3.15 <= protected.start <= 3.25
    assert 3.75 <= protected.end <= 3.85
    assert protected.end - protected.start == pytest.approx(0.64, abs=0.06)
    assert protected.silence_sec == pytest.approx(4.8)


def test_planned_pause_pad_stays_at_consumed_seam_despite_nearby_peer_join(tmp_path, monkeypatch):
    configure(monkeypatch, defaults())
    result = project(tmp_path, guest="quiet")
    add_bed(result, tmp_path)
    add_bed(result, tmp_path, "guest")
    result.clips = [
        Clip(id="host-right", track_id="host", source_start=4.7, source_end=6, timeline_start=0.2),
        Clip(id="peer-left", track_id="guest", source_start=0, source_end=0.18, timeline_start=0),
        Clip(
            id="peer-right", track_id="guest", source_start=2, source_end=3.3, timeline_start=0.18
        ),
    ]
    edit = pause()

    _apply_replace_gap_pad(result, edit, 0.2)

    for tid in ("host", "guest"):
        pads = [c for c in result.clips if c.source_id == f"room-tone-{tid}"]
        assert [(c.timeline_start, c.timeline_end) for c in pads] == [pytest.approx((0.2, 0.45))]
        assert [(c.fade_in_ms, c.fade_out_ms) for c in pads] == [(10, 10)]
    right = next(c for c in result.clips if c.id == "host-right")
    assert (right.source_start, right.timeline_start) == pytest.approx((4.7, 0.45))
    assert right.fade_in_ms > 0


def test_gate_fill_keeps_its_measured_gated_floor_and_registered_bed_workflow(
    tmp_path, monkeypatch
):
    configure(monkeypatch, defaults())
    result = project(tmp_path, guest="gated")
    add_bed(result, tmp_path, "guest")
    audio = np.zeros(6 * RATE)
    voice(audio, 0.5, 1)
    voice(audio, 3, 3.5)
    write_wav(tmp_path / "raw" / "guest.wav", audio)

    summary = fill_gate_holes(result, {"gate_fill": {"mode": "auto", "fade_ms": 10}})

    fill = result.track_by_id("guest").gate_fill
    assert fill is not None
    assert fill.source is GateFillSource.ROOM_TONE_BED
    assert fill.noise_db is None
    assert fill.filled_sec == pytest.approx(2, abs=0.01)
    assert (tmp_path / fill.path).is_file()
    assert "guest" in summary


def test_gate_fill_keeps_generated_comfort_noise_from_the_gated_live_floor(tmp_path, monkeypatch):
    configure(monkeypatch, defaults())
    result = project(tmp_path, guest="gated")
    floor = room(seconds=15.4, seed=1111, db=-66)
    audio = np.zeros(floor.size)
    phrases = (
        (0.6, 1.2),
        (2, 2.6),
        (3.4, 4.2),
        (5.2, 5.8),
        (6.6, 7.2),
        (8, 8.7),
        (9.6, 10.2),
        (11, 11.8),
        (12.6, 13.2),
        (14, 14.6),
    )
    for start, end in phrases:
        lo, hi = round((start - 0.03) * RATE), round((end + 0.15) * RATE)
        audio[lo:hi] = floor[lo:hi]
        voice(audio, start, end)
    path = tmp_path / "raw" / "guest.wav"
    write_wav(path, audio)
    result.track_by_id("guest").media.duration_sec = 15.4
    before_audio = path.read_bytes()

    summary = fill_gate_holes(result, {"gate_fill": {"mode": "auto", "fade_ms": 10}})

    fill = result.track_by_id("guest").gate_fill
    assert fill is not None
    assert fill.source is GateFillSource.COMFORT_NOISE
    assert fill.holes == 9
    assert fill.filled_sec == pytest.approx(5.88, abs=0.01)
    assert fill.noise_db == pytest.approx(-66, abs=4)
    assert (tmp_path / fill.path).is_file()
    assert path.read_bytes() == before_audio
    assert "guest" in summary

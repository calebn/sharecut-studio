"""Complete direct phrases may move locally; uncertain mixed audio stays untouched."""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines.timeline_render import render_track_from_timeline
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)

RATE = 48_000


def _write(path: Path, samples: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as out:
        out.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
        out.writeframes(np.round(samples * 32767).astype("<i2").tobytes())


def _read(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as source:
        return np.frombuffer(source.readframes(source.getnframes()), dtype="<i2")


def _episode(tmp_path: Path) -> EpisodeProject:
    p = EpisodeProject.create("retained copy", str(tmp_path))
    p.ensure_dirs()
    rng = np.random.default_rng(19)
    direct = np.zeros(6 * RATE)
    direct[int(1.2 * RATE) : int(3.2 * RATE)] = rng.normal(0, 0.08, 2 * RATE)
    direct[4 * RATE : int(4.4 * RATE)] = rng.normal(0, 0.07, int(0.4 * RATE))
    mixed = np.zeros_like(direct)
    mixed[: -int(0.15 * RATE)] = direct[int(0.15 * RATE) :] * 0.2
    lo, hi = int(1.05 * RATE), int(3.05 * RATE)
    mixed[lo:hi] += 0.003 * np.sin(2 * np.pi * 183 * np.arange(hi - lo) / RATE)
    for tid, samples in (("direct", direct), ("uncertain", mixed)):
        _write(tmp_path / "raw" / f"{tid}.wav", samples)
        p.tracks.append(
            Track(
                id=tid,
                label=tid,
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=6),
            )
        )
        p.clips.append(
            Clip(id=f"clip-{tid}", track_id=tid, source_start=0, source_end=6, timeline_start=0)
        )
    p.transcripts = [
        Transcript(
            track_id="direct",
            words=[
                TranscriptWord(text="whole", start=1.3, end=2.1),
                TranscriptWord(text="phrase", start=2.2, end=3.1),
                TranscriptWord(text="later", start=4.05, end=4.3),
            ],
        ),
        Transcript(
            track_id="uncertain",
            words=[
                TranscriptWord(
                    text="whole phrase",
                    start=1.15,
                    end=2.95,
                    suppressed=True,
                    audibility_status="bleed",
                    dominant_track="direct",
                )
            ],
        ),
    ]
    return p


def _api():
    from podcast_mcp.edits import retained_bleed_alignment

    return retained_bleed_alignment


def test_local_alignment_preserves_complete_main_phrase_and_uncertain_lane(tmp_path: Path) -> None:
    p = _episode(tmp_path)
    api = _api()
    before_clips = [clip.model_dump() for clip in p.clips if clip.track_id == "uncertain"]
    raw = _read(tmp_path / "raw" / "direct.wav")
    plan = api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    assert len(plan.proposals) == 1
    result = api.apply_retained_bleed_alignment(p, plan)
    assert result["applied_count"] == 1
    assert [clip.model_dump() for clip in p.clips if clip.track_id == "uncertain"] == before_clips
    output = tmp_path / "aligned.wav"
    render_track_from_timeline(p, p.track_by_id("direct"), output, {})
    aligned = _read(output)
    np.testing.assert_allclose(
        aligned[int(1.05 * RATE) : int(3.05 * RATE)], raw[int(1.2 * RATE) : int(3.2 * RATE)], atol=1
    )
    np.testing.assert_array_equal(aligned[: int(0.8 * RATE)], raw[: int(0.8 * RATE)])
    np.testing.assert_array_equal(aligned[int(3.5 * RATE) :], raw[int(3.5 * RATE) :])
    uncertain = tmp_path / "uncertain.wav"
    render_track_from_timeline(p, p.track_by_id("uncertain"), uncertain, {})
    np.testing.assert_array_equal(_read(uncertain), _read(tmp_path / "raw" / "uncertain.wav"))


def test_reopen_repeat_converges_without_resplitting_or_double_shift(tmp_path: Path) -> None:
    p = _episode(tmp_path)
    api = _api()
    api.apply_retained_bleed_alignment(
        p, api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    )
    reopened = EpisodeProject.model_validate(p.model_dump(by_alias=True))
    before = reopened.model_dump(by_alias=True)
    repeated = api.plan_retained_bleed_alignment(reopened, start_sec=0.8, end_sec=3.5)
    assert repeated.proposals == ()
    api.apply_retained_bleed_alignment(reopened, repeated)
    assert reopened.model_dump(by_alias=True) == before


@pytest.mark.parametrize("mode", ["manual", "declined"])
def test_saved_timing_choice_wins_until_explicit_reset(tmp_path: Path, mode: str) -> None:
    p = _episode(tmp_path)
    api = _api()
    result = api.apply_retained_bleed_alignment(
        p, api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    )
    decision_id = result["alignments"][0]["decision_id"]
    api.set_retained_bleed_alignment_mode(p, decision_id, mode)
    choice = next(d for d in p.editorial.retained_bleed_alignments if d.id == decision_id)
    assert choice.mode == mode
    plan = api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    assert plan.proposals == ()
    assert any(row["reason"] == f"saved_{mode}_decision" for row in plan.skipped)
    api.set_retained_bleed_alignment_mode(p, decision_id, "auto")
    assert choice.mode == "auto"


def test_no_quiet_slack_abstains_without_truncating_main_speaker(tmp_path: Path) -> None:
    p = _episode(tmp_path)
    source = tmp_path / "raw" / "direct.wav"
    samples = _read(source).astype(float) / 32767
    samples[: int(1.2 * RATE)] = np.random.default_rng(42).normal(0, 0.08, int(1.2 * RATE))
    _write(source, samples)
    api = _api()
    before = p.model_dump(by_alias=True)
    plan = api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    assert plan.proposals == ()
    assert any(row["reason"] == "unsafe_phrase_boundaries" for row in plan.skipped)
    assert p.model_dump(by_alias=True) == before


def test_delay_change_inside_phrase_requires_review_instead_of_warp(tmp_path: Path) -> None:
    p = _episode(tmp_path)
    mixed = _read(tmp_path / "raw" / "uncertain.wav").astype(float) / 32767
    direct = _read(tmp_path / "raw" / "direct.wav").astype(float) / 32767
    split = int(2.1 * RATE)
    stop = int(3.0 * RATE)
    mixed[split:stop] = direct[split + int(0.21 * RATE) : stop + int(0.21 * RATE)] * 0.2
    _write(tmp_path / "raw" / "uncertain.wav", mixed)
    plan = _api().plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    assert plan.proposals == ()
    assert any(row["reason"] == "inconsistent_local_delay" for row in plan.skipped)


def test_stale_plan_cannot_overwrite_a_user_clip_move(tmp_path: Path) -> None:
    p = _episode(tmp_path)
    api = _api()
    plan = api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    p.clips[0].timeline_start = 0.2
    before = p.model_dump(by_alias=True)
    with pytest.raises(ValueError, match="stale"):
        api.apply_retained_bleed_alignment(p, plan)
    assert p.model_dump(by_alias=True) == before

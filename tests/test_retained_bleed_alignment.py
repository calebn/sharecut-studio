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


def _episode(tmp_path: Path, owner_amplitude: float = 0.003) -> EpisodeProject:
    p = EpisodeProject.create("retained copy", str(tmp_path))
    p.ensure_dirs()
    rng = np.random.default_rng(19)
    direct = np.zeros(6 * RATE)
    direct[int(1.2 * RATE) : int(3.2 * RATE)] = rng.normal(0, 0.08, 2 * RATE)
    direct[4 * RATE : int(4.4 * RATE)] = rng.normal(0, 0.07, int(0.4 * RATE))
    mixed = np.zeros_like(direct)
    mixed[: -int(0.15 * RATE)] = direct[int(0.15 * RATE) :] * 0.2
    lo, hi = int(1.05 * RATE), int(3.05 * RATE)
    mixed[lo:hi] += owner_amplitude * np.sin(2 * np.pi * 183 * np.arange(hi - lo) / RATE)
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


def test_preview_can_be_declined_before_apply_and_survives_reopen(tmp_path: Path) -> None:
    p = _episode(tmp_path)
    api = _api()
    before_clips = [c.model_dump() for c in p.clips]
    proposal = api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5).proposals[0]
    api.set_retained_bleed_alignment_mode(p, proposal.decision_id, "declined", proposal=proposal)
    assert [c.model_dump() for c in p.clips] == before_clips
    reopened = EpisodeProject.model_validate(p.model_dump(by_alias=True))
    plan = api.plan_retained_bleed_alignment(reopened, start_sec=0.8, end_sec=3.5)
    assert plan.proposals == ()
    assert {"track_id": "direct", "reason": "saved_declined_decision"} in plan.skipped


def test_legacy_manual_placement_requires_scoped_override_with_provenance(tmp_path: Path) -> None:
    from podcast_mcp.models import SpeakerIngestAlignment

    p = _episode(tmp_path)
    p.meta.ingest_alignment = {"direct": SpeakerIngestAlignment(align_method="manual")}
    api = _api()
    held = api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    assert held.proposals == ()
    assert {"track_id": "direct", "reason": "manual_recorder_placement"} in held.skipped
    plan = api.plan_retained_bleed_alignment(
        p, start_sec=0.8, end_sec=3.5, override_placement_lock=True
    )
    assert len(plan.proposals) == 1
    api.apply_retained_bleed_alignment(p, plan)
    assert p.editorial.retained_bleed_alignments[0].provenance == "requested_scoped_override"


def test_stereo_antiphase_owner_cannot_be_mistaken_for_quiet_slack(tmp_path: Path) -> None:
    p = _episode(tmp_path)
    path = tmp_path / "raw" / "direct.wav"
    mono = _read(path)
    stereo = np.column_stack([mono, mono])
    before = int(1.2 * RATE)
    owner = np.round(np.random.default_rng(43).normal(0, 0.08, before) * 32767).astype("<i2")
    stereo[:before, 0] = owner
    stereo[:before, 1] = -owner
    with wave.open(str(path), "wb") as out:
        out.setparams((2, 2, RATE, 0, "NONE", "not compressed"))
        out.writeframes(stereo.astype("<i2").tobytes())
    plan = _api().plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    assert plan.proposals == ()
    assert {"track_id": "direct", "reason": "unsafe_phrase_boundaries"} in plan.skipped


@pytest.mark.parametrize("other_delay", [0.15, 0.21])
def test_all_retained_copy_peers_must_agree_before_direct_phrase_moves(
    tmp_path: Path, other_delay: float
) -> None:
    p = _episode(tmp_path)
    direct = _read(tmp_path / "raw" / "direct.wav").astype(float) / 32767
    copy = np.zeros_like(direct)
    count = int(other_delay * RATE)
    copy[:-count] = direct[count:] * 0.2
    _write(tmp_path / "raw" / "another.wav", copy)
    p.tracks.append(
        Track(
            id="another",
            label="another",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/another.wav", duration_sec=6),
        )
    )
    p.clips.append(
        Clip(id="clip-another", track_id="another", source_start=0, source_end=6, timeline_start=0)
    )
    p.transcripts.append(
        Transcript(
            track_id="another",
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
        )
    )
    plan = _api().plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5, track_id="uncertain")
    if other_delay == 0.15:
        assert len(plan.proposals) == 1
    else:
        assert plan.proposals == ()
        assert {"track_id": "direct", "reason": "conflicting_retained_bleed_delays"} in plan.skipped


@pytest.mark.parametrize("owner_amplitude", [0.025, 0.08])
def test_comparable_or_louder_overlapping_owner_stays_intact(
    tmp_path: Path, owner_amplitude: float
) -> None:
    p = _episode(tmp_path, owner_amplitude)
    api = _api()
    original_clips = [c.model_dump() for c in p.clips if c.track_id == "uncertain"]
    plan = api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    if owner_amplitude == 0.025:
        assert len(plan.proposals) == 1
    else:
        assert plan.proposals == ()
    api.apply_retained_bleed_alignment(p, plan)
    assert [c.model_dump() for c in p.clips if c.track_id == "uncertain"] == original_clips
    out = tmp_path / "uncertain-after.wav"
    render_track_from_timeline(p, p.track_by_id("uncertain"), out, {})
    np.testing.assert_array_equal(_read(out), _read(tmp_path / "raw" / "uncertain.wav"))


def test_existing_outer_clip_fades_are_not_copied_onto_moved_phrase(tmp_path: Path) -> None:
    p = _episode(tmp_path)
    p.clips[0].fade_in_ms = p.clips[0].fade_out_ms = 500
    api = _api()
    plan = api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    api.apply_retained_bleed_alignment(p, plan)
    output = tmp_path / "faded-outer.wav"
    render_track_from_timeline(p, p.track_by_id("direct"), output, {})
    np.testing.assert_allclose(
        _read(output)[int(1.05 * RATE) : int(3.05 * RATE)],
        _read(tmp_path / "raw" / "direct.wav")[int(1.2 * RATE) : int(3.2 * RATE)],
        atol=1,
    )


def test_comparable_broadband_overlapping_owner_can_align_without_touching_mixture(
    tmp_path: Path,
) -> None:
    p = _episode(tmp_path, owner_amplitude=0)
    path = tmp_path / "raw" / "uncertain.wav"
    mixed = _read(path).astype(float) / 32767
    lo, hi = int(1.05 * RATE), int(3.05 * RATE)
    owner = np.random.default_rng(17049).normal(0, 0.016, hi - lo)
    mixed[lo:hi] += owner
    _write(path, mixed)
    original = _read(path).copy()
    api = _api()
    plan = api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    assert len(plan.proposals) == 1
    assert plan.proposals[0].offset_sec == pytest.approx(-0.15, abs=0.002)
    api.apply_retained_bleed_alignment(p, plan)
    out = tmp_path / "broad-owner-after.wav"
    render_track_from_timeline(p, p.track_by_id("uncertain"), out, {})
    np.testing.assert_array_equal(_read(out), original)


def test_declining_direct_phrase_also_prevents_retiming_against_another_peer(
    tmp_path: Path,
) -> None:
    p = _episode(tmp_path)
    api = _api()
    proposal = api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5).proposals[0]
    api.set_retained_bleed_alignment_mode(p, proposal.decision_id, "declined", proposal=proposal)
    p.tracks.append(p.tracks[1].model_copy(update={"id": "another"}))
    p.clips.append(p.clips[1].model_copy(update={"id": "clip-another", "track_id": "another"}))
    p.transcripts.append(p.transcripts[1].model_copy(update={"track_id": "another"}))
    reopened = EpisodeProject.model_validate(p.model_dump(by_alias=True))
    plan = api.plan_retained_bleed_alignment(
        reopened, start_sec=0.8, end_sec=3.5, track_id="another"
    )
    assert plan.proposals == ()
    assert {"track_id": "direct", "reason": "saved_declined_decision"} in plan.skipped


def test_alignment_geometry_and_choice_restore_together_from_history_snapshot(
    tmp_path: Path,
) -> None:
    from podcast_mcp.models.project_format import apply_editable_snapshot, snapshot_editable_state

    p = _episode(tmp_path)
    api = _api()
    before = snapshot_editable_state(p)
    plan = api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    api.apply_retained_bleed_alignment(p, plan)
    api.set_retained_bleed_alignment_mode(p, plan.proposals[0].decision_id, "manual")
    after = snapshot_editable_state(p)
    apply_editable_snapshot(p, before)
    assert snapshot_editable_state(p) == before
    apply_editable_snapshot(p, after)
    assert snapshot_editable_state(p) == after
    assert p.editorial.retained_bleed_alignments[0].mode == "manual"


def test_short_fullband_burst_in_shift_slack_is_not_averaged_into_silence(tmp_path: Path) -> None:
    p = _episode(tmp_path)
    path = tmp_path / "raw" / "direct.wav"
    samples = _read(path).astype(float) / 32767
    samples[int(1.12 * RATE)] = 0.003
    _write(path, samples)
    plan = _api().plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    assert plan.proposals == ()
    assert {"track_id": "direct", "reason": "unsafe_phrase_boundaries"} in plan.skipped


def test_foreign_copy_fully_covered_by_safe_gate_does_not_retime_direct_phrase(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    p = _episode(tmp_path, owner_amplitude=0)
    direct = _read(tmp_path / "raw" / "direct.wav").astype(float) / 32767
    _write(tmp_path / "raw" / "uncertain.wav", direct * 0.2)
    word = p.transcripts[1].words[0]
    word.start, word.end = 1.2, 3.2
    api = _api()

    def unexpected(*args, **kwargs):
        raise AssertionError("hard-eliminable copy should never trigger local retiming")

    monkeypatch.setattr(api, "_local_delay", unexpected)
    plan = api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    assert plan.proposals == ()


@pytest.mark.parametrize("participant", ["direct", "uncertain", "another"])
def test_crossfade_clock_in_any_retained_participant_prevents_phrase_retiming(
    tmp_path: Path, participant: str
) -> None:
    from podcast_mcp.models import ClipJoinMode

    p = _episode(tmp_path)
    if participant == "another":
        p.tracks.append(p.tracks[1].model_copy(update={"id": "another"}))
        p.clips.append(p.clips[1].model_copy(update={"id": "clip-another", "track_id": "another"}))
        p.transcripts.append(p.transcripts[1].model_copy(update={"track_id": "another"}))
    clip = next(c for c in p.clips if c.track_id == participant)
    clip.join_in_mode, clip.fade_in_ms = ClipJoinMode.CROSSFADE, 10
    before = p.model_dump(by_alias=True)
    api = _api()
    plan = api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5, track_id="uncertain")
    assert plan.proposals == ()
    assert {"track_id": "direct", "reason": "unsupported_crossfade_evidence_clock"} in plan.skipped
    api.apply_retained_bleed_alignment(p, plan)
    assert p.model_dump(by_alias=True) == before


def test_only_interior_copy_probes_do_not_authorize_whole_phrase_move(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from dataclasses import replace

    p = _episode(tmp_path)
    api = _api()
    original = api.measure_long_delay_regions

    def interior_only(*args, **kwargs):
        rows = original(*args, **kwargs)
        assert len(rows) == 5
        assert sum(row.supported for row in rows[1:-1]) == 3
        return tuple(
            replace(row, reason="weak_copy") if index in (0, len(rows) - 1) else row
            for index, row in enumerate(rows)
        )

    monkeypatch.setattr(api, "measure_long_delay_regions", interior_only)
    plan = api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    assert plan.proposals == ()
    assert {"track_id": "direct", "reason": "insufficient_endpoint_evidence"} in plan.skipped


def test_local_phrase_move_does_not_create_stacked_same_media_qc_issue(tmp_path: Path) -> None:
    from podcast_mcp.engines.session_timeline import same_source_timeline_overlaps

    p = _episode(tmp_path)
    api = _api()
    api.apply_retained_bleed_alignment(
        p, api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    )
    assert same_source_timeline_overlaps(p) == []


@pytest.mark.parametrize("muted_track", ["direct", "uncertain"])
def test_saved_mix_mute_prevents_automatic_phrase_retiming(
    tmp_path: Path, muted_track: str
) -> None:
    p = _episode(tmp_path)
    p.track_by_id(muted_track).muted = True
    before = p.model_dump(by_alias=True)
    api = _api()
    plan = api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    assert plan.proposals == ()
    assert {"track_id": muted_track, "reason": "saved_mix_mute"} in plan.skipped
    api.apply_retained_bleed_alignment(p, plan)
    assert p.model_dump(by_alias=True) == before


def test_muted_conflicting_copy_peer_does_not_block_audible_pair_alignment(tmp_path: Path) -> None:
    p = _episode(tmp_path)
    p.tracks.append(p.tracks[1].model_copy(update={"id": "another", "muted": True}))
    p.clips.append(
        p.clips[1].model_copy(
            update={"id": "clip-another", "track_id": "another", "timeline_start": 0.06}
        )
    )
    p.transcripts.append(p.transcripts[1].model_copy(update={"track_id": "another"}))
    plan = _api().plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5, track_id="uncertain")
    assert len(plan.proposals) == 1


def test_quiet_destination_trim_cannot_remove_retained_word_source_coverage(tmp_path: Path) -> None:
    p = _episode(tmp_path)
    p.transcripts[0].words.insert(0, TranscriptWord(text="quiet label", start=1.07, end=1.1))
    before = p.model_dump(by_alias=True)
    api = _api()
    plan = api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    assert plan.proposals == ()
    assert {"track_id": "direct", "reason": "quiet_trim_would_remove_retained_word"} in plan.skipped
    assert p.model_dump(by_alias=True) == before


def test_verified_quiet_overlap_trim_has_source_scoped_provenance(tmp_path: Path) -> None:
    p = _episode(tmp_path)
    api = _api()
    api.apply_retained_bleed_alignment(
        p, api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    )
    trim = p.editorial.edit_log[-1].params["quiet_trim"]
    assert trim["reason"] == "verified_quiet_destination_overlap"
    assert trim["source_ranges"] == [
        {"source_id": None, "start_s": pytest.approx(1.03), "end_s": pytest.approx(1.18)}
    ]


def _two_phrase_episode(tmp_path: Path, *, competing: bool = False) -> EpisodeProject:
    p = _episode(tmp_path, owner_amplitude=0)
    direct = np.zeros(8 * RATE)
    mixed = np.zeros_like(direct)
    second_start = 3.85 if competing else 4.2
    phrases = ((1.2, 0.4 if competing else -0.15), (second_start, -0.4 if competing else -0.15))
    direct_words = []
    bleed_words = []
    rng = np.random.default_rng(9481)
    for index, (start, offset) in enumerate(phrases):
        voice = rng.normal(0, 0.08, 2 * RATE)
        source_start = round(start * RATE)
        target_start = round((start + offset) * RATE)
        direct[source_start : source_start + len(voice)] = voice
        mixed[target_start : target_start + len(voice)] += voice * 0.2
        mixed[target_start : target_start + len(voice)] += 0.003 * np.sin(
            2 * np.pi * 183 * np.arange(len(voice)) / RATE
        )
        direct_words.extend(
            [
                TranscriptWord(text=f"phrase{index} start", start=start + 0.1, end=start + 0.9),
                TranscriptWord(text=f"phrase{index} end", start=start + 1, end=start + 1.9),
            ]
        )
        bleed_words.append(
            TranscriptWord(
                text=f"retained phrase{index}",
                start=start + offset + 0.1,
                end=start + offset + 1.9,
                suppressed=True,
                audibility_status="bleed",
                dominant_track="direct",
            )
        )
    for tid, samples in (("direct", direct), ("uncertain", mixed)):
        _write(tmp_path / "raw" / f"{tid}.wav", samples)
        p.track_by_id(tid).media.duration_sec = 8
    for clip in p.clips:
        clip.source_end = 8
    p.transcripts[0].words = direct_words
    p.transcripts[1].words = bleed_words
    return p


def test_scoped_override_preserves_per_clip_manual_lock_on_other_phrase_after_reopen(
    tmp_path: Path,
) -> None:
    from podcast_mcp.models import SpeakerIngestAlignment
    from podcast_mcp.services import ProjectWorkspace

    p = _two_phrase_episode(tmp_path)
    p.meta.ingest_alignment = {"direct:clip-direct": SpeakerIngestAlignment(align_method="manual")}
    api = _api()
    later = api.plan_retained_bleed_alignment(p, start_sec=3.8, end_sec=6.5)
    assert later.proposals == ()
    assert {"track_id": "direct", "reason": "manual_recorder_placement"} in later.skipped
    first = api.plan_retained_bleed_alignment(
        p, start_sec=0.8, end_sec=3.5, override_placement_lock=True
    )
    assert len(first.proposals) == 1
    assert api.apply_retained_bleed_alignment(p, first)["applied_count"] == 1
    assert p.editorial.retained_bleed_alignments[0].provenance == "requested_scoped_override"
    ws = ProjectWorkspace(tmp_path / "episode.project.json", p)
    ws.save()
    reopened = ProjectWorkspace.open(ws.path).project
    snapshot = reopened.model_dump(by_alias=True)
    later = api.plan_retained_bleed_alignment(reopened, start_sec=3.8, end_sec=6.5)
    assert later.proposals == ()
    assert {"track_id": "direct", "reason": "manual_recorder_placement"} in later.skipped
    api.apply_retained_bleed_alignment(reopened, later)
    assert reopened.model_dump(by_alias=True) == snapshot


def test_competing_local_phrase_moves_abstain_before_unsafe_batch_publication(
    tmp_path: Path,
) -> None:
    p = _two_phrase_episode(tmp_path, competing=True)
    api = _api()
    before = p.model_dump(by_alias=True)
    plan = api.plan_retained_bleed_alignment(p, start_sec=0.7, end_sec=6.5)
    assert plan.proposals == ()
    assert {"track_id": "direct", "reason": "conflicting_phrase_corrections"} in plan.skipped
    assert api.apply_retained_bleed_alignment(p, plan)["applied_count"] == 0
    assert p.model_dump(by_alias=True) == before


def test_competing_local_moves_preserve_both_phrases_and_retained_word_source_coverage(
    tmp_path: Path,
) -> None:
    from podcast_mcp.engines.session_timeline import SessionTimeline
    from podcast_mcp.util.timebase import SourceSec

    p = _two_phrase_episode(tmp_path, competing=True)
    api = _api()
    mixed_before = [clip.model_dump() for clip in p.clips if clip.track_id == "uncertain"]
    plan = api.plan_retained_bleed_alignment(p, start_sec=0.7, end_sec=6.5)
    api.apply_retained_bleed_alignment(p, plan)
    timeline = SessionTimeline(p)
    for start, end in ((1.2, 3.2), (3.85, 5.85)):
        spans = timeline.map_source_span("direct", SourceSec(start), SourceSec(end))
        assert sum(float(hi - lo) for lo, hi in spans) == pytest.approx(end - start)
    for word in p.transcripts[0].words:
        spans = timeline.map_source_span("direct", SourceSec(word.start), SourceSec(word.end))
        assert sum(float(hi - lo) for lo, hi in spans) == pytest.approx(word.end - word.start)
    assert [clip.model_dump() for clip in p.clips if clip.track_id == "uncertain"] == mixed_before


def _remove_matching_direct_phrase(p: EpisodeProject, case: str) -> str:
    if case == "missing_transcript":
        p.transcripts = [
            transcript for transcript in p.transcripts if transcript.track_id != "direct"
        ]
    elif case == "suppressed_phrases":
        for word in p.transcripts[0].words:
            word.suppressed = True
    else:
        p.transcripts[0].words = p.transcripts[0].words[-1:]
    return (
        "unmatched_direct_retained_phrase"
        if case == "unmatched"
        else "missing_direct_retained_phrase"
    )


@pytest.mark.parametrize("case", ["missing_transcript", "suppressed_phrases", "unmatched"])
def test_retained_copy_without_matching_direct_phrase_is_explicitly_unresolved(
    tmp_path: Path, case: str
) -> None:
    p = _episode(tmp_path)
    reason = _remove_matching_direct_phrase(p, case)
    before = p.model_dump(by_alias=True)
    plan = _api().plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5, track_id="uncertain")
    assert plan.proposals == ()
    assert {"track_id": "direct", "reason": reason} in plan.skipped
    assert p.model_dump(by_alias=True) == before


@pytest.mark.parametrize("case", ["missing_transcript", "suppressed_phrases", "unmatched"])
def test_default_gate_preview_reports_unresolved_direct_phrase_without_mutation(
    tmp_path: Path, case: str
) -> None:
    from podcast_mcp.services import EditService, ProjectWorkspace

    p = _episode(tmp_path)
    reason = _remove_matching_direct_phrase(p, case)
    ws = ProjectWorkspace(tmp_path / "episode.project.json", p)
    ws.save()
    before = p.model_dump(by_alias=True)
    preview = EditService(ws).apply_bleed_mute(
        track_id="uncertain", start_sec=0.8, end_sec=3.5, apply=False
    )
    assert "alignment" in preview
    assert preview["alignment"]["proposed_count"] == 0
    assert {"track_id": "direct", "reason": reason} in preview["alignment"]["skipped"]
    assert p.model_dump(by_alias=True) == before

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


def test_default_gate_preview_accepts_supported_implicit_full_media_timeline(
    tmp_path: Path,
) -> None:
    from podcast_mcp.services import EditService, ProjectWorkspace

    p = _episode(tmp_path)
    p.clips = []
    ws = ProjectWorkspace(tmp_path / "episode.project.json", p)
    ws.save()
    before = p.model_dump(by_alias=True)
    preview = EditService(ws).apply_bleed_mute(track_id="uncertain", apply=False)
    assert preview["dry_run"] is True
    assert p.model_dump(by_alias=True) == before


def _select_secondary_source(p: EpisodeProject, tmp_path: Path) -> None:
    from podcast_mcp.models import SourceRecording

    samples = _read(tmp_path / "raw" / "direct.wav").astype(float) / 32767
    _write(tmp_path / "raw" / "secondary.wav", samples)
    _write(tmp_path / "raw" / "direct.wav", np.zeros_like(samples))
    p.sources.append(SourceRecording(id="secondary", path="raw/secondary.wav", duration_sec=6))
    next(clip for clip in p.clips if clip.track_id == "direct").source_id = "secondary"


def test_phrase_planning_uses_selected_secondary_recording_transcript(tmp_path: Path) -> None:
    p = _episode(tmp_path)
    _select_secondary_source(p, tmp_path)
    selected_words = p.transcripts[0].words[:2]
    p.transcripts[0].words = p.transcripts[0].words[-1:]
    p.transcripts.append(Transcript(track_id="direct", source_id="secondary", words=selected_words))
    before = p.model_dump(by_alias=True)
    plan = _api().plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    assert len(plan.proposals) == 1
    proposal = plan.proposals[0]
    assert proposal.source_id == "secondary"
    assert proposal.phrase_source_start == pytest.approx(1.2)
    assert proposal.phrase_source_end == pytest.approx(3.2)
    assert proposal.offset_sec == pytest.approx(-0.15, abs=0.002)
    assert p.model_dump(by_alias=True) == before


def test_quiet_trim_preserves_retained_words_from_selected_secondary_transcript(
    tmp_path: Path,
) -> None:
    p = _episode(tmp_path)
    _select_secondary_source(p, tmp_path)
    p.transcripts.append(
        Transcript(
            track_id="direct",
            source_id="secondary",
            words=[
                TranscriptWord(text="quiet retained word", start=1.07, end=1.1),
                *[word.model_copy() for word in p.transcripts[0].words],
            ],
        )
    )
    before = p.model_dump(by_alias=True)
    api = _api()
    plan = api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    assert plan.proposals == ()
    assert {"track_id": "direct", "reason": "quiet_trim_would_remove_retained_word"} in plan.skipped
    assert api.apply_retained_bleed_alignment(p, plan)["applied_count"] == 0
    assert p.model_dump(by_alias=True) == before


def test_unselected_primary_transcript_cannot_block_secondary_phrase_correction(
    tmp_path: Path,
) -> None:
    p = _episode(tmp_path)
    _select_secondary_source(p, tmp_path)
    p.transcripts.append(
        Transcript(
            track_id="direct",
            source_id="secondary",
            words=[word.model_copy() for word in p.transcripts[0].words],
        )
    )
    p.transcripts[0].words.insert(0, TranscriptWord(text="other recording", start=1.07, end=1.1))
    plan = _api().plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    assert len(plan.proposals) == 1
    assert plan.proposals[0].source_id == "secondary"


def test_independent_two_phrase_batch_applies_without_losing_either_source_span(
    tmp_path: Path,
) -> None:
    from podcast_mcp.engines.session_timeline import SessionTimeline, same_source_timeline_overlaps
    from podcast_mcp.util.timebase import SourceSec

    p = _two_phrase_episode(tmp_path)
    mixed_before = [clip.model_dump() for clip in p.clips if clip.track_id == "uncertain"]
    api = _api()
    plan = api.plan_retained_bleed_alignment(p)
    assert len(plan.proposals) == 2
    assert api.apply_retained_bleed_alignment(p, plan)["applied_count"] == 2
    timeline = SessionTimeline(p)
    for start, end in ((1.2, 3.2), (4.2, 6.2)):
        spans = timeline.map_selected_source_span("direct", None, SourceSec(start), SourceSec(end))
        assert sum(float(hi - lo) for lo, hi in spans) == pytest.approx(end - start)
    assert same_source_timeline_overlaps(p) == []
    assert [clip.model_dump() for clip in p.clips if clip.track_id == "uncertain"] == mixed_before


@pytest.mark.parametrize("signal", ["copy", "periodic", "unrelated"])
def test_scoped_delay_decodes_bounded_context_on_two_hour_source_with_null_controls(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, signal: str
) -> None:
    from podcast_mcp.engines import ungated_audio

    p = _episode(tmp_path)
    for clip in p.clips:
        clip.source_end = 7200
    for track in p.tracks:
        track.media.duration_sec = 7200
    rate = 8000
    origin = 984.0
    count = 40 * rate
    rng = np.random.default_rng(9354)
    direct = rng.normal(0, 0.001, count).astype(np.float32)
    mixed = rng.normal(0, 0.001, count).astype(np.float32)
    first, last = round((1000.2 - origin) * rate), round((1002.2 - origin) * rate)
    lag = round(0.15 * rate)
    direct[first:last] = rng.normal(0, 0.08, last - first)
    mixed[first - lag : last - lag] += direct[first:last] * 0.2
    if signal == "periodic":
        direct = (0.08 * np.sin(2 * np.pi * 173 * np.arange(count) / rate)).astype(np.float32)
        mixed[:-lag] = direct[lag:] * 0.2
    elif signal == "unrelated":
        mixed = rng.normal(0, 0.08, count).astype(np.float32)
    reads: list[tuple[float, float]] = []

    def bounded_decode(path, *, start_sec, duration_sec, sample_rate, **kwargs):
        assert sample_rate == rate
        reads.append((start_sec, duration_sec))
        assert duration_sec <= 32, "local evidence must not decode the two-hour recording"
        assert origin <= start_sec and start_sec + duration_sec <= origin + count / rate
        samples = direct if Path(path).stem == "direct" else mixed
        lo = round((start_sec - origin) * rate)
        return samples[lo : lo + round(duration_sec * rate)].copy()

    def full_decode(*args, **kwargs):
        raise AssertionError("scoped local evidence requested an unbounded source decode")

    monkeypatch.setattr(ungated_audio, "load_mono_window", bounded_decode)
    monkeypatch.setattr(ungated_audio, "load_mono_full", full_decode)
    result = _api()._local_delay(
        p,
        "direct",
        "uncertain",
        {},
        {},
        999.7,
        1002.7,
        phrase_start=1000.2,
        phrase_end=1002.2,
    )
    assert reads
    assert sum(duration for _, duration in reads) <= 64
    if signal == "copy":
        assert result.reason is None
        assert result.offset_sec == pytest.approx(-0.15, abs=0.002)
        assert result.validation_windows >= 3
    else:
        assert result.reason is not None


@pytest.mark.parametrize("operation", ["split", "punch"])
def test_ordinary_clip_replacement_preserves_per_clip_manual_recorder_lock(
    tmp_path: Path, operation: str
) -> None:
    from podcast_mcp.edits.clips_ops import punch_timeline_range_from_clips, set_track_clips
    from podcast_mcp.edits.timeline_ops import split_clip
    from podcast_mcp.models import SpeakerIngestAlignment

    p = _two_phrase_episode(tmp_path)
    p.meta.ingest_alignment = {"direct:clip-direct": SpeakerIngestAlignment(align_method="manual")}
    if operation == "split":
        split_clip(p, "direct", 3.5)
    else:
        lane = [clip for clip in p.clips if clip.track_id == "direct"]
        set_track_clips(p, "direct", punch_timeline_range_from_clips(lane, 3.4, 3.6))
    reopened = EpisodeProject.model_validate(p.model_dump(by_alias=True))
    plan = _api().plan_retained_bleed_alignment(reopened, start_sec=3.8, end_sec=6.5)
    assert plan.proposals == ()
    assert {"track_id": "direct", "reason": "manual_recorder_placement"} in plan.skipped


@pytest.mark.parametrize("phrases_per_source", [32, 40])
def test_phrase_index_scans_each_selected_source_once_and_stops_at_evidence_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, phrases_per_source: int
) -> None:
    from podcast_mcp.engines.bleed_gate import BleedGatePlan
    from podcast_mcp.engines.session_timeline import SessionTimeline
    from podcast_mcp.models import SourceRecording, SpeakerIngestAlignment

    p = _episode(tmp_path)
    direct_clip = p.clips[0]
    direct_clip.source_end = 80
    p.clips.append(
        Clip(
            id="clip-secondary",
            track_id="direct",
            source_id="secondary",
            source_start=0,
            source_end=80,
            timeline_start=80,
        )
    )
    p.clips[1].source_end = 160
    p.sources.append(SourceRecording(id="secondary", path="raw/direct.wav", duration_sec=80))
    p.transcripts[0].words = [
        TranscriptWord(text=f"first{i}", start=2 * i + 0.1, end=2 * i + 1.1)
        for i in range(phrases_per_source)
    ]
    p.transcripts.append(
        Transcript(
            track_id="direct",
            source_id="secondary",
            words=[
                TranscriptWord(text=f"second{i}", start=2 * i + 0.1, end=2 * i + 1.1)
                for i in range(phrases_per_source)
            ],
        )
    )
    p.transcripts[1].words = [
        TranscriptWord(
            text=f"candidate{i}",
            start=i / 10000,
            end=160,
            suppressed=True,
            audibility_status="bleed",
            dominant_track="direct",
        )
        for i in range(1000)
    ]
    p.meta.ingest_alignment = {"direct": SpeakerIngestAlignment(align_method="manual")}
    api = _api()
    scans = 0
    candidate_mappings = 0
    original_phrases = api._own_phrases
    original_mapping = SessionTimeline.map_source_span
    original_selected_mapping = SessionTimeline.map_selected_source_span

    def counted_phrases(*args, **kwargs):
        nonlocal scans
        scans += 1
        return original_phrases(*args, **kwargs)

    def counted_mapping(self, track_id, *args, **kwargs):
        nonlocal candidate_mappings
        if track_id == "uncertain":
            candidate_mappings += 1
        return original_mapping(self, track_id, *args, **kwargs)

    def counted_selected_mapping(self, track_id, *args, **kwargs):
        nonlocal candidate_mappings
        if track_id == "uncertain":
            candidate_mappings += 1
        return original_selected_mapping(self, track_id, *args, **kwargs)

    monkeypatch.setattr(api, "_own_phrases", counted_phrases)
    monkeypatch.setattr(api, "build_bleed_gate_plan", lambda *args, **kwargs: BleedGatePlan())
    monkeypatch.setattr(SessionTimeline, "map_source_span", counted_mapping)
    monkeypatch.setattr(SessionTimeline, "map_selected_source_span", counted_selected_mapping)
    plan = api.plan_retained_bleed_alignment(p)
    assert plan.proposals == ()
    assert {"track_id": "direct", "reason": "alignment_evidence_budget_exhausted"} in plan.skipped
    assert scans == 1, "a direct lane's selected-source phrase index must be built once"
    assert candidate_mappings <= 2, (
        "candidate traversal must stop when the 64-phrase budget is spent"
    )


def _reciprocal_episode(tmp_path: Path) -> EpisodeProject:
    p = _episode(tmp_path)
    rng = np.random.default_rng(2801)
    first, second = rng.normal(0, 0.08, (2, 2 * RATE))
    direct = np.zeros(6 * RATE)
    mixed = np.zeros_like(direct)
    direct[int(1.2 * RATE) : int(3.2 * RATE)] = first + second * 0.5
    mixed[int(1.05 * RATE) : int(3.05 * RATE)] = second + first * 0.5
    _write(tmp_path / "raw" / "direct.wav", direct)
    _write(tmp_path / "raw" / "uncertain.wav", mixed)
    for transcript, start, peer in (
        (p.transcripts[0], 1.3, "uncertain"),
        (p.transcripts[1], 1.15, "direct"),
    ):
        transcript.words = [
            TranscriptWord(text="own phrase", start=start, end=start + 1.8),
            TranscriptWord(
                text="retained peer phrase",
                start=start,
                end=start + 1.8,
                suppressed=True,
                audibility_status="bleed",
                dominant_track=peer,
            ),
        ]
    return p


def test_reciprocal_mixed_phrase_corrections_abstain_without_reversing_copy_lag(
    tmp_path: Path,
) -> None:
    p = _reciprocal_episode(tmp_path)
    api = _api()
    for bleed_lane in ("direct", "uncertain"):
        one = api.plan_retained_bleed_alignment(p, track_id=bleed_lane, start_sec=0.7, end_sec=3.7)
        assert len(one.proposals) == 1
        assert abs(one.proposals[0].offset_sec) == pytest.approx(0.15, abs=0.002)
    before = p.model_dump(by_alias=True)
    plan = api.plan_retained_bleed_alignment(p, start_sec=0.7, end_sec=3.7)
    assert plan.proposals == ()
    assert {row["reason"] for row in plan.skipped} >= {"conflicting_phrase_dependencies"}
    assert api.apply_retained_bleed_alignment(p, plan)["applied_count"] == 0
    assert p.model_dump(by_alias=True) == before


def test_batch_preserves_secondary_retained_peer_used_as_stationary_reference(
    tmp_path: Path,
) -> None:
    p = _reciprocal_episode(tmp_path)
    p.transcripts[0].words = p.transcripts[0].words[:1]
    secondary = _read(tmp_path / "raw" / "uncertain.wav").astype(float) / 32767
    target = np.zeros_like(secondary)
    lag = int(0.15 * RATE)
    target[lag:] = secondary[:-lag] * 0.5
    target[int(1.2 * RATE) : int(3.2 * RATE)] += np.random.default_rng(2802).normal(
        0, 0.008, 2 * RATE
    )
    for tid, samples in (("secondary", secondary), ("target", target)):
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
    p.transcripts.append(p.transcripts[1].model_copy(deep=True, update={"track_id": "secondary"}))
    p.transcripts.append(
        Transcript(
            track_id="target",
            words=[
                TranscriptWord(text="target owner", start=1.3, end=3.1),
                TranscriptWord(
                    text="retained secondary phrase",
                    start=1.3,
                    end=3.1,
                    suppressed=True,
                    audibility_status="bleed",
                    dominant_track="secondary",
                ),
            ],
        )
    )
    api = _api()
    for bleed_lane in ("uncertain", "target"):
        assert len(api.plan_retained_bleed_alignment(p, track_id=bleed_lane).proposals) == 1
    before = p.model_dump(by_alias=True)
    plan = api.plan_retained_bleed_alignment(p)
    assert plan.proposals == ()
    assert {row["reason"] for row in plan.skipped} >= {"conflicting_phrase_dependencies"}
    api.apply_retained_bleed_alignment(p, plan)
    assert p.model_dump(by_alias=True) == before


def test_unsupported_active_interior_probe_blocks_whole_phrase_correction(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    p = _episode(tmp_path)
    path = tmp_path / "raw" / "uncertain.wav"
    mixed = _read(path).astype(float) / 32767
    mixed[int(1.7 * RATE) : int(2.2 * RATE)] = np.random.default_rng(2803).normal(
        0, 0.08, int(0.5 * RATE)
    )
    _write(path, mixed)
    api = _api()
    measured = []
    original = api.measure_long_delay_regions

    def record_evidence(*args, **kwargs):
        rows = original(*args, **kwargs)
        measured.extend(rows)
        return rows

    monkeypatch.setattr(api, "measure_long_delay_regions", record_evidence)
    before = p.model_dump(by_alias=True)
    plan = api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    assert sum(row.supported for row in measured) >= 3
    assert any(not row.supported and row.start < 3.05 and row.end > 1.05 for row in measured)
    assert plan.proposals == ()
    assert {"track_id": "direct", "reason": "unsupported_phrase_interior"} in plan.skipped
    assert p.model_dump(by_alias=True) == before


def test_distinct_transcript_seeds_expand_to_one_complete_acoustic_correction(
    tmp_path: Path,
) -> None:
    p = _episode(tmp_path)
    direct = np.zeros(6 * RATE)
    first, last = int(1.48 * RATE), int(2.26 * RATE)
    direct[first:last] = np.random.default_rng(2804).normal(0, 0.08, last - first)
    shifted_null_context = np.random.default_rng(2805).normal(0, 0.08, RATE)
    direct[4 * RATE : 5 * RATE] = shifted_null_context
    mixed = np.zeros_like(direct)
    lag = int(0.15 * RATE)
    mixed[:-lag] = direct[lag:] * 0.2
    mixed[first - lag : last - lag] += 0.003 * np.sin(
        2 * np.pi * 183 * np.arange(last - first) / RATE
    )
    _write(tmp_path / "raw" / "direct.wav", direct)
    _write(tmp_path / "raw" / "uncertain.wav", mixed)
    p.transcripts[0].words = [
        TranscriptWord(text="first seed", start=1.5, end=1.7),
        TranscriptWord(text="second seed", start=2.05, end=2.25),
    ]
    p.transcripts[1].words[0].start, p.transcripts[1].words[0].end = 1.35, 2.1
    api = _api()
    plan = api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.0)
    assert len(plan.proposals) == 1
    assert api.apply_retained_bleed_alignment(p, plan)["applied_count"] == 1
    reopened = EpisodeProject.model_validate(p.model_dump(by_alias=True))
    assert api.plan_retained_bleed_alignment(reopened, start_sec=0.8, end_sec=3.0).proposals == ()


@pytest.mark.parametrize("legacy_choice", [False, True])
@pytest.mark.parametrize("absolute_source_path", [False, True])
def test_declined_primary_phrase_remains_protected_after_same_file_pin_and_reopen(
    tmp_path: Path, legacy_choice: bool, absolute_source_path: bool
) -> None:
    from podcast_mcp.edits.timeline_ops import move_clips
    from podcast_mcp.services import ProjectWorkspace

    p = _episode(tmp_path)
    api = _api()
    proposal = api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5).proposals[0]
    api.set_retained_bleed_alignment_mode(p, proposal.decision_id, "declined", proposal=proposal)
    media_key = p.editorial.retained_bleed_alignments[0].media_key
    assert media_key.startswith("sha256:")
    assert str(tmp_path) not in media_key
    assert "direct.wav" not in media_key
    if legacy_choice:
        saved = p.model_dump(by_alias=True)
        for decision in saved["editorial"]["retained_bleed_alignments"]:
            decision.pop("media_key", None)
        p = EpisodeProject.model_validate(saved)
    original = next(clip for clip in p.clips if clip.track_id == "direct")
    move_clips(p, [{"clip_id": original.id, "track_id": "uncertain", "timeline_start": 0}])
    move_clips(p, [{"clip_id": original.id, "track_id": "direct", "timeline_start": 0}])
    assert original.source_id is not None
    if absolute_source_path:
        p.source_by_id(original.source_id).path = str(tmp_path / "raw" / "direct.wav")
    ws = ProjectWorkspace(tmp_path / "episode.project.json", p)
    ws.save()
    reopened = ProjectWorkspace.open(ws.path).project
    before = reopened.model_dump(by_alias=True)
    plan = api.plan_retained_bleed_alignment(reopened, start_sec=0.8, end_sec=3.5)
    assert plan.proposals == ()
    assert {"track_id": "direct", "reason": "saved_declined_decision"} in plan.skipped
    assert reopened.model_dump(by_alias=True) == before


@pytest.mark.parametrize("mode", ["manual", "declined"])
def test_saved_choice_does_not_lock_a_different_selected_recording(
    tmp_path: Path, mode: str
) -> None:
    p = _episode(tmp_path)
    api = _api()
    proposal = api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5).proposals[0]
    api.set_retained_bleed_alignment_mode(p, proposal.decision_id, mode, proposal=proposal)
    samples = _read(tmp_path / "raw" / "direct.wav").astype(float) / 32767
    _write(tmp_path / "raw" / "replacement.wav", samples)
    p.track_by_id("direct").media.path = "raw/replacement.wav"
    plan = api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    assert len(plan.proposals) == 1
    assert {"track_id": "direct", "reason": f"saved_{mode}_decision"} not in plan.skipped


def test_untranscribed_secondary_recording_cannot_borrow_primary_phrase_authorization(
    tmp_path: Path,
) -> None:
    p = _episode(tmp_path)
    _select_secondary_source(p, tmp_path)
    before = p.model_dump(by_alias=True)
    api = _api()
    plan = api.plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    assert plan.proposals == ()
    assert {"track_id": "direct", "reason": "missing_direct_retained_phrase"} in plan.skipped
    assert api.apply_retained_bleed_alignment(p, plan)["applied_count"] == 0
    assert p.model_dump(by_alias=True) == before


def test_untranscribed_secondary_recording_cannot_authorize_quiet_destination_trim(
    tmp_path: Path,
) -> None:
    p = _episode(tmp_path)
    _select_secondary_source(p, tmp_path)
    before = p.model_dump(by_alias=True)
    assert _api()._retained_words_survive_trim(p, "direct", 1.05, 1.18) is False
    assert p.model_dump(by_alias=True) == before


@pytest.mark.parametrize("absolute_path", [False, True])
def test_primary_recording_explicit_alias_keeps_legacy_phrase_authorization(
    tmp_path: Path, absolute_path: bool
) -> None:
    from podcast_mcp.models import SourceRecording

    p = _episode(tmp_path)
    path = str(tmp_path / "raw" / "direct.wav") if absolute_path else "raw/direct.wav"
    p.sources.append(SourceRecording(id="primary-alias", path=path, duration_sec=6))
    next(clip for clip in p.clips if clip.track_id == "direct").source_id = "primary-alias"
    plan = _api().plan_retained_bleed_alignment(p, start_sec=0.8, end_sec=3.5)
    assert len(plan.proposals) == 1
    assert plan.proposals[0].source_id == "primary-alias"
    assert plan.proposals[0].offset_sec == pytest.approx(-0.15, abs=0.002)


@pytest.mark.parametrize("selection", ["secondary", "primary_alias", "absolute_primary_alias"])
def test_gate_cannot_project_primary_foreign_verdict_onto_untranscribed_recording(
    tmp_path: Path, selection: str
) -> None:
    from podcast_mcp.engines.bleed_gate import build_bleed_gate_plan
    from podcast_mcp.models import SourceRecording

    p = _episode(tmp_path)
    reference = _read(tmp_path / "raw" / "direct.wav").astype(float) / 32767
    _write(tmp_path / "raw" / "uncertain.wav", reference)
    if selection == "secondary":
        selected_path = "raw/secondary.wav"
    else:
        selected_path = "raw/direct.wav"
    _write(tmp_path / selected_path, reference * 0.12)
    path = str(tmp_path / selected_path) if selection == "absolute_primary_alias" else selected_path
    p.sources.append(SourceRecording(id="selected", path=path, duration_sec=6))
    next(clip for clip in p.clips if clip.track_id == "direct").source_id = "selected"
    p.transcripts[0].words = [
        TranscriptWord(
            text="foreign",
            start=1.3,
            end=3.1,
            suppressed=True,
            audibility_status="bleed",
            dominant_track="uncertain",
        )
    ]
    p.transcripts[1].words = [TranscriptWord(text="foreign", start=1.3, end=3.1)]
    before = p.model_dump(by_alias=True)
    plan = build_bleed_gate_plan(p, "direct")
    if selection == "secondary":
        assert plan.attenuation_spans == ()
    else:
        assert plan.attenuation_spans
    assert p.model_dump(by_alias=True) == before

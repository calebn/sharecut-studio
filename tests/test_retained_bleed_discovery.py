from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits import retained_bleed_alignment as api
from podcast_mcp.engines.timeline_render import render_track_from_timeline
from test_retained_bleed_alignment import RATE, _episode, _read, _write, gate_abstains


@pytest.fixture(autouse=True)
def _gate_leaves_the_uncertain_lane(monkeypatch: pytest.MonkeyPatch) -> None:
    gate_abstains(monkeypatch)


def _unseeded(tmp_path: Path):
    project = _episode(tmp_path)
    project.transcripts[1].words = []
    return project


def _plan(project, **kwargs):
    return api.plan_retained_bleed_alignment(
        project, track_id="uncertain", start_sec=0.8, end_sec=3.5, **kwargs
    )


def test_erased_copy_words_recovers_same_complete_plan_and_pcm(tmp_path: Path) -> None:
    project = _episode(tmp_path)
    seeded = _plan(project)
    project.transcripts[1].words = []
    before = project.model_dump(by_alias=True)
    plan = _plan(project)
    assert project.model_dump(by_alias=True) == before
    assert plan.proposals == seeded.proposals
    assert len(plan.proposals) == 1
    proposal = plan.proposals[0]
    assert proposal.offset_sec == pytest.approx(-0.15)
    assert (proposal.source_start, proposal.source_end) == pytest.approx((1.18, 3.22))
    assert api.apply_retained_bleed_alignment(project, plan)["applied_count"] == 1
    for track_id in ("direct", "uncertain"):
        output = tmp_path / f"{track_id}-rendered.wav"
        render_track_from_timeline(project, project.track_by_id(track_id), output, {})
        rendered = _read(output)
        raw = _read(tmp_path / "raw" / f"{track_id}.wav")
        if track_id == "uncertain":
            np.testing.assert_array_equal(rendered, raw)
        else:
            np.testing.assert_array_equal(rendered[: round(0.8 * RATE)], raw[: round(0.8 * RATE)])
            np.testing.assert_array_equal(rendered[round(3.5 * RATE) :], raw[round(3.5 * RATE) :])
            assert sum(
                c.source_end - c.source_start for c in project.clips if c.track_id == track_id
            ) == pytest.approx(5.85)
    from podcast_mcp.engines.session_timeline import SessionTimeline
    from podcast_mcp.util.timebase import SourceSec

    timeline = SessionTimeline(project)
    for word in project.transcripts[0].words:
        retained = timeline.map_selected_source_span(
            "direct", None, SourceSec(word.start), SourceSec(word.end)
        )
        assert sum(float(hi - lo) for lo, hi in retained) == pytest.approx(word.end - word.start)
    reopened = type(project).model_validate(project.model_dump(by_alias=True))
    before_repeat = reopened.model_dump(by_alias=True)
    repeated = _plan(reopened)
    assert repeated.proposals == ()
    assert api.apply_retained_bleed_alignment(reopened, repeated)["applied_count"] == 0
    assert reopened.model_dump(by_alias=True) == before_repeat


@pytest.mark.parametrize("missing", ["track_id", "start_sec", "end_sec"])
def test_discovery_requires_complete_explicit_scope(tmp_path: Path, missing: str) -> None:
    project = _unseeded(tmp_path)
    args = {"track_id": "uncertain", "start_sec": 0.8, "end_sec": 3.5}
    args.pop(missing)
    assert api.plan_retained_bleed_alignment(project, **args).proposals == ()


@pytest.mark.parametrize("bound", ["start_sec", "end_sec"])
@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf")])
def test_discovery_rejects_nonfinite_scope(tmp_path: Path, bound: str, value: float) -> None:
    project = _unseeded(tmp_path)
    args = {"track_id": "uncertain", "start_sec": 0.8, "end_sec": 3.5, bound: value}
    with pytest.raises(ValueError, match="finite"):
        api.plan_retained_bleed_alignment(project, **args)


@pytest.mark.parametrize("peer", ["agree", "conflict", "unrelated", "quiet"])
def test_untranscribed_third_peer_must_validate_or_be_measured_quiet(
    tmp_path: Path, peer: str
) -> None:
    from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole

    project = _unseeded(tmp_path)
    direct = _read(tmp_path / "raw" / "direct.wav").astype(float) / 32767
    samples = np.zeros_like(direct)
    if peer in {"agree", "conflict"}:
        count = round((0.15 if peer == "agree" else 0.21) * RATE)
        samples[:-count] = direct[count:] * 0.2
    elif peer == "unrelated":
        samples[round(1.0 * RATE) : round(3.3 * RATE)] = np.random.default_rng(41).normal(
            0, 0.05, round(2.3 * RATE)
        )
    _write(tmp_path / "raw" / "third.wav", samples)
    project.tracks.append(
        Track(
            id="third",
            label="third",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/third.wav", duration_sec=6),
        )
    )
    project.clips.append(
        Clip(id="third", track_id="third", source_start=0, source_end=6, timeline_start=0)
    )
    plan = _plan(project)
    if peer in {"agree", "quiet"}:
        assert len(plan.proposals) == 1
        assert ("third" in plan.proposals[0].reference_track_ids) is (peer == "agree")
    else:
        assert plan.proposals == ()
        reason = (
            "conflicting_retained_bleed_delays"
            if peer == "conflict"
            else "unverified_retained_bleed_peer"
        )
        assert {"track_id": "direct", "reason": reason} in plan.skipped


@pytest.mark.parametrize("case", ["unrelated", "periodic", "weak", "endpoint", "interior"])
def test_unseeded_unsupported_complete_copy_abstains(tmp_path: Path, case: str) -> None:
    project = _unseeded(tmp_path)
    direct = _read(tmp_path / "raw" / "direct.wav").astype(float) / 32767
    mixed = _read(tmp_path / "raw" / "uncertain.wav").astype(float) / 32767
    rng = np.random.default_rng(76)
    if case == "unrelated":
        mixed = rng.normal(0, 0.02, direct.size)
    elif case == "periodic":
        direct = 0.08 * np.sin(2 * np.pi * 173 * np.arange(direct.size) / RATE)
        direct[: round(1.2 * RATE)] = direct[round(3.2 * RATE) :] = 0
        mixed[:] = 0
        mixed[: -round(0.15 * RATE)] = direct[round(0.15 * RATE) :] * 0.2
        _write(tmp_path / "raw" / "direct.wav", direct)
    elif case == "weak":
        mixed = mixed * 0.0001 + rng.normal(0, 0.01, mixed.size)
    elif case == "endpoint":
        mixed[round(2.7 * RATE) : round(3.1 * RATE)] = rng.normal(0, 0.02, round(0.4 * RATE))
    else:
        mixed[round(1.8 * RATE) : round(2.4 * RATE)] = rng.normal(0, 0.02, round(0.6 * RATE))
    _write(tmp_path / "raw" / "uncertain.wav", mixed)
    before = project.model_dump(by_alias=True)
    plan = _plan(project)
    assert plan.proposals == ()
    assert plan.skipped
    assert all(row["reason"] != "no_retained_bleed_candidate" for row in plan.skipped)
    assert project.model_dump(by_alias=True) == before


@pytest.mark.parametrize("hold", ["manual", "declined", "recorder"])
def test_unseeded_discovery_preserves_saved_holds(tmp_path: Path, hold: str) -> None:
    from podcast_mcp.models import SpeakerIngestAlignment

    project = _unseeded(tmp_path)
    if hold == "recorder":
        project.meta.ingest_alignment = {"direct": SpeakerIngestAlignment(align_method="manual")}
        reason = "manual_recorder_placement"
        override = False
    else:
        proposal = _plan(project).proposals[0]
        api.set_retained_bleed_alignment_mode(
            project, proposal.decision_id, hold, proposal=proposal
        )
        reason = f"saved_{hold}_decision"
        override = True
    reopened = type(project).model_validate(project.model_dump(by_alias=True))
    before = reopened.model_dump(by_alias=True)
    plan = _plan(reopened, override_placement_lock=override)
    assert plan.proposals == ()
    assert {"track_id": "direct", "reason": reason} in plan.skipped
    assert reopened.model_dump(by_alias=True) == before


@pytest.mark.parametrize(
    "case", ["secondary", "alias", "missing_transcript", "overlapping_unknown"]
)
def test_discovery_uses_matching_selected_direct_recording(tmp_path: Path, case: str) -> None:
    from podcast_mcp.models import Clip, SourceRecording, Transcript
    from test_retained_bleed_alignment import _select_secondary_source

    project = _unseeded(tmp_path)
    if case == "alias":
        project.sources.append(SourceRecording(id="alias", path="raw/direct.wav", duration_sec=6))
        project.clips[0].source_id = "alias"
    else:
        selected_words = list(project.transcripts[0].words)
        _select_secondary_source(project, tmp_path)
        project.transcripts.append(
            Transcript(track_id="direct", source_id="secondary", words=selected_words)
        )
        if case == "missing_transcript":
            project.transcripts = [t for t in project.transcripts if t.source_id != "secondary"]
        elif case == "overlapping_unknown":
            project.sources.append(
                SourceRecording(id="unknown", path="raw/direct.wav", duration_sec=6)
            )
            project.clips.append(
                Clip(
                    id="unknown",
                    track_id="direct",
                    source_id="unknown",
                    source_start=0,
                    source_end=6,
                    timeline_start=0,
                )
            )
    plan = _plan(project)
    if case in {"secondary", "alias"}:
        assert len(plan.proposals) == 1
        assert plan.proposals[0].source_id == ("secondary" if case == "secondary" else "alias")
    else:
        assert plan.proposals == ()
        assert plan.skipped


@pytest.mark.parametrize("participant", ["direct", "uncertain"])
def test_scoped_discovery_never_builds_cold_whole_recording_gate(
    tmp_path: Path, monkeypatch, participant: str
) -> None:
    from podcast_mcp.engines import ungated_audio

    project = _episode(tmp_path)
    calls = []
    original = api.raw_timeline_window

    def measured(project, track_id, start, end, **kwargs):
        calls.append((track_id, start, end))
        assert end - start <= 60
        return original(project, track_id, start, end, **kwargs)

    def forbidden(*args, **kwargs):
        raise AssertionError("bounded discovery cannot decode full source or build a gate plan")

    monkeypatch.setattr(api, "raw_timeline_window", measured)
    monkeypatch.setattr(api, "build_bleed_gate_plan", forbidden)
    monkeypatch.setattr(ungated_audio, "load_mono_full", forbidden)
    plan = _plan(project)
    assert len(plan.proposals) == 1
    assert calls
    assert any(row[0] == participant for row in calls)


@pytest.mark.parametrize("limit", [1, 2, 3, 4])
def test_global_budget_cannot_emit_partially_checked_candidate(
    tmp_path: Path, monkeypatch, limit: int
) -> None:
    project = _unseeded(tmp_path)
    monkeypatch.setattr(api, "_MAX_PHRASES", limit)
    plan = _plan(project)
    if limit < 4:
        assert plan.proposals == ()
        assert {
            "track_id": "direct",
            "reason": "alignment_evidence_budget_exhausted",
        } in plan.skipped
    else:
        assert len(plan.proposals) == 1


def test_completed_acoustic_envelope_cannot_exceed_phrase_bound(
    tmp_path: Path, monkeypatch
) -> None:
    from podcast_mcp.models import TranscriptWord

    project = _unseeded(tmp_path)
    direct = np.zeros(40 * RATE)
    direct[RATE : round(31.2 * RATE)] = np.random.default_rng(57).normal(
        0, 0.08, round(30.2 * RATE)
    )
    for track in project.tracks:
        track.media.duration_sec = 40
    for clip in project.clips:
        clip.source_end = 40
    project.transcripts[0].words = [TranscriptWord(text="complete", start=1.3, end=31.0)]
    _write(tmp_path / "raw" / "direct.wav", direct)
    _write(tmp_path / "raw" / "uncertain.wav", direct * 0.2)

    def forbidden(*args, **kwargs):
        raise AssertionError("completed envelopes over 30 seconds cannot reach measurement")

    monkeypatch.setattr(api, "_local_delay", forbidden)
    plan = api.plan_retained_bleed_alignment(
        project, track_id="uncertain", start_sec=0.5, end_sec=33.0
    )
    assert plan.proposals == ()
    assert {"track_id": "direct", "reason": "unsafe_phrase_boundaries"} in plan.skipped


def test_unseeded_insufficient_null_context_is_not_supported(tmp_path: Path, monkeypatch) -> None:
    from podcast_mcp.models import TranscriptWord

    project = _unseeded(tmp_path)
    direct = np.zeros(round(1.8 * RATE))
    direct[round(0.7 * RATE) : round(1.4 * RATE)] = np.random.default_rng(32).normal(
        0, 0.08, round(0.7 * RATE)
    )
    mixed = np.zeros_like(direct)
    mixed[: -round(0.15 * RATE)] = direct[round(0.15 * RATE) :] * 0.2
    _write(tmp_path / "raw" / "direct.wav", direct)
    _write(tmp_path / "raw" / "uncertain.wav", mixed)
    for track in project.tracks:
        track.media.duration_sec = 1.8
    for clip in project.clips:
        clip.source_end = 1.8
    project.transcripts[0].words = [TranscriptWord(text="short", start=0.8, end=1.3)]
    rows = []
    original = api.measure_long_delay_regions

    def measured(*args, **kwargs):
        result = original(*args, **kwargs)
        rows.extend(result)
        return result

    monkeypatch.setattr(api, "measure_long_delay_regions", measured)
    plan = api.plan_retained_bleed_alignment(
        project, track_id="uncertain", start_sec=0.01, end_sec=1.8
    )
    assert plan.proposals == ()
    assert any(row.reason == "insufficient_null_context" for row in rows)
    assert all(not row.owner_absence_proven for row in rows)


@pytest.mark.parametrize("peer_case", ["quiet", "unreadable", "crossfade", "muted"])
def test_unknown_peer_scope_and_budget_fail_closed(
    tmp_path: Path, monkeypatch, peer_case: str
) -> None:
    from podcast_mcp.models import ClipJoinMode, MediaAsset

    project = _unseeded(tmp_path)
    peer = project.tracks[1].model_copy(
        update={
            "id": "third",
            "label": "third",
            "media": MediaAsset(path="raw/third.wav", duration_sec=6),
        }
    )
    placement = project.clips[1].model_copy(update={"id": "third", "track_id": "third"})
    project.tracks.append(peer)
    project.clips.append(placement)
    _write(tmp_path / "raw" / "third.wav", np.zeros(6 * RATE))
    if peer_case == "unreadable":
        (tmp_path / "raw" / "third.wav").unlink()
    elif peer_case == "crossfade":
        placement.join_in_mode = ClipJoinMode.CROSSFADE
        placement.fade_in_ms = 20
    elif peer_case == "muted":
        peer.muted = True
    else:
        monkeypatch.setattr(api, "_MAX_PHRASES", 4)
        quiet_reads = []
        original = api._quiet

        def quiet(*args, **kwargs):
            quiet_reads.append(args[1])
            return original(*args, **kwargs)

        monkeypatch.setattr(api, "_quiet", quiet)
    plan = _plan(project)
    if peer_case == "muted":
        assert len(plan.proposals) == 1
        assert "third" not in plan.proposals[0].reference_track_ids
    else:
        assert plan.proposals == ()
        if peer_case == "quiet":
            assert {
                "track_id": "direct",
                "reason": "alignment_evidence_budget_exhausted",
            } in plan.skipped
            assert quiet_reads == []


def test_scoped_discovery_does_not_decode_two_hour_recordings(tmp_path: Path, monkeypatch) -> None:
    from podcast_mcp.engines import ungated_audio

    project = _unseeded(tmp_path)
    direct_pcm = _read(tmp_path / "raw" / "direct.wav").astype(np.float32) / 32767
    mixed_pcm = _read(tmp_path / "raw" / "uncertain.wav").astype(np.float32) / 32767
    for track in project.tracks:
        track.media.duration_sec = 7200
    for clip in project.clips:
        clip.source_end = 7200
    reads = []

    def bounded(path, *, start_sec, duration_sec, sample_rate, **kwargs):
        reads.append((start_sec, duration_sec, sample_rate))
        assert duration_sec <= 60
        source = direct_pcm if Path(path).stem == "direct" else mixed_pcm
        times = start_sec + np.arange(round(duration_sec * sample_rate)) / sample_rate
        positions = np.rint(times * RATE).astype(int)
        result = np.zeros(positions.size, dtype=np.float32)
        valid = positions < source.size
        result[valid] = source[positions[valid]]
        return result.reshape(-1, 1) if kwargs.get("preserve_channels") else result

    def forbidden(*args, **kwargs):
        raise AssertionError("new scoped discovery attempted a whole-file decode")

    monkeypatch.setattr(ungated_audio, "load_mono_window", bounded)
    monkeypatch.setattr(ungated_audio, "load_wav_channels_window", bounded)
    monkeypatch.setattr(ungated_audio, "load_mono_full", forbidden)
    monkeypatch.setattr(api, "build_bleed_gate_plan", forbidden)
    plan = _plan(project)
    assert len(plan.proposals) == 1
    assert reads
    assert max(duration for _, duration, _ in reads) < 33


@pytest.mark.parametrize("copy_transcript", ["empty", "absent", "secondary"])
def test_discovery_does_not_require_selected_copy_transcript(
    tmp_path: Path, copy_transcript: str
) -> None:
    from podcast_mcp.models import SourceRecording

    project = _unseeded(tmp_path)
    if copy_transcript != "empty":
        project.transcripts = project.transcripts[:1]
    if copy_transcript == "secondary":
        source = tmp_path / "raw" / "selected-copy.wav"
        source.write_bytes((tmp_path / "raw" / "uncertain.wav").read_bytes())
        project.sources.append(
            SourceRecording(id="copy-secondary", path="raw/selected-copy.wav", duration_sec=6)
        )
        project.clips[1].source_id = "copy-secondary"
        _write(tmp_path / "raw" / "uncertain.wav", np.zeros(6 * RATE))
    assert len(_plan(project).proposals) == 1


@pytest.mark.parametrize("window", [(1.1, 3.5), (0.8, 3.21)])
def test_acoustic_correction_and_internal_fades_stay_inside_scope(tmp_path: Path, window) -> None:
    project = _unseeded(tmp_path)
    before = project.model_dump(by_alias=True)
    plan = api.plan_retained_bleed_alignment(
        project, track_id="uncertain", start_sec=window[0], end_sec=window[1]
    )
    assert plan.proposals == ()
    assert plan.skipped
    assert api.apply_retained_bleed_alignment(project, plan)["applied_count"] == 0
    assert project.model_dump(by_alias=True) == before


def test_discovered_phrase_cannot_trim_any_retained_word(tmp_path: Path) -> None:
    from podcast_mcp.models import TranscriptWord

    project = _unseeded(tmp_path)
    project.transcripts[0].words.insert(0, TranscriptWord(text="keep", start=1.08, end=1.1))
    plan = _plan(project)
    assert plan.proposals == ()
    assert {"track_id": "direct", "reason": "quiet_trim_would_remove_retained_word"} in plan.skipped


@pytest.mark.parametrize("owner_amplitude", [0.025, 0.08])
def test_unseeded_loud_owner_never_moves_or_changes_mixed_lane(
    tmp_path: Path, owner_amplitude: float
) -> None:
    project = _episode(tmp_path, owner_amplitude=owner_amplitude)
    project.transcripts[1].words = []
    clips = [clip.model_dump() for clip in project.clips if clip.track_id == "uncertain"]
    plan = _plan(project)
    api.apply_retained_bleed_alignment(project, plan)
    assert [clip.model_dump() for clip in project.clips if clip.track_id == "uncertain"] == clips
    output = tmp_path / "mixed-after.wav"
    render_track_from_timeline(project, project.track_by_id("uncertain"), output, {})
    np.testing.assert_array_equal(_read(output), _read(tmp_path / "raw" / "uncertain.wav"))


def test_rejected_complete_geometry_is_not_measured_twice(tmp_path: Path, monkeypatch) -> None:
    from podcast_mcp.models import TranscriptWord

    project = _unseeded(tmp_path)
    direct = np.zeros(6 * RATE)
    direct[round(1.48 * RATE) : round(2.26 * RATE)] = np.random.default_rng(2804).normal(
        0, 0.08, round(0.78 * RATE)
    )
    _write(tmp_path / "raw" / "direct.wav", direct)
    _write(tmp_path / "raw" / "uncertain.wav", np.zeros_like(direct))
    project.transcripts[0].words = [
        TranscriptWord(text="first", start=1.5, end=1.7),
        TranscriptWord(text="second", start=2.05, end=2.25),
    ]
    measured = []
    original = api._local_delay

    def measure(*args, **kwargs):
        measured.append((kwargs["phrase_start"], kwargs["phrase_end"]))
        return original(*args, **kwargs)

    monkeypatch.setattr(api, "_local_delay", measure)
    assert _plan(project).proposals == ()
    assert measured == [(1.48, 2.26)]


@pytest.mark.parametrize("origin", ["transcript", "acoustic"])
@pytest.mark.parametrize("foreign", ["locked_bleed", "bleed", "dominant", "speaker_match"])
def test_explicit_foreign_retention_cannot_authorize_owner_move(
    tmp_path: Path, origin: str, foreign: str
) -> None:
    project = _episode(tmp_path)
    if origin == "acoustic":
        project.transcripts[1].words = []
    for word in project.transcripts[0].words:
        if foreign in {"locked_bleed", "bleed"}:
            word.audibility_status = "bleed"
        if foreign in {"locked_bleed", "dominant"}:
            word.dominant_track = "uncertain"
        if foreign == "speaker_match":
            word.speaker_match_track = "uncertain"
            word.dominant_track = "direct"
            word.audibility_status = "audible"
        word.audibility_locked = foreign == "locked_bleed"
        word.suppressed = False
    samples = _read(tmp_path / "raw" / "direct.wav").astype(float) / 32767
    lo, hi = round(1.2 * RATE), round(3.2 * RATE)
    samples[lo:hi] += 0.012 * np.sin(2 * np.pi * 237 * np.arange(hi - lo) / RATE)
    _write(tmp_path / "raw" / "direct.wav", samples)
    before = project.model_dump(by_alias=True)
    plan = (
        _plan(project)
        if origin == "acoustic"
        else api.plan_retained_bleed_alignment(project, track_id="uncertain")
    )
    assert plan.proposals == ()
    assert api.apply_retained_bleed_alignment(project, plan)["applied_count"] == 0
    assert project.model_dump(by_alias=True) == before
    assert all(not word.suppressed for word in project.transcripts[0].words)


@pytest.mark.parametrize("origin", ["transcript", "acoustic"])
@pytest.mark.parametrize("owner", ["unattributed", "own_track", "manual_retained"])
def test_retained_local_owner_words_still_authorize_move(
    tmp_path: Path, origin: str, owner: str
) -> None:
    project = _episode(tmp_path)
    if origin == "acoustic":
        project.transcripts[1].words = []
    for word in project.transcripts[0].words:
        if owner == "own_track":
            word.dominant_track = "direct"
            word.speaker_match_track = "direct"
            word.audibility_status = "audible"
        if owner == "manual_retained":
            word.audibility_locked = True
    before = project.model_dump(by_alias=True)
    plan = (
        _plan(project)
        if origin == "acoustic"
        else api.plan_retained_bleed_alignment(project, track_id="uncertain")
    )
    assert len(plan.proposals) == 1
    assert plan.proposals[0].offset_sec == pytest.approx(-0.15)
    assert project.model_dump(by_alias=True) == before


@pytest.mark.parametrize("origin", ["transcript", "acoustic"])
@pytest.mark.parametrize("location", ["interior", "start_margin", "end_margin"])
@pytest.mark.parametrize("retention", ["manual", "suppressed", "ignored"])
@pytest.mark.parametrize("mapping", ["identity", "shifted"])
def test_completed_owner_interval_cannot_enclose_foreign_attribution(
    tmp_path: Path, origin: str, location: str, retention: str, mapping: str
) -> None:
    from podcast_mcp.models import TranscriptWord

    project = _episode(tmp_path)
    if origin == "acoustic":
        project.transcripts[1].words = []
    project.transcripts[0].words[0].end = 1.95
    start, end = {
        "interior": (2.0, 2.1),
        "start_margin": (1.22, 1.28),
        "end_margin": (3.12, 3.18),
    }[location]
    project.transcripts[0].words.insert(
        1,
        TranscriptWord(
            text="foreign",
            start=start,
            end=end,
            dominant_track="uncertain",
            audibility_status="bleed",
            audibility_locked=True,
            suppressed=retention == "suppressed",
            ignored=retention == "ignored",
        ),
    )
    samples = _read(tmp_path / "raw" / "direct.wav").astype(float) / 32767
    lo, hi = round(1.2 * RATE), round(3.2 * RATE)
    samples[lo:hi] += 0.012 * np.sin(2 * np.pi * 237 * np.arange(hi - lo) / RATE)
    _write(tmp_path / "raw" / "direct.wav", samples)
    if mapping == "shifted":
        for clip in project.clips:
            clip.timeline_start = 0.4
    before = project.model_dump(by_alias=True)
    plan = api.plan_retained_bleed_alignment(
        project,
        track_id="uncertain",
        **({"start_sec": 0.8, "end_sec": 4.0} if origin == "acoustic" else {}),
    )
    assert plan.proposals == ()
    assert {"track_id": "direct", "reason": "foreign_attribution_in_direct_phrase"} in plan.skipped
    assert api.apply_retained_bleed_alignment(project, plan)["applied_count"] == 0
    assert project.model_dump(by_alias=True) == before


@pytest.mark.parametrize("origin", ["transcript", "acoustic"])
@pytest.mark.parametrize(
    "foreign_source", ["other_recording", "outside_interval", "mapped_outside"]
)
def test_foreign_attribution_outside_selected_source_interval_does_not_veto(
    tmp_path: Path, origin: str, foreign_source: str
) -> None:
    from podcast_mcp.models import SourceRecording, Transcript, TranscriptWord

    project = _episode(tmp_path)
    if origin == "acoustic":
        project.transcripts[1].words = []
    foreign = TranscriptWord(
        text="foreign",
        start=2.0,
        end=2.1,
        dominant_track="uncertain",
        audibility_status="bleed",
        audibility_locked=True,
    )
    if foreign_source == "other_recording":
        project.sources.append(SourceRecording(id="other", path="raw/other.wav", duration_sec=6))
        project.transcripts.append(
            Transcript(track_id="direct", source_id="other", words=[foreign])
        )
    else:
        foreign.start, foreign.end = 3.4, 3.5
        project.transcripts[0].words.append(foreign)
        if foreign_source == "mapped_outside":
            for clip in project.clips:
                clip.timeline_start = 0.4
    before = project.model_dump(by_alias=True)
    plan = api.plan_retained_bleed_alignment(
        project,
        track_id="uncertain",
        **({"start_sec": 0.8, "end_sec": 4.0} if origin == "acoustic" else {}),
    )
    assert len(plan.proposals) == 1
    assert plan.proposals[0].offset_sec == pytest.approx(-0.15)
    assert project.model_dump(by_alias=True) == before


def test_previous_owner_evidence_revision_cannot_apply(tmp_path: Path, monkeypatch) -> None:
    project = _unseeded(tmp_path)
    with monkeypatch.context() as previous:
        previous.setattr(api, "EVIDENCE_REVISION", 4)
        plan = _plan(project)
    assert len(plan.proposals) == 1
    before = project.model_dump(by_alias=True)
    with pytest.raises(ValueError, match="plan is stale"):
        api.apply_retained_bleed_alignment(project, plan)
    assert project.model_dump(by_alias=True) == before

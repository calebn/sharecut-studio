from __future__ import annotations

import ast
import dataclasses
import hashlib
from pathlib import Path
from types import SimpleNamespace

import pytest

from pause_policy_public_helpers import configure, defaults, room, voice, write_wav
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import cut_effects, cut_placement, cut_policy, cut_safety, verdict_cache
from podcast_mcp.edits.cut_placement import CutScopeHold
from podcast_mcp.edits.ripple import RippleRemoval
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval, record_suggested_cut_speech
from podcast_mcp.edits.tighten import propose_tighten_edits
from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
from podcast_mcp.engines.audio import PlacedSource, SourceAudio, sources
from podcast_mcp.engines.timeline_render import placed_track_audio
from podcast_mcp.models import (
    Clip,
    ClipJoinMode,
    CutIntent,
    CutSpeech,
    CutSpeechTrack,
    CutSpeechWord,
    EditDecision,
    EditDecisionType,
    EditMode,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.models.episode import ClipMuteRegion, RangeInterval, SourceRecording
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService, TimelineService
from podcast_mcp.util.coded_error import CodedValueError


def _workspace(tmp_path: Path) -> ProjectWorkspace:
    project = EpisodeProject.create("source removal", str(tmp_path))
    project.tracks = [
        Track(
            id=tid,
            label=tid,
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=6.0),
        )
        for tid in ("host", "guest")
    ]
    project.clips = [
        Clip(id=tid, track_id=tid, source_start=0, source_end=6, timeline_start=0)
        for tid in ("host", "guest")
    ]
    project.timeline.duration_sec = 6
    for index, tid in enumerate(("host", "guest")):
        samples = room(seed=1508 + index)
        voice(samples, 0, 0.8)
        voice(samples, 5, 5.8)
        samples[14400:78400] = 0
        write_wav(tmp_path / f"raw/{tid}.wav", samples)
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="before", start=0, end=0.2),
                TranscriptWord(text="after", start=5, end=5.2),
            ],
        )
    ]
    save_project(project, tmp_path / "episode.project.json")
    REFINE_GATE.mark_done(project, notes="Inspected literal source fixture")
    return ProjectWorkspace.open(tmp_path / "episode.project.json")


def _cut(edit_id: str = "cut", *, reason: str = "filler:um", scope: str = "session"):
    return EditDecision(
        id=edit_id,
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=1,
        end=2,
        boundary_mode="exact",
        review_required=False,
        applied=False,
        scope=scope,
        reason=reason,
    )


@pytest.mark.parametrize("operation", ["extension", "late_fade", "late_pad_fade", "live_plan"])
def test_completed_effect_acoustics_is_the_only_veto(tmp_path, monkeypatch, operation):
    from podcast_mcp.edits import cut_application as decisions
    from podcast_mcp.edits.ripple import plan_trim
    from podcast_mcp.models import EditMode
    from podcast_mcp.services.document.boundary import TrimBoundaryTarget, boundary_context

    ws = _workspace(tmp_path)
    audio = room(seed=1770)
    voice(audio, 0, 0.8)
    voice(audio, 1.85, 2.15) if operation == "extension" else voice(audio, 2.2, 2.5)
    write_wav(tmp_path / "raw/host.wav", audio)
    if operation == "extension":

        def setup(project):
            project.clips[0].source_end = 1
            project.clips[0].fade_out_ms = 50

        ws.mutate("before setup", "after setup", setup)
        assert plan_trim(ws.project, "host", "out", 2, EditMode.GAP).removal is None

        def apply():
            ws.reload()
            token = boundary_context(
                ws.project,
                TrimBoundaryTarget(clip_id="host", edge="out", mode=EditMode.GAP),
                defaults=load_defaults(),
            ).token
            return TimelineService(ws).trim_clip_edge(
                "host", "out", 2, mode=EditMode.GAP, expected_token=token
            )
    elif operation == "live_plan":
        from podcast_mcp.mcp.tools.edits import apply_edit_plan_tool

        with ws.transaction():
            pass

        original_approve = decisions.approve_edits
        original_write = decisions._write_source_remove
        applying = False

        def apply_selected(*args, **kwargs):
            nonlocal applying
            applying = True
            try:
                return original_approve(*args, **kwargs)
            finally:
                applying = False

        def bad_plan_edge(project, *args, **kwargs):
            result = original_write(project, *args, **kwargs)
            if applying:
                next(
                    c for c in project.clips if c.track_id == "host" and c.source_start == 2
                ).fade_in_ms = 600
            return result

        monkeypatch.setattr(decisions, "approve_edits", apply_selected)
        monkeypatch.setattr(decisions, "_write_source_remove", bad_plan_edge)

        def apply():
            apply_edit_plan_tool(
                str(ws.path),
                [
                    {
                        "track_id": "host",
                        "start": 1,
                        "end": 2,
                        "applied": True,
                        "use_inaudible_opt": False,
                    }
                ],
            )
            ws.reload()
    else:
        edit = _cut()
        if operation == "late_pad_fade":
            edit.replace_gap_sec = 0.25
        ws.mutate("before proposal", "after proposal", lambda p: p.edit_decisions.append(edit))
        original = decisions._write_join_fades

        def bad_fade(project, edits, **kwargs):
            result = original(project, edits, **kwargs)
            for clip in project.clips:
                if clip.track_id == "host" and clip.source_start == 2:
                    clip.fade_in_ms = 600
            return result

        monkeypatch.setattr(decisions, "_write_join_fades", bad_fade)

        def apply():
            if operation == "late_pad_fade":
                from podcast_mcp.engines.room_tone import OwnQuietSample, Sample

                monkeypatch.setattr(decisions, "filler_pad_mode", lambda *args, **kw: "room_tone")
                monkeypatch.setattr(
                    "podcast_mcp.edits.timeline_ops.room_tone_span",
                    lambda *args, **kwargs: OwnQuietSample(Sample(3.0, 3.25, -70.0, None)),
                )
                return decisions.apply_auto_edits(
                    ws.project,
                    defaults(mode="room_tone"),
                )
            return decisions.apply_auto_edits(ws.project, defaults())

    before = ws.project.model_dump(mode="json")
    files = {p.relative_to(tmp_path): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}
    if operation == "extension":
        key = ("breath_edge", "mute")
        policy = cut_policy.CUT_ACTION_TABLE[key]
        monkeypatch.delitem(cut_policy.CUT_ACTION_TABLE, key)
        with pytest.raises(KeyError, match="breath_edge"):
            apply()
        assert ws.project.model_dump(mode="json") == before
        assert {
            p.relative_to(tmp_path): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()
        } == files
        monkeypatch.setitem(cut_policy.CUT_ACTION_TABLE, key, policy)
    if operation in {"extension", "live_plan"}:
        with pytest.raises(ScopeChangedAtApproval, match="held edges"):
            apply()
    elif operation in {"late_fade", "late_pad_fade"}:
        assert apply() == 0
    assert ws.project.model_dump(mode="json") == before
    assert {
        p.relative_to(tmp_path): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()
    } == files
    monkeypatch.setattr(cut_safety, "complete_effect_acoustics", lambda *args, **kwargs: [])
    apply()
    assert len(ws.project.editorial.edit_log) == 1
    if operation == "extension":
        clip = next(c for c in ws.project.clips if c.id == "host")
        assert (clip.source_end, clip.fade_out_ms) == (2, 50)
    else:
        assert not ws.project.edit_decisions
        clip = next(c for c in ws.project.clips if c.track_id == "host" and c.source_start == 2)
        assert clip.fade_in_ms == 600


@pytest.mark.parametrize("predicate", ["placement", "hull", "receipts"])
def test_completed_structural_policy_is_the_only_veto(tmp_path, monkeypatch, predicate):
    from pause_policy_public_helpers import add_bed
    from podcast_mcp.edits import cut_application

    configure(monkeypatch, defaults())
    ws = _workspace(tmp_path)
    edit = _cut()
    if predicate in ("placement", "hull"):
        add_bed(ws.project, tmp_path)
        add_bed(ws.project, tmp_path, "guest")
        edit.replace_gap_sec = 0.25
        original = cut_application.insert_bound_room_tone_pad

        def displace_tile(project, plan, **_kw):
            result = original(project, plan, **_kw)
            tile = next(c for c in project.clips if c.source_id == "room-tone-host")
            tile.timeline_start += 0.05
            return result

        if predicate == "hull":
            planned = cut_application.room_tone_pad
            monkeypatch.setattr(
                cut_application,
                "room_tone_pad",
                lambda *args, **kwargs: dataclasses.replace(
                    plan := planned(*args, **kwargs), at_time=plan.at_time + 3.0
                ),
            )
        else:
            monkeypatch.setattr(cut_application, "insert_bound_room_tone_pad", displace_tile)
    else:
        ws.project.edit_decisions = [edit.model_copy(deep=True)]
        assert cut_application.approve_edits(ws.project, [edit.id], defaults=load_defaults()) == 1
        # The same recording is placed again after the first receipt; it is now
        # mechanically removable, so placement cannot mask a duplicate consumption.
        ws.project.clips = [
            Clip(id=tid, track_id=tid, source_start=0, source_end=6, timeline_start=0)
            for tid in ("host", "guest")
        ]
        ws.project.timeline.duration_sec = 6
    ws.project.edit_decisions = [edit]
    before = ws.project.model_dump(mode="json")
    files = {p.relative_to(tmp_path): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}
    with pytest.raises(ScopeChangedAtApproval) as held:
        cut_application.approve_edits(ws.project, [edit.id], defaults=load_defaults())
    assert held.value.ids == (edit.id,)
    assert (
        held.value.held[0].detail
        == (
            {"placement": "pad_source_binding", "hull": "pad_hull", "receipts": "source_receipt"}[
                predicate
            ]
        )
    )
    assert ws.project.model_dump(mode="json") == before
    assert {
        p.relative_to(tmp_path): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()
    } == files
    monkeypatch.setattr(
        cut_effects if predicate == "receipts" else cut_safety,
        f"complete_effect_{'receipts' if predicate == 'receipts' else 'placement'}",
        lambda *args, **kwargs: [] if predicate == "receipts" else None,
    )
    assert cut_application.approve_edits(ws.project, [edit.id], defaults=load_defaults()) == 1
    if predicate == "hull":
        assert len(ws.project.editorial.edit_log) == 1
    elif predicate == "placement":
        tile = next(c for c in ws.project.clips if c.source_id == "room-tone-host")
        assert (tile.timeline_start, tile.timeline_end) == pytest.approx((1.05, 1.3))
        assert len(ws.project.editorial.edit_log) == 1
    else:
        assert [r.decision_ids for r in ws.project.editorial.edit_log] == [[edit.id], [edit.id]]
        assert [
            (c.source_start, c.source_end) for c in ws.project.clips if c.track_id == "host"
        ] == [(0, 1), (2, 6)]


def test_new_id_cannot_remove_a_source_span_consumed_by_an_earlier_cut(tmp_path, monkeypatch):
    from podcast_mcp.edits import cut_application
    from podcast_mcp.services.document import EditService

    ws = _workspace(tmp_path)
    ws.mutate("before proposals", "after proposals", lambda project: project.edit_decisions.clear())
    service = EditService(ws)
    service.suggest_pending_edit("host", 1.0, 1.3)
    previously_offered = ws.project.edit_decisions[-1].model_copy(deep=True)
    service.suggest_pending_edit("host", 1.1, 1.2)
    first_id = ws.project.edit_decisions[-1].id
    assert first_id != previously_offered.id
    assert service.approve([first_id]) == 1
    assert any(edit.id == previously_offered.id for edit in ws.project.edit_decisions)
    before_model = ws.project.model_dump(mode="json")
    before_bytes = ws.path.read_bytes()

    with pytest.raises(ScopeChangedAtApproval) as held:
        service.approve([previously_offered.id])
    assert held.value.held[0].reason == "source_geometry"
    assert ws.project.model_dump(mode="json") == before_model
    assert ws.path.read_bytes() == before_bytes

    from podcast_mcp.edits.cut_application import approve_edits

    monkeypatch.setattr(
        cut_application.cut_safety, "complete_effect_placement", lambda *a, **k: None
    )
    assert approve_edits(ws.project, [previously_offered.id], defaults=load_defaults()) == 1
    rows = ws.project.editorial.edit_log
    assert [(row.source_start, row.source_end) for row in rows] == [(1.1, 1.2), (1.0, 1.3)]
    assert [row.decision_ids for row in rows] == [[first_id], [previously_offered.id]]


def test_record_suggested_cut_speech_ignores_mute_without_remove_placement():
    project = EpisodeProject.create("pure source removal", "/tmp/fix1508-pure")
    project.tracks = [Track(id="host", label="Host", role=TrackRole.DIALOGUE)]
    project.clips = [
        Clip(id="host-clip", track_id="host", source_start=0, source_end=6, timeline_start=0)
    ]
    mute = EditDecision(
        id="mute",
        track_id="host",
        type=EditDecisionType.MUTE,
        start=1,
        end=2,
        reason="filler:um",
        applied=False,
    )

    record_suggested_cut_speech(project, mute, defaults=load_defaults())

    assert mute.cut_speech is None


@pytest.mark.parametrize("scope", ["track", "session"])
def test_remove_inside_an_accepted_mute_uses_the_heard_audio(tmp_path, monkeypatch, scope):
    import numpy as np

    from podcast_mcp.edits.audio_cache import JUMP_SAMPLE_RATE, recording_audio_cache
    from podcast_mcp.edits.cut_application import approve_edits
    from podcast_mcp.edits.cut_safety import assess_held_source as assess_source
    from podcast_mcp.engines.level_profile import PROFILE_SAMPLE_RATE

    project = EpisodeProject.create("muted source", str(tmp_path))
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=5),
        )
    ]
    project.clips = [
        Clip(id="host-main", track_id="host", source_start=0, source_end=5, timeline_start=0.25)
    ]
    project.timeline.duration_sec = 5.25
    audio = room(seconds=5, seed=1701, db=-70)
    audio[16000:32000] += 0.1 * np.sin(2 * np.pi * 140 * np.arange(16000) / 16000)
    audio[38400:48000] += 0.1 * np.sin(2 * np.pi * 220 * np.arange(9600) / 16000)
    write_wav(tmp_path / "raw/host.wav", audio)
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="spoken", start=1, end=2),
                TranscriptWord(text="unrelated", start=2.4, end=3),
            ],
        )
    ]
    measured_caches = []
    import tempfile
    from hashlib import sha256

    source_hash = sha256((tmp_path / "raw/host.wav").read_bytes()).hexdigest()
    render_calls = []
    reference_caches = []
    from podcast_mcp.edits.audio_cache import decode_track
    from podcast_mcp.engines import timeline_render, track_evidence

    render = timeline_render.render_track_from_timeline
    heard_evidence = track_evidence.heard

    def count_render(snapshot, track, output, render_defaults, **kwargs):
        render_calls.append(track.id)
        return render(snapshot, track, output, render_defaults, **kwargs)

    def check_heard(live, track_id, heard_defaults):
        cache = heard_evidence(live, track_id, heard_defaults)
        snapshot = live.model_copy(deep=True)
        track = snapshot.track_by_id(track_id)
        track.transcript_gate = False
        snapshot.processing_chains = []
        with tempfile.TemporaryDirectory(prefix="heard-reference-") as folder:
            reference = Path(folder) / "reference.wav"
            render(snapshot, track, reference, heard_defaults)
            reference_caches.append(decode_track(reference))
        return cache

    monkeypatch.setattr(timeline_render, "render_track_from_timeline", count_render)
    monkeypatch.setattr(track_evidence, "heard", check_heard)

    def record_cache(*args, **kwargs):
        measured_caches.append(kwargs["audio_cache"])
        return assess_source(*args, **kwargs)

    monkeypatch.setattr("podcast_mcp.edits.cut_safety.assess_held_source", record_cache)
    mute = EditDecision(
        id="mute",
        track_id="host",
        type=EditDecisionType.MUTE,
        start=0.9,
        end=2.1,
        reason="nl:range",
        boundary_mode="exact",
        scope="track",
        review_required=False,
        crossfade_ms=10,
    )
    project.edit_decisions = [mute]
    assert approve_edits(project, [mute.id], defaults=load_defaults()) == 1
    accepted = project.model_dump(mode="json")
    remove = EditDecision(
        id="remove",
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=1.3,
        end=1.5,
        reason="nl:range",
        boundary_mode="exact",
        scope=scope,
        review_required=False,
        crossfade_ms=10,
    )
    project.edit_decisions.append(remove)

    assert approve_edits(project, [remove.id], defaults=load_defaults()) == 1
    archives = project.editorial.edit_log
    assert [record.decision_ids for record in archives] == [["mute"], ["remove"]]
    assert (archives[1].source_start, archives[1].source_end) == (1.3, 1.5)
    assert (archives[1].timeline_start, archives[1].timeline_end) == (1.55, 1.75)
    assert (project.clips[0].source_start, project.clips[0].timeline_start) == (0, 0.25)
    assert (project.clips[-1].source_end, project.clips[-1].timeline_start) == (
        5,
        pytest.approx(1.75 if scope == "track" else 1.55),
    )
    heard = next(cache for cache in measured_caches if cache.jump.timeline_offset_sec == -0.25)
    source = recording_audio_cache(tmp_path / "raw/host.wav")
    assert heard.jump.sample_rate == JUMP_SAMPLE_RATE
    assert heard.waveform.sample_rate == PROFILE_SAMPLE_RATE
    assert heard.jump.profile == source.jump.profile
    assert heard.waveform.profile == source.waveform.profile
    np.testing.assert_allclose(
        heard.window(1.5, 1.51), reference_caches[-1].window(1.75, 1.76), atol=1e-3
    )
    assert accepted != project.model_dump(mode="json")
    assert (archives[0].source_start, archives[0].source_end) == (0.9, 2.1)
    assert (archives[0].timeline_start, archives[0].timeline_end) == (1.15, 2.35)
    assert project.clips[-1].source_start == 1.5
    assert render_calls == []
    assert reference_caches
    assert sha256((tmp_path / "raw/host.wav").read_bytes()).hexdigest() == source_hash

    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.models import CutIntent

    manual_mute = mute.model_copy(update={"id": "manual-mute", "start": 2.5, "end": 2.7})
    project.edit_decisions.append(manual_mute)
    assert (
        approve_edits(
            project,
            [manual_mute.id],
            application_intent=CutIntent.HUMAN_BOUNDARIES,
            defaults=load_defaults(),
        )
        == 1
    )
    quiet_cut = remove.model_copy(update={"id": "quiet-cut", "start": 2.25, "end": 2.35})
    word_start = 2.65 if scope == "track" else 2.45
    with tempfile.TemporaryDirectory(prefix="inherited-mute-pcm-") as folder:
        before_path, after_path = Path(folder) / "before.wav", Path(folder) / "after.wav"
        render(project, project.tracks[0], before_path, {})
        project.edit_decisions.append(quiet_cut)
        assert approve_edits(project, [quiet_cut.id], defaults=load_defaults()) == 1
        render(project, project.tracks[0], after_path, {})
        engine = FFmpegEngine()
        before_audio = engine.decode_window_f32(before_path, 0, 84000, 16000, 1)
        after_audio = engine.decode_window_f32(after_path, 0, 84000, 16000, 1)
        first = round(word_start * 16000)
        shifted = first if scope == "track" else first - 1600
        assert len(before_audio[first : first + 9600]) == 9600
        assert len(after_audio[shifted : shifted + 9600]) == 9600
        np.testing.assert_array_equal(
            before_audio[first : first + 9600], after_audio[shifted : shifted + 9600]
        )
    assert not Path(folder).exists()
    assert [record.decision_ids for record in project.editorial.edit_log] == [
        ["mute"],
        ["remove"],
        ["manual-mute"],
        ["quiet-cut"],
    ]
    assert (
        project.editorial.edit_log[-1].source_start,
        project.editorial.edit_log[-1].source_end,
    ) == (2.25, 2.35)
    assert sha256((tmp_path / "raw/host.wav").read_bytes()).hexdigest() == source_hash
    inside_cut = remove.model_copy(update={"id": "inside-cut", "start": 2.55, "end": 2.6})
    project.edit_decisions.append(inside_cut)
    assert approve_edits(project, [inside_cut.id], defaults=load_defaults()) == 1
    assert len(project.editorial.edit_log) == 5
    assert project.editorial.edit_log[-1].decision_ids == ["inside-cut"]
    assert (
        project.editorial.edit_log[-1].source_start,
        project.editorial.edit_log[-1].source_end,
    ) == (2.55, 2.6)
    assert sha256((tmp_path / "raw/host.wav").read_bytes()).hexdigest() == source_hash


def test_unrelated_recording_mute_does_not_qualify_an_effect(tmp_path):
    project = EpisodeProject.create("separate recordings", str(tmp_path))
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=5),
        )
    ]
    project.sources = [SourceRecording(id="guest-recording", path="raw/guest.wav")]
    project.clips = [
        Clip(id="target", track_id="host", source_start=0, source_end=5, timeline_start=5.25),
        Clip(
            id="muted-other-recording",
            track_id="host",
            source_id="guest-recording",
            source_start=0,
            source_end=5,
            timeline_start=0,
            mute_regions=[ClipMuteRegion(start_s=1, end_s=2)],
        ),
    ]
    audio = room(seconds=5, seed=1701, db=-70)
    voice(audio, 1, 2)
    write_wav(tmp_path / "raw/host.wav", audio)
    write_wav(tmp_path / "raw/guest.wav", room(seconds=5))
    candidate = project.model_copy(deep=True)
    candidate.clips[0].source_start = 1.3
    candidate.clips[0].timeline_start = 6.55
    candidate.clips[0].fade_in_ms = 10
    effects = cut_effects.completed_audio_effects(
        project, candidate, frozenset({"remove"}), defaults={}
    )
    assert effects
    assert all(effect.before is not None for effect in effects)
    assert all(not cut_safety._effect_has_accepted_mute(project, effect) for effect in effects)
    holds = cut_safety.complete_effect_acoustics(project, effects, defaults={})
    assert [hold.edit_id for hold in holds] == ["remove"]
    assert "voiced_edge" in holds[0].detail


def test_completed_effects_preserve_unchanged_downstream_fade_after_ripple(tmp_path):
    audio = room(seconds=92, seed=2375, db=-70)
    voice(audio, 90.7, 91.11)
    write_wav(tmp_path / "raw/host.wav", audio)
    project = EpisodeProject.create("downstream fade ripple", str(tmp_path))
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=92),
        )
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="downstream", start=90.7, end=91.11)],
        )
    ]
    project.clips = [
        Clip(id="cut-clip", track_id="host", source_start=0, source_end=45, timeline_start=0),
        Clip(
            id="downstream",
            track_id="host",
            source_start=90,
            source_end=91.11,
            timeline_start=90,
            fade_out_ms=200,
        ),
    ]
    candidate = project.model_copy(deep=True)
    candidate.clips[0].source_end = 44.8
    candidate.clips[1].timeline_start -= 0.2
    effects = cut_effects.completed_audio_effects(
        project, candidate, frozenset({"cut"}), defaults={}
    )
    assert [
        (effect.start, effect.end, effect.join, effect.retained, effect.contributors)
        for effect in effects
    ] == [
        (44.8, 44.8, cut_policy.CutJoin.SPLICE, False, frozenset({"cut"})),
        (44.8, 45, cut_policy.CutJoin.SPLICE, False, frozenset({"cut"})),
    ]
    assert candidate.clips[1].fade_out_ms == 200
    assert cut_safety.complete_effect_acoustics(project, effects, defaults={}) == []


@pytest.mark.parametrize("aliased", [False, True])
def test_completed_effects_bind_repeated_physical_occurrences(tmp_path, aliased):
    path = tmp_path / "raw/host.wav"
    audio = room(seconds=5, seed=1701, db=-70)
    voice(audio, 1, 2)
    write_wav(path, audio)
    alias = tmp_path / "raw/alias.wav"
    alias.hardlink_to(path)
    project = EpisodeProject.create("repeated source", str(tmp_path))
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=5),
        )
    ]
    project.sources = [SourceRecording(id="alias", path="raw/alias.wav")]
    project.clips = [
        Clip(
            id="muted",
            track_id="host",
            source_start=0,
            source_end=5,
            timeline_start=0,
            source_id="alias" if aliased else None,
            mute_regions=[ClipMuteRegion(start_s=1, end_s=2)],
        ),
        Clip(id="target", track_id="host", source_start=0, source_end=5, timeline_start=5.25),
    ]
    candidate = project.model_copy(deep=True)
    candidate.clips[1].source_start = 1.3
    candidate.clips[1].fade_in_ms = 10
    effects = cut_effects.completed_audio_effects(
        project, candidate, frozenset({"remove"}), defaults={}
    )
    assert effects
    assert all(effect.before.source.clip_id == "target" for effect in effects)
    assert all(not cut_safety._effect_has_accepted_mute(project, effect) for effect in effects)
    removed = [
        effect for effect in effects if effect.envelope is None and effect.start < effect.end
    ]
    assert [(effect.start, effect.end, effect.timeline_start) for effect in removed] == [
        (0, 1.3, 5.25)
    ]
    retained = next(effect for effect in effects if effect.retained)
    assert retained.timeline_start == 5.25
    assert (
        retained.before.timeline_start + retained.start - retained.before.source.src_start == 6.55
    )
    assert cut_safety.complete_effect_acoustics(project, effects, defaults={})
    if not aliased:
        candidate.clips[1].id = "unattributed-split"
        with pytest.raises(ValueError, match="ambiguous BEFORE"):
            cut_effects.completed_audio_effects(
                project, candidate, frozenset({"remove"}), defaults={}
            )
    candidate = project.model_copy(deep=True)
    candidate.clips.append(
        project.clips[1].model_copy(update={"id": "duplicate", "timeline_start": 11})
    )
    if aliased:
        with pytest.raises(ValueError, match="duplicated BEFORE"):
            cut_effects.completed_audio_effects(
                project, candidate, frozenset({"remove"}), defaults={}
            )


def test_pause_join_quality_uses_selected_physical_recording(tmp_path, monkeypatch):
    selected_ws = _workspace(tmp_path / "selected-recording")
    selected = selected_ws.project
    alias_path = tmp_path / "selected-recording" / "raw/host-alias.wav"
    alias_path.hardlink_to(tmp_path / "selected-recording" / "raw/host.wav")
    selected.sources = [SourceRecording(id="host-alias", path="raw/host-alias.wav")]
    next(clip for clip in selected.clips if clip.track_id == "host").source_id = "host-alias"
    pause = _cut("pause", reason="pause:1s")
    pause.source_id = None
    selected.edit_decisions = [pause]
    changed = selected.model_copy(deep=True)
    from podcast_mcp.edits.ripple import ripple_remove_clips, ripple_track_ids
    from podcast_mcp.util.batch_scope import batch_scope

    with batch_scope():
        ripple_remove_clips(
            changed, [(1, 2)], ripple_track_ids(selected, ["host"]), defaults=load_defaults()
        )
        pause_effects = cut_effects.completed_audio_effects(
            selected, changed, frozenset({pause.id}), defaults={}
        )
        calls = []
        verdicts = {"host": "pass", "guest": "review"}

        def score(project, track_id, start, end, **kwargs):
            calls.append((track_id, start, end))
            return SimpleNamespace(verdict=verdicts[track_id])

        monkeypatch.setattr(cut_safety, "assess_proposed_cut", score)
        pause_holds = cut_safety.complete_effect_acoustics(
            selected,
            pause_effects,
            defaults={"tighten": {"join_continuity_gate": True}},
            pauses={pause.id: cut_safety.HeldPause((), 0.5, (0, 6))},
        )
        assert calls == [("host", 1, 2)]
        assert pause_holds == []

        for verdict, reason in (("review", "review_required"), ("fail", "join_continuity")):
            verdicts["host"] = verdict
            calls.clear()
            pause_holds = cut_safety.complete_effect_acoustics(
                selected,
                pause_effects,
                defaults={"tighten": {"join_continuity_gate": True}},
                pauses={pause.id: cut_safety.HeldPause((), 0.5, (0, 6))},
            )
            assert calls == [("host", 1, 2)]
            assert [(hold.reason, hold.detail) for hold in pause_holds] == [("pause_join", reason)]

        def unavailable(*args, **kwargs):
            raise OSError("selected recording could not be scored")

        monkeypatch.setattr(cut_safety, "assess_proposed_cut", unavailable)
        pause_holds = cut_safety.complete_effect_acoustics(
            selected,
            pause_effects,
            defaults={"tighten": {"join_continuity_gate": True}},
            pauses={pause.id: cut_safety.HeldPause((), 0.5, (0, 6))},
        )
        assert [(hold.reason, hold.detail) for hold in pause_holds] == [
            ("pause_join", "audio_unavailable")
        ]

        monkeypatch.setattr(cut_safety, "assess_proposed_cut", score)
        selected.edit_decisions.clear()
        pause_holds = cut_safety.complete_effect_acoustics(
            selected,
            pause_effects,
            defaults={"tighten": {"join_continuity_gate": True}},
            pauses={pause.id: cut_safety.HeldPause((), 0.5, (0, 6))},
        )
        assert [(hold.reason, hold.detail) for hold in pause_holds] == [
            ("pause_join", "audio_unavailable")
        ]
        selected.edit_decisions = [pause.model_copy(update={"source_id": "missing"})]
        pause_holds = cut_safety.complete_effect_acoustics(
            selected,
            pause_effects,
            defaults={"tighten": {"join_continuity_gate": True}},
            pauses={pause.id: cut_safety.HeldPause((), 0.5, (0, 6))},
        )
        assert [(hold.reason, hold.detail) for hold in pause_holds] == [
            ("pause_join", "audio_unavailable")
        ]


@pytest.mark.parametrize("occurrence", [0, 1])
@pytest.mark.parametrize("aliased", [False, True])
def test_public_range_cut_preserves_repeated_source_occurrences(tmp_path, occurrence, aliased):
    path = tmp_path / "raw/host.wav"
    write_wav(path, room(seconds=5, seed=1711, db=-70))
    alias = tmp_path / "raw/alias.wav"
    alias.hardlink_to(path)
    source_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    project = EpisodeProject.create("repeated public range", str(tmp_path))
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=5),
        )
    ]
    project.sources = [SourceRecording(id="alias", path="raw/alias.wav")]
    project.clips = [
        Clip(id="first", track_id="host", source_start=0, source_end=5, timeline_start=0),
        Clip(
            id="second",
            track_id="host",
            source_start=0,
            source_end=5,
            timeline_start=5.25,
            source_id="alias" if aliased else None,
        ),
    ]
    project.timeline.duration_sec = 10.25
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="before", start=0.1, end=0.3),
                TranscriptWord(text="after", start=4.5, end=4.7),
            ],
        )
    ]
    project_path = tmp_path / "episode.project.json"
    save_project(project, project_path)
    REFINE_GATE.mark_done(project, notes="literal quiet source fixture")
    ws = ProjectWorkspace.open(project_path)
    offset = 5.25 * occurrence
    EditService(ws).cut_range(
        offset + 1.3,
        offset + 1.5,
        mode=EditMode.RIPPLE,
        track_ids=["host"],
        use_inaudible_opt=False,
    )
    expected = (
        [(0, 1.3, 0), (1.5, 5, 1.3), (0, 5, 5.05)]
        if occurrence == 0
        else [(0, 5, 0), (0, 1.3, 5.25), (1.5, 5, 6.55)]
    )
    for actual in (ws.project, load_project(project_path)):
        assert len(actual.clips) == 3
        for clip, geometry in zip(actual.clips, expected, strict=True):
            assert (clip.source_start, clip.source_end, clip.timeline_start) == pytest.approx(
                geometry
            )
        assert actual.clips[2 if occurrence == 0 else 0].id == (
            "second" if occurrence == 0 else "first"
        )
        assert actual.timeline.duration_sec == pytest.approx(10.05)
        assert len(actual.editorial.edit_log) == 1
    assert hashlib.sha256(path.read_bytes()).hexdigest() == source_hash
    assert hashlib.sha256(alias.read_bytes()).hexdigest() == source_hash


def test_record_suggested_cut_speech_annotates_a_valid_remove(monkeypatch):
    project = EpisodeProject.create("pure source removal", "/tmp/fix1508-pure")
    project.tracks = [
        Track(id=tid, label=tid.title(), role=TrackRole.DIALOGUE) for tid in ("host", "guest")
    ]
    project.clips = [
        Clip(id=f"{tid}-clip", track_id=tid, source_start=0, source_end=6, timeline_start=0)
        for tid in ("host", "guest")
    ]
    decision = _cut()
    expected = CutSpeech(
        spans=[RangeInterval(start=1, end=2)],
        tracks=[
            CutSpeechTrack(
                track_id="guest",
                speaker="Guest",
                words=[CutSpeechWord(text="hello", timeline_start=1.2, timeline_end=1.5)],
            )
        ],
    )
    observed: list[tuple[EpisodeProject, tuple[tuple[float, float], ...], frozenset[str]]] = []

    def assess(project_arg: EpisodeProject, removal: RippleRemoval, **_kw) -> CutSpeech:
        observed.append((project_arg, removal.spans, removal.edited_track_ids))
        return expected

    monkeypatch.setattr("podcast_mcp.edits.source_removals.assess_cut_speech", assess)

    record_suggested_cut_speech(project, decision, defaults=load_defaults())

    assert observed == [(project, ((1.0, 2.0),), frozenset({"host"}))]
    assert decision.cut_speech == expected


def _restricted_cut_access(code: str, *, caller: str = "") -> set[str]:
    restricted = {
        "podcast_mcp.edits.breath_detect.protect_cut_breaths",
        "podcast_mcp.edits.speech_energy_guard.assess_cross_track_speech",
        "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
        "podcast_mcp.edits.join_continuity.assess_proposed_cut",
        "podcast_mcp.edits.source_removals.inspect_source_remove_placement",
        "podcast_mcp.edits.source_removals._inspect_source_remove_placement_impl",
        "podcast_mcp.edits.source_removals._witnessed_source_span_has_unsafe_overlap",
        "podcast_mcp.edits.tighten.prepare._original_pause_support",
        "podcast_mcp.edits.tighten.prepare._check_voiced_speech",
        "podcast_mcp.edits.sound_actions.sound_label_and_action",
        "podcast_mcp.edits.suggested_actions.suggested_action_for",
        "podcast_mcp.edits.cut_speech.clear_ripple",
    }
    if caller not in {"edits/cut_application.py", "edits/timeline_ops.py"}:
        restricted.update(
            f"podcast_mcp.edits.timeline_ops.{name}"
            for name in (
                "_write_ripple_delete",
                "_write_punch_delete",
                "_write_ripple_delete_clips",
                "_write_punch_delete_clips",
                "_write_punch_delete_range",
                "_write_trim_clip_edge",
            )
        )
    if caller != "edits/cut_application.py":
        restricted.update(
            f"podcast_mcp.edits.cut_application.{name}"
            for name in (
                "_apply_source_remove",
                "_write_source_remove",
                "_write_join_fades",
                "_apply_mute_edit",
                "_range_candidate",
            )
        )
    tree = ast.parse(code)
    nodes = tuple(ast.walk(tree))
    aliases: dict[str, str] = {}
    found: set[str] = set()
    for node in nodes:
        if isinstance(node, ast.ImportFrom) and node.module:
            for alias in node.names:
                qualified = f"{node.module}.{alias.name}"
                aliases[alias.asname or alias.name] = qualified
                if qualified in restricted:
                    found.add(qualified)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                aliases[alias.asname or alias.name.split(".")[0]] = (
                    alias.name if alias.asname else alias.name.split(".")[0]
                )

    def qualified_name(node: ast.expr) -> str:
        if isinstance(node, ast.Name):
            return aliases.get(node.id, node.id)
        if isinstance(node, ast.Attribute):
            return f"{qualified_name(node.value)}.{node.attr}"
        return ""

    for node in nodes:
        if isinstance(node, ast.Attribute):
            qualified = qualified_name(node)
            if qualified in restricted:
                found.add(qualified)
    return found


def test_cut_safety_boundary_owns_remove_placement_and_guard_imports():
    source = Path(__file__).parents[1] / "src/podcast_mcp"
    consumers = {
        str(path.relative_to(source)): hits
        for path in source.rglob("*.py")
        if (
            hits := _restricted_cut_access(
                path.read_text(encoding="utf-8"), caller=str(path.relative_to(source))
            )
        )
    }
    assert consumers == {}
    for code in (
        "from podcast_mcp.edits.timeline_ops import _write_trim_clip_edge as write; write()",
        "import podcast_mcp.edits.timeline_ops as ops; ops._write_ripple_delete()",
        "from podcast_mcp.edits import timeline_ops; timeline_ops._write_punch_delete()",
        "import podcast_mcp.edits.cut_application; podcast_mcp.edits.cut_application._write_join_fades()",
        "from podcast_mcp.edits.cut_application import _apply_source_remove as consume; consume()",
        "from podcast_mcp.edits.breath_detect import protect_cut_breaths as protect",
        "from podcast_mcp.edits.speech_energy_guard import assess_cross_track_speech as assess",
        "import podcast_mcp.edits.join_continuity as joins; joins.assess_proposed_cut()",
        "from podcast_mcp.edits import source_removals as cuts; cuts.inspect_source_remove_placement()",
        "import podcast_mcp.edits.source_removals; podcast_mcp.edits.source_removals._inspect_source_remove_placement_impl()",
        "from podcast_mcp.edits.source_removals import _witnessed_source_span_has_unsafe_overlap",
        "from podcast_mcp.edits.tighten.prepare import _original_pause_support",
        "from podcast_mcp.edits.tighten.prepare import _check_voiced_speech as check",
        "from podcast_mcp.edits import sound_actions as sounds; sounds.sound_label_and_action()",
    ):
        assert _restricted_cut_access(code), code
    definitions = []
    for path in (source / "edits").glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        definitions.extend(
            (node.name, path.name)
            for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name
            in {
                "inspect_source_remove_placement",
                "protect_cut_breaths",
                "assess_cross_track_speech",
                "assess_proposed_cut",
                "original_pause_support",
                "complete_effect_acoustics",
                "_peer_policy",
                "complete_effect_placement",
                "complete_effect_receipts",
            }
        )
    owners = {
        "inspect_source_remove_placement": "cut_placement.py",
        "original_pause_support": "cut_placement.py",
        "complete_effect_receipts": "cut_effects.py",
        "protect_cut_breaths": "cut_safety.py",
        "assess_cross_track_speech": "cut_safety.py",
        "assess_proposed_cut": "cut_safety.py",
        "complete_effect_acoustics": "cut_safety.py",
        "_peer_policy": "cut_safety.py",
        "complete_effect_placement": "cut_safety.py",
    }
    assert sorted(definitions) == sorted(owners.items())

    project = EpisodeProject.create("pure source removal", "/tmp/fix1508-pure")
    project.tracks = [Track(id="host", label="Host", role=TrackRole.DIALOGUE)]
    project.clips = [
        Clip(id="host-clip", track_id="host", source_start=0, source_end=6, timeline_start=0)
    ]
    mute = EditDecision(
        id="mute",
        track_id="host",
        type=EditDecisionType.MUTE,
        start=1,
        end=2,
        applied=False,
    )
    remove = mute.model_copy(update={"id": "remove", "type": EditDecisionType.REMOVE})

    assert cut_placement.inspect_source_remove_placement(project, mute) == (1, 2)
    assert cut_placement.inspect_source_remove_placement(project, remove) == (1, 2)


def _replay(project: EpisodeProject) -> None:
    project.clips.append(
        Clip(id="replay", track_id="host", source_start=1, source_end=2, timeline_start=6)
    )
    project.clips.append(
        Clip(id="guest-tail", track_id="guest", source_start=5, source_end=6, timeline_start=6)
    )
    project.timeline.duration_sec = 7


@pytest.mark.parametrize("reason", ["filler:um", "nl:range", "focus", "repeat:test"])
@pytest.mark.parametrize("scope", ["session", "track"])
def test_saved_ordinary_remove_refuses_replayed_source(tmp_path: Path, reason: str, scope: str):
    ws = _workspace(tmp_path)

    def setup(project: EpisodeProject):
        _replay(project)
        project.edit_decisions = [_cut(reason=reason, scope=scope)]

    ws.mutate("before replay", "after replay", setup)
    assert isinstance(
        cut_placement.inspect_source_remove_placement(ws.project, ws.project.edit_decisions[0]),
        CutScopeHold,
    )
    before = ws.path.read_bytes()
    with pytest.raises(ScopeChangedAtApproval) as held:
        EditService(ws).approve(["cut"])
    assert held.value.ids == ("cut",)
    assert ws.path.read_bytes() == before
    saved = load_project(ws.path)
    assert saved.timeline.duration_sec == 7
    assert [(c.source_start, c.source_end, c.timeline_start) for c in saved.clips] == [
        (0, 6, 0),
        (0, 6, 0),
        (1, 2, 6),
        (5, 6, 6),
    ]
    assert [e.id for e in saved.edit_decisions] == ["cut"]


def test_saved_track_pause_cannot_punch(tmp_path: Path):
    ws = _workspace(tmp_path)
    ws.mutate(
        "before pause",
        "after pause",
        lambda p: setattr(p, "edit_decisions", [_cut(reason="pause:4.80s", scope="track")]),
    )
    before = ws.path.read_bytes()
    with pytest.raises(ScopeChangedAtApproval) as held:
        EditService(ws).approve(["cut"])
    assert held.value.ids == ("cut",)
    assert ws.path.read_bytes() == before
    assert {
        tid: sum(c.source_end - c.source_start for c in ws.project.clips if c.track_id == tid)
        for tid in ("host", "guest")
    } == {"host": 6, "guest": 6}


def test_saved_batch_rolls_back_valid_remove_when_later_geometry_holds(tmp_path: Path):
    ws = _workspace(tmp_path)

    def setup(project: EpisodeProject):
        _replay(project)
        valid = _cut("valid")
        valid.start, valid.end = 3, 4
        project.edit_decisions = [_cut(), valid]

    ws.mutate("before batch", "after batch", setup)
    before = ws.path.read_bytes()
    with pytest.raises(ScopeChangedAtApproval):
        EditService(ws).approve(["valid", "cut"])
    assert ws.path.read_bytes() == before
    assert [w.text for w in ws.project.transcripts[0].words] == ["before", "after"]
    assert [e.id for e in ws.project.edit_decisions] == ["cut", "valid"]


def test_pause_proposal_after_hole_drops_crossing_span_and_keeps_safe_control(tmp_path: Path):
    ws = _workspace(tmp_path)
    prior = _cut("prior", reason="nl:range")
    prior.start, prior.end = 0.7, 4
    ws.mutate("before prior", "after prior", lambda p: p.edit_decisions.append(prior))
    assert EditService(ws).approve(["prior"], application_intent=CutIntent.HUMAN_BOUNDARIES) == 1
    for tid in ("host", "guest"):
        (tmp_path / f"raw/{tid}.wav").unlink()
    cfg = {
        "tighten": {
            "inaudible_opt": False,
            "leave_in_if_risky": False,
            "join_continuity_gate": False,
            "filler_words": [],
            "repetition_candidates": False,
            "acoustic_gap_filler": {"enabled": False},
            "breath_handling": {"enabled": False},
            "speech_energy_guard": {"enabled": False},
        },
        "performance": {"max_workers": 1},
    }
    proposal = propose_tighten_edits(ws.project, cfg, intensity="aggressive")
    assert proposal.decisions == []
    assert proposal.skip_counts.get("no_air") == 1
    from podcast_mcp.edits.cut_placement import CutScopeHold
    from podcast_mcp.edits.cut_safety import inspect_source_remove

    crossing = _cut("crossing", reason="pause:4.80s")
    crossing.start, crossing.end = 0.2, 4.7
    assessed = inspect_source_remove(ws.project, crossing)
    assert isinstance(assessed, CutScopeHold)
    assert assessed.reason == "source_geometry"
    control_workspace = _workspace(tmp_path / "control")
    for tid in ("host", "guest"):
        audio = room(seed=1510 if tid == "host" else 1511)
        voice(audio, 0, 0.2)
        voice(audio, 5, 5.2)
        write_wav(tmp_path / "control" / f"raw/{tid}.wav", audio)
    control = propose_tighten_edits(control_workspace.project, cfg, intensity="aggressive")
    assert [(d.start, d.end, d.scope) for d in control.decisions] == [(0.2, 4.7, "session")]


def test_saved_known_finite_identity_lane_remove_materializes_real_clips(tmp_path: Path):
    ws = _workspace(tmp_path)
    ws.mutate("before identity", "after identity", lambda p: setattr(p, "clips", []))
    assert EditService(ws).suggest_pending_edit("host", 1, 2)["scope"] == "session"
    edit_id = ws.project.edit_decisions[0].id
    assert EditService(ws).approve([edit_id]) == 1
    saved = load_project(ws.path)
    assert saved.timeline.duration_sec == 5
    assert {
        tid: [
            (c.source_start, c.source_end, c.timeline_start)
            for c in saved.clips
            if c.track_id == tid
        ]
        for tid in ("host", "guest")
    } == {"host": [(0, 1, 0), (2, 6, 1)], "guest": [(0, 1, 0), (2, 6, 1)]}


@pytest.mark.parametrize("empty", [False, True])
def test_saved_unresolved_or_intentionally_empty_identity_remove_holds(tmp_path: Path, empty: bool):
    ws = _workspace(tmp_path)

    # Saved directly: a mutation would retire the proposal this test needs to hold (#1487).
    ws.project.clips = []
    ws.project.tracks[0].timeline_empty = empty
    if not empty:
        ws.project.tracks[0].media.duration_sec = None
    ws.project.edit_decisions = [_cut()]
    ws.save()
    before = ws.path.read_bytes()
    if empty:
        # No clip plays the span, so approval refuses the proposal outright (#1487).
        with pytest.raises(CodedValueError) as refused:
            EditService(ws).approve(["cut"])
        assert refused.value.code == "edit_span_not_played"
    else:
        with pytest.raises(ScopeChangedAtApproval) as held:
            EditService(ws).approve(["cut"])
        assert held.value.held[0].reason == "media_extent_unavailable"
    assert ws.path.read_bytes() == before
    assert ws.project.clips == []
    assert [e.id for e in ws.project.edit_decisions] == ["cut"]


@pytest.mark.parametrize("unsafe", [False, True])
@pytest.mark.parametrize("scope", ["session", "track"])
def test_saved_final_bounds_are_not_reoptimized_into_neighboring_media(
    tmp_path: Path, monkeypatch, unsafe: bool, scope: str
):

    ws = _workspace(tmp_path)

    def setup(project: EpisodeProject):
        project.edit_decisions = [_cut(scope=scope)]
        if unsafe:
            project.clips.append(
                Clip(
                    id="edge-replay",
                    track_id="host",
                    source_start=0.8,
                    source_end=1,
                    timeline_start=6,
                )
            )
            project.clips.append(
                Clip(
                    id="guest-tail",
                    track_id="guest",
                    source_start=5.8,
                    source_end=6,
                    timeline_start=6,
                )
            )
            project.timeline.duration_sec = 6.2

    ws.mutate("before optimizer", "after optimizer", setup)

    def forbidden_optimizer(*args, **kwargs):
        pytest.fail("Applying held bounds must not optimize again")

    monkeypatch.setattr(
        "podcast_mcp.edits.inaudible_cuts.optimize_timeline_cut_range", forbidden_optimizer
    )
    assert EditService(ws).approve(["cut"]) == 1
    saved = load_project(ws.path)
    record = saved.editorial.edit_log[-1]
    assert (record.source_start, record.source_end) == (1, 2)
    assert (record.timeline_start, record.timeline_end) == (1, 2)
    assert saved.timeline.duration_sec == pytest.approx(
        (6.2 if unsafe else 6) - (1 if scope == "session" else 0)
    )
    expected = [(0, 1, 0), (2, 6, 1 if scope == "session" else 2)]
    if unsafe:
        expected.append((0.8, 1, 5 if scope == "session" else 6))
    assert [
        (c.source_start, c.source_end, c.timeline_start)
        for c in saved.clips
        if c.track_id == "host"
    ] == expected


@pytest.mark.parametrize(
    ("sabotage", "reason", "manual_applies"),
    [
        ("held_edge", "acoustic_edge", True),
        ("peer", "peer_speech", True),
        ("placement", "source_geometry", False),
        ("replay", "source_geometry", False),
    ],
)
def test_apply_reassesses_real_sabotage_after_offer(
    tmp_path: Path, monkeypatch, sabotage, reason, manual_applies
):
    ws = _workspace(tmp_path)
    EditService(ws).suggest_pending_edit("host", 1, 2)
    (proposal,) = ws.project.edit_decisions
    assert (proposal.start, proposal.end) == (1, 2)
    assert "acoustic_review" not in proposal.reason
    origin = proposal.proposal_origin
    if sabotage in {"held_edge", "peer"}:
        track = "host" if sabotage == "held_edge" else "guest"
        audio = room(seed=1770)
        voice(audio, 0, 0.8)
        voice(audio, 5, 5.8)
        audio[14400:78400] = 0
        voice(audio, 0.95, 1.2) if sabotage == "held_edge" else voice(audio, 1.2, 1.6)
        write_wav(tmp_path / f"raw/{track}.wav", audio)
        if sabotage == "peer":
            ws.mutate(
                "before peer",
                "after peer",
                lambda p: p.transcripts.append(
                    Transcript(
                        track_id="guest", words=[TranscriptWord(text="new", start=1.2, end=1.6)]
                    )
                ),
            )
    elif sabotage == "placement":

        def set_mute_mode(project):
            next(
                edit for edit in project.edit_decisions if edit.id == proposal.id
            ).type = EditDecisionType.MUTE

        ws.mutate("before mute placement", "after mute placement", set_mute_mode)
        (proposal,) = ws.project.edit_decisions

        def separate_source(project):
            project.clips[0].source_end = 1.5
            project.clips.append(
                Clip(
                    id="displaced",
                    track_id="host",
                    source_start=1.5,
                    source_end=6,
                    timeline_start=2,
                )
            )

        ws.mutate("before placement", "after placement", separate_source)
    else:
        ws.mutate("before replay", "after replay", _replay)
    before = ws.path.read_bytes()
    before_model = ws.project.model_dump(mode="json")
    before_files = {
        str(p.relative_to(tmp_path)): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()
    }
    if sabotage == "placement":
        key = ("source_geometry", "mute")
        policy = cut_policy.CUT_ACTION_TABLE[key]
        monkeypatch.delitem(cut_policy.CUT_ACTION_TABLE, key)
        with pytest.raises(KeyError, match="source_geometry"):
            EditService(ws).approve([proposal.id])
        assert ws.path.read_bytes() == before
        assert ws.project.model_dump(mode="json") == before_model
        monkeypatch.setitem(cut_policy.CUT_ACTION_TABLE, key, policy)
    with pytest.raises(ScopeChangedAtApproval) as held:
        EditService(ws).approve([proposal.id])
    assert held.value.held[0].reason == reason
    assert held.value.ids == (proposal.id,)
    assert {
        str(p.relative_to(tmp_path)): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()
    } == before_files
    assert ws.path.read_bytes() == before
    assert ws.project.model_dump(mode="json") == before_model
    if not manual_applies:
        with pytest.raises(ScopeChangedAtApproval) as human_held:
            EditService(ws).approve([proposal.id], application_intent=CutIntent.HUMAN_BOUNDARIES)
        assert human_held.value.held[0].reason == "source_geometry"
        assert ws.path.read_bytes() == before
        assert ws.project.model_dump(mode="json") == before_model
    if manual_applies:
        assert (
            EditService(ws).approve([proposal.id], application_intent=CutIntent.HUMAN_BOUNDARIES)
            == 1
        )
        record = ws.project.editorial.edit_log[-1]
        assert (record.source_start, record.source_end) == (1, 2)
        assert len(ws.project.editorial.edit_log) == 1
        assert record.params.get("source_start", 1) == 1
        if sabotage == "peer":
            from podcast_mcp.services.document import HistoryService

            HistoryService(ws).undo()
            observations = []

            def omit_only_peer_policy(evidence, **_kwargs):
                observations.append(evidence)
                return None

            monkeypatch.setattr(cut_safety, "_peer_policy", omit_only_peer_policy)
            assert EditService(ws).approve([proposal.id]) == 1
            assert len(observations) == 1
            evidence = observations[0]
            assert evidence.mapped.cause == "peer_speech"
            assert [t.track_id for t in evidence.removed.tracks] == ["guest"]
            assert [
                (w.timeline_start, w.timeline_end) for w in evidence.removed.tracks[0].words
            ] == [(1.2, 1.6)]
            saved = load_project(ws.path)
            assert saved.edit_decisions == []
            assert [(r.source_start, r.source_end) for r in saved.editorial.edit_log] == [(1, 2)]
            assert [
                (c.source_start, c.source_end) for c in saved.clips if c.track_id == "guest"
            ] == [(0, 1), (2, 6)]
    else:
        with pytest.raises(ScopeChangedAtApproval):
            EditService(ws).approve([proposal.id], application_intent=CutIntent.HUMAN_BOUNDARIES)
        assert ws.path.read_bytes() == before
        assert ws.project.edit_decisions[0].proposal_origin == origin


@pytest.mark.parametrize("pad", [0.1, 1.0, 1.2])
def test_saved_pause_rechecks_original_floor_instead_of_stored_pad(
    tmp_path: Path, monkeypatch, pad: float
):
    cfg = defaults(acoustic=True)
    configure(monkeypatch, cfg)
    ws = _workspace(tmp_path)
    host = room(seed=1510)
    voice(host, 0, 0.2)
    voice(host, 5, 5.2)
    voice(host, 5.4, 5.8)
    write_wav(tmp_path / "raw/host.wav", host)
    guest = room(seed=1511)
    voice(guest, 0, 0.2)
    voice(guest, 5, 5.2)
    voice(guest, 5.4, 5.8)
    write_wav(tmp_path / "raw/guest.wav", guest)
    ws.project.transcripts[0].words.append(TranscriptWord(text="reference", start=5.4, end=5.8))
    ws.project.transcripts.append(
        Transcript(
            track_id="guest",
            words=[w.model_copy(deep=True) for w in ws.project.transcripts[0].words],
        )
    )
    pause = _cut(reason="pause:4.80s")
    pause.replace_gap_sec = pad
    ws.mutate("before pause", "after pause", lambda p: p.edit_decisions.append(pause))

    assert EditService(ws).approve(["cut"]) == 1

    saved = load_project(ws.path)
    assert saved.timeline.duration_sec == pytest.approx(5)
    record = saved.editorial.edit_log[-1]
    assert (record.source_start, record.source_end) == pytest.approx((1, 2))
    assert record.params["loss_sec"] == pytest.approx(1)
    assert record.params["replace_gap_sec"] is None
    assert record.params["pad_samples"] == []
    assert saved.edit_decisions == []

    cfg["tighten"].update(min_retained_pause_sec=5, min_retained_solo_pause_sec=5)
    held_pause = _cut("held", reason="pause:3.80s")
    held_pause.start, held_pause.end, held_pause.replace_gap_sec = 2.5, 3.5, pad
    ws.mutate(
        "before held pause", "after held pause", lambda p: p.edit_decisions.append(held_pause)
    )
    before = ws.path.read_bytes()
    before_model = ws.project.model_dump(mode="json")
    with pytest.raises(ScopeChangedAtApproval) as held:
        EditService(ws).approve(["held"])
    assert (held.value.held[0].reason, held.value.held[0].detail) == ("pause_air", "no_air")
    assert ws.path.read_bytes() == before
    assert ws.project.model_dump(mode="json") == before_model
    assert [e.id for e in load_project(ws.path).edit_decisions] == ["held"]


def test_saved_auto_holds_replay_and_applies_unique_survivor_once(tmp_path: Path):
    ws = _workspace(tmp_path)

    def setup(project: EpisodeProject):
        _replay(project)
        valid = _cut("valid")
        valid.start, valid.end = 3, 4
        project.edit_decisions = [_cut(), valid]

    ws.mutate("before auto", "after auto", setup)
    assert EditService(ws).apply_auto() == 1
    saved = load_project(ws.path)
    assert [e.id for e in saved.edit_decisions] == ["cut"]
    assert saved.timeline.duration_sec == 6
    assert [r.decision_ids for r in saved.editorial.edit_log] == [["valid"]]
    assert EditService(ws).apply_auto() == 0
    assert [e.id for e in ws.project.edit_decisions] == ["cut"]
    assert ws.project.timeline.duration_sec == 6


def test_saved_auto_restarts_after_fresh_scope_hold_without_duplicate_survivor(
    tmp_path: Path, monkeypatch
):
    from podcast_mcp.edits.cut_safety import ResolvedCutScope

    ws = _workspace(tmp_path)
    late = _cut("late")
    late.start, late.end = 3, 4
    mute = _cut("mute")
    mute.type = EditDecisionType.MUTE
    mute.start, mute.end = 1.2, 1.4
    ws.mutate(
        "before auto", "after auto", lambda p: setattr(p, "edit_decisions", [_cut(), late, mute])
    )
    from podcast_mcp.edits import cut_application as decisions
    from podcast_mcp.project import merge as project_merge

    base_model = ws.project.model_dump(mode="json")
    base_files = {
        str(p.relative_to(tmp_path)): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()
    }
    final_fades = decisions._write_join_fades
    failed_archives = []

    def fail_after_final_fades(candidate, selected, **kwargs):
        final_fades(candidate, selected, **kwargs)
        failed_archives.extend(r.decision_ids for r in candidate.editorial.edit_log)
        assert ws.project.model_dump(mode="json") == base_model
        raise RuntimeError("injected after final candidate fades")

    monkeypatch.setattr(decisions, "_write_join_fades", fail_after_final_fades)
    with pytest.raises(RuntimeError, match="injected after final candidate fades"):
        EditService(ws).apply_auto()
    assert failed_archives == [["mute"], ["late"], ["cut"]]
    assert ws.project.model_dump(mode="json") == base_model
    assert {
        str(p.relative_to(tmp_path)): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()
    } == base_files
    monkeypatch.setattr(decisions, "_write_join_fades", final_fades)

    adopted_clips = []
    adopted_pending = []
    adopted_archives = []
    adopt = project_merge.adopt_project_state

    def observe_adoption(destination, candidate):
        adopted_clips.append([c.model_dump(mode="json") for c in candidate.clips])
        adopted_pending.append([e.id for e in candidate.edit_decisions])
        adopted_archives.append([r.model_dump(mode="json") for r in candidate.editorial.edit_log])
        adopt(destination, candidate)

    monkeypatch.setattr(project_merge, "adopt_project_state", observe_adoption)
    observed_durations: set[float] = set()

    def scope(project, _track_id, start, _end, **_kwargs):
        if start == 1:
            observed_durations.add(project.timeline.duration_sec)
            if project.timeline.duration_sec == 5:
                return ResolvedCutScope("speaker_bleed")
        return ResolvedCutScope("session_clear")

    monkeypatch.setattr("podcast_mcp.edits.cut_safety.resolve_cut_scope", scope)
    # the patch changes what a check decides for the same inputs, so entries from before it are stale
    verdict_cache._STORE.clear()
    assert EditService(ws).apply_auto() == 2
    saved = load_project(ws.path)
    assert adopted_clips == [[c.model_dump(mode="json") for c in saved.clips]]
    assert adopted_pending == [[e.id for e in saved.edit_decisions]]
    assert adopted_archives == [[r.model_dump(mode="json") for r in saved.editorial.edit_log]]
    host_left, host_right = [c for c in saved.clips if c.track_id == "host"]
    assert len(host_left.mute_regions) == 1
    assert host_left.mute_regions[0].start_s <= 1.2
    assert host_left.mute_regions[0].end_s >= 1.4
    assert host_left.fade_out_ms > 0
    assert host_right.fade_in_ms > 0
    assert observed_durations == {5}
    assert [e.id for e in saved.edit_decisions] == ["cut"]
    assert [r.decision_ids for r in saved.editorial.edit_log] == [["mute"], ["late"]]
    assert saved.timeline.duration_sec == 5
    assert [(c.source_start, c.source_end, c.timeline_start) for c in saved.clips] == [
        (0, 3, 0),
        (4, 6, 3),
        (0, 3, 0),
        (4, 6, 3),
    ]


def test_auto_restart_excludes_speech_chosen_only_by_freshly_held_punch(
    tmp_path: Path, monkeypatch
):
    from podcast_mcp.edits.cut_safety import ResolvedCutScope

    ws = _workspace(tmp_path)
    punch = _cut("punch", scope="track")
    punch.track_id, punch.start, punch.end, punch.boundary_mode = "guest", 4, 5, None

    def setup(project: EpisodeProject):
        project.clips[1].source_start, project.clips[1].source_end = 3, 6
        project.transcripts.append(
            Transcript(
                track_id="guest",
                words=[TranscriptWord(text="chosen", start=4, end=5)],
            )
        )
        project.edit_decisions = [_cut(), punch]

    ws.mutate("before auto", "after auto", setup)
    before = [(c.source_start, c.source_end, c.timeline_start) for c in ws.project.clips]
    assert cut_placement.inspect_source_remove_placement(ws.project, punch) == (1, 2)

    punch.source_timeline_span = RangeInterval(start=2, end=3)
    ws.mutate(
        "before changed witness",
        "after changed witness",
        lambda p: setattr(p.edit_decisions[1], "source_timeline_span", punch.source_timeline_span),
    )
    peer = room(seed=1510)
    voice(peer, 0, 0.2)
    voice(peer, 4, 5)
    write_wav(tmp_path / "raw/guest.wav", peer)
    monkeypatch.setattr(
        "podcast_mcp.edits.cut_safety.resolve_cut_scope",
        lambda *_args, **_kwargs: ResolvedCutScope("session_clear"),
    )
    assert EditService(ws).apply_auto() == 0
    saved = load_project(ws.path)
    assert [e.id for e in saved.edit_decisions] == ["cut", "punch"]
    assert saved.editorial.edit_log == []
    assert [(c.source_start, c.source_end, c.timeline_start) for c in saved.clips] == before
    assert saved.transcripts[1].words[0].text == "chosen"


def test_rejected_generated_merged_hole_preserves_retained_manual_row(tmp_path: Path):
    from podcast_mcp.edits.transcript_cuts import coalesce_edits

    project = _workspace(tmp_path).project
    project.clips = [
        Clip(id="early", track_id="host", source_start=0, source_end=1.4, timeline_start=0),
        Clip(id="late", track_id="host", source_start=1.42, source_end=6, timeline_start=1.4),
    ]
    manual = _cut("manual", reason="nl:range")
    manual.start, manual.end = 0.4, 1.2
    first, second = _cut("first"), _cut("second")
    first.start, first.end = 1.2, 1.4
    second.start, second.end = 1.42, 1.6
    project.edit_decisions = [manual, first, second]
    expected = manual.model_dump()
    skips: dict[str, int] = {}
    coalesce_edits(
        project, skip_counts=skips, merge_ids={"first", "second"}, defaults=load_defaults()
    )
    assert [e.model_dump() for e in project.edit_decisions] == [expected]
    assert skips == {"source_geometry": 1}


def test_saved_hold_does_not_promise_batch_restore_when_rollback_is_unknown(
    tmp_path: Path, monkeypatch
):
    from podcast_mcp.project.history.rollback import RollbackOutcome

    ws = _workspace(tmp_path)
    ws.mutate(
        "before replay", "after replay", lambda p: (_replay(p), p.edit_decisions.append(_cut()))
    )
    monkeypatch.setattr(
        "podcast_mcp.project.history.rollback.roll_back_history",
        lambda *_args: RollbackOutcome.UNKNOWN,
    )
    with pytest.raises(ScopeChangedAtApproval) as held:
        EditService(ws).approve(["cut"])
    assert held.value.ids == ("cut",)
    assert "None of the selected edits were applied" not in str(held.value)


def test_saved_track_seed_cannot_shrink_away_an_origin_placement_on_another_lane(
    tmp_path: Path, monkeypatch
):
    from podcast_mcp.models.episode import SourceRecording

    ws = _workspace(tmp_path)

    def setup(project: EpisodeProject):
        project.sources.append(SourceRecording(id="host-source", path="raw/host.wav"))
        project.clips[0].source_end = 2
        project.clips.append(
            Clip(
                id="parked-host",
                track_id="guest",
                source_id="host-source",
                source_start=2,
                source_end=6,
                timeline_start=2,
            )
        )
        cut = _cut(scope="track", reason="nl:range")
        cut.end, cut.boundary_mode = 3, None
        project.edit_decisions = [cut]

    ws.mutate("before cross-lane seed", "after cross-lane seed", setup)
    before = ws.path.read_bytes()
    with pytest.raises(ScopeChangedAtApproval) as held:
        EditService(ws).approve(["cut"])
    assert held.value.held[0].reason == "source_geometry"
    assert ws.path.read_bytes() == before
    assert [
        (c.track_id, c.source_start, c.source_end, c.timeline_start) for c in ws.project.clips
    ] == [
        ("host", 0, 2, 0),
        ("guest", 0, 6, 0),
        ("guest", 2, 6, 2),
    ]


def test_a_witnessed_cut_of_a_source_played_twice_is_refused_and_applies_nothing(
    tmp_path, monkeypatch
):
    from podcast_mcp.edits import cut_application

    configure(monkeypatch, defaults())
    ws = _workspace(tmp_path)
    project = ws.project
    project.clips.append(
        Clip(id="host-again", track_id="host", source_start=0, source_end=6, timeline_start=6)
    )
    project.timeline.duration_sec = 12
    edit = _cut()
    edit.source_timeline_span = RangeInterval(start=1, end=2)
    project.edit_decisions = [edit]
    before = project.model_dump(mode="json")
    for intent in (CutIntent.PROGRAMMATIC, CutIntent.HUMAN_BOUNDARIES):
        with pytest.raises(ScopeChangedAtApproval) as held:
            cut_application.approve_edits(
                project, [edit.id], application_intent=intent, defaults=load_defaults()
            )
        assert held.value.held[0].reason == "source_geometry"
        assert project.model_dump(mode="json") == before


def _split_with_crossfade(tmp_path, *, gap=0.0, fade_ms=20, second_end=5.0):
    project = EpisodeProject.create("crossfade split", str(tmp_path))
    project.tracks = [
        Track(
            id="host",
            label="host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=5),
        )
    ]
    project.clips = [
        Clip(id="whole", track_id="host", source_start=0, source_end=5, timeline_start=0)
    ]
    write_wav(tmp_path / "raw/host.wav", room(seconds=5, seed=2035))
    candidate = project.model_copy(deep=True)
    candidate.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0,
            source_end=2.0,
            timeline_start=0,
            fade_out_ms=fade_ms,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=2.0 + gap,
            source_end=second_end,
            timeline_start=2.0,
            fade_in_ms=fade_ms,
            join_in_mode=ClipJoinMode.CROSSFADE,
        ),
    ]
    return project, candidate


def test_a_contiguous_crossfade_split_is_not_a_duplicate(tmp_path):
    project, candidate = _split_with_crossfade(tmp_path)
    effects = cut_effects.completed_audio_effects(
        project, candidate, frozenset({"remove"}), defaults={}
    )
    removals = [
        e
        for e in effects
        if e.join is cut_effects.CutJoin.SPLICE
        and e.end - e.start > cut_effects.SOURCE_GEOMETRY_TOLERANCE_SEC
        and not e.retained
    ]
    assert removals == []


@pytest.mark.parametrize(("gap", "fade_ms"), [(0.01, 20), (0.08, 200)])
def test_a_gapped_crossfade_split_borrows_at_most_half_the_gap_so_it_is_no_duplicate(
    tmp_path, gap, fade_ms
):
    project, candidate = _split_with_crossfade(tmp_path, gap=gap, fade_ms=fade_ms)
    cut_effects.completed_audio_effects(project, candidate, frozenset({"remove"}), defaults={})


@pytest.mark.parametrize("fade_ms", [0, 20])
def test_a_source_range_placed_twice_is_still_a_duplicate(tmp_path, fade_ms):
    project, candidate = _split_with_crossfade(tmp_path, gap=-1.0, fade_ms=fade_ms)
    with pytest.raises(cut_effects.DuplicateSourceOccurrence):
        cut_effects.completed_audio_effects(project, candidate, frozenset({"remove"}), defaults={})


def _clip(clip_id, start, end, at, *, fade_ms=0, join=None):
    return Clip(
        id=clip_id,
        track_id="host",
        source_start=start,
        source_end=end,
        timeline_start=at,
        fade_out_ms=fade_ms if join is None else 0,
        fade_in_ms=fade_ms if join is not None else 0,
        **({"join_in_mode": join} if join is not None else {}),
    )


def _project_pair(tmp_path, before, after):
    # Both projects share one directory so the recordings bind.
    project = EpisodeProject.create("pair", str(tmp_path))
    project.tracks = [
        Track(
            id="host",
            label="host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10),
        )
    ]
    write_wav(tmp_path / "raw/host.wav", room(seconds=10, seed=2035))
    project.clips = before
    candidate = project.model_copy(deep=True)
    candidate.clips = after
    return project, candidate


def test_borrowed_tail_meeting_a_clip_that_is_not_its_partner_is_a_duplicate(tmp_path):
    xfade = ClipJoinMode.CROSSFADE
    a = Clip(
        id="a", track_id="host", source_start=0, source_end=2, timeline_start=0, fade_out_ms=200
    )
    project, candidate = _project_pair(
        tmp_path,
        [Clip(id="w", track_id="host", source_start=0, source_end=9, timeline_start=0)],
        [a, _clip("d", 7, 9, 2, fade_ms=200, join=xfade), _clip("b", 2, 5, 4)],
    )
    with pytest.raises(cut_effects.DuplicateSourceOccurrence):
        cut_effects.completed_audio_effects(project, candidate, frozenset({"remove"}), defaults={})


def _run_duplicate_check(project, candidate):
    return cut_effects.completed_audio_effects(
        project, candidate, frozenset({"remove"}), defaults={}
    )


def _crossfaded_pair():
    return [
        _clip("a", 0, 2, 0, fade_ms=200),
        _clip("b", 2, 5, 2, fade_ms=200, join=ClipJoinMode.CROSSFADE),
    ]


@pytest.mark.parametrize(
    "after",
    [
        pytest.param(
            [*_crossfaded_pair(), _clip("a2", 1.95, 2.05, 6)],
            id="intact_pair_plus_replay_inside_borrowed_tail",
        ),
        pytest.param(
            [_clip("a", 1.95, 2.05, 0), _clip("a2", 1.95, 2.05, 1)], id="two_clips_in_borrowed_zone"
        ),
        pytest.param(
            [_clip("a", 1.5, 2.05, 0), _clip("a2", 1.5, 2.05, 1)], id="two_clips_reaching_past"
        ),
        pytest.param(
            [_clip("a", 0, 2, 0, fade_ms=200), _clip("a2", 1.95, 2.05, 6)], id="full_plus_replay"
        ),
    ],
)
def test_a_replay_inside_a_crossfades_borrowed_zone_is_a_duplicate(tmp_path, after):
    project, candidate = _project_pair(tmp_path, _crossfaded_pair(), after)
    with pytest.raises(cut_effects.DuplicateSourceOccurrence):
        _run_duplicate_check(project, candidate)


def test_partners_with_overlapping_nominal_ends_are_a_duplicate(tmp_path):
    project, candidate = _split_with_crossfade(tmp_path, gap=-1e-3, fade_ms=200)
    with pytest.raises(cut_effects.DuplicateSourceOccurrence):
        _run_duplicate_check(project, candidate)


def test_partners_with_a_source_gap_borrow_only_into_it(tmp_path):
    project, candidate = _split_with_crossfade(tmp_path, gap=1e-3, fade_ms=200)
    _run_duplicate_check(project, candidate)


def _placed(start, end, at, *, reach_in=0.0, reach_out=0.0):
    leaf = SourceAudio(
        path=Path("host.wav"),
        src_start=start,
        src_end=end,
        reach_in=reach_in,
        reach_out=reach_out,
    )
    return PlacedSource(leaf, at, ())


@pytest.mark.parametrize(
    ("shift", "replays"),
    [(0.0, False), (1e-3, True), (-1e-3, True)],
    ids=["blend_placement", "placed_late", "placed_early"],
)
def test_partners_must_sit_where_the_blend_places_them(shift, replays):
    # a plays [0, 2.1) with 0.1 borrowed; b plays [1.9, 5) with 0.1 borrowed; blend overlap 0.2.
    first = _placed(0.0, 2.1, 0.0, reach_out=0.1)
    second = _placed(1.9, 5.0, 1.9 + shift, reach_in=0.1)
    assert cut_effects._replays_source(first, second) is replays
    assert cut_effects._replays_source(second, first) is replays


def test_a_heard_crossfade_tail_is_still_removed_when_the_join_becomes_a_cut(tmp_path):
    xfade = ClipJoinMode.CROSSFADE
    project, candidate = _project_pair(
        tmp_path,
        [_clip("a", 0, 2, 0, fade_ms=200), _clip("b", 2.3, 5, 2, fade_ms=200, join=xfade)],
        [_clip("a", 0, 2, 0), _clip("b", 2.3, 5, 2)],
    )
    effects = cut_effects.completed_audio_effects(
        project, candidate, frozenset({"remove"}), defaults={}
    )
    removals = sorted(
        (round(e.start, 4), round(e.end, 4))
        for e in effects
        if e.join is cut_effects.CutJoin.SPLICE
        and e.end - e.start > cut_effects.SOURCE_GEOMETRY_TOLERANCE_SEC
        and not e.retained
    )
    assert removals == [(2.0, 2.1), (2.2, 2.3)]


@pytest.mark.parametrize(
    ("window", "expected"),
    [
        (None, {"a": (0.0, 5.0), "b": (5.0, 9.0)}),
        ((4.0, 6.0), {"a": (4.0, 5.0), "b": (5.0, 6.0)}),
        ((1.0, 5.0), {"a": (1.0, 5.0)}),
    ],
)
@pytest.mark.parametrize("mode", [ClipJoinMode.CROSSFADE, ClipJoinMode.CUT])
def test_a_placed_leaf_reports_the_clips_own_source_bounds(tmp_path, mode, window, expected):
    project = EpisodeProject.create("nominal", str(tmp_path))
    project.tracks = [
        Track(
            id="host",
            label="host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=100),
        )
    ]
    left = Clip(
        id="a", track_id="host", source_start=10, source_end=15, timeline_start=0, fade_out_ms=200
    )
    right = Clip(
        id="b",
        track_id="host",
        source_start=15,
        source_end=19,
        timeline_start=5,
        fade_in_ms=200,
        join_in_mode=mode,
    )
    audio = placed_track_audio(project, project.tracks[0], [left, right], window=window).audio
    leaves = {leaf.clip_id: leaf for leaf in sources(audio) if not leaf.is_fill}
    assert leaves.keys() == expected.keys()
    for clip_id, (start, end) in expected.items():
        assert leaves[clip_id].nominal_start == pytest.approx(10 + start)
        assert leaves[clip_id].nominal_end == pytest.approx(10 + end)
    if mode is ClipJoinMode.CROSSFADE and window is None:
        assert leaves["a"].src_end > leaves["a"].nominal_end

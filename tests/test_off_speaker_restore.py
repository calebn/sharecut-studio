from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.mute_regions import add_source_mute
from podcast_mcp.edits.off_speaker_mute import OffSpeakerPlan, apply_off_speaker_mutes
from podcast_mcp.models import ClipMuteRegion, RoomToneFill
from test_bleed_restore_core import RATE, _pcm, _project, _render, _restore


def _apply(project):
    plan = OffSpeakerPlan(track_id="host", regions=[{"start": 0.1, "end": 0.9}])
    return apply_off_speaker_mutes(project, plan, defaults=load_defaults())


@pytest.mark.parametrize("fill", [False, True])
@pytest.mark.parametrize("automatic_first", [False, True])
def test_automatic_application_preserves_ordinary_ownership(tmp_path, fill, automatic_first):
    project = _project(tmp_path)
    project.clips = project.clips[:1]
    ordinary = ClipMuteRegion(
        start_s=0.2,
        end_s=0.6,
        fill=RoomToneFill(start_s=0.91, end_s=0.99) if fill else None,
        gain_db=None if fill else -6,
    )
    if automatic_first:
        _apply(project)
    add_source_mute(project.clips[0], ordinary)
    if not automatic_first:
        _apply(project)
    clip = project.clips[0]
    assert clip.mute_regions == [ordinary]
    assert [(r.start_s, r.end_s) for r in clip.off_speaker_mute_regions] == [(0.1, 0.9)]


def test_current_automatic_mute_can_be_restored_without_late_gate(tmp_path: Path):
    project = _project(tmp_path)
    project.clips = project.clips[:1]
    project.tracks[0].transcript_gate = False
    source = _pcm(tmp_path / "source.wav")
    _apply(project)
    baseline = _render(project, tmp_path / "baseline.wav", None)
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.3, 0.6)])
    restored = _render(project, tmp_path / "restored.wav", None)
    assert np.any(
        restored[round(0.35 * RATE) : round(0.55 * RATE)]
        != baseline[round(0.35 * RATE) : round(0.55 * RATE)]
    )
    np.testing.assert_array_equal(
        restored[round(0.35 * RATE) : round(0.55 * RATE)],
        source[round(0.35 * RATE) : round(0.55 * RATE)],
    )
    np.testing.assert_array_equal(restored[: round(0.3 * RATE)], baseline[: round(0.3 * RATE)])
    np.testing.assert_array_equal(restored[round(0.6 * RATE) :], baseline[round(0.6 * RATE) :])


def test_automatic_reapply_keeps_restore_and_has_no_authored_change(tmp_path):
    project = _project(tmp_path)
    _apply(project)
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.3, 0.6)])
    before = project.model_dump(mode="json")
    result = _apply(project)
    assert result["applied_count"] == 0
    assert project.model_dump(mode="json") == before


def test_automatic_full_anchors_survive_split_extract_and_clipboard(tmp_path):
    from podcast_mcp.edits.clips_ops import extract_clips_in_timeline_range, split_clip_at
    from podcast_mcp.edits.timeline_ops import copy_segment, paste_segment
    from podcast_mcp.models import EditMode, EpisodeProject

    project = _project(tmp_path)
    project.clips = project.clips[:1]
    _apply(project)
    clip = EpisodeProject.model_validate_json(project.model_dump_json()).clips[0]
    left, right = split_clip_at(clip, 0.5, defaults=load_defaults())
    extracted = extract_clips_in_timeline_range([clip], 0.3, 0.6)[0]
    clipboard = copy_segment(project, 0.3, 0.6, ["host"])
    paste_segment(
        project,
        1,
        clipboard["duration"],
        clipboard["extracts"],
        mode=EditMode.GAP,
        defaults=load_defaults(),
    )
    pasted = next(c for c in project.clips if c.timeline_start == 1)
    for copy in (left, right, extracted, pasted):
        assert copy.off_speaker_mute_regions == clip.off_speaker_mute_regions
        assert copy.off_speaker_mute_regions[0] is not clip.off_speaker_mute_regions[0]


def test_empty_automatic_collection_preserves_legacy_serialized_detector_and_render_identity(
    tmp_path,
):
    import json

    from podcast_mcp.engines.bleed_gate import bleed_gate_payload
    from podcast_mcp.engines.play_audit import track_render_hash
    from podcast_mcp.models import EpisodeProject

    project = _project(tmp_path)
    old = project.model_dump(mode="json")
    for clip in old["timeline"]["clips"]:
        clip.pop("off_speaker_mute_regions", None)
    identity = track_render_hash(project, "host", defaults=load_defaults())
    detector = bleed_gate_payload(project, "host", defaults=load_defaults())
    for clip in project.clips:
        clip.off_speaker_mute_regions = []
    assert all(not c.off_speaker_mute_regions for c in project.clips)
    roundtrip = EpisodeProject.model_validate_json(json.dumps(old))
    assert track_render_hash(roundtrip, "host", defaults=load_defaults()) == identity
    assert bleed_gate_payload(roundtrip, "host", defaults=load_defaults()) == detector
    assert all(
        "off_speaker_mute_regions" not in clip
        for lane in detector["inputs"]
        for clip in lane["clips"]
    )


@pytest.mark.parametrize("first_rate,selected_rate", [(44100, 48000), (48000, 44100)])
@pytest.mark.parametrize("prepared", ["lower", "room_tone", "gate_fill", "zero"])
@pytest.mark.parametrize("effect", ["", "acompressor", "loudnorm"])
@pytest.mark.parametrize("window", [None, (0.11337, 0.51337)])
def test_automatic_joint_recovery_matches_bounded_pcm_formula(
    tmp_path, monkeypatch, first_rate, selected_rate, prepared, effect, window
):
    import math
    import wave

    from podcast_mcp.engines.audio import MixAudio, SourceAudio, postorder
    from podcast_mcp.engines.bleed_gate import BleedGatePlan
    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.engines.render_clock import read_render_clock
    from podcast_mcp.models import (
        Clip,
        ClipOffSpeakerMuteRegion,
        EpisodeProject,
        MediaAsset,
        ProcessingChain,
        ProcessingEffect,
        SourceRecording,
        Track,
    )

    for rate in (first_rate, selected_rate):
        for name, value in (("bed", 700), ("voice", 7000), ("zero", 0)):
            with wave.open(str(tmp_path / f"{rate}-{name}.wav"), "wb") as target:
                target.setnchannels(2)
                target.setsampwidth(2)
                target.setframerate(rate)
                target.writeframes(np.full((rate, 2), value, dtype="<i2").tobytes())
    project = EpisodeProject.create("automatic", str(tmp_path))
    project.tracks = [
        Track(
            id="host",
            label="Host",
            transcript_gate=True,
            media=MediaAsset(path=f"{first_rate}-voice.wav", duration_sec=1),
        )
    ]
    project.sources = [
        SourceRecording(id="selected", path=f"{selected_rate}-voice.wav", duration_sec=1),
        SourceRecording(id="room", path=f"{first_rate}-bed.wav", duration_sec=1),
    ]
    project.clips = [
        Clip(id="other", track_id="host", source_start=0, source_end=0.8, timeline_start=0),
        Clip(
            id="selected",
            track_id="host",
            source_id="selected",
            source_start=0.01049,
            source_end=0.81049,
            timeline_start=0,
            off_speaker_mute_regions=[
                ClipOffSpeakerMuteRegion(start_s=0.05, end_s=0.75, fade_out_ms=90, fade_in_ms=80)
            ],
        ),
    ]
    selected = project.clips[1]
    if prepared in {"room_tone", "lower", "zero"}:
        selected.mute_regions = [
            ClipMuteRegion(
                start_s=0.05 if prepared == "zero" else 0.2,
                end_s=0.75 if prepared == "zero" else 0.3,
                fade_out_ms=0,
                fade_in_ms=0,
                gain_db=-6 if prepared == "lower" else None,
                fill=RoomToneFill(source_id="room", start_s=0.9, end_s=0.95)
                if prepared == "room_tone"
                else None,
            )
        ]
    if prepared == "gate_fill":
        monkeypatch.setattr(
            "podcast_mcp.engines.timeline_render.current_gate_fill_path",
            lambda *_, **_kw: tmp_path / f"{first_rate}-bed.wav",
        )
    if effect:
        project.processing_chains = [
            ProcessingChain(track_id="host", effects=[ProcessingEffect(effect=effect, params={})])
        ]
    plan = BleedGatePlan(
        attenuation_spans=((0, 3),), fade_sec=0.02, reduction="attenuate", attenuation_db=20
    )
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan", lambda *_, **_kw: plan
    )
    baseline = _render(project, tmp_path / "baseline.wav", window)
    project.clips[1] = _restore(
        selected, tmp_path / f"{selected_rate}-voice.wav", [(0.150013, 0.450017)]
    )
    engine = FFmpegEngine()
    actual_render = engine.render_timeline
    passes, clocks, graphs = [], [], []

    def capture(path, audio, af, **kwargs):
        result = actual_render(path, audio, af, **kwargs)
        passes.append(_pcm(path))
        clocks.append(read_render_clock(kwargs["clock_path"]))
        graphs.append(audio)
        return result

    monkeypatch.setattr(engine, "render_timeline", capture)
    output = tmp_path / "restored.wav"
    if window is None:
        from podcast_mcp.engines.timeline_render import render_track_from_timeline

        render_track_from_timeline(project, project.tracks[0], output, {}, engine=engine)
    else:
        from podcast_mcp.engines.timeline_render import render_track_segment

        render_track_segment(project, "host", *window, output, {}, engine=engine)
    actual = _pcm(output)
    assert len(passes) == 3
    assert clocks[0] == clocks[1] == clocks[2]
    clock = clocks[0]
    nodes = list(postorder(graphs[0]))
    primary = next(
        n for n in nodes if isinstance(n, SourceAudio) and n.clip_id == "selected" and not n.is_fill
    )
    leaf_index = [n for n in nodes if isinstance(n, SourceAudio)].index(primary)
    trim = clock.trims[leaf_index]
    trim_rate = trim.producer.sample_rate
    first_source = math.floor(primary.src_start * trim_rate + 0.5)
    chain = []

    def path(node):
        if node is primary:
            chain.append(node)
            return True
        if isinstance(node, MixAudio):
            children = [node.head.audio, *(at.audio for at in node.tail)]
        elif hasattr(node, "body"):
            children = [node.body]
        else:
            children = []
        if any(path(child) for child in children):
            chain.append(node)
            return True
        return False

    assert path(graphs[0])

    def scale(frame, old, new):
        magnitude = (abs(frame) * new + old // 2) // old
        return magnitude if frame >= 0 else -magnitude

    def output_frame(value):
        frame = math.ceil(value * trim_rate) - first_source
        rate = trim_rate
        frame = scale(frame, rate, trim.consumer.sample_rate)
        rate = trim.consumer.sample_rate
        for node in chain:
            boundary = clock.nodes[nodes.index(node)]
            frame = scale(frame, rate, boundary.producer.sample_rate)
            frame = scale(frame, boundary.producer.sample_rate, boundary.consumer.sample_rate)
            rate = boundary.consumer.sample_rate
        return round((window[0] if window else 0) * clock.output.sample_rate) + scale(
            frame, rate, clock.output.sample_rate
        )

    first, last = output_frame(0.150013), output_frame(0.450017)
    rate = clock.output.sample_rate
    origin = round((window[0] if window else 0) * rate)
    n = np.arange(len(actual)) + origin
    h = np.zeros(len(actual))
    support = (n >= first) & (n < last)
    width = min(round(plan.fade_sec * rate), (last - first) // 2)
    h[support] = np.minimum(
        1, np.minimum((n[support] - first) / width, (last - 1 - n[support]) / width)
    )
    g = plan.gains_for_frames(origin, len(actual), rate)
    u, w, v = (p.astype(np.float64) for p in passes)
    b = (u.astype(np.float32) * g[:, None]).astype("<i2")
    lifted = (w.astype(np.float32) * g[:, None]).astype("<i2")
    correction = h[:, None] * (
        lifted.astype(np.float64) - b.astype(np.float64) + (1 - g)[:, None] * (w - v)
    )
    expected = np.clip(b.astype(np.float64) + correction, -32768, 32767).astype("<i2")
    np.testing.assert_array_equal(baseline, b)
    np.testing.assert_array_equal(actual, expected)
    np.testing.assert_array_equal(actual[~support], baseline[~support])
    if prepared == "zero":
        np.testing.assert_array_equal(passes[0], passes[1])
        np.testing.assert_array_equal(passes[1], passes[2])
        np.testing.assert_array_equal(actual, baseline)
    else:
        assert np.any(actual[support] != baseline[support])


def test_service_adopts_external_commit_then_reapplies_without_extra_history(tmp_path, monkeypatch):
    from podcast_mcp.project.store import load_project, save_project
    from podcast_mcp.services.app.workspace import ProjectWorkspace
    from podcast_mcp.services.document.analysis import AnalysisService
    from podcast_mcp.services.document.history import HistoryService

    project = _project(tmp_path)
    project.clips = project.clips[:1]
    project.ensure_dirs()
    add_source_mute(
        project.clips[0],
        ClipMuteRegion(start_s=0.2, end_s=0.6, fill=RoomToneFill(start_s=0.91, end_s=0.99)),
    )
    path = save_project(project)
    stale = ProjectWorkspace.open(path)
    external = ProjectWorkspace.open(path)
    external.mutate(
        "before rename", "after rename", lambda p: setattr(p.tracks[0], "label", "External label")
    )
    seen = []

    def plan(p, tid, **_):
        seen.append(p.tracks[0].label)
        return OffSpeakerPlan(
            track_id=tid, regions=[{"start": 0.1, "end": 0.9, "duration": 0.8, "audible_sec": 0.8}]
        )

    monkeypatch.setattr("podcast_mcp.edits.off_speaker_mute.plan_off_speaker_mutes", plan)
    result = AnalysisService(stale).mute_off_speaker(track_id="host")
    assert result["applied_count"] == 1
    assert seen == ["External label"]
    assert load_project(path).tracks[0].label == "External label"
    head = stale.project.history.head_id()
    count = len(stale.project.history.entries)
    assert AnalysisService(stale).mute_off_speaker(track_id="host")["applied_count"] == 0
    assert stale.project.history.head_id() == head
    assert len(stale.project.history.entries) == count
    reopened = ProjectWorkspace.open(path)
    assert reopened.project.clips[0].off_speaker_mute_regions
    HistoryService(reopened).undo(expected_head_id=head)
    assert reopened.project.tracks[0].label == "External label"
    assert not reopened.project.clips[0].off_speaker_mute_regions
    assert reopened.project.clips[0].mute_regions == project.clips[0].mute_regions


@pytest.mark.parametrize("restore", [False, True])
def test_lower_under_automatic_remains_muted_outside_explicit_restore(tmp_path, restore):
    project = _project(tmp_path)
    project.clips = project.clips[:1]
    project.tracks[0].transcript_gate = False
    _apply(project)
    add_source_mute(project.clips[0], ClipMuteRegion(start_s=0.2, end_s=0.8, gain_db=-6))
    if restore:
        project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.3, 0.6)])
    actual = _render(project, tmp_path / "lower.wav", None)
    assert np.all(actual[round(0.21 * RATE) : round(0.29 * RATE)] == 0)
    assert np.all(actual[round(0.61 * RATE) : round(0.79 * RATE)] == 0)
    if restore:
        assert np.any(actual[round(0.35 * RATE) : round(0.55 * RATE)] != 0)
    else:
        assert np.all(actual[round(0.35 * RATE) : round(0.55 * RATE)] == 0)


def test_ignored_words_and_hard_mutes_are_retained_inside_restore(tmp_path):
    from podcast_mcp.models import Transcript, TranscriptWord

    project = _project(tmp_path)
    project.clips = project.clips[:1]
    project.tracks[0].transcript_gate = False
    project.transcripts = [
        Transcript(
            track_id="host", words=[TranscriptWord(text="ignore", start=0.3, end=0.4, ignored=True)]
        )
    ]
    _apply(project)
    add_source_mute(project.clips[0], ClipMuteRegion(start_s=0.5, end_s=0.6))
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.2, 0.7)])
    actual = _render(project, tmp_path / "ignored.wav", None)
    assert np.all(actual[round(0.32 * RATE) : round(0.38 * RATE)] == 0)
    assert np.all(actual[round(0.52 * RATE) : round(0.58 * RATE)] == 0)
    assert np.any(actual[round(0.42 * RATE) : round(0.48 * RATE)] != 0)


def test_changed_recording_deactivates_automatic_bypass_without_changing_authored_state(tmp_path):
    project = _project(tmp_path)
    project.clips = project.clips[:1]
    project.tracks[0].transcript_gate = False
    _apply(project)
    baseline = _render(project, tmp_path / "baseline.wav", None)
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.3, 0.6)])
    authored = project.clips[0].model_dump()
    with (tmp_path / "source.wav").open("ab") as stream:
        stream.write(b"different recording identity")
    actual = _render(project, tmp_path / "inactive.wav", None)
    np.testing.assert_array_equal(actual, baseline)
    assert project.clips[0].model_dump() == authored


@pytest.mark.parametrize("gate", ["disabled", "empty"])
def test_automatic_only_restore_uses_two_complete_fx_evaluations(tmp_path, monkeypatch, gate):
    from podcast_mcp.engines.bleed_gate import BleedGatePlan
    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.engines.timeline_render import render_track_from_timeline

    project = _project(tmp_path)
    project.clips = project.clips[:1]
    project.tracks[0].transcript_gate = gate != "disabled"
    _apply(project)
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.3, 0.6)])
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_, **_kw: BleedGatePlan(),
    )
    engine = FFmpegEngine()
    render = engine.render_timeline
    count = []

    def record(*args, **kwargs):
        count.append(1)
        return render(*args, **kwargs)

    monkeypatch.setattr(engine, "render_timeline", record)
    render_track_from_timeline(project, project.tracks[0], tmp_path / "two.wav", {}, engine=engine)
    assert len(count) == 2


@pytest.mark.parametrize("pass_number", [1, 2, 3])
def test_changed_automatic_restore_dependency_keeps_completed_artifact(
    tmp_path, monkeypatch, pass_number
):
    from podcast_mcp.engines.bleed_gate import BleedGatePlan
    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.engines.timeline_render import render_track_from_timeline

    project = _project(tmp_path)
    project.clips = project.clips[:1]
    _apply(project)
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.3, 0.6)])
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_, **_kw: BleedGatePlan(attenuation_spans=((0, 1),)),
    )
    target = tmp_path / "completed.wav"
    target.write_bytes(b"previous complete artifact")
    engine = FFmpegEngine()
    render = engine.render_timeline
    calls = []

    def replace_after_pass(*args, **kwargs):
        result = render(*args, **kwargs)
        calls.append(1)
        if len(calls) == pass_number:
            with (tmp_path / "source.wav").open("ab") as stream:
                stream.write(b"new file revision")
        return result

    monkeypatch.setattr(engine, "render_timeline", replace_after_pass)
    with pytest.raises(ValueError, match="Inputs changed"):
        render_track_from_timeline(project, project.tracks[0], target, {}, engine=engine)
    assert target.read_bytes() == b"previous complete artifact"
    assert len(calls) == pass_number


def test_roll_does_not_union_automatic_ownership_or_restore_into_neighbor(tmp_path):
    from podcast_mcp.edits.clips_ops import roll_clip_join

    project = _project(tmp_path)
    project.clips[0].source_end = 0.5
    project.clips[1].source_start = 0.5
    project.clips[1].timeline_start = 0.5
    _apply(project)
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.3, 0.6)])
    left_masks = project.clips[0].off_speaker_mute_regions.copy()
    right_masks = project.clips[1].off_speaker_mute_regions.copy()
    roll_clip_join(project, "selected", "other", 0.1)
    assert project.clips[0].off_speaker_mute_regions == left_masks
    assert project.clips[1].off_speaker_mute_regions == right_masks
    assert project.clips[1].bleed_restore is None


@pytest.mark.parametrize("rate", [44100, 48000])
def test_split_retains_original_automatic_fades_and_restore_edges(tmp_path, monkeypatch, rate):
    import wave

    from podcast_mcp.edits.clips_ops import split_clip_at
    from podcast_mcp.models import ClipOffSpeakerMuteRegion

    project = _project(tmp_path)
    project.clips = project.clips[:1]
    project.tracks[0].transcript_gate = False
    with wave.open(str(tmp_path / "source.wav"), "wb") as stream:
        stream.setnchannels(2)
        stream.setsampwidth(2)
        stream.setframerate(rate)
        stream.writeframes(np.full((rate, 2), 7000, dtype="<i2").tobytes())
    project.clips[0].off_speaker_mute_regions = [
        ClipOffSpeakerMuteRegion(start_s=0.1, end_s=0.9, fade_out_ms=100, fade_in_ms=100)
    ]
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.3, 0.6)])
    whole = _render(project, tmp_path / "whole.wav", None)
    monkeypatch.setattr("podcast_mcp.edits.clips_ops.join_micro_fade_ms", lambda **_kw: 0)
    project.clips = list(split_clip_at(project.clips[0], 0.45, defaults=load_defaults()))
    split = _render(project, tmp_path / "split.wav", None)
    np.testing.assert_array_equal(split, whole)


def test_overlap_projection_counts_saved_automatic_restore_as_potential_audio(tmp_path):
    from podcast_mcp.engines.session_timeline import same_source_timeline_overlaps
    from podcast_mcp.models import ClipOffSpeakerMuteRegion

    project = _project(tmp_path)
    project.clips[0].off_speaker_mute_regions = [ClipOffSpeakerMuteRegion(start_s=0, end_s=1)]
    assert same_source_timeline_overlaps(project) == []
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.2, 0.6)])
    [stack] = same_source_timeline_overlaps(project)
    assert stack.overlap_sec == 0.4
    add_source_mute(project.clips[0], ClipMuteRegion(start_s=0.2, end_s=0.6))
    assert same_source_timeline_overlaps(project) == []

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.clips_ops import extract_clips_in_timeline_range, split_clip_at
from podcast_mcp.edits.timeline_ops import copy_segment, paste_segment
from podcast_mcp.engines.bleed_gate import BleedGatePlan, bleed_gate_payload
from podcast_mcp.engines.play_audit import track_render_hash
from podcast_mcp.engines.timeline_render import render_track_from_timeline, render_track_segment
from podcast_mcp.models import Clip, ClipMuteRegion, EditMode, EpisodeProject, MediaAsset, Track
from podcast_mcp.util.hashing import sha256_file

RATE = 48000


def _pcm(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as source:
        return np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").reshape(
            -1, source.getnchannels()
        )


def _project(tmp_path: Path) -> EpisodeProject:
    source = tmp_path / "source.wav"
    t = np.arange(RATE) / RATE
    samples = np.column_stack(
        (7000 * np.sin(2 * np.pi * 311 * t), 4500 * np.cos(2 * np.pi * 439 * t))
    ).astype("<i2")
    with wave.open(str(source), "wb") as target:
        target.setnchannels(2)
        target.setsampwidth(2)
        target.setframerate(RATE)
        target.writeframes(samples.tobytes())
    project = EpisodeProject.create("restore", str(tmp_path))
    project.tracks.append(
        Track(
            id="host",
            label="Host",
            media=MediaAsset(path="source.wav", duration_sec=1),
            transcript_gate=True,
        )
    )
    project.clips = [
        Clip(id=name, track_id="host", source_start=0, source_end=1, timeline_start=0)
        for name in ("selected", "other")
    ]
    return project


def _restore(clip: Clip, path: Path, regions: list[tuple[float, float]]) -> Clip:
    return Clip.model_validate(
        {
            **clip.model_dump(),
            "bleed_restore": {
                "source_sha256": sha256_file(path),
                "regions": [{"start_s": s, "end_s": e} for s, e in regions],
            },
        }
    )


def _render(project: EpisodeProject, path: Path, window: tuple[float, float] | None) -> np.ndarray:
    if window is None:
        render_track_from_timeline(project, project.tracks[0], path, {})
    else:
        render_track_segment(project, "host", *window, path, {})
    return _pcm(path)


@pytest.mark.parametrize("window", [None, (0.23, 0.73)])
@pytest.mark.parametrize("compressed", [False, True])
def test_restore_selected_overlap_uses_joint_bus_difference(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    window: tuple[float, float] | None,
    compressed: bool,
) -> None:
    from podcast_mcp.models import ProcessingChain, ProcessingEffect

    project = _project(tmp_path)
    if compressed:
        project.processing_chains.append(
            ProcessingChain(
                track_id="host",
                effects=[
                    ProcessingEffect(effect="acompressor", params={"threshold_db": -24, "ratio": 8})
                ],
            )
        )
    if window:
        project.tracks[0].gain_db = -3
    plan = BleedGatePlan(
        attenuation_spans=((0.1, 0.9),), fade_sec=0.02, reduction="attenuate", attenuation_db=20
    )
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    baseline = _render(project, tmp_path / "baseline.wav", window)
    project.tracks[0].transcript_gate = False
    whole = _render(project, tmp_path / "whole.wav", window)
    project.clips[0].mute_regions = [
        ClipMuteRegion(start_s=0.2, end_s=0.6, fade_in_ms=0, fade_out_ms=0)
    ]
    without = _render(project, tmp_path / "without.wav", window)
    project.clips[0].mute_regions = []
    project.tracks[0].transcript_gate = True
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.2, 0.6)])
    restored = _render(project, tmp_path / "restored.wav", window)
    origin = round((window[0] if window else 0) * RATE)
    frames = np.arange(len(whole)) + origin
    h = np.zeros(len(whole))
    selected = (frames >= 0.2 * RATE) & (frames < 0.6 * RATE)
    h[selected] = np.minimum(
        1,
        np.minimum(
            (frames[selected] - round(0.2 * RATE)) / round(0.02 * RATE),
            (round(0.6 * RATE) - 1 - frames[selected]) / round(0.02 * RATE),
        ),
    )
    gains = plan.gains_for_frames(origin, len(whole), RATE)
    expected = np.clip(
        baseline.astype(np.float64)
        + ((1 - gains) * h)[:, None] * (whole.astype(np.float64) - without.astype(np.float64)),
        -32768,
        32767,
    ).astype("<i2")
    assert np.any(restored[selected] != baseline[selected])
    np.testing.assert_array_equal(restored, expected)
    np.testing.assert_array_equal(restored[~selected], baseline[~selected])
    if not compressed and window is None:
        source = _pcm(tmp_path / "source.wav")[12000:27000].astype(np.float64)
        selected_plus_reduced_copy = source + (source * 0.1).astype("<i2")
        np.testing.assert_allclose(restored[12000:27000], selected_plus_reduced_copy, atol=1)


def test_restore_roundtrip_canonical_intervals_and_independent_lifecycle(tmp_path: Path) -> None:
    project = _project(tmp_path)
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.4, 0.7), (0.2, 0.4)])
    restored = EpisodeProject.model_validate_json(project.model_dump_json()).clips[0]
    assert restored.model_dump()["bleed_restore"]["regions"] == [{"start_s": 0.2, "end_s": 0.7}]
    left, right = split_clip_at(restored, 0.5, defaults=load_defaults())
    assert (
        left.bleed_restore.regions == right.bleed_restore.regions == restored.bleed_restore.regions
    )
    assert left.bleed_restore is not right.bleed_restore
    extracted = extract_clips_in_timeline_range([restored], 0.3, 0.6)[0]
    assert extracted.bleed_restore == restored.bleed_restore
    assert extracted.bleed_restore is not restored.bleed_restore
    clipboard = copy_segment(project, 0.3, 0.6, ["host"])
    paste_segment(
        project,
        1,
        clipboard["duration"],
        clipboard["extracts"],
        mode=EditMode.GAP,
        defaults=load_defaults(),
    )
    pasted = next(c for c in project.clips if c.timeline_start == 1 and c.bleed_restore)
    assert pasted.bleed_restore == restored.bleed_restore
    assert pasted.bleed_restore is not project.clips[0].bleed_restore


def test_restoration_changes_render_identity_without_changing_detector_inputs(
    tmp_path: Path,
) -> None:
    project = _project(tmp_path)
    acoustic = bleed_gate_payload(project, "host", defaults=load_defaults())
    render_hash = track_render_hash(project, "host", defaults=load_defaults())
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.2, 0.6)])
    assert track_render_hash(project, "host", defaults=load_defaults()) != render_hash
    assert bleed_gate_payload(project, "host", defaults=load_defaults()) == acoustic


@pytest.mark.parametrize("case", ["disabled", "empty", "outside", "changed_bytes"])
def test_inactive_restore_keeps_legacy_pcm_exact(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, case: str
) -> None:
    project = _project(tmp_path)
    plan = BleedGatePlan(attenuation_spans=((0.1, 0.9),), fade_sec=0.03)
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    if case == "disabled":
        project.tracks[0].transcript_gate = False
    baseline = _render(project, tmp_path / "baseline.wav", None)
    regions = [] if case == "empty" else [(0.91, 0.99)] if case == "outside" else [(0.2, 0.6)]
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", regions)
    if case == "changed_bytes":
        with (tmp_path / "source.wav").open("ab") as source:
            source.write(b"changed recording bytes")
    restored = _render(project, tmp_path / "restored.wav", None)
    np.testing.assert_array_equal(restored, baseline)


def test_same_recording_bytes_survive_relocation_and_source_pinning(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.edits.clips_ops import move_clips

    project = _project(tmp_path)
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.2, 0.6)])
    plan = BleedGatePlan(attenuation_spans=((0.1, 0.9),))
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    original = _render(project, tmp_path / "original.wav", None)
    (tmp_path / "relocated.wav").write_bytes((tmp_path / "source.wav").read_bytes())
    project.tracks[0].media.path = "relocated.wav"
    relocated = _render(project, tmp_path / "relocated-out.wav", None)
    np.testing.assert_array_equal(relocated, original)
    project.tracks.append(
        Track(
            id="destination",
            label="Destination",
            media=MediaAsset(path="source.wav"),
            transcript_gate=True,
        )
    )
    move_clips(project, [{"clip_id": "selected", "timeline_start": 0, "track_id": "destination"}])
    assert project.clips[0].source_id is not None
    render_track_from_timeline(project, project.tracks[1], tmp_path / "moved.wav", {})
    moved = _pcm(tmp_path / "moved.wav")
    source = _pcm(tmp_path / "source.wav")
    np.testing.assert_array_equal(moved[15000:20000], source[15000:20000])


@pytest.mark.parametrize("compressed", [False, True])
def test_joint_choices_union_adjacent_source_regions_before_one_ramp(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, compressed: bool
) -> None:
    from podcast_mcp.models import ProcessingChain, ProcessingEffect

    project = _project(tmp_path)
    if compressed:
        project.processing_chains.append(
            ProcessingChain(
                track_id="host",
                effects=[
                    ProcessingEffect(effect="acompressor", params={"threshold_db": -24, "ratio": 8})
                ],
            )
        )
    plan = BleedGatePlan(attenuation_spans=((0, 1),), fade_sec=0.03)
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    baseline = _render(project, tmp_path / "baseline.wav", None)
    for index in range(2):
        project.clips[index] = _restore(
            project.clips[index], tmp_path / "source.wav", [(0.2, 0.4), (0.4, 0.6), (0.3, 0.5)]
        )
    joint = _render(project, tmp_path / "joint.wav", None)
    project.tracks[0].transcript_gate = False
    whole = _render(project, tmp_path / "whole.wav", None)
    np.testing.assert_array_equal(joint[12000:27000], whole[12000:27000])
    np.testing.assert_array_equal(joint[:9000], baseline[:9000])
    np.testing.assert_array_equal(joint[30000:], baseline[30000:])


def test_split_preserves_original_restore_ramps_with_only_authored_microfades(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.edits.clips_ops import join_micro_fade_ms
    from podcast_mcp.models import ClipJoinMode

    project = _project(tmp_path)
    project.clips = [_restore(project.clips[0], tmp_path / "source.wav", [(0.2, 0.8)])]
    plan = BleedGatePlan(attenuation_spans=((0, 1),), fade_sec=0.04)
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    unsplit = _render(project, tmp_path / "unsplit.wav", None)
    project.clips = list(split_clip_at(project.clips[0], 0.5, defaults=load_defaults()))
    split = _render(project, tmp_path / "split.wav", None)
    radius = round(join_micro_fade_ms(defaults=load_defaults()) / 1000 * RATE) + 1
    np.testing.assert_array_equal(split[: RATE // 2 - radius], unsplit[: RATE // 2 - radius])
    np.testing.assert_array_equal(split[RATE // 2 + radius :], unsplit[RATE // 2 + radius :])
    assert np.any(split != unsplit)
    project.clips[1].join_in_mode = ClipJoinMode.CUT
    equivalent = _render(project, tmp_path / "equivalent.wav", None)
    np.testing.assert_array_equal(equivalent, unsplit)


def test_render_counterfactual_failure_preserves_output_and_removes_temporary_audio(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.engines.audio import MaskAudio, postorder
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    project = _project(tmp_path)
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.2, 0.6)])
    plan = BleedGatePlan(attenuation_spans=((0, 1),))
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    target = tmp_path / "output.wav"
    target.write_bytes(b"previous completed artifact")
    engine = FFmpegEngine()
    real_render = engine.render_timeline

    def fail_counterfactual(path, audio, af, **kwargs):
        if any(isinstance(node, MaskAudio) for node in postorder(audio)):
            path.write_bytes(b"partial counterfactual")
            raise RuntimeError("counterfactual failed")
        return real_render(path, audio, af, **kwargs)

    monkeypatch.setattr(engine, "render_timeline", fail_counterfactual)
    with pytest.raises(RuntimeError, match="counterfactual failed"):
        render_track_from_timeline(project, project.tracks[0], target, {}, engine=engine)
    assert target.read_bytes() == b"previous completed artifact"
    assert not list(tmp_path.glob(".bleed-restore-*"))


def test_restore_pcm_widens_subtraction_saturates_and_preserves_zero_corrections() -> None:
    from podcast_mcp.edits.bleed_restore import restored_pcm

    baseline = np.array([[30000, -30000], [123, -456], [32767, -32768]], dtype="<i2")
    whole = np.array([[32767, -32768], [123, -456], [32767, -32768]], dtype="<i2")
    without = np.array([[-32768, 32767], [-32768, 32767], [-32768, 32767]], dtype="<i2")
    actual = restored_pcm(
        baseline.tobytes(),
        whole.tobytes(),
        without.tobytes(),
        channels=2,
        gate_gains=np.array([0, 0, 1], dtype=np.float32),
        restore_gains=np.array([1, 0, 1]),
    )
    expected = np.array([[32767, -32768], [123, -456], [32767, -32768]], dtype="<i2")
    assert actual == expected.tobytes()


def test_narrow_restore_ramp_uses_saved_bounds_and_caps_each_edge() -> None:
    from podcast_mcp.edits.bleed_restore import RestoreSupport, restore_gains_for_frames

    support = (
        RestoreSupport(
            saved_first_frame=100,
            saved_last_frame=108,
            active_first_frame=100,
            active_last_frame=108,
            source_first_frame=0,
            source_rate=1000,
            placement_frame=0,
            placement_rate=1000,
        ),
    )
    gains = restore_gains_for_frames(support, 100, 8, 1000, fade_sec=0.02)
    np.testing.assert_array_equal(gains, [0, 0.25, 0.5, 0.75, 0.75, 0.5, 0.25, 0])
    np.testing.assert_array_equal(
        restore_gains_for_frames(support, 103, 3, 1000, fade_sec=0.02), gains[3:6]
    )


def test_restore_keeps_cached_automatic_plan_identity(tmp_path: Path) -> None:
    from podcast_mcp.engines.bleed_gate import build_bleed_gate_plan

    project = _project(tmp_path)
    before = build_bleed_gate_plan(project, "host", defaults=load_defaults())
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.2, 0.6)])
    after = build_bleed_gate_plan(project, "host", defaults=load_defaults())
    assert after is before


def test_roll_does_not_transfer_restore_and_trim_retains_hidden_choices(tmp_path: Path) -> None:
    from podcast_mcp.edits.clips_ops import roll_clip_join
    from podcast_mcp.edits.ripple import apply_trim_geometry, plan_trim

    project = _project(tmp_path)
    left, right = split_clip_at(
        _restore(project.clips[0], tmp_path / "source.wav", [(0.2, 0.8)]),
        0.5,
        defaults=load_defaults(),
    )
    right.bleed_restore = None
    project.clips = [left, right]
    roll_clip_join(project, left.id, right.id, -0.1)
    assert left.bleed_restore is not None
    assert right.bleed_restore is None
    project.clips = [left]
    apply_trim_geometry(
        project, plan_trim(project, left.id, "out", 0.15, EditMode.GAP), defaults=load_defaults()
    )
    assert project.clips[0].source_end == 0.15
    assert project.clips[0].bleed_restore.regions[0].end_s == 0.8
    apply_trim_geometry(
        project, plan_trim(project, left.id, "out", 0.9, EditMode.GAP), defaults=load_defaults()
    )
    assert project.clips[0].source_end == 0.9
    assert project.clips[0].bleed_restore.regions[0].end_s == 0.8


def test_history_snapshot_roundtrip_restores_clip_choice(tmp_path: Path) -> None:
    from podcast_mcp.project.history.manager import apply_snapshot_to_project, snapshot_from_project

    project = _project(tmp_path)
    before = snapshot_from_project(project)
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.2, 0.6)])
    after = snapshot_from_project(project)
    apply_snapshot_to_project(project, before)
    assert project.clips[0].bleed_restore is None
    apply_snapshot_to_project(project, after)
    assert project.clips[0].bleed_restore.source_sha256 == sha256_file(tmp_path / "source.wav")
    assert project.clips[0].bleed_restore.regions[0].start_s == 0.2


def test_secondary_recording_restores_only_its_selected_occurrence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.models import SourceRecording

    project = _project(tmp_path)
    source = _pcm(tmp_path / "source.wav")
    secondary = (source.astype(np.int32) // 3).astype("<i2")
    with wave.open(str(tmp_path / "secondary.wav"), "wb") as target:
        target.setnchannels(2)
        target.setsampwidth(2)
        target.setframerate(RATE)
        target.writeframes(secondary.tobytes())
    project.sources.append(SourceRecording(id="second", path="secondary.wav", duration_sec=1))
    project.clips[0].source_id = "second"
    project.clips[0] = _restore(project.clips[0], tmp_path / "secondary.wav", [(0.2, 0.6)])
    project.clips.append(
        Clip(
            id="repeated-secondary",
            track_id="host",
            source_start=0,
            source_end=1,
            timeline_start=0,
            source_id="second",
        )
    )
    plan = BleedGatePlan(attenuation_spans=((0, 1),), fade_sec=0.02)
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    restored = _render(project, tmp_path / "restored.wav", None)
    np.testing.assert_array_equal(restored[12000:27000], secondary[12000:27000])
    assert np.any(restored[12000:27000] != 2 * secondary[12000:27000])


def test_restore_removes_prepared_room_tone_fill_with_the_selected_body(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.models import RoomToneFill

    project = _project(tmp_path)
    project.clips[0].mute_regions = [
        ClipMuteRegion(
            start_s=0.2,
            end_s=0.6,
            fade_in_ms=0,
            fade_out_ms=0,
            fill=RoomToneFill(start_s=0.7, end_s=0.8),
        )
    ]
    project.tracks[0].transcript_gate = False
    reference = _render(project, tmp_path / "reference.wav", None)
    project.clips[1].mute_regions = [
        ClipMuteRegion(start_s=0.2, end_s=0.6, fade_in_ms=0, fade_out_ms=0)
    ]
    selected_only = _render(project, tmp_path / "selected-only.wav", None)
    project.clips[1].mute_regions = []
    project.tracks[0].transcript_gate = True
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.2, 0.6)])
    plan = BleedGatePlan(attenuation_spans=((0, 1),), fade_sec=0.02)
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    restored = _render(project, tmp_path / "restored.wav", None)
    np.testing.assert_array_equal(restored[12000:27000], selected_only[12000:27000])
    assert np.any(restored[12000:27000] != reference[12000:27000])


@pytest.mark.parametrize(
    "restore",
    [
        {"source_sha256": "invalid", "regions": []},
        {"source_sha256": "a" * 64, "regions": [{"start_s": -0.1, "end_s": 0.2}]},
        {"source_sha256": "a" * 64, "regions": [{"start_s": 0.2, "end_s": 0.2}]},
        {"source_sha256": "a" * 64, "regions": [{"start_s": 0.2, "end_s": float("inf")}]},
    ],
)
def test_clip_boundary_rejects_invalid_restore(restore: dict) -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        Clip.model_validate(
            {
                "id": "clip",
                "track_id": "host",
                "source_start": 0,
                "source_end": 1,
                "timeline_start": 0,
                "bleed_restore": restore,
            }
        )


def test_invalid_restore_clipboard_refuses_without_mutating_project(tmp_path: Path) -> None:
    from podcast_mcp.edits.timeline_ops import PasteRejectedError

    project = _project(tmp_path)
    clipboard = copy_segment(project, 0.3, 0.6, ["host"])
    clipboard["extracts"][0]["bleed_restore"] = {"source_sha256": "invalid", "regions": []}
    before = project.model_dump_json()
    with pytest.raises(PasteRejectedError):
        paste_segment(
            project,
            1,
            clipboard["duration"],
            clipboard["extracts"],
            mode=EditMode.GAP,
            defaults=load_defaults(),
        )
    assert project.model_dump_json() == before


@pytest.mark.parametrize(
    "window, source_first, delay", [(None, 504, 4800), ((0.13749, 0.73749), 2280, 0)]
)
def test_fractional_restore_uses_prepared_sample_clock(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    window: tuple[float, float] | None,
    source_first: int,
    delay: int,
) -> None:
    project = _project(tmp_path)
    with wave.open(str(tmp_path / "source.wav"), "wb") as target:
        target.setnchannels(2)
        target.setsampwidth(2)
        target.setframerate(RATE)
        target.writeframes(np.full((RATE, 2), 10000, dtype="<i2").tobytes())
    project.clips = [
        Clip(
            id="selected",
            track_id="host",
            source_start=0.01049,
            source_end=1,
            timeline_start=0.10049,
        )
    ]
    plan = BleedGatePlan(attenuation_spans=((0, 2),), fade_sec=0.02)
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    baseline = _render(project, tmp_path / "baseline.wav", window)
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.2, 0.6)])
    restored = _render(project, tmp_path / "restored.wav", window)
    first, last = delay + 9600 - source_first, delay + 28800 - source_first
    positions = np.arange(last - first)
    h = np.minimum(1, np.minimum(positions / 960, (last - first - 1 - positions) / 960))
    expected = baseline.copy()
    expected[first:last] = (10000 * h[:, None]).astype("<i2")
    np.testing.assert_array_equal(restored, expected)


def test_content_memo_observes_atomic_replacement_with_same_size_and_mtime(tmp_path: Path) -> None:
    import os

    from podcast_mcp.edits.bleed_restore import active_restore_regions
    from podcast_mcp.util.batch_scope import batch_scope

    project = _project(tmp_path)
    source = tmp_path / "source.wav"
    clip = _restore(project.clips[0], source, [(0.2, 0.6)])
    previous = source.stat()
    replacement = tmp_path / "replacement.wav"
    replacement.write_bytes(source.read_bytes()[:-2] + b"\x00\x00")
    os.utime(replacement, ns=(previous.st_atime_ns, previous.st_mtime_ns))
    with batch_scope():
        assert active_restore_regions(clip, source)
        replacement.replace(source)
        assert sha256_file(source) != clip.bleed_restore.source_sha256
        assert active_restore_regions(clip, source) == ()


@pytest.mark.parametrize("stage", ["after_hash", "after_whole", "after_correction"])
@pytest.mark.parametrize("destination", ["stem", "segment"])
def test_media_change_refuses_restore_publication_preserving_prior_artifacts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stage: str, destination: str
) -> None:
    from podcast_mcp.engines import transcript_gated_play
    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.engines.play_audit import publish_stem, stem_hash_path
    from podcast_mcp.util.coded_error import CodedValueError
    from podcast_mcp.util.project_state import render_lock
    from podcast_mcp.util.tracks import stem_path

    project = _project(tmp_path)
    source = tmp_path / "source.wav"
    plan = BleedGatePlan(attenuation_spans=((0, 1),), fade_sec=0.02)
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    with render_lock(project):
        publish_stem(
            project,
            "host",
            lambda target: render_track_from_timeline(project, project.tracks[0], target, {}),
            defaults=load_defaults(),
        )
    project.clips[0] = _restore(project.clips[0], source, [(0.2, 0.6)])
    target = stem_path(project, "host") if destination == "stem" else tmp_path / "segment.wav"
    if destination == "segment":
        target.write_bytes(b"previous complete segment")
        project.tracks[0].gain_db = -3
    previous_audio = target.read_bytes()
    previous_hash = stem_hash_path(project, "host").read_bytes()

    def replace_source() -> None:
        replacement = tmp_path / "replacement.wav"
        replacement.write_bytes(source.read_bytes()[:-4] + b"\x01\x00\x02\x00")
        replacement.replace(source)

    engine = FFmpegEngine()
    if stage == "after_hash":
        real_hash = sha256_file

        def change_after_hash(path: Path) -> str:
            digest = real_hash(path)
            replace_source()
            return digest

        monkeypatch.setattr("podcast_mcp.edits.bleed_restore.sha256_file", change_after_hash)
    elif stage == "after_whole":
        real_render = engine.render_timeline

        def change_after_render(path, audio, af, **kwargs):
            result = real_render(path, audio, af, **kwargs)
            if path.name.startswith("whole"):
                replace_source()
            return result

        monkeypatch.setattr(engine, "render_timeline", change_after_render)
    else:
        real_correct = transcript_gated_play.apply_restored_bleed_gate_plan

        def change_after_correction(*args, **kwargs):
            result = real_correct(*args, **kwargs)
            replace_source()
            return result

        monkeypatch.setattr(
            transcript_gated_play, "apply_restored_bleed_gate_plan", change_after_correction
        )
    with pytest.raises(CodedValueError, match="changed"):
        with render_lock(project):
            if destination == "stem":
                publish_stem(
                    project,
                    "host",
                    lambda output: render_track_from_timeline(
                        project, project.tracks[0], output, {}, engine=engine
                    ),
                    defaults=load_defaults(),
                )
            else:
                render_track_segment(project, "host", 0.23, 0.73, target, {}, engine=engine)
    assert target.read_bytes() == previous_audio
    assert stem_hash_path(project, "host").read_bytes() == previous_hash
    assert not list(tmp_path.rglob(".bleed-restore-*"))
    assert not list(tmp_path.rglob("*.partial.wav"))


@pytest.mark.parametrize("crossfade", [False, True])
def test_restore_clock_accounts_for_fractional_concat_and_crossfade(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, crossfade: bool
) -> None:
    from podcast_mcp.models import ClipJoinMode

    project = _project(tmp_path)
    with wave.open(str(tmp_path / "source.wav"), "wb") as target:
        target.setnchannels(2)
        target.setsampwidth(2)
        target.setframerate(RATE)
        target.writeframes(np.full((RATE, 2), 10000, dtype="<i2").tobytes())
    project.clips = [
        Clip(
            id="before",
            track_id="host",
            source_start=0.00049,
            source_end=0.20050,
            timeline_start=0,
            fade_out_ms=20 if crossfade else 0,
        ),
        Clip(
            id="selected",
            track_id="host",
            source_start=0.01049,
            source_end=0.41049,
            timeline_start=0.20001,
            fade_in_ms=20 if crossfade else 0,
            join_in_mode=ClipJoinMode.CROSSFADE if crossfade else ClipJoinMode.FADE,
        ),
    ]
    plan = BleedGatePlan(attenuation_spans=((0, 2),), fade_sec=0.02)
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    baseline = _render(project, tmp_path / "baseline.wav", None)
    project.clips[1] = _restore(project.clips[1], tmp_path / "source.wav", [(0.2, 0.3)])
    restored = _render(project, tmp_path / "restored.wav", None)
    body_first = 9600 - (960 if crossfade else 0)
    first, last = body_first + 9600 - 504, body_first + 14400 - 504
    h = np.minimum(
        1,
        np.minimum(
            np.arange(last - first) / 960, (last - first - 1 - np.arange(last - first)) / 960
        ),
    )
    expected = baseline.copy()
    expected[first:last] = (10000 * h[:, None]).astype("<i2")
    np.testing.assert_array_equal(restored, expected)


def test_restore_policy_revision_changes_only_restore_render_identities(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path)
    ordinary_hash = track_render_hash(project, "host", defaults=load_defaults())
    monkeypatch.setattr("podcast_mcp.engines.play_audit.RESTORE_RENDER_REV", 9)
    assert track_render_hash(project, "host", defaults=load_defaults()) == ordinary_hash
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.2, 0.6)])
    restored_hash = track_render_hash(project, "host", defaults=load_defaults())
    monkeypatch.setattr("podcast_mcp.engines.play_audit.RESTORE_RENDER_REV", 10)
    assert track_render_hash(project, "host", defaults=load_defaults()) != restored_hash
    project.clips[0].bleed_restore = None
    assert track_render_hash(project, "host", defaults=load_defaults()) == ordinary_hash


@pytest.mark.parametrize("dependency", ["unselected", "fill", "peer"])
def test_restore_revalidates_all_bus_fill_and_gate_inputs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, dependency: str
) -> None:
    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.engines.play_audit import publish_stem, stem_hash_path
    from podcast_mcp.models import RoomToneFill, SourceRecording
    from podcast_mcp.util.coded_error import CodedValueError
    from podcast_mcp.util.project_state import render_lock
    from podcast_mcp.util.tracks import stem_path

    project = _project(tmp_path)
    changed_path = tmp_path / "dependency.wav"
    changed_path.write_bytes((tmp_path / "source.wav").read_bytes())
    if dependency == "peer":
        project.tracks.append(
            Track(id="peer", label="Peer", media=MediaAsset(path="dependency.wav", duration_sec=1))
        )
    else:
        project.sources.append(
            SourceRecording(id="dependency", path="dependency.wav", duration_sec=1)
        )
        if dependency == "unselected":
            project.clips[1].source_id = "dependency"
        else:
            project.clips[1].mute_regions = [
                ClipMuteRegion(
                    start_s=0.2,
                    end_s=0.6,
                    fill=RoomToneFill(start_s=0.1, end_s=0.2, source_id="dependency"),
                )
            ]
    plan = BleedGatePlan(attenuation_spans=((0, 1),), fade_sec=0.02)
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    with render_lock(project):
        publish_stem(
            project,
            "host",
            lambda target: render_track_from_timeline(project, project.tracks[0], target, {}),
            defaults=load_defaults(),
        )
    previous_audio = stem_path(project, "host").read_bytes()
    previous_hash = stem_hash_path(project, "host").read_bytes()
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.2, 0.6)])
    engine = FFmpegEngine()
    real_render = engine.render_timeline

    def replace_after_whole(path, audio, af, **kwargs):
        result = real_render(path, audio, af, **kwargs)
        if path.name == "whole.wav":
            replacement = tmp_path / "replacement.wav"
            replacement.write_bytes(changed_path.read_bytes()[:-4] + b"\x01\x00\x02\x00")
            replacement.replace(changed_path)
        return result

    monkeypatch.setattr(engine, "render_timeline", replace_after_whole)
    with pytest.raises(CodedValueError, match="changed"):
        with render_lock(project):
            publish_stem(
                project,
                "host",
                lambda target: render_track_from_timeline(
                    project, project.tracks[0], target, {}, engine=engine
                ),
                defaults=load_defaults(),
            )
    assert stem_path(project, "host").read_bytes() == previous_audio
    assert stem_hash_path(project, "host").read_bytes() == previous_hash


def test_stem_publisher_refuses_media_change_after_renderer_returns(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.engines.play_audit import publish_stem, stem_hash_path
    from podcast_mcp.util.coded_error import CodedValueError
    from podcast_mcp.util.project_state import render_lock
    from podcast_mcp.util.tracks import stem_path

    project = _project(tmp_path)
    plan = BleedGatePlan(attenuation_spans=((0, 1),))
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    with render_lock(project):
        publish_stem(
            project,
            "host",
            lambda target: render_track_from_timeline(project, project.tracks[0], target, {}),
            defaults=load_defaults(),
        )
    previous = (
        stem_path(project, "host").read_bytes(),
        stem_hash_path(project, "host").read_bytes(),
    )
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.2, 0.6)])

    def render_then_change(target: Path) -> None:
        render_track_from_timeline(project, project.tracks[0], target, {})
        source = tmp_path / "source.wav"
        replacement = tmp_path / "replacement.wav"
        replacement.write_bytes(source.read_bytes()[:-4] + b"\x01\x00\x02\x00")
        replacement.replace(source)

    with pytest.raises(CodedValueError, match="changed"):
        with render_lock(project):
            publish_stem(project, "host", render_then_change, defaults=load_defaults())
    assert (
        stem_path(project, "host").read_bytes(),
        stem_hash_path(project, "host").read_bytes(),
    ) == previous
    assert not list(tmp_path.rglob("*.partial.wav"))


def test_fractional_restore_at_44100_hz_uses_native_sample_origin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path)
    rate = 44100
    with wave.open(str(tmp_path / "source.wav"), "wb") as target:
        target.setnchannels(2)
        target.setsampwidth(2)
        target.setframerate(rate)
        target.writeframes(np.full((rate, 2), 10000, dtype="<i2").tobytes())
    project.clips = [
        Clip(
            id="selected",
            track_id="host",
            source_start=0.01049,
            source_end=1,
            timeline_start=0.10049,
        )
    ]
    plan = BleedGatePlan(attenuation_spans=((0, 2),), fade_sec=0.02)
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    baseline = _render(project, tmp_path / "baseline.wav", None)
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.2, 0.6)])
    restored = _render(project, tmp_path / "restored.wav", None)
    first, last = 4410 + 8820 - 463, 4410 + 26460 - 463
    positions = np.arange(last - first)
    h = np.minimum(1, np.minimum(positions / 882, (last - first - 1 - positions) / 882))
    expected = baseline.copy()
    expected[first:last] = (10000 * h[:, None]).astype("<i2")
    np.testing.assert_array_equal(restored, expected)


def test_mixed_rate_concat_restoration_matches_independent_masked_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.models import SourceRecording

    project = _project(tmp_path)
    secondary = np.full((44100, 2), 10000, dtype="<i2")
    for name, samples in [("secondary.wav", secondary), ("masked.wav", secondary.copy())]:
        if name == "masked.wav":
            samples[8820:13230] = 0
        with wave.open(str(tmp_path / name), "wb") as target:
            target.setnchannels(2)
            target.setsampwidth(2)
            target.setframerate(44100)
            target.writeframes(samples.tobytes())
    project.sources.append(SourceRecording(id="second", path="secondary.wav", duration_sec=1))
    project.clips = [
        Clip(
            id="before", track_id="host", source_start=0.00049, source_end=0.20050, timeline_start=0
        ),
        Clip(
            id="selected",
            track_id="host",
            source_start=0.01049,
            source_end=0.41049,
            timeline_start=0.20001,
            source_id="second",
        ),
    ]
    plan = BleedGatePlan(attenuation_spans=((0, 2),), fade_sec=0.02)
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    baseline = _render(project, tmp_path / "baseline.wav", None)
    project.tracks[0].transcript_gate = False
    whole = _render(project, tmp_path / "whole.wav", None)
    project.sources[0].path = "masked.wav"
    without = _render(project, tmp_path / "without.wav", None)
    project.sources[0].path = "secondary.wav"
    project.tracks[0].transcript_gate = True
    project.clips[1] = _restore(project.clips[1], tmp_path / "secondary.wav", [(0.2, 0.3)])
    restored = _render(project, tmp_path / "restored.wav", None)
    first, last = 18696, 23496
    positions = np.arange(last - first)
    h = np.minimum(1, np.minimum(positions / 960, (last - first - 1 - positions) / 960))
    expected = baseline.copy()
    expected[first:last] = (
        h[:, None] * (whole[first:last].astype(np.float64) - without[first:last].astype(np.float64))
    ).astype("<i2")
    np.testing.assert_array_equal(restored[:first], baseline[:first])
    np.testing.assert_array_equal(restored[last:], baseline[last:])
    np.testing.assert_allclose(restored, expected, atol=1)


def test_stem_hash_uses_validated_fingerprint_if_media_changes_after_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.engines import play_audit
    from podcast_mcp.util.project_state import render_lock

    project = _project(tmp_path)
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.2, 0.6)])
    expected_hash = track_render_hash(project, "host", defaults=load_defaults())
    plan = BleedGatePlan(attenuation_spans=((0, 1),))
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    real_write_hash = play_audit._write_hash

    def replace_before_hash_write(path: Path, digest: str) -> str:
        source = tmp_path / "source.wav"
        replacement = tmp_path / "replacement.wav"
        replacement.write_bytes(source.read_bytes()[:-4] + b"\x01\x00\x02\x00")
        replacement.replace(source)
        return real_write_hash(path, digest)

    monkeypatch.setattr(play_audit, "_write_hash", replace_before_hash_write)
    with render_lock(project):
        play_audit.publish_stem(
            project,
            "host",
            lambda target: render_track_from_timeline(project, project.tracks[0], target, {}),
            defaults=load_defaults(),
        )
    assert play_audit.read_stem_hash(project, "host") == expected_hash
    assert track_render_hash(project, "host", defaults=load_defaults()) != expected_hash
    assert not play_audit.stem_is_fresh(project, "host", defaults=load_defaults())


def test_mixed_rate_zero_prepared_contribution_keeps_shared_compressor_baseline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.models import ProcessingChain, ProcessingEffect, SourceRecording

    project = _project(tmp_path)
    samples = np.full((44100, 2), 10000, dtype="<i2")
    with wave.open(str(tmp_path / "secondary.wav"), "wb") as target:
        target.setnchannels(2)
        target.setsampwidth(2)
        target.setframerate(44100)
        target.writeframes(samples.tobytes())
    project.sources.append(SourceRecording(id="second", path="secondary.wav", duration_sec=1))
    project.clips[1].source_id = "second"
    project.clips[1].mute_regions = [
        ClipMuteRegion(start_s=0.05, end_s=0.7, fade_in_ms=0, fade_out_ms=0)
    ]
    project.processing_chains.append(
        ProcessingChain(
            track_id="host",
            effects=[
                ProcessingEffect(effect="acompressor", params={"threshold_db": -24, "ratio": 8})
            ],
        )
    )
    plan = BleedGatePlan(
        attenuation_spans=((0, 1),), fade_sec=0.02, reduction="attenuate", attenuation_db=20
    )
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    baseline = _render(project, tmp_path / "baseline.wav", None)
    project.clips[1] = _restore(project.clips[1], tmp_path / "secondary.wav", [(0.2, 0.5)])
    restored = _render(project, tmp_path / "restored.wav", None)
    np.testing.assert_array_equal(restored, baseline)


@pytest.mark.parametrize("first_rate,second_rate", [(44100, 48000), (48000, 44100)])
@pytest.mark.parametrize("middle_count", [8821, 8822, 8823, 8824, 8825, 9601, 9602, 9603, 9604])
def test_restore_edges_follow_actual_mixed_concat_body_onset(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    first_rate: int,
    second_rate: int,
    middle_count: int,
) -> None:
    from podcast_mcp.models import SourceRecording

    project = _project(tmp_path)
    for name, rate, value in [
        ("source.wav", first_rate, 0),
        ("middle.wav", second_rate, 0),
        ("last.wav", first_rate, 10000),
    ]:
        with wave.open(str(tmp_path / name), "wb") as target:
            target.setnchannels(2)
            target.setsampwidth(2)
            target.setframerate(rate)
            target.writeframes(np.full((rate, 2), value, dtype="<i2").tobytes())
    project.sources = [
        SourceRecording(id="middle", path="middle.wav", duration_sec=1),
        SourceRecording(id="last", path="last.wav", duration_sec=1),
    ]
    middle_end = 0.01049 + middle_count / second_rate
    project.clips = [
        Clip(
            id="first", track_id="host", source_start=0.00049, source_end=0.20050, timeline_start=0
        ),
        Clip(
            id="middle",
            track_id="host",
            source_id="middle",
            source_start=0.01049,
            source_end=middle_end,
            timeline_start=0.20001,
        ),
        Clip(
            id="last",
            track_id="host",
            source_id="last",
            source_start=0.01049,
            source_end=0.51049,
            timeline_start=0.20001 + middle_end - 0.01049,
        ),
    ]
    project.tracks[0].transcript_gate = False
    whole = _render(project, tmp_path / "whole.wav", None)
    onset = int(np.flatnonzero(whole[:, 0])[0])
    project.tracks[0].transcript_gate = True
    plan = BleedGatePlan(attenuation_spans=((0, 2),), fade_sec=0.02)
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    project.clips[-1] = _restore(project.clips[-1], tmp_path / "last.wav", [(0.1, 0.4)])
    restored = _render(project, tmp_path / "restored.wav", None)
    first = onset + int(np.ceil(0.1 * first_rate)) - round(0.01049 * first_rate)
    last = onset + int(np.ceil(0.4 * first_rate)) - round(0.01049 * first_rate)
    positions = np.arange(last - first)
    fade = round(0.02 * first_rate)
    h = np.minimum(1, np.minimum(positions / fade, (last - first - 1 - positions) / fade))
    expected = np.zeros_like(restored)
    expected[first:last] = (10000 * h[:, None]).astype("<i2")
    np.testing.assert_array_equal(restored, expected)


@pytest.mark.parametrize("count", [2442, 3882, 5002])
def test_restore_after_gate_fill_uses_emitted_resampler_count(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, count: int
) -> None:
    from podcast_mcp.models import SourceRecording

    project = _project(tmp_path)
    for name, rate, value in [
        ("source.wav", 48000, 0),
        ("fill.wav", 44100, 0),
        ("last.wav", 44100, 10000),
    ]:
        with wave.open(str(tmp_path / name), "wb") as target:
            target.setnchannels(2)
            target.setsampwidth(2)
            target.setframerate(rate)
            target.writeframes(np.full((rate, 2), value, dtype="<i2").tobytes())
    project.sources = [SourceRecording(id="last", path="last.wav", duration_sec=1)]
    project.clips = [
        Clip(
            id="first", track_id="host", source_start=0, source_end=count / 48000, timeline_start=0
        ),
        Clip(
            id="last",
            track_id="host",
            source_id="last",
            source_start=0.01049,
            source_end=0.51049,
            timeline_start=count / 48000,
        ),
    ]
    monkeypatch.setattr(
        "podcast_mcp.engines.timeline_render.current_gate_fill_path",
        lambda *_args: tmp_path / "fill.wav",
    )
    project.tracks[0].transcript_gate = False
    whole = _render(project, tmp_path / "whole.wav", None)
    onset = int(np.flatnonzero(whole[:, 0])[0])
    project.tracks[0].transcript_gate = True
    plan = BleedGatePlan(attenuation_spans=((0, 2),), fade_sec=0.02)
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    project.clips[-1] = _restore(project.clips[-1], tmp_path / "last.wav", [(0.1, 0.4)])
    restored = _render(project, tmp_path / "restored.wav", None)
    first, last = onset + 4410 - 463, onset + 17640 - 463
    positions = np.arange(last - first)
    h = np.minimum(1, np.minimum(positions / 882, (last - first - 1 - positions) / 882))
    expected = np.zeros_like(restored)
    expected[first:last] = (10000 * h[:, None]).astype("<i2")
    np.testing.assert_array_equal(restored, expected)


def test_restore_loudnorm_maps_combined_placement_before_final_resampling(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.models import ProcessingChain, ProcessingEffect, SourceRecording

    project = _project(tmp_path)
    for name, rate, value in [
        ("source.wav", 48000, 0),
        ("fill.wav", 44100, 0),
        ("last.wav", 44100, 10000),
    ]:
        with wave.open(str(tmp_path / name), "wb") as target:
            target.setnchannels(2)
            target.setsampwidth(2)
            target.setframerate(rate)
            target.writeframes(np.full((rate, 2), value, dtype="<i2").tobytes())
    selected = _pcm(tmp_path / "last.wav").copy()
    selected[4410:17640] = 0
    with wave.open(str(tmp_path / "masked.wav"), "wb") as target:
        target.setnchannels(2)
        target.setsampwidth(2)
        target.setframerate(44100)
        target.writeframes(selected.tobytes())
    project.sources = [SourceRecording(id="last", path="last.wav", duration_sec=1)]
    project.clips = [
        Clip(
            id="first", track_id="host", source_start=0, source_end=2442 / 48000, timeline_start=0
        ),
        Clip(
            id="last",
            track_id="host",
            source_id="last",
            source_start=0.01049,
            source_end=0.51049,
            timeline_start=2442 / 48000,
        ),
    ]
    monkeypatch.setattr(
        "podcast_mcp.engines.timeline_render.current_gate_fill_path",
        lambda *_args: tmp_path / "fill.wav",
    )
    project.tracks[0].transcript_gate = False
    plain = _render(project, tmp_path / "plain.wav", None)
    onset = int(np.flatnonzero(plain[:, 0])[0])
    project.processing_chains = [
        ProcessingChain(track_id="host", effects=[ProcessingEffect(effect="loudnorm", params={})])
    ]
    whole = _render(project, tmp_path / "whole.wav", None)
    with wave.open(str(tmp_path / "whole.wav"), "rb") as rendered:
        output_rate = rendered.getframerate()
    assert output_rate == 192000
    project.sources[0].path = "masked.wav"
    without = _render(project, tmp_path / "without.wav", None)
    project.sources[0].path = "last.wav"
    project.tracks[0].transcript_gate = True
    plan = BleedGatePlan(attenuation_spans=((0, 2),), fade_sec=0.02)
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    baseline = _render(project, tmp_path / "baseline.wav", None)
    project.clips[-1] = _restore(project.clips[-1], tmp_path / "last.wav", [(0.1, 0.4)])
    restored = _render(project, tmp_path / "restored.wav", None)
    first = round((onset + 4410 - 463) * output_rate / 44100)
    last = round((onset + 17640 - 463) * output_rate / 44100)
    positions = np.arange(last - first)
    fade = round(0.02 * output_rate)
    h = np.minimum(1, np.minimum(positions / fade, (last - first - 1 - positions) / fade))
    expected = baseline.copy()
    expected[first:last] = (
        h[:, None] * (whole[first:last].astype(np.float64) - without[first:last].astype(np.float64))
    ).astype("<i2")
    np.testing.assert_array_equal(restored[:first], baseline[:first])
    np.testing.assert_array_equal(restored[last:], baseline[last:])
    np.testing.assert_allclose(restored, expected, atol=1)


@pytest.mark.parametrize(
    "damage",
    [
        "missing_trim",
        "missing_body",
        "duplicate_event",
        "bad_rate",
        "truncated_log",
        "missing_output",
        "malformed_graph",
    ],
)
def test_invalid_observed_clock_preserves_previous_render(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, damage: str
) -> None:
    from podcast_mcp.engines import ffmpeg
    from podcast_mcp.util.coded_error import CodedValueError

    project = _project(tmp_path)
    plan = BleedGatePlan(attenuation_spans=((0, 1),))
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    output = tmp_path / "published.wav"
    _render(project, output, None)
    previous = output.read_bytes()
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.2, 0.6)])
    real_run = ffmpeg.run

    def damage_observations(command, **kwargs):
        result = real_run(command, **kwargs)
        if "-print_graphs_file" in command:
            stream = kwargs["stderr"]
            stream.flush()
            path = Path(stream.name)
            lines = path.read_text().splitlines(keepends=True)
            if damage == "malformed_graph":
                Path(command[command.index("-print_graphs_file") + 1]).write_text("{")
            elif damage == "truncated_log":
                lines = lines[
                    : next(i for i, line in enumerate(lines) if "ashowinfo@restore_node_0 " in line)
                ]
            elif damage.startswith("missing"):
                name = {
                    "missing_trim": "trim_0",
                    "missing_body": "node_0",
                    "missing_output": "output",
                }[damage]
                lines = [line for line in lines if f"ashowinfo@restore_{name} " not in line]
            elif damage == "duplicate_event":
                event = next(line for line in lines if "ashowinfo@restore_node_0 " in line)
                lines.append(event)
            elif damage == "bad_rate":
                lines = [
                    line.replace("rate:48000 nb_samples", "rate:44100 nb_samples") for line in lines
                ]
            path.write_text("".join(lines))
        return result

    monkeypatch.setattr(ffmpeg, "run", damage_observations)
    with pytest.raises(CodedValueError, match="clock"):
        _render(project, output, None)
    assert output.read_bytes() == previous
    assert not list(tmp_path.glob(".bleed-restore-*"))
    assert not list(tmp_path.rglob(".restore-clock-*"))


@pytest.mark.parametrize(
    "shape", ["concat", "crossfade", "mix_delay", "gate_fill", "room_tone", "silence", "many_nodes"]
)
@pytest.mark.parametrize(
    "effect", ["", "loudnorm=I=-16:TP=-1.5:LRA=11", "acompressor=threshold=0.1:ratio=4"]
)
def test_passive_clock_observers_preserve_legacy_pcm(
    tmp_path: Path, shape: str, effect: str
) -> None:
    from podcast_mcp.engines.audio import (
        At,
        CrossfadeAudio,
        MixAudio,
        SequenceAudio,
        SilenceAudio,
        SourceAudio,
    )
    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.engines.render_clock import read_render_clock

    _project(tmp_path)
    with wave.open(str(tmp_path / "secondary.wav"), "wb") as target:
        target.setnchannels(2)
        target.setsampwidth(2)
        target.setframerate(44100)
        target.writeframes(np.full((44100, 2), 10000, dtype="<i2").tobytes())
    first = SourceAudio(tmp_path / "source.wav", 0.00049, 0.20050)
    second = SourceAudio(tmp_path / "secondary.wav", 0.01049, 0.194260833)
    last = SourceAudio(tmp_path / "source.wav", 0.41049, 0.71049)
    if shape == "concat":
        audio = SequenceAudio(SequenceAudio(first, (second,)), (last,))
    elif shape == "crossfade":
        audio = CrossfadeAudio(SequenceAudio(first, (second,)), last, 0.031337)
    elif shape == "mix_delay":
        audio = MixAudio(At(0.10049, SequenceAudio(first, (second,))), (At(0.01337, last),))
    elif shape == "gate_fill":
        first = SourceAudio(
            tmp_path / "source.wav", 0, 2442 / 48000, fill_path=tmp_path / "secondary.wav"
        )
        audio = SequenceAudio(first, (second, last))
    elif shape == "many_nodes":
        leaves = [
            SourceAudio(
                tmp_path / ("source.wav" if i % 2 == 0 else "secondary.wav"),
                0.01049 + i * 0.001,
                0.06049 + i * 0.001,
                fill_path=tmp_path / "secondary.wav" if i in (0, 9) else None,
            )
            for i in range(12)
        ]
        audio = SequenceAudio(leaves[0], tuple(leaves[1:]))
    elif shape == "room_tone":
        audio = SequenceAudio(MixAudio(At(0, first), (At(0.02049, second),)), (last,))
    else:
        audio = SequenceAudio(first, (SilenceAudio(0.031337), second, last))
    engine = FFmpegEngine()
    legacy, observed = tmp_path / "legacy.wav", tmp_path / "observed.wav"
    engine.render_timeline(legacy, audio, effect)
    engine.render_timeline(observed, audio, effect, clock_path=tmp_path / "clock.json")
    with wave.open(str(legacy), "rb") as original, wave.open(str(observed), "rb") as measured:
        assert measured.getparams() == original.getparams()
    np.testing.assert_array_equal(_pcm(observed), _pcm(legacy))
    clock = read_render_clock(tmp_path / "clock.json")
    with wave.open(str(observed), "rb") as rendered:
        assert (clock.output.sample_rate, clock.output.frames) == (
            rendered.getframerate(),
            rendered.getnframes(),
        )
    assert not list(tmp_path.glob(".restore-clock-*"))


@pytest.mark.parametrize("effect", ["acompressor", "loudnorm"])
@pytest.mark.parametrize("placement", ["overlap", "concat", "crossfade", "gate_fill"])
def test_zero_prepared_restore_preserves_entire_bus_and_both_passes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, effect: str, placement: str
) -> None:
    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.models import ClipJoinMode, ProcessingChain, ProcessingEffect, SourceRecording

    project = _project(tmp_path)
    for name, value in [("secondary.wav", 10000), ("fill.wav", 0)]:
        with wave.open(str(tmp_path / name), "wb") as target:
            target.setnchannels(2)
            target.setsampwidth(2)
            target.setframerate(44100)
            target.writeframes(np.full((44100, 2), value, dtype="<i2").tobytes())
    project.sources = [SourceRecording(id="second", path="secondary.wav", duration_sec=1)]
    selected = project.clips[1]
    selected.source_id = "second"
    selected.mute_regions = [ClipMuteRegion(start_s=0.05, end_s=0.7, fade_in_ms=0, fade_out_ms=0)]
    if placement in ("concat", "crossfade"):
        selected.timeline_start = 1
    if placement == "crossfade":
        selected.join_in_mode = ClipJoinMode.CROSSFADE
        selected.fade_in_ms = 30
        project.clips[0].fade_out_ms = 30
    if placement == "gate_fill":
        monkeypatch.setattr(
            "podcast_mcp.engines.timeline_render.current_gate_fill_path",
            lambda *_args: tmp_path / "fill.wav",
        )
    project.processing_chains = [
        ProcessingChain(track_id="host", effects=[ProcessingEffect(effect=effect, params={})])
    ]
    plan = BleedGatePlan(attenuation_spans=((0, 3),), fade_sec=0.02)
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    project.tracks[0].transcript_gate = False
    whole = _render(project, tmp_path / "legacy-whole.wav", None)
    project.tracks[0].transcript_gate = True
    baseline = _render(project, tmp_path / "baseline.wav", None)
    project.clips[1] = _restore(selected, tmp_path / "secondary.wav", [(0.2, 0.4)])
    engine = FFmpegEngine()
    real_render = engine.render_timeline
    passes = []

    def capture_pass(path, audio, af, **kwargs):
        result = real_render(path, audio, af, **kwargs)
        passes.append(_pcm(path).copy())
        return result

    monkeypatch.setattr(engine, "render_timeline", capture_pass)
    output = tmp_path / "restored.wav"
    render_track_from_timeline(project, project.tracks[0], output, {}, engine=engine)
    assert len(passes) == 2
    np.testing.assert_array_equal(passes[0], whole)
    np.testing.assert_array_equal(passes[1], whole)
    np.testing.assert_array_equal(_pcm(output), baseline)


def test_restore_accepts_an_unselected_zero_frame_branch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path)
    project.clips[0].source_start = project.clips[0].source_end = 0.1
    project.clips[1].timeline_start = 0
    plan = BleedGatePlan(attenuation_spans=((0, 1),), fade_sec=0.02)
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    project.clips[1] = _restore(project.clips[1], tmp_path / "source.wav", [(0.2, 0.6)])
    restored = _render(project, tmp_path / "restored.wav", None)
    np.testing.assert_array_equal(restored[12000:27000], _pcm(tmp_path / "source.wav")[12000:27000])


@pytest.mark.parametrize("window", [None, (0.2, 0.7)])
def test_restore_dependency_snapshot_precedes_filter_preparation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, window: tuple[float, float] | None
) -> None:
    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.models import ProcessingChain, ProcessingEffect
    from podcast_mcp.util.coded_error import CodedValueError

    project = _project(tmp_path)
    output = tmp_path / "published.wav"
    _render(project, output, window)
    previous = output.read_bytes()
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.2, 0.6)])
    engine = FFmpegEngine()
    real_build = engine.build_track_filter

    def change_after_preparing_filter(*args, **kwargs):
        prepared = real_build(*args, **kwargs)
        project.processing_chains.append(
            ProcessingChain(
                track_id="host", effects=[ProcessingEffect(effect="acompressor", params={})]
            )
        )
        return prepared

    monkeypatch.setattr(engine, "build_track_filter", change_after_preparing_filter)
    with pytest.raises(CodedValueError, match="changed"):
        if window:
            render_track_segment(project, "host", *window, output, {}, engine=engine)
        else:
            render_track_from_timeline(project, project.tracks[0], output, {}, engine=engine)
    assert output.read_bytes() == previous


@pytest.mark.parametrize("count", [0, 1, 31])
@pytest.mark.parametrize(
    "effect", ["volume=1000", "loudnorm=I=-16:TP=-1.5:LRA=11", "afftdn=nf=-25,volume=1000"]
)
def test_zero_event_boundaries_keep_configured_formats_with_float_media(
    tmp_path: Path, count: int, effect: str
) -> None:
    from podcast_mcp.engines.audio import SequenceAudio, SourceAudio
    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.engines.render_clock import read_render_clock
    from podcast_mcp.util.process import run

    primary = tmp_path / "primary.wav"
    with wave.open(str(primary), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(48000)
        target.writeframes(np.zeros(48000, dtype="<i2").tobytes())
    secondary = tmp_path / "secondary.wav"
    engine = FFmpegEngine()
    run(
        [
            engine.ffmpeg,
            "-v",
            "error",
            "-f",
            "f32le",
            "-ar",
            "44100",
            "-ac",
            "2",
            "-i",
            "pipe:0",
            "-c:a",
            "pcm_f32le",
            str(secondary),
        ],
        input=np.full((44100, 2), 3.1e-6, dtype="<f4").tobytes(),
        capture_output=True,
        check=True,
    )
    audio = SequenceAudio(
        SourceAudio(primary, 0, count / 48000, fill_path=secondary),
        (SourceAudio(secondary, 0.01049, 0.21049), SourceAudio(primary, 0.41049, 0.61049)),
    )
    legacy, observed = tmp_path / "legacy.wav", tmp_path / "observed.wav"
    engine.render_timeline(legacy, audio, effect)
    engine.render_timeline(observed, audio, effect, clock_path=tmp_path / "clock.json")
    with wave.open(str(legacy), "rb") as original, wave.open(str(observed), "rb") as measured:
        assert measured.getparams() == original.getparams()
    np.testing.assert_array_equal(_pcm(observed), _pcm(legacy))
    clock = read_render_clock(tmp_path / "clock.json")
    assert clock.trims[0].producer.frames == count
    if count < 2:
        assert clock.nodes[0].producer.frames == 0
        assert clock.nodes[0].producer.sample_fmt
        assert clock.nodes[0].consumer.sample_fmt


def test_native_descriptor_rejects_filter_syntax_before_rendering(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.engines import render_clock
    from podcast_mcp.util.coded_error import CodedValueError

    project = _project(tmp_path)
    output = tmp_path / "published.wav"
    _render(project, output, None)
    previous = output.read_bytes()
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.2, 0.6)])
    plan = BleedGatePlan(attenuation_spans=((0, 1),))
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    real_run = render_clock.run

    def corrupt_descriptor(command, **kwargs):
        result = real_run(command, **kwargs)
        if "ashowinfo@restore_descriptor" in command:
            result.stderr = result.stderr.replace("chlayout:stereo ", "chlayout:stereo;anull ")
        return result

    monkeypatch.setattr(render_clock, "run", corrupt_descriptor)
    with pytest.raises(CodedValueError, match="clock"):
        _render(project, output, None)
    assert output.read_bytes() == previous
    assert not list(tmp_path.glob(".bleed-restore-*"))


def test_missing_normalized_clock_entry_preserves_previous_render(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import json

    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.util.coded_error import CodedValueError

    project = _project(tmp_path)
    output = tmp_path / "published.wav"
    _render(project, output, None)
    previous = output.read_bytes()
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.2, 0.6)])
    plan = BleedGatePlan(attenuation_spans=((0, 1),))
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    engine = FFmpegEngine()
    real_render = engine.render_timeline

    def omit_entry(path, audio, af, **kwargs):
        result = real_render(path, audio, af, **kwargs)
        if kwargs.get("clock_path"):
            clock_path = kwargs["clock_path"]
            payload = json.loads(clock_path.read_text())
            payload["nodes"].pop(0)
            clock_path.write_text(json.dumps(payload))
        return result

    monkeypatch.setattr(engine, "render_timeline", omit_entry)
    with pytest.raises(CodedValueError, match="clock"):
        render_track_from_timeline(project, project.tracks[0], output, {}, engine=engine)
    assert output.read_bytes() == previous
    assert not list(tmp_path.glob(".bleed-restore-*"))


def test_clock_observation_preserves_sub_pcm16_precision_before_track_fx(tmp_path: Path) -> None:
    from podcast_mcp.engines.audio import At, MixAudio, SourceAudio
    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.util.process import run

    engine = FFmpegEngine()
    floating = tmp_path / "floating.wav"
    samples = (3.1e-6 * np.sin(2 * np.pi * 311 * np.arange(44100) / 44100)).astype("<f4")
    run(
        [
            engine.ffmpeg,
            "-v",
            "error",
            "-f",
            "f32le",
            "-ar",
            "44100",
            "-ac",
            "1",
            "-i",
            "pipe:0",
            "-c:a",
            "pcm_f32le",
            str(floating),
        ],
        input=samples.tobytes(),
        capture_output=True,
        check=True,
    )
    zero = tmp_path / "zero.wav"
    with wave.open(str(zero), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(48000)
        target.writeframes(np.zeros(48000, dtype="<i2").tobytes())
    audio = MixAudio(At(0, SourceAudio(floating, 0, 1)), (At(0, SourceAudio(zero, 0, 1)),))
    legacy, observed = tmp_path / "legacy.wav", tmp_path / "observed.wav"
    engine.render_timeline(legacy, audio, "volume=1000")
    engine.render_timeline(observed, audio, "volume=1000", clock_path=tmp_path / "clock.json")
    with wave.open(str(legacy), "rb") as original, wave.open(str(observed), "rb") as measured:
        assert measured.getparams() == original.getparams()
    np.testing.assert_array_equal(_pcm(observed), _pcm(legacy))
    assert np.count_nonzero(_pcm(observed)) > 40000
    assert np.count_nonzero((samples * 32768).astype("<i2")) == 0


def test_restore_after_a_nonempty_trim_that_emits_zero_prepared_frames(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.models import SourceRecording

    project = _project(tmp_path)
    with wave.open(str(tmp_path / "source.wav"), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(48000)
        target.writeframes(np.zeros(48000, dtype="<i2").tobytes())
    with wave.open(str(tmp_path / "secondary.wav"), "wb") as target:
        target.setnchannels(2)
        target.setsampwidth(2)
        target.setframerate(44100)
        target.writeframes(np.full((44100, 2), 10000, dtype="<i2").tobytes())
    project.sources = [SourceRecording(id="second", path="secondary.wav", duration_sec=1)]
    project.clips = [
        Clip(id="first", track_id="host", source_start=0, source_end=1 / 48000, timeline_start=0),
        Clip(
            id="selected",
            track_id="host",
            source_id="second",
            source_start=0.01049,
            source_end=0.21049,
            timeline_start=1 / 48000,
        ),
    ]
    monkeypatch.setattr(
        "podcast_mcp.engines.timeline_render.current_gate_fill_path",
        lambda *_args: tmp_path / "secondary.wav",
    )
    plan = BleedGatePlan(attenuation_spans=((0, 1),), fade_sec=0.02)
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    baseline = _render(project, tmp_path / "baseline.wav", None)
    project.clips[1] = _restore(project.clips[1], tmp_path / "secondary.wav", [(0.05, 0.15)])
    actual = _render(project, tmp_path / "restored.wav", None)
    first, last = 2205 - 463, 6615 - 463
    position = np.arange(last - first)
    h = np.minimum(1, np.minimum(position / 882, (last - first - 1 - position) / 882))
    expected = baseline.copy()
    expected[first:last] = (10000 * h[:, None]).astype("<i2")
    np.testing.assert_array_equal(actual, expected)


@pytest.mark.parametrize("first_rate,selected_rate", [(44100, 48000), (48000, 44100)])
@pytest.mark.parametrize("effect", ["", "acompressor", "loudnorm"])
@pytest.mark.parametrize("room_tone", [False, True])
@pytest.mark.parametrize("removal", ["partial", "whole", "zero"])
def test_restore_preserves_mixed_rate_manual_body_consumer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    first_rate: int,
    selected_rate: int,
    effect: str,
    room_tone: bool,
    removal: str,
) -> None:
    import math

    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.engines.render_clock import read_render_clock
    from podcast_mcp.models import (
        ProcessingChain,
        ProcessingEffect,
        RoomToneFill,
        SourceRecording,
    )

    for rate in (first_rate, selected_rate):
        for kind, value in (("before", 5000), ("signal", 10000), ("zero", 0)):
            with wave.open(str(tmp_path / f"{rate}-{kind}.wav"), "wb") as target:
                target.setnchannels(2)
                target.setsampwidth(2)
                target.setframerate(rate)
                target.writeframes(np.full((rate, 2), value, dtype="<i2").tobytes())
    project = EpisodeProject.create("consumer-clock", str(tmp_path))
    track = Track(
        id="host",
        label="Host",
        media=MediaAsset(path=f"{first_rate}-before.wav", duration_sec=1),
        transcript_gate=False,
    )
    project.tracks = [track]
    project.sources = [
        SourceRecording(id="selected", path=f"{selected_rate}-signal.wav", duration_sec=1),
        SourceRecording(
            id="room",
            path=f"{selected_rate}-{'zero' if removal == 'zero' else 'signal'}.wav",
            duration_sec=1,
        ),
    ]
    project.clips = [
        Clip(
            id="before",
            track_id="host",
            source_start=0.00049,
            source_end=0.20050,
            timeline_start=0,
        ),
        Clip(
            id="selected",
            track_id="host",
            source_id="selected",
            source_start=0.01049,
            source_end=0.61049,
            timeline_start=0.20001,
            mute_regions=[
                ClipMuteRegion(
                    start_s=0.05 if removal == "zero" else 0.2,
                    end_s=0.7 if removal == "zero" else 0.3,
                    fade_in_ms=0,
                    fade_out_ms=0,
                    fill=RoomToneFill(source_id="room", start_s=0.7, end_s=0.75)
                    if room_tone
                    else None,
                )
            ],
        ),
    ]
    if effect:
        project.processing_chains = [
            ProcessingChain(track_id="host", effects=[ProcessingEffect(effect=effect, params={})])
        ]
    monkeypatch.setattr(
        "podcast_mcp.engines.timeline_render.current_gate_fill_path",
        lambda *_args: tmp_path / f"{first_rate}-zero.wav",
    )
    plan = BleedGatePlan(
        attenuation_spans=((0, 3),), fade_sec=0.02, reduction="attenuate", attenuation_db=20
    )
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )
    whole = _render(project, tmp_path / "legacy-whole.wav", None)
    independent_without = None
    if removal == "whole":
        reference = project.model_copy(deep=True)
        for source in reference.sources:
            source.path = f"{selected_rate}-zero.wav"
        independent_without = _render(reference, tmp_path / "reference-without.wav", None)
    track.transcript_gate = True
    baseline = _render(project, tmp_path / "baseline.wav", None)
    start, end = (0.0, 0.7) if removal == "whole" else (0.150013, 0.450017)
    project.clips[1] = _restore(
        project.clips[1], tmp_path / f"{selected_rate}-signal.wav", [(start, end)]
    )
    engine = FFmpegEngine()
    real_render = engine.render_timeline
    passes = []
    clocks = []

    def capture_pass(path, audio, af, **kwargs):
        result = real_render(path, audio, af, **kwargs)
        passes.append(_pcm(path).copy())
        clocks.append(read_render_clock(kwargs["clock_path"]))
        return result

    monkeypatch.setattr(engine, "render_timeline", capture_pass)
    output = tmp_path / "restored.wav"
    render_track_from_timeline(project, track, output, {}, engine=engine)
    actual = _pcm(output)
    assert len(passes) == 2
    assert clocks[0] == clocks[1]
    np.testing.assert_array_equal(passes[0], whole)
    clock = clocks[0]
    trim = clock.trims[1]
    body = clock.nodes[-2]
    rate = clock.output.sample_rate

    def scale(frame, source_rate, target_rate):
        magnitude = (abs(frame) * target_rate + source_rate // 2) // source_rate
        return magnitude if frame >= 0 else -magnitude

    source_first = math.floor(0.01049 * trim.producer.sample_rate + 0.5)

    def placed_frame(frame):
        frame -= source_first
        frame = scale(frame, trim.producer.sample_rate, trim.consumer.sample_rate)
        frame = scale(frame, trim.consumer.sample_rate, body.producer.sample_rate)
        frame = scale(frame, body.producer.sample_rate, body.consumer.sample_rate)
        frame += clock.nodes[0].consumer.frames
        return scale(frame, clock.nodes[-1].producer.sample_rate, rate)

    first_source = math.ceil(start * trim.producer.sample_rate)
    last_source = math.ceil(end * trim.producer.sample_rate)
    first, last = placed_frame(first_source), placed_frame(last_source)
    active_first = placed_frame(max(first_source, source_first))
    active_last = placed_frame(
        min(
            last_source,
            math.floor(0.61049 * trim.producer.sample_rate + 0.5),
            source_first + trim.producer.frames,
        )
    )
    positions = np.arange(len(actual))
    selected = (positions >= active_first) & (positions < active_last)
    h = np.zeros(len(actual))
    fade = round(plan.fade_sec * rate)
    h[selected] = np.minimum(
        1, np.minimum((positions[selected] - first) / fade, (last - 1 - positions[selected]) / fade)
    )
    expected = np.clip(
        baseline.astype(np.float64)
        + ((1 - plan.gains_for_frames(0, len(actual), rate)) * h)[:, None]
        * (passes[0].astype(np.float64) - passes[1].astype(np.float64)),
        -32768,
        32767,
    ).astype("<i2")
    np.testing.assert_array_equal(actual, expected)
    np.testing.assert_array_equal(actual[~selected], baseline[~selected])
    if removal == "zero":
        assert np.any(whole[:1000] != 0)
        np.testing.assert_array_equal(passes[1], whole)
        np.testing.assert_array_equal(actual, baseline)
    else:
        assert np.any(actual[selected] != baseline[selected])
    if independent_without is not None:
        np.testing.assert_array_equal(passes[1], independent_without)

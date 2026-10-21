from __future__ import annotations

import shutil
import wave
from dataclasses import FrozenInstanceError
from pathlib import Path
from unittest.mock import Mock

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import source_proxy_audio as proxy
from podcast_mcp.engines import timeline_render, transcript_gated_play
from podcast_mcp.engines.bleed_gate import BleedGatePlan
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.models import (
    Clip,
    ClipBleedRestore,
    ClipMuteRegion,
    ClipOffSpeakerMuteRegion,
    EpisodeProject,
    MediaAsset,
    ProcessingChain,
    ProcessingEffect,
    Track,
)
from podcast_mcp.models.episode import (
    RoomToneFill,
    SourceRecording,
    SourceSpan,
    TrackProxy,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.hashing import sha256_file


def _write(path: Path, value: int = 1000) -> None:
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(16000)
        stream.writeframes(np.full(16000, value, dtype="<i2").tobytes())


def _samples(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as stream:
        return np.frombuffer(stream.readframes(stream.getnframes()), dtype="<i2")


@pytest.fixture
def capture_project(tmp_path):
    _write(tmp_path / "primary.wav")
    _write(tmp_path / "secondary.wav", 3000)
    project = EpisodeProject.create("Inputs", str(tmp_path))
    project.tracks = [Track(id="origin", label="Origin", media=MediaAsset(path="primary.wav"))]
    project.sources = [SourceRecording(id="secondary", path="secondary.wav")]
    project.clips = [
        Clip(
            id="choice",
            track_id="origin",
            source_id="secondary",
            source_start=0.1,
            source_end=0.9,
            timeline_start=5,
            bleed_restore=ClipBleedRestore(
                source_sha256=sha256_file(tmp_path / "secondary.wav"),
                regions=[SourceSpan(start_s=0.3, end_s=0.7)],
            ),
        )
    ]
    return project, FFmpegEngine()


def _capture(project, engine):
    return proxy.SourceProxyInputs.capture_occurrence(
        project, project.clips[0].id, engine, defaults=load_defaults()
    )


def test_legacy_selector_needs_no_occurrence_and_renders_exact_primary(capture_project, tmp_path):
    project, engine = capture_project
    project.clips = []
    before = project.model_dump_json()
    captured = proxy.SourceProxyInputs.capture_legacy(
        project, "origin", engine, defaults=load_defaults()
    )
    expected = tmp_path / "expected.wav"
    timeline_render.render_source_with_chain(
        project, project.tracks[0], expected, engine=engine, defaults=load_defaults()
    )
    actual = tmp_path / "actual.wav"
    proxy.render_source_proxy_inputs(
        project, captured, actual, engine=engine, defaults=load_defaults()
    )
    assert actual.read_bytes() == expected.read_bytes()
    assert project.model_dump_json() == before
    assert captured.selector == "legacy" and captured.clip_id is None


@pytest.mark.parametrize("inactive", [False, True])
def test_occurrence_selector_keeps_secondary_at_unity(capture_project, tmp_path, inactive):
    project, engine = capture_project
    if inactive:
        project.clips[0].bleed_restore.source_sha256 = "0" * 64
    captured = _capture(project, engine)
    actual = tmp_path / "actual.wav"
    proxy.render_source_proxy_inputs(
        project, captured, actual, engine=engine, defaults=load_defaults()
    )
    np.testing.assert_array_equal(_samples(actual), np.full(16000, 3000))
    assert captured.affected
    assert captured.source.name == "secondary.wav"
    legacy = proxy.SourceProxyInputs.capture_legacy(
        project, "origin", engine, defaults=load_defaults()
    )
    assert legacy.input_hash != captured.input_hash


def test_capture_and_identity_are_immutable(capture_project):
    project, engine = capture_project
    captured = _capture(project, engine)
    payload = captured.identity_payload
    payload["recording"]["source_id"] = "changed"
    assert captured.identity_payload["recording"]["source_id"] == "secondary"
    with pytest.raises(FrozenInstanceError):
        captured.source = Path("other.wav")


def test_prepared_renderer_preserves_complete_baseline_context(
    capture_project, tmp_path, monkeypatch
):
    project, engine = capture_project
    project.transcripts = [
        Transcript(
            track_id="origin",
            source_id="secondary",
            words=[TranscriptWord(text="spoken", start=0.2, end=0.6)],
        )
    ]
    captured = _capture(project, engine)
    expected = project.model_dump_json()
    render = proxy.render_source_with_chain

    def render_complete_context(context, *args, **kwargs):
        assert context.model_dump_json() == expected
        return render(context, *args, **kwargs)

    monkeypatch.setattr(proxy, "render_source_with_chain", render_complete_context)
    output = tmp_path / "complete-context.wav"
    proxy.render_source_proxy_inputs(
        project, captured, output, engine=engine, defaults=load_defaults()
    )
    np.testing.assert_array_equal(_samples(output), np.full(16000, 3000))
    assert project.model_dump_json() == expected


@pytest.mark.parametrize(
    "change", ["clip_id", "fades", "placement", "gain", "proxy", "other_choice"]
)
def test_irrelevant_occurrence_changes_preserve_identity(capture_project, change):
    project, engine = capture_project
    original = _capture(project, engine).input_hash
    clip = project.clips[0]
    if change == "clip_id":
        clip.id = "renamed"
    elif change == "fades":
        clip.fade_in_ms, clip.fade_out_ms = 200, 300
    elif change == "placement":
        clip.timeline_start = 17
    elif change == "gain":
        project.tracks[0].gain_db = -12
        project.tracks[0].muted = True
    elif change == "proxy":
        project.tracks[0].proxy = TrackProxy(
            hash="a" * 16, chunk_count=1, chunk_sec=30, duration_sec=1
        )
    elif change == "other_choice":
        project.clips.append(
            clip.model_copy(deep=True, update={"id": "unrelated", "timeline_start": 23})
        )
        project.clips[1].bleed_restore.regions = [SourceSpan(start_s=0.2, end_s=0.8)]
    assert _capture(project, engine).input_hash == original


@pytest.mark.parametrize(
    "change",
    [
        "recording_id",
        "context",
        "content",
        "fx",
        "bounds",
        "anchors",
        "ordinary",
        "automatic",
        "ignored",
    ],
)
def test_audible_occurrence_dependencies_change_identity(capture_project, change):
    project, engine = capture_project
    original = _capture(project, engine).input_hash
    clip = project.clips[0]
    if change == "recording_id":
        project.sources.append(project.sources[0].model_copy(update={"id": "alias"}))
        clip.source_id = "alias"
    elif change == "context":
        project.tracks[0].id = "new-context"
        clip.track_id = "new-context"
    elif change == "content":
        _write(project.workspace_path() / "secondary.wav", 4000)
    elif change == "fx":
        project.processing_chains = [
            ProcessingChain(
                track_id="origin",
                effects=[ProcessingEffect(effect="highpass", params={"frequency": 100})],
            )
        ]
    elif change == "bounds":
        clip.source_start = 0.4
    elif change == "anchors":
        clip.bleed_restore.regions[0].end_s = 0.75
    elif change == "ordinary":
        clip.mute_regions = [ClipMuteRegion(start_s=0.2, end_s=0.8, gain_db=-12)]
    elif change == "automatic":
        clip.off_speaker_mute_regions = [ClipOffSpeakerMuteRegion(start_s=0.2, end_s=0.8)]
    elif change == "ignored":
        project.transcripts = [
            Transcript(
                track_id="origin",
                source_id="secondary",
                words=[TranscriptWord(text="ignored", start=0.2, end=0.8, ignored=True)],
            )
        ]
    assert _capture(project, engine).input_hash != original


def test_path_relocation_preserves_identity_but_old_capture_refuses(capture_project, tmp_path):
    project, engine = capture_project
    captured = _capture(project, engine)
    shutil.copyfile(tmp_path / "secondary.wav", tmp_path / "relocated.wav")
    project.sources[0].path = "relocated.wav"
    assert _capture(project, engine).input_hash == captured.input_hash
    with pytest.raises(CodedValueError):
        captured.validate(project, engine, defaults=load_defaults())


@pytest.mark.parametrize("default", [False, True])
def test_model_paths_normalize_escaped_operand_and_content(
    capture_project, tmp_path, monkeypatch, default
):
    project, engine = capture_project
    first, second = tmp_path / "model:a'b.rnnn", tmp_path / "model\\alias.rnnn"
    first.write_bytes(b"first model")
    second.write_bytes(first.read_bytes())
    params = {} if default else {"model": str(first)}
    project.processing_chains = [
        ProcessingChain(
            track_id="origin", effects=[ProcessingEffect(effect="arnndn", params=params)]
        )
    ]
    monkeypatch.setenv("PODCAST_MCP_RNNOISE_MODEL", str(first))
    captured = _capture(project, engine)
    if default:
        monkeypatch.setenv("PODCAST_MCP_RNNOISE_MODEL", str(second))
    else:
        project.processing_chains[0].effects[0].params["model"] = str(second)
    relocated = _capture(project, engine)
    assert relocated.input_hash == captured.input_hash
    assert relocated.recipe != captured.recipe
    assert str(first) not in captured.identity_json
    with pytest.raises(CodedValueError):
        captured.validate(project, engine, defaults=load_defaults())
    second.write_bytes(b"second model")
    assert _capture(project, engine).input_hash != relocated.input_hash


def test_room_content_changes_identity(capture_project, tmp_path):
    project, engine = capture_project
    _write(tmp_path / "room.wav", 200)
    project.sources.append(SourceRecording(id="room", path="room.wav"))
    project.clips[0].mute_regions = [
        ClipMuteRegion(
            start_s=0.2, end_s=0.8, fill=RoomToneFill(source_id="room", start_s=0, end_s=0.1)
        )
    ]
    original = _capture(project, engine).input_hash
    _write(tmp_path / "room.wav", 300)
    assert _capture(project, engine).input_hash != original


@pytest.mark.parametrize("filled", [False, True])
def test_prepared_baseline_keeps_default_command_and_pcm(
    capture_project, tmp_path, monkeypatch, filled
):
    project, engine = capture_project
    project.clips = []
    _write(tmp_path / "fill.wav", 200)
    fill = tmp_path / "fill.wav" if filled else None
    monkeypatch.setattr(timeline_render, "current_gate_fill_path", lambda *_: fill)
    captured = proxy.SourceProxyInputs.capture_legacy(
        project, "origin", engine, defaults=load_defaults()
    )
    target = tmp_path / "same.wav"
    run = Mock(wraps=timeline_render.run)
    monkeypatch.setattr(timeline_render, "run", run)
    timeline_render.render_source_with_chain(
        project, project.tracks[0], target, engine=engine, defaults=load_defaults()
    )
    command, expected = run.call_args, target.read_bytes()
    timeline_render.render_source_with_chain(
        project,
        project.tracks[0],
        target,
        engine=engine,
        selected_source_path=captured.source,
        processing=timeline_render.SourceChainProcessing(
            captured.recipe, captured.fill, captured.gate
        ),
        defaults=load_defaults(),
    )
    assert run.call_args == command
    assert target.read_bytes() == expected
    np.testing.assert_array_equal(_samples(target), np.full(16000, 1200 if filled else 1000))


def test_prepared_renderer_consumes_captured_gate(capture_project, tmp_path, monkeypatch):
    project, engine = capture_project
    project.tracks[0].transcript_gate = True
    project.clips = []
    gate = BleedGatePlan(attenuation_spans=((0.2, 0.4),), fade_sec=0)
    monkeypatch.setattr(proxy, "build_bleed_gate_plan", lambda *_a, **_k: gate)
    captured = proxy.SourceProxyInputs.capture_legacy(
        project, "origin", engine, defaults=load_defaults()
    )
    monkeypatch.setattr(
        proxy,
        "build_bleed_gate_plan",
        lambda *_a, **_k: pytest.fail("Captured gate must be reused"),
    )
    monkeypatch.setattr(
        transcript_gated_play,
        "build_bleed_gate_plan",
        lambda *_a, **_k: pytest.fail("Captured gate must be reused"),
    )
    target = tmp_path / "captured.wav"
    proxy.render_source_proxy_inputs(
        project, captured, target, engine=engine, defaults=load_defaults()
    )
    expected = np.full(16000, 1000)
    expected[3200:6400] = 0
    np.testing.assert_array_equal(_samples(target), expected)


def test_legacy_and_occurrence_preparation_identities_are_independent(capture_project):
    project, engine = capture_project
    legacy = proxy.SourceProxyInputs.capture_legacy(
        project, "origin", engine, defaults=load_defaults()
    )
    occurrence = _capture(project, engine)
    project.clips[0].mute_regions = [ClipMuteRegion(start_s=0.2, end_s=0.8)]
    project.clips[0].bleed_restore.regions[0].end_s = 0.8
    assert (
        proxy.SourceProxyInputs.capture_legacy(
            project, "origin", engine, defaults=load_defaults()
        ).input_hash
        == legacy.input_hash
    )
    assert _capture(project, engine).input_hash != occurrence.input_hash


def test_actual_unsupported_source_layout_is_captured_at_unity(capture_project):
    project, engine = capture_project
    project.tracks[0].transcript_gate = True
    captured = _capture(project, engine)
    assert captured.gate.attenuation_spans == ()
    assert captured.gate.reasons == ("unsupported_source_proxy_layout",)
    assert captured.identity_payload["gate"]["reasons"] == ["unsupported_source_proxy_layout"]


@pytest.mark.parametrize(
    "change", ["gate_spans", "gate_floor", "gate_fade", "peer_content", "policy", "transcript"]
)
def test_source_gate_dependencies_invalidate_identity(
    capture_project, tmp_path, monkeypatch, change
):
    project, engine = capture_project
    project.tracks[0].transcript_gate = True
    _write(tmp_path / "peer.wav", 600)
    project.tracks.append(Track(id="peer", label="Peer", media=MediaAsset(path="peer.wav")))
    plan = BleedGatePlan(attenuation_spans=((0.2, 0.4),))
    monkeypatch.setattr(proxy, "build_bleed_gate_plan", lambda *_a, **_k: plan)
    original = _capture(project, engine).input_hash
    if change == "gate_spans":
        plan = BleedGatePlan(attenuation_spans=((0.3, 0.5),))
    elif change == "gate_floor":
        plan = BleedGatePlan(
            attenuation_spans=((0.2, 0.4),), reduction="attenuate", attenuation_db=12
        )
    elif change == "gate_fade":
        plan = BleedGatePlan(attenuation_spans=((0.2, 0.4),), fade_sec=0.01)
    elif change == "peer_content":
        _write(tmp_path / "peer.wav", 800)
    elif change == "policy":
        policy = proxy.ffmpeg_policy()
        monkeypatch.setattr(proxy, "ffmpeg_policy", lambda: {**policy, "identity_probe": 1})
    elif change == "transcript":
        project.transcripts = [
            Transcript(
                track_id="origin",
                source_id="secondary",
                words=[TranscriptWord(text="speech", start=0.1, end=0.6)],
            )
        ]
    assert _capture(project, engine).input_hash != original


@pytest.mark.parametrize("change", ["fill_content", "eligibility"])
def test_effective_fill_changes_identity(capture_project, tmp_path, monkeypatch, change):
    project, engine = capture_project
    project.clips[0].source_id = None
    project.clips[0].bleed_restore.source_sha256 = sha256_file(tmp_path / "primary.wav")
    fill = tmp_path / "fill.wav"
    _write(fill, 200)
    monkeypatch.setattr(timeline_render, "current_gate_fill_path", lambda *_: fill)
    original = _capture(project, engine).input_hash
    if change == "fill_content":
        _write(fill, 300)
    else:
        monkeypatch.setattr(timeline_render, "current_gate_fill_path", lambda *_: None)
    assert _capture(project, engine).input_hash != original


def test_model_equal_content_alias_preserves_key_and_seals_runtime_binding(
    capture_project, tmp_path
):
    project, engine = capture_project
    first, second, alias = (
        tmp_path / "first.rnnn",
        tmp_path / "second.rnnn",
        tmp_path / "alias.rnnn",
    )
    first.write_bytes(b"same model")
    second.write_bytes(first.read_bytes())
    alias.symlink_to(first.name)
    project.processing_chains = [
        ProcessingChain(
            track_id="origin",
            effects=[ProcessingEffect(effect="arnndn", params={"model": str(alias)})],
        )
    ]
    captured = _capture(project, engine)
    alias.unlink()
    alias.symlink_to(second.name)
    assert _capture(project, engine).input_hash == captured.input_hash
    with pytest.raises(CodedValueError):
        captured.validate(project, engine, defaults=load_defaults())


def test_history_is_excluded_from_semantics_but_included_in_validation(capture_project):
    from podcast_mcp.models.history import HistoryEntry

    project, engine = capture_project
    captured = _capture(project, engine)
    project.history.entries.append(
        HistoryEntry(id="123456789abc", label="Metadata", snapshot_file="snapshot.json")
    )
    project.history.cursor = 0
    assert _capture(project, engine).input_hash == captured.input_hash
    with pytest.raises(CodedValueError):
        captured.validate(project, engine, defaults=load_defaults())

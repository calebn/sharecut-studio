import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines.audio_audit import analyze_gate_overreach
from podcast_mcp.engines.play_audit import proxy_render_hash, stem_is_fresh, track_render_hash
from podcast_mcp.engines.transcript_reconcile import reconcile_transcript
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, Transcript, TranscriptWord
from podcast_mcp.render import rerender_preview
from podcast_mcp.services.pipeline import PipelineService
from podcast_mcp.services.play import PlayRequest, PlayService
from podcast_mcp.services.workspace import ProjectWorkspace


def gated_project(tmp_path: Path) -> EpisodeProject:
    project = EpisodeProject.create("gate regression", str(tmp_path))
    project.timeline.tracks = [Track(id="host", label="Host", transcript_gate=True)]
    project.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="hello", start=1, end=2)])
    ]
    return project


def test_transcript_gate_without_noise_gate_is_identified(tmp_path: Path) -> None:
    project = gated_project(tmp_path)
    report = analyze_gate_overreach(project, "host")
    assert report["gate_present"] is True
    assert report["risk"] == "unknown"


@pytest.mark.parametrize("fingerprint", [track_render_hash, proxy_render_hash])
@pytest.mark.parametrize("field,value", [("start", 1.2), ("end", 2.2), ("suppressed", True)])
def test_gated_audio_cache_tracks_word_edits(tmp_path: Path, fingerprint, field, value) -> None:
    project = gated_project(tmp_path)
    before = fingerprint(project, "host")
    setattr(project.transcripts[0].words[0], field, value)
    assert fingerprint(project, "host") != before


@pytest.mark.parametrize("fingerprint", [track_render_hash, proxy_render_hash])
def test_ungated_audio_cache_ignores_caption_timing(tmp_path: Path, fingerprint) -> None:
    project = gated_project(tmp_path)
    project.timeline.tracks[0].transcript_gate = False
    before = fingerprint(project, "host")
    project.transcripts[0].words[0].start = 1.2
    assert fingerprint(project, "host") == before


def audio_project(tmp_path: Path) -> EpisodeProject:
    project = gated_project(tmp_path)
    project.ensure_dirs()
    rate = 16000
    samples = np.zeros(rate * 3, dtype="<i2")
    clock = np.arange(rate) / rate
    samples[rate : 2 * rate] = (np.sin(2 * np.pi * 173 * clock) * 7000).astype("<i2")
    path = tmp_path / "raw" / "host.wav"
    with wave.open(str(path), "wb") as stream:
        stream.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        stream.writeframes(samples.tobytes())
    project.track_by_id("host").media = MediaAsset(path="raw/host.wav", duration_sec=3)
    project.timeline.clips = [
        Clip(id="host-clip", track_id="host", source_start=0, source_end=3, timeline_start=0)
    ]
    return project


def test_follow_transcript_preserves_owner_without_bleed_evidence(tmp_path: Path) -> None:
    project = audio_project(tmp_path)
    project.transcripts[0].words[0].start = 1.2
    project.transcripts[0].words[0].end = 1.7
    ws = ProjectWorkspace(tmp_path / "episode.project.json", project)
    ws.save()
    service = PlayService(ws)
    result = service.play(
        PlayRequest(source="processed:host", start_sec=1.05, end_sec=1.95, follow_transcript=True),
        dry_run=True,
    )
    with wave.open(str(result.wav_path), "rb") as stream:
        samples = np.frombuffer(stream.readframes(stream.getnframes()), dtype="<i2")
        rate = stream.getframerate()
    assert np.sqrt(np.mean(samples[: int(rate * 0.1)].astype(float) ** 2)) > 1000
    assert np.sqrt(np.mean(samples[-int(rate * 0.1) :].astype(float) ** 2)) > 1000


def test_gate_overreach_reports_added_tail_loss(tmp_path: Path) -> None:
    project = audio_project(tmp_path)
    source = tmp_path / "raw" / "host.wav"
    with wave.open(str(source), "rb") as stream:
        samples = np.frombuffer(stream.readframes(stream.getnframes()), dtype="<i2").copy()
    samples[int(1.96 * 16000) : 2 * 16000] = 0
    stem = project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(stem), "wb") as stream:
        stream.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        stream.writeframes(samples.tobytes())
    report = analyze_gate_overreach(project, "host")
    assert report["gate_present"] is True
    assert any(issue["kind"] == "processed_offset_chop" for issue in report["issues"])


@pytest.mark.parametrize("previously_suppressed", [False, True])
def test_reconcile_does_not_treat_gate_created_silence_as_source_evidence(
    tmp_path: Path, previously_suppressed: bool
) -> None:
    project = audio_project(tmp_path)
    if previously_suppressed:
        project.transcripts[0].words[0].suppressed = True
        project.transcripts[0].words[0].audibility_status = "inaudible"
    stem = project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(stem), "wb") as stream:
        stream.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        stream.writeframes(np.zeros(16000 * 3, dtype="<i2").tobytes())
    reconcile_transcript(project, dry_run=False)
    word = project.transcripts[0].words[0]
    assert word.suppressed is False
    assert word.audibility_status == "audible"


def test_refresh_publishes_stem_for_final_gate_driving_transcript(tmp_path: Path) -> None:
    project = audio_project(tmp_path)
    rerender_preview(project)
    assert stem_is_fresh(project, "host")


def test_reconcile_refuses_gated_fallback_when_ungated_evidence_fails(tmp_path, monkeypatch):
    project = audio_project(tmp_path)
    before = project.transcripts[0].words[0].model_dump()

    def unavailable(*args):
        raise ValueError("ungated evidence unavailable")

    monkeypatch.setattr("podcast_mcp.engines.audio_audit._pre_transcript_gate_cache", unavailable)
    with pytest.raises(ValueError, match="ungated evidence unavailable"):
        reconcile_transcript(project, dry_run=False)
    assert project.transcripts[0].words[0].model_dump() == before


def test_refresh_persists_fresh_reconciliation_with_transcript_gate(tmp_path):
    project = audio_project(tmp_path)
    ws = ProjectWorkspace(tmp_path / "episode.project.json", project)
    ws.save()
    PipelineService(ws).render_preview()
    PipelineService(ws).render_preview()
    reloaded = ProjectWorkspace.open(ws.path).project
    assert reloaded.reconciliation_stale is False
    assert stem_is_fresh(reloaded, "host")


def test_gate_overreach_detects_a_completely_silenced_retained_word(tmp_path):
    project = audio_project(tmp_path)
    stem = project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(stem), "wb") as stream:
        stream.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        stream.writeframes(np.zeros(16000 * 3, dtype="<i2").tobytes())
    report = analyze_gate_overreach(project, "host")
    assert report["risk"] != "none"
    assert any(issue["kind"] == "processed_word_loss" for issue in report["issues"])


def test_refresh_reconciles_current_ungated_peer_not_its_stale_stem(tmp_path):
    project = audio_project(tmp_path)
    project.tracks.append(
        Track(id="guest", label="Guest", media=MediaAsset(path="raw/host.wav", duration_sec=3))
    )
    project.clips.append(
        Clip(id="guest-clip", track_id="guest", source_start=0, source_end=3, timeline_start=0)
    )
    project.transcripts.append(
        Transcript(track_id="guest", words=[TranscriptWord(text="guest", start=1, end=2)])
    )
    stem = project.artifacts_dir() / "tracks" / "guest.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(stem), "wb") as stream:
        stream.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        stream.writeframes(np.zeros(16000 * 3, dtype="<i2").tobytes())
    rerender_preview(project)
    guest = project.transcript_for_track("guest").words[0]
    assert guest.audibility_status != "inaudible"


def test_refresh_does_not_clear_stale_when_audio_changes_after_reconciliation(
    tmp_path, monkeypatch
):
    from podcast_mcp.engines.reconciliation_state import mark_reconciliation_stale
    from podcast_mcp.pipeline import PipelineRunner

    project = audio_project(tmp_path)
    original = PipelineRunner.run

    def change_after_evidence(self, p, **kwargs):
        result = original(self, p, **kwargs)
        if kwargs.get("only_step") == "mix_with_music":
            p.clips[0].fade_in_ms += 30
            mark_reconciliation_stale(p)
        return result

    monkeypatch.setattr(PipelineRunner, "run", change_after_evidence)
    result = rerender_preview(project)
    assert project.reconciliation_stale is True
    assert result["reconciliation"]["stale"] is True


def test_same_track_noise_and_transcript_gates_keep_separate_attribution(tmp_path, monkeypatch):
    from podcast_mcp.engines.audio_audit import TrackRmsCache
    from podcast_mcp.models import ProcessingChain, ProcessingEffect

    project = audio_project(tmp_path)
    project.processing_chains = [
        ProcessingChain(track_id="host", effects=[ProcessingEffect(effect="agate")])
    ]
    with wave.open(str(tmp_path / "raw" / "host.wav"), "rb") as source:
        samples = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").copy()
    samples[16000 : int(1.1 * 16000)] = 0
    stem = project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(stem), "wb") as output:
        output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        output.writeframes(samples.tobytes())
    before_transcript_gate = TrackRmsCache.from_timeline_stem(stem)
    monkeypatch.setattr(
        "podcast_mcp.engines.audio_audit._pre_transcript_gate_cache",
        lambda *_: before_transcript_gate,
    )
    report = analyze_gate_overreach(project, "host")
    assert report["gate_type"] == "combined"
    by_type = {part["gate_type"]: part for part in report["components"]}
    assert by_type["transcript"]["risk"] == "none"
    assert by_type["noise"]["issue_count"] > 0

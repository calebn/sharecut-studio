import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines.audio_audit import analyze_gate_overreach
from podcast_mcp.engines.play_audit import proxy_render_hash, stem_is_fresh, track_render_hash
from podcast_mcp.engines.transcript_reconcile import reconcile_transcript
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, Transcript, TranscriptWord
from podcast_mcp.render import rerender_preview
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


def test_reconcile_does_not_treat_gate_created_silence_as_source_evidence(tmp_path: Path) -> None:
    project = audio_project(tmp_path)
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

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.engines.asr_timing import word_duration_is_anomalous
from podcast_mcp.engines.transcribe import (
    TranscriptionEngine,
    flag_anomalous_asr_durations,
)
from podcast_mcp.models import (
    CombinedTranscript,
    Transcript,
    TranscriptWord,
    load_project,
)


def test_merge_transcripts_ordering(minimal_project):
    proj = load_project(minimal_project)
    proj.transcripts = [
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="Later", start=5.0, end=5.3),
            ],
        ),
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="Hello", start=0.0, end=0.3),
                TranscriptWord(text="world", start=0.35, end=0.6),
            ],
        ),
    ]
    proj.tracks = []
    engine = TranscriptionEngine()
    combined = engine.merge_transcripts(proj)
    assert isinstance(combined, CombinedTranscript)
    assert combined.utterances[0].text.startswith("Hello")
    assert combined.utterances[-1].text == "Later"


def test_engine_rejects_unknown_model() -> None:
    with pytest.raises(ValueError, match="Unknown Whisper model"):
        TranscriptionEngine(model_size="attacker/malicious-faster-whisper")


def test_cache_path_stable(minimal_project, sample_wav, tmp_workspace):
    proj = load_project(minimal_project)
    engine = TranscriptionEngine()
    p1 = engine.cache_path(proj, "host", sample_wav)
    p2 = engine.cache_path(proj, "host", sample_wav)
    assert p1 == p2
    assert "host_" in p1.name


def test_cache_path_sanitizes_unsafe_id(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    engine = TranscriptionEngine()
    path = engine.cache_path(proj, "host__/etc/passwd", sample_wav)
    assert path.is_relative_to(proj.transcripts_dir())
    assert "passwd" not in path.name
    assert ".." not in path.name


def test_merge_transcripts_skips_empty_and_suppressed(minimal_project):
    proj = load_project(minimal_project)
    proj.transcripts = [
        Transcript(track_id="host", words=[]),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="gone", start=0.0, end=0.2, suppressed=True),
                TranscriptWord(text="hi", start=1.0, end=1.2),
            ],
        ),
    ]
    combined = TranscriptionEngine().merge_transcripts(proj)
    assert len(combined.utterances) == 1
    assert combined.utterances[0].text == "hi"


def test_transcribe_file_segment_without_words_and_with_prompt(sample_wav):
    from unittest.mock import MagicMock, patch

    seg_no_words = MagicMock(text="  hello segment  ", start=1.0, end=2.0, words=None)
    seg_with_word = MagicMock(
        words=[
            MagicMock(word=" hi ", start=0.0, end=0.2, probability=0.9),
        ]
    )
    engine = TranscriptionEngine()
    mock_model = MagicMock()
    mock_model.transcribe.return_value = ([seg_no_words, seg_with_word], None)
    with patch.object(engine, "_get_model", return_value=mock_model):
        transcript = engine.transcribe_file(
            sample_wav, language="en", initial_prompt="podcast glossary"
        )
    texts = [w.text for w in transcript.words]
    assert "hello segment" in texts
    assert "hi" in texts
    assert mock_model.transcribe.call_args.kwargs["initial_prompt"] == "podcast glossary"


def test_transcribe_track_not_found_raises(minimal_project):
    engine = TranscriptionEngine()
    proj = load_project(minimal_project)
    with pytest.raises(ValueError, match="not found"):
        engine.transcribe_track(proj, "missing")


def test_transcribe_file_skips_blank_segment_text(sample_wav):
    from unittest.mock import MagicMock, patch

    blank = MagicMock(text="   ", start=0.0, end=0.5, words=None)
    engine = TranscriptionEngine()
    mock_model = MagicMock()
    mock_model.transcribe.return_value = ([blank], None)
    with patch.object(engine, "_get_model", return_value=mock_model):
        transcript = engine.transcribe_file(sample_wav, language="en")
    assert transcript.words == []


def test_get_model_lazy_loads_whisper(tmp_path, monkeypatch):
    blob = tmp_path / "models--Systran--faster-whisper-tiny" / "blobs" / "model.bin"
    blob.parent.mkdir(parents=True)
    blob.write_bytes(b"x")
    monkeypatch.setattr("podcast_mcp.config.whisper_cache_dir", lambda: tmp_path)

    engine = TranscriptionEngine(model_size="tiny", device="cpu")

    class FakeWM:
        def __init__(self, *a, **k):
            self.args = a
            self.kwargs = k

    monkeypatch.setitem(
        __import__("sys").modules,
        "faster_whisper",
        type("M", (), {"WhisperModel": FakeWM})(),
    )
    model = engine._get_model()
    assert isinstance(model, FakeWM)
    assert model.kwargs.get("device") == "cpu"
    assert model.kwargs.get("compute_type") == "int8"
    assert model.kwargs.get("local_files_only") is True
    assert engine._get_model() is model

    gpu = TranscriptionEngine(model_size="tiny", device="cuda")
    gpu_model = gpu._get_model()
    assert gpu_model.kwargs.get("compute_type") == "float16"
    assert gpu_model.kwargs.get("local_files_only") is True


def test_transcribe_all_dialogue_reports_progress(minimal_project, sample_wav):
    from unittest.mock import MagicMock

    from podcast_mcp.models import MediaAsset, Track, TrackRole
    from podcast_mcp.util.progress import NullProgress

    proj = load_project(minimal_project)
    dest = Path(proj.workspace_dir) / "raw" / "host.wav"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=str(dest)),
        )
    ]
    engine = TranscriptionEngine()
    fake = Transcript(
        track_id="host",
        words=[TranscriptWord(text="hi", start=0.0, end=0.1)],
    )
    engine.transcribe_track = MagicMock(return_value=fake)  # type: ignore[method-assign]
    progress = MagicMock(wraps=NullProgress())
    out = engine.transcribe_all_dialogue(proj, language="en", progress=progress)
    assert out and out[0].words[0].text == "hi"
    progress.start.assert_called()
    progress.end.assert_called_with("transcribe")


def test_transcribe_all_dialogue_extra_source_and_cache(minimal_project, sample_wav):
    from unittest.mock import MagicMock

    from podcast_mcp.models import Clip, MediaAsset, SourceRecording, Track, TrackRole

    proj = load_project(minimal_project)
    raw = Path(proj.workspace_dir) / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    (raw / "host_b.wav").write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    proj.sources = [
        SourceRecording(id="host_b", path="raw/host_b.wav", speaker="Host", duration_sec=1.0)
    ]
    proj.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=0.0,
            source_id="host_b",
        )
    ]
    engine = TranscriptionEngine()
    engine.transcribe_track = MagicMock(  # type: ignore[method-assign]
        return_value=Transcript(
            track_id="host",
            words=[TranscriptWord(text="hi", start=0.0, end=0.1)],
        )
    )
    extra = Transcript(
        track_id="host",
        words=[TranscriptWord(text="extra", start=0.0, end=0.1)],
    )
    engine.transcribe_file = MagicMock(return_value=extra)  # type: ignore[method-assign]
    out = engine.transcribe_all_dialogue(proj, language="en")
    assert len(out) == 2
    assert out[1].source_id == "host_b"
    engine.transcribe_file.assert_called_once()
    again = engine.transcribe_all_dialogue(proj, language="en")
    assert again[1].source_id == "host_b"
    engine.transcribe_file.assert_called_once()


def test_flag_anomalous_asr_durations_marks_deferred_without_clamping() -> None:
    words = [
        TranscriptWord(text="normal", start=0.0, end=0.4),
        TranscriptWord(text="don't", start=1.0, end=10.3),
        TranscriptWord(text="I'm", start=10.3, end=20.5),
    ]
    flags = flag_anomalous_asr_durations(words, max_word_sec=2.0, track_id="lana")
    assert len(flags) == 2
    assert words[1].end == 10.3
    assert words[2].end == 20.5
    assert words[1].audibility_status == "deferred"
    assert words[2].audibility_status == "deferred"
    assert words[0].audibility_status is None
    assert flags[0]["reason"] == "anomalous_word_duration"
    assert flags[0]["track_id"] == "lana"
    assert flags[0]["duration_sec"] == 9.3


def test_flag_anomalous_asr_durations_skips_mutation_when_requested() -> None:
    words = [TranscriptWord(text="don't", start=1.0, end=10.3)]
    flags = flag_anomalous_asr_durations(words, max_word_sec=2.0, mutate=False)
    assert len(flags) == 1
    assert words[0].audibility_status is None


def test_flag_anomalous_asr_durations_leaves_existing_status() -> None:
    words = [
        TranscriptWord(text="don't", start=1.0, end=10.3, audibility_status="audible"),
    ]
    flags = flag_anomalous_asr_durations(words, max_word_sec=2.0)
    assert flags
    assert words[0].audibility_status == "audible"


def test_word_duration_is_anomalous_threshold() -> None:
    assert word_duration_is_anomalous(2.1, 2.0)
    assert not word_duration_is_anomalous(2.0, 2.0)
    assert not word_duration_is_anomalous(9.0, max_sec=0)


def test_transcribe_file_flags_stretched_words(sample_wav) -> None:
    from unittest.mock import MagicMock, patch

    stretched = MagicMock(word=" don't ", start=1.0, end=11.0, probability=0.5)
    engine = TranscriptionEngine()
    mock_model = MagicMock()
    mock_model.transcribe.return_value = (
        [MagicMock(words=[stretched], text=None, start=1.0, end=11.0)],
        None,
    )
    with patch.object(engine, "_get_model", return_value=mock_model):
        transcript = engine.transcribe_file(sample_wav, language="en")
    assert len(transcript.words) == 1
    assert transcript.words[0].text == "don't"
    assert transcript.words[0].end == 11.0
    assert transcript.words[0].audibility_status == "deferred"


def test_transcribe_track_rejects_workspace_escape(minimal_project, tmp_path, sample_wav):
    from podcast_mcp.engines.transcribe import TranscriptionEngine
    from podcast_mcp.models import MediaAsset, Track, TrackRole, load_project, save_project

    proj = load_project(minimal_project)
    dest = Path(proj.workspace_dir) / "raw" / "host.wav"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=str(dest)),
        )
    ]
    outside = tmp_path / "secret.wav"
    outside.write_bytes(b"x")
    assert proj.tracks[0].media is not None
    proj.tracks[0].media.path = str(outside)
    save_project(proj, minimal_project)
    engine = TranscriptionEngine()
    with pytest.raises(ValueError, match="under workspace"):
        engine.transcribe_track(load_project(minimal_project), "host")

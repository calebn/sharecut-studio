from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines.asr_timing import word_duration_is_anomalous
from podcast_mcp.engines.transcribe import (
    TranscriptionEngine,
    collect_punctuation_outlier_flags,
    flag_anomalous_asr_durations,
    track_punctuation_rate,
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
    engine = TranscriptionEngine(defaults=load_defaults())
    combined = engine.merge_transcripts(proj)
    assert isinstance(combined, CombinedTranscript)
    assert combined.utterances[0].text.startswith("Hello")
    assert combined.utterances[-1].text == "Later"


def test_engine_rejects_unknown_model() -> None:
    with pytest.raises(ValueError, match="Unknown Whisper model"):
        TranscriptionEngine(
            model_size="attacker/malicious-faster-whisper", defaults=load_defaults()
        )


def test_cache_path_stable(minimal_project, sample_wav, tmp_workspace):
    proj = load_project(minimal_project)
    engine = TranscriptionEngine(defaults=load_defaults())
    p1 = engine.cache_path(proj, "host", sample_wav)
    p2 = engine.cache_path(proj, "host", sample_wav)
    assert p1 == p2
    assert "host_" in p1.name


def test_cache_path_sanitizes_unsafe_id(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    engine = TranscriptionEngine(defaults=load_defaults())
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
    combined = TranscriptionEngine(defaults=load_defaults()).merge_transcripts(proj)
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
    engine = TranscriptionEngine(defaults=load_defaults())
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


def test_transcribe_file_passes_vad_and_decode_kwargs(sample_wav):
    from unittest.mock import MagicMock, patch

    engine = TranscriptionEngine(defaults=load_defaults())
    model = MagicMock()
    model.transcribe.return_value = ([], None)
    with patch.object(engine, "_get_model", return_value=model):
        engine.transcribe_file(sample_wav, language="en")
    kw = model.transcribe.call_args.kwargs
    assert kw["vad_filter"] is True
    assert kw["vad_parameters"] == {
        "threshold": 0.4,
        "min_silence_duration_ms": 500,
        "speech_pad_ms": 300,
    }
    assert kw["temperature"] == [0.0, 0.2, 0.4]
    assert kw["hallucination_silence_threshold"] == 2.0
    assert kw["condition_on_previous_text"] is True
    assert "initial_prompt" not in kw and "hotwords" not in kw


def test_transcribe_file_sends_prompt_as_hotwords_without_conditioning(sample_wav):
    from unittest.mock import MagicMock, patch

    from podcast_mcp.engines.asr_options import AsrOptions

    engine = TranscriptionEngine(
        options=AsrOptions(condition_on_previous_text=False), defaults=load_defaults()
    )
    model = MagicMock()
    model.transcribe.return_value = ([], None)
    with patch.object(engine, "_get_model", return_value=model):
        engine.transcribe_file(sample_wav, language="en", initial_prompt="glossary")
    kw = model.transcribe.call_args.kwargs
    assert kw["hotwords"] == "glossary"
    assert "initial_prompt" not in kw


def test_transcribe_track_not_found_raises(minimal_project):
    engine = TranscriptionEngine(defaults=load_defaults())
    proj = load_project(minimal_project)
    with pytest.raises(ValueError, match="not found"):
        engine.transcribe_track(proj, "missing")


def test_transcribe_file_skips_blank_segment_text(sample_wav):
    from unittest.mock import MagicMock, patch

    blank = MagicMock(text="   ", start=0.0, end=0.5, words=None)
    engine = TranscriptionEngine(defaults=load_defaults())
    mock_model = MagicMock()
    mock_model.transcribe.return_value = ([blank], None)
    with patch.object(engine, "_get_model", return_value=mock_model):
        transcript = engine.transcribe_file(sample_wav, language="en")
    assert transcript.words == []


def test_get_model_lazy_loads_whisper(tmp_path, monkeypatch):
    blob = tmp_path / "models--Systran--faster-whisper-tiny" / "blobs" / "model.bin"
    blob.parent.mkdir(parents=True)
    blob.write_bytes(b"x")
    monkeypatch.setattr("podcast_mcp.config.defaults.whisper_cache_dir", lambda: tmp_path)

    engine = TranscriptionEngine(model_size="tiny", device="cpu", defaults=load_defaults())

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

    gpu = TranscriptionEngine(model_size="tiny", device="cuda", defaults=load_defaults())
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
    engine = TranscriptionEngine(defaults=load_defaults())
    fake = Transcript(
        track_id="host",
        words=[TranscriptWord(text="hi", start=0.0, end=0.1)],
    )
    engine.transcribe_file = MagicMock(return_value=fake)  # type: ignore[method-assign]
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
    engine = TranscriptionEngine(defaults=load_defaults())
    primary = Transcript(track_id="host", words=[TranscriptWord(text="hi", start=0.0, end=0.1)])
    extra = Transcript(track_id="host", words=[TranscriptWord(text="extra", start=0.0, end=0.1)])
    engine.transcribe_file = MagicMock(side_effect=[primary, extra])  # type: ignore[method-assign]
    out = engine.transcribe_all_dialogue(proj, language="en")
    assert len(out) == 2
    assert out[1].source_id == "host_b"
    assert out[0].audio_sha256 and out[1].audio_sha256
    assert engine.transcribe_file.call_count == 2
    again = engine.transcribe_all_dialogue(proj, language="en")
    assert again[1].source_id == "host_b"
    assert engine.transcribe_file.call_count == 2


def test_transcribe_all_dialogue_skips_missing_extra_source(minimal_project):
    from unittest.mock import MagicMock

    from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole

    proj = load_project(minimal_project)
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    proj.sources = []
    host = Path(proj.workspace_dir) / "raw" / "host.wav"
    host.parent.mkdir(parents=True, exist_ok=True)
    host.write_bytes(b"audio")
    proj.clips = [
        Clip(
            id="missing-extra",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=0.0,
            source_id="missing-source",
        )
    ]
    engine = TranscriptionEngine(defaults=load_defaults())
    engine.transcribe_file = MagicMock(  # type: ignore[method-assign]
        return_value=Transcript(track_id="host", words=[])
    )

    out = engine.transcribe_all_dialogue(proj, language="en")

    assert len(out) == 1
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


def test_flag_anomalous_asr_durations_flags_an_overlong_word_under_the_cap() -> None:
    words = [
        TranscriptWord(text="-huh.", start=1.0, end=2.5, overlong=True),
        TranscriptWord(text="-huh.", start=3.0, end=4.5),
    ]
    flags = flag_anomalous_asr_durations(words, max_word_sec=2.0, track_id="lana")
    assert [(f["word_index"], f["start"], f["end"]) for f in flags] == [(0, 1.0, 2.5)]
    assert [w.audibility_status for w in words] == ["deferred", None]


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


def _words(n: int, punctuated: int, *, text: str = "word", mark: str = ".") -> list[TranscriptWord]:
    """``n`` words, the first ``punctuated`` ending in ``mark``."""
    return [
        TranscriptWord(
            text=(f"{text}{mark}" if i < punctuated else text), start=float(i), end=i + 0.4
        )
        for i in range(n)
    ]


def test_track_punctuation_rate_below_min_words_is_none() -> None:
    assert track_punctuation_rate(_words(99, 99)) is None


def test_track_punctuation_rate_computes_fraction() -> None:
    assert track_punctuation_rate(_words(100, 25)) == 0.25


def test_track_punctuation_rate_strips_trailing_quotes_and_brackets() -> None:
    # Closing quote/bracket codepoints, not literal characters, so a diff can't confuse
    # them with an ASCII lookalike: RIGHT SINGLE/DOUBLE QUOTATION MARK plus the ASCII set.
    closers = "\"')]}" + "".join(chr(cp) for cp in (0x2019, 0x201D))
    quoted = _words(100, 0)
    for i, mark in enumerate(closers):
        quoted[i] = TranscriptWord(text=f"word.{mark}", start=float(i), end=i + 0.4)
    assert track_punctuation_rate(quoted) == pytest.approx(len(closers) / 100)


def test_track_punctuation_rate_counts_cjk_terminal_marks() -> None:
    # IDEOGRAPHIC FULL STOP, FULLWIDTH EXCLAMATION MARK, FULLWIDTH QUESTION MARK, by
    # codepoint rather than literally.
    marks = "".join(chr(cp) for cp in (0x3002, 0xFF01, 0xFF1F))
    text = chr(0x4F60) + chr(0x597D)  # 你好 ("hello")
    words = _words(100, 0, text=text)
    for i, mark in enumerate(marks):
        words[i] = TranscriptWord(text=f"{text}{mark}", start=float(i), end=i + 0.4)
    assert track_punctuation_rate(words) == pytest.approx(len(marks) / 100)


def test_collect_punctuation_outlier_flags_flags_track_far_below_peers(minimal_project) -> None:
    proj = load_project(minimal_project)
    proj.transcripts = [
        Transcript(track_id="caleb", words=_words(100, 1)),
        Transcript(track_id="audra", words=_words(100, 15)),
        Transcript(track_id="lana", words=_words(100, 18)),
    ]
    flags = collect_punctuation_outlier_flags(proj)
    assert len(flags) == 1
    assert flags[0]["track_id"] == "caleb"
    assert flags[0]["reason"] == "punctuation_rate_outlier"
    assert flags[0]["punctuation_rate"] == pytest.approx(0.01)


def test_collect_punctuation_outlier_flags_needs_two_tracks(minimal_project) -> None:
    proj = load_project(minimal_project)
    proj.transcripts = [Transcript(track_id="caleb", words=_words(100, 1))]
    assert collect_punctuation_outlier_flags(proj) == []


def test_collect_punctuation_outlier_flags_skips_uniformly_low_peers(minimal_project) -> None:
    """No peer with a real punctuation rate to compare against: nothing to flag."""
    proj = load_project(minimal_project)
    proj.transcripts = [
        Transcript(track_id="caleb", words=_words(100, 0)),
        Transcript(track_id="audra", words=_words(100, 1)),
    ]
    assert collect_punctuation_outlier_flags(proj) == []


def test_transcribe_file_flags_stretched_words(sample_wav) -> None:
    from unittest.mock import MagicMock, patch

    stretched = MagicMock(word=" don't ", start=1.0, end=11.0, probability=0.5)
    engine = TranscriptionEngine(defaults=load_defaults())
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
    engine = TranscriptionEngine(defaults=load_defaults())
    with pytest.raises(ValueError, match="under workspace"):
        engine.transcribe_track(load_project(minimal_project), "host")


def _dialogue_project(minimal_project, sample_wav, extra: bool = False):
    from podcast_mcp.models import Clip, MediaAsset, SourceRecording, Track, TrackRole

    proj = load_project(minimal_project)
    raw = Path(proj.workspace_dir) / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    if extra:
        (raw / "b.wav").write_bytes(b"other")
        proj.sources = [SourceRecording(id="b", path="raw/b.wav", speaker="H", duration_sec=1.0)]
        clip = dict(track_id="host", source_start=0.0, source_end=1.0, source_id="b")
        proj.clips = [
            Clip(id="c1", timeline_start=0.0, **clip),
            Clip(id="c2", timeline_start=1.0, **clip),
        ]
    return proj


def test_dialogue_transcribe_jobs_orders_primary_first_and_dedups(minimal_project, sample_wav):
    from podcast_mcp.engines.transcribe import dialogue_transcribe_jobs

    proj = _dialogue_project(minimal_project, sample_wav, extra=True)
    jobs = dialogue_transcribe_jobs(proj)
    assert [j.key for j in jobs] == [("host", None), ("host", "b")]
    assert jobs[1].cache_id == "host__b"
    assert jobs[1].label == "Track host source b"


def test_transcribe_file_reports_segment_progress(sample_wav):
    from types import SimpleNamespace
    from unittest.mock import MagicMock, patch

    from podcast_mcp.util.progress import RecordingProgress, bind_progress

    rec = RecordingProgress()
    segs = [
        SimpleNamespace(text="a", start=0.0, end=4.0, words=None),
        SimpleNamespace(text="b", start=4.0, end=9.0, words=None),
    ]
    engine = TranscriptionEngine(defaults=load_defaults())
    model = MagicMock()
    model.transcribe.return_value = (segs, SimpleNamespace(duration=10.0))
    with patch.object(engine, "_get_model", return_value=model), bind_progress(rec):
        engine.transcribe_file(sample_wav, language="en")
    starts = [e for e in rec.events if e.kind == "start" and e.task_id == "transcribe_audio"]
    assert starts and starts[0].total == 10
    updates = [
        e.current for e in rec.events if e.kind == "update" and e.task_id == "transcribe_audio"
    ]
    assert 4 in updates and 9 in updates


def test_transcribe_all_dialogue_stamps_audio_hash(minimal_project, sample_wav):
    from unittest.mock import MagicMock

    from podcast_mcp.util.hashing import sha256_file

    proj = _dialogue_project(minimal_project, sample_wav)
    engine = TranscriptionEngine(defaults=load_defaults())
    engine.transcribe_file = MagicMock(  # type: ignore[method-assign]
        return_value=Transcript(track_id="", words=[])
    )
    out = engine.transcribe_all_dialogue(proj, language="en")
    assert out[0].audio_sha256 == sha256_file(Path(proj.workspace_dir) / "raw" / "host.wav")


def _silent_job_engine(minimal_project, tmp_path, options=None):
    """Engine whose ASR returns one word over a digital-silence wav."""
    import wave
    from unittest.mock import patch

    from podcast_mcp.engines.transcribe import TranscribeJob
    from podcast_mcp.models import Transcript, TranscriptWord

    proj = load_project(minimal_project)
    wav = tmp_path / "silent.wav"
    with wave.open(str(wav), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(8000)
        f.writeframes(b"\x00\x00" * 16000)
    job = TranscribeJob(track_id="host", source_id=None, audio=wav)
    engine = TranscriptionEngine(options=options, defaults=load_defaults())
    asr = Transcript(track_id="", words=[TranscriptWord(text="thanks", start=0.2, end=0.6)])
    return proj, job, engine, patch.object(engine, "transcribe_file", return_value=asr)


def test_transcribe_job_flags_silent_word_but_caches_unflagged_words(minimal_project, tmp_path):
    proj, job, engine, patcher = _silent_job_engine(minimal_project, tmp_path)
    with patcher:
        tr = engine.transcribe_job(proj, job, language="en")
    assert tr.words[0].suspect_hallucination
    cached = engine.cache_path(proj, job.cache_id, job.audio, language="en")
    text = cached.read_text(encoding="utf-8")
    assert '"suspect_hallucination": true' not in text
    assert '"suspect_hallucination": false' in text


def test_transcribe_job_cache_hit_recomputes_flags_from_current_settings(minimal_project, tmp_path):
    from unittest.mock import patch

    from podcast_mcp.engines.asr_options import AsrOptions

    proj, job, engine, patcher = _silent_job_engine(minimal_project, tmp_path)
    with patcher:
        first = engine.transcribe_job(proj, job, language="en")
    assert first.words[0].suspect_hallucination
    off = TranscriptionEngine(
        options=AsrOptions(silence_filter_enabled=False), defaults=load_defaults()
    )
    with patch.object(off, "transcribe_file") as asr:
        tr = off.transcribe_job(proj, job, language="en")
    asr.assert_not_called()
    assert not tr.words[0].suspect_hallucination


def test_transcribe_job_decode_failure_clears_flags_and_records_skip(minimal_project, tmp_path):
    from unittest.mock import patch

    proj, job, engine, patcher = _silent_job_engine(minimal_project, tmp_path)
    with (
        patcher as asr_call,
        patch("podcast_mcp.engines.asr_silence.flag_silent_words_in_file", return_value=None),
    ):
        asr_call.return_value.words[0].suspect_hallucination = True
        tr = engine.transcribe_job(proj, job, language="en")
    assert not tr.words[0].suspect_hallucination
    assert engine.silence_filter_skipped == [job.label]


def test_transcribe_job_silence_filter_can_be_disabled(minimal_project, tmp_path):
    from podcast_mcp.engines.asr_options import AsrOptions

    proj, job, engine, patcher = _silent_job_engine(
        minimal_project, tmp_path, AsrOptions(silence_filter_enabled=False)
    )
    with patcher:
        tr = engine.transcribe_job(proj, job, language="en")
    assert not tr.words[0].suspect_hallucination


def _loop_segments(loop_words: int = 221):
    from types import SimpleNamespace

    def seg(texts, start, step, ratio):
        words = [
            SimpleNamespace(
                word=f" {t}", start=start + i * step, end=start + i * step + 0.0005, probability=0.9
            )
            for i, t in enumerate(texts)
        ]
        return SimpleNamespace(
            text=" ".join(texts),
            start=words[0].start,
            end=words[-1].end,
            words=words,
            compression_ratio=ratio,
            temperature=0.4,
        )

    real = seg([f"word{i}" for i in range(20)], 294.0, 0.3, 1.4)
    loop_texts = (["And", "I", "know", "that"] * loop_words)[:loop_words]
    loop = seg(loop_texts, 299.84, 0.12 / loop_words, 14.0)
    return real, loop


def test_transcribe_file_drops_a_looped_window(sample_wav):
    from unittest.mock import MagicMock, patch

    real, loop = _loop_segments()
    engine = TranscriptionEngine(defaults=load_defaults())
    model = MagicMock()
    model.transcribe.return_value = ([real, loop], None)
    with patch.object(engine, "_get_model", return_value=model):
        transcript = engine.transcribe_file(sample_wav, language="en")
    assert [w.text for w in transcript.words] == [f"word{i}" for i in range(20)]
    drop = engine._loop_drop
    assert drop is not None
    assert drop.dropped == 221
    assert drop.start == pytest.approx(299.84)
    assert drop.end == pytest.approx(299.96, abs=0.001)
    assert set(model.transcribe.call_args.kwargs) == {
        "language",
        "word_timestamps",
        *engine.options.transcribe_kwargs(),
    }


def test_transcribe_file_drops_the_loop_before_the_duration_flags(sample_wav):
    from unittest.mock import MagicMock, patch

    real, loop = _loop_segments()
    engine = TranscriptionEngine(defaults=load_defaults())
    model = MagicMock()
    model.transcribe.return_value = ([real, loop], None)
    seen: list[int] = []

    def spy(words, **kwargs):
        seen.append(len(words))

    with (
        patch.object(engine, "_get_model", return_value=model),
        patch("podcast_mcp.engines.transcribe.flag_anomalous_asr_durations", spy),
    ):
        engine.transcribe_file(sample_wav, language="en")
    assert seen == [20]


def test_transcribe_file_without_a_loop_records_nothing(sample_wav):
    from unittest.mock import MagicMock, patch

    real, _ = _loop_segments()
    engine = TranscriptionEngine(defaults=load_defaults())
    model = MagicMock()
    model.transcribe.return_value = ([real], None)
    with patch.object(engine, "_get_model", return_value=model):
        transcript = engine.transcribe_file(sample_wav, language="en")
    assert len(transcript.words) == 20
    assert engine._loop_drop is None


def test_decode_key_does_not_change_with_the_loop_guard():
    from podcast_mcp.engines.asr_options import AsrOptions

    assert AsrOptions().decode_key() == {
        "vad": {"threshold": 0.4, "min_silence_duration_ms": 500, "speech_pad_ms": 300},
        "temperature": [0.0, 0.2, 0.4],
        "no_speech_threshold": 0.6,
        "log_prob_threshold": -1.0,
        "compression_ratio_threshold": 2.4,
        "condition_on_previous_text": True,
        "hallucination_silence_threshold": 2.0,
    }


def _legacy_looped_cache(engine, proj, job, sha):
    from podcast_mcp.models import Transcript, TranscriptWord

    words = [
        TranscriptWord(text=f"word{i}", start=294.0 + i * 0.3, end=294.2 + i * 0.3)
        for i in range(20)
    ]
    words += [
        TranscriptWord(text=t, start=299.84 + i * 0.0005, end=299.8405 + i * 0.0005)
        for i, t in enumerate((["And", "I", "know", "that"] * 56)[:221])
    ]
    cache = engine.cache_path(proj, job.cache_id, job.audio, audio_sha256=sha)
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(Transcript(track_id="host", words=words).model_dump_json(), encoding="utf-8")
    return cache


def test_read_asr_cache_repairs_a_legacy_cache_that_holds_a_loop(minimal_project, sample_wav):
    from podcast_mcp.engines.transcribe import TranscribeJob

    proj = _dialogue_project(minimal_project, sample_wav)
    job = TranscribeJob(track_id="host", source_id=None, audio=sample_wav)
    engine = TranscriptionEngine(defaults=load_defaults())
    cache = _legacy_looped_cache(engine, proj, job, "ab" * 32)
    path, first = engine.read_asr_cache(
        proj, job, language=None, initial_prompt=None, audio_sha256="ab" * 32
    )
    assert path == cache
    assert first is not None
    assert len(first.words) == 20
    assert engine._loop_drop is not None
    assert engine._loop_drop.dropped == 221
    _, second = engine.read_asr_cache(
        proj, job, language=None, initial_prompt=None, audio_sha256="ab" * 32
    )
    assert second is not None
    assert len(second.words) == 20
    assert engine._loop_drop is not None
    assert engine._loop_drop.dropped == 221


def test_read_asr_cache_repair_is_not_written_back_and_is_found_again(minimal_project, sample_wav):
    from podcast_mcp.engines.transcribe import TranscribeJob

    proj = _dialogue_project(minimal_project, sample_wav)
    job = TranscribeJob(track_id="host", source_id=None, audio=sample_wav)
    engine = TranscriptionEngine(defaults=load_defaults())
    cache = _legacy_looped_cache(engine, proj, job, "cd" * 32)
    before = cache.read_text(encoding="utf-8")
    engine.read_asr_cache(proj, job, language=None, initial_prompt=None, audio_sha256="cd" * 32)
    assert cache.read_text(encoding="utf-8") == before
    again = TranscriptionEngine(defaults=load_defaults())
    _, repaired = again.read_asr_cache(
        proj, job, language=None, initial_prompt=None, audio_sha256="cd" * 32
    )
    assert repaired is not None
    assert len(repaired.words) == 20
    assert again._loop_drop is not None
    assert again._loop_drop.dropped == 221


def test_transcribe_job_reports_a_fresh_drop_and_the_cache_written_has_none(
    minimal_project, tmp_path
):
    from unittest.mock import MagicMock, patch

    proj, job, engine, _ = _silent_job_engine(minimal_project, tmp_path)
    real, loop = _loop_segments()
    model = MagicMock()
    model.transcribe.return_value = ([real, loop], None)
    with patch.object(engine, "_get_model", return_value=model):
        transcript = engine.transcribe_job(proj, job, language="en")
    assert len(transcript.words) == 20
    assert engine.asr_loop_drops == [
        {
            "label": job.label,
            "track_id": "host",
            "dropped": 221,
            "start": pytest.approx(299.84),
            "end": pytest.approx(299.96, abs=0.001),
            "dense_words": 0,
            "looped_segments": 0,
        }
    ]
    cached = TranscriptionEngine(defaults=load_defaults())
    with patch.object(cached, "transcribe_file") as again:
        out = cached.transcribe_job(proj, job, language="en")
    again.assert_not_called()
    assert len(out.words) == 20
    assert cached.asr_loop_drops == []


def test_transcribe_job_reports_a_loop_repaired_from_a_legacy_cache(minimal_project, tmp_path):
    from unittest.mock import patch

    from podcast_mcp.util.hashing import sha256_file

    proj, job, engine, _ = _silent_job_engine(minimal_project, tmp_path)
    _legacy_looped_cache(engine, proj, job, sha256_file(job.audio))
    with patch.object(engine, "transcribe_file") as asr:
        transcript = engine.transcribe_job(proj, job)
    asr.assert_not_called()
    assert len(transcript.words) == 20
    assert [e["dropped"] for e in engine.asr_loop_drops] == [221]


def test_transcribe_job_without_a_drop_reports_nothing(minimal_project, tmp_path):
    proj, job, engine, patcher = _silent_job_engine(minimal_project, tmp_path)
    with patcher:
        engine.transcribe_job(proj, job, language="en")
    assert engine.asr_loop_drops == []

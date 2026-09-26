from __future__ import annotations

import hashlib
import json

import pytest

from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.models import Transcript, TranscriptWord, load_project


def test_transcript_cache_keeps_short_file_hash(minimal_project, tmp_path):
    project = load_project(minimal_project)
    audio = tmp_path / "recording.wav"
    audio.write_bytes(b"recording")

    cache = TranscriptionEngine().cache_path(project, "host", audio)

    assert cache.name.startswith(f"host_{hashlib.sha256(b'recording').hexdigest()[:16]}_")
    assert cache.name.endswith(".json")
    assert TranscriptionEngine().cache_path(project, "host", audio, initial_prompt="New") != cache


def test_transcript_cache_rejects_outward_symlink(minimal_project, tmp_path):
    project = load_project(minimal_project)
    audio = tmp_path / "recording.wav"
    audio.write_bytes(b"recording")
    name = TranscriptionEngine().cache_path(project, "host", audio).name
    project.transcripts_dir().mkdir(parents=True, exist_ok=True)
    (project.transcripts_dir() / name).symlink_to(audio)
    with pytest.raises(ValueError, match="transcript cache escaped"):
        TranscriptionEngine().cache_path(project, "host", audio)


def test_transcribe_track_uses_cache(minimal_project, sample_wav, tmp_workspace):
    proj = load_project(minimal_project)
    from podcast_mcp.models import MediaAsset, Track, TrackRole, save_project

    (tmp_workspace / "raw").mkdir(exist_ok=True)
    dest = tmp_workspace / "raw" / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    proj.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    )
    save_project(proj, minimal_project)
    proj = load_project(minimal_project)

    engine = TranscriptionEngine()
    cached = Transcript(
        track_id="host",
        words=[TranscriptWord(text="cached", start=0.0, end=0.5)],
    )
    cache_path = engine.cache_path(proj, "host", dest)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(cached.model_dump_json(), encoding="utf-8")

    result = engine.transcribe_track(proj, "host", use_cache=True)
    assert result.words[0].text == "cached"


def test_transcribe_track_recomputes_after_prompt_change(
    minimal_project, sample_wav, tmp_workspace
):
    from unittest.mock import patch

    from podcast_mcp.models import MediaAsset, Track, TrackRole, save_project

    proj = load_project(minimal_project)
    (tmp_workspace / "raw").mkdir(exist_ok=True)
    dest = tmp_workspace / "raw" / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    proj.tracks.append(
        Track(
            id="host", label="Host", role=TrackRole.DIALOGUE, media=MediaAsset(path="raw/host.wav")
        )
    )
    save_project(proj, minimal_project)
    proj = load_project(minimal_project)
    engine = TranscriptionEngine()
    fresh = Transcript(track_id="host", words=[TranscriptWord(text="fresh", start=0, end=0.5)])
    with patch.object(engine, "transcribe_file", return_value=fresh) as transcribe:
        assert engine.transcribe_track(proj, "host", initial_prompt="Old").words[0].text == "fresh"
        assert engine.transcribe_track(proj, "host", initial_prompt="Old").words[0].text == "fresh"
        assert transcribe.call_count == 1
        engine.transcribe_track(proj, "host", initial_prompt="New")
        assert transcribe.call_count == 2


def test_transcribe_track_writes_cache_on_miss(minimal_project, sample_wav, tmp_workspace):
    from unittest.mock import patch

    from podcast_mcp.models import MediaAsset, Track, TrackRole, save_project

    proj = load_project(minimal_project)
    (tmp_workspace / "raw").mkdir(exist_ok=True)
    dest = tmp_workspace / "raw" / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    proj.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    )
    save_project(proj, minimal_project)
    proj = load_project(minimal_project)

    engine = TranscriptionEngine()
    cached = Transcript(
        track_id="host",
        words=[TranscriptWord(text="fresh", start=0.0, end=0.5)],
    )
    with patch.object(engine, "transcribe_file", return_value=cached):
        result = engine.transcribe_track(proj, "host", use_cache=True)
    assert result.words[0].text == "fresh"
    cache_path = engine.cache_path(proj, "host", dest)
    assert cache_path.is_file()
    assert json.loads(cache_path.read_text(encoding="utf-8"))["words"][0]["text"] == "fresh"


def test_transcribe_track_absolute_audio_path(minimal_project, sample_wav, tmp_workspace):
    from unittest.mock import patch

    from podcast_mcp.models import MediaAsset, Track, TrackRole, save_project

    proj = load_project(minimal_project)
    (tmp_workspace / "raw").mkdir(exist_ok=True)
    dest = tmp_workspace / "raw" / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    proj.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=str(dest.resolve())),
        )
    )
    save_project(proj, minimal_project)
    proj = load_project(minimal_project)

    engine = TranscriptionEngine()
    cached = Transcript(
        track_id="host",
        words=[TranscriptWord(text="abs", start=0.0, end=0.5)],
    )
    with patch.object(engine, "transcribe_file", return_value=cached) as transcribe:
        result = engine.transcribe_track(proj, "host", use_cache=False)
    assert result.words[0].text == "abs"
    assert transcribe.call_args.args[0] == dest.resolve()


def _host_project(minimal_project, sample_wav, tmp_workspace):
    from podcast_mcp.models import MediaAsset, Track, TrackRole, save_project

    proj = load_project(minimal_project)
    (tmp_workspace / "raw").mkdir(exist_ok=True)
    dest = tmp_workspace / "raw" / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    proj.tracks.append(
        Track(
            id="host", label="Host", role=TrackRole.DIALOGUE, media=MediaAsset(path="raw/host.wav")
        )
    )
    save_project(proj, minimal_project)
    return load_project(minimal_project), dest


def _write_legacy(proj, dest):
    from podcast_mcp.engines.transcribe import legacy_cache_path
    from podcast_mcp.util.hashing import sha256_file

    legacy = legacy_cache_path(proj, "host", sha256_file(dest))
    legacy.parent.mkdir(parents=True, exist_ok=True)
    tr = Transcript(track_id="host", words=[TranscriptWord(text="legacy", start=0, end=0.5)])
    legacy.write_text(tr.model_dump_json(), encoding="utf-8")


def test_legacy_cache_name_is_honoured_by_default(minimal_project, sample_wav, tmp_workspace):
    from unittest.mock import patch

    proj, dest = _host_project(minimal_project, sample_wav, tmp_workspace)
    _write_legacy(proj, dest)
    engine = TranscriptionEngine()
    with patch.object(engine, "transcribe_file") as asr:
        out = engine.transcribe_all_dialogue(proj, language="en")
    asr.assert_not_called()
    assert out[0].words[0].text == "legacy"
    assert out[0].audio_sha256


def test_legacy_cache_ignored_with_prompt_or_when_disabled(
    minimal_project, sample_wav, tmp_workspace
):
    from unittest.mock import patch

    proj, dest = _host_project(minimal_project, sample_wav, tmp_workspace)
    _write_legacy(proj, dest)
    engine = TranscriptionEngine()
    fresh = Transcript(track_id="", words=[TranscriptWord(text="fresh", start=0, end=0.5)])
    with patch.object(engine, "transcribe_file", return_value=fresh) as asr:
        with_prompt = engine.transcribe_all_dialogue(proj, language="en", initial_prompt="P")
        disabled = engine.transcribe_all_dialogue(proj, language="en", use_cache=False)
    assert asr.call_count == 2
    assert with_prompt[0].words[0].text == disabled[0].words[0].text == "fresh"


def test_corrupt_cache_is_a_miss_and_is_rewritten(
    minimal_project, sample_wav, tmp_workspace, caplog
):
    from unittest.mock import patch

    proj, dest = _host_project(minimal_project, sample_wav, tmp_workspace)
    engine = TranscriptionEngine()
    cache = engine.cache_path(proj, "host", dest, language="en")
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text('{"track_id": "host", "words": [', encoding="utf-8")
    fresh = Transcript(track_id="", words=[TranscriptWord(text="fresh", start=0, end=0.5)])
    with (
        patch.object(engine, "transcribe_file", return_value=fresh) as asr,
        caplog.at_level("WARNING"),
    ):
        out = engine.transcribe_all_dialogue(proj, language="en")
    asr.assert_called_once()
    assert out[0].words[0].text == "fresh"
    assert "unreadable transcript cache" in caplog.text
    assert (
        Transcript.model_validate_json(cache.read_text(encoding="utf-8")).words[0].text == "fresh"
    )


def test_cached_audio_keys_reads_both_names_only_for_that_job(minimal_project):
    from podcast_mcp.engines.transcribe import cached_audio_keys

    proj = load_project(minimal_project)
    tdir = proj.transcripts_dir()
    tdir.mkdir(parents=True, exist_ok=True)
    for name in (
        f"host_{'1' * 16}.json",
        f"host_{'2' * 16}_{'f' * 16}.json",
        f"host__b_{'3' * 16}_{'f' * 16}.json",
        "host.json",
        "combined.json",
    ):
        (tdir / name).write_text("{}", encoding="utf-8")
    assert cached_audio_keys(proj, "host") == {"1" * 16, "2" * 16}
    assert cached_audio_keys(proj, "host__b") == {"3" * 16}

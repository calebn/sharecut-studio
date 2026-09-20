from __future__ import annotations

import json

from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.models import Transcript, TranscriptWord, load_project


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

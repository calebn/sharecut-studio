"""Production call sites stamp first-stream identity terms for several-stream media (#2110)."""

from __future__ import annotations

import json
import re
from pathlib import Path
from unittest.mock import patch

import pytest

import multistream_media as media
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import prosody_profile as pp
from podcast_mcp.engines import speaker_id
from podcast_mcp.engines.asr_options import AsrOptions, ForcedAlignment
from podcast_mcp.engines.asr_silence import silence_filter_fingerprint
from podcast_mcp.engines.transcribe import TranscribeJob, TranscriptionEngine
from podcast_mcp.models import EpisodeProject, Transcript, TranscriptWord
from test_transcribe_word_align import StubAligner

WORDS = [("hi", 0.0, 0.5), ("bye", 0.5, 1.0)]


@pytest.fixture
def pair(tmp_path: Path) -> tuple[Path, Path]:
    several = media.multistream(tmp_path, "st.mkv")
    return several, media.first_stream_only(several, tmp_path)


def _engine(aligned: bool = True, **kwargs) -> TranscriptionEngine:
    options = AsrOptions(
        forced_alignment=ForcedAlignment(requested=aligned, installed=True), **kwargs
    )
    engine = TranscriptionEngine(options=options, defaults=load_defaults())
    engine._word_aligner = StubAligner([(0.1, 0.3), (0.6, 0.9)], n_aligned=2, n_unaligned=0)
    return engine


def _transcribe(engine: TranscriptionEngine, project: EpisodeProject, audio: Path) -> Transcript:
    fresh = Transcript(
        track_id="",
        language="en",
        words=[TranscriptWord(text=t, start=s, end=e) for t, s, e in WORDS],
    )
    job = TranscribeJob(track_id="host", source_id=None, audio=audio)
    with patch.object(engine, "transcribe_file", return_value=fresh):
        return engine.transcribe_job(project, job, language="en")


def _project(tmp_path: Path) -> EpisodeProject:
    project = EpisodeProject.create("t", str(tmp_path / "ws"))
    project.ensure_dirs()
    return project


def _align_key(project: EpisodeProject) -> str:
    (path,) = project.transcripts_dir().glob("*.word_align_*.json")
    return path.name.split(".word_align_")[1]


def test_engine_passes_the_audio_into_the_alignment_cache_key(
    tmp_path: Path, pair: tuple[Path, Path]
) -> None:
    several, single = pair
    keys = []
    for index, audio in enumerate((several, single)):
        project = _project(tmp_path / str(index))
        _transcribe(_engine(), project, audio)
        keys.append(_align_key(project))
    assert keys[0] != keys[1]


def test_transcribe_stamps_the_first_stream_silence_fingerprint(
    tmp_path: Path, pair: tuple[Path, Path]
) -> None:
    several, single = pair
    project = _project(tmp_path)
    for audio, first_stream in ((several, True), (single, False)):
        engine = _engine(aligned=False)
        transcript = _transcribe(engine, project, audio)
        expected = silence_filter_fingerprint(
            transcript.words,
            transcript.audio_sha256 or "",
            engine.options,
            first_stream=first_stream,
        )
        assert transcript.silence_filter_fingerprint == expected


def _analysis(*_args, **_kwargs) -> dict:
    return {
        "engine": {"backend": "stub", "version": pp.parselmouth_version() or "0"},
        "segments": [],
    }


def _prosody_project(tmp_path: Path, audio: Path) -> tuple[EpisodeProject, TranscribeJob]:
    project = _project(tmp_path)
    return project, TranscribeJob(track_id="host", source_id=None, audio=audio)


def _stored_marks(project: EpisodeProject) -> list[int | None]:
    return [
        json.loads(p.read_text(encoding="utf-8")).get("audio_stream")
        for p in sorted(pp.profile_path(project, "host", "x", "y").parent.glob("*.json"))
    ]


def test_prosody_marks_the_first_stream_and_reanalyzes_an_unmarked_profile(
    tmp_path: Path, pair: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    several, _ = pair
    project, job = _prosody_project(tmp_path, several)
    params = pp.ProsodyParams.from_defaults(load_defaults())
    monkeypatch.setattr(pp, "analyze_prosody_file", _analysis)

    assert pp._analyze_track(project, "host", job, params) == "computed"
    assert _stored_marks(project) == [0]
    assert pp._analyze_track(project, "host", job, params) == "reused"

    stored = pp._existing_profile(project, "host")
    assert stored is not None
    stored.audio_stream = None
    for path in pp.profile_path(project, "host", "x", "y").parent.glob("*.json"):
        path.write_text(json.dumps(stored.to_json()), encoding="utf-8")
    assert pp._analyze_track(project, "host", job, params) == "computed"
    assert _stored_marks(project) == [0]


def test_prosody_single_stream_stays_unmarked_and_reused(
    tmp_path: Path, pair: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    _, single = pair
    project, job = _prosody_project(tmp_path, single)
    params = pp.ProsodyParams.from_defaults(load_defaults())
    monkeypatch.setattr(pp, "analyze_prosody_file", _analysis)

    assert pp._analyze_track(project, "host", job, params) == "computed"
    assert _stored_marks(project) == [None]
    assert pp._analyze_track(project, "host", job, params) == "reused"


def test_speaker_profile_cache_name_has_no_colon_and_matches_the_superseded_pattern(
    tmp_path: Path,
) -> None:
    project = _project(tmp_path)
    path = speaker_id.profile_cache_path(project, "spk/1", "abcdef0123:a0")
    assert ":" not in path.name
    assert re.compile(r"^spk_1_[0-9a-f]+\.json$").match(path.name)

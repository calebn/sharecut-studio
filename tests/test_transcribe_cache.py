from __future__ import annotations

import hashlib
import json

import pytest

from podcast_mcp.engines.asr_options import AsrOptions
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
    from podcast_mcp.util.hashing import sha256_file

    legacy = proj.transcripts_dir() / f"host_{sha256_file(dest)[:16]}.json"
    legacy.parent.mkdir(parents=True, exist_ok=True)
    tr = Transcript(track_id="host", words=[TranscriptWord(text="legacy", start=0, end=0.5)])
    legacy.write_text(tr.model_dump_json(), encoding="utf-8")


def test_cache_key_changes_with_decode_options(minimal_project, sample_wav, tmp_workspace):
    proj, dest = _host_project(minimal_project, sample_wav, tmp_workspace)
    on = TranscriptionEngine(options=AsrOptions())
    off = TranscriptionEngine(options=AsrOptions(vad_enabled=False))
    loops = TranscriptionEngine(options=AsrOptions(condition_on_previous_text=False))
    paths = {e.cache_path(proj, "host", dest) for e in (on, off, loops)}
    assert len(paths) == 3
    assert on.cache_path(proj, "host", dest) == TranscriptionEngine().cache_path(proj, "host", dest)


def test_legacy_cache_ignored_with_non_default_decode_options(
    minimal_project, sample_wav, tmp_workspace
):
    from unittest.mock import patch

    proj, dest = _host_project(minimal_project, sample_wav, tmp_workspace)
    _write_legacy(proj, dest)
    engine = TranscriptionEngine()  # VAD on: legacy words were decoded without it
    with patch.object(
        engine, "transcribe_file", return_value=Transcript(track_id="", words=[])
    ) as asr:
        engine.transcribe_all_dialogue(proj, language="en")
    asr.assert_called_once()


def test_legacy_cache_is_a_miss_and_removed_after_success(
    minimal_project, sample_wav, tmp_workspace
):
    from unittest.mock import patch

    proj, dest = _host_project(minimal_project, sample_wav, tmp_workspace)
    _write_legacy(proj, dest)
    engine = TranscriptionEngine(options=AsrOptions(vad_enabled=False))
    with patch.object(
        engine, "transcribe_file", return_value=Transcript(track_id="", words=[])
    ) as asr:
        engine.transcribe_all_dialogue(proj, language="en")
    asr.assert_called_once()
    from podcast_mcp.util.hashing import sha256_file

    assert not (proj.transcripts_dir() / f"host_{sha256_file(dest)[:16]}.json").exists()


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


def test_cached_audio_keys_reads_current_names_only_for_that_job(minimal_project):
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
    assert cached_audio_keys(proj, "host") == {"2" * 16}
    assert cached_audio_keys(proj, "host__b") == {"3" * 16}


def test_transcript_cache_keeps_auto_detection_separate_from_english(minimal_project, tmp_path):
    project = load_project(minimal_project)
    audio = tmp_path / "recording.wav"
    audio.write_bytes(b"recording")
    engine = TranscriptionEngine()
    auto = engine.cache_path(project, "host", audio, language=None)
    english = engine.cache_path(project, "host", audio, language="en")
    assert auto != english
    assert engine.cache_path(project, "host", audio, language=None) == auto


def test_pipeline_and_transcript_service_share_default_language_cache(
    minimal_project, sample_wav, tmp_workspace
):
    from unittest.mock import patch

    from podcast_mcp.config import load_defaults
    from podcast_mcp.pipeline.steps import transcribe_tracks
    from podcast_mcp.services import ProjectWorkspace, TranscriptService
    from podcast_mcp.services.pipeline_config import config_store

    project, _audio = _host_project(minimal_project, sample_wav, tmp_workspace)
    defaults = load_defaults()
    defaults["transcribe"]["forced_alignment"]["enabled"] = False
    store = config_store()
    store.put(minimal_project, config=defaults)
    try:
        with patch.object(
            TranscriptionEngine,
            "transcribe_file",
            return_value=Transcript(track_id="host", words=[]),
        ) as decode:
            transcribe_tracks(project, defaults)
            workspace = ProjectWorkspace.open(minimal_project)
            TranscriptService(workspace).transcribe()
        assert decode.call_count == 1
        assert decode.call_args.kwargs["language"] == "en"
    finally:
        store.put(minimal_project, reset=True)


@pytest.mark.parametrize("source_id", [None, "guest-source"])
def test_successful_cache_write_keeps_two_variants_and_their_alignments(
    minimal_project, sample_wav, tmp_workspace, source_id
):
    import os
    from unittest.mock import patch

    from podcast_mcp.engines.transcribe import TranscribeJob
    from podcast_mcp.models import Track

    project, audio = _host_project(minimal_project, sample_wav, tmp_workspace)
    job = TranscribeJob("host", source_id, audio)
    engine = TranscriptionEngine()
    current = engine.cache_path(project, job.cache_id, audio, initial_prompt="current")
    current.parent.mkdir(exist_ok=True)
    previous = []
    for i in range(3):
        cache = engine.cache_path(project, job.cache_id, audio, initial_prompt=f"old-{i}")
        cache.write_text(Transcript(track_id="host", words=[]).model_dump_json())
        os.utime(cache, ns=(i + 1, i + 1))
        sidecar = cache.with_name(f"{cache.stem}.word_align_{'a' * 16}.json")
        sidecar.write_text("{}")
        previous.append((cache, sidecar))
    family = current.stem.rsplit("_", 1)[0]
    legacy = current.with_name(f"{family}.json")
    legacy.write_text("{}")
    orphan = current.with_name(f"{family}_{'0' * 16}.word_align_{'b' * 16}.json")
    orphan.write_text("{}")
    protected = [
        current.with_name("host.json"),
        current.with_name("combined.json"),
        current.with_name(f"host__other_{'1' * 16}_{'2' * 16}.json"),
        current.with_name(f"{job.cache_id}_{'3' * 16}_{'4' * 16}.json"),
        current.with_name(f"{family}_not-an-input-key.json"),
    ]
    mirror_name = f"{family}_{'7' * 16}"
    project.tracks.append(Track(id=mirror_name, label="Cache-shaped track"))
    protected.append(current.with_name(f"{mirror_name}.json"))
    for path in protected:
        path.write_text("preserve")
    target = tmp_workspace / "outside-transcripts.txt"
    target.write_text("preserve")
    link = current.with_name(f"{family}_{'5' * 16}.json")
    link.symlink_to(target)
    directory = current.with_name(f"{family}_{'6' * 16}.json")
    directory.mkdir()
    with patch.object(
        engine, "transcribe_file", return_value=Transcript(track_id="", words=[])
    ) as decode:
        engine.transcribe_job(project, job, initial_prompt="current")
        engine.transcribe_job(project, job, initial_prompt="current")
    assert decode.call_count == 1
    assert current.is_file()
    assert previous[2][0].is_file() and previous[2][1].is_file()
    assert all(not path.exists() for pair in previous[:2] for path in pair)
    assert not legacy.exists() and not orphan.exists()
    assert all(path.read_text() == "preserve" for path in protected)
    assert link.is_symlink() and target.read_text() == "preserve"
    assert directory.is_dir()


@pytest.mark.parametrize("failure", ["decode", "write"])
def test_failed_transcription_preserves_prior_cache_family(
    minimal_project, sample_wav, tmp_workspace, failure
):
    from unittest.mock import patch

    project, audio = _host_project(minimal_project, sample_wav, tmp_workspace)
    engine = TranscriptionEngine()
    old = engine.cache_path(project, "host", audio, initial_prompt="old")
    old.parent.mkdir(exist_ok=True)
    legacy = old.with_name(f"{old.stem.rsplit('_', 1)[0]}.json")
    old.write_text("preserve")
    legacy.write_text("preserve legacy")
    with patch.object(
        engine, "transcribe_file", return_value=Transcript(track_id="", words=[])
    ) as decode:
        if failure == "decode":
            decode.side_effect = OSError("decode failed")
        with patch("podcast_mcp.engines.transcribe.write_text_atomic") as write:
            if failure == "write":
                write.side_effect = OSError("write failed")
            with pytest.raises(OSError, match="failed"):
                engine.transcribe_track(project, "host", initial_prompt="new")
    assert old.read_text() == "preserve"
    assert legacy.read_text() == "preserve legacy"


def test_cache_cleanup_failure_keeps_successful_transcription(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, caplog
):
    from pathlib import Path
    from unittest.mock import patch

    project, audio = _host_project(minimal_project, sample_wav, tmp_workspace)
    engine = TranscriptionEngine()
    current = engine.cache_path(project, "host", audio, initial_prompt="new")
    current.parent.mkdir(exist_ok=True)
    legacy = current.with_name(f"{current.stem.rsplit('_', 1)[0]}.json")
    legacy.write_text("old")
    original_unlink = Path.unlink

    def unlink(path, *args, **kwargs):
        if path == legacy:
            raise PermissionError("cache busy")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", unlink)
    with patch.object(engine, "transcribe_file", return_value=Transcript(track_id="", words=[])):
        result = engine.transcribe_track(project, "host", initial_prompt="new")
    assert result.track_id == "host"
    assert current.is_file() and legacy.is_file()
    assert "could not prune transcript cache" in caplog.text


def test_cache_path_rejects_alias_to_canonical_transcript(minimal_project, tmp_path):
    project = load_project(minimal_project)
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"audio")
    engine = TranscriptionEngine()
    cache = engine.cache_path(project, "host", audio)
    cache.parent.mkdir(exist_ok=True)
    canonical = cache.with_name("host.json")
    canonical.write_text("preserve")
    cache.symlink_to(canonical)
    with pytest.raises(ValueError, match="aliases another file"):
        engine.cache_path(project, "host", audio)
    assert canonical.read_text() == "preserve"


def test_concurrent_cache_writers_leave_two_complete_variants(
    minimal_project, sample_wav, tmp_workspace
):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from unittest.mock import patch

    from podcast_mcp.engines.transcribe import TranscribeJob

    project, audio = _host_project(minimal_project, sample_wav, tmp_workspace)
    job = TranscribeJob("host", None, audio)
    barrier = Barrier(4)

    def decode(*args, **kwargs):
        barrier.wait(timeout=5)
        return Transcript(track_id="", words=[])

    def run(prompt):
        return TranscriptionEngine().transcribe_job(project, job, initial_prompt=prompt)

    with patch.object(TranscriptionEngine, "transcribe_file", side_effect=decode):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(run, ["one", "two", "three", "four"]))
    assert [result.track_id for result in results] == ["host"] * 4
    caches = list(project.transcripts_dir().glob("host_*_*.json"))
    assert len(caches) == 2
    assert all(
        Transcript.model_validate_json(path.read_text()).track_id == "host" for path in caches
    )


@pytest.mark.parametrize("failure", ["disappeared", "scan-denied"])
def test_cache_cleanup_handles_filesystem_changes_after_success(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, caplog, failure
):
    from pathlib import Path
    from unittest.mock import patch

    project, audio = _host_project(minimal_project, sample_wav, tmp_workspace)
    engine = TranscriptionEngine()
    cache = engine.cache_path(project, "host", audio, initial_prompt="new")
    cache.parent.mkdir(exist_ok=True)
    legacy = cache.with_name(f"{cache.stem.rsplit('_', 1)[0]}.json")
    legacy.write_text("old")
    original_lstat = Path.lstat
    original_iterdir = Path.iterdir

    def lstat(path):
        if path == legacy:
            legacy.unlink()
            raise FileNotFoundError("cache disappeared")
        return original_lstat(path)

    def iterdir(path):
        if path == cache.parent:
            raise PermissionError("directory unreadable")
        return original_iterdir(path)

    if failure == "disappeared":
        monkeypatch.setattr(Path, "lstat", lstat)
    else:
        monkeypatch.setattr(Path, "iterdir", iterdir)
    with patch.object(engine, "transcribe_file", return_value=Transcript(track_id="", words=[])):
        result = engine.transcribe_track(project, "host", initial_prompt="new")
    assert result.track_id == "host"
    assert cache.is_file()
    if failure == "scan-denied":
        assert "could not scan transcript cache family" in caplog.text


def test_cache_path_rejects_name_collision_with_canonical_mirror(minimal_project, tmp_path):
    from podcast_mcp.models import Track

    project = load_project(minimal_project)
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"audio")
    engine = TranscriptionEngine()
    cache = engine.cache_path(project, "host", audio)
    project.tracks.append(Track(id=cache.stem, label="Cache-shaped track"))
    cache.parent.mkdir(exist_ok=True)
    cache.write_text("preserve")
    with pytest.raises(ValueError, match="collides with a canonical mirror"):
        engine.cache_path(project, "host", audio)
    assert cache.read_text() == "preserve"


def test_cache_publication_timeout_does_not_prune(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from threading import Event, Thread
    from unittest.mock import patch

    from filelock import Timeout

    import podcast_mcp.engines.transcribe as module

    project, audio = _host_project(minimal_project, sample_wav, tmp_workspace)
    engine = TranscriptionEngine()
    cache = engine.cache_path(project, "host", audio, initial_prompt="new")
    cache.parent.mkdir(exist_ok=True)
    legacy = cache.with_name(f"{cache.stem.rsplit('_', 1)[0]}.json")
    legacy.write_text("preserve")
    started, release = Event(), Event()
    monkeypatch.setattr(module, "ASR_CACHE_LOCK_TIMEOUT_SEC", 0.05)

    def hold():
        with module._cache_publication_lock(project, cache):
            started.set()
            release.wait(timeout=5)

    thread = Thread(target=hold)
    thread.start()
    try:
        assert started.wait(timeout=5)
        with patch.object(
            engine, "transcribe_file", return_value=Transcript(track_id="", words=[])
        ):
            with pytest.raises(Timeout):
                engine.transcribe_track(project, "host", initial_prompt="new")
        assert not cache.exists()
        assert legacy.read_text() == "preserve"
    finally:
        release.set()
        thread.join(timeout=5)

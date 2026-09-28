"""Tests for edits/prosody_profile.py: cache write/reuse, reader, and the
timeline-mapped audition-context window. Uses the word_boundary fixture
(gold words) as a small real-speech project."""

from __future__ import annotations

import contextlib
import json
import shutil
from pathlib import Path

import pytest

from podcast_mcp.edits import prosody_profile as pp
from podcast_mcp.engines.prosody import ProsodyParams
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import (
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.util.progress import CancelledProgress
from podcast_mcp.util.timebase import SourceSec

pytestmark = pytest.mark.skipif(
    pp.parselmouth_version() is None, reason="requires the prosody extra (praat-parselmouth)"
)

FIXTURE_WAV = Path(__file__).parent / "fixtures" / "word_boundary" / "5338-24640-0003.wav"
FIXTURE_GOLD = Path(__file__).parent / "fixtures" / "word_boundary" / "5338-24640-0003.gold.json"


def _gold_words() -> list[TranscriptWord]:
    data = json.loads(FIXTURE_GOLD.read_text(encoding="utf-8"))
    return [TranscriptWord(text=w["text"], start=w["start"], end=w["end"]) for w in data["words"]]


def _project_with_host(tmp_workspace: Path, *, with_media: bool = True) -> Path:
    project = EpisodeProject.create("prosody_test", str(tmp_workspace))
    project.ensure_dirs()
    media = None
    if with_media:
        raw = tmp_workspace / "raw"
        raw.mkdir(exist_ok=True)
        dest = raw / "host.wav"
        shutil.copyfile(FIXTURE_WAV, dest)
        media = MediaAsset(path="raw/host.wav")
    project.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host", media=media)
    ]
    project.transcripts = [Transcript(track_id="host", words=_gold_words())]
    return save_project(project)


def test_run_prosody_analysis_computes_and_caches(tmp_workspace: Path) -> None:
    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    result = pp.run_prosody_analysis(proj, {})
    assert result.computed == ["host"]
    assert result.reused == []
    assert not result.unavailable
    assert "1 computed" in result.summary()

    cached = list(pp.prosody_dir(proj).glob("host_*.json"))
    assert len(cached) == 1
    payload = json.loads(cached[0].read_text(encoding="utf-8"))
    assert payload["schema"] == pp.PROFILE_SCHEMA
    assert payload["track_id"] == "host"
    assert payload["segments"]
    assert payload["audio_sha256"]

    # No absolute workspace paths leaked into the cached payload.
    dumped = json.dumps(payload)
    assert str(tmp_workspace) not in dumped
    assert str(tmp_workspace.parent) not in dumped


def test_run_prosody_analysis_reuses_when_unchanged(tmp_workspace: Path) -> None:
    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    first = pp.run_prosody_analysis(proj, {})
    assert first.computed == ["host"]

    proj2 = load_project(path)
    second = pp.run_prosody_analysis(proj2, {})
    assert second.computed == []
    assert second.reused == ["host"]
    assert len(list(pp.prosody_dir(proj2).glob("host_*.json"))) == 1


def test_run_prosody_analysis_refreshes_stats_on_mtime_touch(tmp_workspace: Path) -> None:
    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    pp.run_prosody_analysis(proj, {})
    cached_path = next(pp.prosody_dir(proj).glob("host_*.json"))
    before = json.loads(cached_path.read_text(encoding="utf-8"))

    # Touch the media file's mtime without changing its bytes.
    media_path = tmp_workspace / "raw" / "host.wav"
    new_time = media_path.stat().st_mtime + 5
    import os

    os.utime(media_path, (new_time, new_time))

    proj2 = load_project(path)
    result = pp.run_prosody_analysis(proj2, {})
    assert result.reused == ["host"]
    after = json.loads(cached_path.read_text(encoding="utf-8"))
    assert after["audio_sha256"] == before["audio_sha256"]
    assert after["audio_mtime_ns"] != before["audio_mtime_ns"]
    assert after["segments"] == before["segments"]


def test_run_prosody_analysis_recomputes_on_words_change(tmp_workspace: Path) -> None:
    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    pp.run_prosody_analysis(proj, {})

    proj2 = load_project(path)
    proj2.transcripts[0].words.append(TranscriptWord(text="extra", start=5.97, end=6.1))
    save_project(proj2, path)

    proj3 = load_project(path)
    result = pp.run_prosody_analysis(proj3, {})
    assert result.computed == ["host"]
    assert result.reused == []


def test_run_prosody_analysis_recomputes_on_params_change(tmp_workspace: Path) -> None:
    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    pp.run_prosody_analysis(proj, {})

    proj2 = load_project(path)
    result = pp.run_prosody_analysis(proj2, {"prosody": {"pitch_floor_hz": 90.0}})
    assert result.computed == ["host"]


def test_run_prosody_analysis_recomputes_on_parselmouth_upgrade(
    tmp_workspace: Path, monkeypatch
) -> None:
    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    pp.run_prosody_analysis(proj, {})

    proj2 = load_project(path)
    monkeypatch.setattr(pp, "parselmouth_version", lambda: "999.0")
    result = pp.run_prosody_analysis(proj2, {})
    assert result.computed == ["host"]


def test_load_track_profile_stale_after_algorithm_bump(tmp_workspace: Path, monkeypatch) -> None:
    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    pp.run_prosody_analysis(proj, {})

    proj2 = load_project(path)
    monkeypatch.setattr(pp, "ALGORITHM_VERSION", pp.ALGORITHM_VERSION + 1)
    lookup = pp.load_track_profile(proj2, "host")
    assert lookup.status == "stale"
    assert lookup.hint is not None and "algorithm" in lookup.hint


def test_run_prosody_analysis_prunes_superseded_profiles(tmp_workspace: Path) -> None:
    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    pp.run_prosody_analysis(proj, {})

    proj2 = load_project(path)
    proj2.transcripts[0].words.append(TranscriptWord(text="extra", start=5.97, end=6.1))
    save_project(proj2, path)

    proj3 = load_project(path)
    result = pp.run_prosody_analysis(proj3, {})
    assert result.computed == ["host"]
    assert len(list(pp.prosody_dir(proj3).glob("host_*.json"))) == 1


def test_prefix_sibling_track_cache_is_not_read_or_pruned(tmp_workspace: Path) -> None:
    import os

    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    pp.run_prosody_analysis(proj, {})

    sibling = pp.prosody_dir(proj) / f"host_b_{'a' * 16}_{'b' * 16}.json"
    sibling.write_text(
        json.dumps(
            pp.ProsodyProfile(track_id="host_b", algorithm_version=pp.ALGORITHM_VERSION).to_json()
        ),
        encoding="utf-8",
    )
    future = sibling.stat().st_mtime + 10
    os.utime(sibling, (future, future))

    assert pp._existing_profile(proj, "host").track_id == "host"

    proj2 = load_project(path)
    proj2.transcripts[0].words.append(TranscriptWord(text="extra", start=5.97, end=6.1))
    save_project(proj2, path)
    proj3 = load_project(path)
    pp.run_prosody_analysis(proj3, {})
    assert sibling.exists()


def test_existing_profile_skips_other_schema(tmp_workspace: Path) -> None:
    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    bogus = pp.prosody_dir(proj) / f"host_{'0' * 16}_{'1' * 16}.json"
    bogus.parent.mkdir(parents=True, exist_ok=True)
    bogus.write_text(
        json.dumps({"schema": "prosody_profile.v999", "track_id": "host"}), encoding="utf-8"
    )
    assert pp._existing_profile(proj, "host") is None
    assert pp.load_track_profile(proj, "host").status == "missing"


def test_existing_profile_tolerates_file_removed_before_stat(
    tmp_workspace: Path, monkeypatch
) -> None:
    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    pp.run_prosody_analysis(proj, {})

    real = pp._track_profile_paths(proj, "host")
    ghost = pp.prosody_dir(proj) / f"host_{'f' * 16}_{'e' * 16}.json"
    monkeypatch.setattr(pp, "_track_profile_paths", lambda *_a: [ghost, *real])
    assert pp._existing_profile(proj, "host") is not None


def test_run_prosody_analysis_holds_per_track_lock(tmp_workspace: Path, monkeypatch) -> None:
    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    seen: list[Path] = []

    def fake_lock(lock_path, timeout):
        seen.append(lock_path)
        return contextlib.nullcontext()

    monkeypatch.setattr(pp, "shared_file_lock", fake_lock)
    pp.run_prosody_analysis(proj, {})
    assert [p.name for p in seen] == ["host.lock"]


def test_version_bump_recomputes_and_supersedes_old_file(tmp_workspace: Path, monkeypatch) -> None:
    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    pp.run_prosody_analysis(proj, {})
    (old_file,) = pp.prosody_dir(proj).glob("host_*.json")

    monkeypatch.setattr(pp, "ALGORITHM_VERSION", pp.ALGORITHM_VERSION + 1)
    proj2 = load_project(path)
    assert pp.load_track_profile(proj2, "host").status == "stale"
    result = pp.run_prosody_analysis(proj2, {})
    assert result.computed == ["host"]
    assert result.reused == []

    files = list(pp.prosody_dir(proj2).glob("host_*.json"))
    assert len(files) == 1
    assert files[0].name != old_file.name
    payload = json.loads(files[0].read_text(encoding="utf-8"))
    assert payload["algorithm_version"] == pp.ALGORITHM_VERSION
    assert pp.load_track_profile(load_project(path), "host").status == "fresh"


def test_run_prosody_analysis_not_installed(tmp_workspace: Path, monkeypatch) -> None:
    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    monkeypatch.setattr(pp, "parselmouth_version", lambda: None)
    result = pp.run_prosody_analysis(proj, {})
    assert result.unavailable is True
    assert "not installed" in result.summary()
    assert not pp.prosody_dir(proj).exists() or not list(pp.prosody_dir(proj).glob("*.json"))


def test_run_prosody_analysis_skips_track_without_media(tmp_workspace: Path) -> None:
    path = _project_with_host(tmp_workspace, with_media=False)
    proj = load_project(path)
    result = pp.run_prosody_analysis(proj, {})
    assert result.skipped == ["host"]
    assert result.computed == []


def test_run_prosody_analysis_honors_cancel_check(tmp_workspace: Path) -> None:
    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    with pytest.raises(CancelledProgress):
        pp.run_prosody_analysis(proj, {"_pipeline_cancel_check": lambda: True})
    assert not list(pp.prosody_dir(proj).glob("*.json")) if pp.prosody_dir(proj).exists() else True


def test_load_track_profile_missing(tmp_workspace: Path) -> None:
    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    lookup = pp.load_track_profile(proj, "host")
    assert lookup.status == "missing"
    assert lookup.hint is not None


def test_load_track_profile_stale_after_params_change(tmp_workspace: Path) -> None:
    path = _project_with_host(tmp_workspace)
    pp.run_prosody_analysis(load_project(path), {})

    proj2 = load_project(path)
    lookup = pp.load_track_profile(proj2, "host", params=ProsodyParams(pitch_floor_hz=90.0))
    assert lookup.status == "stale"
    assert lookup.hint is not None
    assert "settings" in lookup.hint

    assert (
        pp.load_track_profile(proj2, "host", params=ProsodyParams.from_defaults({})).status
        == "fresh"
    )


def test_load_track_profile_fresh_without_parselmouth(tmp_workspace: Path, monkeypatch) -> None:
    """The reader does not need parselmouth once a profile is cached."""
    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    pp.run_prosody_analysis(proj, {})

    proj2 = load_project(path)
    monkeypatch.setattr(pp, "parselmouth_version", lambda: None)
    lookup = pp.load_track_profile(proj2, "host")
    assert lookup.status == "fresh"
    assert lookup.profile is not None
    assert lookup.profile.segments


def test_load_track_profile_stale_after_media_change(tmp_workspace: Path) -> None:
    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    pp.run_prosody_analysis(proj, {})

    # Replace media bytes+mtime (simulate re-recording/re-trim) without recomputing.
    media_path = tmp_workspace / "raw" / "host.wav"
    media_path.write_bytes(media_path.read_bytes() + b"\x00" * 8)

    proj2 = load_project(path)
    lookup = pp.load_track_profile(proj2, "host")
    assert lookup.status == "stale"
    assert lookup.hint is not None


def test_load_track_profile_stale_after_words_change(tmp_workspace: Path) -> None:
    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    pp.run_prosody_analysis(proj, {})

    proj2 = load_project(path)
    proj2.transcripts[0].words.append(TranscriptWord(text="extra", start=5.97, end=6.1))
    save_project(proj2, path)

    proj3 = load_project(path)
    lookup = pp.load_track_profile(proj3, "host")
    assert lookup.status == "stale"


def test_load_track_profile_missing_media_track() -> None:
    project = EpisodeProject.create("no_media", "/tmp/does-not-matter")
    project.tracks = [Track(id="host", label="Host", role=TrackRole.DIALOGUE, media=None)]
    lookup = pp.load_track_profile(project, "host")
    # No cached profile at all yet -> missing, not stale.
    assert lookup.status == "missing"


def test_load_track_profile_stale_when_media_removed(tmp_workspace: Path) -> None:
    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    pp.run_prosody_analysis(proj, {})

    proj2 = load_project(path)
    proj2.track_by_id("host").media = None
    save_project(proj2, path)

    proj3 = load_project(path)
    lookup = pp.load_track_profile(proj3, "host")
    assert lookup.status == "stale"


def test_prosody_window_returns_missing_status(tmp_workspace: Path) -> None:
    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    st = SessionTimeline(proj)
    window = pp.prosody_window(proj, st, "host", [(SourceSec(0.0), SourceSec(6.42))])
    assert window["status"] == "missing"
    assert "hint" in window


def test_prosody_window_maps_segments_to_timeline(tmp_workspace: Path) -> None:
    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    pp.run_prosody_analysis(proj, {})

    proj2 = load_project(path)
    st = SessionTimeline(proj2)
    window = pp.prosody_window(proj2, st, "host", [(SourceSec(0.0), SourceSec(6.42))])
    assert window["status"] == "fresh"
    assert window["segments"]
    seg = window["segments"][0]
    assert seg["timeline_start"] is not None
    assert seg["timeline_end"] is not None
    assert isinstance(seg["line"], str) and seg["line"]
    assert seg["timeline_start"] == pytest.approx(
        seg["source_start"]
    )  # identity mapping (no clips)


def test_prosody_window_stale_after_params_change(tmp_workspace: Path) -> None:
    path = _project_with_host(tmp_workspace)
    pp.run_prosody_analysis(load_project(path), {})

    proj2 = load_project(path)
    st = SessionTimeline(proj2)
    window = pp.prosody_window(
        proj2,
        st,
        "host",
        [(SourceSec(0.0), SourceSec(6.42))],
        params=ProsodyParams(pause_min_sec=0.5),
    )
    assert window["status"] == "stale"
    assert "hint" in window


def test_prosody_window_truncates_and_caps_segments(tmp_workspace: Path) -> None:
    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    pp.run_prosody_analysis(proj, {})

    proj2 = load_project(path)
    lookup = pp.load_track_profile(proj2, "host")
    assert lookup.profile is not None
    # Fabricate more segments than the cap so truncation is exercised.
    extra_segments = lookup.profile.segments * (pp.MAX_WINDOW_SEGMENTS + 2)
    cached_path = next(pp.prosody_dir(proj2).glob("host_*.json"))
    payload = json.loads(cached_path.read_text(encoding="utf-8"))
    payload["segments"] = extra_segments
    cached_path.write_text(json.dumps(payload), encoding="utf-8")

    proj3 = load_project(path)
    st = SessionTimeline(proj3)
    window = pp.prosody_window(proj3, st, "host", [(SourceSec(0.0), SourceSec(6.42))])
    assert window["status"] == "fresh"
    assert len(window["segments"]) == pp.MAX_WINDOW_SEGMENTS
    assert window["truncated"] is True


def test_prosody_window_excludes_segments_outside_spans(tmp_workspace: Path) -> None:
    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    pp.run_prosody_analysis(proj, {})
    proj2 = load_project(path)
    st = SessionTimeline(proj2)
    window = pp.prosody_window(proj2, st, "host", [(SourceSec(100.0), SourceSec(101.0))])
    assert window["status"] == "fresh"
    assert window["segments"] == []
    assert window["truncated"] is False


def test_words_fingerprint_is_order_independent() -> None:
    a = [pp.WordSpan("hi", 0.0, 0.2), pp.WordSpan("there", 0.3, 0.5)]
    b = [pp.WordSpan("there", 0.3, 0.5), pp.WordSpan("hi", 0.0, 0.2)]
    assert pp.words_fingerprint(a) == pp.words_fingerprint(b)


def test_profile_path_stays_inside_prosody_dir(tmp_workspace: Path) -> None:
    path = _project_with_host(tmp_workspace)
    proj = load_project(path)
    resolved = pp.profile_path(proj, "host", "0" * 16, "1" * 16)
    assert resolved.is_relative_to(pp.prosody_dir(proj))

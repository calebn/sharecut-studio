"""``stem_is_fresh`` checks the cheap conditions first and hashes last (#2359).

It is a pure conjunction (the stem exists, its sidecar names the track's render hash,
the stem is not longer than the timeline), so reordering it may change what is computed
and never what is answered.
"""

from __future__ import annotations

import itertools
import wave
from pathlib import Path

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import play_audit
from podcast_mcp.engines.play_audit import (
    read_stem_hash,
    stem_duration_matches_timeline,
    stem_hash_path,
    stem_is_fresh,
    stem_path,
    track_render_hash,
    write_stem_hash,
)
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, TrackRole

DEFAULTS = load_defaults()
RATE = 8000


def _wav(path: Path, seconds: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(b"\0\0" * round(seconds * RATE))


def _project(tmp_path: Path, *, clips: bool) -> EpisodeProject:
    project = EpisodeProject.create("fresh", str(tmp_path))
    _wav(tmp_path / "raw" / "host.wav", 4.0)
    project.tracks = [
        Track(
            id="host",
            label="host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=4.0),
        )
    ]
    project.clips = (
        [Clip(id="c1", track_id="host", source_start=0.0, source_end=2.0, timeline_start=0.0)]
        if clips
        else []
    )
    return project


def _old(project: EpisodeProject, track_id: str) -> bool:
    """The definition before the reorder."""
    if not stem_path(project, track_id).is_file():
        return False
    stored = read_stem_hash(project, track_id)
    if stored != track_render_hash(project, track_id, defaults=DEFAULTS):
        return False
    return stem_duration_matches_timeline(project, track_id)


STEM = ("missing", "short", "long")  # none / 1 s / 5 s against a 2 s timeline
SIDECAR = ("missing", "equal", "different")


def _arrange(project: EpisodeProject, stem: str, sidecar: str) -> None:
    if stem != "missing":
        _wav(stem_path(project, "host"), 1.0 if stem == "short" else 5.0)
    if sidecar == "equal":
        write_stem_hash(project, "host", defaults=DEFAULTS)
    elif sidecar == "different":
        stem_hash_path(project, "host").parent.mkdir(parents=True, exist_ok=True)
        stem_hash_path(project, "host").write_text("0" * 64, encoding="utf-8")


@pytest.mark.parametrize("clips", [True, False], ids=["clips", "no-clips"])
@pytest.mark.parametrize(("stem", "sidecar"), list(itertools.product(STEM, SIDECAR)))
def test_the_answer_is_the_old_definitions_and_the_hash_is_only_computed_when_needed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    stem: str,
    sidecar: str,
    clips: bool,
) -> None:
    project = _project(tmp_path, clips=clips)
    _arrange(project, stem, sidecar)
    expected = _old(project, "host")
    calls: list[str] = []
    real = play_audit.track_render_hash

    def spy(*args, **kwargs):  # type: ignore[no-untyped-def]
        calls.append("hash")
        return real(*args, **kwargs)

    monkeypatch.setattr(play_audit, "track_render_hash", spy)

    assert stem_is_fresh(project, "host", defaults=DEFAULTS) is expected

    exists = stem != "missing"
    # a track with no clips has no timeline extent, so no stem is too long for it
    duration_ok = stem == "short" or not clips
    assert (calls == ["hash"]) is (exists and duration_ok)
    assert calls in ([], ["hash"])


def test_a_fresh_stem_is_fresh_and_one_edit_later_it_is_not(tmp_path: Path) -> None:
    project = _project(tmp_path, clips=True)
    _arrange(project, "short", "equal")
    assert stem_is_fresh(project, "host", defaults=DEFAULTS)
    project.clips[0].fade_out_ms = 50
    assert not stem_is_fresh(project, "host", defaults=DEFAULTS)


def test_a_stem_longer_than_the_timeline_is_stale_without_hashing_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Where the hash would have raised, the stale answer needs no hash; a fresh stem still does."""
    too_long = _project(tmp_path / "long", clips=True)
    _arrange(too_long, "long", "equal")
    fits = _project(tmp_path / "fits", clips=True)
    _arrange(fits, "short", "equal")

    def boom(*args, **kwargs):  # type: ignore[no-untyped-def]
        raise RuntimeError("hashed")

    monkeypatch.setattr(play_audit, "track_render_hash", boom)
    assert stem_is_fresh(too_long, "host", defaults=DEFAULTS) is False
    with pytest.raises(RuntimeError, match="hashed"):
        stem_is_fresh(fits, "host", defaults=DEFAULTS)

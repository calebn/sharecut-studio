"""Reader-side words-fingerprint memoization (#729): tests/test_prosody_profile.py's
``track_words_fingerprint``/``load_track_profile`` coverage runs the real writer
(``run_prosody_analysis``, needing the ``prosody`` extra); these run without it,
seeding a profile directly via ``prosody_helpers.seed_prosody_profile``.
"""

from __future__ import annotations

from pathlib import Path

from podcast_mcp.edits import prosody_profile as pp
from podcast_mcp.models import (
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from prosody_helpers import seed_prosody_profile


def _single_track_project(minimal_project: Path) -> Path:
    proj = load_project(minimal_project)
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        ),
    ]
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.1, end=0.4, confidence=0.9),
                TranscriptWord(text="world", start=0.5, end=0.9, confidence=0.9),
            ],
        )
    ]
    save_project(proj, minimal_project)
    return minimal_project


def _seeded_project(minimal_project: Path) -> object:
    path = _single_track_project(minimal_project)
    proj = load_project(path)
    seed_prosody_profile(proj)
    return load_project(path)


def test_track_words_fingerprint_matches_uncached(minimal_project: Path) -> None:
    proj = _seeded_project(minimal_project)
    assert pp.track_words_fingerprint(proj, "host") == pp.words_fingerprint(
        pp.profile_words(proj, "host")
    )
    assert pp.track_words_fingerprint(proj, "unknown-track") == pp.words_fingerprint([])


def test_load_track_profile_memoizes_words_fingerprint(minimal_project: Path, monkeypatch) -> None:
    proj = _seeded_project(minimal_project)
    calls = {"n": 0}
    real_words_fingerprint = pp.words_fingerprint

    def counting_words_fingerprint(words):
        calls["n"] += 1
        return real_words_fingerprint(words)

    monkeypatch.setattr(pp, "words_fingerprint", counting_words_fingerprint)

    assert pp.load_track_profile(proj, "host").status == "fresh"
    assert pp.load_track_profile(proj, "host").status == "fresh"
    assert calls["n"] == 1

    proj.transcripts[0].words[0].suspect_hallucination = False  # already False
    assert pp.load_track_profile(proj, "host").status == "fresh"
    assert calls["n"] == 1


def test_other_track_words_edit_recomputes_once_and_stays_fresh(
    minimal_project: Path, monkeypatch
) -> None:
    """The words revision is process-wide (#729): an edit on another track's words
    recomputes this track's fingerprint once; the profile stays fresh.
    """
    proj = _seeded_project(minimal_project)
    proj.transcripts.append(
        Transcript(
            track_id="guest",
            words=[TranscriptWord(text="hi", start=1.0, end=1.2, confidence=0.9)],
        )
    )
    calls = {"n": 0}
    real_words_fingerprint = pp.words_fingerprint

    def counting_words_fingerprint(words):
        calls["n"] += 1
        return real_words_fingerprint(words)

    monkeypatch.setattr(pp, "words_fingerprint", counting_words_fingerprint)

    assert pp.load_track_profile(proj, "host").status == "fresh"
    assert calls["n"] == 1
    proj.transcripts[1].words[0].suppressed = True
    assert pp.load_track_profile(proj, "host").status == "fresh"
    assert calls["n"] == 2
    assert pp.load_track_profile(proj, "host").status == "fresh"
    assert calls["n"] == 2


def test_in_place_flag_change_is_stale_without_a_save(minimal_project: Path) -> None:
    proj = _seeded_project(minimal_project)
    assert pp.load_track_profile(proj, "host").status == "fresh"

    proj.transcripts[0].words[0].suspect_hallucination = True
    assert pp.load_track_profile(proj, "host").status == "stale"

    proj.transcripts[0].words[0].suspect_hallucination = False
    assert pp.load_track_profile(proj, "host").status == "fresh"


def test_word_replacement_is_stale(minimal_project: Path) -> None:
    proj = _seeded_project(minimal_project)
    assert pp.load_track_profile(proj, "host").status == "fresh"

    tr = proj.transcripts[0]
    tr.words[0] = tr.words[0].model_copy(update={"start": 0.2})
    assert pp.load_track_profile(proj, "host").status == "stale"


def test_words_reassignment_is_stale(minimal_project: Path) -> None:
    proj = _seeded_project(minimal_project)
    assert pp.load_track_profile(proj, "host").status == "fresh"

    tr = proj.transcripts[0]
    tr.words = tr.words[:1]
    assert pp.load_track_profile(proj, "host").status == "stale"

"""Tighten's apply reads the timeline stems the analysis already built (#2364).

``record_suggested_cut_speech`` measures the speech a suggested pause cut would take from
others. Without the analysis's stems it re-read every probe window from disk (295 reads on
the 150-word synthetic project).
"""

from __future__ import annotations

import pytest

import benchmark_tighten as bench
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import propose_tighten_edits
from podcast_mcp.edits.cut_application import record_suggested_cut_speech
from podcast_mcp.edits.tighten.propose import apply_tighten_decisions
from podcast_mcp.engines import audio_audit
from podcast_mcp.models import TranscriptWord


def _add_guest_word(project, text: str, start: float, end: float) -> None:
    guest = next(t for t in project.transcripts if t.track_id == "guest")
    guest.words.insert(0, TranscriptWord(text=text, start=start, end=end))


def test_propose_reads_no_timeline_window_from_disk(tmp_path, monkeypatch):
    project = bench._synthetic_filler_project(150, tmp_path)
    reads: list[object] = []
    original = audio_audit._played_window

    def spy(*args, **kwargs):
        reads.append(args)
        return original(*args, **kwargs)

    monkeypatch.setattr(audio_audit, "_played_window", spy)

    proposal = propose_tighten_edits(project, load_defaults(), replace_existing=True)

    assert len(proposal.decisions) == 30
    assert len(reads) == 0


def test_pause_cut_records_the_peer_speech_inside_it(tmp_path):
    project = bench._synthetic_filler_project(20, tmp_path)
    _add_guest_word(project, "yeah", 0.5, 1.0)

    proposal = propose_tighten_edits(project, load_defaults(), replace_existing=True)

    pause = next(d for d in proposal.decisions if d.track_id == "host" and d.start == 0.25)
    assert pause.cut_speech is not None
    assert [
        (t.track_id, [(w.text, w.timeline_start, w.timeline_end) for w in t.words])
        for t in pause.cut_speech.tracks
    ] == [("guest", [("yeah", 0.5, 1.0)])]
    assert [(s.start, s.end) for s in pause.cut_speech.spans] == [
        (pytest.approx(0.25), pytest.approx(1.5561875))
    ]


def test_cut_speech_after_an_applied_cut_matches_a_fresh_assessment(tmp_path):
    project = bench._synthetic_filler_project(30, tmp_path)
    host = next(t for t in project.transcripts if t.track_id == "host")
    pause_start = host.words[23].end
    _add_guest_word(project, "yeah", pause_start + 0.3, pause_start + 0.8)
    defaults = load_defaults()
    propose_tighten_edits(project, defaults, replace_existing=True)
    assert apply_tighten_decisions(project, defaults) == 3

    proposal = propose_tighten_edits(project, defaults, replace_existing=True)

    shifted = next(d for d in proposal.decisions if d.cut_speech is not None)
    assert [
        (t.track_id, [(w.text, w.timeline_start) for w in t.words])
        for t in shifted.cut_speech.tracks
    ] == [("guest", [("yeah", pytest.approx(11.1375))])]
    fresh = shifted.model_copy(update={"cut_speech": None})
    record_suggested_cut_speech(project, fresh, defaults=defaults)
    assert shifted.cut_speech == fresh.cut_speech

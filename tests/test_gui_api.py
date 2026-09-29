from __future__ import annotations

import random
from pathlib import Path

import pytest
from filelock import Timeout

from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.gui.mapper import (
    is_tighten_reason,
    join_risk_from_decision,
    map_applied_edits_to_timeline,
    map_pending_edits_to_timeline,
    map_transcript_utterances_to_timeline,
    social_clips_for_view,
)
from podcast_mcp.models import (
    AppliedEditRecord,
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    SocialClipCandidate,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.services import PipelineRunResult
from podcast_mcp.util.project_state import ProjectBusyError, RenderBusyError


@pytest.fixture(autouse=True)
def _bypass_whisper_run_gate(monkeypatch: pytest.MonkeyPatch) -> None:
    """Happy-path GUI run tests stub the Whisper cache gate (409 covered elsewhere)."""
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.pipeline.ensure_whisper_cached_for_run",
        lambda **_kwargs: None,
    )


def _wait_pipeline_idle(client, timeout_s: float = 10.0) -> None:
    """Block until the single-flight pipeline slot is free.

    ``/api/pipeline/run`` returns as soon as the job thread starts, so a
    follow-up run can hit 409 while a stubbed job is still finishing on a
    loaded worker.
    """
    import time

    deadline = time.monotonic() + timeout_s
    while client.get("/api/pipeline/status").json()["running"]:
        assert time.monotonic() < deadline, "pipeline job did not finish"
        time.sleep(0.02)


def _minimal() -> EpisodeProject:
    p = EpisodeProject.create("gui", "/tmp/gui")
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    p.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=5.0,
            timeline_start=0.0,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=5.0,
            source_end=10.0,
            timeline_start=5.0,
        ),
    ]
    return p


def test_map_pending_edits_mappable() -> None:
    p = _minimal()
    decision = EditDecision(
        id="d1",
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=1.0,
        end=2.0,
        reason="test",
    )
    rows = map_pending_edits_to_timeline(p, [decision])
    assert len(rows) == 1
    assert rows[0]["mappable"] is True
    assert rows[0]["timeline_start"] == pytest.approx(1.0)
    assert rows[0]["timeline_end"] == pytest.approx(2.0)
    assert rows[0]["scope"] == "session"
    assert rows[0]["can_skip"] is True
    assert rows[0]["skip_reason"] is None
    assert rows[0]["join_risk"] is None


def test_map_pending_edits_unmappable() -> None:
    p = _minimal()
    decision = EditDecision(
        id="d2",
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=20.0,
        end=21.0,
        reason="away",
    )
    rows = map_pending_edits_to_timeline(p, [decision])
    assert rows[0]["mappable"] is False
    assert rows[0]["timeline_start"] is None
    assert rows[0]["can_skip"] is False
    assert rows[0]["skip_reason"] is not None
    assert "not on the current timeline" in rows[0]["skip_reason"]
    assert rows[0]["join_risk"] is None


def test_map_pending_edits_join_risk_from_reason() -> None:
    p = _minimal()
    risky = EditDecision(
        id="d-risk",
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=1.0,
        end=2.0,
        reason="filler:um:risky",
        review_required=True,
    )
    join_review = EditDecision(
        id="d-join",
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=3.0,
        end=3.4,
        reason="pause:0.8s:join_review",
        review_required=True,
    )
    rows = map_pending_edits_to_timeline(p, [risky, join_review])
    assert rows[0]["join_risk"] == {
        "verdict": "review",
        "label": "risky",
        "source": "reason",
        "risk": None,
    }
    assert rows[1]["join_risk"] == {
        "verdict": "review",
        "label": "join_review",
        "source": "reason",
        "risk": None,
    }


def test_join_risk_from_decision_prefixes() -> None:
    safe = EditDecision(
        id="d-ok",
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=1.0,
        end=2.0,
        reason="filler:um",
    )
    assert is_tighten_reason("filler:um") is True
    assert is_tighten_reason("pause:0.8s") is True
    assert is_tighten_reason("repetition:word:the") is True
    assert is_tighten_reason("restart:phrase:i went") is True
    assert is_tighten_reason("nl:topic") is False
    assert is_tighten_reason(None) is False
    assert join_risk_from_decision(safe) is None


def test_map_transcript_utterances_to_timeline() -> None:
    p = _minimal()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=1.0, end=1.4, confidence=0.95),
                TranscriptWord(
                    text="world", start=1.5, end=2.0, confidence=0.4, suspect_hallucination=True
                ),
                TranscriptWord(text="skip", start=1.7, end=1.9, suppressed=True, confidence=0.9),
                TranscriptWord(
                    text="locked",
                    start=1.9,
                    end=2.1,
                    suppressed=False,
                    audibility_locked=True,
                    confidence=0.9,
                ),
            ],
        )
    ]
    transcript = {
        "utterances": [
            {
                "track_id": "host",
                "speaker": "Host",
                "start": 1.0,
                "end": 2.0,
                "text": "hello world",
            }
        ]
    }
    mapped = map_transcript_utterances_to_timeline(p, transcript)
    assert mapped is not None
    u = mapped["utterances"][0]
    assert u["start"] == pytest.approx(1.0)
    assert u["end"] == pytest.approx(2.0)
    assert u["mappable"] is True
    assert u["timeline_start"] == pytest.approx(1.0)
    assert u["timeline_end"] == pytest.approx(2.0)
    assert len(u["words"]) == 4
    assert u["words"][0]["text"] == "hello"
    assert u["words"][0]["word_index"] == 0
    assert u["words"][0]["suppressed"] is False
    assert u["words"][0]["confidence"] == pytest.approx(0.95)
    assert u["words"][0]["timeline_start"] == pytest.approx(1.0)
    assert u["words"][1]["text"] == "world"
    assert u["words"][1]["word_index"] == 1
    assert u["words"][1]["confidence"] == pytest.approx(0.4)
    assert u["words"][1]["timeline_start"] == pytest.approx(1.5)
    assert u["words"][2]["text"] == "skip"
    assert u["words"][2]["word_index"] == 2
    assert u["words"][2]["suppressed"] is True
    assert u["words"][0]["suspect_hallucination"] is False
    assert u["words"][1]["suspect_hallucination"] is True
    assert u["words"][0]["audibility_locked"] is False
    assert u["words"][3]["text"] == "locked"
    assert u["words"][3]["suppressed"] is False
    assert u["words"][3]["audibility_locked"] is True


def test_transcript_word_mapping_batches_unsorted_words_once_per_track(monkeypatch) -> None:
    from podcast_mcp.engines.session_timeline import SessionTimeline

    p = _minimal()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="late", start=2.0, end=2.3),
                TranscriptWord(text="point", start=1.1, end=1.1),
                TranscriptWord(text="early", start=1.0, end=1.4),
            ],
        )
    ]
    combined = {
        "utterances": [
            {"track_id": "host", "start": 1.0, "end": 1.5},
            {"track_id": "host", "start": 2.0, "end": 2.5},
        ]
    }
    calls: list[int] = []
    original = SessionTimeline.map_word_spans

    def counted(self, track_id, words):
        calls.append(len(words))
        return original(self, track_id, words)

    monkeypatch.setattr(SessionTimeline, "map_word_spans", counted)
    mapped = map_transcript_utterances_to_timeline(p, combined)
    assert mapped is not None
    assert [[w["text"] for w in row["words"]] for row in mapped["utterances"]] == [
        ["point", "early"],
        ["late"],
    ]
    assert [w["word_index"] for w in mapped["utterances"][0]["words"]] == [1, 2]
    assert calls == [3]
    map_transcript_utterances_to_timeline(p, combined, include_words=False)
    assert calls == [3]


def test_transcript_word_index_preserves_zero_width_boundary_rules() -> None:
    from podcast_mcp.engines.session_timeline import SessionTimeline
    from podcast_mcp.gui.mapper import _words_for_utterance

    project = _minimal()
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="after", start=1.5, end=1.8),
                TranscriptWord(text="just-before", start=1.0995, end=1.0995),
                TranscriptWord(text="at-start", start=1.1, end=1.1),
                TranscriptWord(text="long", start=0.5, end=2.0),
                TranscriptWord(text="at-end", start=1.8, end=1.8),
            ],
        )
    ]
    rows = _words_for_utterance(project, SessionTimeline(project), "host", 1.1, 1.8)
    assert [row["text"] for row in rows] == ["after", "at-start", "long"]


def test_word_view_maps_zero_length_word_at_clip_source_end() -> None:
    from podcast_mcp.engines.session_timeline import SessionTimeline
    from podcast_mcp.gui.mapper import _mapped_word_index

    project = _minimal()
    project.timeline.clips[1] = Clip(
        id="c2", track_id="host", source_start=7.0, source_end=10.0, timeline_start=5.0
    )
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="edge", start=5.0, end=5.0),  # cut [5, 7) starts here
                TranscriptWord(text="gone", start=6.0, end=6.0),
            ],
        )
    ]
    views = _mapped_word_index(project, SessionTimeline(project), "host").views
    assert views[0]["mappable"] is True
    assert views[0]["timeline_end"] == pytest.approx(5.0)
    assert views[1]["mappable"] is False


def test_map_transcript_includes_suppressed_within_utterance() -> None:
    """Suppressed tokens that still overlap the utterance span stay visible."""
    p = _minimal()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="keep", start=1.0, end=1.4, confidence=0.9),
                TranscriptWord(text="gone", start=1.5, end=1.8, suppressed=True, confidence=0.5),
                TranscriptWord(text="ok", start=1.9, end=2.2, confidence=0.9),
            ],
        )
    ]
    transcript = {
        "utterances": [
            {
                "track_id": "host",
                "speaker": "Host",
                "start": 1.0,
                "end": 2.2,
                "text": "keep ok",
            }
        ]
    }
    mapped = map_transcript_utterances_to_timeline(p, transcript)
    assert mapped is not None
    words = mapped["utterances"][0]["words"]
    assert [w["text"] for w in words] == ["keep", "gone", "ok"]
    assert words[1]["word_index"] == 1
    assert words[1]["suppressed"] is True
    slim = map_transcript_utterances_to_timeline(p, transcript, include_words=False)
    assert slim is not None
    assert "words" not in slim["utterances"][0]


def test_map_transcript_edge_suppressed_first_word_kept() -> None:
    """A suppressed word before the first non-suppressed word stays a chip on that utterance (#752)."""
    p = _minimal()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="welcome", start=0.0, end=0.3, suppressed=True, confidence=0.9),
                TranscriptWord(text="to", start=0.5, end=0.7, confidence=0.9),
                TranscriptWord(text="the", start=0.7, end=0.9, confidence=0.9),
                TranscriptWord(text="show", start=0.9, end=1.1, confidence=0.9),
            ],
        )
    ]
    combined = TranscriptionEngine().merge_transcripts(p).model_dump()
    assert len(combined["utterances"]) == 1
    assert combined["utterances"][0]["start"] == pytest.approx(0.5)
    mapped = map_transcript_utterances_to_timeline(p, combined)
    assert mapped is not None
    u = mapped["utterances"][0]
    assert [w["word_index"] for w in u["words"]] == [0, 1, 2, 3]
    assert u["words"][0]["text"] == "welcome"
    assert u["words"][0]["suppressed"] is True


def test_map_transcript_edge_suppressed_last_word_kept() -> None:
    """A suppressed word after the last non-suppressed word stays a chip on that utterance (#752)."""
    p = _minimal()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.3, confidence=0.9),
                TranscriptWord(text="world", start=0.4, end=0.6, confidence=0.9),
                TranscriptWord(text="done", start=0.7, end=0.9, suppressed=True, confidence=0.9),
            ],
        )
    ]
    combined = TranscriptionEngine().merge_transcripts(p).model_dump()
    assert len(combined["utterances"]) == 1
    mapped = map_transcript_utterances_to_timeline(p, combined)
    assert mapped is not None
    u = mapped["utterances"][0]
    assert [w["word_index"] for w in u["words"]] == [0, 1, 2]
    assert u["words"][2]["text"] == "done"
    assert u["words"][2]["suppressed"] is True


def test_map_transcript_edge_suppressed_gap_run_nearest_utterance() -> None:
    """A suppressed run between two utterances splits to the nearest one, each word once (#752)."""
    p = _minimal()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="a", start=0.0, end=0.2, confidence=0.9),
                TranscriptWord(text="b", start=0.2, end=0.4, confidence=0.9),
                TranscriptWord(text="x1", start=1.0, end=1.1, suppressed=True, confidence=0.5),
                TranscriptWord(text="x2", start=1.5, end=1.6, suppressed=True, confidence=0.5),
                TranscriptWord(text="c", start=2.0, end=2.2, confidence=0.9),
                TranscriptWord(text="d", start=2.2, end=2.4, confidence=0.9),
            ],
        )
    ]
    combined = TranscriptionEngine().merge_transcripts(p).model_dump()
    assert len(combined["utterances"]) == 2
    mapped = map_transcript_utterances_to_timeline(p, combined)
    assert mapped is not None
    first, second = mapped["utterances"]
    assert [w["word_index"] for w in first["words"]] == [0, 1, 2]
    assert first["words"][2]["text"] == "x1"
    assert [w["word_index"] for w in second["words"]] == [3, 4, 5]
    assert second["words"][0]["text"] == "x2"
    all_indices = [w["word_index"] for w in first["words"]] + [
        w["word_index"] for w in second["words"]
    ]
    assert sorted(all_indices) == [0, 1, 2, 3, 4, 5]
    assert len(all_indices) == len(set(all_indices))


def test_map_transcript_edge_suppressed_uneven_gap_run() -> None:
    """An uneven suppressed run splits word by word to the nearer utterance (#752)."""
    p = _minimal()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="a", start=0.0, end=0.2, confidence=0.9),
                TranscriptWord(text="b", start=0.2, end=0.4, confidence=0.9),
                TranscriptWord(text="x1", start=0.6, end=0.7, suppressed=True, confidence=0.5),
                TranscriptWord(text="x2", start=0.9, end=1.0, suppressed=True, confidence=0.5),
                TranscriptWord(text="x3", start=1.2, end=1.3, suppressed=True, confidence=0.5),
                TranscriptWord(text="x4", start=2.6, end=2.7, suppressed=True, confidence=0.5),
                TranscriptWord(text="c", start=3.0, end=3.2, confidence=0.9),
                TranscriptWord(text="d", start=3.2, end=3.4, confidence=0.9),
            ],
        )
    ]
    combined = TranscriptionEngine().merge_transcripts(p).model_dump()
    assert len(combined["utterances"]) == 2
    mapped = map_transcript_utterances_to_timeline(p, combined)
    assert mapped is not None
    first, second = mapped["utterances"]
    assert [w["word_index"] for w in first["words"]] == [0, 1, 2, 3, 4]
    assert [w["word_index"] for w in second["words"]] == [5, 6, 7]
    assert first["edge_suppressed_word_indices"] == [2, 3, 4]
    assert second["edge_suppressed_word_indices"] == [5]


def test_map_transcript_edge_suppressed_word_next_to_cut_away_utterance() -> None:
    """Attachment is by source gap: a kept word nearest a cut-away row rides on that row (#752)."""
    p = _with_cut_gap()  # source [3, 7) cut away
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="a", start=6.0, end=6.2, confidence=0.9),
                TranscriptWord(text="b", start=6.2, end=6.5, confidence=0.9),
                TranscriptWord(text="x", start=7.1, end=7.2, suppressed=True, confidence=0.5),
                TranscriptWord(text="c", start=9.0, end=9.2, confidence=0.9),
                TranscriptWord(text="d", start=9.2, end=9.4, confidence=0.9),
            ],
        )
    ]
    combined = TranscriptionEngine().merge_transcripts(p).model_dump()
    assert len(combined["utterances"]) == 2
    mapped = map_transcript_utterances_to_timeline(p, combined)
    assert mapped is not None
    first, second = mapped["utterances"]
    assert first["mappable"] is False
    assert [w["word_index"] for w in first["words"]] == [0, 1, 2]
    chip = first["words"][2]
    assert chip["text"] == "x"
    assert chip["mappable"] is True
    assert chip["timeline_start"] == pytest.approx(3.1)
    assert [w["word_index"] for w in second["words"]] == [3, 4]


def test_edge_suppressed_word_indices_helper() -> None:
    """Unit-tests _edge_suppressed_word_indices: ties, other tracks, no-utterance tracks (#752)."""
    from podcast_mcp.gui.mapper import _edge_suppressed_word_indices

    host_words = [
        TranscriptWord(text="in-window", start=0.1, end=0.3, suppressed=True),
        TranscriptWord(text="tie", start=1.0, end=1.0, suppressed=True),
        TranscriptWord(text="not-suppressed", start=5.0, end=5.2),
    ]
    guest_words = [
        TranscriptWord(text="orphan", start=0.5, end=0.7, suppressed=True),
    ]
    utterances = [
        {"track_id": "host", "start": 0.0, "end": 0.5},
        {"track_id": "host", "start": 1.5, "end": 2.0},
    ]
    words_by_track = {"host": host_words, "guest": guest_words}
    result = _edge_suppressed_word_indices(utterances, words_by_track)
    # index 0 already overlaps utterance 0's own [0.0, 0.5) window - not an "edge" word, skipped.
    # index 1 sits exactly between the two utterances - the tie goes to the earlier one (position 0).
    # "guest" has no utterance at all here (this helper alone does not add one) - its
    # suppressed word is never attached; the mapper's _suppressed_only_rows lists it
    # instead, on a synthetic row (#758).
    assert result == {0: [1]}


def test_edge_suppressed_word_indices_never_duplicates_a_covered_word() -> None:
    """A word inside any same-track window is not attached, even if windows overlap (#752)."""
    from podcast_mcp.gui.mapper import _edge_suppressed_word_indices

    words = [TranscriptWord(text="inside-long", start=2.0, end=2.1, suppressed=True)]
    utterances = [
        {"track_id": "host", "start": 0.0, "end": 3.0},
        {"track_id": "host", "start": 1.0, "end": 1.5},
    ]
    assert _edge_suppressed_word_indices(utterances, {"host": words}) == {}


def test_edge_suppressed_word_indices_zero_length_window_is_a_candidate() -> None:
    """A zero-length utterance window still receives a nearby edge-suppressed word (#752)."""
    from podcast_mcp.gui.mapper import _edge_suppressed_word_indices

    words = [TranscriptWord(text="x", start=1.5, end=1.6, suppressed=True)]
    utterances = [{"track_id": "host", "start": 1.0, "end": 1.0}]
    assert _edge_suppressed_word_indices(utterances, {"host": words}) == {0: [0]}


def test_covered_word_ordinals_pads_a_zero_length_window() -> None:
    """A zero-length window covers its own word and a straddling word, not a word ending at it (#752)."""
    from podcast_mcp.gui.mapper import _covered_word_ordinals, _raw_word_intervals

    words = [
        TranscriptWord(text="ends-at", start=1.8, end=2.0),
        TranscriptWord(text="straddles", start=1.9, end=2.1, suppressed=True),
        TranscriptWord(text="own", start=2.0, end=2.0),
        TranscriptWord(text="after", start=2.5, end=2.6),
    ]
    assert _covered_word_ordinals(words, _raw_word_intervals(words), 2.0, 2.0) == {1, 2}


def test_map_transcript_zero_length_utterance_lists_straddling_suppressed_word() -> None:
    """A suppressed word straddling a zero-length utterance window is listed on that row, once, and the row is mappable on kept audio (#752)."""
    p = _minimal()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.3, confidence=0.9),
                TranscriptWord(text="um", start=1.9, end=2.1, suppressed=True, confidence=0.5),
                TranscriptWord(text="yeah", start=2.0, end=2.0, confidence=0.9),
                TranscriptWord(text="bye", start=5.0, end=5.3, confidence=0.9),
            ],
        )
    ]
    combined = TranscriptionEngine().merge_transcripts(p).model_dump()
    assert [(u["start"], u["end"]) for u in combined["utterances"]] == [
        (0.0, 0.3),
        (2.0, 2.0),
        (5.0, 5.3),
    ]
    mapped = map_transcript_utterances_to_timeline(p, combined)
    assert mapped is not None
    rows = mapped["utterances"]
    assert [[w["text"] for w in u["words"]] for u in rows] == [
        ["hello"],
        ["um", "yeah"],
        ["bye"],
    ]
    assert all("edge_suppressed_word_indices" not in u for u in rows)
    indices = [w["word_index"] for u in rows for w in u["words"]]
    assert sorted(indices) == [0, 1, 2, 3]
    zero = rows[1]
    assert (zero["start"], zero["end"]) == (2.0, 2.0)
    assert zero["mappable"] is True
    assert zero["timeline_start"] == pytest.approx(2.0)
    assert zero["timeline_end"] == pytest.approx(2.001)
    assert len(zero["timeline_spans"]) == 1


def test_map_transcript_zero_length_utterance_on_cut_audio_stays_unmappable() -> None:
    """Padding a zero-length row never makes cut-away audio mappable (#752)."""
    p = _minimal()
    p.timeline.clips = [c for c in p.timeline.clips if c.id != "c1"]
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="yeah", start=2.0, end=2.0, confidence=0.9),
                TranscriptWord(text="bye", start=5.0, end=5.3, confidence=0.9),
            ],
        )
    ]
    combined = TranscriptionEngine().merge_transcripts(p).model_dump()
    mapped = map_transcript_utterances_to_timeline(p, combined)
    assert mapped is not None
    zero = next(u for u in mapped["utterances"] if u["start"] == u["end"] == 2.0)
    assert zero["mappable"] is False
    assert zero["timeline_spans"] == []


def _random_track_words(rng: random.Random) -> list[TranscriptWord]:
    words: list[TranscriptWord] = []
    t = 0.0
    for i in range(rng.randint(1, 14)):
        t = round(t + rng.choice([0.0, 0.1, 0.2, 0.5, 0.9, 1.5]), 1)
        duration = rng.choice([0.0, 0.0, 0.1, 0.2, 0.3])
        words.append(
            TranscriptWord(
                text=f"w{i}",
                start=t,
                end=round(t + duration, 1),
                suppressed=rng.random() < 0.4,
                ignored=rng.random() < 0.3,
            )
        )
    return words


def test_indexed_word_paths_match_brute_force_on_random_layouts() -> None:
    """Index-based coverage, ignored indices and edge attachment equal a brute-force scan (#752).

    Layouts come from ``merge_transcripts`` on a 0.1 s grid with zero-length words, so
    they hit tied starts, words ending exactly at a window edge and zero-length windows.
    """
    from podcast_mcp.engines.session_timeline import word_source_span
    from podcast_mcp.gui.mapper import (
        _covered_word_ordinals,
        _edge_suppressed_word_indices,
        _ignored_word_indices_for_utterance,
        _raw_word_intervals,
        _word_in_utterance,
    )

    def brute_covered(words: list[TranscriptWord], start: float, end: float) -> set[int]:
        s, e = word_source_span(start, end)
        return {i for i, w in enumerate(words) if _word_in_utterance(w, s, e)}

    rng = random.Random(752)
    for _ in range(300):
        project = _minimal()
        words = _random_track_words(rng)
        project.transcripts = [Transcript(track_id="host", words=words)]
        rows = TranscriptionEngine().merge_transcripts(project).model_dump()["utterances"]
        intervals = _raw_word_intervals(words)
        covered: set[int] = set()
        for row in rows:
            expected = brute_covered(words, row["start"], row["end"])
            assert _covered_word_ordinals(words, intervals, row["start"], row["end"]) == expected
            covered |= expected
        expected_edge: dict[int, list[int]] = {}
        for i, w in enumerate(words):
            if not w.suppressed or i in covered or not rows:
                continue
            gaps = [max(r["start"] - w.end, w.start - r["end"]) for r in rows]
            expected_edge.setdefault(gaps.index(min(gaps)), []).append(i)
        edge = _edge_suppressed_word_indices(rows, {"host": words})
        assert edge == expected_edge, (words, rows)
        for position, row in enumerate(rows):
            extras = edge.get(position, [])
            expected_ignored = sorted(
                i
                for i in brute_covered(words, row["start"], row["end"]) | set(extras)
                if words[i].ignored
            )
            assert (
                _ignored_word_indices_for_utterance(
                    words, intervals, row["start"], row["end"], extra_indices=extras
                )
                == expected_ignored
            )


def test_map_transcript_edge_suppressed_ignored_word_in_ignored_indices() -> None:
    """An edge-suppressed word that is also ignored lands in ignored_word_indices (#752, #633)."""
    p = _minimal()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(
                    text="welcome",
                    start=0.0,
                    end=0.3,
                    suppressed=True,
                    ignored=True,
                    confidence=0.5,
                ),
                TranscriptWord(text="to", start=0.5, end=0.7, confidence=0.9),
                TranscriptWord(text="the", start=0.7, end=0.9, confidence=0.9),
                TranscriptWord(text="show", start=0.9, end=1.1, confidence=0.9),
            ],
        )
    ]
    combined = TranscriptionEngine().merge_transcripts(p).model_dump()
    mapped = map_transcript_utterances_to_timeline(p, combined, include_words=False)
    assert mapped is not None
    u = mapped["utterances"][0]
    assert "words" not in u
    assert u["ignored_word_indices"] == [0]


def _guest_all_suppressed_project() -> EpisodeProject:
    p = _minimal()
    p.timeline.tracks.append(
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/guest.wav", duration_sec=10.0),
        )
    )
    p.timeline.clips.append(
        Clip(id="g1", track_id="guest", source_start=0.0, source_end=10.0, timeline_start=0.0)
    )
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.3, confidence=0.9),
                TranscriptWord(text="world", start=0.4, end=0.6, confidence=0.9),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="um", start=0.1, end=0.2, suppressed=True, confidence=0.4),
                TranscriptWord(text="uh", start=0.5, end=0.6, suppressed=True, confidence=0.4),
            ],
        ),
    ]
    return p


def test_map_transcript_all_suppressed_track_gets_suppressed_only_row() -> None:
    """A track whose words are all suppressed gets a view-only suppressed_only row (#758)."""
    p = _guest_all_suppressed_project()
    combined = TranscriptionEngine().merge_transcripts(p).model_dump()
    assert [u["track_id"] for u in combined["utterances"]] == ["host"]

    mapped = map_transcript_utterances_to_timeline(p, combined)
    assert mapped is not None
    assert [u["track_id"] for u in mapped["utterances"]] == ["host", "guest"]

    host = mapped["utterances"][0]
    assert [w["word_index"] for w in host["words"]] == [0, 1]
    assert [w["text"] for w in host["words"]] == ["hello", "world"]
    assert "edge_suppressed_word_indices" not in host
    assert "suppressed_only" not in host

    guest = mapped["utterances"][1]
    assert guest["suppressed_only"] is True
    assert guest["text"] == "um uh"
    assert guest["speaker"] == "guest"
    assert (guest["start"], guest["end"]) == (0.1, 0.6)
    assert guest["mappable"] is True
    assert guest["timeline_start"] == pytest.approx(0.1)
    assert [w["word_index"] for w in guest["words"]] == [0, 1]
    assert all(w["suppressed"] for w in guest["words"])
    assert "edge_suppressed_word_indices" not in guest

    slim = map_transcript_utterances_to_timeline(p, combined, include_words=False)
    assert slim is not None
    guest_slim = slim["utterances"][1]
    assert guest_slim["suppressed_only"] is True
    assert "words" not in guest_slim


def test_map_transcript_suppressed_only_rows_split_on_gaps() -> None:
    """One suppressed_only row per gap-run, interleaved by start with other rows (#758)."""
    p = _minimal()
    p.timeline.tracks.append(
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/guest.wav", duration_sec=10.0),
        )
    )
    p.timeline.clips.append(
        Clip(id="g1", track_id="guest", source_start=0.0, source_end=10.0, timeline_start=0.0)
    )
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="hi", start=1.0, end=1.2, confidence=0.9)],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="um", start=0.0, end=0.2, suppressed=True, confidence=0.4),
                TranscriptWord(text="uh", start=0.3, end=0.5, suppressed=True, confidence=0.4),
                TranscriptWord(text="er", start=2.0, end=2.2, suppressed=True, confidence=0.4),
            ],
        ),
    ]
    combined = TranscriptionEngine().merge_transcripts(p).model_dump()
    assert [u["track_id"] for u in combined["utterances"]] == ["host"]

    mapped = map_transcript_utterances_to_timeline(p, combined)
    assert mapped is not None
    rows = mapped["utterances"]
    assert [(r["track_id"], r["start"]) for r in rows] == [
        ("guest", 0.0),
        ("host", 1.0),
        ("guest", 2.0),
    ]
    assert [w["word_index"] for w in rows[0]["words"]] == [0, 1]
    assert [w["word_index"] for w in rows[2]["words"]] == [2]


def test_map_transcript_suppressed_only_rows_sorted_across_tracks() -> None:
    """Two all-suppressed tracks' runs interleave by source start, not by track order (#758)."""
    p = _minimal()
    p.timeline.tracks.append(
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/guest.wav", duration_sec=10.0),
        )
    )
    p.timeline.clips.append(
        Clip(id="g1", track_id="guest", source_start=0.0, source_end=10.0, timeline_start=0.0)
    )
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="a", start=2.0, end=2.2, suppressed=True, confidence=0.4),
                TranscriptWord(text="b", start=8.0, end=8.2, suppressed=True, confidence=0.4),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="c", start=1.0, end=1.2, suppressed=True, confidence=0.4),
                TranscriptWord(text="d", start=5.0, end=5.2, suppressed=True, confidence=0.4),
            ],
        ),
    ]
    combined = TranscriptionEngine().merge_transcripts(p).model_dump()
    assert combined["utterances"] == []

    for include_words in (True, False):
        mapped = map_transcript_utterances_to_timeline(p, combined, include_words=include_words)
        assert mapped is not None
        rows = mapped["utterances"]
        assert [(r["track_id"], r["start"]) for r in rows] == [
            ("guest", 1.0),
            ("host", 2.0),
            ("guest", 5.0),
            ("host", 8.0),
        ]
        assert all(r["suppressed_only"] is True for r in rows)


def test_map_transcript_input_row_wins_start_tie_with_suppressed_only_row() -> None:
    """At an equal source start, an input row sorts ahead of a suppressed_only row (#758)."""
    p = _minimal()
    p.timeline.tracks.append(
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/guest.wav", duration_sec=10.0),
        )
    )
    p.timeline.clips.append(
        Clip(id="g1", track_id="guest", source_start=0.0, source_end=10.0, timeline_start=0.0)
    )
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="hi", start=2.0, end=2.2, confidence=0.9)],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="um", start=2.0, end=2.2, suppressed=True, confidence=0.4),
                TranscriptWord(text="uh", start=5.0, end=5.2, suppressed=True, confidence=0.4),
            ],
        ),
    ]
    combined = TranscriptionEngine().merge_transcripts(p).model_dump()
    assert [u["track_id"] for u in combined["utterances"]] == ["host"]

    for include_words in (True, False):
        mapped = map_transcript_utterances_to_timeline(p, combined, include_words=include_words)
        assert mapped is not None
        rows = mapped["utterances"]
        assert [(r["track_id"], r["start"]) for r in rows] == [
            ("host", 2.0),
            ("guest", 2.0),
            ("guest", 5.0),
        ]
        assert "suppressed_only" not in rows[0]
        assert rows[1]["suppressed_only"] is True
        assert rows[2]["suppressed_only"] is True


def test_map_transcript_suppressed_only_row_lists_ignored_indices() -> None:
    """A suppressed_only row lists its ignored words, with and without word views (#758)."""
    p = _minimal()
    p.timeline.tracks.append(
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/guest.wav", duration_sec=10.0),
        )
    )
    p.timeline.clips.append(
        Clip(id="g1", track_id="guest", source_start=0.0, source_end=10.0, timeline_start=0.0)
    )
    p.transcripts = [
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(
                    text="um", start=0.0, end=0.2, suppressed=True, ignored=True, confidence=0.4
                ),
                TranscriptWord(text="uh", start=0.3, end=0.5, suppressed=True, confidence=0.4),
            ],
        ),
    ]
    combined = {"utterances": []}
    mapped = map_transcript_utterances_to_timeline(p, combined)
    assert mapped is not None
    row = mapped["utterances"][0]
    assert row["ignored_word_indices"] == [0]

    slim = map_transcript_utterances_to_timeline(p, combined, include_words=False)
    assert slim is not None
    assert slim["utterances"][0]["ignored_word_indices"] == [0]
    assert "words" not in slim["utterances"][0]


def test_map_transcript_suppressed_only_row_unmappable_without_clip() -> None:
    """A suppressed_only row whose source window is cut away is unmappable, like any other row (#758)."""
    p = _minimal()
    p.timeline.tracks.append(
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/guest.wav", duration_sec=10.0),
        )
    )
    p.timeline.clips.append(
        Clip(id="g1", track_id="guest", source_start=5.0, source_end=10.0, timeline_start=0.0)
    )
    p.transcripts = [
        Transcript(
            track_id="guest",
            words=[TranscriptWord(text="um", start=0.0, end=0.2, suppressed=True, confidence=0.4)],
        ),
    ]
    combined = {"utterances": []}
    mapped = map_transcript_utterances_to_timeline(p, combined)
    assert mapped is not None
    row = mapped["utterances"][0]
    assert row["mappable"] is False
    assert row["timeline_spans"] == []


def test_map_transcript_no_suppressed_only_row_for_stale_combined() -> None:
    """A track with unsuppressed words but no input row is stale combined.json, not all-suppressed (#758)."""
    p = _minimal()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="hello", start=0.0, end=0.3, confidence=0.9)],
        ),
    ]
    combined = {"utterances": []}
    mapped = map_transcript_utterances_to_timeline(p, combined)
    assert mapped is not None
    assert mapped["utterances"] == []


def test_map_transcript_no_suppressed_only_row_when_track_has_rows() -> None:
    """A track that already has a row (the #752 first-word case) gets no suppressed_only rows (#758)."""
    p = _minimal()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="welcome", start=0.0, end=0.3, suppressed=True, confidence=0.5),
                TranscriptWord(text="to", start=0.5, end=0.7, confidence=0.9),
                TranscriptWord(text="the", start=0.7, end=0.9, confidence=0.9),
                TranscriptWord(text="show", start=0.9, end=1.1, confidence=0.9),
            ],
        )
    ]
    combined = TranscriptionEngine().merge_transcripts(p).model_dump()
    mapped = map_transcript_utterances_to_timeline(p, combined, include_words=False)
    assert mapped is not None
    assert len(mapped["utterances"]) == 1
    assert "suppressed_only" not in mapped["utterances"][0]


def test_map_transcript_rows_list_edge_suppressed_indices() -> None:
    """Rows list attached edge-suppressed words, SHELL (include_words=False) included (#752)."""
    p = _minimal()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="welcome", start=0.0, end=0.3, suppressed=True, confidence=0.9),
                TranscriptWord(text="to", start=0.3, end=0.5, suppressed=True, confidence=0.9),
                TranscriptWord(text="the", start=2.0, end=2.2, confidence=0.9),
                TranscriptWord(text="show", start=2.2, end=2.4, confidence=0.9),
            ],
        )
    ]
    combined = TranscriptionEngine().merge_transcripts(p).model_dump()
    assert len(combined["utterances"]) == 1
    for include_words in (True, False):
        mapped = map_transcript_utterances_to_timeline(p, combined, include_words=include_words)
        assert mapped is not None
        assert mapped["utterances"][0]["edge_suppressed_word_indices"] == [0, 1]
    words = p.transcripts[0].words
    words[0] = words[0].model_copy(update={"suppressed": False})
    words[1] = words[1].model_copy(update={"suppressed": False})
    combined = TranscriptionEngine().merge_transcripts(p).model_dump()
    assert len(combined["utterances"]) == 2
    mapped = map_transcript_utterances_to_timeline(p, combined, include_words=False)
    assert mapped is not None
    assert all("edge_suppressed_word_indices" not in u for u in mapped["utterances"])


def test_map_transcript_ignored_zero_length_word_in_ignored_indices() -> None:
    """A zero-length ignored word inside the window is found through the raw-word index (#633)."""
    p = _minimal()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.3, confidence=0.9),
                TranscriptWord(text="uh", start=0.4, end=0.4, ignored=True, confidence=0.4),
                TranscriptWord(text="world", start=0.5, end=0.8, confidence=0.9),
            ],
        )
    ]
    combined = TranscriptionEngine().merge_transcripts(p).model_dump()
    mapped = map_transcript_utterances_to_timeline(p, combined, include_words=False)
    assert mapped is not None
    assert mapped["utterances"][0]["ignored_word_indices"] == [1]


def test_map_transcript_utterances_unmappable() -> None:
    p = _minimal()
    transcript = {
        "utterances": [
            {
                "track_id": "host",
                "speaker": "Host",
                "start": 20.0,
                "end": 21.0,
                "text": "gone",
            }
        ]
    }
    mapped = map_transcript_utterances_to_timeline(p, transcript)
    assert mapped is not None
    assert mapped["utterances"][0]["mappable"] is False
    assert mapped["utterances"][0]["timeline_start"] is None


def _with_cut_gap() -> EpisodeProject:
    """Source [0-3]@tl[0-3] then [7-10]@tl[3-6] - middle source cut away (joined)."""
    p = EpisodeProject.create("gui-gap", "/tmp/gui-gap")
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    p.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=3.0,
            timeline_start=0.0,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=7.0,
            source_end=10.0,
            timeline_start=3.0,
        ),
    ]
    return p


def _with_timeline_hole() -> EpisodeProject:
    """Surviving clips with a timeline hole so source spans map to non-merged intervals."""
    p = EpisodeProject.create("gui-hole", "/tmp/gui-hole")
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    p.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=8.0,
            source_end=10.0,
            timeline_start=5.0,
        ),
    ]
    return p


def test_map_transcript_utterances_multi_span() -> None:
    p = _with_timeline_hole()
    transcript = {
        "utterances": [
            {
                "track_id": "host",
                "speaker": "Host",
                "start": 1.0,
                "end": 9.0,
                "text": "across hole",
            }
        ]
    }
    mapped = map_transcript_utterances_to_timeline(p, transcript)
    assert mapped is not None
    u = mapped["utterances"][0]
    assert u["mappable"] is True
    assert len(u["timeline_spans"]) == 2
    assert u["timeline_spans"][0]["start"] == pytest.approx(1.0)
    assert u["timeline_spans"][0]["end"] == pytest.approx(2.0)
    assert u["timeline_spans"][1]["start"] == pytest.approx(5.0)
    assert u["timeline_spans"][1]["end"] == pytest.approx(6.0)
    assert u["timeline_start"] == pytest.approx(1.0)
    assert u["timeline_end"] == pytest.approx(6.0)


def test_map_applied_edits_fills_missing_timeline() -> None:
    p = _with_cut_gap()
    legacy = AppliedEditRecord(
        id="alog_legacy",
        applied_at="2026-01-01T00:00:00+00:00",
        operation="remove",
        track_ids=["host"],
        source_start=1.0,
        source_end=2.0,
        timeline_start=None,
        timeline_end=None,
        reason="legacy",
    )
    already = AppliedEditRecord(
        id="alog_ok",
        applied_at="2026-01-01T00:00:00+00:00",
        operation="remove",
        track_ids=["host"],
        source_start=8.0,
        source_end=9.0,
        timeline_start=4.0,
        timeline_end=5.0,
        reason="has timeline",
    )
    view = map_applied_edits_to_timeline(
        p, {"count": 2, "records": [legacy.model_dump(), already.model_dump()]}
    )
    assert view["count"] == 2
    remapped = view["records"][0]
    assert remapped["timeline_start"] == pytest.approx(1.0)
    assert remapped["timeline_end"] == pytest.approx(2.0)
    # Pass-through when timeline already set
    assert view["records"][1]["timeline_start"] == pytest.approx(4.0)
    assert view["records"][1]["timeline_end"] == pytest.approx(5.0)


def test_map_applied_edits_unmappable_source_stays_null() -> None:
    p = _with_cut_gap()
    cut_away = AppliedEditRecord(
        id="alog_gone",
        applied_at="2026-01-01T00:00:00+00:00",
        operation="remove",
        track_ids=["host"],
        source_start=4.0,
        source_end=5.0,
        timeline_start=None,
        timeline_end=None,
    )
    view = map_applied_edits_to_timeline(p, {"count": 1, "records": [cut_away]})
    assert view["records"][0]["timeline_start"] is None
    assert view["records"][0]["timeline_end"] is None


def test_social_clips_for_view() -> None:
    p = _minimal()
    p.social.clip_candidates = [
        SocialClipCandidate(
            id="s1",
            track_id="host",
            start=1.0,
            end=3.0,
            score=0.9,
            title_suggestion="Hook",
            approved=False,
        )
    ]
    rows = social_clips_for_view(p)
    assert len(rows) == 1
    assert rows[0]["id"] == "s1"
    assert rows[0]["start"] == pytest.approx(1.0)
    assert rows[0]["title_suggestion"] == "Hook"


def _fixture_project():
    from pathlib import Path

    fixture = (
        Path(__file__).resolve().parents[0]
        / "fixtures"
        / "aligned_dialogue"
        / "episode.project.json"
    )
    if not fixture.is_file():
        pytest.skip("aligned_dialogue fixture missing")
    return fixture


def test_api_project_bootstrap() -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    fixture = _fixture_project()
    client = TestClient(create_app())
    res = client.get("/api/project", params={"path": str(fixture)})
    assert res.status_code == 200
    data = res.json()
    assert "tracks" in data
    assert "clips" in data
    assert "pending_edits" in data
    assert "render_status" in data
    assert data["timeline_duration_sec"] > 0


def test_api_project_get_pins_and_close_unpins(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    from pathlib import Path

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.project.peer_host",
        lambda _request: "127.0.0.1",
    )
    client = TestClient(create_app(served_project=None))
    assert client.app.state.served_project is None
    res = client.get("/api/project", params={"path": str(minimal_project)})
    assert res.status_code == 200, res.text
    assert client.app.state.served_project == Path(minimal_project).resolve()
    closed = client.post("/api/project/close")
    assert closed.status_code == 200, closed.text
    assert closed.json() == {"ok": True}
    assert client.app.state.served_project is None


def test_api_project_create_and_open(tmp_path, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    from pathlib import Path

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.project.peer_host",
        lambda _request: "127.0.0.1",
    )
    client = TestClient(create_app(served_project=None))
    created = client.post(
        "/api/project/create",
        json={"workspace_dir": str(tmp_path / "demo"), "name": "Demo"},
    )
    assert created.status_code == 200, created.text
    project_path = created.json()["project_path"]
    assert created.json()["name"] == "Demo"

    opened = client.post("/api/project/open", json={"path": project_path})
    assert opened.status_code == 200
    assert opened.json()["project_path"] == project_path

    # Open via workspace directory resolves to episode.project.json
    by_dir = client.post(
        "/api/project/open",
        json={"path": str(Path(project_path).parent)},
    )
    assert by_dir.status_code == 200
    assert by_dir.json()["project_path"] == project_path

    blank = client.post(
        "/api/project/create",
        json={"workspace_dir": str(tmp_path / "blank"), "name": "  "},
    )
    assert blank.status_code == 200

    wrong_name = client.post(
        "/api/project/open",
        json={"path": str(tmp_path / "missing.json")},
    )
    assert wrong_name.status_code == 400
    assert "episode.project.json" in wrong_name.json()["detail"]

    missing = client.post(
        "/api/project/open",
        json={"path": str(tmp_path / "nope" / "episode.project.json")},
    )
    assert missing.status_code == 404

    junk = tmp_path / "episode.project.json"
    junk.write_text("not-a-project", encoding="utf-8")
    invalid = client.post("/api/project/open", json={"path": str(junk)})
    assert invalid.status_code == 400

    def _create_fails(*_args, **_kwargs):
        raise ValueError("nope")

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.project.ProjectWorkspace.create",
        _create_fails,
    )
    failed = client.post(
        "/api/project/create",
        json={"workspace_dir": str(tmp_path / "fail"), "name": "X"},
    )
    assert failed.status_code == 400

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.project.peer_host",
        lambda _request: "10.0.0.5",
    )
    assert (
        client.post(
            "/api/project/create",
            json={"workspace_dir": str(tmp_path / "remote"), "name": "X"},
        ).status_code
        == 403
    )
    assert client.post("/api/project/open", json={"path": project_path}).status_code == 403


def test_api_project_pick(tmp_path, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.host_file_dialog import HostPickResult
    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services import ProjectWorkspace

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.project.peer_host",
        lambda _request: "127.0.0.1",
    )
    client = TestClient(create_app(served_project=None))
    ws = ProjectWorkspace.create(tmp_path / "picked", name="Picked")
    project_path = str(ws.path)
    assert client.app.state.served_project is None

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.project.pick_episode_project_path",
        lambda: HostPickResult(path=project_path),
    )
    picked = client.post("/api/project/pick")
    assert picked.status_code == 200
    assert picked.json()["project_path"] == project_path
    # Pick must not pin served_project — open does that.
    assert client.app.state.served_project is None

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.project.pick_episode_project_path",
        lambda: HostPickResult(cancelled=True),
    )
    assert client.post("/api/project/pick").json() == {"cancelled": True}

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.project.pick_episode_project_path",
        lambda: HostPickResult(cancelled=True, detail="File dialog timed out."),
    )
    timed_out = client.post("/api/project/pick")
    assert timed_out.status_code == 200
    assert timed_out.json() == {
        "cancelled": True,
        "detail": "File dialog timed out.",
    }

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.project.pick_episode_project_path",
        lambda: HostPickResult(unavailable=True, detail="no dialog"),
    )
    unavailable = client.post("/api/project/pick")
    assert unavailable.status_code == 200
    assert unavailable.json()["unavailable"] is True
    assert unavailable.json()["detail"] == "no dialog"

    missing = tmp_path / "gone" / "episode.project.json"
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.project.pick_episode_project_path",
        lambda: HostPickResult(path=str(missing)),
    )
    assert client.post("/api/project/pick").status_code == 404

    other = tmp_path / "other.json"
    other.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.project.pick_episode_project_path",
        lambda: HostPickResult(path=str(other)),
    )
    bad_name = client.post("/api/project/pick")
    assert bad_name.status_code == 400
    assert "episode.project.json" in bad_name.json()["detail"]

    from podcast_mcp.gui.routes import project as project_routes

    held = project_routes._PICK_LOCK.acquire(blocking=False)
    assert held
    try:
        busy = client.post("/api/project/pick")
        assert busy.status_code == 409
    finally:
        project_routes._PICK_LOCK.release()

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.project.peer_host",
        lambda _request: "10.0.0.5",
    )
    assert client.post("/api/project/pick").status_code == 403


def test_api_project_pick_empty_path_and_close_forbidden(tmp_path, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.host_file_dialog import HostPickResult
    from podcast_mcp.gui.server import create_app

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.project.peer_host",
        lambda _request: "127.0.0.1",
    )
    client = TestClient(create_app(served_project=None))
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.project.pick_episode_project_path",
        lambda: HostPickResult(detail="empty"),
    )
    empty = client.post("/api/project/pick")
    assert empty.status_code == 400
    assert empty.json()["detail"] == "empty"

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.project.peer_host",
        lambda _request: "10.0.0.5",
    )
    assert client.post("/api/project/close").status_code == 403


def test_api_waveform_snap_unknown_track(minimal_project) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    res = client.get(
        "/api/waveform-snap",
        params={
            "path": str(minimal_project),
            "track_id": "missing",
            "start": 0.0,
            "end": 0.4,
        },
    )
    assert res.status_code == 400


def test_api_audio_resolve_errors(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())

    def bad_kind(*_args: object, **_kwargs: object) -> None:
        raise ValueError("bad kind")

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.project.resolve_viewer_transport",
        bad_kind,
    )
    bad = client.get("/api/audio", params={"path": str(minimal_project)})
    assert bad.status_code == 400

    def missing_kind(*_args: object, **_kwargs: object) -> None:
        raise KeyError("no stem")

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.project.resolve_viewer_transport",
        missing_kind,
    )
    missing = client.get("/api/audio", params={"path": str(minimal_project)})
    assert missing.status_code == 404


def test_api_audio_rerender_merge_conflict_is_409(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.project_merge import ProjectMergeConflict

    def conflict(*_args: object, **_kwargs: object) -> None:
        raise ProjectMergeConflict(["render.premix_hash"])

    monkeypatch.setattr("podcast_mcp.gui.routes.project.resolve_viewer_transport", conflict)
    res = TestClient(create_app()).get(
        "/api/audio", params={"path": str(minimal_project), "rerender": "true"}
    )
    assert res.status_code == 409
    assert "re-run it" in res.json()["detail"]


def test_project_busy_error_is_a_503_with_the_shared_code() -> None:
    pytest.importorskip("fastapi")
    from podcast_mcp.gui.routes.deps import PROJECT_BUSY_CODE, project_busy_error

    exc = project_busy_error("busy")
    assert exc.status_code == 503
    assert exc.detail == "busy"
    assert exc.headers == {"X-Sharecut-Error-Code": PROJECT_BUSY_CODE}
    assert PROJECT_BUSY_CODE == "project_busy"


def test_project_busy_http_error_maps_timeout_and_sqlite_busy_only() -> None:
    pytest.importorskip("fastapi")
    import sqlite3

    from filelock import Timeout

    from podcast_mcp.gui.routes.deps import project_busy_http_error
    from podcast_mcp.util.project_state import PROJECT_BUSY_MESSAGE

    lock = project_busy_http_error(Timeout("/secret/artifacts/episode.project.json.lock"))
    assert lock is not None and lock.status_code == 503
    assert "/secret" not in lock.detail
    db = project_busy_http_error(sqlite3.OperationalError("database is locked"))
    assert db is not None and db.detail == PROJECT_BUSY_MESSAGE
    assert db.headers == {"X-Sharecut-Error-Code": "project_busy"}
    assert project_busy_http_error(sqlite3.OperationalError("no such table: x")) is None
    assert project_busy_http_error(ValueError("bad")) is None


def test_api_audio_render_busy_is_503(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.util.project_state import RenderBusyError

    def busy(*_args: object, **_kwargs: object) -> None:
        raise RenderBusyError("render.lock")

    monkeypatch.setattr("podcast_mcp.gui.routes.project.resolve_viewer_transport", busy)
    res = TestClient(create_app()).get(
        "/api/audio", params={"path": str(minimal_project), "rerender": "true"}
    )
    assert res.status_code == 503
    assert res.headers["X-Sharecut-Error-Code"] == "project_busy"
    assert "another render" in res.json()["detail"]


def test_api_audio_render_busy_fallback_sets_header(
    minimal_project, sample_wav, tmp_path, monkeypatch
) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services.play import TransportPath

    wav = tmp_path / "premix.wav"
    wav.write_bytes(sample_wav.read_bytes())
    client = TestClient(create_app())
    params = {"path": str(minimal_project), "rerender": "true"}
    for busy in (True, False):
        transport = TransportPath(path=wav, source="premix", tier="premix", render_busy=busy)
        monkeypatch.setattr(
            "podcast_mcp.gui.routes.project.resolve_viewer_transport",
            lambda *_a, _t=transport, **_k: _t,
        )
        res = client.get("/api/audio", params=params)
        assert res.status_code == 200
        assert ("X-Sharecut-Render-Busy" in res.headers) is busy
        if busy:
            assert res.headers["X-Sharecut-Render-Busy"] == "1"


def test_api_audio_project_lock_timeout_hides_the_lock_path(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    from filelock import Timeout

    from podcast_mcp.gui.server import create_app

    def busy(*_args: object, **_kwargs: object) -> None:
        raise Timeout("/secret/ws/artifacts/episode.project.json.lock")

    monkeypatch.setattr("podcast_mcp.gui.routes.project.resolve_viewer_transport", busy)
    res = TestClient(create_app()).get(
        "/api/audio", params={"path": str(minimal_project), "rerender": "true"}
    )
    assert res.status_code == 503
    assert res.headers["X-Sharecut-Error-Code"] == "project_busy"
    assert "/secret" not in res.json()["detail"]


def test_api_health() -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    assert client.get("/api/health").json() == {"ok": True}


def test_api_project_meta(minimal_project) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    res = client.get("/api/project/meta", params={"path": str(minimal_project)})
    assert res.status_code == 200
    data = res.json()
    assert data["mtime_ns"] > 0
    assert data["size"] > 0
    assert "episode.project.json" in data["path"] or data["path"].endswith(
        str(minimal_project.name)
    )


def test_api_session_meta_missing(minimal_project) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    res = client.get("/api/session/meta", params={"path": str(minimal_project)})
    assert res.status_code == 200
    data = res.json()
    assert data["exists"] is False
    assert data["mtime_ns"] == 0


def test_api_session_meta_tracks_commits(minimal_project, monkeypatch) -> None:
    import itertools

    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.models import load_project
    from podcast_mcp.services.session_sync import log as session_sync_log
    from podcast_mcp.services.session_sync.viewer import publish_agent_play

    ticker = itertools.count(10**18, 1000)
    monkeypatch.setattr(session_sync_log.time, "time_ns", lambda: next(ticker))

    proj = load_project(minimal_project)
    publish_agent_play(
        proj,
        timeline_start_sec=0.0,
        timeline_end_sec=1.0,
        source="premix",
        tier="premix",
        dry_run=True,
    )
    client = TestClient(create_app())
    meta1 = client.get("/api/session/meta", params={"path": str(minimal_project)}).json()

    publish_agent_play(
        proj,
        timeline_start_sec=1.0,
        timeline_end_sec=2.0,
        source="premix",
        tier="premix",
        dry_run=True,
    )
    meta2 = client.get("/api/session/meta", params={"path": str(minimal_project)}).json()

    assert meta2["server_seq"] > meta1["server_seq"]
    assert meta2["mtime_ns"] != meta1["mtime_ns"]


def test_api_session_state_roundtrip(minimal_project) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.models import load_project
    from podcast_mcp.services.session_sync.viewer import publish_agent_play

    proj = load_project(minimal_project)
    publish_agent_play(
        proj,
        timeline_start_sec=12.5,
        timeline_end_sec=18.0,
        source="premix",
        tier="premix",
        dry_run=True,
        query="puro pinche party",
    )
    client = TestClient(create_app())
    meta = client.get("/api/session/meta", params={"path": str(minimal_project)})
    assert meta.status_code == 200
    assert meta.json()["exists"] is True
    assert meta.json()["mtime_ns"] > 0

    state = client.get("/api/session/state", params={"path": str(minimal_project)})
    assert state.status_code == 200
    body = state.json()
    assert body["query"] == "puro pinche party"
    assert body["region"]["start_sec"] == 12.5
    assert body["region"]["end_sec"] == 18.0
    assert body["source"] == "premix"
    assert body["is_playing"] is True
    assert body["last_command_id"]
    assert body["origin"] == "agent"

    # While agent transport is playing, viewer playhead is presence-only
    # (durable SetPlayhead would stutter audio). Region must stay LWW.
    posted = client.post(
        "/api/session/state",
        params={"path": str(minimal_project)},
        json={
            "playhead_sec": 13.0,
            "client_id": "viewer-gui-test",
            "ack_command_id": body["last_command_id"],
        },
    )
    assert posted.status_code == 200
    out = posted.json()
    assert out["playhead_sec"] == 12.5  # durable agent seek unchanged
    assert out["region"]["start_sec"] == 12.5
    assert out["server_seq"] >= body.get("server_seq", 1)
    viewer = next(c for c in (out.get("clients") or []) if c["client_id"] == "viewer-gui-test")
    assert viewer["playhead_sec"] == 13.0

    cmd = client.post(
        "/api/session/command",
        params={"path": str(minimal_project)},
        json={
            "type": "SetPlayhead",
            "payload": {"playhead_sec": 14.0},
            "client_id": "agent-http",
            "role": "agent",
            "client_seq": 9001,
        },
    )
    assert cmd.status_code == 200
    assert cmd.json()["snapshot"]["playhead_sec"] == 14.0


def test_api_session_state_missing(minimal_project) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    res = client.get("/api/session/state", params={"path": str(minimal_project)})
    assert res.status_code == 404
    assert res.json()["available"] is False


def test_api_comments_create_resolve_action(minimal_project) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    path = str(minimal_project)
    created = client.post(
        "/api/comments",
        json={
            "path": path,
            "body": "Too long here",
            "author": "guest",
            "timeline_start": 10.0,
            "timeline_end": 15.0,
            "action_texts": ["Trim 5s"],
        },
    )
    assert created.status_code == 200
    comment = created.json()["comment"]
    assert comment["author"] == "guest"
    assert len(comment["action_items"]) == 1
    cid = comment["id"]
    aid = comment["action_items"][0]["id"]

    meta = client.get("/api/project/meta", params={"path": path})
    assert meta.status_code == 200
    assert meta.json()["server_seq"] == 1

    view = client.get("/api/project", params={"path": path})
    assert view.status_code == 200
    assert any(c["id"] == cid for c in view.json().get("comments", []))

    done = client.post(
        f"/api/comments/{cid}/actions/{aid}/done",
        json={"path": path, "done": True, "by": "editor"},
    )
    assert done.status_code == 200
    assert done.json()["action_item"]["completed_by"] == "editor"

    resolved = client.patch(
        f"/api/comments/{cid}",
        json={"path": path, "resolved": True, "by": "editor"},
    )
    assert resolved.status_code == 200
    assert resolved.json()["comment"]["resolved"] is True


def test_api_comment_noop_patch_journals_nothing(minimal_project) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    path = str(minimal_project)
    created = client.post(
        "/api/comments",
        json={"path": path, "body": "note", "author": "host", "timeline_start": 1.0},
    )
    assert created.status_code == 200
    cid = created.json()["comment"]["id"]
    seq = client.get("/api/project/meta", params={"path": path}).json()["server_seq"]

    noop = client.patch(f"/api/comments/{cid}", json={"path": path})
    assert noop.status_code == 200
    assert noop.json()["comment"]["id"] == cid
    assert client.get("/api/project/meta", params={"path": path}).json()["server_seq"] == seq


@pytest.mark.parametrize(
    "make_exc",
    [
        lambda: ProjectBusyError("/artifacts/episode.project.json.lock"),
        lambda: RenderBusyError("/artifacts/render.lock"),
        lambda: Timeout("/artifacts/transcript_context.yaml.lock"),
    ],
    ids=["project-busy", "render-busy", "raw-timeout"],
)
def test_api_comments_busy_lock_returns_503(minimal_project, monkeypatch, make_exc) -> None:
    """A busy project/render lock (#488) maps to 503 project_busy, never the lock path."""
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.routes import comments as comments_route
    from podcast_mcp.gui.server import create_app

    def _raise(self, **kwargs):
        raise make_exc()

    monkeypatch.setattr(comments_route.CommentService, "add", _raise)
    client = TestClient(create_app())
    res = client.post(
        "/api/comments",
        json={
            "path": str(minimal_project),
            "body": "note",
            "author": "host",
            "timeline_start": 1.0,
        },
    )
    assert res.status_code == 503
    assert res.headers["X-Sharecut-Error-Code"] == "project_busy"
    assert "/artifacts" not in res.text


def test_api_comments_non_busy_error_stays_500(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.routes import comments as comments_route
    from podcast_mcp.gui.server import create_app

    def _raise(self, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(comments_route.CommentService, "add", _raise)
    client = TestClient(create_app(), raise_server_exceptions=False)
    res = client.post(
        "/api/comments",
        json={
            "path": str(minimal_project),
            "body": "note",
            "author": "host",
            "timeline_start": 1.0,
        },
    )
    assert res.status_code == 500


def test_api_pipeline_steps() -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.pipeline import STEP_NAMES

    client = TestClient(create_app())
    res = client.get("/api/pipeline/steps")
    assert res.status_code == 200
    assert res.json()["steps"] == list(STEP_NAMES)


def test_api_pipeline_status_idle() -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    res = client.get("/api/pipeline/status")
    assert res.status_code == 200
    assert res.json() == {
        "running": False,
        "job": None,
        "jobs": [],
        "running_count": 0,
    }


def test_pipeline_status_scoped_to_project(tmp_path) -> None:
    """status(project_path=...) hides jobs from other projects (#170)."""
    from podcast_mcp.gui.jobs import PipelineJob, PipelineJobManager

    mgr = PipelineJobManager()
    project_a = (tmp_path / "proj-a" / "episode.project.json").resolve()
    project_b = (tmp_path / "proj-b" / "episode.project.json").resolve()
    job_a = PipelineJob(
        id="jobaaa",
        project_path=str(project_a),
        from_step=None,
        only_step=None,
        kind="export",
        status="ok",
    )
    # Simulate project A's finished export as the current job.
    mgr._job = job_a
    mgr._finished[job_a.id] = job_a
    mgr._finished_order.append(job_a.id)

    # Unfiltered: A's job visible.
    st = mgr.status()
    assert st["job"]["id"] == "jobaaa"
    assert [j["id"] for j in st["jobs"]] == ["jobaaa"]

    # Scoped to project A: still visible.
    st_a = mgr.status(project_path=str(project_a))
    assert st_a["job"]["id"] == "jobaaa"
    assert [j["id"] for j in st_a["jobs"]] == ["jobaaa"]

    # Scoped to project B (switched projects): hidden.
    st_b = mgr.status(project_path=str(project_b))
    assert st_b["job"] is None
    assert st_b["jobs"] == []
    assert st_b["running"] is False
    assert st_b["running_count"] == 0


def test_api_pipeline_status_scopes_to_served_project(minimal_project, tmp_path) -> None:
    """The status route shows the served project's job, not another project's."""
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.jobs import PipelineJob
    from podcast_mcp.gui.server import create_app

    other = tmp_path / "other" / "episode.project.json"
    other.parent.mkdir()
    other.write_text(minimal_project.read_text())
    client = TestClient(create_app(served_project=other))
    other_job = PipelineJob(
        id="other-job",
        project_path=str(other.resolve()),
        from_step=None,
        only_step=None,
        kind="export",
        status="ok",
    )
    hidden_job = PipelineJob(
        id="hidden-job",
        project_path=str(minimal_project.resolve()),
        from_step=None,
        only_step=None,
        kind="pipeline",
        status="ok",
    )
    jobs = client.app.state.jobs
    jobs._job = other_job
    jobs._finished[hidden_job.id] = hidden_job
    jobs._finished_order.append(hidden_job.id)

    res = client.get("/api/pipeline/status")
    assert res.status_code == 200
    assert res.json()["job"]["id"] == "other-job"
    assert [row["id"] for row in res.json()["jobs"]] == ["other-job"]


def test_api_pipeline_run_and_events(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    import json
    import time

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.util.progress import NullProgress

    def fake_run(self, **kwargs):
        progress = kwargs.get("progress")
        reporter = progress or NullProgress()
        reporter.start("pipeline", "Pipeline", total=2)
        reporter.message("pipeline", "Running step_a")
        reporter.update(
            "pipeline",
            1,
            total=2,
            message="Completed step_a: 3 tracks probed",
        )
        reporter.message("pipeline", "Running step_b")
        reporter.update(
            "pipeline",
            2,
            total=2,
            message="Completed step_b: 12 cuts applied",
        )
        reporter.end("pipeline")
        return PipelineRunResult(
            last_step="step_b",
            steps=[],
            export_qc={"ok": False, "issues": ["bad"], "warnings": [], "timebase": {"big": 1}},
            export_qc_path=minimal_project.parent / "export_qc.json",
        )

    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.run",
        fake_run,
    )

    client = TestClient(create_app())
    res = client.post(
        "/api/pipeline/run",
        json={"path": str(minimal_project)},
    )
    assert res.status_code == 200
    job_id = res.json()["job"]["id"]

    for _ in range(50):
        st = client.get("/api/pipeline/status").json()
        if st["job"] and st["job"]["status"] in ("ok", "error"):
            break
        time.sleep(0.05)
    st = client.get("/api/pipeline/status").json()
    assert st["job"]["id"] == job_id
    assert st["job"]["status"] == "ok"
    assert st["job"]["current"] == 2
    assert len(st["job"]["steps"]) == 2
    assert st["job"]["steps"][0]["name"] == "step_a"
    assert st["job"]["steps"][0]["summary"] == "3 tracks probed"
    assert st["job"]["steps"][1]["summary"] == "12 cuts applied"
    assert st["job"]["result"] == {
        "export_qc": {"ok": False, "issues": ["bad"], "warnings": []},
        "export_qc_path": str(minimal_project.parent / "export_qc.json"),
    }

    with client.stream(
        "GET",
        "/api/pipeline/events",
        params={"job_id": job_id},
    ) as stream:
        assert stream.status_code == 200
        lines = [ln for ln in stream.iter_lines() if ln.startswith("data: ")]
        assert lines
        payload = json.loads(lines[0].removeprefix("data: "))
        assert payload["type"] in ("status", "done")
        assert payload["job"]["id"] == job_id


def test_api_pipeline_events_status_snapshots_while_running(minimal_project, monkeypatch) -> None:
    """Quiet steps should still get ~1s SSE status snapshots with fresh elapsed."""
    pytest.importorskip("fastapi")
    import json
    import threading
    import time

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    started = threading.Event()
    release = threading.Event()

    def blocking_run(self, **kwargs):
        progress = kwargs.get("progress")
        if progress is not None:
            progress.start("pipeline", "Pipeline", total=1)
            progress.message("pipeline", "Running long_step")
        started.set()
        release.wait(timeout=5)
        if progress is not None:
            progress.update("pipeline", 1, total=1, message="done")
            progress.end("pipeline")
        return PipelineRunResult(last_step="long_step", steps=[])

    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.run",
        blocking_run,
    )

    client = TestClient(create_app())
    res = client.post(
        "/api/pipeline/run",
        json={"path": str(minimal_project)},
    )
    assert res.status_code == 200
    job_id = res.json()["job"]["id"]
    assert started.wait(timeout=2)

    with client.stream(
        "GET",
        "/api/pipeline/events",
        params={"job_id": job_id},
    ) as stream:
        assert stream.status_code == 200
        status_events = []
        deadline = time.monotonic() + 3.5
        first_elapsed: float | None = None
        for line in stream.iter_lines():
            if not line.startswith("data: "):
                continue
            payload = json.loads(line.removeprefix("data: "))
            if payload.get("type") == "status":
                status_events.append(payload)
                elapsed = float(payload["job"]["elapsed_sec"])
                if first_elapsed is None:
                    first_elapsed = elapsed
                # Wait for a quiet-step heartbeat (~1s Empty timeout) so
                # elapsed advances past the connect snapshot.
                if first_elapsed is not None and elapsed > first_elapsed:
                    break
            if time.monotonic() > deadline:
                break
        release.set()

    assert len(status_events) >= 2
    assert all(ev["job"]["id"] == job_id for ev in status_events)
    assert status_events[-1]["job"]["elapsed_sec"] > status_events[0]["job"]["elapsed_sec"]


def test_api_pipeline_events_two_subscribers_both_get_done(minimal_project, monkeypatch) -> None:
    """Two concurrent subscribers each get their own full stream, ending in ``done``."""
    pytest.importorskip("fastapi")
    import json
    import threading
    import time

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.job_events import job_listener_count
    from podcast_mcp.gui.server import create_app

    started = threading.Event()
    release = threading.Event()

    def blocking_run(self, **kwargs):
        progress = kwargs.get("progress")
        if progress is not None:
            progress.start("pipeline", "Pipeline", total=1)
            progress.message("pipeline", "Running long_step")
        started.set()
        release.wait(timeout=5)
        if progress is not None:
            progress.update("pipeline", 1, total=1, message="Completed long_step: ok")
            progress.end("pipeline")
        return PipelineRunResult(last_step="long_step", steps=[])

    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.run",
        blocking_run,
    )

    with TestClient(create_app()) as client:
        res = client.post(
            "/api/pipeline/run",
            json={"path": str(minimal_project)},
        )
        assert res.status_code == 200
        job_id = res.json()["job"]["id"]
        assert started.wait(timeout=2)

        bodies: list[str] = []

        def _stream() -> None:
            resp = client.get("/api/pipeline/events", params={"job_id": job_id})
            bodies.append(resp.text)

        threads = [threading.Thread(target=_stream) for _ in range(2)]
        for t in threads:
            t.start()

        deadline = time.monotonic() + 5.0
        while job_listener_count(job_id) < 2 and time.monotonic() < deadline:
            time.sleep(0.02)
        assert job_listener_count(job_id) == 2

        release.set()
        for t in threads:
            t.join(timeout=5)

    assert len(bodies) == 2
    for body in bodies:
        events = [
            json.loads(ln.removeprefix("data: "))
            for ln in body.splitlines()
            if ln.startswith("data: ")
        ]
        assert events[-1]["type"] == "done"
        assert events[-1]["job"]["status"] == "ok"
        assert any(
            ev.get("type") == "progress" and ev.get("message") == "Completed long_step: ok"
            for ev in events
        )


def test_api_pipeline_render_preview(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    import time

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    seen: list[object] = []

    def fake_preview(self, *, rerender=True, progress=None, cancel_check=None):
        seen.append(cancel_check)
        if progress is not None:
            progress.start("render", "Render preview", total=1)
            progress.update("render", 1, total=1, message="Done")
            progress.end("render")
        return {"ok": True, "rerender": rerender}

    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.render_preview",
        fake_preview,
    )

    client = TestClient(create_app())
    res = client.post(
        "/api/pipeline/render-preview",
        json={"path": str(minimal_project)},
    )
    assert res.status_code == 200
    job = res.json()["job"]
    assert job["kind"] == "render_preview"
    for _ in range(50):
        st = client.get("/api/pipeline/status").json()
        if st["job"] and st["job"]["status"] in ("ok", "error"):
            break
        time.sleep(0.05)
    st = client.get("/api/pipeline/status").json()
    assert st["job"]["status"] == "ok"
    assert st["job"]["kind"] == "render_preview"
    assert len(seen) == 1 and callable(seen[0])


def test_api_export_bounce(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    import time

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    monkeypatch.setattr(
        "podcast_mcp.services.bounce.BounceService.validate",
        lambda self, req=None: [],
    )
    monkeypatch.setattr(
        "podcast_mcp.services.bounce.BounceService.bounce",
        lambda self, req=None, **_k: [self.ws.project.export_dir() / "bounces" / "x.wav"],
    )
    client = TestClient(create_app())
    res = client.post(
        "/api/export/bounce",
        json={"path": str(minimal_project), "formats": ["wav"]},
    )
    assert res.status_code == 200
    body = res.json()
    job_id = body["job_id"]
    assert body["job"]["id"] == job_id
    assert body["job"]["kind"] == "bounce"
    job = None
    for _ in range(50):
        st = client.get("/api/pipeline/status").json()
        cand = st.get("job")
        if cand and cand["id"] == job_id and cand["status"] in ("ok", "error"):
            job = cand
            break
        time.sleep(0.05)
    assert job is not None
    assert job["kind"] == "bounce"
    assert job["status"] == "ok"
    assert job["result"]["paths"][0].endswith("x.wav")


def test_api_export_bounce_conflict_when_pipeline_running(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.jobs import PipelineJob
    from podcast_mcp.gui.server import create_app

    monkeypatch.setattr(
        "podcast_mcp.services.bounce.BounceService.bounce",
        lambda self, req=None, **_k: [self.ws.project.export_dir() / "bounces" / "x.wav"],
    )
    app = create_app()
    app.state.jobs._job = PipelineJob(
        id="pipe",
        project_path=str(minimal_project),
        from_step=None,
        only_step=None,
        status="running",
        kind="pipeline",
    )
    client = TestClient(app)
    res = client.post(
        "/api/export/bounce",
        json={"path": str(minimal_project), "formats": ["wav"]},
    )
    assert res.status_code == 409


def test_api_export_bounce_validation_error_is_400(minimal_project) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    res = client.post(
        "/api/export/bounce",
        json={"path": str(minimal_project), "formats": ["wav"]},
    )
    assert res.status_code == 400
    assert "bounceable" in res.json()["detail"].lower()


def test_api_export_deliverables(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    import time

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.export_audio",
        lambda self, formats=None, **_k: [self.ws.project.export_dir() / "demo.wav"],
    )
    client = TestClient(create_app())
    res = client.post(
        "/api/export/deliverables",
        json={"path": str(minimal_project)},
    )
    assert res.status_code == 200
    job_id = res.json()["job_id"]
    job = None
    for _ in range(50):
        st = client.get("/api/pipeline/status").json()
        cand = st.get("job")
        if cand and cand["id"] == job_id and cand["status"] in ("ok", "error"):
            job = cand
            break
        time.sleep(0.05)
    assert job is not None
    assert job["kind"] == "export"
    assert job["status"] == "ok"
    assert job["result"]["paths"][0].endswith("demo.wav")


def test_api_export_deliverables_reports_merge_conflict(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    import time

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.project_merge import ProjectMergeConflict

    def conflict(self, formats=None, **_k):
        raise ProjectMergeConflict(["tracks[host].gain_db"])

    monkeypatch.setattr("podcast_mcp.services.pipeline.PipelineService.export_audio", conflict)
    client = TestClient(create_app())
    res = client.post("/api/export/deliverables", json={"path": str(minimal_project)})
    assert res.status_code == 200
    job_id = res.json()["job_id"]
    job = None
    for _ in range(50):
        cand = client.get("/api/pipeline/status").json().get("job")
        if cand and cand["id"] == job_id and cand["status"] in ("ok", "error"):
            job = cand
            break
        time.sleep(0.05)
    assert job is not None
    assert job["status"] == "error"
    assert "re-run it" in job["error"]
    assert "Traceback" not in job["error"]


def test_api_pipeline_render_preview_marks_error_when_ok_false(
    minimal_project, monkeypatch
) -> None:
    pytest.importorskip("fastapi")
    import time

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    def fake_preview(self, *, rerender=True, progress=None, cancel_check=None):
        return {"ok": False, "path": None}

    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.render_preview",
        fake_preview,
    )

    client = TestClient(create_app())
    res = client.post(
        "/api/pipeline/render-preview",
        json={"path": str(minimal_project)},
    )
    assert res.status_code == 200
    job_id = res.json()["job"]["id"]
    final = None
    for _ in range(50):
        st = client.get("/api/pipeline/status").json()
        job = st.get("job")
        if job and job["id"] == job_id and job["status"] in ("ok", "error"):
            final = job
            break
        time.sleep(0.05)
    assert final is not None
    assert final["status"] == "error"
    assert final["error"]


def test_api_pipeline_render_preview_conflict(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    import threading
    import time

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    started = threading.Event()
    release = threading.Event()

    def blocking_preview(self, *, rerender=True, progress=None, cancel_check=None):
        started.set()
        release.wait(timeout=5)
        return {"ok": True}

    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.render_preview",
        blocking_preview,
    )

    client = TestClient(create_app())
    first = client.post(
        "/api/pipeline/render-preview",
        json={"path": str(minimal_project)},
    )
    assert first.status_code == 200
    assert started.wait(timeout=2)
    conflict = client.post(
        "/api/pipeline/render-preview",
        json={"path": str(minimal_project)},
    )
    assert conflict.status_code == 409
    release.set()
    for _ in range(50):
        st = client.get("/api/pipeline/status").json()
        if st["job"] and st["job"]["status"] in ("ok", "error"):
            break
        time.sleep(0.05)


def test_pipeline_job_manager_retains_finished_for_get_job(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    import time

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    def fake_preview(self, *, rerender=True, progress=None, cancel_check=None):
        return {"ok": True}

    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.render_preview",
        fake_preview,
    )

    app = create_app()
    client = TestClient(app)
    first = client.post(
        "/api/pipeline/render-preview",
        json={"path": str(minimal_project)},
    )
    job_id = first.json()["job"]["id"]
    for _ in range(50):
        st = client.get("/api/pipeline/status").json()
        if st["job"] and st["job"]["status"] in ("ok", "error"):
            break
        time.sleep(0.05)
    retained = app.state.jobs.get_job(job_id)
    assert retained is not None
    assert retained.status == "ok"
    # Start a second job; first id must still resolve.
    second = client.post(
        "/api/pipeline/render-preview",
        json={"path": str(minimal_project)},
    )
    assert second.status_code == 200
    assert second.json()["job"]["id"] != job_id
    for _ in range(50):
        st = client.get("/api/pipeline/status").json()
        if st["job"] and st["job"]["status"] in ("ok", "error"):
            break
        time.sleep(0.05)
    still = app.state.jobs.get_job(job_id)
    assert still is not None
    assert still.id == job_id
    assert still.status == "ok"
    # SSE for the archived job still works.
    with client.stream("GET", f"/api/pipeline/events?job_id={job_id}") as stream:
        lines = []
        for line in stream.iter_lines():
            if line:
                lines.append(line)
            if any("done" in (ln or "") for ln in lines):
                break
    assert any("done" in (ln or "") for ln in lines)


def test_api_pipeline_run_conflict(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    import threading
    import time

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    started = threading.Event()
    release = threading.Event()

    def blocking_run(self, **kwargs):
        kwargs.get("progress")
        started.set()
        release.wait(timeout=5)
        return PipelineRunResult(last_step="done", steps=[])

    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.run",
        blocking_run,
    )

    client = TestClient(create_app())
    first = client.post(
        "/api/pipeline/run",
        json={"path": str(minimal_project)},
    )
    assert first.status_code == 200
    assert started.wait(timeout=2)

    second = client.post(
        "/api/pipeline/run",
        json={"path": str(minimal_project)},
    )
    assert second.status_code == 409
    release.set()
    for _ in range(50):
        st = client.get("/api/pipeline/status").json()
        if not st["running"]:
            break
        time.sleep(0.05)


def test_api_pipeline_config_and_analyze(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    monkeypatch.setattr(
        "podcast_mcp.services.pipeline_config.suggest_pipeline_tuning",
        lambda project, base_config=None, cancel_check=None: {
            "proposed_config": {"balance": {"dialogue_lufs": -19.0}},
            "patches": {"balance": {"dialogue_lufs": -19.0}},
            "reasons": [{"code": "test", "message": "ok", "track_id": "t1"}],
            "report_summary": {"track_count": 1, "reason_count": 1},
        },
    )

    client = TestClient(create_app())
    path = str(minimal_project)
    res = client.get("/api/pipeline/config", params={"path": path})
    assert res.status_code == 200
    data = res.json()
    assert "steps" in data and "params" in data and "config" in data
    assert data["unattended"] is True

    put = client.put(
        "/api/pipeline/config",
        json={
            "path": path,
            "enabled_steps": [],
        },
    )
    assert put.status_code == 200
    put = client.put(
        "/api/pipeline/config",
        json={
            "path": path,
            "config": {"balance": {"dialogue_lufs": -18.0}},
            "unattended": False,
            "enabled_steps": ["export_deliverables"],
        },
    )
    assert put.status_code == 200
    body = put.json()
    assert body["unattended"] is False
    assert body["config"]["balance"]["dialogue_lufs"] == -18.0
    assert "master_loudness" in body["enabled_steps"]
    assert "export_deliverables" in body["enabled_steps"]

    jobs = client.app.state.jobs

    an = client.post(
        "/api/pipeline/analyze",
        json={"path": path, "apply": True},
    )
    assert an.status_code == 200
    an_body = an.json()
    assert an_body["job"]["kind"] == "analyze"
    an_job = jobs.get_job(an_body["job"]["id"])
    jobs.wait(an_job, timeout=5)
    assert an_job.status == "ok"
    an_result = an_job.snapshot()["result"]
    assert an_result["applied"] is True
    assert an_result["reasons"][0]["code"] == "test"

    preview = client.post(
        "/api/pipeline/analyze",
        json={"path": path, "apply": False},
    )
    assert preview.status_code == 200
    preview_job = jobs.get_job(preview.json()["job"]["id"])
    jobs.wait(preview_job, timeout=5)
    assert preview_job.status == "ok"
    assert preview_job.snapshot()["result"]["applied"] is False


def test_api_pipeline_analyze_job_cancel_and_slot(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    import threading
    import time

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.util.progress import raise_if_cancel_requested

    started = threading.Event()
    release = threading.Event()

    def blocking_suggest(project, *, base_config=None, cancel_check=None):
        started.set()
        release.wait(timeout=5)
        raise_if_cancel_requested(cancel_check, "Analyze cancelled")
        return {
            "proposed_config": {"balance": {"dialogue_lufs": -19.0}},
            "patches": {"balance": {"dialogue_lufs": -19.0}},
            "reasons": [{"code": "test", "message": "ok", "track_id": "t1"}],
            "report_summary": {"track_count": 1, "reason_count": 1},
        }

    monkeypatch.setattr(
        "podcast_mcp.services.pipeline_config.suggest_pipeline_tuning",
        blocking_suggest,
    )

    client = TestClient(create_app())
    path = str(minimal_project)

    an = client.post("/api/pipeline/analyze", json={"path": path, "apply": True})
    assert an.status_code == 200
    job_id = an.json()["job"]["id"]
    assert started.wait(timeout=2)

    run_conflict = client.post("/api/pipeline/run", json={"path": path})
    assert run_conflict.status_code == 409

    analyze_conflict = client.post("/api/pipeline/analyze", json={"path": path, "apply": True})
    assert analyze_conflict.status_code == 409

    cancel_res = client.post("/api/pipeline/cancel", json={"job_id": job_id})
    assert cancel_res.status_code == 200
    release.set()

    jobs = client.app.state.jobs
    job = jobs.get_job(job_id)
    jobs.wait(job, timeout=5)
    assert job.status == "cancelled"
    assert job.snapshot()["message"] == "Analyze cancelled"
    assert job.snapshot()["result"] is None

    cfg = client.get("/api/pipeline/config", params={"path": path}).json()["config"]
    assert cfg["balance"]["dialogue_lufs"] != -19.0

    for _ in range(50):
        st = client.get("/api/pipeline/status").json()
        if not st["running"]:
            break
        time.sleep(0.05)


def test_api_transcript_vocabulary_roundtrip_and_validation(minimal_project) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    path = str(minimal_project)
    initial = client.get("/api/transcript/vocabulary", params={"path": path})
    assert initial.status_code == 200
    assert initial.json()["terms"] == []

    response = client.put(
        "/api/transcript/vocabulary",
        json={
            "path": path,
            "terms": [" Kaczynski ", "Kaczynski"],
            "guest_names": ["Alice"],
            "base_revision": initial.json()["revision"],
        },
    )
    assert response.status_code == 200
    assert response.json()["terms"] == ["Kaczynski"]
    assert response.json()["guest_names"] == ["Alice"]
    assert client.get("/api/transcript/vocabulary", params={"path": path}).json() == response.json()
    assert (minimal_project.parent / "transcript_context.yaml").is_file()

    bad = client.put(
        "/api/transcript/vocabulary",
        json={
            "path": path,
            "terms": [" "],
            "guest_names": [],
            "base_revision": response.json()["revision"],
        },
    )
    assert bad.status_code == 400
    stale = client.put(
        "/api/transcript/vocabulary",
        json={
            "path": path,
            "terms": ["Other"],
            "guest_names": [],
            "base_revision": initial.json()["revision"],
        },
    )
    assert stale.status_code == 409
    current = client.get("/api/transcript/vocabulary", params={"path": path}).json()
    assert current["terms"] == ["Kaczynski"]
    too_many = client.put(
        "/api/transcript/vocabulary",
        json={
            "path": path,
            "terms": [f"t{i}" for i in range(101)],
            "guest_names": [],
            "base_revision": None,
        },
    )
    assert too_many.status_code == 422


def test_api_transcript_vocabulary_busy_lock_is_project_busy_503(
    minimal_project, monkeypatch
) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    from filelock import Timeout

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services import TranscriptPrecorrectService
    from podcast_mcp.util.project_state import TRANSCRIPT_CONTEXT_BUSY_MESSAGE

    def busy(self, **kwargs):
        raise Timeout("/secret/ws/artifacts/transcript_context.yaml.lock")

    monkeypatch.setattr(TranscriptPrecorrectService, "set_vocabulary", busy)
    response = TestClient(create_app()).put(
        "/api/transcript/vocabulary",
        json={
            "path": str(minimal_project),
            "terms": ["Kaczynski"],
            "guest_names": [],
            "base_revision": None,
        },
    )
    assert response.status_code == 503
    assert response.headers["X-Sharecut-Error-Code"] == "project_busy"
    assert response.json() == {"detail": TRANSCRIPT_CONTEXT_BUSY_MESSAGE}
    assert "/artifacts" not in response.text


def test_api_transcript_vocabulary_rejects_unauthorized_remote(
    minimal_project, monkeypatch
) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict")
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", "session-token")
    monkeypatch.setattr("podcast_mcp.gui.routes.deps.peer_host", lambda _request: "10.0.0.5")
    client = TestClient(create_app(bind_host="0.0.0.0"))
    response = client.put(
        "/api/transcript/vocabulary",
        json={
            "path": str(minimal_project),
            "terms": ["Kaczynski"],
            "guest_names": [],
            "base_revision": None,
        },
    )
    assert response.status_code == 403


def test_api_transcript_vocabulary_rejects_relayed_request(minimal_project, monkeypatch) -> None:
    """#393: relay-tunneled traffic never reaches owner routes, even non-strict."""
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services.session_sync.authz import HOST_ROLE_RELAYED_REASON

    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    client = TestClient(create_app())
    response = client.put(
        "/api/transcript/vocabulary",
        json={
            "path": str(minimal_project),
            "terms": ["Kaczynski"],
            "guest_names": [],
            "base_revision": None,
        },
        headers={"X-Sharecut-Relayed": "1"},
    )
    assert response.status_code == 403
    assert response.json() == {"detail": HOST_ROLE_RELAYED_REASON}
    context_path = minimal_project.parent / "artifacts" / "transcript_context.yaml"
    assert not context_path.exists()


def test_api_transcript_refine_waive_records_user_source(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    calls: list[tuple[str, str]] = []

    def waive(self, *, reason: str, source: str = "cli") -> dict[str, str]:
        calls.append((reason, source))
        return {"status": "waived", "reason": reason, "source": source}

    monkeypatch.setattr(
        "podcast_mcp.services.transcript_refine.TranscriptRefineService.waive",
        waive,
    )
    client = TestClient(create_app())
    path = str(minimal_project)

    ok = client.post(
        "/api/transcript/refine/waive",
        json={"path": path, "reason": "Reviewed in host GUI"},
    )
    assert ok.status_code == 200
    assert calls == [("Reviewed in host GUI", "user")]


def test_api_transcript_refine_waive_persists_status(minimal_project) -> None:
    pytest.importorskip("fastapi")
    import json

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    missing = client.post("/api/transcript/refine/waive", json={"path": str(minimal_project)})
    assert missing.status_code == 422
    blank = client.post(
        "/api/transcript/refine/waive",
        json={"path": str(minimal_project), "reason": "  "},
    )
    assert blank.status_code == 400
    assert blank.json() == {"detail": "refine waive requires a non-empty reason"}
    response = client.post(
        "/api/transcript/refine/waive",
        json={"path": str(minimal_project), "reason": "Reviewed in host GUI"},
    )
    assert response.status_code == 200
    status_path = minimal_project.parent / "artifacts" / "transcript_refine_status.json"
    status = json.loads(status_path.read_text(encoding="utf-8"))
    assert status["status"] == "waived"
    assert status["source"] == "user"
    assert status["notes"] == "Reviewed in host GUI"


def test_api_transcript_refine_waive_rejects_unauthorized_remote(
    minimal_project, monkeypatch
) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict")
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", "session-token")
    monkeypatch.setattr("podcast_mcp.gui.routes.deps.peer_host", lambda _request: "10.0.0.5")
    client = TestClient(create_app(bind_host="0.0.0.0"))
    response = client.post(
        "/api/transcript/refine/waive",
        json={"path": str(minimal_project), "reason": "not authorized"},
    )
    assert response.status_code == 403
    assert response.json() == {"detail": "remote client requires PODCAST_SESSION_TOKEN"}


def test_api_document_command_refine_gate_has_stable_error_code(
    minimal_project, monkeypatch
) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.edits.transcript_refine_status import TranscriptRefineRequiredError
    from podcast_mcp.gui.server import create_app

    def reject_for_refine(self, command, **kwargs):
        raise TranscriptRefineRequiredError("Refine the transcript before editing")

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.document.DocumentSyncService.submit",
        reject_for_refine,
    )
    client = TestClient(create_app())
    response = client.post(
        f"/api/document/command?path={minimal_project}",
        json={
            "type": "CorrectTranscriptWord",
            "payload": {"track_id": "host", "word_index": 0, "text": "corrected"},
            "client_id": "viewer",
            "client_seq": 1,
            "role": "viewer",
        },
    )

    assert response.status_code == 409
    assert response.headers["X-Sharecut-Error-Code"] == "transcript_refine_required"
    assert response.json() == {"detail": "Refine the transcript before editing"}


def test_api_pipeline_run_validation_and_cancel(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.run",
        lambda self, **kwargs: PipelineRunResult(last_step="done", steps=[]),
    )
    client = TestClient(create_app())
    path = str(minimal_project)

    assert (
        client.post(
            "/api/pipeline/run",
            json={"path": path, "from_step": "not_a_step"},
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/api/pipeline/run",
            json={"path": path, "only_step": "not_a_step"},
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/api/pipeline/run",
            json={"path": path, "skip_steps": ["not_a_step"]},
        ).status_code
        == 400
    )

    ok = client.post(
        "/api/pipeline/run",
        json={
            "path": path,
            "enabled_steps": ["ingest_tracks"],
            "config": {"balance": {"dialogue_lufs": -17.0}},
            "unattended": True,
        },
    )
    assert ok.status_code == 200

    assert (
        client.post(
            "/api/pipeline/cancel",
            json={"job_id": "missing-job"},
        ).status_code
        == 404
    )

    # Working-set skip_steps path when enabled_steps already stored
    from podcast_mcp.services.pipeline_config import config_store

    # The pipeline slot is single-flight; let the first job finish first.
    _wait_pipeline_idle(client)
    config_store().put(path, enabled_steps=["ingest_tracks"], unattended=True)
    ws_run = client.post(
        "/api/pipeline/run",
        json={"path": path, "use_working_set": True},
    )
    assert ws_run.status_code == 200


def test_api_pipeline_run_passes_unattended(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    import time

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    seen: dict = {}

    def fake_run(self, **kwargs):
        seen.update(kwargs)
        return PipelineRunResult(last_step="done", steps=[])

    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.run",
        fake_run,
    )
    client = TestClient(create_app())
    path = str(minimal_project)
    res = client.post(
        "/api/pipeline/run",
        json={
            "path": path,
            "unattended": True,
            "enabled_steps": ["ingest_tracks", "transcribe_tracks"],
            "use_working_set": False,
            "config": {"balance": {"dialogue_lufs": -17.0}},
        },
    )
    assert res.status_code == 200
    for _ in range(50):
        st = client.get("/api/pipeline/status").json()
        if not st["running"]:
            break
        time.sleep(0.05)
    assert seen.get("unattended") is True
    assert "merge_transcript" in (seen.get("skip_steps") or [])
    assert seen.get("config")["balance"]["dialogue_lufs"] == -17.0
    assert st["job"]["result"] is None


def test_project_meta_helper(minimal_project) -> None:
    from podcast_mcp.gui.jobs import project_meta

    meta = project_meta(minimal_project)
    assert meta["mtime_ns"] > 0
    assert meta["size"] > 0
    assert meta["server_seq"] == 0

    document_db = minimal_project.parent / "artifacts" / "session" / "document.db"
    assert not document_db.exists()


def test_project_meta_omits_server_seq_when_document_db_is_unreadable(
    minimal_project, monkeypatch
) -> None:
    import sqlite3

    from podcast_mcp.gui.jobs import project_meta
    from podcast_mcp.services.document_sync import service as document_service

    def _locked(_path):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(document_service, "_existing_store_at", _locked)
    meta = project_meta(minimal_project)
    assert "server_seq" not in meta
    assert meta["mtime_ns"] > 0 and meta["size"] > 0


def test_project_meta_on_a_corrupt_document_db_omits_server_seq(minimal_project) -> None:
    from podcast_mcp.gui.jobs import project_meta

    db = minimal_project.parent / "artifacts" / "session" / "document.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    db.write_bytes(b"not a sqlite database\x00" * 512)
    assert "server_seq" not in project_meta(minimal_project)


def test_meta_routes_survive_a_symlink_loop_under_artifacts(minimal_project) -> None:
    from podcast_mcp.gui.jobs import project_meta, session_file_meta

    ws = minimal_project.parent
    artifacts = ws / "artifacts"
    if artifacts.exists():
        import shutil

        shutil.rmtree(artifacts)
    artifacts.symlink_to(ws / "artifacts2")
    (ws / "artifacts2").symlink_to(artifacts)
    assert session_file_meta(minimal_project)["exists"] is False
    assert project_meta(minimal_project)["mtime_ns"] > 0


def test_resolve_viewer_audio_premix(tmp_path) -> None:
    from podcast_mcp.gui.audio import resolve_viewer_audio, resolve_viewer_transport
    from podcast_mcp.services import ProjectWorkspace

    ws = ProjectWorkspace.create(tmp_path, name="a")
    premix = ws.project.artifacts_dir() / "premix.wav"
    premix.parent.mkdir(parents=True, exist_ok=True)
    premix.write_bytes(b"RIFF....")
    path = resolve_viewer_audio(ws, kind="premix")
    assert path == premix.resolve()
    assert resolve_viewer_transport(ws, kind="premix").render_busy is False


def test_resolve_viewer_audio_missing_premix(tmp_path) -> None:
    from podcast_mcp.gui.audio import resolve_viewer_audio
    from podcast_mcp.services import ProjectWorkspace

    ws = ProjectWorkspace.create(tmp_path, name="a")
    with pytest.raises(FileNotFoundError):
        resolve_viewer_audio(ws, kind="premix")


def test_api_audio_premix_fixture() -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    fixture = _fixture_project()
    from podcast_mcp.models import load_project

    project = load_project(fixture)
    premix = project.artifacts_dir() / "premix.wav"
    if not premix.is_file():
        pytest.skip("aligned_dialogue premix missing")
    client = TestClient(create_app())
    res = client.get(
        "/api/audio",
        params={"path": str(fixture), "kind": "premix"},
    )
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("audio/")
    assert len(res.content) > 44


def test_api_audio_bad_kind(minimal_project) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    res = client.get(
        "/api/audio",
        params={"path": str(minimal_project), "kind": "nope"},
    )
    assert res.status_code == 400


def test_api_history_diff_empty(minimal_project) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    res = client.get("/api/history/diff", params={"path": str(minimal_project)})
    assert res.status_code == 200
    assert res.json()["diff"] == {}


def test_api_history_diff_bad_index(minimal_project) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services import ProjectWorkspace

    ws = ProjectWorkspace.open(minimal_project)
    ws.record_snapshot("one", force=True)
    client = TestClient(create_app())
    res = client.get(
        "/api/history/diff",
        params={"path": str(minimal_project), "from_index": 0, "to_index": 99},
    )
    assert res.status_code == 400


def test_api_project_not_found() -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    res = client.get("/api/project", params={"path": "/no/such/project.json"})
    assert res.status_code == 404


def test_cli_gui_help() -> None:
    import os

    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app

    runner = CliRunner()
    env = {**os.environ, "NO_COLOR": "1", "TERM": "dumb", "COLUMNS": "200"}
    result = runner.invoke(app, ["gui", "--help"], env=env, color=False)
    assert result.exit_code == 0
    text = (result.stdout or "") + (result.output or "")
    # Rich may wrap; accept either the flag or the option name in help text.
    assert "--project" in text or "project" in text.lower()


def test_cli_gui_missing_project(tmp_path) -> None:
    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app

    runner = CliRunner()
    result = runner.invoke(
        app,
        ["gui", "--project", str(tmp_path / "missing.json"), "--no-open"],
    )
    assert result.exit_code == 1


def test_cli_gui_dev_mode(minimal_project) -> None:
    from unittest.mock import patch

    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app

    runner = CliRunner()
    with patch("podcast_mcp.gui.bind.run_gui_server") as run:
        result = runner.invoke(
            app,
            [
                "gui",
                "--project",
                str(minimal_project),
                "--dev",
                "--no-open",
                "--port",
                "9876",
            ],
        )
    assert result.exit_code == 0
    run.assert_called_once()
    assert "Dev mode" in result.stdout


def test_cli_gui_opens_browser(minimal_project) -> None:
    from unittest.mock import patch

    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app

    runner = CliRunner()
    with patch("podcast_mcp.gui.bind.run_gui_server"), patch("webbrowser.open") as open_browser:
        result = runner.invoke(
            app,
            ["gui", "--project", str(minimal_project)],
        )
    assert result.exit_code == 0
    open_browser.assert_called_once()
    assert "Viewer:" in result.stdout


def test_cli_gui_missing_uvicorn(minimal_project) -> None:
    from unittest.mock import patch

    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app

    runner = CliRunner()
    with patch("podcast_mcp.gui.bind.gui_server_deps_available", return_value=False):
        result = runner.invoke(
            app,
            ["gui", "--project", str(minimal_project), "--no-open"],
        )
    assert result.exit_code == 1
    assert "GUI dependencies missing" in result.stdout or "GUI dependencies missing" in (
        result.stderr or ""
    )


def test_cli_gui_background_requires_project() -> None:
    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app

    result = CliRunner().invoke(app, ["gui", "--background", "--no-open"])
    assert result.exit_code == 1
    assert "--background requires --project" in (result.stdout + (result.stderr or ""))


def test_cli_gui_background_delegates(minimal_project) -> None:
    from unittest.mock import patch

    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app
    from podcast_mcp.services.gui_launch import GuiLaunchResult

    launched = GuiLaunchResult(
        ok=True,
        url="http://127.0.0.1:8765/",
        host="127.0.0.1",
        port=8765,
        project_path=str(minimal_project),
        already_running=False,
        opened_browser=False,
    )
    with patch("podcast_mcp.cli.gui.ensure_viewer", return_value=launched):
        result = CliRunner().invoke(
            app,
            ["gui", "--background", "--project", str(minimal_project), "--no-open"],
        )
    assert result.exit_code == 0
    assert launched.to_json() in result.stdout


def test_cli_gui_home_on_loopback() -> None:
    from unittest.mock import patch

    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app

    runner = CliRunner()
    with patch("podcast_mcp.gui.bind.run_gui_server"):
        result = runner.invoke(app, ["gui", "--no-open"])
    assert result.exit_code == 0
    assert "Viewer: http://127.0.0.1:8765/" in result.stdout


def test_cli_gui_home_rejects_non_loopback() -> None:
    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app

    result = CliRunner().invoke(app, ["gui", "--host", "0.0.0.0", "--no-open"])
    assert result.exit_code == 1
    assert "loopback" in (result.stdout + (result.stderr or "")).lower()


def test_cli_gui_home_with_session_token() -> None:
    from unittest.mock import patch

    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app

    runner = CliRunner()
    with (
        patch("podcast_mcp.gui.bind.run_gui_server"),
        patch(
            "podcast_mcp.gui.routes.deps.ensure_non_loopback_session_auth",
            return_value="tok",
        ),
    ):
        result = runner.invoke(app, ["gui", "--no-open"])
    assert result.exit_code == 0
    assert "session_token=tok" in result.stdout


def test_cli_gui_returns_when_subcommand_set() -> None:
    from types import SimpleNamespace

    from podcast_mcp.cli.gui import gui_cmd

    gui_cmd(
        SimpleNamespace(invoked_subcommand="other"),
        project=None,
        port=8765,
        host="127.0.0.1",
        no_open=True,
        background=False,
        dev=False,
    )


def test_cli_gui_non_loopback_session_token(minimal_project) -> None:
    from unittest.mock import patch

    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app

    runner = CliRunner()
    with (
        patch("podcast_mcp.gui.bind.run_gui_server"),
        patch(
            "podcast_mcp.gui.routes.deps.ensure_non_loopback_session_auth",
            return_value="tok",
        ),
    ):
        result = runner.invoke(
            app,
            ["gui", "--project", str(minimal_project), "--no-open"],
        )
    assert result.exit_code == 0
    assert "session_token" in (result.stdout + (result.stderr or ""))


def test_build_project_view_aligned_fixture() -> None:
    from pathlib import Path

    from podcast_mcp.gui.assembler import build_project_view

    fixture = (
        Path(__file__).resolve().parents[0]
        / "fixtures"
        / "aligned_dialogue"
        / "episode.project.json"
    )
    if not fixture.is_file():
        pytest.skip("aligned_dialogue fixture missing")
    view = build_project_view(fixture)
    assert len(view.tracks) >= 1
    assert view.clips["clip_count"] >= 1


def test_build_project_view_with_track_and_transcript(minimal_project) -> None:
    from podcast_mcp.gui.assembler import build_project_view
    from podcast_mcp.models import (
        Clip,
        CombinedTranscript,
        CombinedUtterance,
        MediaAsset,
        Track,
        TrackRole,
        Transcript,
        TranscriptWord,
        load_project,
        save_project,
    )

    project = load_project(minimal_project)
    project.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=1.0,
                text="hello",
            )
        ]
    )
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="hello", start=0.0, end=0.5)],
        )
    ]
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    ]
    save_project(project, minimal_project)
    view = build_project_view(minimal_project)
    assert len(view.tracks) == 1
    assert view.tracks[0].has_source_audio is True
    assert view.transcript is not None
    utt = view.transcript["utterances"][0]
    assert utt["text"] == "hello"
    assert utt["mappable"] is True
    assert utt["timeline_start"] == pytest.approx(0.0)
    assert utt["timeline_end"] == pytest.approx(1.0)
    assert view.social_clips == []


def test_track_view_reports_source_presence_without_duration(minimal_project) -> None:
    from podcast_mcp.gui.assembler import build_project_view
    from podcast_mcp.models import MediaAsset, Track, TrackRole, load_project, save_project

    project = load_project(minimal_project)
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        ),
        Track(id="empty", label="Empty", role=TrackRole.DIALOGUE),
    ]
    save_project(project, minimal_project)

    tracks = build_project_view(minimal_project).tracks
    assert tracks[0].duration_sec is None
    assert tracks[0].has_source_audio is True
    assert tracks[1].duration_sec is None
    assert tracks[1].has_source_audio is False


def test_build_project_view_transcripts_without_combined(minimal_project) -> None:
    from unittest.mock import patch

    from podcast_mcp.gui.assembler import build_project_view
    from podcast_mcp.models import (
        MediaAsset,
        Track,
        TrackRole,
        Transcript,
        TranscriptWord,
        load_project,
        save_project,
    )

    project = load_project(minimal_project)
    project.combined_transcript = None
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="hi", start=0.0, end=0.2)],
        )
    ]
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    save_project(project, minimal_project)
    with patch(
        "podcast_mcp.gui.assembler.TranscriptService.get",
        return_value='{"utterances": []}',
    ):
        view = build_project_view(minimal_project)
    assert view.transcript == {"utterances": []}


def test_build_project_view_minimal(minimal_project) -> None:
    from podcast_mcp.gui.assembler import build_project_view

    view = build_project_view(minimal_project)
    assert view.meta["name"]
    assert isinstance(view.tracks, list)
    assert "tracks" in view.clips
    assert view.timeline_duration_sec >= 0


def test_create_app_serves_index_when_dist_exists() -> None:
    pytest.importorskip("fastapi")
    from pathlib import Path

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    dist = Path(__file__).resolve().parents[1] / "gui" / "web" / "dist"
    if not (dist / "index.html").is_file():
        pytest.skip("gui/web/dist not built")
    client = TestClient(create_app(static_dir=dist))
    res = client.get("/")
    assert res.status_code == 200


def _recovery_static_root(tmp_path):
    """Minimal public files needed by recovery-page server tests."""
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><title>Studio</title>")
    public = Path(__file__).resolve().parents[1] / "gui" / "web" / "public"
    for name in ("recovery.css", "brand-tokens.css"):
        (dist / name).write_text((public / name).read_text(encoding="utf-8"))
    return dist


def test_index_project_mismatch_returns_recovery_page(minimal_project, tmp_path) -> None:
    """Browser navigation to a non-served ?project= gets a friendly HTML page."""
    pytest.importorskip("fastapi")
    from urllib.parse import urlencode

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    other = minimal_project.parent / "other" / "episode.project.json"
    client = TestClient(
        create_app(static_dir=_recovery_static_root(tmp_path), served_project=minimal_project)
    )
    res = client.get(
        "/",
        params={"project": str(other)},
        headers={"Accept": "text/html"},
    )
    assert res.status_code == 403
    assert "text/html" in res.headers["content-type"]
    assert "isn&rsquo;t served by this server" in res.text
    assert "Choose a different project" in res.text
    assert f"/?{urlencode({'project': str(minimal_project)})}" in res.text
    assert 'href="/?home=1"' in res.text


def test_index_project_mismatch_keeps_json_for_non_html_accept(minimal_project, tmp_path) -> None:
    """The mismatched index URL keeps its JSON 403 API boundary."""
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    other = minimal_project.parent / "other" / "episode.project.json"
    client = TestClient(
        create_app(static_dir=_recovery_static_root(tmp_path), served_project=minimal_project)
    )
    res = client.get(
        "/",
        params={"project": str(other)},
        headers={"Accept": "application/json"},
    )
    assert res.status_code == 403
    assert res.json() == {"detail": "project path not allowed for this server instance"}


def test_index_project_mismatch_requires_remote_token_and_preserves_it(
    minimal_project, monkeypatch, tmp_path
) -> None:
    """Strict remote recovery never discloses metadata before authentication."""
    pytest.importorskip("fastapi")
    from urllib.parse import urlencode

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict")
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", "recovery-token")
    other = minimal_project.parent / "other" / "episode.project.json"
    client = TestClient(
        create_app(
            static_dir=_recovery_static_root(tmp_path),
            served_project=minimal_project,
            bind_host="0.0.0.0",
        )
    )
    denied = client.get(
        "/",
        params={"project": str(other)},
        headers={"Accept": "text/html"},
    )
    assert denied.status_code == 403
    assert denied.json() == {"detail": "remote client requires PODCAST_SESSION_TOKEN"}
    assert minimal_project.name not in denied.text

    res = client.get(
        "/",
        params={"project": str(other), "session_token": "recovery-token", "ignored": "no"},
        headers={"Accept": "text/html"},
    )
    assert res.status_code == 403
    open_query = urlencode({"project": str(minimal_project), "session_token": "recovery-token"})
    assert f'href="/?{open_query}"' in res.text
    assert 'href="/?home=1&session_token=recovery-token"' in res.text
    assert "ignored=no" not in res.text


def test_index_project_mismatch_refuses_relayed_request(
    minimal_project, monkeypatch, tmp_path
) -> None:
    """Relay-tunneled traffic never gets the owner recovery page (#393)."""
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services.session_sync.authz import HOST_ROLE_RELAYED_REASON

    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    other = minimal_project.parent / "other" / "episode.project.json"
    client = TestClient(
        create_app(static_dir=_recovery_static_root(tmp_path), served_project=minimal_project)
    )
    res = client.get(
        "/",
        params={"project": str(other)},
        headers={"Accept": "text/html", "X-Sharecut-Relayed": "1"},
    )
    assert res.status_code == 403
    assert res.json() == {"detail": HOST_ROLE_RELAYED_REASON}
    assert str(minimal_project) not in res.text
    assert str(minimal_project.parent) not in res.text


def test_index_served_project_param_serves_app(minimal_project, tmp_path) -> None:
    """?project= matching served_project still boots the app."""
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(
        create_app(static_dir=_recovery_static_root(tmp_path), served_project=minimal_project)
    )
    res = client.get("/", params={"project": str(minimal_project)})
    assert res.status_code == 200
    assert "text/html" in res.headers["content-type"]
    res = client.get("/")
    assert res.status_code == 200


def _root_client(tmp_path, served):
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    return TestClient(create_app(static_dir=_recovery_static_root(tmp_path), served_project=served))


def test_index_bare_root_redirects_to_pinned_project(minimal_project, tmp_path) -> None:
    from urllib.parse import parse_qs, urljoin, urlsplit

    served = Path(minimal_project).resolve()
    client = _root_client(tmp_path, minimal_project)
    res = client.get("/", params={"theme": "dark"}, follow_redirects=False)
    assert res.status_code == 307
    location = res.headers["location"]
    assert location.startswith("?")
    parts = urlsplit(urljoin("http://testserver/", location))
    assert parts.path == "/"
    assert parse_qs(parts.query) == {"theme": ["dark"], "project": [str(minimal_project)]}
    assert Path(client.app.state.served_project).resolve() == served
    assert "no-store" in res.headers["cache-control"]


def test_index_bare_root_redirect_keeps_a_mount_prefix(minimal_project, tmp_path) -> None:
    pytest.importorskip("fastapi")
    from urllib.parse import parse_qs, urljoin, urlsplit

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    outer = FastAPI()
    outer.mount(
        "/studio",
        create_app(static_dir=_recovery_static_root(tmp_path), served_project=minimal_project),
    )
    client = TestClient(outer)
    res = client.get("/studio/", params={"theme": "dark"}, follow_redirects=False)
    assert res.status_code == 307
    location = res.headers["location"]
    assert location.startswith("?")
    parts = urlsplit(urljoin("http://testserver/studio/", location))
    assert parts.path == "/studio/"
    assert parse_qs(parts.query) == {"theme": ["dark"], "project": [str(minimal_project)]}


def test_index_bare_root_redirect_keeps_the_desktop_close_guard(minimal_project, tmp_path) -> None:
    from urllib.parse import parse_qs, urlsplit

    client = _root_client(tmp_path, minimal_project)
    res = client.get("/", params={"sc_close_guard": "host"}, follow_redirects=False)
    assert res.status_code == 307
    query = parse_qs(urlsplit(res.headers["location"]).query)
    assert query["sc_close_guard"] == ["host"]
    assert query["project"] == [str(minimal_project)]


def test_index_home_param_skips_pinned_redirect(minimal_project, tmp_path) -> None:
    client = _root_client(tmp_path, minimal_project)
    res = client.get("/", params={"home": "1"}, follow_redirects=False)
    assert res.status_code == 200
    assert "text/html" in res.headers["content-type"]
    assert "location" not in res.headers
    res = client.get("/", params={"review": "tok"}, follow_redirects=False)
    assert res.status_code == 200


def test_recovery_home_link_keeps_the_pin(minimal_project, tmp_path) -> None:
    """The recovery page's home link shows home and never unpins (#533)."""
    served = Path(minimal_project).resolve()
    client = _root_client(tmp_path, minimal_project)
    other = minimal_project.parent / "other" / "episode.project.json"
    page = client.get(
        "/",
        params={"project": str(other)},
        headers={"Accept": "text/html"},
        follow_redirects=False,
    )
    assert page.status_code == 403
    assert 'href="/?home=1"' in page.text
    home = client.get("/", params={"home": "1"}, follow_redirects=False)
    assert home.status_code == 200
    assert Path(client.app.state.served_project).resolve() == served
    assert client.get("/", follow_redirects=False).status_code == 307


def test_home_query_param_matches_the_gui() -> None:
    """The web client's /?home=1 must be the flag the pinned-root redirect skips."""
    pytest.importorskip("fastapi")
    import re

    from podcast_mcp.gui.server import HOME_QUERY_PARAM

    ts = (
        Path(__file__).resolve().parents[1] / "gui" / "web" / "src" / "utils" / "projectUrl.ts"
    ).read_text(encoding="utf-8")
    match = re.search(r'export const HOME_QUERY_PARAM = "(\w+)";', ts)
    assert match
    assert match.group(1) == HOME_QUERY_PARAM


def test_index_bare_root_redirect_refuses_relayed_request(minimal_project, tmp_path) -> None:
    client = _root_client(tmp_path, minimal_project)
    res = client.get("/", headers={"X-Sharecut-Relayed": "1"}, follow_redirects=False)
    assert res.status_code != 307
    assert str(minimal_project) not in res.headers.get("location", "")


def test_index_bare_root_skips_redirect_when_pinned_file_is_gone(tmp_path) -> None:
    client = _root_client(tmp_path, tmp_path / "gone" / "episode.project.json")
    res = client.get("/", follow_redirects=False)
    assert res.status_code == 200


def test_index_bare_root_without_pin_serves_home(tmp_path) -> None:
    client = _root_client(tmp_path, None)
    res = client.get("/", follow_redirects=False)
    assert res.status_code == 200
    assert "location" not in res.headers


def test_api_project_mismatch_still_json_403(minimal_project, tmp_path) -> None:
    """API clients keep getting JSON 403 for non-served projects."""
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    other = tmp_path / "other" / "episode.project.json"
    other.parent.mkdir(parents=True)
    other.write_text(minimal_project.read_text())
    client = TestClient(create_app(served_project=minimal_project))
    res = client.get("/api/project/meta", params={"path": str(other)})
    assert res.status_code == 403
    assert res.json() == {"detail": "project path not allowed for this server instance"}


def test_recovery_css_served_from_dist(tmp_path) -> None:
    """The recovery page stylesheet is served from dist."""
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app(static_dir=_recovery_static_root(tmp_path)))
    res = client.get("/recovery.css")
    assert res.status_code == 200
    assert "text/css" in res.headers["content-type"]
    assert ".recovery-page" in res.text
    tokens = client.get("/brand-tokens.css")
    assert tokens.status_code == 200
    assert "--color-bg-canvas" in tokens.text


def test_favicon_svg_served_from_dist() -> None:
    pytest.importorskip("fastapi")
    from pathlib import Path

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    dist = Path(__file__).resolve().parents[1] / "gui" / "web" / "dist"
    if not (dist / "favicon.svg").is_file():
        pytest.skip("gui/web/dist favicon.svg missing")
    client = TestClient(create_app(static_dir=dist))
    res = client.get("/favicon.svg")
    assert res.status_code == 200
    assert "image/svg" in res.headers.get("content-type", "")


def test_assets_have_immutable_cache_control() -> None:
    pytest.importorskip("fastapi")
    from pathlib import Path

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    dist = Path(__file__).resolve().parents[1] / "gui" / "web" / "dist"
    assets = dist / "assets"
    if not assets.is_dir():
        pytest.skip("gui/web/dist assets missing")
    sample = next(assets.glob("*.js"), None)
    if sample is None:
        pytest.skip("no hashed js assets")
    client = TestClient(create_app(static_dir=dist))
    res = client.get(f"/assets/{sample.name}")
    assert res.status_code == 200
    assert "immutable" in res.headers.get("cache-control", "")


def test_host_index_injects_meta_when_served_project(minimal_project, tmp_path) -> None:
    pytest.importorskip("fastapi")
    from pathlib import Path

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.models import load_project, save_project

    dist = Path(__file__).resolve().parents[1] / "gui" / "web" / "dist"
    if not (dist / "index.html").is_file():
        pytest.skip("gui/web/dist not built")
    proj = load_project(minimal_project)
    proj.meta.name = "Host Meta Episode"
    save_project(proj, minimal_project)
    client = TestClient(create_app(static_dir=dist, served_project=Path(minimal_project)))
    res = client.get("/")
    assert res.status_code == 200
    assert "Host Meta Episode" in res.text
    assert 'name="description"' in res.text
    assert "no-cache" in res.headers.get("cache-control", "")


def test_gui_package_create_app() -> None:
    pytest.importorskip("fastapi")
    from podcast_mcp.gui import create_app

    app = create_app()
    assert app.title == "Podcast MCP Viewer"


def test_api_transcript_vocabulary_busy_lock_returns_503(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    from filelock import Timeout

    from podcast_mcp.gui.server import create_app

    def busy(self, **_kwargs):
        raise Timeout("transcript_context.yaml.lock")

    monkeypatch.setattr(
        "podcast_mcp.services.transcript_precorrect.TranscriptPrecorrectService.set_vocabulary",
        busy,
    )
    client = TestClient(create_app())
    response = client.put(
        "/api/transcript/vocabulary",
        json={
            "path": str(minimal_project),
            "terms": ["A"],
            "guest_names": [],
            "base_revision": None,
        },
    )
    assert response.status_code == 503


def test_api_pipeline_run_force_transcribe_is_run_only(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    import time

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services.pipeline_config import config_store

    seen: list[dict | None] = []

    def fake_run(self, **kwargs):
        seen.append(kwargs.get("config"))
        return PipelineRunResult(last_step="done", steps=[])

    monkeypatch.setattr("podcast_mcp.services.pipeline.PipelineService.run", fake_run)
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.pipeline.ensure_whisper_cached_for_run", lambda **_: None
    )
    client = TestClient(create_app())
    res = client.post(
        "/api/pipeline/run",
        json={"path": str(minimal_project), "force_transcribe": True, "overwrite_edited": True},
    )
    assert res.status_code == 200
    for _ in range(100):
        if not client.get("/api/pipeline/status").json()["running"]:
            break
        time.sleep(0.05)
    assert seen and seen[0]["transcribe"]["overwrite"] is True
    assert seen[0]["transcribe"]["overwrite_edited"] is True
    working = config_store().get(Path(str(minimal_project)))
    persisted = ((working.config or {}).get("transcribe") or {}) if working else {}
    assert not persisted.get("overwrite")
    assert not persisted.get("overwrite_edited")


def test_api_pipeline_run_retime_words_is_run_only(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    import time

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services.pipeline_config import config_store

    seen: list[dict | None] = []

    def fake_run(self, **kwargs):
        seen.append(kwargs.get("config"))
        return PipelineRunResult(last_step="done", steps=[])

    monkeypatch.setattr("podcast_mcp.services.pipeline.PipelineService.run", fake_run)
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.pipeline.ensure_whisper_cached_for_run", lambda **_: None
    )
    client = TestClient(create_app())
    res = client.post(
        "/api/pipeline/run",
        json={"path": str(minimal_project), "retime_words": True, "overwrite_edited": True},
    )
    assert res.status_code == 200
    for _ in range(100):
        if not client.get("/api/pipeline/status").json()["running"]:
            break
        time.sleep(0.05)
    assert seen and seen[0]["transcribe"]["retime_words"] is True
    assert seen[0]["transcribe"]["forced_alignment"]["enabled"] is True
    assert seen[0]["transcribe"]["overwrite_edited"] is True
    working = config_store().get(Path(str(minimal_project)))
    persisted = ((working.config or {}).get("transcribe") or {}) if working else {}
    assert not persisted.get("retime_words")
    assert not persisted.get("overwrite_edited")


def test_api_pipeline_run_rejects_force_with_retime_words(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    seen: list[dict | None] = []

    def fake_run(self, **kwargs):
        seen.append(kwargs.get("config"))
        return PipelineRunResult(last_step="done", steps=[])

    monkeypatch.setattr("podcast_mcp.services.pipeline.PipelineService.run", fake_run)
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.pipeline.ensure_whisper_cached_for_run", lambda **_: None
    )
    client = TestClient(create_app())
    res = client.post(
        "/api/pipeline/run",
        json={
            "path": str(minimal_project),
            "retime_words": True,
            "force_transcribe": True,
        },
    )
    assert res.status_code == 400
    assert seen == []

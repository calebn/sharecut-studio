from __future__ import annotations

from podcast_mcp.edits.focus import (
    _episode_duration,
    _has_hook,
    _word_jaccard,
    apply_focus_decisions,
    build_focus_outline,
    format_focus_outline_markdown,
    macro_focus_segments,
    propose_focus_cuts,
    write_focus_outline,
)
from podcast_mcp.models import (
    CombinedTranscript,
    CombinedUtterance,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    Transcript,
    TranscriptWord,
)


def _project_with_repeated_utterances() -> EpisodeProject:
    text = (
        "we need to organize our community and build power together "
        "for immigration justice and safety for everyone"
    )
    p = EpisodeProject.create("focus", "/tmp/ws")
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text=w, start=i * 0.4, end=i * 0.4 + 0.3)
                for i, w in enumerate(text.split())
            ],
        )
    ]
    p.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=20.0,
                text=text,
            ),
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=40.0,
                end=60.0,
                text=text,
            ),
        ]
    )
    return p


def test_macro_focus_segments_merge_same_speaker():
    utts = [
        CombinedUtterance(
            track_id="host",
            speaker="Host",
            start=0.0,
            end=2.0,
            text="hello there",
        ),
        CombinedUtterance(
            track_id="host",
            speaker="Host",
            start=2.5,
            end=5.0,
            text="how are you",
        ),
        CombinedUtterance(
            track_id="guest",
            speaker="Guest",
            start=6.0,
            end=10.0,
            text="doing fine",
        ),
    ]
    segs = macro_focus_segments(utts, merge_gap_sec=2.5)
    assert len(segs) == 2
    assert segs[0].track_id == "host"
    assert segs[0].duration_sec == 5.0
    assert "hello" in segs[0].text and "how are you" in segs[0].text


def test_build_focus_outline_whole_episode():
    project = _project_with_repeated_utterances()
    outline = build_focus_outline(
        project,
        {"focus": {"segment_merge_gap_sec": 2.5}},
    )
    assert outline["segment_count"] == 2
    assert len(outline["segments"]) == 2
    assert outline["segments"][0]["text"]


def test_propose_focus_disabled_by_default():
    project = _project_with_repeated_utterances()
    decisions = propose_focus_cuts(project, {"focus": {"enabled": False}})
    assert decisions == []
    assert project.edit_decisions == []


def test_propose_focus_repeat_segment():
    project = _project_with_repeated_utterances()
    defaults = {
        "focus": {
            "enabled": True,
            "review_required": True,
            "min_segment_sec": 10,
            "max_remove_pct": 1.0,
        }
    }
    decisions = propose_focus_cuts(project, defaults)
    assert len(decisions) == 1
    assert decisions[0].reason.startswith("focus:repeat")
    assert decisions[0].review_required is True


def test_format_and_write_focus_outline(tmp_path):
    project = _project_with_repeated_utterances()
    project.workspace_dir = str(tmp_path)
    outline = build_focus_outline(project, {"focus": {"segment_merge_gap_sec": 2.5}})
    md = format_focus_outline_markdown(outline)
    assert "# Focus outline" in md
    assert "Segments:" in md
    path = write_focus_outline(project, {"focus": {"segment_merge_gap_sec": 2.5}})
    assert path.is_file()
    assert (tmp_path / "artifacts" / "focus_outline.json").is_file()


def test_propose_focus_long_drift_segment():
    long_text = " ".join(["detail"] * 80)
    project = EpisodeProject.create("focus", "/tmp/ws")
    from podcast_mcp.models import MediaAsset, Track, TrackRole

    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=600.0),
        )
    ]
    project.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=120.0,
                end=240.0,
                text=long_text,
            )
        ]
    )
    defaults = {
        "focus": {
            "enabled": True,
            "min_segment_sec": 15,
            "long_segment_sec": 90,
            "max_remove_pct": 1.0,
            "max_candidates": 5,
        }
    }
    decisions = propose_focus_cuts(project, defaults)
    assert any("focus:long_drift" in (d.reason or "") for d in decisions)


def test_focus_helpers_and_empty_segments():
    assert _word_jaccard("", "hello") == 0.0
    assert _word_jaccard("hello world", "hello earth") > 0
    assert _has_hook("What if we started here?") is True
    project = EpisodeProject.create("focus", "/tmp/ws")
    assert _episode_duration(project, segments=[]) == 0.0
    project.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=12.0,
                text="short",
            )
        ]
    )
    assert _episode_duration(project) == 12.0
    empty = EpisodeProject.create("empty", "/tmp/ws")
    empty.combined_transcript = CombinedTranscript(utterances=[])
    assert propose_focus_cuts(empty, {"focus": {"enabled": True}}) == []


def test_propose_focus_respects_max_candidates():
    project = _project_with_repeated_utterances()
    for i in range(5):
        project.combined_transcript.utterances.append(
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=80.0 + i * 50,
                end=120.0 + i * 50,
                text=(
                    "we need to organize our community and build power together "
                    "for immigration justice and safety for everyone"
                ),
            )
        )
    defaults = {
        "focus": {
            "enabled": True,
            "min_segment_sec": 10,
            "max_candidates": 1,
            "max_remove_pct": 1.0,
        }
    }
    decisions = propose_focus_cuts(project, defaults)
    assert len(decisions) <= 1


def test_apply_focus_skips_review_required():
    project = EpisodeProject.create("focus", "/tmp/ws")
    project.edit_decisions = [
        EditDecision(
            id="pending",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.0,
            end=2.0,
            reason="focus:repeat",
            review_required=True,
        )
    ]
    assert apply_focus_decisions(project) == 0
    assert len(project.edit_decisions) == 1

"""Transcript view of a lane recorded as two takes: each row plays only where its take does."""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.gui.mapper import map_transcript_utterances_to_timeline
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)


def _words(prefix: str, starts: list[float], **kw: object) -> list[TranscriptWord]:
    return [
        TranscriptWord(text=f"{prefix}{n}", start=s, end=s + 0.4, confidence=0.9, **kw)
        for n, s in enumerate(starts)
    ]


def _two_take_project(tmp_path: Path) -> EpisodeProject:
    """Take 2 plays at 0-10 s from its own 0-10 s; take 3 at 10-30 s from its own 0-20 s."""
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id=tid, label=tid, role=TrackRole.DIALOGUE, speaker=tid) for tid in ("vicky", "dani")
    ]
    project.clips = [
        Clip(
            id="c2",
            track_id="vicky",
            source_id="take2",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        ),
        Clip(
            id="c3",
            track_id="vicky",
            source_id="take3",
            source_start=0.0,
            source_end=20.0,
            timeline_start=10.0,
        ),
        Clip(id="cd", track_id="dani", source_start=0.0, source_end=30.0, timeline_start=0.0),
    ]
    project.transcripts = [
        Transcript(track_id="vicky", source_id="take2", words=_words("a", [1.0, 4.5])),
        Transcript(
            track_id="vicky", source_id="take3", words=_words("b", [1.0, 4.5, 8.0, 12.0, 18.0])
        ),
        Transcript(track_id="dani", words=_words("d", [16.0])),
    ]
    project.combined_transcript = TranscriptionEngine(defaults=load_defaults()).merge_transcripts(
        project
    )
    return project


def _view(project: EpisodeProject, *, include_words: bool = True) -> list[dict]:
    assert project.combined_transcript is not None
    mapped = map_transcript_utterances_to_timeline(
        project, project.combined_transcript.model_dump(), include_words=include_words
    )
    assert mapped is not None
    return mapped["utterances"]


def test_each_take_row_maps_only_through_its_own_clips(tmp_path: Path) -> None:
    rows = _view(_two_take_project(tmp_path))
    spans = {row["text"]: [(s["start"], s["end"]) for s in row["timeline_spans"]] for row in rows}
    # Before: a0 also lit up at 11 s (take 3's clip plays source 1 s there), b0 at 1 s.
    assert spans["a0"] == [(1.0, 1.4)]
    assert spans["b0"] == [(11.0, 11.4)]
    assert spans["b3"] == [(22.0, 22.4)]


def test_take_rows_carry_their_own_words(tmp_path: Path) -> None:
    rows = _view(_two_take_project(tmp_path))
    by_text = {row["text"]: row for row in rows}
    # Before: take 3's rows listed take 2's words, and rows past take 2's last word none.
    for text in ("a0", "a1", "b0", "b1", "b2", "b3", "b4"):
        words = by_text[text]["words"]
        assert [w["text"] for w in words] == [text]
        source_id = "take2" if text.startswith("a") else "take3"
        assert words[0]["timing_target"]["source_id"] == source_id
    assert by_text["b4"]["words"][0]["timeline_start"] == 28.0


def test_each_take_words_are_addressable_by_source_and_index(tmp_path: Path) -> None:
    rows = _view(_two_take_project(tmp_path))
    by_text = {row["text"]: row for row in rows}
    assert by_text["a1"]["words"][0]["word_index"] == 1
    word = by_text["b1"]["words"][0]
    assert word["word_index"] == 1
    assert word["timing_target"] == {"track_id": "vicky", "source_id": "take3", "word_index": 1}


def test_suppressed_only_second_take_keeps_source_identity_and_deleted_placement(
    tmp_path: Path,
) -> None:
    project = _two_take_project(tmp_path)
    take3 = project.transcripts[1]
    take3.words = [word.model_copy(update={"suppressed": True}) for word in take3.words]
    project.combined_transcript = TranscriptionEngine(defaults=load_defaults()).merge_transcripts(
        project
    )

    rows = _view(project)
    suppressed = [row for row in rows if row.get("suppressed_only")]
    assert suppressed
    assert all(row["source_id"] == "take3" for row in suppressed)
    assert all(row["words"][0]["timing_target"]["source_id"] == "take3" for row in suppressed)

    project.clips = [clip for clip in project.clips if clip.id != "c3"]
    rows = _view(project)
    suppressed = [row for row in rows if row.get("suppressed_only")]
    assert suppressed
    assert all(row["mappable"] is False for row in suppressed)
    assert all(row["words"][0]["word_index"] is not None for row in suppressed)


def test_rows_run_in_playback_order(tmp_path: Path) -> None:
    project = _two_take_project(tmp_path)
    for include_words in (True, False):
        rows = _view(project, include_words=include_words)
        # Before: source order put take 3 (source clock from 0) among take 2's rows and
        # Dani's 16 s row before take 3's 22 s row only by accident of source time.
        assert [row["text"] for row in rows] == ["a0", "a1", "b0", "b1", "d0", "b2", "b3", "b4"]
        starts = [row["timeline_start"] for row in rows]
        assert starts == sorted(starts)


def test_cut_away_row_keeps_its_place_after_the_row_before(tmp_path: Path) -> None:
    project = _two_take_project(tmp_path)
    # Cut take 3's source 7-9 s (b2) away: its row stays after b1, not at the top.
    project.clips[1] = project.clips[1].model_copy(update={"source_end": 7.0})
    project.clips.append(
        Clip(
            id="c3b",
            track_id="vicky",
            source_id="take3",
            source_start=9.0,
            source_end=20.0,
            timeline_start=17.0,
        )
    )
    rows = _view(project)
    texts = [row["text"] for row in rows]
    b2 = next(row for row in rows if row["text"] == "b2")
    assert b2["mappable"] is False
    assert texts.index("b2") == texts.index("b1") + 1


def test_edge_suppressed_word_attaches_within_its_own_take(tmp_path: Path) -> None:
    project = _two_take_project(tmp_path)
    take3 = project.transcripts[1]
    take3.words[1] = take3.words[1].model_copy(update={"suppressed": True})
    project.combined_transcript = TranscriptionEngine(defaults=load_defaults()).merge_transcripts(
        project
    )
    rows = _view(project)
    owners = {
        row["text"]: row.get("edge_suppressed_word_indices", [])
        for row in rows
        if row["track_id"] == "vicky"
    }
    # b1 (take 3 word 1) is suppressed and attaches to a take 3 row, never to take 2's.
    assert owners["a0"] == [] and owners["a1"] == []
    assert sum(1 in v for k, v in owners.items() if k.startswith("b")) == 1


def test_one_recording_under_two_source_spellings_maps_through_both(tmp_path: Path) -> None:
    """Clips naming the track's own media implicitly and as an explicit source are one take."""
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(
            id="host",
            label="host",
            role=TrackRole.DIALOGUE,
            speaker="host",
            media=MediaAsset(path="raw/host.wav", duration_sec=20.0),
        )
    ]
    project.sources = [SourceRecording(id="S", path="raw/host.wav")]
    project.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=10.0, timeline_start=0.0),
        Clip(
            id="c2",
            track_id="host",
            source_id="S",
            source_start=10.0,
            source_end=20.0,
            timeline_start=10.0,
        ),
    ]
    project.transcripts = [Transcript(track_id="host", words=_words("h", [1.0, 12.0]))]
    project.combined_transcript = TranscriptionEngine(defaults=load_defaults()).merge_transcripts(
        project
    )
    rows = _view(project)
    assert [(row["text"], row["timeline_start"]) for row in rows] == [("h0", 1.0), ("h1", 12.0)]
    assert [w["timeline_start"] for w in rows[1]["words"]] == [12.0]


def test_stale_row_maps_through_the_whole_lane(tmp_path: Path) -> None:
    """A row no current run matches keeps the old whole-lane mapping, never cut away."""
    project = _two_take_project(tmp_path)
    assert project.combined_transcript is not None
    utterances = project.combined_transcript.utterances
    position = next(i for i, u in enumerate(utterances) if u.text == "b3")
    utterances[position] = utterances[position].model_copy(update={"text": "edited"})
    row = next(r for r in _view(project) if r["text"] == "edited")
    # Take 3's source 12 s: read through take 2's clips alone it would be cut away.
    assert row["mappable"] is True
    assert row["timeline_start"] == 22.0


def test_clip_moved_off_a_multi_take_lane_keeps_its_row(tmp_path: Path) -> None:
    """A moved clip still plays its origin lane's recording, so its row maps and follows."""
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(
            id="vicky",
            label="vicky",
            role=TrackRole.DIALOGUE,
            speaker="vicky",
            media=MediaAsset(path="raw/vicky.wav", duration_sec=20.0),
        ),
        Track(id="dani", label="dani", role=TrackRole.DIALOGUE, speaker="dani"),
    ]
    project.sources = [
        SourceRecording(id="V", path="raw/vicky.wav"),
        SourceRecording(id="T2", path="raw/take2.wav"),
    ]
    project.clips = [
        Clip(id="v1", track_id="vicky", source_start=0.0, source_end=10.0, timeline_start=0.0),
        Clip(
            id="t2",
            track_id="vicky",
            source_id="T2",
            source_start=0.0,
            source_end=10.0,
            timeline_start=10.0,
        ),
        # Moved to another lane: pinned to the recording it still plays.
        Clip(
            id="v2",
            track_id="dani",
            source_id="V",
            source_start=10.0,
            source_end=20.0,
            timeline_start=30.0,
        ),
    ]
    project.transcripts = [
        Transcript(track_id="vicky", words=_words("v", [1.0, 12.0])),
        Transcript(track_id="vicky", source_id="T2", words=_words("t", [1.0])),
    ]
    project.combined_transcript = TranscriptionEngine(defaults=load_defaults()).merge_transcripts(
        project
    )
    rows = {row["text"]: row for row in _view(project)}
    assert rows["v1"]["mappable"] is True
    assert rows["v1"]["timeline_start"] == 32.0
    assert rows["t0"]["timeline_start"] == 11.0


def test_pasted_repeat_on_a_single_take_lane_keeps_source_order(tmp_path: Path) -> None:
    """Only a take's rows sort by timeline; a repeat on one recording stays where it was."""
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="host", role=TrackRole.DIALOGUE, speaker="host")
    ]
    project.clips = [
        Clip(id="cold", track_id="host", source_start=11.5, source_end=13.0, timeline_start=0.0),
        Clip(id="body", track_id="host", source_start=0.0, source_end=20.0, timeline_start=5.0),
    ]
    project.transcripts = [Transcript(track_id="host", words=_words("w", [6.0, 12.0]))]
    project.combined_transcript = TranscriptionEngine(defaults=load_defaults()).merge_transcripts(
        project
    )
    assert [row["text"] for row in _view(project)] == ["w0", "w1"]


def test_stale_row_does_not_duplicate_an_edge_suppressed_word(tmp_path: Path) -> None:
    project = _two_take_project(tmp_path)
    words = _words("a", [1.0, 4.5, 8.0])
    words[1] = words[1].model_copy(update={"suppressed": True})
    project.transcripts[0] = Transcript(track_id="vicky", source_id="take2", words=words)
    project.combined_transcript = TranscriptionEngine(defaults=load_defaults()).merge_transcripts(
        project
    )
    assert project.combined_transcript is not None
    utterances = project.combined_transcript.utterances
    position = next(i for i, u in enumerate(utterances) if u.text == "a0")
    utterances[position] = utterances[position].model_copy(update={"text": "edited"})
    owners = [
        row["text"]
        for row in _view(project)
        if 1 in row.get("edge_suppressed_word_indices", []) and row["text"] in ("edited", "a2")
    ]
    assert len(owners) == 1


def test_second_take_moved_to_another_lane_keeps_its_row(tmp_path: Path) -> None:
    project = _two_take_project(tmp_path)
    project.clips[1] = project.clips[1].model_copy(update={"track_id": "dani"})
    rows = {row["text"]: row for row in _view(project)}
    assert rows["b0"]["mappable"] is True
    assert rows["b0"]["timeline_start"] == 11.0
    assert [w["text"] for w in rows["b0"]["words"]] == ["b0"]


def test_identical_lines_in_two_takes_each_keep_their_own_take(tmp_path: Path) -> None:
    project = _two_take_project(tmp_path)
    project.transcripts[0] = Transcript(
        track_id="vicky", source_id="take2", words=_words("okay", [1.0])
    )
    project.transcripts[1] = Transcript(
        track_id="vicky", source_id="take3", words=_words("okay", [1.0, 8.0])
    )
    project.combined_transcript = TranscriptionEngine(defaults=load_defaults()).merge_transcripts(
        project
    )
    rows = [row for row in _view(project) if row["track_id"] == "vicky"]
    assert [row["text"] for row in rows] == ["okay0", "okay0", "okay1"]
    assert [row["timeline_start"] for row in rows] == [1.0, 11.0, 18.0]
    assert [row["words"][0]["timing_target"]["source_id"] for row in rows] == [
        "take2",
        "take3",
        "take3",
    ]


def test_offset_lane_orders_with_the_takes_by_timeline(tmp_path: Path) -> None:
    project = _two_take_project(tmp_path)
    # Dani's recording starts 100 s into the session: source 3.0 plays at timeline 103.
    project.clips[2] = project.clips[2].model_copy(update={"timeline_start": 100.0})
    project.transcripts[2] = Transcript(track_id="dani", words=_words("d", [3.0]))
    project.combined_transcript = TranscriptionEngine(defaults=load_defaults()).merge_transcripts(
        project
    )
    starts = [row["timeline_start"] for row in _view(project)]
    assert starts == sorted(starts)
    assert _view(project)[-1]["text"] == "d0"


def test_host_detail_rebuilds_take_rows_from_stale_combined_transcript(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from collections import Counter

    from podcast_mcp.gui import assembler
    from podcast_mcp.models import CombinedTranscript, CombinedUtterance
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.util import workspace_paths
    from podcast_mcp.util.batch_scope import _scope

    project = _two_take_project(tmp_path)
    project.timeline.tracks[0].media = MediaAsset(path="take2.wav", duration_sec=30.0)
    project.sources = [
        SourceRecording(id="take2", path="take2.wav"),
        SourceRecording(id="take3", path="take3.wav"),
    ]
    (tmp_path / "take2.wav").write_bytes(b"x")
    (tmp_path / "take3.wav").write_bytes(b"x")
    project.transcripts = [
        Transcript(track_id="vicky", source_id="take2", words=_words("okay", [1.0])),
        Transcript(track_id="vicky", source_id="take3", words=_words("okay", [1.0])),
    ]
    project.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="vicky",
                speaker="vicky",
                start=1.0,
                end=1.4,
                text="stale row without source identity",
            )
        ]
    )
    workspace = ProjectWorkspace(tmp_path / "episode.project.json", project)

    _resolve_within_calls: list[str] = []
    resolve_within = workspace_paths._resolve_within

    def record_resolve(root: Path, stored: str, base: Path | None) -> Path:
        _resolve_within_calls.append(stored)
        return resolve_within(root, stored, base)

    monkeypatch.setattr(workspace_paths, "_resolve_within", record_resolve)
    detail = assembler.dump_project_projection(
        workspace,
        projection=assembler.ViewProjection.DETAIL,
        history={},
    )
    rows = detail["transcript"]["utterances"]
    expected = [
        ("okay0", "take2", [(1.0, 1.4)]),
        ("okay0", "take3", [(11.0, 11.4)]),
    ]
    assert [
        (
            row["text"],
            row["source_id"],
            [(span["start"], span["end"]) for span in row["timeline_spans"]],
        )
        for row in rows
    ] == expected
    assert [row["words"][0]["timing_target"] for row in rows] == [
        {"track_id": "vicky", "source_id": "take2", "word_index": 0},
        {"track_id": "vicky", "source_id": "take3", "word_index": 0},
    ]
    assert Counter(_resolve_within_calls) == Counter({"take2.wav": 1, "take3.wav": 1})
    assert _scope.get() is None

    _resolve_within_calls.clear()
    project.sources[1] = project.sources[1].model_copy(update={"path": "take3-moved.wav"})
    (tmp_path / "take3-moved.wav").write_bytes(b"x")
    project.clips[1] = project.clips[1].model_copy(update={"timeline_start": 20.0})
    moved = assembler.dump_project_projection(
        workspace,
        projection=assembler.ViewProjection.DETAIL,
        history={},
    )
    moved_rows = moved["transcript"]["utterances"]
    assert [(row["source_id"], row["timeline_spans"][0]["start"]) for row in moved_rows] == [
        ("take2", 1.0),
        ("take3", 21.0),
    ]
    assert rows[1]["timeline_spans"][0]["start"] == 11.0
    assert Counter(_resolve_within_calls) == Counter({"take2.wav": 1, "take3-moved.wav": 1})
    assert "take3.wav" not in _resolve_within_calls
    assert _scope.get() is None

    def fail_during_mapping(*args, **kwargs):
        raise RuntimeError("mapper stopped")

    monkeypatch.setattr(assembler, "map_transcript_utterances_to_timeline", fail_during_mapping)
    with pytest.raises(RuntimeError, match="mapper stopped"):
        assembler.dump_project_projection(
            workspace,
            projection=assembler.ViewProjection.DETAIL,
            history={},
        )
    assert _scope.get() is None

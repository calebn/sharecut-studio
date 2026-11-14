from __future__ import annotations

import json
import logging
from unittest.mock import patch

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import TranscriptionEngine as Engine
from podcast_mcp.models import (
    ArchivedTranscriptWord,
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
from podcast_mcp.models.words_revision import words_revision
from podcast_mcp.pipeline import steps
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app.workspace import ProjectWorkspace
from podcast_mcp.services.document import HistoryService
from podcast_mcp.services.pipeline import PipelineService
from podcast_mcp.util.hashing import sha256_file

CLEAN = 20
LOOPED = 221


def _words() -> list[TranscriptWord]:
    words = [
        TranscriptWord(text=f"word{i}", start=294.0 + i * 0.3, end=294.2 + i * 0.3)
        for i in range(CLEAN)
    ]
    words += [
        TranscriptWord(text=t, start=299.84 + i * 0.0005, end=299.8405 + i * 0.0005)
        for i, t in enumerate((["And", "I", "know", "that"] * 56)[:LOOPED])
    ]
    return words


def _clean_words() -> list[TranscriptWord]:
    return _words()[:CLEAN]


def _project(minimal_project, sample_wav, tmp_workspace, words, **fields):
    proj = load_project(minimal_project)
    (tmp_workspace / "raw").mkdir(exist_ok=True)
    audio = tmp_workspace / "raw" / "host.wav"
    audio.write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    proj.transcripts = [
        Transcript(track_id="host", words=words, audio_sha256=sha256_file(audio), **fields)
    ]
    save_project(proj, minimal_project)
    return load_project(minimal_project)


def _run(proj):
    with patch.object(
        Engine, "transcribe_file", side_effect=AssertionError("Whisper must not run")
    ):
        summary = steps.transcribe_tracks(proj, load_defaults())
    timing = json.loads((proj.artifacts_dir() / "transcript_timing.json").read_text("utf-8"))
    return summary, timing["asr_loops"]


def test_a_stored_unedited_loop_is_repaired_on_a_plain_rerun(
    minimal_project, sample_wav, tmp_workspace, caplog
):
    proj = _project(minimal_project, sample_wav, tmp_workspace, _words())
    with caplog.at_level(logging.WARNING):
        summary, loops = _run(proj)
    assert len(proj.transcripts[0].words) == CLEAN
    assert "1 reused" in summary
    assert "dropped 221 looped word(s) at 299.84-299.95s on host" in summary
    assert len(loops) == 1
    assert loops[0]["label"] == "Track host"
    assert loops[0]["track_id"] == "host"
    assert loops[0]["dropped"] == LOOPED
    assert set(loops[0]) == {
        "label",
        "track_id",
        "dropped",
        "start",
        "end",
        "dense_words",
        "looped_segments",
    }
    assert sum("dropped 221 looped" in r.getMessage() for r in caplog.records) == 1


def test_a_second_run_changes_nothing_and_reports_nothing(
    minimal_project, sample_wav, tmp_workspace, caplog
):
    proj = _project(minimal_project, sample_wav, tmp_workspace, _words())
    _run(proj)
    revision = words_revision()
    caplog.clear()
    with caplog.at_level(logging.WARNING):
        summary, loops = _run(proj)
    assert loops == []
    assert "looped" not in summary
    assert "looped" not in caplog.text
    assert len(proj.transcripts[0].words) == CLEAN
    assert words_revision() == revision


def test_an_edited_transcript_keeps_its_loop(minimal_project, sample_wav, tmp_workspace):
    proj = _project(minimal_project, sample_wav, tmp_workspace, _words(), user_edited=True)
    summary, loops = _run(proj)
    assert len(proj.transcripts[0].words) == CLEAN + LOOPED
    assert loops == []
    assert "looped" not in summary


@pytest.mark.parametrize("flag", ["audibility_locked", "ignored", "timing_edited"])
def test_a_person_decision_inside_a_loop_leaves_the_transcript_alone(
    minimal_project, sample_wav, tmp_workspace, flag
):
    words = _words()
    setattr(words[CLEAN + 10], flag, True)
    proj = _project(minimal_project, sample_wav, tmp_workspace, words)
    revision = words_revision()
    summary, loops = _run(proj)
    assert len(proj.transcripts[0].words) == CLEAN + LOOPED
    assert getattr(proj.transcripts[0].words[CLEAN + 10], flag)
    assert loops == []
    assert "looped" not in summary
    assert words_revision() == revision


def test_a_clean_transcript_is_a_no_op(minimal_project, sample_wav, tmp_workspace):
    proj = _project(minimal_project, sample_wav, tmp_workspace, _clean_words())
    revision = words_revision()
    summary, loops = _run(proj)
    assert loops == []
    assert "looped" not in summary
    assert words_revision() == revision


def test_archived_words_keep_their_place_around_a_repair(
    minimal_project, sample_wav, tmp_workspace
):
    total = CLEAN + LOOPED
    archived = [
        ArchivedTranscriptWord(ordinal=o, word=TranscriptWord(text="gone", start=1.0, end=1.2))
        for o in (0, 5, total + 2)
    ]
    proj = _project(minimal_project, sample_wav, tmp_workspace, _words(), archived_words=archived)
    _, loops = _run(proj)
    transcript = proj.transcripts[0]
    assert len(transcript.words) == CLEAN
    assert [e.ordinal for e in transcript.archived_words] == [0, 5, CLEAN + 2]
    assert len(transcript.active_words_with_ordinals()) == CLEAN
    assert loops[0]["dropped"] == LOOPED


def test_a_repair_entry_joins_the_engine_entries(minimal_project, sample_wav, tmp_workspace):
    proj = _project(minimal_project, sample_wav, tmp_workspace, _words())
    engine_entry = {
        "label": "Track other",
        "track_id": "other",
        "dropped": 5,
        "start": 1.0,
        "end": 2.0,
        "dense_words": 0,
        "looped_segments": 0,
    }

    def run_plan(project, plan, make_engine, **_):
        make_engine()
        return []

    with (
        patch("podcast_mcp.pipeline.steps.TranscriptionEngine") as eng_cls,
        patch("podcast_mcp.edits.transcript_reuse.run_transcribe_plan", run_plan),
    ):
        eng_cls.return_value.asr_loop_drops = [engine_entry]
        summary = steps.transcribe_tracks(proj, load_defaults())
    timing = json.loads((proj.artifacts_dir() / "transcript_timing.json").read_text("utf-8"))
    assert [e["dropped"] for e in timing["asr_loops"]] == [5, LOOPED]
    assert "dropped 221 looped word(s)" in summary
    assert "dropped 5 looped word(s)" in summary


@pytest.fixture
def no_model_gate(monkeypatch):
    from podcast_mcp.services.pipeline import config

    monkeypatch.setattr(config, "ensure_whisper_cached_for_run", lambda **_: None)
    monkeypatch.setattr(config, "ensure_word_aligner_for_run", lambda *_, **__: None)


def test_undo_through_the_service_restores_the_looped_words(
    minimal_project, sample_wav, tmp_workspace, no_model_gate
):
    _project(minimal_project, sample_wav, tmp_workspace, _words())
    ws = ProjectWorkspace.open(minimal_project)
    with patch.object(
        Engine, "transcribe_file", side_effect=AssertionError("Whisper must not run")
    ):
        with write_grant(WriteGrantKind.DISPATCHER):
            PipelineService(ws).run(only_step="transcribe_tracks")
    assert len(load_project(minimal_project).transcripts[0].words) == CLEAN
    with write_grant(WriteGrantKind.DISPATCHER):
        HistoryService(ws).undo()
    assert len(load_project(minimal_project).transcripts[0].words) == CLEAN + LOOPED


def test_a_repair_rebuilds_the_combined_transcript(minimal_project, sample_wav, tmp_workspace):
    proj = _project(minimal_project, sample_wav, tmp_workspace, _words())
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(track_id="host", speaker="Host", start=299.0, end=300.0, text="x")
        ]
    )
    _run(proj)
    text = " ".join(u.text for u in proj.combined_transcript.utterances)
    assert "And I know that" not in text
    assert "word0" in text


def test_redo_reapplies_the_repair(minimal_project, sample_wav, tmp_workspace, no_model_gate):
    _project(minimal_project, sample_wav, tmp_workspace, _words())
    ws = ProjectWorkspace.open(minimal_project)
    with patch.object(
        Engine, "transcribe_file", side_effect=AssertionError("Whisper must not run")
    ):
        with write_grant(WriteGrantKind.DISPATCHER):
            PipelineService(ws).run(only_step="transcribe_tracks")
    with write_grant(WriteGrantKind.DISPATCHER):
        HistoryService(ws).undo()
    assert len(load_project(minimal_project).transcripts[0].words) == CLEAN + LOOPED
    with write_grant(WriteGrantKind.DISPATCHER):
        HistoryService(ws).redo()
    assert len(load_project(minimal_project).transcripts[0].words) == CLEAN

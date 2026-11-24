"""The mutation hook rebuilds ``combined_transcript`` once, only when merge inputs moved (#1849 S2)."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

import pytest

from combined_contract_helpers import (
    STALE_COMBINED,
    State,
    head_snapshot_combined,
    merged,
    open_workspace,
    read_combined_json,
    saved_combined,
)
from podcast_mcp.engines.play_audit import write_stem_hash
from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.models import EpisodeProject, ProcessingChain, ProcessingEffect
from podcast_mcp.pipeline import runner
from podcast_mcp.project.history.manager import HistoryManager
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.pipeline import PipelineService

MOVING = [State.FRESH, State.STALE]


def _edit_word(project: EpisodeProject) -> None:
    word = project.transcripts[0].words[0]
    word.text = "howdy"


def _edit_clip_only(project: EpisodeProject) -> None:
    project.timeline.clips[0].timeline_start = project.timeline.clips[0].timeline_start


def _mutate(ws: ProjectWorkspace, change: Any) -> None:
    with write_grant(WriteGrantKind.DISPATCHER):
        ws.mutate("before", "after", change)


def _count_merges(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    results: list[Any] = []
    original = TranscriptionEngine.merge_transcripts

    def spy(self: TranscriptionEngine, project: EpisodeProject) -> Any:
        out = original(self, project)
        results.append(out)
        return out

    monkeypatch.setattr(TranscriptionEngine, "merge_transcripts", spy)
    return results


@pytest.mark.parametrize("state", MOVING, ids=str)
def test_moved_inputs_store_the_merge_before_snapshot_and_file(
    state: State, tmp_path: Path, ten_second_silence_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, state)
    at_record: list[Any] = []
    original = HistoryManager.record

    def spy(self: HistoryManager, project: EpisodeProject, label: str, *a: Any, **k: Any) -> Any:
        if label == "after":
            at_record.append((project.combined_transcript, merged(project)))
        return original(self, project, label, *a, **k)

    monkeypatch.setattr(HistoryManager, "record", spy)
    _mutate(ws, _edit_word)
    stored, expected = at_record[0]
    assert stored == expected
    assert stored != STALE_COMBINED
    assert ws.project.combined_transcript == expected
    assert saved_combined(ws) == expected
    assert head_snapshot_combined(ws) == expected
    assert read_combined_json(ws) == expected.model_dump(by_alias=True, mode="json")


@pytest.mark.parametrize("state", list(State), ids=str)
def test_unmoved_inputs_leave_combined_byte_identical(
    state: State, tmp_path: Path, ten_second_silence_wav: Path
) -> None:
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, state)
    entry = ws.project.combined_transcript
    entry_json = read_combined_json(ws)
    _mutate(ws, _edit_clip_only)
    assert ws.project.combined_transcript == entry
    assert saved_combined(ws) == entry
    assert read_combined_json(ws) == entry_json
    assert (ws.project.combined_transcript is None) == (entry is None)


def test_none_combined_stays_none_when_inputs_move(
    tmp_path: Path, ten_second_silence_wav: Path
) -> None:
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, State.NONE)
    _mutate(ws, _edit_word)
    assert ws.project.combined_transcript is None
    assert saved_combined(ws) is None
    assert head_snapshot_combined(ws) is None


def test_equal_merge_skips_the_assignment(
    tmp_path: Path, ten_second_silence_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, State.FRESH)
    before = ws.project.combined_transcript
    results = _count_merges(monkeypatch)

    def swap_transcript_objects(project: EpisodeProject) -> None:
        project.transcripts = [t.model_copy(deep=True) for t in project.transcripts]

    _mutate(ws, swap_transcript_objects)
    assert len(results) == 1
    assert results[0] == before
    assert ws.project.combined_transcript is before


def test_history_moves_never_rebuild(
    tmp_path: Path, ten_second_silence_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, State.STALE)
    _mutate(ws, _edit_word)
    results = _count_merges(monkeypatch)
    hook_calls: list[Any] = []
    import podcast_mcp.project.history.session as session

    original = session.rebuild_combined_if_inputs_moved

    def hook_spy(*a: Any, **k: Any) -> None:
        hook_calls.append(a)
        original(*a, **k)

    monkeypatch.setattr(session, "rebuild_combined_if_inputs_moved", hook_spy)
    with write_grant(WriteGrantKind.DISPATCHER):
        ws.undo()
        assert ws.project.combined_transcript == STALE_COMBINED
        ws.redo()
        redone = ws.project.combined_transcript
        ws.goto(0)
        assert ws.project.combined_transcript == STALE_COMBINED
        ws.goto(len(ws.project.history.entries) - 1)
        assert ws.project.combined_transcript == redone
        ws.reload()
        assert ws.project.combined_transcript == redone
        ws.record_snapshot("manual", force=True)
    assert results == []
    assert hook_calls == []


def test_dry_run_style_failed_mutation_after_a_word_edit_leaves_combined_untouched(
    tmp_path: Path, ten_second_silence_wav: Path
) -> None:
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, State.STALE)
    words_before = [w.text for w in ws.project.transcripts[0].words]

    def edit_then_fail(project: EpisodeProject) -> None:
        _edit_word(project)
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        _mutate(ws, edit_then_fail)
    assert ws.project.combined_transcript == STALE_COMBINED
    assert saved_combined(ws) == STALE_COMBINED
    assert [w.text for w in ws.project.transcripts[0].words] == words_before


def test_hook_failure_rolls_the_mutation_back(
    tmp_path: Path, ten_second_silence_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, State.STALE)
    words_before = [w.text for w in ws.project.transcripts[0].words]

    def broken(self: TranscriptionEngine, project: EpisodeProject) -> Any:
        raise RuntimeError("merge failed")

    monkeypatch.setattr(TranscriptionEngine, "merge_transcripts", broken)
    with pytest.raises(RuntimeError, match="merge failed"):
        _mutate(ws, _edit_word)
    assert ws.project.combined_transcript == STALE_COMBINED
    assert saved_combined(ws) == STALE_COMBINED
    assert [w.text for w in ws.project.transcripts[0].words] == words_before


def test_auto_reconcile_double_bump_ends_with_one_merge_value(
    tmp_path: Path, ten_second_silence_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def host_stem(project: EpisodeProject) -> None:
        stem = project.artifacts_dir() / "tracks" / "host.wav"
        stem.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(project.workspace_path() / "raw" / "host.wav", stem)

    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, State.FRESH, arrange=host_stem)
    results = _count_merges(monkeypatch)

    def gate(project: EpisodeProject) -> None:
        project.processing_chains = [
            ProcessingChain(track_id="host", effects=[ProcessingEffect(effect="agate", params={})])
        ]
        write_stem_hash(project, "host", defaults=ws.effective_config())

    _mutate(ws, gate)
    assert len(results) >= 2
    final = ws.project.combined_transcript
    assert final == results[-1]
    assert final is not results[-1]
    assert final == merged(ws.project)
    assert saved_combined(ws) == final
    assert head_snapshot_combined(ws) == final


def _patch_step(monkeypatch: pytest.MonkeyPatch, change: Any) -> None:
    def step(project: EpisodeProject, defaults: dict) -> str | None:
        change(project)
        return None

    monkeypatch.setitem(runner._STEP_MAP, "analyze_prosody", step)


@pytest.mark.parametrize("state", MOVING, ids=str)
def test_pipeline_step_rebuilds_before_the_after_snapshot(
    state: State, tmp_path: Path, ten_second_silence_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, state)
    _patch_step(monkeypatch, _edit_word)
    with write_grant(WriteGrantKind.DISPATCHER):
        PipelineService(ws).run(only_step="analyze_prosody", config={})
    expected = merged(ws.project)
    assert ws.project.combined_transcript == expected
    assert saved_combined(ws) == expected
    assert head_snapshot_combined(ws) == expected


def test_pipeline_step_without_moved_inputs_leaves_a_stale_combined(
    tmp_path: Path, ten_second_silence_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, State.STALE)
    _patch_step(monkeypatch, _edit_clip_only)
    with write_grant(WriteGrantKind.DISPATCHER):
        PipelineService(ws).run(only_step="analyze_prosody", config={})
    assert ws.project.combined_transcript == STALE_COMBINED
    assert saved_combined(ws) == STALE_COMBINED


def test_pipeline_step_keeps_none_combined(
    tmp_path: Path, ten_second_silence_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, State.NONE)
    _patch_step(monkeypatch, _edit_word)
    with write_grant(WriteGrantKind.DISPATCHER):
        PipelineService(ws).run(only_step="analyze_prosody", config={})
    assert ws.project.combined_transcript is None

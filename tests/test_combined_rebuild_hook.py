"""The mutation hook rebuilds ``combined_transcript`` once, only when merge inputs moved (#1849 S2)."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

import pytest

from combined_contract_helpers import (
    STALE_COMBINED,
    State,
    build_project,
    head_snapshot_combined,
    merged,
    open_workspace,
    read_combined_json,
    saved_combined,
)
from podcast_mcp.engines.play_audit import write_stem_hash
from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.models import EpisodeProject, ProcessingChain, ProcessingEffect
from podcast_mcp.models.words_revision import bump_words_revision
from podcast_mcp.pipeline import runner
from podcast_mcp.project.history.manager import HistoryManager
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document.episode import EpisodeService
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
    results = _count_merges(monkeypatch)
    hook_calls: list[Any] = []
    import podcast_mcp.project.history.session as session

    original = session.rebuild_combined_if_inputs_moved

    def hook_spy(*a: Any, **k: Any) -> None:
        hook_calls.append(a)
        original(*a, **k)

    monkeypatch.setattr(session, "rebuild_combined_if_inputs_moved", hook_spy)
    _mutate(ws, _edit_word)
    assert len(hook_calls) == 1
    assert len(results) >= 1
    hook_calls.clear()
    results.clear()
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


def test_failed_mutation_before_the_hook_never_merges(
    tmp_path: Path, ten_second_silence_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, State.STALE)
    words_before = [w.text for w in ws.project.transcripts[0].words]
    results = _count_merges(monkeypatch)

    def edit_then_fail(project: EpisodeProject) -> None:
        _edit_word(project)
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        _mutate(ws, edit_then_fail)
    assert results == []
    assert ws.project.combined_transcript == STALE_COMBINED
    assert saved_combined(ws) == STALE_COMBINED
    assert [w.text for w in ws.project.transcripts[0].words] == words_before


def test_commit_failure_after_the_hook_rolls_the_rebuilt_combined_back(
    tmp_path: Path, ten_second_silence_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, State.STALE)
    words_before = [w.text for w in ws.project.transcripts[0].words]
    results = _count_merges(monkeypatch)
    original = HistoryManager.record

    def failing_record(
        self: HistoryManager, project: EpisodeProject, label: str, *a: Any, **k: Any
    ) -> Any:
        if label == "after":
            assert project.combined_transcript != STALE_COMBINED
            raise RuntimeError("record failed")
        return original(self, project, label, *a, **k)

    monkeypatch.setattr(HistoryManager, "record", failing_record)
    with pytest.raises(RuntimeError, match="record failed"):
        _mutate(ws, _edit_word)
    assert len(results) == 1
    assert ws.project.combined_transcript == STALE_COMBINED
    assert saved_combined(ws) == STALE_COMBINED
    assert [w.text for w in ws.project.transcripts[0].words] == words_before


def test_hook_failure_rolls_the_mutation_back(
    tmp_path: Path, ten_second_silence_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, State.STALE)
    words_before = [w.text for w in ws.project.transcripts[0].words]
    attempts: list[EpisodeProject] = []

    def broken(self: TranscriptionEngine, project: EpisodeProject) -> Any:
        attempts.append(project)
        raise RuntimeError("merge failed")

    monkeypatch.setattr(TranscriptionEngine, "merge_transcripts", broken)
    with pytest.raises(RuntimeError, match="merge failed"):
        _mutate(ws, _edit_word)
    assert len(attempts) == 1
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


def _edit_then_fail(project: EpisodeProject) -> None:
    _edit_word(project)
    raise RuntimeError("step failed")


def _run_failing_step(ws: ProjectWorkspace) -> None:
    with write_grant(WriteGrantKind.DISPATCHER):
        with pytest.raises(RuntimeError, match="step failed"):
            PipelineService(ws).run(only_step="analyze_prosody", config={})


@pytest.mark.parametrize("state", MOVING, ids=str)
def test_failed_pipeline_step_rebuilds_combined_for_the_words_it_published(
    state: State, tmp_path: Path, ten_second_silence_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, state)
    _patch_step(monkeypatch, _edit_then_fail)
    _run_failing_step(ws)
    assert ws.project.transcripts[0].words[0].text == "howdy"
    expected = merged(ws.project)
    assert ws.project.combined_transcript == expected
    assert ws.project.combined_transcript != STALE_COMBINED


def test_failed_pipeline_step_that_moved_nothing_leaves_combined_alone(
    tmp_path: Path, ten_second_silence_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, State.STALE)

    def clip_then_fail(project: EpisodeProject) -> None:
        _edit_clip_only(project)
        raise RuntimeError("step failed")

    _patch_step(monkeypatch, clip_then_fail)
    _run_failing_step(ws)
    assert ws.project.combined_transcript == STALE_COMBINED


def test_failed_pipeline_step_keeps_none_combined(
    tmp_path: Path, ten_second_silence_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, State.NONE)
    _patch_step(monkeypatch, _edit_then_fail)
    _run_failing_step(ws)
    assert ws.project.combined_transcript is None


def test_rebuild_failure_after_a_failed_step_never_masks_the_step_error(
    tmp_path: Path, ten_second_silence_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, State.STALE)
    attempts: list[EpisodeProject] = []

    def broken(self: TranscriptionEngine, project: EpisodeProject) -> Any:
        attempts.append(project)
        raise ValueError("merge failed")

    monkeypatch.setattr(TranscriptionEngine, "merge_transcripts", broken)
    _patch_step(monkeypatch, _edit_then_fail)
    with write_grant(WriteGrantKind.DISPATCHER):
        with pytest.raises(RuntimeError, match="step failed") as raised:
            PipelineService(ws).run(only_step="analyze_prosody", config={})
    assert attempts
    assert raised.value.__context__ is None
    assert ws.project.combined_transcript == STALE_COMBINED


def _edit_clip_and_bump_revision(project: EpisodeProject) -> None:
    _edit_clip_only(project)
    bump_words_revision()


def _edit_clip_and_edit_foreign_words(project: EpisodeProject, foreign: EpisodeProject) -> None:
    _edit_clip_only(project)
    foreign.transcripts[0].words[0].text = "elsewhere"


def test_foreign_revision_bump_refreshes_a_stale_combined(
    tmp_path: Path, ten_second_silence_wav: Path
) -> None:
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, State.STALE)
    _mutate(ws, _edit_clip_and_bump_revision)
    assert ws.project.combined_transcript == merged(ws.project)
    assert ws.project.combined_transcript != STALE_COMBINED
    assert saved_combined(ws) == merged(ws.project)
    assert head_snapshot_combined(ws) == merged(ws.project)


def test_mutation_on_another_project_refreshes_a_stale_combined(
    tmp_path: Path, ten_second_silence_wav: Path
) -> None:
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, State.STALE)
    foreign = build_project(tmp_path / "other", ten_second_silence_wav, State.FRESH)
    _mutate(ws, lambda project: _edit_clip_and_edit_foreign_words(project, foreign))
    assert foreign.transcripts[0].words[0].text == "elsewhere"
    assert ws.project.transcripts[0].words[0].text != "elsewhere"
    assert ws.project.combined_transcript == merged(ws.project)
    assert saved_combined(ws) == merged(ws.project)


def test_foreign_revision_bump_leaves_a_fresh_combined_equal(
    tmp_path: Path, ten_second_silence_wav: Path
) -> None:
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, State.FRESH)
    before = ws.project.combined_transcript
    _mutate(ws, _edit_clip_and_bump_revision)
    assert ws.project.combined_transcript is before


def test_foreign_revision_bump_never_touches_a_none_combined(
    tmp_path: Path, ten_second_silence_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, State.NONE)
    results = _count_merges(monkeypatch)
    _mutate(ws, _edit_clip_and_bump_revision)
    assert results == []
    assert ws.project.combined_transcript is None
    assert saved_combined(ws) is None
    assert head_snapshot_combined(ws) is None


def _rename_host(project: EpisodeProject) -> None:
    project.track_by_id("host").speaker = "Dr Host"  # type: ignore[union-attr]


def _unrelated(project: EpisodeProject) -> None:
    project.timeline.clips[0].timeline_start = 0.0


def _no_transcripts(project: EpisodeProject) -> None:
    project.transcripts = []


@pytest.mark.parametrize("change", [_rename_host, _unrelated], ids=["speaker", "unrelated"])
@pytest.mark.parametrize("with_transcripts", [True, False], ids=["with", "without"])
def test_stale_combined_is_rebuilt_only_when_transcripts_exist(
    change: Any,
    with_transcripts: bool,
    tmp_path: Path,
    ten_second_silence_wav: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ws = open_workspace(
        tmp_path / "ep",
        ten_second_silence_wav,
        State.STALE,
        arrange=None if with_transcripts else _no_transcripts,
    )
    results = _count_merges(monkeypatch)
    _mutate(ws, change)
    if with_transcripts and change is _rename_host:
        assert len(results) == 1
        assert ws.project.combined_transcript == merged(ws.project)
    elif with_transcripts:
        assert results == []
        assert ws.project.combined_transcript == STALE_COMBINED
    else:
        assert results == []
        assert ws.project.combined_transcript == STALE_COMBINED
        assert saved_combined(ws) == STALE_COMBINED


def test_set_track_meta_keeps_the_patched_combined_without_transcripts(
    tmp_path: Path, ten_second_silence_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = open_workspace(
        tmp_path / "ep", ten_second_silence_wav, State.STALE, arrange=_no_transcripts
    )
    results = _count_merges(monkeypatch)
    with write_grant(WriteGrantKind.DISPATCHER):
        EpisodeService(ws).set_track_meta("host", speaker="Dr Host")
    assert results == []
    expected = STALE_COMBINED.model_copy(deep=True)
    expected.utterances[0].speaker = "Dr Host"
    assert ws.project.combined_transcript == expected
    assert saved_combined(ws) == expected


def test_set_track_meta_rebuilds_a_stale_combined_with_transcripts(
    tmp_path: Path, ten_second_silence_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = open_workspace(tmp_path / "ep", ten_second_silence_wav, State.STALE)
    results = _count_merges(monkeypatch)
    with write_grant(WriteGrantKind.DISPATCHER):
        EpisodeService(ws).set_track_meta("host", speaker="Dr Host")
    assert len(results) == 1
    assert ws.project.combined_transcript == merged(ws.project)
    assert saved_combined(ws) == merged(ws.project)

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from podcast_mcp.transcript_context import (
    TranscriptContext,
    context_from_dict,
    load_transcript_context,
)


def test_vocabulary_edit_marks_existing_transcript_stale(minimal_project: Path) -> None:
    from podcast_mcp.models import Transcript
    from podcast_mcp.services.transcript_precorrect import TranscriptPrecorrectService
    from podcast_mcp.services.workspace import ProjectWorkspace

    ws = ProjectWorkspace.open(minimal_project)
    ws.project.transcripts = [Transcript(track_id="host", words=[])]
    svc = TranscriptPrecorrectService(ws)
    result = svc.set_vocabulary(terms=["Kaczynski"], guest_names=["Alice"], base_revision=None)
    assert result["needs_retranscription"] is True
    assert "Kaczynski" in svc.load_context().initial_prompt_text()
    assert (
        svc.set_vocabulary(
            terms=["Kaczynski"], guest_names=["Alice"], base_revision=result["revision"]
        )
        == result
    )


def test_vocabulary_rejects_terms_outside_whisper_prompt(minimal_project: Path) -> None:
    from podcast_mcp.services.transcript_precorrect import TranscriptPrecorrectService
    from podcast_mcp.services.workspace import ProjectWorkspace

    svc = TranscriptPrecorrectService(ProjectWorkspace.open(minimal_project))
    with pytest.raises(ValueError, match="prompt limit"):
        svc.set_vocabulary(
            terms=[str(index) + "a" * 99 for index in range(5)], guest_names=[], base_revision=None
        )
    assert svc.get_vocabulary()["terms"] == []


def test_context_update_merges_latest_vocabulary(minimal_project: Path) -> None:
    from podcast_mcp.services.transcript_precorrect import TranscriptPrecorrectService
    from podcast_mcp.services.workspace import ProjectWorkspace

    first = TranscriptPrecorrectService(ProjectWorkspace.open(minimal_project))
    second = TranscriptPrecorrectService(ProjectWorkspace.open(minimal_project))
    first.set_vocabulary(terms=["A"], guest_names=[], base_revision=None)
    second.update_context(values={"show_title": "Episode"}, terms=["B"])
    assert first.get_vocabulary()["terms"] == ["A", "B"]


def test_context_from_dict_initial_prompt() -> None:
    ctx = context_from_dict(
        {
            "show_title": "My Show",
            "terms": ["Guest Name"],
            "guest_names": ["Alice"],
        }
    )
    prompt = ctx.initial_prompt_text(max_chars=200)
    assert prompt is not None
    assert "My Show" in prompt
    assert "Guest Name" in prompt
    assert "Alice" in prompt


def test_load_transcript_context_merges_episode(tmp_path: Path) -> None:
    (tmp_path / "show_glossary.yaml").write_text(
        yaml.safe_dump({"show_title": "Show A", "terms": ["Term A"]}),
        encoding="utf-8",
    )
    (tmp_path / "transcript_context.yaml").write_text(
        yaml.safe_dump({"guest_names": ["Bob"]}),
        encoding="utf-8",
    )
    ctx = load_transcript_context(tmp_path)
    assert ctx.show_title == "Show A"
    assert "Term A" in ctx.terms
    assert "Bob" in ctx.guest_names


def test_load_transcript_context_merges_nested_speaker_id(tmp_path: Path) -> None:
    (tmp_path / "show_glossary.yaml").write_text(
        yaml.safe_dump({"analysis": {"speaker_id": {"auto_suppress": True}}}),
        encoding="utf-8",
    )
    ctx = load_transcript_context(tmp_path)
    assert ctx.speaker_id.auto_suppress is True
    # Sibling keys from the shipped transcript_glossary.yaml survive the nested merge.
    assert ctx.speaker_id.mode == "auto"


def test_load_transcript_context_keeps_underscore_transcribe_keys(tmp_path: Path) -> None:
    (tmp_path / "show_glossary.yaml").write_text(
        yaml.safe_dump({"transcribe": {"_vendor_hint": "x"}}),
        encoding="utf-8",
    )
    ctx = load_transcript_context(tmp_path)
    assert ctx.transcribe.get("_vendor_hint") == "x"


def test_replacements_sorted_longest_first() -> None:
    ctx = context_from_dict(
        {
            "replacements": [
                {"match": "foo", "replace": "a"},
                {"match": "foo bar", "replace": "b"},
            ]
        }
    )
    assert ctx.replacements[0].match == "foo bar"


def test_context_roundtrip_save(tmp_path: Path) -> None:
    ctx = TranscriptContext(show_title="Test", terms=["One"])
    path = ctx.save(tmp_path)
    assert path.is_file()
    loaded = load_transcript_context(tmp_path)
    assert loaded.show_title == "Test"
    assert loaded.terms == ["One"]


def test_initial_prompt_disabled_and_truncated() -> None:
    ctx = TranscriptContext(
        show_title="Show",
        terms=["a" * 200],
        transcribe={"initial_prompt": False},
    )
    assert ctx.initial_prompt_text() is None

    ctx2 = TranscriptContext(
        show_title="Show",
        terms=[f"term{i}" for i in range(30)],
        transcribe={"initial_prompt_max_chars": 40},
    )
    prompt = ctx2.initial_prompt_text()
    assert prompt is not None
    assert len(prompt) <= 40


def test_parse_replacements_and_skip_spans_skips_invalid() -> None:
    from podcast_mcp.transcript_context import context_from_dict

    ctx = context_from_dict(
        {
            "replacements": ["bad", {"match": "", "replace": "x"}, {"match": "ok", "replace": "y"}],
            "skip_spans": ["bad", {"start_sec": 1.0, "end_sec": 2.0, "reason": "noise"}],
        }
    )
    assert len(ctx.replacements) == 1
    assert ctx.replacements[0].match == "ok"
    assert len(ctx.skip_spans) == 1


def test_speaker_id_config_roundtrip(tmp_path: Path) -> None:
    ctx = TranscriptContext()
    ctx.speaker_id = ctx.speaker_id.__class__(
        mode="auto",
        expected_speaker_count=3,
        speaker_count_source="user",
        max_speaker_gap_sec=0.4,
    )
    ctx.save(tmp_path)
    loaded = load_transcript_context(tmp_path)
    assert loaded.speaker_id.mode == "auto"
    assert loaded.speaker_id.expected_speaker_count == 3
    assert loaded.speaker_id.speaker_count_source == "user"
    assert loaded.speaker_id.max_speaker_gap_sec == 0.4


def test_cross_track_max_word_duration_matches_asr_default() -> None:
    from podcast_mcp.engines.asr_timing import DEFAULT_MAX_WORD_DURATION_SEC
    from podcast_mcp.engines.audio_audit import AnalysisPolicy
    from podcast_mcp.transcript_context import CrossTrackConfig

    assert CrossTrackConfig().max_word_duration_sec == DEFAULT_MAX_WORD_DURATION_SEC
    assert AnalysisPolicy().max_word_audibility_sec == DEFAULT_MAX_WORD_DURATION_SEC


def test_vocabulary_needs_retranscription_only_for_mismatched_transcripts(
    minimal_project: Path,
) -> None:
    from podcast_mcp.models import Transcript
    from podcast_mcp.services.transcript_precorrect import TranscriptPrecorrectService
    from podcast_mcp.services.workspace import ProjectWorkspace

    ws = ProjectWorkspace.open(minimal_project)
    ws.project.transcripts = []
    svc = TranscriptPrecorrectService(ws)
    saved = svc.set_vocabulary(terms=["Kaczynski"], guest_names=[], base_revision=None)
    assert saved["needs_retranscription"] is False
    ws.project.transcripts = [
        Transcript(track_id="host", words=[], vocabulary_revision=saved["revision"])
    ]
    assert svc.get_vocabulary()["needs_retranscription"] is False
    ws.project.transcripts.append(Transcript(track_id="guest", words=[]))
    assert svc.get_vocabulary()["needs_retranscription"] is True


def test_vocabulary_save_rejects_stale_base_revision(minimal_project: Path) -> None:
    from podcast_mcp.services.transcript_precorrect import (
        TranscriptPrecorrectService,
        VocabularyConflictError,
    )
    from podcast_mcp.services.workspace import ProjectWorkspace

    first = TranscriptPrecorrectService(ProjectWorkspace.open(minimal_project))
    second = TranscriptPrecorrectService(ProjectWorkspace.open(minimal_project))
    base = first.get_vocabulary()["revision"]
    first.set_vocabulary(terms=["A"], guest_names=[], base_revision=base)
    with pytest.raises(VocabularyConflictError):
        second.set_vocabulary(terms=["B"], guest_names=[], base_revision=base)
    assert first.get_vocabulary()["terms"] == ["A"]


def test_full_prompt_text_matches_untruncated_initial_prompt() -> None:
    ctx = TranscriptContext(show_title=" Show ", terms=["A", "A", " B "], guest_names=["C"])
    assert ctx.full_prompt_text() == "Show, A, B, C"
    assert ctx.initial_prompt_text() == ctx.full_prompt_text()


def test_vocabulary_saves_long_lists_when_prompting_disabled(minimal_project: Path) -> None:
    from podcast_mcp.services.transcript_precorrect import TranscriptPrecorrectService
    from podcast_mcp.services.workspace import ProjectWorkspace

    ws = ProjectWorkspace.open(minimal_project)
    TranscriptContext(transcribe={"initial_prompt": False}).save(ws.project.workspace_path())
    svc = TranscriptPrecorrectService(ws)
    terms = [str(index) + "a" * 99 for index in range(5)]
    result = svc.set_vocabulary(
        terms=terms, guest_names=[], base_revision=svc.get_vocabulary()["revision"]
    )
    assert result["terms"] == terms


def test_context_update_dedupes_without_new_revision(minimal_project: Path) -> None:
    from podcast_mcp.services.transcript_precorrect import TranscriptPrecorrectService
    from podcast_mcp.services.workspace import ProjectWorkspace

    svc = TranscriptPrecorrectService(ProjectWorkspace.open(minimal_project))
    svc.update_context(terms=["A"])
    revision = svc.get_vocabulary()["revision"]
    svc.update_context(terms=[" A "])
    assert svc.get_vocabulary()["terms"] == ["A"]
    assert svc.get_vocabulary()["revision"] == revision


def test_context_update_validates_entry_length(minimal_project: Path) -> None:
    from podcast_mcp.services.transcript_precorrect import TranscriptPrecorrectService
    from podcast_mcp.services.workspace import ProjectWorkspace

    svc = TranscriptPrecorrectService(ProjectWorkspace.open(minimal_project))
    with pytest.raises(ValueError, match="Vocabulary allows up to"):
        svc.update_context(terms=["x" * 101])


def test_context_lock_is_reentrant_and_under_artifacts(tmp_path: Path) -> None:
    from podcast_mcp.transcript_context import context_lock
    from podcast_mcp.util.file_locks import shared_file_lock

    lock = shared_file_lock(tmp_path / "artifacts" / "transcript_context.yaml.lock")
    assert Path(lock.lock_file).parent == (tmp_path / "artifacts").resolve()
    with context_lock(tmp_path):
        assert lock.is_locked
        TranscriptContext(terms=["A"]).save(tmp_path)
    assert not lock.is_locked
    saved = yaml.safe_load((tmp_path / "transcript_context.yaml").read_text())
    assert saved["terms"] == ["A"]
    assert not (tmp_path / "transcript_context.yaml.lock").exists()

from __future__ import annotations

from dataclasses import asdict
from typing import Any

from mcp.server import MCPServer

from podcast_mcp.edits.transcript_timing import WordTimingTarget
from podcast_mcp.mcp.args import JsonObject, JsonObjectList
from podcast_mcp.mcp.serialize import to_json
from podcast_mcp.mcp.tools.agent_notify import notify_after_mutation
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import AnalysisService, TranscriptService
from podcast_mcp.services.document_sync import (
    host_command_result,
    submit_host_command_result,
    submit_host_document_command,
    validate_payload,
)
from podcast_mcp.services.jobs import run_audio_edit
from podcast_mcp.services.media import (
    TranscriptPrecorrectService,
    TranscriptRefineService,
)
from podcast_mcp.util.progress import resolve_progress
from podcast_mcp.util.project_state import REQUEST_RENDER_LOCK_TIMEOUT_SEC


def transcribe_track(project_path: str, track_id: str | None = None) -> str:
    """Transcribe one track, or all dialogue tracks when track_id is omitted, into word-level timestamps.

    Runs even when a transcript exists, but reuses the ASR disk cache when the audio,
    model and prompt are unchanged (the pipeline's force_transcribe skips that cache).
    Replaces only those transcripts (others and extra-source transcripts are kept) and
    warns when it replaces a hand-edited one; the pipeline's transcribe_tracks step
    reuses existing transcripts instead.
    """
    ws = ProjectWorkspace.open(project_path)
    ids = TranscriptService(ws).transcribe(track_id)
    return to_json(ids)


def get_transcript(
    project_path: str,
    combined: bool = False,
    format: str = "json",
) -> str:
    """Fetch the transcript, combined or per-track, in text or JSON format."""
    ws = ProjectWorkspace.open(project_path)
    return TranscriptService(ws).get(combined=combined, format=format)


def export_transcript(
    project_path: str,
    formats: list[str] | None = None,
    dry_run: bool = False,
    with_text: bool = False,
) -> str:
    """Write the edited episode's transcript next to the audio; return JSON.

    formats: any of "txt", "md", "srt", "vtt" (default ["md", "srt"]). Files go to the
    project's export folder under the episode name, all written together or none, and
    reflect the edited timeline (cut material omitted). dry_run writes nothing and returns
    the preview only; with_text adds the full reading text. Result keys: language, turns,
    duration_sec, preview, cue_sample, files (format, path, name, bytes, language, written,
    current), text. Errors: export_busy (another export is running), transcript_empty.
    """
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        TranscriptService(ws).export(
            formats if formats is not None else ["md", "srt"],
            dry_run=dry_run,
            with_text=with_text,
        )
    )


def list_exported_transcripts(project_path: str) -> str:
    """List transcript files already exported next to the audio (txt, md, srt, vtt) as JSON.

    Each entry: format, path, name, mime, language, bytes, modified (UTC), current (false
    when the transcript was edited since the file was written). Read-only.
    """
    ws = ProjectWorkspace.open(project_path)
    return to_json([asdict(f) for f in TranscriptService(ws).exported()])


def get_transcript_vocabulary_tool(project_path: str) -> str:
    """Read project terms, guest names, revision, and re-transcription status."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(TranscriptPrecorrectService(ws).get_vocabulary())


def set_transcript_vocabulary_tool(
    project_path: str,
    terms: list[str],
    guest_names: list[str],
    base_revision: str | None,
) -> str:
    """Replace vocabulary using the revision returned by get_transcript_vocabulary_tool.

    Pass null only when that read returned a null revision. A stale revision rejects
    the write; the existing show title and other transcript context stay unchanged.
    This changes future transcription prompts, not existing transcript words.
    """
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        TranscriptPrecorrectService(ws).set_vocabulary(
            terms=terms,
            guest_names=guest_names,
            base_revision=base_revision,
        )
    )


def precorrect_transcript_tool(
    project_path: str,
    dry_run: bool = True,
) -> str:
    """Apply automatic transcript precorrections; dry_run previews without changing words."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        TranscriptPrecorrectService(ws).precorrect(
            dry_run=dry_run,
            progress=resolve_progress(),
        )
    )


def transcript_refine_status_tool(project_path: str) -> str:
    """Report the transcript-refine gate status (blocking approve_edits while open)."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(TranscriptRefineService(ws).status())


def transcript_refine_brief_tool(project_path: str) -> str:
    """Return the transcript-refine brief: what to review before marking done."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(TranscriptRefineService(ws).brief())


def transcript_refine_done_tool(
    project_path: str,
    notes: str | None = None,
    expected_fingerprint: str | None = None,
) -> str:
    """Mark transcript refinement done, with optional notes.

    Pass the status ``fingerprint`` you reviewed as ``expected_fingerprint`` to refuse if the
    transcript changed since.
    """
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        TranscriptRefineService(ws).mark_done(
            notes=notes, source="mcp", expected_fingerprint=expected_fingerprint
        )
    )


def transcript_refine_waive_tool(project_path: str, reason: str) -> str:
    """Waive transcript refinement with a recorded reason."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(TranscriptRefineService(ws).waive(reason=reason, source="mcp"))


def correct_transcript_tool(
    project_path: str,
    track_id: str,
    word_index: int,
    new_text: str,
    expected_text: str | None = None,
    source_id: str | None = None,
) -> str:
    """Fix the text of one transcript word without changing its timing.

    Pass ``expected_text`` (the word text you read) to refuse the fix if the word at
    ``word_index`` changed meanwhile (for example a GUI edit shifted indices); omit to skip.
    ``source_id`` names the recording whose words ``word_index`` counts; it is required on a
    track recorded as several takes, and the refusal is ``word_source_required``.
    """
    return to_json(
        submit_host_command_result(
            project_path,
            "CorrectTranscriptWord",
            {
                "track_id": track_id,
                "source_id": source_id,
                "word_index": word_index,
                "text": new_text,
                "expected_text": expected_text,
            },
        )
    )


def correct_transcript_phrase_tool(
    project_path: str,
    track_id: str,
    start_word_index: int,
    end_word_index: int,
    new_text: str,
    expected_text: str | None = None,
    source_id: str | None = None,
) -> str:
    """Replace a word range's text with corrected phrase text.

    Pass ``expected_text`` (the space-joined words you read for this range) to refuse the fix
    if those words changed meanwhile; omit to skip.
    ``source_id`` names the recording whose words ``word_index`` counts; it is required on a
    track recorded as several takes, and the refusal is ``word_source_required``.
    """
    return to_json(
        submit_host_command_result(
            project_path,
            "CorrectTranscriptPhrase",
            {
                "track_id": track_id,
                "source_id": source_id,
                "start_word_index": start_word_index,
                "end_word_index": end_word_index,
                "text": new_text,
                "expected_text": expected_text,
            },
        )
    )


def set_word_suppressed_tool(
    project_path: str,
    track_id: str,
    word_index: int,
    suppressed: bool,
    expected_text: str | None = None,
    source_id: str | None = None,
) -> str:
    """Toggle suppressed on one per-track word (TOOL_TIMEBASE: source).

    Pass ``expected_text`` (the word text you read) to refuse the toggle if the word at
    ``word_index`` changed meanwhile; omit to skip.
    ``source_id`` names the recording whose words ``word_index`` counts; it is required on a
    track recorded as several takes, and the refusal is ``word_source_required``.
    """
    return to_json(
        submit_host_command_result(
            project_path,
            "SetTranscriptWordSuppressed",
            {
                "track_id": track_id,
                "source_id": source_id,
                "word_index": word_index,
                "suppressed": suppressed,
                "expected_text": expected_text,
            },
        )
    )


def set_word_automatic_tool(
    project_path: str,
    track_id: str,
    word_index: int,
    expected_text: str | None = None,
    source_id: str | None = None,
) -> str:
    """Clear one word's suppression lock; ``suppressed`` waits for the next reconcile (#824).

    A word set directly by ``set_word_suppressed_tool``, an explicit-list suppress-bleed /
    low-audibility apply, or Studio's Suppress toggle stays ``audibility_locked`` until this
    call. It does not itself change ``suppressed`` — run ``reconcile_transcript_tool`` after
    to get the computed target. Pass ``expected_text`` (the word text you read) to refuse the
    unlock if the word at ``word_index`` changed meanwhile; omit to skip. TOOL_TIMEBASE: source.
    ``source_id`` names the recording whose words ``word_index`` counts; it is required on a
    track recorded as several takes, and the refusal is ``word_source_required``.
    """
    return to_json(
        submit_host_command_result(
            project_path,
            "SetTranscriptWordAutomatic",
            {
                "track_id": track_id,
                "source_id": source_id,
                "word_index": word_index,
                "expected_text": expected_text,
            },
        )
    )


def set_word_timing_tool(
    project_path: str,
    track_id: str,
    word_index: int,
    start: float,
    end: float,
    source_id: str | None = None,
    expected_text: str | None = None,
) -> str:
    """Set one transcript word's start and end in source seconds (Studio Adjust word timing).

    ``word_index`` indexes the track's transcript, or the ``source_id`` recording's
    transcript when given. Pass ``expected_text`` to refuse the change if the word was
    edited meanwhile. Bounds are checked against the recording; a word that overlaps
    its neighbours comes back in ``context.warnings``. Submits
    ``SetTranscriptWordTiming``; undoable.
    """
    target = WordTimingTarget(track_id=track_id, source_id=source_id, word_index=word_index)
    ws = ProjectWorkspace.open(project_path)
    context = TranscriptService(ws).word_timing_context(target, expected_text=expected_text)
    reply = submit_host_document_command(
        project_path,
        "SetTranscriptWordTiming",
        {
            "target": context["target"],
            "expected_token": context["expected_token"],
            "start": start,
            "end": end,
        },
    )
    return to_json(host_command_result(reply))


def find_replace_transcript_tool(
    project_path: str,
    search: str,
    replacement: str,
    match_case: bool = False,
    dry_run: bool = False,
) -> str:
    """Replace a literal word or phrase everywhere in the transcript (Studio Find and replace).

    Matches whole words across every track and recording; punctuation around a word is
    kept. ``dry_run`` returns the preview (``matches``, ``count``, ``skipped_words``)
    and changes nothing. Otherwise every previewed match is replaced through
    ``ReplaceTranscriptMatches`` in one undo step, and ``replaced`` gives the count.
    For one word use ``correct_transcript_tool``.
    """
    ws = ProjectWorkspace.open(project_path)
    preview = TranscriptService(ws).preview_transcript_replacement(
        search, replacement, match_case=match_case
    )
    if dry_run:
        return to_json(preview)
    reply = submit_host_document_command(
        project_path,
        "ReplaceTranscriptMatches",
        {
            "search": search,
            "replacement": replacement,
            "match_case": match_case,
            "preview_token": preview["preview_token"],
        },
    )
    return to_json({**preview, **host_command_result(reply)})


def set_words_ignored_tool(
    project_path: str,
    track_id: str,
    start_word_index: int,
    end_word_index: int,
    ignored: bool,
    expected_text: str | None = None,
    source_id: str | None = None,
) -> str:
    """Strike through and mute (or restore) a word range at render, without a cut.

    Text-and-audio hide (#633): unlike suppress, the words stay in the combined
    transcript; only their audio is muted, computed at render time and never
    written to ``Clip.mute_regions``. TOOL_TIMEBASE: source.

    Pass ``expected_text`` (the space-joined words you read for this range) to refuse the
    toggle if those words changed meanwhile; omit to skip.
    ``source_id`` names the recording whose words ``word_index`` counts; it is required on a
    track recorded as several takes, and the refusal is ``word_source_required``.
    """
    return to_json(
        submit_host_command_result(
            project_path,
            "SetTranscriptWordsIgnored",
            {
                "track_id": track_id,
                "source_id": source_id,
                "start_word_index": start_word_index,
                "end_word_index": end_word_index,
                "ignored": ignored,
                "expected_text": expected_text,
            },
        )
    )


def apply_transcript_cleanup_tool(
    project_path: str,
    track_id: str,
    corrections: JsonObject,
) -> str:
    """Batch word + phrase fixes in one undoable history step.

    ``corrections``: ``{"words": [{word_index, text}], "phrases": [{start_word_index, end_word_index, text}]}``
    """
    return to_json(
        submit_host_command_result(
            project_path,
            "ApplyTranscriptCleanup",
            {
                "track_id": track_id,
                "words": corrections.get("words"),
                "phrases": corrections.get("phrases"),
            },
        )
    )


def low_confidence_words_tool(project_path: str, threshold: float | None = None) -> str:
    """List words below a confidence threshold for human review.

    ``threshold`` defaults to the project's unsure-word line, the config key
    ``analysis.unsure_word_confidence`` (0.7 as shipped), the same line the mapped ``unsure`` flag,
    the refine brief and bulk approve use. Suppressed words are not listed.
    """
    ws = ProjectWorkspace.open(project_path)
    return to_json(TranscriptService(ws).low_confidence_words(threshold))


def verify_transcript_tool(
    project_path: str,
    track_id: str,
    corrections: JsonObjectList,
) -> str:
    """Apply bulk corrections and mark words verified on a track's transcript."""
    return to_json(
        submit_host_command_result(
            project_path,
            "VerifyTranscript",
            {"track_id": track_id, "corrections": corrections},
        )
    )


def low_audibility_words_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
) -> str:
    """List words too quiet to hear relative to the mix."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(AnalysisService(ws).low_audibility_words(track_id=track_id, speaker=speaker))


def apply_low_audibility_suppression_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    words: JsonObjectList | None = None,
) -> str:
    """Suppress low-audibility transcript words, optionally only ``words``; leaves audio unchanged."""
    return to_json(
        submit_host_command_result(
            project_path,
            "SuppressLowAudibility",
            {"track_id": track_id, "speaker": speaker, "words": words},
        )
    )


def gate_overreach_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
) -> str:
    """Report where noise gating muted speech on a track."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(AnalysisService(ws).gate_overreach(track_id=track_id, speaker=speaker))


def audibility_map_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
) -> str:
    """Return per-word audibility scores for a track or speaker."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(AnalysisService(ws).audibility_map(track_id=track_id, speaker=speaker))


def flagged_words_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
) -> str:
    """List words flagged for review (suppressed, low-audibility, or bleed)."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(AnalysisService(ws).flagged_words(track_id=track_id, speaker=speaker))


def reconciliation_status_tool(project_path: str) -> str:
    """Report transcript/timeline reconciliation status (stale vs current)."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(AnalysisService(ws).reconciliation_status())


def reconcile_transcript_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    dry_run: bool | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> str:
    """Re-run transcript/timeline reconciliation; dry_run previews without applying."""
    if dry_run is True:
        ws = ProjectWorkspace.open(project_path)
        return to_json(
            AnalysisService(ws).preview_reconcile_transcript(
                track_id=track_id, speaker=speaker, start_sec=start_sec, end_sec=end_sec
            )
        )
    return to_json(
        submit_host_command_result(
            project_path,
            "ReconcileTranscript",
            {
                "track_id": track_id,
                "speaker": speaker,
                "dry_run": dry_run,
                "start_sec": start_sec,
                "end_sec": end_sec,
            },
        )
    )


def bleed_words_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> str:
    """List words contaminated by another speaker's microphone bleed."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        AnalysisService(ws).list_bleed_words(
            track_id=track_id,
            speaker=speaker,
            start_sec=start_sec,
            end_sec=end_sec,
        )
    )


def apply_bleed_suppression_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    words: JsonObjectList | None = None,
    exclude_words: JsonObjectList | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
    apply: bool = True,
    dry_run: bool = False,
) -> str:
    """Suppress mic-bleed words (dry_run previews without applying)."""
    payload = {
        "track_id": track_id,
        "speaker": speaker,
        "words": words,
        "exclude_words": exclude_words,
        "start_sec": start_sec,
        "end_sec": end_sec,
    }
    if not (apply and not dry_run):
        checked = validate_payload("SuppressBleed", payload)
        ws = ProjectWorkspace.open(project_path)
        return to_json(
            AnalysisService(ws).preview_suppress_bleed(
                track_id=track_id,
                speaker=speaker,
                word_keys=checked["words"],
                exclude_word_keys=checked["exclude_words"],
                start_sec=start_sec,
                end_sec=end_sec,
            )
        )
    return to_json(submit_host_command_result(project_path, "SuppressBleed", payload))


def overlap_duplicates_tool(
    project_path: str,
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> str:
    """Find duplicate words across tracks in an overlap window."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(AnalysisService(ws).overlap_duplicates(start_sec=start_sec, end_sec=end_sec))


def apply_transcript_gate_tool(
    project_path: str,
    track_id: str | None = None,
    speaker: str | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
    apply: bool = True,
    dry_run: bool = False,
    align_retained_bleed: bool = True,
    override_placement_lock: bool = False,
) -> str:
    """Apply an acoustic bleed plan to fresh dialogue stems and persist its source scope.

    Retained speech and unresolved audio stay open. Later renders reuse the plan's
    policy and scope. Supported local retained-bleed alignment runs by default and
    respects saved timing choices. Alignment can trigger normal transcript reconciliation.
    """
    ws = ProjectWorkspace.open(project_path)
    params: dict[str, Any] = {
        "track_id": track_id,
        "speaker": speaker,
        "start_sec": start_sec,
        "end_sec": end_sec,
        "align_retained_bleed": align_retained_bleed,
        "override_placement_lock": override_placement_lock,
    }
    if not apply or dry_run:
        return to_json(AnalysisService(ws).preview_bleed_mute(**params))
    return to_json(
        run_audio_edit(ws, "apply_bleed_mute", params, lock_timeout=REQUEST_RENDER_LOCK_TIMEOUT_SEC)
    )


def register(mcp: MCPServer) -> None:
    """Register transcript tools on the MCP server."""
    mutating = {
        correct_transcript_tool,
        correct_transcript_phrase_tool,
        set_word_suppressed_tool,
        set_word_automatic_tool,
        set_words_ignored_tool,
        apply_transcript_cleanup_tool,
        verify_transcript_tool,
        apply_low_audibility_suppression_tool,
        reconcile_transcript_tool,
        apply_bleed_suppression_tool,
    }
    mcp.tool()(transcribe_track)
    mcp.tool()(get_transcript)
    mcp.tool()(get_transcript_vocabulary_tool)
    mcp.tool()(set_transcript_vocabulary_tool)
    mcp.tool()(export_transcript)
    mcp.tool()(list_exported_transcripts)
    mcp.tool()(precorrect_transcript_tool)
    mcp.tool()(transcript_refine_status_tool)
    mcp.tool()(transcript_refine_brief_tool)
    mcp.tool()(transcript_refine_done_tool)
    mcp.tool()(transcript_refine_waive_tool)
    for fn in (
        correct_transcript_tool,
        correct_transcript_phrase_tool,
        set_word_suppressed_tool,
        set_word_automatic_tool,
        set_word_timing_tool,
        find_replace_transcript_tool,
        set_words_ignored_tool,
        apply_transcript_cleanup_tool,
        low_confidence_words_tool,
        verify_transcript_tool,
        low_audibility_words_tool,
        apply_low_audibility_suppression_tool,
        gate_overreach_tool,
        audibility_map_tool,
        flagged_words_tool,
        reconciliation_status_tool,
        reconcile_transcript_tool,
        bleed_words_tool,
        apply_bleed_suppression_tool,
        overlap_duplicates_tool,
        apply_transcript_gate_tool,
    ):
        mcp.tool()(notify_after_mutation(fn) if fn in mutating else fn)

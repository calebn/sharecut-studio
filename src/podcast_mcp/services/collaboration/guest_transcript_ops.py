"""The Editor's transcript work, shared by the HTTP twins and the guest MCP tools.

Each function is the body of a ``transcript_*`` row of ``GUEST_OWNER_ROUTES``, taking the share's
workspace and the already-validated fields of its request. A refusal is a ``GuestRefusal``: the
HTTP adapter sends its status, text and code as they are, and a guest MCP tool sends the code with
the fixed guest copy. Nothing here takes a path from a client.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Mapping, Sequence
from dataclasses import asdict
from typing import Any

from podcast_mcp.edits.review_gate import ShareSource
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.guest_project_ops import guest_only_keys, guest_refusal
from podcast_mcp.services.collaboration.share_capabilities import SHARE_ACTOR_PREFIX
from podcast_mcp.services.document import (
    ExportBusyError,
    TranscriptEmptyError,
    TranscriptService,
    TranscriptTimingChangedError,
    WordTimingTarget,
)
from podcast_mcp.services.media import (
    TranscriptChangedSinceReviewError,
    TranscriptPrecorrectService,
    TranscriptRefineService,
    VocabularyConflictError,
)
from podcast_mcp.util.coded_error import CodedError

log = logging.getLogger(__name__)

GUEST_NOTE_PREFIX = "From an Editor link: "
GUEST_VOCABULARY_KEYS = (
    "terms",
    "guest_names",
    "prompt_limit",
    "revision",
    "needs_retranscription",
)
# What the transcript check shows a guest; the gate's report also names a sidecar path and the
# stored fingerprint, which stay on the host.
GUEST_REFINE_KEYS = (
    "status",
    "clear",
    "stale",
    "mode",
    "fingerprint",
    "source",
    "notes",
    "updated_at",
    "hint",
    "low_confidence_words",
    "low_confidence_threshold",
)
GUEST_EXPORT_KEYS = ("language", "turns", "duration_sec", "preview", "cue_sample", "files", "text")
GUEST_EXPORT_FILE_KEYS = ("format", "name", "bytes", "language", "written", "current")
GUEST_EXPORTED_KEYS = ("format", "name", "mime", "language", "bytes", "modified", "current")
# A transcript write is refused, not queued, while two are running; a dry run writes nothing.
EXPORT_SLOTS = threading.BoundedSemaphore(2)


def _guest_note(text: str | None) -> str | None:
    stripped = (text or "").strip()
    return f"{GUEST_NOTE_PREFIX}{stripped}" if stripped else None


def _refine_view(report: dict[str, Any]) -> dict[str, Any]:
    source = report.get("source")
    guest = isinstance(source, str) and source.startswith(SHARE_ACTOR_PREFIX)
    missing = [key for key in GUEST_REFINE_KEYS if key not in report]
    if missing:
        raise RuntimeError(f"transcript check report lacks {missing}")
    view = {key: report[key] for key in GUEST_REFINE_KEYS}
    # The host's notes are never shown, nor an Editor's own.
    return {**view, "notes": "", "source": "guest" if guest else source}


def guest_vocabulary(ws: ProjectWorkspace) -> dict[str, Any]:
    return guest_only_keys(
        TranscriptPrecorrectService.vocabulary_status(ws.path), GUEST_VOCABULARY_KEYS
    )


def guest_save_vocabulary(
    ws: ProjectWorkspace,
    who: str,
    *,
    terms: list[str],
    guest_names: list[str],
    base_revision: str | None,
) -> dict[str, Any]:
    try:
        saved = TranscriptPrecorrectService(ws).set_vocabulary(
            terms=terms, guest_names=guest_names, base_revision=base_revision
        )
    except VocabularyConflictError as exc:
        raise guest_refusal(409, "vocabulary_conflict") from exc
    log.info("guest vocabulary saved by=%s", who)
    return guest_only_keys(saved, GUEST_VOCABULARY_KEYS)


def guest_refine_status(ws: ProjectWorkspace) -> dict[str, Any]:
    return _refine_view(TranscriptRefineService(ws).gate_status())


def guest_refine_done(
    ws: ProjectWorkspace,
    source: ShareSource,
    *,
    notes: str | None,
    expected_fingerprint: str | None,
) -> dict[str, Any]:
    try:
        report = TranscriptRefineService(ws).mark_checked(
            notes=_guest_note(notes), source=source, expected_fingerprint=expected_fingerprint
        )
    except TranscriptChangedSinceReviewError as exc:
        raise guest_refusal(409, "transcript_changed") from exc
    return _refine_view(report)


def guest_refine_waive(ws: ProjectWorkspace, source: ShareSource, *, reason: str) -> dict[str, Any]:
    refine = TranscriptRefineService(ws)
    report = refine.gate_status()
    if not report["clear"]:
        refine.waive(reason=_guest_note(reason) or "", source=source)
        report = refine.gate_status()
    return _refine_view(report)


def guest_replacement_preview(
    ws: ProjectWorkspace, *, search: str, replacement: str, match_case: bool
) -> dict[str, Any]:
    return TranscriptService(ws).preview_transcript_replacement(
        search, replacement, match_case=match_case
    )


def guest_word_timing_context(
    ws: ProjectWorkspace,
    *,
    target: Mapping[str, Any],
    expected_text: str,
    expected_start: float,
    expected_end: float,
) -> dict[str, Any]:
    try:
        return TranscriptService(ws).word_timing_context(
            WordTimingTarget(**target),
            expected_text=expected_text,
            expected_start=expected_start,
            expected_end=expected_end,
        )
    except TranscriptTimingChangedError as exc:
        raise guest_refusal(409, "transcript_timing_changed") from exc
    except CodedError:
        # Load-bearing: CodedKeyError and CodedFileNotFoundError are KeyError and
        # FileNotFoundError too, and must keep their own code, not become word_not_found.
        raise
    except (KeyError, FileNotFoundError) as exc:
        raise guest_refusal(404, "word_not_found") from exc


def guest_export_transcript(
    ws: ProjectWorkspace,
    who: str,
    *,
    formats: Sequence[str],
    dry_run: bool,
    with_text: bool,
) -> dict[str, Any]:
    """Writes into the project's export folder; a write is refused, not queued, while two run."""
    writes = not dry_run
    if writes and not EXPORT_SLOTS.acquire(blocking=False):
        raise guest_refusal(503, "export_busy")
    try:
        result = TranscriptService(ws).export(formats, dry_run=dry_run, with_text=with_text)
    except ExportBusyError as exc:
        raise guest_refusal(503, "export_busy") from exc
    except TranscriptEmptyError as exc:
        raise guest_refusal(409, "transcript_empty") from exc
    finally:
        if writes:
            EXPORT_SLOTS.release()
    if writes:
        log.info("guest transcript export by=%s formats=%s", who, ",".join(formats))
    view = guest_only_keys(asdict(result), GUEST_EXPORT_KEYS)
    view["files"] = [guest_only_keys(row, GUEST_EXPORT_FILE_KEYS) for row in view["files"]]
    return view


def guest_exports(ws: ProjectWorkspace) -> list[dict[str, Any]]:
    return [
        guest_only_keys(asdict(row), GUEST_EXPORTED_KEYS)
        for row in TranscriptService(ws).exported()
    ]

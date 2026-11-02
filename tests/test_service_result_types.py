"""Ratchet for #1811: service functions that return a bare ``dict``.

Each entry is the exact number of functions under ``services/`` annotated ``-> dict`` or
``-> dict[...]`` in that file. A typed result model removes entries; the count may only go
down, and a lower count must be written here so the list stays exact.
"""

from __future__ import annotations

import ast
from collections import Counter
from pathlib import Path

SERVICES = Path(__file__).resolve().parents[1] / "src" / "podcast_mcp" / "services"

DICT_RETURNS: dict[str, int] = {
    "app/recent_projects.py": 2,
    "app/review_gate.py": 5,
    "app/studio_host.py": 2,
    "collaboration/guest_insight_ops.py": 4,
    "collaboration/guest_progress.py": 1,
    "collaboration/guest_project_ops.py": 8,
    "collaboration/guest_transcript_ops.py": 9,
    "collaboration/record_share.py": 2,
    "collaboration/review.py": 5,
    "collaboration/review_shares.py": 1,
    "collaboration/session_control.py": 6,
    "collaboration/share.py": 27,
    "collaboration/share_registry.py": 2,
    "collaboration/tunnel.py": 1,
    "collaboration/tunnel_status.py": 4,
    "document/analysis.py": 32,
    "document/bleed_inspection.py": 1,
    "document/edit.py": 8,
    "document/effects.py": 6,
    "document/episode.py": 11,
    "document/feed.py": 5,
    "document/golden_ear.py": 7,
    "document/history.py": 4,
    "document/play_compose.py": 2,
    "document/play_pending.py": 1,
    "document/play_session.py": 2,
    "document/segment_insert.py": 2,
    "document/service_base.py": 4,
    "document/session_suggestion.py": 7,
    "document/suggested_actions.py": 1,
    "document/timeline.py": 37,
    "document/transcript.py": 7,
    "document_sync/capabilities.py": 1,
    "document_sync/commands.py": 1,
    "document_sync/handlers/__init__.py": 1,
    "document_sync/handlers/comments.py": 7,
    "document_sync/handlers/edits.py": 44,
    "document_sync/handlers/episode.py": 9,
    "document_sync/handlers/feed.py": 2,
    "document_sync/handlers/history.py": 2,
    "document_sync/handlers/markers.py": 8,
    "document_sync/handlers/session_suggestion.py": 3,
    "document_sync/handlers/transcript.py": 9,
    "document_sync/host_submit.py": 4,
    "document_sync/payloads.py": 4,
    "document_sync/projection_delta.py": 5,
    "document_sync/service.py": 19,
    "jobs/audio_edits.py": 1,
    "jobs/catalog.py": 1,
    "jobs/job.py": 5,
    "jobs/manager.py": 3,
    "media/ingest.py": 5,
    "media/media_store.py": 4,
    "media/proxy_media.py": 2,
    "media/proxy_variants.py": 3,
    "media/review_media.py": 3,
    "media/speaker.py": 13,
    "media/transcript_precorrect.py": 6,
    "media/transcript_refine.py": 3,
    "pipeline/bootstrap.py": 4,
    "pipeline/config.py": 10,
    "pipeline/preview.py": 1,
    "pipeline/service.py": 4,
    "record/commands.py": 1,
    "record/control.py": 14,
    "record/landing.py": 9,
    "record/landing_math.py": 2,
    "record/live_comments.py": 1,
    "record/participants.py": 1,
    "record/preflight.py": 2,
    "record/service.py": 8,
    "record/sessions.py": 2,
    "record/signal.py": 2,
    "record/track_choice.py": 2,
    "record/track_match.py": 5,
    "record/upload.py": 3,
    "remote_mcp/limits.py": 1,
    "remote_mcp/protocol.py": 6,
    "remote_mcp/tools.py": 34,
    "session_sync/commands.py": 1,
    "session_sync/hub.py": 1,
    "session_sync/log.py": 5,
    "session_sync/presence_delta.py": 5,
    "session_sync/service.py": 13,
    "session_sync/snapshot.py": 6,
    "session_sync/viewer.py": 2,
    "share_auth/oauth_credentials.py": 1,
    "share_auth/oauth_flow.py": 2,
    "share_auth/passkeys.py": 4,
    "share_auth/store.py": 3,
    "support/diagnostics.py": 6,
    "support/doctor.py": 3,
    "support/report_submission.py": 2,
}


def _is_dict(annotation: ast.expr | None) -> bool:
    if isinstance(annotation, ast.Subscript):
        annotation = annotation.value
    return isinstance(annotation, ast.Name) and annotation.id == "dict"


def _counts() -> dict[str, int]:
    found: Counter[str] = Counter()
    for path in sorted(SERVICES.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and _is_dict(node.returns):
                found[path.relative_to(SERVICES).as_posix()] += 1
    return dict(found)


def test_service_dict_returns_match_the_allowlist_exactly() -> None:
    assert _counts() == DICT_RETURNS


def test_comment_service_returns_typed_results() -> None:
    assert "document/comment.py" not in DICT_RETURNS

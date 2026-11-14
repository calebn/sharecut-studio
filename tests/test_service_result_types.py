"""Ratchet for #1811: service functions that return a bare ``dict``.

Each entry caps functions under ``services/`` with a bare dictionary return, including
``Optional`` and ``Union`` members, qualified names, quoted annotations, and ``|`` unions.
``Annotated`` wrappers count only their first type argument; metadata is ignored.
Dictionaries nested inside other containers do not count. A typed result model lowers a
cap and the lowered cap must be written here. A count above its cap fails, so a file
cannot gain a bare dictionary return. A count below its cap does not fail, so two PRs
that each type a different function cannot turn main red. A cap that no longer matches
any function at all is reported as stale.
"""

from __future__ import annotations

import ast
from collections import Counter
from pathlib import Path

import pytest

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
    "collaboration/review_shares.py": 3,
    "collaboration/session_control.py": 7,
    "collaboration/share.py": 28,
    "collaboration/share_registry.py": 4,
    "collaboration/tunnel.py": 1,
    "collaboration/tunnel_status.py": 4,
    "document/analysis.py": 32,
    "document/bleed_inspection.py": 1,
    "document/cross_process_sync.py": 2,
    "document/edit.py": 8,
    "document/feed.py": 6,
    "document/golden_ear.py": 8,
    "document/history.py": 4,
    "document/play_compose.py": 2,
    "document/play_pending.py": 1,
    "document/play_session.py": 5,
    "document/segment_insert.py": 1,
    "document/service_base.py": 4,
    "document/session_suggestion.py": 9,
    "document/timeline.py": 37,
    "document/transcript.py": 7,
    "document_sync/capabilities.py": 1,
    "document_sync/commands.py": 1,
    "document_sync/handlers/comments.py": 7,
    "document_sync/handlers/edits.py": 45,
    "document_sync/handlers/episode.py": 9,
    "document_sync/handlers/feed.py": 2,
    "document_sync/handlers/history.py": 2,
    "document_sync/handlers/markers.py": 10,
    "document_sync/handlers/session_suggestion.py": 3,
    "document_sync/handlers/transcript.py": 9,
    "document_sync/host_submit.py": 4,
    "document_sync/payloads.py": 4,
    "document_sync/projection_delta.py": 5,
    "document_sync/registry.py": 1,
    "document_sync/service.py": 23,
    "document_sync/snapshot_cache.py": 1,
    "jobs/audio_edits.py": 1,
    "jobs/catalog.py": 1,
    "jobs/job.py": 6,
    "jobs/manager.py": 3,
    "media/ingest.py": 6,
    "media/media_store.py": 4,
    "media/object_store_cors.py": 1,
    "media/proxy_media.py": 2,
    "media/proxy_variants.py": 3,
    "media/review_media.py": 3,
    "media/speaker.py": 14,
    "media/transcript_precorrect.py": 6,
    "media/transcript_refine.py": 3,
    "pipeline/bootstrap.py": 4,
    "pipeline/config.py": 12,
    "pipeline/preview.py": 1,
    "pipeline/service.py": 5,
    "record/commands.py": 1,
    "record/control.py": 15,
    "record/landing.py": 9,
    "record/landing_math.py": 2,
    "record/live_comments.py": 2,
    "record/participants.py": 1,
    "record/preflight.py": 2,
    "record/service.py": 10,
    "record/sessions.py": 3,
    "record/signal.py": 2,
    "record/track_choice.py": 2,
    "record/track_match.py": 5,
    "record/upload.py": 4,
    "remote_mcp/limits.py": 1,
    "remote_mcp/protocol.py": 7,
    "remote_mcp/tools.py": 34,
    "session_sync/commands.py": 2,
    "session_sync/hub.py": 2,
    "session_sync/log.py": 14,
    "session_sync/presence_delta.py": 5,
    "session_sync/service.py": 17,
    "session_sync/snapshot.py": 6,
    "session_sync/viewer.py": 2,
    "share_auth/oauth_credentials.py": 1,
    "share_auth/oauth_flow.py": 2,
    "share_auth/passkeys.py": 4,
    "share_auth/store.py": 13,
    "support/diagnostics.py": 7,
    "support/doctor.py": 3,
    "support/report_submission.py": 2,
}


def _is_dict(annotation: ast.expr | None) -> bool:
    if isinstance(annotation, ast.Constant) and isinstance(annotation.value, str):
        annotation = ast.parse(annotation.value, mode="eval").body
    if isinstance(annotation, ast.BinOp):
        return _is_dict(annotation.left) or _is_dict(annotation.right)
    if isinstance(annotation, ast.Subscript):
        outer = annotation.value
        name = (
            outer.id
            if isinstance(outer, ast.Name)
            else outer.attr
            if isinstance(outer, ast.Attribute)
            else None
        )
        if name == "Annotated":
            return (
                isinstance(annotation.slice, ast.Tuple)
                and len(annotation.slice.elts) >= 2
                and _is_dict(annotation.slice.elts[0])
            )
        if name in {"Optional", "Union"}:
            members = (
                annotation.slice.elts
                if isinstance(annotation.slice, ast.Tuple)
                else [annotation.slice]
            )
            return any(_is_dict(member) for member in members)
        annotation = outer
    if isinstance(annotation, ast.Attribute):
        return annotation.attr in {"dict", "Dict"}
    return isinstance(annotation, ast.Name) and annotation.id in {"dict", "Dict"}


def _counts() -> dict[str, int]:
    found: Counter[str] = Counter()
    for path in sorted(SERVICES.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and _is_dict(node.returns):
                found[path.relative_to(SERVICES).as_posix()] += 1
    return dict(found)


def _over_cap(counts: dict[str, int], caps: dict[str, int]) -> dict[str, int]:
    return {f: n for f, n in counts.items() if n > caps.get(f, 0)}


def _stale(counts: dict[str, int], caps: dict[str, int]) -> list[str]:
    return sorted(f for f in caps if f not in counts)


def test_service_dict_returns_stay_within_the_allowlist() -> None:
    over = _over_cap(_counts(), DICT_RETURNS)
    assert not over, f"new bare dict returns (cap in DICT_RETURNS): {over}"


def test_the_allowlist_has_no_stale_files() -> None:
    stale = _stale(_counts(), DICT_RETURNS)
    assert not stale, f"remove from DICT_RETURNS, no bare dict returns left: {stale}"


def test_the_cap_check_fails_one_above_a_cap_and_for_an_uncapped_file() -> None:
    assert _over_cap({"a.py": 2}, {"a.py": 2}) == {}
    assert _over_cap({"a.py": 1}, {"a.py": 2}) == {}
    assert _over_cap({"a.py": 3}, {"a.py": 2}) == {"a.py": 3}
    assert _over_cap({"new.py": 1}, {"a.py": 2}) == {"new.py": 1}
    assert _stale({"a.py": 1}, {"a.py": 2, "gone.py": 1}) == ["gone.py"]


def _annotation(text: str) -> ast.expr:
    function = ast.parse(f"def f() -> {text}: ...").body[0]
    assert isinstance(function, ast.FunctionDef)
    assert function.returns is not None
    return function.returns


def test_the_ratchet_recognises_every_bare_dict_spelling() -> None:
    flagged = [
        "dict",
        "dict[str, Any]",
        "Dict[str, int]",
        "builtins.dict",
        "typing.Dict[str, int]",
        "Optional[dict[str, Any]]",
        "typing.Optional[dict[str, Any]]",
        "Union[dict, None]",
        "typing.Union[None, dict[str, Any]]",
        "typing.Union[str, typing.Optional[dict]]",
        "'typing.Optional[dict[str, Any]]'",
        "Optional['Union[dict, None]']",
        "dict | None",
        "None | dict",
        "'dict[str, Any]'",
        "Annotated[dict, 'metadata']",
    ]
    ignored = [
        "str",
        "list[dict]",
        "Model",
        "None",
        "Mapping[str, Any]",
        "Union[list[dict], None]",
        "typing.Optional[Mapping[str, Any]]",
        "typing.Union[Model, None]",
        "list[typing.Optional[dict]]",
        "Mapping[str, dict]",
        "tuple[dict, None]",
    ]
    assert all(_is_dict(_annotation(text)) for text in flagged)
    assert not any(_is_dict(_annotation(text)) for text in ignored)


@pytest.mark.parametrize("definition", ["def", "async def"])
def test_the_scanner_counts_nullable_dict_returns(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, definition: str
) -> None:
    annotations = [
        "typing.Optional[dict[str, Any]]",
        "Union[dict, None]",
        "typing.Union[None, dict[str, Any]]",
        "typing.Union[str, typing.Optional[dict]]",
        "'typing.Optional[dict[str, Any]]'",
        "Optional['Union[dict, None]']",
    ]
    (tmp_path / "nullable.py").write_text(
        "\n".join(
            f"{definition} f{index}() -> {annotation}: ..."
            for index, annotation in enumerate(annotations)
        ),
        encoding="utf-8",
    )
    (tmp_path / "containers.py").write_text(
        f"{definition} f() -> typing.Union[list[dict], tuple[dict], None]: ...",
        encoding="utf-8",
    )
    monkeypatch.setattr(f"{__name__}.SERVICES", tmp_path)

    counts = _counts()
    assert counts == {"nullable.py": 6}
    assert _over_cap(counts, {}) == {"nullable.py": 6}
    assert _over_cap(counts, {"nullable.py": 6}) == {}
    assert _over_cap(counts, {"nullable.py": 5}) == {"nullable.py": 6}

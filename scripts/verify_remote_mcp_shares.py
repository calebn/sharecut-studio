#!/usr/bin/env python3
"""Verify capability-scoped remote MCP against a live ``podcast gui`` host.

Assumes::

    PODCAST_REMOTE_MCP=1 podcast gui --project <episode.project.json> --no-open

Example::

    uv run python scripts/verify_remote_mcp_shares.py \\
      --project /path/to/episode.project.json

Without ``--project`` the committed ``aligned_dialogue`` fixture is copied into a
temporary relocated workspace first, so publishing the review version never
writes into ``tests/fixtures/``. An explicit ``--project`` runs in place.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from podcast_mcp.project_io import copy_relocated_workspace
from podcast_mcp.services.remote_mcp.allowlist import tools_for_capabilities
from podcast_mcp.services.review import ReviewService
from podcast_mcp.services.share import ShareService
from podcast_mcp.services.workspace import ProjectWorkspace

_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PROJECT = _ROOT / "tests" / "fixtures" / "aligned_dialogue" / "episode.project.json"

TIERS: list[tuple[str, list[str]]] = [
    ("A_play", ["play", "mcp"]),
    ("B_view", ["play", "view", "mcp"]),
    ("C_comment", ["play", "view", "comment", "reply", "mcp"]),
    ("D_action", ["play", "view", "comment", "action", "mcp"]),
    ("E_suggest", ["play", "view", "suggest", "mcp"]),
    ("F_edit", ["play", "view", "edit", "mcp"]),
    ("G_no_mcp", ["play", "view"]),
]


@dataclass
class CheckResult:
    tier: str
    name: str
    ok: bool
    detail: str = ""


@dataclass
class TierReport:
    tier: str
    caps: list[str]
    token: str | None = None
    checks: list[CheckResult] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return all(c.ok for c in self.checks)


def _http_json(
    method: str,
    url: str,
    body: dict[str, Any] | None = None,
    *,
    accept: str = "application/json",
) -> tuple[int, Any]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Accept": accept,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
            payload: Any = json.loads(raw) if raw else None
            return resp.status, payload
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8")
        try:
            payload = json.loads(raw) if raw else {"detail": raw}
        except json.JSONDecodeError:
            payload = {"detail": raw}
        return exc.code, payload


def mcp_rpc(
    base: str, token: str, method: str, params: dict[str, Any] | None = None
) -> dict[str, Any]:
    status, payload = _http_json(
        "POST",
        f"{base.rstrip('/')}/mcp/{token}/mcp",
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params or {},
        },
    )
    if status != 200:
        raise RuntimeError(f"MCP HTTP {status}: {payload}")
    if not isinstance(payload, dict):
        raise RuntimeError(f"MCP non-object response: {payload!r}")
    return payload


def _no_host_paths(blob: str) -> bool:
    return "/Users/" not in blob and "workspace_dir" not in blob


def _capability_error(msg: str) -> bool:
    low = msg.lower()
    return (
        "share capabilities do not allow" in low
        or "does not allow" in low
        or "unknown tool" in low
        or "method not found" in low
    )


def _relocated_default_project(tmp_root: Path) -> Path:
    """Copy the committed fixture under *tmp_root* so the run never writes into it."""
    return copy_relocated_workspace(DEFAULT_PROJECT, tmp_root / "workspace")


def _ensure_review_version(ws: ProjectWorkspace) -> str:
    active = ws.project.review.active_version_id
    if active:
        return active
    ver = ReviewService(ws).publish(label="remote-mcp-verify")
    return str(ver["id"])


def _assert(report: TierReport, name: str, ok: bool, detail: str = "") -> None:
    report.checks.append(CheckResult(report.tier, name, ok, detail))
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {name}" + (f" - {detail}" if detail else ""))


def verify_tier_no_mcp(base: str, token: str, report: TierReport) -> None:
    status, payload = _http_json("GET", f"{base.rstrip('/')}/mcp/{token}")
    _assert(
        report,
        "info_forbidden",
        status == 403,
        f"status={status} body={payload!r}",
    )


def _first_track_id(ws: ProjectWorkspace) -> str:
    tracks = list(ws.project.tracks)
    if not tracks:
        return "host"
    return tracks[0].id


def verify_mcp_tier(
    base: str,
    token: str,
    caps: list[str],
    report: TierReport,
    *,
    track_id: str,
) -> None:
    expected = tools_for_capabilities(caps)

    init = mcp_rpc(
        base,
        token,
        "initialize",
        {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "verify-remote-mcp", "version": "0"},
        },
    )
    _assert(
        report,
        "initialize",
        "result" in init
        and init["result"].get("serverInfo", {}).get("name") == "podcast-guest-mcp",
        str(init.get("error") or init.get("result", {}).get("serverInfo")),
    )

    listed = mcp_rpc(base, token, "tools/list", {})
    names = {t["name"] for t in listed.get("result", {}).get("tools", [])}
    _assert(
        report,
        "tools_list_exact",
        names == set(expected),
        f"extra={sorted(names - expected)} missing={sorted(expected - names)}",
    )
    _assert(
        report,
        "no_host_tools",
        "pipeline_run" not in names and "episode_create" not in names,
        f"names={sorted(names)}",
    )

    # Allowed calls
    if "guest_get_review_summary" in expected:
        r = mcp_rpc(
            base,
            token,
            "tools/call",
            {"name": "guest_get_review_summary", "arguments": {}},
        )
        text = json.dumps(r)
        _assert(
            report,
            "call_review_summary",
            "error" not in r and _no_host_paths(text),
            str(r.get("error") or "ok"),
        )

    if "guest_audio_info" in expected:
        r = mcp_rpc(
            base,
            token,
            "tools/call",
            {"name": "guest_audio_info", "arguments": {}},
        )
        text = r.get("result", {}).get("content", [{}])[0].get("text", "")
        _assert(
            report,
            "call_audio_info",
            "error" not in r and f"/api/review/{token}/" in text and "/Users/" not in text,
            text[:200],
        )

    if "guest_get_project" in expected:
        r = mcp_rpc(
            base,
            token,
            "tools/call",
            {"name": "guest_get_project", "arguments": {}},
        )
        text = r.get("result", {}).get("content", [{}])[0].get("text", "")
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            payload = {}
        _assert(
            report,
            "call_get_project",
            "error" not in r and payload.get("project_path") == "" and _no_host_paths(text),
            f"project_path={payload.get('project_path')!r}",
        )
        for tool in (
            "guest_list_clips",
            "guest_list_pending_edits",
            "guest_list_applied_edits",
            "guest_render_status",
            "guest_list_comments",
        ):
            if tool not in expected:
                continue
            rr = mcp_rpc(base, token, "tools/call", {"name": tool, "arguments": {}})
            _assert(report, f"call_{tool}", "error" not in rr, str(rr.get("error")))

        if "guest_search_transcript" in expected:
            rr = mcp_rpc(
                base,
                token,
                "tools/call",
                {"name": "guest_search_transcript", "arguments": {"query": "the", "limit": 5}},
            )
            _assert(
                report,
                "call_search_transcript",
                "error" not in rr and _no_host_paths(json.dumps(rr)),
                str(rr.get("error") or "ok"),
            )

        if "guest_pending_preview" in expected:
            rr = mcp_rpc(
                base,
                token,
                "tools/call",
                {
                    "name": "guest_pending_preview",
                    "arguments": {"edit_id": "__missing__"},
                },
            )
            _assert(
                report,
                "call_pending_preview_missing",
                _no_host_paths(json.dumps(rr)),
                str(rr.get("error") or "ok")[:200],
            )

    comment_id: str | None = None
    if "guest_add_comment" in expected:
        r = mcp_rpc(
            base,
            token,
            "tools/call",
            {
                "name": "guest_add_comment",
                "arguments": {
                    "body": "remote-mcp-verify comment",
                    "author": "verifier",
                    "timeline_start": 1.0,
                    "timeline_end": 2.0,
                },
            },
        )
        text = r.get("result", {}).get("content", [{}])[0].get("text", "")
        try:
            payload = json.loads(text)
            comment_id = (payload.get("comment") or {}).get("id")
        except json.JSONDecodeError:
            comment_id = None
        _assert(
            report,
            "call_add_comment",
            "error" not in r and bool(comment_id),
            str(r.get("error") or comment_id),
        )

    if "guest_add_reply" in expected and comment_id:
        r = mcp_rpc(
            base,
            token,
            "tools/call",
            {
                "name": "guest_add_reply",
                "arguments": {
                    "comment_id": comment_id,
                    "body": "remote-mcp-verify reply",
                    "author": "verifier",
                },
            },
        )
        _assert(report, "call_add_reply", "error" not in r, str(r.get("error")))

    if "guest_set_action_done" in expected:
        # Need an action item - add via comment+action if possible is host-only;
        # probe with bogus ids and accept capability-ok tool reaching domain KeyError,
        # OR skip if we can't create actions via guest MCP.
        r = mcp_rpc(
            base,
            token,
            "tools/call",
            {
                "name": "guest_set_action_done",
                "arguments": {
                    "comment_id": comment_id or "missing",
                    "action_id": "missing",
                    "done": True,
                },
            },
        )
        # Tool is allowed: either success or domain not-found - not a capability deny.
        err = r.get("error") or {}
        msg = str(err.get("message") or "")
        "error" not in r or not _capability_error(msg) or "not found" in msg.lower()
        # Prefer: capability allow means we don't get "do not allow tool"
        deny = "do not allow tool" in msg.lower()
        _assert(
            report,
            "call_set_action_done_reachable",
            not deny,
            msg or "ok/domain-error",
        )

    if "guest_submit_document_command" in expected:
        if "suggest" in caps:
            r = mcp_rpc(
                base,
                token,
                "tools/call",
                {
                    "name": "guest_submit_document_command",
                    "arguments": {
                        "type": "SuggestPendingEdit",
                        "payload": {
                            "track_id": track_id,
                            "start": 1.0,
                            "end": 1.2,
                            "reason": "remote-mcp-verify",
                        },
                    },
                },
            )
            # May fail domain validation if track missing - still not capability deny for Suggest
            err = r.get("error") or {}
            msg = str(err.get("message") or "")
            _assert(
                report,
                "suggest_SuggestPendingEdit_not_cap_deny",
                "do not allow document command" not in msg.lower()
                and "do not allow tool" not in msg.lower(),
                msg or "ok",
            )
            bad = mcp_rpc(
                base,
                token,
                "tools/call",
                {
                    "name": "guest_submit_document_command",
                    "arguments": {
                        "type": "ApproveEdits",
                        "payload": {"decision_ids": []},
                    },
                },
            )
            bmsg = str((bad.get("error") or {}).get("message") or "")
            _assert(
                report,
                "suggest_ApproveEdits_denied",
                "error" in bad and _capability_error(bmsg),
                bmsg,
            )

        if "edit" in caps:
            # Empty approve should be allowed by cap (may no-op / domain error)
            r = mcp_rpc(
                base,
                token,
                "tools/call",
                {
                    "name": "guest_submit_document_command",
                    "arguments": {
                        "type": "ApproveEdits",
                        "payload": {"decision_ids": []},
                    },
                },
            )
            err = r.get("error") or {}
            msg = str(err.get("message") or "")
            _assert(
                report,
                "edit_ApproveEdits_not_cap_deny",
                "do not allow document command" not in msg.lower()
                and "do not allow tool" not in msg.lower(),
                msg or "ok",
            )

    # Denied tools (present in ALL_GUEST but not this tier)
    denied_candidates = sorted(
        {
            "guest_get_project",
            "guest_add_comment",
            "guest_set_action_done",
            "guest_submit_document_command",
        }
        - expected
    )
    for tool in denied_candidates:
        r = mcp_rpc(
            base,
            token,
            "tools/call",
            {"name": tool, "arguments": {}},
        )
        err = r.get("error") or {}
        msg = str(err.get("message") or "")
        _assert(
            report,
            f"deny_{tool}",
            "error" in r and _capability_error(msg),
            msg,
        )

    # Host tool name must fail
    r = mcp_rpc(
        base,
        token,
        "tools/call",
        {"name": "pipeline_run", "arguments": {}},
    )
    err = r.get("error") or {}
    msg = str(err.get("message") or "")
    _assert(report, "deny_pipeline_run", "error" in r, msg)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--project",
        type=Path,
        default=None,
        help=(
            "Episode project to share (runs in place). Default: a temporary relocated "
            "copy of the committed aligned_dialogue fixture."
        ),
    )
    parser.add_argument("--base", default="http://127.0.0.1:8765")
    parser.add_argument(
        "--revoke",
        action="store_true",
        default=True,
        help="Revoke created shares after the run (default: true)",
    )
    parser.add_argument(
        "--keep-shares",
        action="store_true",
        help="Do not revoke shares after the run",
    )
    args = parser.parse_args(argv)
    revoke = args.revoke and not args.keep_shares

    if args.project is not None:
        return _run(args.project.expanduser().resolve(), args.base, revoke=revoke)
    with tempfile.TemporaryDirectory(prefix="verify-remote-mcp-") as tmp:
        if not revoke:
            print(
                "WARN: --keep-shares with the default project leaves shares pointing at a "
                "temporary workspace that is deleted when the run ends",
                file=sys.stderr,
            )
        return _run(_relocated_default_project(Path(tmp)), args.base, revoke=revoke)


def _run(project: Path, base: str, *, revoke: bool) -> int:
    if not project.is_file():
        print(f"project not found: {project}", file=sys.stderr)
        return 2

    # Health + remote MCP enabled
    status, _health = _http_json("GET", f"{base.rstrip('/')}/api/health")
    if status != 200:
        # Some builds may lack /api/health - try opening a bogus mcp info
        print(
            f"WARN: /api/health returned {status}; continuing if MCP routes respond",
            file=sys.stderr,
        )

    ws = ProjectWorkspace.open(project)
    version_id = _ensure_review_version(ws)
    track_id = _first_track_id(ws)
    print(f"project={project}")
    print(f"base={base}")
    print(f"review_version={version_id}")
    print(f"track_id={track_id}")

    reports: list[TierReport] = []
    tokens: list[str] = []

    for tier, caps in TIERS:
        print(f"\n=== Tier {tier} caps={caps} ===")
        report = TierReport(tier=tier, caps=caps)
        reports.append(report)
        share = ShareService(ws).create(
            review_version_id=version_id,
            public_base_url=base,
            capabilities=caps,
        )
        token = str(share["token"])
        report.token = token
        tokens.append(token)
        print(f"  token={token}")
        if share.get("mcp_url"):
            print(f"  mcp_url={share['mcp_url']}")
            print(f"  local_mcp={base.rstrip('/')}/mcp/{token}/mcp")

        try:
            if "mcp" not in caps:
                verify_tier_no_mcp(base, token, report)
            else:
                # Confirm info endpoint says enabled
                st, info = _http_json("GET", f"{base.rstrip('/')}/mcp/{token}")
                _assert(
                    report,
                    "info_ok",
                    st == 200 and bool((info or {}).get("remote_mcp_enabled")),
                    f"status={st} info={info!r}",
                )
                if st == 200 and not (info or {}).get("remote_mcp_enabled"):
                    print(
                        "ERROR: GUI is running but PODCAST_REMOTE_MCP is not set on the host.",
                        file=sys.stderr,
                    )
                verify_mcp_tier(base, token, caps, report, track_id=track_id)
        except Exception as exc:
            _assert(report, "tier_exception", False, str(exc))

    if revoke:
        print("\n=== Revoking shares ===")
        for tok in tokens:
            try:
                ShareService(ws).revoke(tok)
                print(f"  revoked {tok}")
            except Exception as exc:
                print(f"  revoke failed {tok}: {exc}", file=sys.stderr)

    print("\n=== Summary ===")
    failed = 0
    for report in reports:
        status = "PASS" if report.ok else "FAIL"
        n_fail = sum(1 for c in report.checks if not c.ok)
        print(f"  {status} {report.tier} ({n_fail} failed checks)")
        if not report.ok:
            failed += 1
            for c in report.checks:
                if not c.ok:
                    print(f"      - {c.name}: {c.detail}")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

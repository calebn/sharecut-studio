"""Docs-like share role presets and capability expansion."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.edits.share_capabilities import (
    COMMENTER_CAPABILITIES,
    EDITOR_CAPABILITIES,
    RECORD_ROLE_PRESETS,
    ROLE_PRESETS,
    VIEWER_CAPABILITIES,
    capabilities_for_role,
    docs_role_for_capabilities,
    record_capabilities_for_role,
    record_role_for_capabilities,
    resolve_share_capabilities,
)
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services import ProjectWorkspace, ReviewService
from podcast_mcp.services.remote_mcp.allowlist import tools_for_capabilities


@pytest.mark.parametrize(
    ("role", "expected"),
    [
        ("viewer", VIEWER_CAPABILITIES),
        ("commenter", COMMENTER_CAPABILITIES),
        ("editor", EDITOR_CAPABILITIES),
        ("VIEWER", VIEWER_CAPABILITIES),
    ],
)
def test_capabilities_for_role(role: str, expected: list[str]) -> None:
    assert capabilities_for_role(role) == list(expected)


def test_capabilities_for_role_with_mcp() -> None:
    caps = capabilities_for_role("viewer", with_mcp=True)
    assert "mcp" in caps
    assert "play" in caps
    assert "view" in caps


def test_capabilities_for_role_unknown() -> None:
    with pytest.raises(ValueError, match="unknown share role"):
        capabilities_for_role("owner")


def test_resolve_role_overrides_capabilities() -> None:
    caps = resolve_share_capabilities(
        role="viewer",
        capabilities="play,comment,edit",
        with_mcp=False,
    )
    assert caps == list(VIEWER_CAPABILITIES)


def test_resolve_raw_capabilities_with_mcp() -> None:
    caps = resolve_share_capabilities(
        capabilities="play,comment",
        with_mcp=True,
    )
    assert "mcp" in caps
    assert "play" in caps
    assert "comment" in caps


def test_docs_role_for_capabilities() -> None:
    assert docs_role_for_capabilities(VIEWER_CAPABILITIES) == "viewer"
    assert docs_role_for_capabilities(COMMENTER_CAPABILITIES) == "commenter"
    assert docs_role_for_capabilities(EDITOR_CAPABILITIES) == "editor"


def test_record_capabilities_for_role_guest_producer() -> None:
    assert record_capabilities_for_role("guest") == ["join", "monitor", "comment"]
    assert record_capabilities_for_role("producer") == ["monitor", "comment"]
    assert record_capabilities_for_role("GUEST") == ["join", "monitor", "comment"]


def test_record_role_unknown_raises() -> None:
    with pytest.raises(ValueError, match="unknown record role"):
        record_capabilities_for_role("viewer")


def test_resolve_share_capabilities_kind_record_requires_role() -> None:
    with pytest.raises(ValueError, match="require --role"):
        resolve_share_capabilities(kind="record")
    caps = resolve_share_capabilities(kind="record", role="guest", with_mcp=True)
    assert caps == ["join", "monitor", "comment"]
    assert "mcp" not in caps


def test_review_role_presets_unchanged_by_record_presets() -> None:
    assert "guest" not in ROLE_PRESETS
    assert "producer" not in ROLE_PRESETS
    assert set(RECORD_ROLE_PRESETS) == {"guest", "producer"}


def test_record_role_for_capabilities() -> None:
    assert record_role_for_capabilities(["join", "monitor", "comment"]) == "guest"
    assert record_role_for_capabilities(["monitor", "comment"]) == "producer"
    assert record_role_for_capabilities(["play", "comment"]) is None


@pytest.mark.parametrize("role", ["viewer", "commenter", "editor"])
def test_role_allowlist_parity(role: str) -> None:
    """Web guest mode and remote MCP tools both derive from the same caps."""
    caps = capabilities_for_role(role)
    tools = tools_for_capabilities(caps)
    if role == "viewer":
        assert "guest_get_project" in tools
        assert "guest_pending_preview" in tools
        assert "guest_audition_context" in tools
        assert "guest_add_comment" not in tools
    elif role == "commenter":
        assert "guest_add_comment" in tools
        assert "guest_pending_preview" not in tools
        assert "guest_submit_document_command" not in tools
    else:
        assert "guest_submit_document_command" in tools
        assert "guest_upload_media" in tools


def _seed_premix(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def test_cli_share_role_viewer(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_REVIEW_SHARES_INDEX", str(index))
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="role")

    runner = CliRunner()
    result = runner.invoke(
        cli_app,
        [
            "review",
            "share",
            "--project",
            str(minimal_project),
            "--version",
            ver["id"],
            "--base-url",
            "http://relay.test",
            "--role",
            "viewer",
            "--with-mcp",
        ],
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout)
    assert set(payload["capabilities"]) >= {"play", "view", "mcp"}
    assert "comment" not in payload["capabilities"]
    assert payload["guest_mode"] == "view"
    assert payload["mcp_url"]


def test_cli_share_restricted_invite_and_revoke(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_REVIEW_SHARES_INDEX", str(index))
    monkeypatch.setenv("PODCAST_SHARE_ACCOUNTS", "1")
    idb = tmp_workspace / "identity.sqlite"
    monkeypatch.setenv("PODCAST_SHARE_IDENTITY", str(idb))
    from podcast_mcp.services.share_auth.store import reset_identity_store_for_tests

    reset_identity_store_for_tests()
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="restricted-cli")
    runner = CliRunner()
    result = runner.invoke(
        cli_app,
        [
            "review",
            "share",
            "--project",
            str(minimal_project),
            "--version",
            ver["id"],
            "--role",
            "commenter",
            "--general-access",
            "restricted",
            "--require-sign-in",
            "--invite",
            "a@example.com",
            "--invite",
            "b@example.com",
            "--base-url",
            "http://relay.test",
        ],
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout)
    assert payload["general_access"] == "restricted"
    assert payload["require_sign_in"] is True
    assert len(payload["invites"]) == 2
    token = payload["token"]

    listed = runner.invoke(cli_app, ["review", "list-shares", "--project", str(minimal_project)])
    assert listed.exit_code == 0
    assert token in listed.stdout

    invite = runner.invoke(
        cli_app,
        [
            "review",
            "invite-share",
            "--token",
            token,
            "--email",
            "c@example.com",
            "--role",
            "editor",
        ],
    )
    assert invite.exit_code == 0
    assert "c@example.com" in invite.stdout

    revoked = runner.invoke(
        cli_app,
        [
            "review",
            "revoke-invite",
            "--token",
            token,
            "--email",
            "c@example.com",
        ],
    )
    assert revoked.exit_code == 0
    missing = runner.invoke(
        cli_app,
        [
            "review",
            "revoke-invite",
            "--token",
            token,
            "--email",
            "nobody@example.com",
        ],
    )
    assert missing.exit_code == 1

    bad_role = runner.invoke(
        cli_app,
        [
            "review",
            "share",
            "--project",
            str(minimal_project),
            "--version",
            ver["id"],
            "--role",
            "owner",
        ],
    )
    assert bad_role.exit_code == 1
    reset_identity_store_for_tests()


def test_create_review_share_tool_role(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    from podcast_mcp.mcp.tools.review import create_review_share_tool

    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_REVIEW_SHARES_INDEX", str(index))
    monkeypatch.setenv("PODCAST_SHARE_ACCOUNTS", "1")
    idb = tmp_workspace / "id.sqlite"
    monkeypatch.setenv("PODCAST_SHARE_IDENTITY", str(idb))
    from podcast_mcp.services.share_auth.store import reset_identity_store_for_tests

    reset_identity_store_for_tests()
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="mcp-role")
    out = create_review_share_tool(
        str(minimal_project),
        ver["id"],
        public_base_url="http://r.test",
        role="commenter",
        with_mcp=True,
    )
    data = json.loads(out)
    assert "comment" in data["capabilities"]
    assert "mcp" in data["capabilities"]
    assert data["guest_mode"] == "comment"

    out2 = create_review_share_tool(
        str(minimal_project),
        ver["id"],
        public_base_url="http://r.test",
        role="editor",
        general_access="restricted",
        require_sign_in=True,
        invite_emails="one@ex.com, two@ex.com",
    )
    data2 = json.loads(out2)
    assert data2["general_access"] == "restricted"
    assert data2["require_sign_in"] is True
    assert len(data2["invites"]) == 2
    reset_identity_store_for_tests()

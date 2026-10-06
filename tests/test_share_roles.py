"""Docs-like share role presets and capability expansion."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.edits.share_capabilities import (
    RECORD_ROLE_PRESETS,
    REVIEW_ROLE_CAPABILITIES,
    ReviewRole,
    capabilities_for_role,
    normalize_capabilities,
    record_capabilities_for_role,
    record_role_for_capabilities,
    review_role_for_capabilities,
)
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.remote_mcp.allowlist import tools_for_capabilities

COMMENTER = ["play", "view", "comment", "reply", "action", "suggest"]


def test_review_roles_follow_google_docs() -> None:
    """Viewer views and plays; Commenter also comments and suggests; Editor also edits."""
    assert {role.value: capabilities_for_role(role) for role in ReviewRole} == {
        "viewer": ["play", "view"],
        "commenter": COMMENTER,
        "editor": [*COMMENTER, "edit"],
    }
    assert list(REVIEW_ROLE_CAPABILITIES) == list(ReviewRole)


def test_capabilities_for_role_parses_names_and_adds_mcp() -> None:
    assert capabilities_for_role("VIEWER") == ["play", "view"]
    assert capabilities_for_role("commenter", with_mcp=True) == [*COMMENTER, "mcp"]


@pytest.mark.parametrize("role", ["owner", "suggester", "guest", ""])
def test_capabilities_for_role_unknown(role: str) -> None:
    with pytest.raises(ValueError, match="unknown share role"):
        capabilities_for_role(role)


@pytest.mark.parametrize(
    ("caps", "role"),
    [
        (["play", "view"], ReviewRole.VIEWER),
        (COMMENTER, ReviewRole.COMMENTER),
        ([*COMMENTER, "mcp"], ReviewRole.COMMENTER),
        ([*COMMENTER, "edit", "mcp"], ReviewRole.EDITOR),
        # The dropped suggest-only level is no role above Viewer.
        (["play", "view", "suggest"], ReviewRole.VIEWER),
        (["play", "view", "comment", "reply", "action"], ReviewRole.VIEWER),
        (["play", "view", "edit"], ReviewRole.VIEWER),
        (["play", "comment", "reply", "action"], None),
        (["join", "monitor", "comment"], None),
        ([], None),
    ],
)
def test_review_role_is_the_highest_role_a_share_holds_in_full(caps, role) -> None:
    assert review_role_for_capabilities(caps) is role


def test_omitted_capabilities_default_to_the_commenter_role() -> None:
    assert normalize_capabilities(None) == COMMENTER


@pytest.mark.parametrize("caps", [[], "", " , ", ["sugest"], ["nope", "bogus"], "play,sugest"])
def test_malformed_capabilities_raise_instead_of_defaulting(caps) -> None:
    with pytest.raises(ValueError, match="capabilit"):
        normalize_capabilities(caps)


def test_known_capabilities_normalize_with_view_implying_play() -> None:
    assert normalize_capabilities(["view", "comment", "view"]) == ["play", "view", "comment"]
    assert normalize_capabilities("play,edit") == ["play", "edit"]


@pytest.mark.parametrize("caps", [[], ["sugest"], ["view", "sugest"]])
def test_share_creation_rejects_malformed_capabilities(
    minimal_project, sample_wav, tmp_workspace, caps
) -> None:
    from podcast_mcp.edits.review_shares import create_share, list_shares
    from podcast_mcp.services.collaboration.share import ShareService

    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="malformed")
    with pytest.raises(ValueError, match="capabilit"):
        ShareService(ws).create(review_version_id=ver["id"], capabilities=caps)
    with pytest.raises(ValueError, match="capabilit"):
        create_share(ws.project, review_version_id=ver["id"], capabilities=caps)
    assert list_shares(ws.project) == []


def test_share_creation_without_capabilities_is_a_commenter_link(
    minimal_project, sample_wav, tmp_workspace
) -> None:
    from podcast_mcp.services.collaboration.share import ShareService

    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="default")
    row = ShareService(ws).create(review_version_id=ver["id"])
    assert (row["capabilities"], row["docs_role"]) == (COMMENTER, "commenter")


@pytest.mark.parametrize("role", ["owner", "suggester", ""])
def test_host_share_creation_rejects_unknown_roles(
    minimal_project, sample_wav, tmp_workspace, role
) -> None:
    from podcast_mcp.edits.review_shares import list_shares
    from podcast_mcp.services.collaboration.share import ShareService

    ws = _seed_premix(minimal_project, sample_wav)
    ReviewService(ws).publish(label="host-role")
    with pytest.raises(ValueError, match="unknown share role"):
        ShareService(ws).create_for_host(role=role)
    assert list_shares(ws.project) == []


@pytest.mark.parametrize("role", ["owner", "suggester", ""])
def test_cli_share_rejects_unknown_roles_without_minting(
    minimal_project, sample_wav, tmp_workspace, role
) -> None:
    from podcast_mcp.edits.review_shares import list_shares

    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="cli-role")
    result = CliRunner().invoke(
        cli_app,
        [
            "review",
            "share",
            "--project",
            str(minimal_project),
            "--version",
            ver["id"],
            "--role",
            role,
        ],
    )
    assert result.exit_code == 1
    assert "unknown share role" in result.output
    assert list_shares(ws.project) == []


def test_create_review_share_tool_rejects_unknown_roles(minimal_project, sample_wav) -> None:
    from podcast_mcp.edits.review_shares import list_shares
    from podcast_mcp.mcp.tools.review import create_review_share_tool

    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="tool-bad-role")
    for role in ("owner", ""):
        with pytest.raises(ValueError, match="unknown share role"):
            create_review_share_tool(str(minimal_project), ver["id"], role=role)
    assert list_shares(ws.project) == []


def test_record_capabilities_for_role_guest_producer() -> None:
    assert record_capabilities_for_role("guest") == ["join", "monitor", "comment"]
    assert record_capabilities_for_role("producer") == ["monitor", "comment"]
    assert record_capabilities_for_role("GUEST") == ["join", "monitor", "comment"]


def test_record_role_unknown_raises() -> None:
    with pytest.raises(ValueError, match="unknown record role"):
        record_capabilities_for_role("viewer")


def test_review_role_presets_unchanged_by_record_presets() -> None:
    assert {"guest", "producer"}.isdisjoint(ReviewRole)
    assert set(RECORD_ROLE_PRESETS) == {"guest", "producer"}


def test_record_role_for_capabilities() -> None:
    assert record_role_for_capabilities(["join", "monitor", "comment"]) == "guest"
    assert record_role_for_capabilities(["monitor", "comment"]) == "producer"
    assert record_role_for_capabilities(["play", "comment"]) is None


@pytest.mark.parametrize(
    ("role", "offered"),
    [
        ("viewer", {"guest_get_project", "guest_pending_preview", "guest_audition_context"}),
        (
            "commenter",
            {"guest_add_comment", "guest_set_action_done", "guest_submit_document_command"},
        ),
        ("editor", {"guest_submit_document_command", "guest_upload_media"}),
    ],
)
def test_role_allowlist_parity(role: str, offered: set[str]) -> None:
    """Web guest mode and remote MCP tools both derive from the same caps."""
    tools = tools_for_capabilities(capabilities_for_role(role))
    assert offered <= tools
    edit_only = {"guest_render_preview", "guest_upload_media", "guest_render_preview_job"}
    assert edit_only <= tools if role == "editor" else edit_only.isdisjoint(tools)
    authoring = {"guest_add_comment", "guest_submit_document_command"}
    assert authoring.isdisjoint(tools) if role == "viewer" else authoring <= tools


def _seed_premix(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def test_cli_share_role_viewer(minimal_project, sample_wav, tmp_workspace, monkeypatch):
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


def test_cli_share_mints_review_links_from_a_role_only(minimal_project, sample_wav, tmp_workspace):
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="default-role")
    base = ["review", "share", "--project", str(minimal_project), "--version", ver["id"]]
    runner = CliRunner()

    default = runner.invoke(cli_app, [*base, "--base-url", "http://relay.test"])
    assert default.exit_code == 0, default.output
    payload = json.loads(default.stdout)
    assert (payload["capabilities"], payload["docs_role"], payload["guest_mode"]) == (
        COMMENTER,
        "commenter",
        "comment",
    )

    raw = runner.invoke(cli_app, [*base, "--capabilities", "play,view,suggest"])
    assert raw.exit_code == 2
    assert "No such option" in raw.output


def test_create_review_share_tool_takes_no_raw_capabilities(minimal_project, sample_wav):
    from podcast_mcp.mcp.tools.review import create_review_share_tool

    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="tool-role")
    with pytest.raises(TypeError, match="capabilities"):
        create_review_share_tool(str(minimal_project), ver["id"], capabilities="play,view,suggest")
    made = json.loads(create_review_share_tool(str(minimal_project), ver["id"]))
    assert (made["capabilities"], made["docs_role"]) == (COMMENTER, "commenter")


def test_cli_share_restricted_invite_and_revoke(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
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

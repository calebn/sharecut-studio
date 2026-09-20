"""Typed document-command payloads and published JSON Schema."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from podcast_mcp.services.document_sync.payloads import (
    COMMENT_BODY_MAX,
    document_command_json_schema,
    parse_document_command,
    validate_payload,
)
from podcast_mcp.services.remote_mcp.tools import tool_input_schema

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "schemas" / "document-commands.schema.json"
DOCS_SITE_SCHEMA = ROOT / "docs-site" / "schemas" / "document-commands.schema.json"
DOCS_COMMANDS_PAGE = ROOT / "docs-site" / "pages" / "document-commands.md"


def test_checked_in_schema_matches_pydantic():
    assert SCHEMA_PATH.is_file()
    on_disk = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    generated = document_command_json_schema()
    generated["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    generated["$id"] = (
        "https://github.com/calebn/sharecut-studio/schemas/document-commands.schema.json"
    )
    generated["title"] = "DocumentCommandBody"
    generated["description"] = on_disk.get("description")
    assert json.dumps(on_disk, sort_keys=True) == json.dumps(generated, sort_keys=True)


def test_docs_site_schema_matches_checked_in():
    assert DOCS_SITE_SCHEMA.is_file()
    assert DOCS_SITE_SCHEMA.read_text(encoding="utf-8") == SCHEMA_PATH.read_text(encoding="utf-8")


def test_docs_site_document_commands_page_has_generated_catalog():
    text = DOCS_COMMANDS_PAGE.read_text(encoding="utf-8")
    assert "<!-- document-commands:generated -->" in text
    assert "<!-- /document-commands:generated -->" in text
    assert "`ApproveEdits`" in text
    assert "`guest_submit_document_command`" in text
    assert "`SetJoinMode`" in text
    assert "fade \\| crossfade \\| cut" in text


def test_docs_site_maturity_pack_files_exist():
    site = ROOT / "docs-site"
    for rel in (
        "pages/quickstart.md",
        "pages/errors.md",
        "pages/threat-model.md",
        "llms.txt",
        ".well-known/security.txt",
        ".well-known/api-catalog",
        "schemas/guest-share.openapi.json",
    ):
        assert (site / rel).is_file(), rel
    home = (site / "pages/home.md").read_text(encoding="utf-8")
    assert "Alpha" in home
    assert "may change" in home.lower() or "may break" in home.lower()
    share = (site / "pages/share-http.md").read_text(encoding="utf-8")
    assert "<!-- share-http-routes:generated -->" in share
    remote = (site / "pages/remote-mcp.md").read_text(encoding="utf-8")
    assert "<!-- remote-mcp-tools:generated -->" in remote
    oa = json.loads((site / "schemas/guest-share.openapi.json").read_text(encoding="utf-8"))
    assert "/api/review/{token}/daw/document/command" in oa["paths"]
    schemas = (oa.get("components") or {}).get("schemas") or {}
    assert "ShareCreateRequest" not in schemas


def test_mcp_guest_submit_schema_matches_export():
    mcp_schema = tool_input_schema("guest_submit_document_command")
    assert mcp_schema == document_command_json_schema()


def test_parse_rejects_unknown_payload_field():
    with pytest.raises(ValidationError):
        parse_document_command(
            {
                "type": "ApproveEdits",
                "payload": {"decision_ids": ["x"]},
                "client_id": "t",
                "client_seq": 1,
            }
        )


def test_validate_payload_split_at_time():
    out = validate_payload("SplitAtTime", {"at_time": 12.5, "track_ids": ["host"]})
    assert out["at_time"] == 12.5
    assert out["track_ids"] == ["host"]


def test_suggest_pending_edit_rejects_nan_and_inverted():
    with pytest.raises(ValidationError):
        validate_payload(
            "SuggestPendingEdit", {"track_id": "host", "start": float("nan"), "end": 1.0}
        )
    with pytest.raises(ValidationError):
        validate_payload("SuggestPendingEdit", {"track_id": "host", "start": 1.0, "end": 0.25})


def test_comment_body_max_constant():
    assert COMMENT_BODY_MAX == 8000

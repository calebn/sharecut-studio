"""Regression contract for copy-paste MCP setup documentation."""

import json
import re
from pathlib import Path

DOCS_DIR = Path(__file__).parents[1] / "docs"


def test_mcp_setup_examples_match_supported_client_contracts() -> None:
    """Keep client config shapes and local-safety guidance from regressing."""
    document = (DOCS_DIR / "mcp-setup.md").read_text()

    assert "podcast-mcp --version" in document
    assert "podcast-mcp --help" in document
    assert "runs the stdio server when launched without arguments" in document
    assert ".cursor/mcp.json" in document
    assert ".muse/mcp.json" not in document
    assert '"type": "streamableHttp"' in document
    assert "MCP Servers → Configure → Configure MCP Servers" in document
    assert "devin mcp add -s project sharecut" in document
    assert ".venv\\\\Scripts\\\\podcast-mcp.exe" in document
    assert "~/Library/Application Support/Claude/claude_desktop_config.json" in document
    assert "%APPDATA%\\Claude\\claude_desktop_config.json" in document
    assert "loopback-only" in document
    assert "PODCAST_MCP_PROJECT" in document
    assert "An explicit, non-empty `project_path` always wins" in document
    assert "`null`/`None` and an empty string" in document


def test_docs_site_mcp_setup_describes_the_stdio_project_default() -> None:
    document = (Path(__file__).parents[1] / "docs-site" / "pages" / "mcp-setup.md").read_text()

    assert "PODCAST_MCP_PROJECT" in document
    assert "An explicit non-empty `project_path` wins" in document
    assert "empty\npath falls back" in document


def test_mcp_setup_json_examples_are_valid() -> None:
    """Copy-paste JSON blocks must remain syntactically valid."""
    document = (DOCS_DIR / "mcp-setup.md").read_text()
    examples = re.findall(r"```json\n(.*?)\n```", document, flags=re.DOTALL)

    assert examples
    for example in examples:
        assert "mcpServers" in json.loads(example)


def test_mcp_setup_internal_docs_links_exist() -> None:
    """The guide only points readers to repository-controlled documentation."""
    document = (DOCS_DIR / "mcp-setup.md").read_text()

    assert "[host-online-relay.md](host-online-relay.md)" in document
    assert (DOCS_DIR / "host-online-relay.md").is_file()


def _docs_site_gui_section() -> str:
    page = (Path(__file__).parents[1] / "docs-site" / "pages" / "mcp-setup.md").read_text()
    start = page.index("## Co-edit with the desktop GUI")
    return page[start : page.index("\n## ", start + 1)]


def test_docs_site_mcp_setup_describes_gui_co_edit() -> None:
    """The Connect agent section matches the dialog and overclaims nothing."""
    section = _docs_site_gui_section()
    flat = " ".join(section.split())

    for phrase in (
        "Copy address",
        "Config file format",
        "http://127.0.0.1:8765/mcp",
        "cannot tell whether an app is still connected",
        "An app used this address",
        "Last used",
    ):
        assert phrase in flat, phrase

    blocks = re.findall(r"```json\n(.*?)\n```", section, flags=re.DOTALL)
    assert len(blocks) == 1
    assert json.loads(blocks[0])["mcpServers"]["sharecut"]["url"] == "http://127.0.0.1:8765/mcp"


def test_docs_site_gui_co_edit_names_no_app_and_claims_no_live_link() -> None:
    """Caleb's call: the dialog and its docs name no specific app."""
    section = _docs_site_gui_section()

    assert not re.search(r"cursor|claude|chatgpt|codex|windsurf|cline|vs ?code", section, re.I)
    assert "Connected" not in section
    for sentence in re.findall(r"[^.]*\bconnected\b[^.]*\.", " ".join(section.split())):
        assert "cannot tell whether an app is still connected" in sentence


def test_docs_site_mcp_setup_troubleshooting_covers_the_last_used_line() -> None:
    page = (Path(__file__).parents[1] / "docs-site" / "pages" / "mcp-setup.md").read_text()
    flat = " ".join(page.split())

    assert "No app has used this address since Studio started" in flat
    assert "the port can change between runs" in flat

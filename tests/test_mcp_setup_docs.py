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

"""Capability manifest stays aligned with COMMANDS / keymap / MCP / skills."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from script_loader import load_script

ROOT = Path(__file__).resolve().parents[1]


def test_capabilities_manifest_check_passes() -> None:
    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "check_capabilities_manifest.py")],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr + proc.stdout


def test_capabilities_docs_export_check_passes() -> None:
    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "export_capabilities_docs.py"), "--check"],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr + proc.stdout


def test_keymap_chords_reports_alt_track_height_commands() -> None:
    mod = load_script("check_capabilities_manifest")
    chords = mod._keymap_chords()
    assert chords["view.trackHeightIncrease"] == "Alt+="
    assert chords["view.trackHeightDecrease"] == "Alt+-"


def test_gui_capability_without_presence_is_an_error() -> None:
    mod = load_script("check_capabilities_manifest")
    errors = mod.presence_errors(
        {
            "id": "daw.example",
            "surfaces": {"gui": ["x"], "command": "example"},
        }
    )
    assert any("presence block" in e for e in errors)
    ok = mod.presence_errors(
        {
            "id": "daw.example",
            "surfaces": {"gui": ["x"], "command": "example"},
            "presence": {"cursor": "none", "follow": "none"},
        }
    )
    assert ok == []


def _row(effect: str | None, surfaces: dict, omit: dict | None = None) -> dict:
    row: dict = {"id": "daw.example", "label": "Example", "surfaces": surfaces}
    if effect is not None:
        row["effect"] = effect
    if omit is not None:
        row["omit"] = omit
    return row


def test_project_capability_without_agent_surface_is_an_error() -> None:
    mod = load_script("check_capabilities_manifest")
    errors = mod.agent_parity_errors(_row("project", {"command": "example", "gui": ["x"]}))
    assert errors == [
        "daw.example: effect: project needs surfaces.mcp or surfaces.cli "
        "(or an owner-approved omit.agent_reason)"
    ]


def test_project_capability_passes_with_mcp_cli_or_agent_reason() -> None:
    mod = load_script("check_capabilities_manifest")
    assert mod.agent_parity_errors(_row("project", {"mcp": ["example_tool"]})) == []
    assert mod.agent_parity_errors(_row("project", {"cli": "podcast example"})) == []
    assert (
        mod.agent_parity_errors(
            _row("project", {"command": "example"}, {"agent_reason": "Preview only"})
        )
        == []
    )


def test_session_and_view_capabilities_need_no_agent_surface() -> None:
    mod = load_script("check_capabilities_manifest")
    assert mod.agent_parity_errors(_row("session", {"command": "example"})) == []
    assert mod.agent_parity_errors(_row("view", {"command": "example"})) == []


def test_missing_or_unknown_effect_is_an_error() -> None:
    mod = load_script("check_capabilities_manifest")
    assert mod.agent_parity_errors(_row(None, {"command": "example"})) == [
        "daw.example: effect must be one of ['project', 'session', 'view'] (got None)"
    ]
    assert mod.agent_parity_errors(_row("display", {"command": "example"})) == [
        "daw.example: effect must be one of ['project', 'session', 'view'] (got 'display')"
    ]


def test_mcp_name_repeated_within_a_row_is_an_error() -> None:
    mod = load_script("check_capabilities_manifest")
    row = _row("project", {"mcp": ["approve_edits_tool", "approve_edits_tool"]})
    assert mod.mcp_surface_errors(row) == ["duplicate mcp approve_edits_tool (daw.example)"]
    assert mod.mcp_surface_errors(_row("project", {"mcp": ["approve_edits_tool"]})) == []


def test_manifest_shares_one_mcp_tool_across_capabilities() -> None:
    data = json.loads((ROOT / "contracts" / "capabilities.manifest.json").read_text())
    rows = {c["id"]: c["surfaces"].get("mcp") for c in data["capabilities"]}
    assert "approve_edits_tool" in rows["daw.tighten.applyHit"]
    assert "approve_edits_tool" in rows["daw.tighten.applyAllSafe"]


def test_agent_reason_beside_an_agent_surface_is_an_error() -> None:
    mod = load_script("check_capabilities_manifest")
    errors = mod.agent_parity_errors(
        _row("project", {"mcp": ["example_tool"]}, {"agent_reason": "Preview only"})
    )
    assert errors == ["daw.example: has an MCP or CLI surface, so drop omit.agent_reason"]


def test_cli_entry_that_names_no_real_command_is_an_error() -> None:
    mod = load_script("check_capabilities_manifest")
    row = _row(
        "project",
        {
            "cli": [
                "podcast track",
                "podcast edit no-such-cmd",
                "podcast edit delete-clips --no-such-flag",
                "uv run podcast edit approve",
            ]
        },
    )
    assert mod.cli_surface_errors(row, mod._cli_root()) == [
        "daw.example: cli 'podcast track' has no command `podcast track`",
        "daw.example: cli 'podcast edit no-such-cmd' has no command `podcast edit no-such-cmd`",
        "daw.example: cli 'podcast edit delete-clips --no-such-flag' "
        "`podcast edit delete-clips` has no option --no-such-flag",
        "daw.example: cli 'uv run podcast edit approve' must start with `podcast`",
    ]


def test_cli_entries_that_resolve_in_the_typer_tree_pass() -> None:
    mod = load_script("check_capabilities_manifest")
    row = _row(
        "project",
        {
            "cli": [
                "podcast edit",
                "podcast edit delete-clips --mode ripple",
                "podcast doctor --bundle",
            ]
        },
    )
    assert mod.cli_surface_errors(row, mod._cli_root()) == []

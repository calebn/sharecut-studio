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


def test_keyless_keymap_rows_are_listed_apart_from_chords() -> None:
    mod = load_script("check_capabilities_manifest")
    keyless = mod._keyless_keymap_ids()
    assert {"export.bounce", "project.new", "render.refreshMix", "track.add"} <= keyless
    assert keyless.isdisjoint(mod._keymap_chords())


def test_keymap_chords_keep_shift_on_shifted_bare_keys() -> None:
    mod = load_script("check_capabilities_manifest")
    chords = mod._keymap_chords()
    assert chords["track.soloToggle"] == "Shift+S"
    assert chords["edit.addChapter"] == "Shift+C"
    assert chords["comment.draftAt"] == "C"
    assert chords["view.waveformZoomIn"] == "Shift+ArrowUp"
    assert chords["view.waveformZoomOut"] == "Shift+ArrowDown"


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


def test_manifest_gives_the_suggested_actions_tool_a_row() -> None:
    data = json.loads((ROOT / "contracts" / "capabilities.manifest.json").read_text())
    rows = {c["id"]: c["surfaces"].get("mcp") for c in data["capabilities"]}
    assert "apply_suggested_actions_tool" in rows["daw.review.applySuggestedActions"]
    assert "approve_edits_tool" in rows["agent.edits"]


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
                "podcast no-such-group",
                "podcast edit no-such-cmd",
                "podcast edit delete-clips --no-such-flag",
                "uv run podcast edit approve",
            ]
        },
    )
    assert mod.cli_surface_errors(row, mod._cli_root()) == [
        "daw.example: cli 'podcast no-such-group' has no command `podcast no-such-group`",
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


def test_touch_column_names_only_contract_gestures_on_command_rows() -> None:
    mod = load_script("check_capabilities_manifest")
    assert mod._touch_gestures()[:2] == ["long-press-arm-drag", "long-press-empty"]
    errors = mod.touch_errors(
        [
            {"id": "daw.ok", "surfaces": {"command": "x", "touch": ["pinch"]}},
            {"id": "daw.unknown", "surfaces": {"command": "y", "touch": ["wiggle"]}},
            {"id": "agent.touch", "surfaces": {"mcp": "z", "touch": ["pinch"]}},
        ],
        None,
    )
    assert errors == [
        "daw.unknown: unknown touch gesture 'wiggle'",
        "agent.touch: surfaces.touch requires surfaces.command",
    ]


EDIT_TOOLS = {"remove_chapter_tool", "track_set_meta_tool"}
EDIT_TYPES = {"DeleteChapter", "SetTrackMeta", "UpdateChapter"}
COVERED = {"mcp": ["remove_chapter_tool"], "cli": ["podcast edit remove-chapter"]}


def _edit_surface_errors(commands: dict, gui: set[str] | None = None) -> list[str]:
    mod = load_script("check_capabilities_manifest")
    return mod.edit_surface_errors(
        {"commands": commands},
        gui if gui is not None else set(commands),
        EDIT_TYPES,
        EDIT_TOOLS,
        mod._cli_root(),
    )


def test_gui_document_command_types_come_from_non_test_gui_sources() -> None:
    mod = load_script("check_capabilities_manifest")
    sent = mod.gui_document_command_types(mod._schema_command_types())
    assert {"UpdateChapter", "DeleteChapter", "SetTrackMeta", "RenameProject"} <= sent
    assert "Heartbeat" not in sent and "ApplyEditPlan" not in sent


def test_edit_surface_built_from_the_registry_covers_the_gui_types_and_passes_the_checker() -> None:
    mod = load_script("check_capabilities_manifest")
    data = mod.edit_surface_data()
    schema_types = mod._schema_command_types()
    gui = mod.gui_document_command_types(schema_types)
    assert gui <= set(data["commands"])
    assert mod.edit_surface_errors(data, gui, schema_types, mod._mcp_tools(), mod._cli_root()) == []


def test_covered_command_with_mcp_and_cli_passes() -> None:
    assert _edit_surface_errors({"DeleteChapter": COVERED}) == []


def test_gui_sent_type_missing_from_the_file_is_an_error() -> None:
    assert _edit_surface_errors({"DeleteChapter": COVERED}, {"DeleteChapter", "UpdateChapter"}) == [
        "edit-surface: GUI sends UpdateChapter but contracts/edit-surface.json does not list it"
    ]


def test_unregistered_mcp_name_is_an_error() -> None:
    entry = {"mcp": ["no_such_tool"], "cli": COVERED["cli"]}
    assert _edit_surface_errors({"DeleteChapter": entry}) == [
        "edit-surface: DeleteChapter mcp 'no_such_tool' is not a registered tool"
    ]


def test_unresolved_cli_entry_is_an_error() -> None:
    entry = {"mcp": COVERED["mcp"], "cli": ["podcast edit no-such-cmd"]}
    assert _edit_surface_errors({"DeleteChapter": entry}) == [
        "edit-surface: DeleteChapter cli 'podcast edit no-such-cmd' "
        "has no command `podcast edit no-such-cmd`"
    ]


def test_missing_surface_without_a_gap_is_an_error() -> None:
    assert _edit_surface_errors(
        {
            "DeleteChapter": {"mcp": COVERED["mcp"], "cli": []},
            "SetTrackMeta": {"mcp": [], "cli": COVERED["cli"]},
        }
    ) == [
        "edit-surface: DeleteChapter has no cli and no gap",
        "edit-surface: SetTrackMeta has no mcp and no gap",
    ]


def test_gap_on_a_fully_covered_command_is_stale() -> None:
    entry = {**COVERED, "gap": {"reason": "was missing"}}
    assert _edit_surface_errors({"DeleteChapter": entry}) == [
        "edit-surface: DeleteChapter has both mcp and cli, so drop its stale gap"
    ]


def test_partial_gap_on_a_covered_command_is_not_stale() -> None:
    entry = {**COVERED, "gap": {"reason": "cli covers cut only", "partial": True}}
    assert _edit_surface_errors({"DeleteChapter": entry}) == []


def test_gap_with_a_missing_surface_passes() -> None:
    gap = {"mcp": [], "cli": [], "gap": {"reason": "no agent twin yet"}}
    assert _edit_surface_errors({"UpdateChapter": gap}) == []


def test_exempt_type_needs_no_surface_and_no_gap() -> None:
    entry = {"mcp": [], "cli": [], "exempt": {"reason": "Session-only"}}
    assert _edit_surface_errors({"UpdateChapter": entry}) == []
    both = {"mcp": [], "cli": [], "exempt": {"reason": "x"}, "gap": {"reason": "y"}}
    assert _edit_surface_errors({"UpdateChapter": both}) == [
        "edit-surface: UpdateChapter is both exempt and a gap"
    ]


def test_type_missing_from_the_document_command_schema_is_an_error() -> None:
    assert _edit_surface_errors({"DeleteChapter": COVERED, "NoSuchCommand": COVERED}) == [
        "edit-surface: NoSuchCommand is not a type in schemas/document-commands.schema.json"
    ]


def _gui_row(row_id: str, surfaces: dict, omit: dict | None = None) -> dict:
    row = _row("project", {"gui": ["button"], "command": "x", **surfaces}, omit)
    row["id"] = row_id
    return row


def test_project_gui_row_needs_mcp_and_cli_unless_listed() -> None:
    mod = load_script("check_capabilities_manifest")
    both = _gui_row("daw.a", {"mcp": ["a_tool"], "cli": "podcast a"})
    no_cli = _gui_row("daw.b", {"mcp": ["b_tool"]})
    no_mcp = _gui_row("daw.c", {"cli": "podcast c"})
    assert mod.manifest_twin_errors([both, no_cli, no_mcp], [], []) == [
        "edit-surface: daw.b is a project GUI row with no cli; add one or list it in "
        "manifest_rows_without_cli",
        "edit-surface: daw.c is a project GUI row with no mcp; add one or list it in "
        "manifest_rows_without_mcp",
    ]
    assert mod.manifest_twin_errors([both, no_cli, no_mcp], ["daw.b"], ["daw.c"]) == []


def test_listed_manifest_row_that_gained_its_surface_is_stale() -> None:
    mod = load_script("check_capabilities_manifest")
    both = _gui_row("daw.a", {"mcp": ["a_tool"], "cli": "podcast a"})
    session = _row("session", {"gui": ["x"], "command": "s"})
    session["id"] = "daw.s"
    errors = mod.manifest_twin_errors([both, session], ["daw.a", "daw.s", "daw.gone"], ["daw.a"])
    assert errors == [
        "edit-surface: manifest_rows_without_cli lists daw.a but its cli surface is set, "
        "so drop it",
        "edit-surface: manifest_rows_without_cli lists daw.gone but no such manifest row exists",
        "edit-surface: manifest_rows_without_cli lists daw.s but it is not a project GUI row",
        "edit-surface: manifest_rows_without_mcp lists daw.a but its mcp surface is set, "
        "so drop it",
    ]


def test_row_with_an_approved_agent_reason_is_not_asked_for_twins() -> None:
    mod = load_script("check_capabilities_manifest")
    keep = _gui_row("daw.edit.keep", {}, {"agent_reason": "Undo covers it"})
    assert mod.manifest_twin_errors([keep], [], []) == []


PINNED_GAP_TYPES = {
    "EditSelectedRange",
    "SetTrackMedia",
}
PINNED_ROWS_WITHOUT_CLI = {
    "daw.range.mute",
    "daw.media.import",
}
PINNED_ROWS_WITHOUT_MCP = {"daw.share.manage"}
PIN_HELP = (
    "A new entry needs owner approval (Caleb) and a change to this pinned list. "
    "A closed gap must be removed from the list."
)


def _pin_errors(data: dict) -> list[str]:
    commands = data["commands"]
    found = {
        "gap": {n for n, e in commands.items() if e.get("gap")},
        "exempt": {n for n, e in commands.items() if e.get("exempt")},
        "manifest_rows_without_cli": set(data["manifest_rows_without_cli"]),
        "manifest_rows_without_mcp": set(data["manifest_rows_without_mcp"]),
    }
    pinned = {
        "gap": PINNED_GAP_TYPES,
        "exempt": set(),
        "manifest_rows_without_cli": PINNED_ROWS_WITHOUT_CLI,
        "manifest_rows_without_mcp": PINNED_ROWS_WITHOUT_MCP,
    }
    errors = []
    for kind, names in found.items():
        for name in sorted(names - pinned[kind]):
            errors.append(
                f"{kind} {name} is not pinned. A new entry needs owner approval (Caleb) and a pinned-list change."
            )
        for name in sorted(pinned[kind] - names):
            errors.append(f"{kind} {name} is pinned but closed. Remove it from the pinned list.")
    return errors


def _edit_surface_data() -> dict:
    return load_script("check_capabilities_manifest").edit_surface_data()


def test_edit_surface_gaps_and_exempts_are_pinned() -> None:
    assert _pin_errors(_edit_surface_data()) == [], PIN_HELP


def test_new_gap_exempt_or_listing_fails_the_pin() -> None:
    data = _edit_surface_data()
    data["commands"]["SetTrackFader"] = {"mcp": [], "cli": [], "gap": {"reason": "later"}}
    data["commands"]["AddChapter"] = {"exempt": {"reason": "session-only"}}
    data["manifest_rows_without_cli"].append("daw.new.row")
    data["manifest_rows_without_mcp"].append("daw.other.row")
    errors = _pin_errors(data)
    assert len(errors) == 4
    assert all("owner approval (Caleb)" in e for e in errors)
    assert any(e.startswith("exempt AddChapter") for e in errors)


def test_closed_gap_must_leave_the_pin() -> None:
    data = _edit_surface_data()
    del data["commands"]["SetTrackMedia"]["gap"]
    errors = _pin_errors(data)
    assert len(errors) == 1 and "Remove it" in errors[0]


GENERIC_CLI_ROWS = {
    "daw.edit.bladeCut",
    "daw.edit.split",
    "daw.track.remove",
    "daw.track.add",
    "daw.transcript.ignore",
    "daw.envelope.addPoint",
    "daw.edit.setClipFade",
    "daw.edit.setClipGain",
    "daw.range.fillRoomTone",
}


def test_manifest_rows_name_the_generic_cli_only_where_it_performs_the_gui_edit() -> None:
    data = json.loads((ROOT / "contracts" / "capabilities.manifest.json").read_text())
    rows = {
        cap["id"]
        for cap in data["capabilities"]
        if "podcast doc submit" in _as_names(cap.get("surfaces", {}).get("cli"))
    }
    assert rows == GENERIC_CLI_ROWS


def _as_names(value: object) -> list[str]:
    return [value] if isinstance(value, str) else list(value or [])

#!/usr/bin/env python3
"""Validate contracts/capabilities.manifest.json against live COMMANDS/keymap/MCP/skills."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "contracts" / "capabilities.manifest.json"
SCHEMA = ROOT / "schemas" / "capabilities.manifest.schema.json"
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))


def _command_ids() -> set[str]:
    text = (ROOT / "gui/web/src/commands/catalog.ts").read_text(encoding="utf-8")
    return set(re.findall(r'^\s+id:\s*"([^"]+)"', text, re.M))


def _unescape_ts_string(captured: str) -> str:
    """Undo common TS/JSON-style escapes from regex captures of source text."""
    out: list[str] = []
    i = 0
    while i < len(captured):
        if captured[i] == "\\" and i + 1 < len(captured):
            out.append(captured[i + 1])
            i += 2
            continue
        out.append(captured[i])
        i += 1
    return "".join(out)


def _keymap_chords() -> dict[str, str]:
    text = (ROOT / "gui/web/src/keymap/registry.ts").read_text(encoding="utf-8")
    start = text.index("export const KEYMAP_COMMANDS")
    end = text.index("] as const", start)
    block = text[start:end]
    out: dict[str, str] = {}
    for chunk in re.split(r"\n  \{\n", block)[1:]:
        id_m = re.search(r'id:\s*"([^"]+)"', chunk)
        if not id_m:
            continue
        cid = id_m.group(1)
        notes_m = re.search(r'notes:\s*"([^"]*)"', chunk)
        req_mod = "requireMod: true" in chunk
        req_shift = "requireShift: true" in chunk
        keys_m = re.search(r"keys:\s*\[([^\]]+)\]", chunk)
        key_vals = [
            _unescape_ts_string(v)
            for v in re.findall(r'"([^"]+)"', keys_m.group(1) if keys_m else "")
        ]
        primary = key_vals[0] if key_vals else ""
        if notes_m:
            head = re.split(r"\s+[—\-]", _unescape_ts_string(notes_m.group(1)), maxsplit=1)[
                0
            ].strip()
            if (
                head.startswith("Mod")
                or head
                in {
                    "Space",
                    "Escape",
                    "Backspace",
                    "Delete",
                    "ArrowLeft",
                    "ArrowRight",
                    "=",
                    "-",
                    "\\",
                    "?",
                    "K",
                    "M",
                    "S",
                    "V",
                    "C",
                    "1",
                    "2",
                    "3",
                    "4",
                }
                or (len(head) <= 2 and head.isalnum())
            ):
                out[cid] = head
                continue
        if primary in (" ", "Space"):
            chord = "Space"
        elif req_mod and req_shift:
            chord = f"Mod+Shift+{primary}"
        elif req_mod:
            chord = f"Mod+{primary}"
        else:
            chord = primary
        out[cid] = chord
    return out


def _mcp_tools() -> set[str]:
    from mcp_tool_discovery import discover_mcp_tool_names

    return discover_mcp_tool_names()


def _skill_description_nonempty(frontmatter: str) -> bool:
    """True if ``description:`` has a non-empty value (inline or folded block)."""
    m = re.search(r"^description:\s*(.*)$", frontmatter, re.M)
    if not m:
        return False
    rest = m.group(1).strip()
    if rest and rest not in {">", ">-", "|", "|-", "|+", ">+"}:
        return bool(rest.strip("\"'"))
    # Folded/literal: any indented non-empty line until next top-level key
    after = frontmatter[m.end() :]
    for line in after.splitlines():
        if re.match(r"^[a-zA-Z_][\w-]*:", line):
            break
        if line.strip():
            return True
    return False


def _skills() -> set[str]:
    """Return skill names; validates YAML frontmatter (name + description)."""
    names: set[str] = set()
    errors: list[str] = []
    for path in sorted((ROOT / ".agents" / "skills").glob("*/SKILL.md")):
        rel = path.relative_to(ROOT)
        text = path.read_text(encoding="utf-8")
        dir_name = path.parent.name
        if not text.startswith("---"):
            errors.append(f"{rel}: missing YAML frontmatter")
            continue
        end = text.find("\n---", 3)
        if end < 0:
            errors.append(f"{rel}: unclosed YAML frontmatter")
            continue
        fm = text[3:end]
        name_m = re.search(r"^name:\s*(.+)$", fm, re.M)
        if not name_m:
            errors.append(f"{rel}: missing name: in frontmatter")
            continue
        name = name_m.group(1).strip().strip("\"'")
        if name != dir_name:
            errors.append(f"{rel}: name {name!r} != directory {dir_name!r}")
        if not _skill_description_nonempty(fm):
            errors.append(f"{rel}: missing or empty description: in frontmatter")
        names.add(name)
    if errors:
        raise ValueError("skill frontmatter:\n  - " + "\n  - ".join(errors))
    return names


def _as_list(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [str(x) for x in value]
    raise TypeError(f"expected str|list, got {type(value)}")


def presence_errors(cap: dict) -> list[str]:
    """GUI surfaces must declare Look/Hear/Do via a presence block."""
    cid = cap.get("id", "<unknown>")
    surfaces = cap.get("surfaces") or {}
    if not surfaces.get("gui"):
        return []
    presence = cap.get("presence")
    errors: list[str] = []
    if not isinstance(presence, dict):
        errors.append(
            f"{cid}: surfaces.gui requires a presence block (cursor/follow classification)"
        )
        return errors
    if presence.get("cursor") == "anchor" and not presence.get("anchor"):
        errors.append(f"{cid}: presence.cursor=anchor requires presence.anchor pattern")
    if (
        presence.get("follow") in {"look", "hear"}
        and (cap.get("omit") or {}).get("guest")
        and not presence.get("guest_fallback")
    ):
        errors.append(f"{cid}: host-only followable capability needs presence.guest_fallback")
    return errors


def main() -> int:
    errors: list[str] = []
    if not MANIFEST.is_file():
        print(f"missing {MANIFEST}", file=sys.stderr)
        return 1
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))

    if SCHEMA.is_file():
        try:
            import jsonschema  # type: ignore

            schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
            jsonschema.validate(data, schema)
        except ImportError:
            pass
        except Exception as exc:
            errors.append(f"schema: {exc}")

    caps = data.get("capabilities") or []
    hub_skills = set(data.get("hub_skills") or [])
    untracked = set(data.get("untracked_mcp") or [])

    cmd_in_manifest: set[str] = set()
    keymap_in_manifest: dict[str, str] = {}
    mcp_in_manifest: set[str] = set()
    skills_in_manifest: set[str] = set()

    for cap in caps:
        cid = cap.get("id", "<unknown>")
        surfaces = cap.get("surfaces") or {}
        omit = cap.get("omit") or {}
        cmd = surfaces.get("command")
        if cmd:
            if cmd in cmd_in_manifest:
                errors.append(f"duplicate command {cmd} ({cid})")
            cmd_in_manifest.add(cmd)
        kb = surfaces.get("keyboard")
        if kb and cmd:
            keymap_in_manifest[cmd] = str(kb)
        if cap.get("industry_standard_key") and not kb:
            errors.append(f"{cid}: industry_standard_key requires surfaces.keyboard")
        if surfaces.get("gui") and not cmd:
            errors.append(f"{cid}: surfaces.gui requires surfaces.command")
        if surfaces.get("gui"):
            tip = (cap.get("tooltip") or "").strip()
            if not tip:
                errors.append(f"{cid}: surfaces.gui requires non-empty tooltip")
            if cap.get("toggle") and not (cap.get("tooltip_pressed") or "").strip():
                errors.append(f"{cid}: toggle capabilities require tooltip_pressed")
            errors.extend(presence_errors(cap))
        for name in _as_list(surfaces.get("mcp")):
            if name.startswith("guest_"):
                errors.append(
                    f"{cid}: do not put guest_* MCP names in the host manifest "
                    f"({name}); share ACL is share_capabilities.py + allowlist.py"
                )
            if name in mcp_in_manifest:
                errors.append(f"duplicate mcp {name} ({cid})")
            mcp_in_manifest.add(name)
        for sk in _as_list(surfaces.get("skill")):
            skills_in_manifest.add(sk)
        if kb is None and not omit.get("keyboard_reason") and cmd:
            live_km = _keymap_chords()
            if cmd not in live_km:
                errors.append(f"{cid}: unkeyed command needs omit.keyboard_reason")

    live_cmds = _command_ids()
    live_km = _keymap_chords()
    live_mcp = _mcp_tools()
    try:
        live_skills = _skills()
    except ValueError as exc:
        errors.append(str(exc))
        live_skills = set()

    for cmd in sorted(live_cmds - cmd_in_manifest):
        errors.append(f"COMMANDS id missing from manifest: {cmd}")
    for cmd in sorted(cmd_in_manifest - live_cmds):
        errors.append(f"manifest command not in COMMANDS: {cmd}")

    for cmd, chord in live_km.items():
        if cmd not in cmd_in_manifest:
            errors.append(f"KEYMAP id {cmd} has no manifest command row")
            continue
        declared = keymap_in_manifest.get(cmd)
        if not declared:
            errors.append(f"KEYMAP id {cmd} missing surfaces.keyboard in manifest")
        elif declared != chord:
            errors.append(f"keyboard mismatch for {cmd}: manifest={declared!r} keymap={chord!r}")

    for tool in sorted(live_mcp - mcp_in_manifest - untracked):
        errors.append(f"MCP tool missing from manifest: {tool}")
    for tool in sorted(mcp_in_manifest - live_mcp):
        errors.append(f"manifest mcp not registered: {tool}")

    covered_skills = skills_in_manifest | hub_skills
    for sk in sorted(live_skills - covered_skills):
        errors.append(f"skill missing from manifest/hub_skills: {sk}")
    for sk in sorted(hub_skills - live_skills):
        errors.append(f"hub_skills entry not found: {sk}")

    if errors:
        print(f"capabilities-check: {len(errors)} issue(s)", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        return 1
    print(
        "capabilities-check OK "
        f"({len(live_cmds)} commands, {len(live_km)} keys, "
        f"{len(live_mcp)} mcp, {len(live_skills)} skills)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

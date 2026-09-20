#!/usr/bin/env python3
"""Export / check the docs.sharecut.studio capabilities catalog from the manifest.

Writes:
  - docs-site/pages/capabilities.md (marker region)
  - docs-site/schemas/capabilities.manifest.schema.json (site copy)

Usage:
  python scripts/export_capabilities_docs.py
  python scripts/export_capabilities_docs.py --check
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "contracts" / "capabilities.manifest.json"
SCHEMA_SRC = ROOT / "schemas" / "capabilities.manifest.schema.json"
SCHEMA_SITE = ROOT / "docs-site" / "schemas" / "capabilities.manifest.schema.json"
DOCS_PAGE = ROOT / "docs-site" / "pages" / "capabilities.md"

BEGIN = "<!-- capabilities:generated -->"
END = "<!-- /capabilities:generated -->"
MCP_PREVIEW = 6


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    return [str(v) for v in value]


def _esc(cell: str) -> str:
    return cell.replace("|", "\\|").replace("\n", " ")


def _fmt_list(items: list[str], *, preview: int | None = None) -> str:
    if not items:
        return "—"
    shown = items
    suffix = ""
    if preview is not None and len(items) > preview:
        shown = items[:preview]
        suffix = f", +{len(items) - preview}"
    return _esc(", ".join(f"`{x}`" for x in shown) + suffix)


def _keyboard_cell(cap: dict[str, Any]) -> str:
    surfaces = cap.get("surfaces") or {}
    kb = surfaces.get("keyboard")
    if kb:
        return f"`{_esc(str(kb))}`"
    omit = cap.get("omit") or {}
    reason = omit.get("keyboard_reason")
    if reason:
        return f"— ({_esc(str(reason))})"
    return "—"


def _host_only(cap: dict[str, Any]) -> str:
    omit = cap.get("omit") or {}
    return "yes" if omit.get("guest") else "—"


def _presence_cell(cap: dict[str, Any]) -> str:
    presence = cap.get("presence") or {}
    cursor = presence.get("cursor")
    follow = presence.get("follow")
    if not cursor and not follow:
        return "—"
    return _esc(f"{cursor} · {follow}")


def _counts(caps: list[dict[str, Any]]) -> tuple[int, int, int, int, int]:
    cmds: set[str] = set()
    keys = 0
    mcp: set[str] = set()
    skills: set[str] = set()
    for cap in caps:
        surfaces = cap.get("surfaces") or {}
        cmd = surfaces.get("command")
        if cmd:
            cmds.add(str(cmd))
        if surfaces.get("keyboard"):
            keys += 1
        mcp.update(_as_list(surfaces.get("mcp")))
        skills.update(_as_list(surfaces.get("skill")))
    return len(caps), len(cmds), keys, len(mcp), len(skills)


def _render_generated(data: dict[str, Any]) -> str:
    caps = list(data.get("capabilities") or [])
    hub = [str(s) for s in (data.get("hub_skills") or [])]
    n_caps, n_cmds, n_keys, n_mcp, n_skills = _counts(caps)
    daw = [c for c in caps if (c.get("surfaces") or {}).get("command")]
    agent = [c for c in caps if not (c.get("surfaces") or {}).get("command")]

    lines: list[str] = [
        BEGIN,
        "",
        "> **Auto-generated** from [`contracts/capabilities.manifest.json`]"
        "(https://github.com/calebn/sharecut-studio/blob/main/contracts/capabilities.manifest.json). "
        "Do not edit by hand — run `make schema-export`.",
        "",
        f"**{n_caps}** capabilities · **{n_cmds}** Sharecut Studio commands · **{n_keys}** keyed · "
        f"**{n_mcp}** MCP tools · **{n_skills}** skills on rows "
        f"(+ **{len(hub)}** hub skills).",
        "",
        "Keyboard chords: [UX shortcuts](https://ux.sharecut.studio/#/shortcuts). "
        "Document plane: [Document commands](#/document-commands). "
        "Guest MCP allowlist: [Remote MCP](#/remote-mcp).",
        "",
        "## Sharecut Studio capabilities",
        "",
        "| Label | Command | Keyboard | GUI | MCP | CLI | Skill | Host-only | Presence |",
        "| ----- | ------- | -------- | --- | --- | --- | ----- | --------- | -------- |",
    ]
    for cap in daw:
        surfaces = cap.get("surfaces") or {}
        lines.append(
            "| "
            + " | ".join(
                [
                    _esc(str(cap.get("label") or cap.get("id"))),
                    f"`{_esc(str(surfaces.get('command')))}`",
                    _keyboard_cell(cap),
                    _fmt_list(_as_list(surfaces.get("gui"))),
                    _fmt_list(_as_list(surfaces.get("mcp")), preview=MCP_PREVIEW),
                    (f"`{_esc(str(surfaces['cli']))}`" if surfaces.get("cli") else "—"),
                    _fmt_list(_as_list(surfaces.get("skill"))),
                    _host_only(cap),
                    _presence_cell(cap),
                ]
            )
            + " |"
        )

    lines.extend(
        [
            "",
            "## Agent workflows",
            "",
            "Host/agent capabilities without a Sharecut Studio `command` id "
            "(pipeline, transcript, NL, clips, …).",
            "",
            "| Label | MCP | CLI | Skill | Host-only |",
            "| ----- | --- | --- | ----- | --------- |",
        ]
    )
    for cap in agent:
        surfaces = cap.get("surfaces") or {}
        lines.append(
            "| "
            + " | ".join(
                [
                    _esc(str(cap.get("label") or cap.get("id"))),
                    _fmt_list(_as_list(surfaces.get("mcp")), preview=MCP_PREVIEW),
                    (f"`{_esc(str(surfaces['cli']))}`" if surfaces.get("cli") else "—"),
                    _fmt_list(_as_list(surfaces.get("skill"))),
                    _host_only(cap),
                ]
            )
            + " |"
        )

    lines.extend(["", "## Hub skills", ""])
    if hub:
        lines.append("Covered without a dedicated capability row (hubs / deprecated aliases):")
        lines.append("")
        for name in hub:
            lines.append(f"- `{name}`")
    else:
        lines.append("_None._")
    lines.extend(["", END, ""])
    return "\n".join(lines)


def _apply_markers(page: str, generated: str) -> str:
    if BEGIN not in page or END not in page:
        raise SystemExit(f"missing markers {BEGIN!r} .. {END!r} in {DOCS_PAGE}")
    pattern = re.compile(re.escape(BEGIN) + r"[\s\S]*?" + re.escape(END), re.MULTILINE)
    out = pattern.sub(generated.strip(), page)
    if not out.endswith("\n"):
        out += "\n"
    return out


def _page_shell() -> str:
    return f"""# Capabilities

Host product capabilities and which adapters exist (Sharecut Studio command / GUI /
keyboard, MCP, CLI, skill). Source of truth:
[`contracts/capabilities.manifest.json`](https://github.com/calebn/sharecut-studio/blob/main/contracts/capabilities.manifest.json).

Schema: [capabilities.manifest.schema.json](../schemas/capabilities.manifest.schema.json).
Contributor recipe:
[`docs/entry-points.md`](https://github.com/calebn/sharecut-studio/blob/main/docs/entry-points.md).

This is **not** the guest share ACL cap set (`play` / `view` / `comment` / …).
Those unlock guest HTTP and [Remote MCP](#/remote-mcp) tools.

{BEGIN}
{END}
"""


def _write() -> None:
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    generated = _render_generated(data)
    page = DOCS_PAGE.read_text(encoding="utf-8") if DOCS_PAGE.is_file() else _page_shell()
    DOCS_PAGE.parent.mkdir(parents=True, exist_ok=True)
    DOCS_PAGE.write_text(_apply_markers(page, generated), encoding="utf-8")
    SCHEMA_SITE.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SCHEMA_SRC, SCHEMA_SITE)
    print(f"wrote {DOCS_PAGE}")
    print(f"wrote {SCHEMA_SITE}")


def _check() -> list[str]:
    errors: list[str] = []
    if not DOCS_PAGE.is_file():
        errors.append(f"missing {DOCS_PAGE}")
        return errors
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    generated = _render_generated(data)
    page = DOCS_PAGE.read_text(encoding="utf-8")
    expected = _apply_markers(page, generated)
    if page != expected:
        errors.append(f"{DOCS_PAGE} capabilities table is stale")
    if not SCHEMA_SITE.is_file():
        errors.append(f"missing {SCHEMA_SITE}")
    elif SCHEMA_SITE.read_bytes() != SCHEMA_SRC.read_bytes():
        errors.append(f"{SCHEMA_SITE} is stale")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        errors = _check()
        if errors:
            for err in errors:
                print(err, file=sys.stderr)
            print("run: make schema-export", file=sys.stderr)
            return 1
        print(f"{DOCS_PAGE} OK")
        print(f"{SCHEMA_SITE} OK")
        return 0
    _write()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

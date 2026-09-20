#!/usr/bin/env python3
"""Export / check document-command JSON Schema and docs-site markdown.

Usage:
  python scripts/export_document_command_schema.py          # write schema + docs-site
  python scripts/export_document_command_schema.py --check  # fail if stale
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "schemas" / "document-commands.schema.json"
DOCS_SITE_SCHEMA = ROOT / "docs-site" / "schemas" / "document-commands.schema.json"
DOCS_PAGE = ROOT / "docs-site" / "pages" / "document-commands.md"
BEGIN = "<!-- document-commands:generated -->"
END = "<!-- /document-commands:generated -->"


def _schema() -> dict[str, Any]:
    sys.path.insert(0, str(ROOT / "src"))
    from podcast_mcp.services.document_sync.payloads import document_command_json_schema

    data = document_command_json_schema()
    data["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    data["$id"] = "https://github.com/calebn/sharecut-studio/schemas/document-commands.schema.json"
    data["title"] = "DocumentCommandBody"
    data["description"] = (
        "Discriminated document-plane commands (host/guest HTTP, WS, MCP). "
        "Generated from podcast_mcp.services.document_sync.payloads — "
        "run: python scripts/export_document_command_schema.py"
    )
    return data


def _dumps(data: dict[str, Any]) -> str:
    return json.dumps(data, indent=2, sort_keys=True) + "\n"


def _resolve_ref(schema: dict[str, Any], defs: dict[str, Any]) -> dict[str, Any]:
    ref = schema.get("$ref")
    if not ref:
        return schema
    name = str(ref).rsplit("/", 1)[-1]
    return defs.get(name, schema)


def _pipe_join(parts: list[str]) -> str:
    """Join alternatives with escaped pipes so GFM tables keep one cell."""
    return " \\| ".join(parts)


def _type_label(prop: dict[str, Any], defs: dict[str, Any]) -> str:
    prop = _resolve_ref(prop, defs)
    if "enum" in prop:
        return _pipe_join([str(v) for v in prop["enum"]])
    if "anyOf" in prop or "oneOf" in prop:
        alts = prop.get("anyOf") or prop.get("oneOf") or []
        parts: list[str] = []
        for alt in alts:
            alt = _resolve_ref(alt, defs)
            if alt.get("type") == "null":
                parts.append("null")
            elif "enum" in alt:
                parts.append(_pipe_join([str(v) for v in alt["enum"]]))
            elif "type" in alt:
                t = alt["type"]
                parts.append(t if isinstance(t, str) else _pipe_join(list(t)))
            elif "$ref" in alt:
                parts.append(str(alt["$ref"]).rsplit("/", 1)[-1])
            else:
                parts.append("object")
        # Collapse duplicate labels (e.g. inline enum + $ref to same enum).
        uniq: list[str] = []
        for part in parts:
            if part not in uniq:
                uniq.append(part)
        return _pipe_join(uniq)
    if "type" in prop:
        t = prop["type"]
        if t == "array":
            items = _resolve_ref(prop.get("items") or {}, defs)
            if "enum" in items:
                item_t = _pipe_join([str(v) for v in items["enum"]])
            else:
                item_t = items.get("type", "object")
                if isinstance(item_t, list):
                    item_t = _pipe_join(list(item_t))
            return f"array[{item_t}]"
        if isinstance(t, list):
            return _pipe_join(list(t))
        return str(t)
    return "object"


def _command_type_name(cmd: dict[str, Any]) -> str:
    t = (cmd.get("properties") or {}).get("type") or {}
    if "const" in t:
        return str(t["const"])
    if "default" in t:
        return str(t["default"])
    enum = t.get("enum")
    if enum:
        return str(enum[0])
    return cmd.get("title", "Unknown").removesuffix("Command")


def _payload_fields(cmd: dict[str, Any], defs: dict[str, Any]) -> tuple[list[str], list[str]]:
    payload = (cmd.get("properties") or {}).get("payload") or {}
    payload = _resolve_ref(payload, defs)
    props = payload.get("properties") or {}
    required = set(payload.get("required") or [])
    req_cols: list[str] = []
    opt_cols: list[str] = []
    for name in sorted(props):
        label = f"`{name}` ({_type_label(props[name], defs)})"
        if name in required:
            req_cols.append(label)
        else:
            opt_cols.append(label)
    return req_cols, opt_cols


def _render_markdown(schema: dict[str, Any]) -> str:
    defs = schema.get("$defs") or {}
    commands = sorted(
        (defs[name] for name in defs if name.endswith("Command")),
        key=_command_type_name,
    )
    lines: list[str] = [
        BEGIN,
        "",
        "> **Auto-generated** from "
        "[`schemas/document-commands.schema.json`](https://github.com/calebn/sharecut-studio/blob/main/schemas/document-commands.schema.json) "
        "/ Pydantic `services/document_sync/payloads.py`. "
        "Do not edit by hand — run `make schema-export`.",
        "",
        "### Adapters",
        "",
        "| Surface | How it validates |",
        "|---------|------------------|",
        "| Host HTTP `POST /api/document/command` | FastAPI body = `DocumentCommandBody` |",
        "| Guest HTTP `POST /api/review/{token}/daw/document/command` | Same models + share caps |",
        "| Document WS `/api/document/ws` | `parse_document_command` on each `Command` frame |",
        "| Host MCP / CLI helpers | `validate_payload` / typed submit |",
        "| Guest MCP `guest_submit_document_command` | `inputSchema` = this schema |",
        "",
        "Raw JSON Schema (site copy): "
        "[document-commands.schema.json](../schemas/document-commands.schema.json).",
        "",
        "### Command catalog",
        "",
        "| Type | Required payload | Optional payload |",
        "|------|------------------|------------------|",
    ]
    for cmd in commands:
        ctype = _command_type_name(cmd)
        req, opt = _payload_fields(cmd, defs)
        req_s = ", ".join(req) if req else "—"
        opt_s = ", ".join(opt) if opt else "—"
        lines.append(f"| `{ctype}` | {req_s} | {opt_s} |")
    lines.extend(
        [
            "",
            f"_Generated {len(commands)} command types._",
            "",
            "- Regenerate: `make schema-export`",
            "- CI / pre-commit: `make schema-check`",
            "",
            END,
            "",
        ]
    )
    return "\n".join(lines)


def _page_shell() -> str:
    return (
        "# Document commands\n"
        "\n"
        "Typed document-plane commands shared by host GUI, guest share HTTP, "
        "document WebSocket, and MCP.\n"
        "\n"
        "Envelope fields on every command: `client_id`, `client_seq`, optional "
        "`role`, `command_id`, `causation_id`, `token`, `structural_mode`.\n"
        "\n"
        f"{BEGIN}\n"
        f"{END}\n"
    )


def _apply_generated(page: str, generated: str) -> str:
    if BEGIN in page and END in page:
        pattern = re.compile(
            re.escape(BEGIN) + r"[\s\S]*?" + re.escape(END),
            re.MULTILINE,
        )
        return pattern.sub(generated.strip(), page) + ("\n" if not page.endswith("\n") else "")
    # No markers yet — replace trailing shell or append.
    return _page_shell().replace(f"{BEGIN}\n{END}\n", generated)


def _write_docs_site(schema: dict[str, Any]) -> None:
    DOCS_SITE_SCHEMA.parent.mkdir(parents=True, exist_ok=True)
    DOCS_PAGE.parent.mkdir(parents=True, exist_ok=True)
    DOCS_SITE_SCHEMA.write_text(_dumps(schema), encoding="utf-8")
    generated = _render_markdown(schema)
    page = DOCS_PAGE.read_text(encoding="utf-8") if DOCS_PAGE.is_file() else _page_shell()
    DOCS_PAGE.write_text(_apply_generated(page, generated), encoding="utf-8")


def _check_docs_site(schema: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    expected_schema = _dumps(schema)
    if not DOCS_SITE_SCHEMA.is_file():
        errors.append(f"missing {DOCS_SITE_SCHEMA}")
    elif DOCS_SITE_SCHEMA.read_text(encoding="utf-8") != expected_schema:
        errors.append(f"{DOCS_SITE_SCHEMA} is stale")
    generated = _render_markdown(schema)
    if not DOCS_PAGE.is_file():
        errors.append(f"missing {DOCS_PAGE}")
    else:
        page = DOCS_PAGE.read_text(encoding="utf-8")
        if BEGIN not in page or END not in page:
            errors.append(f"{DOCS_PAGE} missing generated markers")
        else:
            expected_page = _apply_generated(page, generated)
            if page != expected_page:
                errors.append(f"{DOCS_PAGE} is stale")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit 1 if schema or docs-site outputs are stale",
    )
    args = parser.parse_args()
    data = _schema()
    rendered = _dumps(data)
    if args.check:
        errors: list[str] = []
        if not SCHEMA_PATH.is_file():
            errors.append(f"missing {SCHEMA_PATH}; run without --check to generate")
        elif SCHEMA_PATH.read_text(encoding="utf-8") != rendered:
            errors.append(f"{SCHEMA_PATH} is stale; run: make schema-export")
        errors.extend(_check_docs_site(data))
        if errors:
            for err in errors:
                print(err, file=sys.stderr)
            print("run: make schema-export", file=sys.stderr)
            return 1
        print(f"{SCHEMA_PATH} OK")
        print(f"{DOCS_SITE_SCHEMA} OK")
        print(f"{DOCS_PAGE} OK")
        return 0
    SCHEMA_PATH.parent.mkdir(parents=True, exist_ok=True)
    SCHEMA_PATH.write_text(rendered, encoding="utf-8")
    _write_docs_site(data)
    print(f"wrote {SCHEMA_PATH}")
    print(f"wrote {DOCS_SITE_SCHEMA}")
    print(f"wrote {DOCS_PAGE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

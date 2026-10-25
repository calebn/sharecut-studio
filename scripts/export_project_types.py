#!/usr/bin/env python3
"""Generate GUI TypeScript contracts from the Pydantic models.

  gui/web/src/types/project.generated.ts          models in podcast_mcp/gui/schemas.py
  gui/web/src/types/documentCommands.generated.ts DocumentCommandType from the command schema

Usage:
  python scripts/export_project_types.py          # write
  python scripts/export_project_types.py --check  # fail if stale (needs gui/web/node_modules)
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from biome_format import biome_format_ts
from export_document_command_schema import _command_type_name, _schema

ROOT = Path(__file__).resolve().parents[1]
TYPES = ROOT / "gui" / "web" / "src" / "types"
PROJECT_OUT = TYPES / "project.generated.ts"
COMMANDS_OUT = TYPES / "documentCommands.generated.ts"

BANNER = "/** Generated from {source} — do not edit by hand. Run `make schema-export`. */\n\n"


def _doc(text: str | None) -> str:
    if not text:
        return ""
    body = " ".join(text.split()).replace("*/", "*\\/")
    return f"/** {body} */\n"


@dataclass(frozen=True)
class _SchemaLocation:
    model: str
    path: tuple[str | int, ...] = ()
    type_index: int | None = None

    def child(self, *segments: str | int) -> _SchemaLocation:
        return _SchemaLocation(self.model, self.path + segments)

    def type_alternative(self, index: int) -> _SchemaLocation:
        return _SchemaLocation(self.model, self.path, index)

    def display(self) -> str:
        path = self.path if self.type_index is None else (*self.path, "type", self.type_index)
        return "$" + "".join(f"[{json.dumps(segment)}]" for segment in path)


def _ts(node: dict[str, Any], location: _SchemaLocation) -> str:
    if "$ref" in node:
        return str(node["$ref"]).rsplit("/", 1)[-1]
    if "const" in node:
        return _lit(node["const"])
    if "enum" in node:
        return " | ".join(_lit(v) for v in node["enum"])
    for key in ("anyOf", "oneOf"):
        if key in node:
            parts = list(
                dict.fromkeys(_ts(alt, location.child(key, i)) for i, alt in enumerate(node[key]))
            )
            return " | ".join(parts)
    if "allOf" in node:
        return " & ".join(
            _ts(alt, location.child("allOf", i)) for i, alt in enumerate(node["allOf"])
        )
    kind = node.get("type")
    if isinstance(kind, list):
        return " | ".join(
            _ts({**node, "type": k}, location.type_alternative(i)) for i, k in enumerate(kind)
        )
    if kind in ("string",):
        return "string"
    if kind in ("number", "integer"):
        return "number"
    if kind == "boolean":
        return "boolean"
    if kind == "null":
        return "null"
    if kind == "array":
        if "prefixItems" in node:
            return (
                "["
                + ", ".join(
                    _ts(item, location.child("prefixItems", i))
                    for i, item in enumerate(node["prefixItems"])
                )
                + "]"
            )
        return f"Array<{_ts(node.get('items') or {}, location.child('items'))}>"
    if kind == "object" or "properties" in node or "additionalProperties" in node:
        if node.get("properties"):
            return _object(node, location)
        extra = node.get("additionalProperties")
        value = (
            _ts(extra, location.child("additionalProperties"))
            if isinstance(extra, dict) and extra
            else "unknown"
        )
        return f"Record<string, {value}>"
    if not node or set(node) <= {
        "title",
        "description",
        "default",
        "examples",
        "deprecated",
        "readOnly",
        "writeOnly",
        "$comment",
    }:
        return "unknown"  # a schema that places no constraint (Pydantic's Any)
    raise ValueError(
        f"export_project_types: unhandled JSON-schema shape {sorted(node)} "
        f"in model {location.model!r} at {location.display()}"
    )


def _lit(value: Any) -> str:
    if isinstance(value, str):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _object(node: dict[str, Any], location: _SchemaLocation) -> str:
    required = set(node.get("required") or [])
    lines = []
    for name, prop in (node.get("properties") or {}).items():
        mark = "" if name in required else "?"
        lines.append(
            f"{_doc(prop.get('description'))}{_key(name)}{mark}: {_ts(prop, location.child('properties', name))};"
        )
    return "{\n" + "\n".join(lines) + "\n}"


def _key(name: str) -> str:
    return name if name.isidentifier() else _lit(name)


def _declaration(name: str, node: dict[str, Any]) -> str:
    location = _SchemaLocation(name)
    doc = _doc(node.get("description"))
    if node.get("properties"):
        return f"{doc}export interface {name} {_object(node, location)}\n"
    return f"{doc}export type {name} = {_ts(node, location)};\n"


def _definitions() -> dict[str, dict[str, Any]]:
    sys.path.insert(0, str(ROOT / "src"))
    import inspect

    from pydantic import BaseModel
    from pydantic.json_schema import models_json_schema

    from podcast_mcp.gui import schemas

    local = [
        cls
        for _, cls in inspect.getmembers(schemas, inspect.isclass)
        if issubclass(cls, BaseModel) and cls.__module__ == schemas.__name__
    ]
    pairs: list[Any] = [(cls, "validation") for cls in local]
    _, bundle = models_json_schema(pairs, ref_template="#/$defs/{model}")
    return dict(sorted(bundle["$defs"].items()))


def project_types() -> str:
    body = "".join(_declaration(name, node) + "\n" for name, node in _definitions().items())
    return BANNER.format(source="podcast_mcp/gui/schemas.py") + body.rstrip("\n") + "\n"


def command_types() -> str:
    schema = _schema()
    defs = schema["$defs"]
    names = sorted(_command_type_name(defs[n]) for n in defs if n.endswith("Command"))
    union = "\n".join(f"  | {_lit(n)}" for n in names)
    registry = "\n".join(f"  {n}: {_lit(n)}," for n in names)
    return (
        BANNER.format(source="schemas/document-commands.schema.json")
        + f"export type DocumentCommandType =\n{union};\n\n"
        + "/** Wire names, so a call site spells `DocumentCommand.MoveClips`, never a string. */\n"
        + f"export const DocumentCommand = {{\n{registry}\n}} as const satisfies "
        + "Record<DocumentCommandType, DocumentCommandType>;\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    outputs = {
        PROJECT_OUT: biome_format_ts(project_types()),
        COMMANDS_OUT: biome_format_ts(command_types()),
    }
    if args.check:
        stale = [p for p, text in outputs.items() if not p.exists() or p.read_text("utf-8") != text]
        for path in stale:
            print(f"project types out of date: {path}", flush=True)
        if stale:
            print("Run: uv run python scripts/export_project_types.py", flush=True)
            return 1
        print("project types up to date")
        return 0
    for path, text in outputs.items():
        path.write_text(text, encoding="utf-8")
        print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

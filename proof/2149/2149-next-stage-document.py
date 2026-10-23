from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from html.parser import HTMLParser
from pathlib import Path


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


class IndexAnchor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.in_head = False
        self.charset_seen = False
        self.first_script: tuple[int, int, bool, bool] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "head":
            self.in_head = True
        elif tag == "meta" and self.in_head and any(key == "charset" for key, _ in attrs):
            self.charset_seen = True
        elif tag == "script" and self.first_script is None:
            row, column = self.getpos()
            self.first_script = (row, column, self.in_head, self.charset_seen)

    def handle_endtag(self, tag: str) -> None:
        if tag == "head":
            self.in_head = False


def stage(source: Path, output: Path, gate_path: Path) -> dict[str, object]:
    original = (source / "index.html").read_bytes()
    gate = gate_path.read_bytes()
    if output.exists():
        raise ValueError("Output must be a new isolated directory")
    if output.resolve().is_relative_to(source.resolve()):
        raise ValueError("Output must not be inside the original build")
    if b"</script" in gate.lower():
        raise ValueError("Gate cannot be embedded in a classic inline script")
    text = original.decode("utf-8")
    anchor = IndexAnchor()
    anchor.feed(text)
    if anchor.first_script is None or not anchor.first_script[2]:
        raise ValueError("Expected the first application script in the document head")
    row, column, _, charset_seen = anchor.first_script
    if not charset_seen:
        raise ValueError("Preserve the original charset before the diagnostic script")
    character_offset = sum(len(line) + 1 for line in text.split("\n")[: row - 1]) + column
    byte_offset = len(text[:character_offset].encode("utf-8"))
    insertion = b'<script data-qa-2149="prebootstrap-nav-gate">\n' + gate + b"\n</script>\n"
    instrumented = original[:byte_offset] + insertion + original[byte_offset:]
    assert instrumented.replace(insertion, b"", 1) == original
    shutil.copytree(source, output)
    (output / "index.html").write_bytes(instrumented)
    assets = {
        str(path.relative_to(source)): sha256(path.read_bytes())
        for path in sorted(source.rglob("*"))
        if path.is_file() and path.suffix in {".js", ".css"}
    }
    manifest = {
        "source_dist": str(source.resolve()),
        "output_dist": str(output.resolve()),
        "original_html_sha256": sha256(original),
        "instrumented_html_sha256": sha256(instrumented),
        "gate_sha256": sha256(gate),
        "reversible_insertion_only": True,
        "unchanged_js_css_sha256": assets,
        "limitation": "Disk bytes do not establish the actual HTTP response or loaded browser assets",
    }
    (output.parent / (output.name + "-manifest.json")).write_text(
        json.dumps(manifest, indent=2) + "\n"
    )
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Stage an isolated, reversible diagnostic HTML insertion"
    )
    parser.add_argument("--source-dist", type=Path, required=True)
    parser.add_argument("--output-dist", type=Path, required=True)
    parser.add_argument("--gate", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(stage(args.source_dist, args.output_dist, args.gate), indent=2))

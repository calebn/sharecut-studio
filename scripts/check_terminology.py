#!/usr/bin/env python3
"""Fail on a new "Never say" phrase in the web app's copy (#3123 item 7).

``docs/communication-philosophy.md`` § Terminology lists, per canonical term, what the product must
never say. This reads the quoted multi-word phrases from that column and looks for them in the
text a person can read in ``gui/web/src``: string and template literals and JSX text, outside tests,
stories and generated files. Single words ("clip", "Start", "Error") are not read: the table bans
them only in a stated sense, which a text match cannot see.

The hits that exist today are counted per phrase and file in ``tests/terminology_baseline.json``.
It is a ratchet: a file may not gain a hit, a file that is not listed may not have one, and a file
that lost hits must lower its count, so the list only shrinks. A hit that is right in its context
(a command label the table bans only in one menu) still counts here until the table is narrowed
or the copy changes. ``--write`` regenerates the baseline after a fix.
"""

from __future__ import annotations

import json
import re
import sys
from collections.abc import Iterator
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TABLE_DOC = ROOT / "docs" / "communication-philosophy.md"
BASELINE = ROOT / "tests" / "terminology_baseline.json"
SOURCE = "gui/web/src"
SUFFIXES = frozenset({".ts", ".tsx"})
SKIPPED_NAME = re.compile(r"\.(test|stories)\.|generated")
LITERAL = re.compile(r"""(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`)""")
JSX_TEXT = re.compile(r">([^<>{}\n]+)<")
QUOTED = re.compile(r'"([^"]+)"')
TERMINOLOGY_HEADING = "## Terminology"


def never_say_phrases(doc: Path = TABLE_DOC) -> dict[str, str]:
    """The quoted multi-word phrases of the table's last column, each with the term it belongs to."""
    text = doc.read_text(encoding="utf-8")
    section = text.split(TERMINOLOGY_HEADING, 1)[1].split("\n## ", 1)[0]
    phrases: dict[str, str] = {}
    for line in section.splitlines():
        if not line.startswith("|") or line.startswith(("|---", "| Term")):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split(" | ")]
        if len(cells) < 3:
            continue
        for quoted in QUOTED.findall(cells[2]):
            phrase = quoted.strip()
            if len(phrase.split()) >= 2:
                phrases[phrase.lower()] = cells[0]
    return phrases


def readable_text(path: Path) -> Iterator[str]:
    """The string literals and JSX text of ``path``, without module specifiers."""
    source = path.read_text(encoding="utf-8", errors="ignore")
    for double, single, template in LITERAL.findall(source):
        text = double or single or template
        if not text.startswith(("./", "../")):
            yield text
    yield from JSX_TEXT.findall(source)


def source_files(root: Path) -> Iterator[Path]:
    base = root / SOURCE
    for path in sorted(base.rglob("*")):
        if (
            path.suffix in SUFFIXES
            and not SKIPPED_NAME.search(path.name)
            and "test" not in path.parent.parts
        ):
            yield path


def scan(root: Path = ROOT, phrases: dict[str, str] | None = None) -> dict[str, int]:
    """Count the phrase hits per ``phrase|file`` key, files as posix paths under ``root``."""
    banned = never_say_phrases() if phrases is None else phrases
    patterns = {p: re.compile(rf"(?<!\w){re.escape(p)}(?!\w)", re.IGNORECASE) for p in banned}
    counts: dict[str, int] = {}
    for path in source_files(root):
        rel = path.relative_to(root).as_posix()
        for text in readable_text(path):
            for phrase, pattern in patterns.items():
                if pattern.search(text):
                    key = f"{phrase}|{rel}"
                    counts[key] = counts.get(key, 0) + 1
    return counts


def load_baseline(path: Path = BASELINE) -> dict[str, int]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return {str(k): int(v) for k, v in data["hits"].items()}


def problems(
    counts: dict[str, int], allowed: dict[str, int], phrases: dict[str, str]
) -> Iterator[str]:
    """One message per phrase and file whose count differs from its allowance."""
    for key in sorted(counts.keys() | allowed.keys()):
        found, limit = counts.get(key, 0), allowed.get(key, 0)
        phrase, rel = key.split("|", 1)
        if found > limit:
            canonical = phrases.get(phrase, "its canonical term")
            yield (
                f'{rel}: says "{phrase}" {found} time(s), {limit} allowed. '
                f"Say {canonical!r} instead (docs/communication-philosophy.md § Terminology)."
            )
        elif found < limit:
            yield (
                f'{rel}: "{phrase}" {found} time(s) left, {limit} allowed. '
                "Run scripts/check_terminology.py --write to lower the baseline."
            )


def write_baseline(counts: dict[str, int], path: Path = BASELINE) -> None:
    payload = {
        "api_version": 1,
        "comment": (
            'Quoted multi-word "Never say" phrases from docs/communication-philosophy.md '
            "§ Terminology that the web app's copy still holds, per phrase and file. A ratchet: "
            "counts may only go down. Regenerate with scripts/check_terminology.py --write."
        ),
        "hits": dict(sorted(counts.items())),
    }
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    phrases = never_say_phrases()
    counts = scan(phrases=phrases)
    if "--write" in args:
        write_baseline(counts)
        print(
            f"wrote {BASELINE.relative_to(ROOT)}: {sum(counts.values())} hits in {len(counts)} rows"
        )
        return 0
    found = list(problems(counts, load_baseline(), phrases))
    for message in found:
        print(message, file=sys.stderr)
    return 1 if found else 0


if __name__ == "__main__":
    raise SystemExit(main())

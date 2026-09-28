"""Parse the checked-in Markdown tables that docs guard tests read.

Cells are split on every ``|``, so a guarded table must not put a pipe inside
a cell (not even inside a code span).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

_CODE_SPAN_RE = re.compile(r"`([^`]+)`")
_SEPARATOR_CELL_RE = re.compile(r":?-{3,}:?")


@dataclass(frozen=True)
class MarkdownTable:
    """The first pipe table in a section: its header cells and body rows."""

    header: list[str]
    rows: list[list[str]]

    def records(self) -> list[dict[str, str]]:
        """Each body row keyed by header cell; a row must have one cell per column."""
        return [dict(zip(self.header, row, strict=True)) for row in self.rows]


def split_row(line: str) -> list[str]:
    """Split one ``| a | b |`` line into stripped cells."""
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def code_spans(text: str) -> list[str]:
    """Return the contents of every single-backtick code span in *text*."""
    return _CODE_SPAN_RE.findall(text)


def section_lines(document: str, heading: str) -> list[str]:
    """Return *document*'s lines from the line starting with *heading* to the next heading.

    Any later line starting with ``#`` ends the section, whatever its level.
    """
    lines = document.splitlines()
    start = next((i for i, line in enumerate(lines) if line.startswith(heading)), None)
    assert start is not None, f"missing the {heading!r} section"
    end = next(
        (i for i in range(start + 1, len(lines)) if lines[i].startswith("#")),
        len(lines),
    )
    return lines[start:end]


def parse_table(lines: list[str]) -> MarkdownTable:
    """Parse the first contiguous pipe table in *lines*."""
    table: list[str] = []
    for line in lines:
        if line.lstrip().startswith("|"):
            table.append(line)
        elif table:
            break
    assert len(table) >= 2, "no Markdown table (header and separator rows) found"
    assert all(_SEPARATOR_CELL_RE.fullmatch(cell) for cell in split_row(table[1])), (
        f"second table line is not a separator row: {table[1]!r}"
    )
    return MarkdownTable(header=split_row(table[0]), rows=[split_row(line) for line in table[2:]])


def section_table(path: Path, heading: str) -> MarkdownTable:
    """Parse the first table under *heading* in the Markdown file at *path*."""
    return parse_table(section_lines(path.read_text(encoding="utf-8"), heading))

"""Unit tests for the shared Markdown table parser in tests/markdown_table.py."""

from __future__ import annotations

from pathlib import Path

import pytest

from markdown_table import (
    MarkdownTable,
    code_spans,
    parse_table,
    section_lines,
    section_table,
    split_row,
)

DOC = """\
# Title

Intro text.

## Section

Some intro text before the table.

| A | B |
| --- | :---: |
| `x` | y |
| z | w |

| Other | Table |
| --- | --- |
| 1 | 2 |

## Next

| C | D |
| --- | --- |
| 3 | 4 |
"""


def test_section_lines_stop_at_the_next_heading() -> None:
    lines = section_lines(DOC, "## Section")
    assert lines[0] == "## Section"
    assert not any(line.startswith("## Next") for line in lines)
    assert not any("3" in line and "4" in line for line in lines)


def test_section_lines_require_the_heading() -> None:
    with pytest.raises(AssertionError, match="'## Missing'"):
        section_lines(DOC, "## Missing")


def test_parse_table_reads_only_the_first_table() -> None:
    table = parse_table(section_lines(DOC, "## Section"))
    assert table.header == ["A", "B"]
    assert table.rows == [["`x`", "y"], ["z", "w"]]


def test_parse_table_requires_a_separator_row() -> None:
    with pytest.raises(AssertionError, match="separator"):
        parse_table(["| A | B |", "| x | y |"])


def test_parse_table_requires_a_table() -> None:
    with pytest.raises(AssertionError, match="no Markdown table"):
        parse_table(["plain text"])


def test_records_key_rows_by_header() -> None:
    table = MarkdownTable(header=["A", "B"], rows=[["1", "2"]])
    assert table.records() == [{"A": "1", "B": "2"}]

    short = MarkdownTable(header=["A", "B"], rows=[["1"]])
    with pytest.raises(AssertionError, match="row has 1 cells, header has 2"):
        short.records()


def test_split_row_and_code_spans() -> None:
    assert split_row("| a |  b |") == ["a", "b"]
    assert code_spans("`x`, `y` and z") == ["x", "y"]
    assert code_spans("none") == []


def test_section_table_reads_a_file(tmp_path: Path) -> None:
    path = tmp_path / "doc.md"
    path.write_text(DOC, encoding="utf-8")
    table = section_table(path, "## Section")
    assert table.header == ["A", "B"]

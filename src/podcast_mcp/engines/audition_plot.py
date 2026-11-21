from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from struct import pack, unpack
from typing import Any

from podcast_mcp.util.coded_error import CodedValueError

_CELL_WIDTH = 8
_CELL_HEIGHT = 16
_AXIS_INK = 1
_INK = ("000000", "bcc8d4", "ff6464", "ffac5c", "f8e46c", "f4f4f4")
_KINDS = {
    "hypothesis": ("Hypothesis", 2),
    "pending_edit": ("Pending edit", 3),
    "comment": ("Comment", 4),
    "word": ("Word", 5),
}


@dataclass(frozen=True)
class PlotAnnotation:
    grid_filters: tuple[str, ...]
    mark_filters: tuple[str, ...]
    footer: bytes
    footer_height: int


def png_dimensions(path: Path) -> tuple[int, int]:
    with path.open("rb") as image:
        header = image.read(24)
        if header[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" or len(header) != 24:
            raise CodedValueError("Invalid plot PNG", code="invalid_plot_png")
        image.seek(-12, 2)
        if image.read(12) != b"\x00\x00\x00\x00IEND\xaeB\x60\x82":
            raise CodedValueError("Incomplete plot PNG", code="invalid_plot_png")
    width, height = unpack(">II", header[16:])
    if width == 0 or height == 0:
        raise CodedValueError("Empty plot PNG", code="invalid_plot_png")
    return width, height


def _blank(columns: int) -> bytearray:
    return bytearray(b" \x00" * columns)


def _cells(text: str) -> bytes:
    return b"".join(
        char.encode("cp437", errors="backslashreplace")
        if char.isprintable() and char != "\\"
        else char.encode("unicode_escape")
        for char in text
    )


def _place(row: bytearray, start: int, cells: bytes, ink: int) -> None:
    room = len(row) // 2 - start
    cells = cells if len(cells) <= room else cells[: max(0, room - 3)] + b"..."[:room]
    row[2 * start : 2 * (start + len(cells)) : 2] = cells
    row[2 * start + 1 : 2 * (start + len(cells)) : 2] = bytes((ink,)) * len(cells)


def _time_label(seconds: float) -> bytes:
    return f"{seconds:.6f}".rstrip("0").rstrip(".").encode("ascii")


def _pixel(fraction: float, width: int) -> int:
    return min(width - 1, round(max(0.0, min(1.0, fraction)) * width))


def _center(x: int, length: int, columns: int) -> int:
    return max(0, min(columns - length, x // _CELL_WIDTH - length // 2))


def _axis(start: float, end: float, width: int, columns: int) -> tuple[list[bytearray], list[int]]:
    left, right = _time_label(start), _time_label(end)
    axis = _blank(columns)
    _place(axis, 0, left, _AXIS_INK)
    pixels = [0, width - 1]
    right_column = max(0, columns - len(right))
    if right_column <= len(left) + 1:
        end_row = _blank(columns)
        _place(end_row, right_column, right, _AXIS_INK)
        return [axis, end_row], pixels
    _place(axis, right_column, right, _AXIS_INK)
    span = end - start
    spacing = max(1.0, span / max(1.0, columns / (max(len(left), len(right)) + 2)))
    scale = 10 ** math.floor(math.log10(spacing))
    step = next(scale * n for n in (1, 2, 5, 10) if scale * n >= spacing)
    next_column = len(left) + 2
    for i in range(math.floor(start / step) + 1, math.ceil(end / step)):
        tick = i * step
        x = _pixel((tick - start) / span, width)
        label = _time_label(tick)
        column = _center(x, len(label), columns)
        if column >= next_column and column + len(label) + 2 <= right_column:
            _place(axis, column, label, _AXIS_INK)
            pixels.append(x)
            next_column = column + len(label) + 2
    return [axis], pixels


def annotate_plot(
    width: int, marks: list[dict[str, Any]], window_start: float, window_end: float
) -> PlotAnnotation:
    if not math.isfinite(window_end - window_start) or window_end <= window_start:
        raise CodedValueError("Invalid plot time window", code="invalid_plot_window")
    # Leave the partial cell blank so cropping the footer never clips a label.
    columns = max(1, width // _CELL_WIDTH)
    frame_columns = (width + _CELL_WIDTH - 1) // _CELL_WIDTH
    axis, ticks = _axis(window_start, window_end, width, columns)
    grid_filters = tuple(
        f"drawbox=x={x}:y=0:w=1:h=ih:color=0x{_INK[_AXIS_INK]}@0.28:t=fill:replace=1" for x in ticks
    )
    groups: dict[int, list[tuple[str, int, str]]] = {}
    for mark in marks:
        kind, ink = _KINDS.get(str(mark.get("kind")), _KINDS["word"])
        group = groups.setdefault(_pixel(float(mark["x"]), width), [])
        group.append((kind, ink, str(mark["label"])))

    rails: list[tuple[bytearray, int]] = []
    legend: list[bytearray] = []
    mark_filters = []
    for reference, (x, group) in enumerate(sorted(groups.items()), 1):
        ink = group[0][1]
        mark_filters.append(
            f"drawbox=x={x}:y=0:w={min(2, width - x)}:h=ih:"
            f"color=0x{_INK[ink]}@0.85:t=fill:replace=1"
        )
        badge = str(reference).encode("ascii")
        column = _center(x, len(badge), columns)
        rail = next((i for i, (_, occupied) in enumerate(rails) if occupied < column), None)
        if rail is None:
            rail = len(rails)
            rails.append((_blank(columns), 0))
        row = rails[rail][0]
        _place(row, column, badge, ink)
        rails[rail] = (row, column + len(badge))
        for kind, kind_ink, label in group:
            entry = _blank(columns)
            _place(entry, 0, _cells(f"{reference}  {kind}  {label[: columns + 1]}"), kind_ink)
            legend.append(entry)
    title = _blank(columns)
    _place(title, 0, b"Timeline (s)", _AXIS_INK)
    rows = [*axis, title, *(row for row, _ in rails), *legend]

    # XBIN stores RGB channels in six bits and uses FFmpeg's built-in 8x16 font.
    palette = bytes(int(color[i : i + 2], 16) >> 2 for color in _INK for i in (0, 2, 4))
    header = b"XBIN\x1a" + pack("<HHBB", frame_columns, len(rows), _CELL_HEIGHT, 1)
    padding = _blank(frame_columns - columns)
    footer = header + palette.ljust(48, b"\0") + b"".join(row + padding for row in rows)
    return PlotAnnotation(grid_filters, tuple(mark_filters), footer, len(rows) * _CELL_HEIGHT)

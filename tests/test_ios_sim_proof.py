"""The pure helpers of the iOS Simulator proof script."""

from __future__ import annotations

import importlib.util
import struct
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/ios/sim_proof.py"
spec = importlib.util.spec_from_file_location("sim_proof", SCRIPT)
assert spec is not None and spec.loader is not None
sim_proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sim_proof)


def _bmp(rows: list[list[tuple[int, int, int]]], *, top_down: bool) -> bytes:
    """A 32-bit BMP whose rows are listed top to bottom, in `simctl`'s BGRA byte order."""
    height = len(rows)
    body = b"".join(
        b"".join(bytes((b, g, r, 255)) for r, g, b in row)
        for row in (rows if top_down else reversed(rows))
    )
    header = b"BM" + struct.pack("<IHHI", 138 + len(body), 0, 0, 138)
    info = struct.pack(
        "<IiiHHIIiiII",
        124,
        len(rows[0]),
        -height if top_down else height,
        1,
        32,
        3,
        len(body),
        0,
        0,
        0,
        0,
    )
    return header + info.ljust(124, b"\0") + b"\0" * (138 - 14 - 124) + body


@pytest.mark.parametrize("top_down", [True, False])
def test_a_bitmap_pixel_is_read_by_row_from_the_top(top_down: bool) -> None:
    rows = [[(1, 2, 3), (4, 5, 6)], [(7, 8, 9), (10, 11, 12)]]
    data = _bmp(rows, top_down=top_down)
    assert sim_proof.bmp_pixel(data, 0, 0) == (1, 2, 3)
    assert sim_proof.bmp_pixel(data, 1, 0) == (4, 5, 6)
    assert sim_proof.bmp_pixel(data, 0, 1) == (7, 8, 9)
    assert sim_proof.bmp_pixel(data, 1, 1) == (10, 11, 12)


def test_a_pixel_outside_the_bitmap_is_refused() -> None:
    with pytest.raises(ValueError, match="no pixel"):
        sim_proof.bmp_pixel(_bmp([[(1, 2, 3)]], top_down=True), 1, 0)

"""The pure helpers of the iOS Simulator proof script."""

from __future__ import annotations

import importlib.util
import json
import struct
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/ios/sim_proof.py"
spec = importlib.util.spec_from_file_location("sim_proof", SCRIPT)
assert spec is not None and spec.loader is not None
sim_proof = importlib.util.module_from_spec(spec)
sys.modules["sim_proof"] = sim_proof
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


def _row(method: str, path: str, status: int, *, query_empty: bool = True) -> str:
    return json.dumps(
        {"method": method, "path": path, "status": status, "query_empty": query_empty}
    )


FULL_AUDIT = "\n".join(
    [
        _row("GET", "/api/session/exchange", 200, query_empty=False),
        _row("GET", "/api/bootstrap/status", 200),
        _row("WEBSOCKET", "/api/host/ws", 101, query_empty=False),
        _row("GET", "/api/pipeline/events", 200, query_empty=False),
        _row("GET", "/api/waveform/tiles/abc", 200),
        _row("GET", "/api/session/exchange", 403, query_empty=False),
    ]
)


def test_an_audit_with_every_kind_of_traffic_is_counted() -> None:
    facts = sim_proof.audit_facts(sim_proof.parse_audit(FULL_AUDIT))

    assert facts == sim_proof.AuditFacts(
        requests=6,
        exchange_200=1,
        status_reads_200=1,
        host_socket_accepts=1,
        event_streams_200=("/api/pipeline/events",),
        media_requests_200=("/api/waveform/tiles/abc",),
    )


def test_a_half_written_audit_line_is_skipped() -> None:
    rows = sim_proof.parse_audit(_row("GET", "/api/health", 401) + '\n{"method": "GE')

    assert [row["path"] for row in rows] == ["/api/health"]


def test_page_traffic_is_observed_only_when_socket_stream_and_media_all_show() -> None:
    full = sim_proof.traffic_assertions(sim_proof.audit_facts(sim_proof.parse_audit(FULL_AUDIT)))
    no_media = sim_proof.traffic_assertions(
        sim_proof.audit_facts(sim_proof.parse_audit("\n".join(FULL_AUDIT.splitlines()[:4])))
    )
    home_only = sim_proof.traffic_assertions(
        sim_proof.audit_facts(sim_proof.parse_audit("\n".join(FULL_AUDIT.splitlines()[:2])))
    )

    assert full["5_page_traffic"]["status"] == "observed"
    assert no_media["5_page_traffic"]["status"] == "partly_observed"
    assert no_media["5_page_traffic"]["gap"] == "not seen in the audit: media"
    assert home_only["5_page_traffic"]["status"] == "not_observed"
    assert home_only["3_bootstrap_status_under_session"]["status"] == "partly_observed"

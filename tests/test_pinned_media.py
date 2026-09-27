"""Descriptor-pinned review media cannot be redirected by a later path swap."""

from __future__ import annotations

from pathlib import Path

import pytest
from starlette.background import BackgroundTask

from podcast_mcp.gui.pinned_file_response import PinnedFileResponse
from podcast_mcp.util.pinned_media import open_pinned_media


def test_pinned_media_keeps_original_after_symlink_swap(tmp_path: Path) -> None:
    media = tmp_path / "mix.mp3"
    media.write_bytes(b"published")
    outside = tmp_path / "outside"
    outside.write_bytes(b"secret")
    with open_pinned_media(media) as source:
        media.unlink()
        media.symlink_to(outside)
        assert source.read() == b"published"
    with pytest.raises(OSError):
        open_pinned_media(media)


def test_pinned_media_rejects_replaced_parent(tmp_path: Path) -> None:
    parent = tmp_path / "review"
    parent.mkdir()
    media = parent / "mix.mp3"
    media.write_bytes(b"published")
    parent.rename(tmp_path / "old-review")
    parent.symlink_to(tmp_path / "old-review", target_is_directory=True)
    with pytest.raises(OSError):
        open_pinned_media(media)


@pytest.mark.anyio
async def test_pinned_response_ranges_head_and_cleanup(tmp_path: Path) -> None:
    media = tmp_path / "mix.mp3"
    media.write_bytes(b"0123456789")
    outside = tmp_path / "outside"
    outside.write_bytes(b"secret")
    closed: list[bool] = []

    async def fetch(method: str, range_header: bytes | None = None):
        response = PinnedFileResponse(media, background=BackgroundTask(lambda: closed.append(True)))
        media.unlink()
        media.symlink_to(outside)
        sent = []
        headers = [] if range_header is None else [(b"range", range_header)]

        async def send(event):
            sent.append(event)

        await response(
            {"type": "http", "method": method, "headers": headers},
            lambda: None,
            send,
        )
        assert response._source.closed
        return sent

    sent = await fetch("GET", b"bytes=2-4")
    assert sent[0]["status"] == 206
    assert b"".join(event.get("body", b"") for event in sent) == b"234"
    assert closed == [True]
    media.unlink()
    media.write_bytes(b"0123456789")
    sent = await fetch("HEAD")
    assert sent[0]["status"] == 200
    assert b"".join(event.get("body", b"") for event in sent) == b""
    assert closed == [True, True]
    media.unlink()
    media.write_bytes(b"0123456789")
    sent = await fetch("GET", b"bytes=99-")
    assert sent[0]["status"] == 416
    assert closed == [True, True, True]

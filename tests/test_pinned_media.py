"""Descriptor-pinned review media cannot be redirected by a later path swap."""

from __future__ import annotations

import inspect
import os
from pathlib import Path

import pytest
from starlette.background import BackgroundTask
from starlette.responses import FileResponse

from podcast_mcp.gui.audio import audio_file_response
from podcast_mcp.gui.pinned_file_response import PinnedFileResponse
from podcast_mcp.util import pinned_media
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


def _no_descriptor_walk(monkeypatch: pytest.MonkeyPatch, how: str) -> None:
    """Make the platform look like Windows to the descriptor-walk probe."""
    if how == "dir_fd":
        monkeypatch.setattr(os, "supports_dir_fd", set())
    else:
        monkeypatch.delattr(os, how)
    assert not pinned_media._descriptor_walk_supported()


@pytest.mark.parametrize("how", ["dir_fd", "O_NOFOLLOW", "O_DIRECTORY"])
def test_pinned_media_falls_back_where_descriptor_walk_is_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, how: str
) -> None:
    media = tmp_path / "mix.mp3"
    media.write_bytes(b"published")
    _no_descriptor_walk(monkeypatch, how)
    with open_pinned_media(media) as source:
        assert source.read() == b"published"


def test_fallback_rejects_links_directories_and_relative_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real = tmp_path / "real"
    real.mkdir()
    (real / "mix.mp3").write_bytes(b"x")
    (tmp_path / "linked").symlink_to(real, target_is_directory=True)
    (tmp_path / "alias.mp3").symlink_to(real / "mix.mp3")
    _no_descriptor_walk(monkeypatch, "dir_fd")
    with pytest.raises(ValueError, match="links"):
        open_pinned_media(tmp_path / "linked" / "mix.mp3")
    with pytest.raises(OSError):  # O_NOFOLLOW still present: the open itself refuses
        open_pinned_media(tmp_path / "alias.mp3")
    monkeypatch.delattr(os, "O_NOFOLLOW")  # Windows: only the lstat identity check remains
    with pytest.raises(ValueError, match="regular"):
        open_pinned_media(tmp_path / "alias.mp3")
    with pytest.raises(ValueError, match="regular"):
        open_pinned_media(real)
    with pytest.raises(ValueError, match="absolute"):
        open_pinned_media(Path("mix.mp3"))
    with pytest.raises(FileNotFoundError):
        open_pinned_media(real / "missing.mp3")


def test_fallback_rejects_a_path_swapped_after_open(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    media = tmp_path / "mix.mp3"
    media.write_bytes(b"published")
    _no_descriptor_walk(monkeypatch, "dir_fd")
    real_lstat = os.lstat

    def swapped(path: str | os.PathLike[str]) -> os.stat_result:
        found = real_lstat(path)
        return os.stat_result((*tuple(found)[:1], found.st_ino + 1, *tuple(found)[2:]))

    monkeypatch.setattr(pinned_media.os, "lstat", swapped)
    with pytest.raises(ValueError, match="regular"):
        open_pinned_media(media)


@pytest.mark.anyio
async def test_response_reads_ranges_without_pread(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    media = tmp_path / "mix.mp3"
    media.write_bytes(b"0123456789")
    monkeypatch.delattr(os, "pread")
    _no_descriptor_walk(monkeypatch, "dir_fd")
    response = PinnedFileResponse(media)
    sent: list[dict] = []

    async def send(event: dict) -> None:
        sent.append(event)

    await response(
        {"type": "http", "method": "GET", "headers": [(b"range", b"bytes=2-4")]},
        lambda: None,
        send,
    )
    assert b"".join(event.get("body", b"") for event in sent) == b"234"


def test_close_is_public_and_idempotent(tmp_path: Path) -> None:
    media = tmp_path / "mix.mp3"
    media.write_bytes(b"x")
    response = PinnedFileResponse(media)
    response.close()
    response.close()
    assert response._source.closed


def test_audio_response_closes_the_pinned_file_on_not_modified(tmp_path: Path) -> None:
    from starlette.requests import Request

    media = tmp_path / "mix.wav"
    media.write_bytes(b"RIFF")
    first = audio_file_response(media)
    assert isinstance(first, PinnedFileResponse)
    etag = first.headers["etag"]
    first.close()
    closed: list[PinnedFileResponse] = []
    original_close = PinnedFileResponse.close

    def spy(self: PinnedFileResponse) -> None:
        closed.append(self)
        original_close(self)

    request = Request(
        {"type": "http", "method": "GET", "headers": [(b"if-none-match", etag.encode())]}
    )
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(PinnedFileResponse, "close", spy)
        response = audio_file_response(media, request=request)
    assert response.status_code == 304
    assert len(closed) == 1 and closed[0]._source.closed


_STARLETTE_HOOKS = (
    "_handle_simple",
    "_handle_single_range",
    "_handle_multiple_ranges",
    "generate_multipart",
)


@pytest.mark.parametrize("hook", _STARLETTE_HOOKS)
def test_pinned_response_overrides_match_starlette_signatures(hook: str) -> None:
    """The private FileResponse hooks drift between releases; fail loudly when they do."""
    upstream = inspect.signature(getattr(FileResponse, hook)).parameters
    ours = inspect.signature(getattr(PinnedFileResponse, hook)).parameters
    assert list(ours) == list(upstream)

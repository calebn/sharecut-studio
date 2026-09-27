"""Descriptor-pinned review media cannot be redirected by a later path swap."""

from __future__ import annotations

import errno
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

posix_only = pytest.mark.skipif(
    os.name == "nt", reason="descriptor walk and unlink-while-open are POSIX-only"
)


@posix_only
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


@posix_only
def test_pinned_media_rejects_replaced_parent(tmp_path: Path) -> None:
    parent = tmp_path / "review"
    parent.mkdir()
    media = parent / "mix.mp3"
    media.write_bytes(b"published")
    parent.rename(tmp_path / "old-review")
    parent.symlink_to(tmp_path / "old-review", target_is_directory=True)
    with pytest.raises(OSError):
        open_pinned_media(media)


@posix_only
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
        monkeypatch.delattr(os, how, raising=False)
    monkeypatch.setattr(pinned_media, "_PATH_FALLBACK_PLATFORM", True)
    assert not pinned_media.descriptor_walk_supported()


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
    with pytest.raises((OSError, ValueError)):  # POSIX: O_NOFOLLOW refuses; Windows: lstat check
        open_pinned_media(tmp_path / "alias.mp3")
    monkeypatch.delattr(
        os, "O_NOFOLLOW", raising=False
    )  # Windows: only the lstat identity check remains
    with pytest.raises(ValueError, match="regular"):
        open_pinned_media(tmp_path / "alias.mp3")
    with pytest.raises((OSError, ValueError)):  # Windows refuses to open a directory
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
@pytest.mark.parametrize("without_pread", [False, True])
@pytest.mark.parametrize(
    ("method", "range_header", "status", "expected"),
    [
        ("GET", None, 200, [b"0123456789"]),
        ("GET", b"bytes=2-4", 206, [b"234"]),
        ("GET", b"bytes=0-1,5-6", 206, [b"01", b"56"]),
        ("HEAD", None, 200, []),
    ],
)
async def test_pinned_response_reads_only_the_descriptor(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    without_pread: bool,
    method: str,
    range_header: bytes | None,
    status: int,
    expected: list[bytes],
) -> None:
    """Every response shape reads the pinned descriptor and never opens the path."""
    import anyio

    media = tmp_path / "mix.mp3"
    media.write_bytes(b"0123456789")
    if without_pread:
        monkeypatch.delattr(os, "pread", raising=False)
        _no_descriptor_walk(monkeypatch, "dir_fd")

    async def forbidden_open(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("FileResponse opened the path instead of the pinned descriptor")

    monkeypatch.setattr(anyio, "open_file", forbidden_open)
    response = PinnedFileResponse(media)
    response.chunk_size = 3  # several chunks per range exercise the shared seek position
    sent: list[dict] = []

    async def send(event: dict) -> None:
        sent.append(event)

    headers = [] if range_header is None else [(b"range", range_header)]
    await response({"type": "http", "method": method, "headers": headers}, lambda: None, send)
    assert sent[0]["status"] == status
    body = b"".join(event.get("body", b"") for event in sent[1:])
    if method == "HEAD":
        assert body == b""
    elif len(expected) == 1:
        assert body == expected[0]
    else:
        assert all(part in body for part in expected)
        assert b"multipart/byteranges" in dict(sent[0]["headers"])[b"content-type"]
    assert response._source.closed


def test_other_platforms_without_descriptor_walk_fail_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    media = tmp_path / "mix.mp3"
    media.write_bytes(b"published")
    monkeypatch.setattr(os, "supports_dir_fd", set())
    monkeypatch.setattr(pinned_media, "_PATH_FALLBACK_PLATFORM", False)
    with pytest.raises(OSError) as caught:
        open_pinned_media(media)
    assert caught.value.errno == errno.ENOTSUP


@pytest.mark.parametrize("blind_link_check", [False, True])
def test_fallback_rejects_a_parent_swapped_before_open(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, blind_link_check: bool
) -> None:
    review = tmp_path / "review"
    review.mkdir()
    media = review / "mix.mp3"
    media.write_bytes(b"published")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "mix.mp3").write_bytes(b"secret")
    _no_descriptor_walk(monkeypatch, "dir_fd")
    if blind_link_check:  # a link the link checks cannot see; realpath must still catch it
        monkeypatch.setattr(pinned_media, "_is_link", lambda _path: False)
    real_open = os.open

    def swap_parent_then_open(path, flags, *args, **kwargs):
        if Path(path) == media:
            review.rename(tmp_path / "old-review")
            review.symlink_to(outside, target_is_directory=True)
        return real_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(pinned_media.os, "open", swap_parent_then_open)
    with pytest.raises(ValueError, match="links"):
        open_pinned_media(media)


def test_fallback_refuses_unverifiable_file_identity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    media = tmp_path / "mix.mp3"
    media.write_bytes(b"published")
    _no_descriptor_walk(monkeypatch, "dir_fd")

    def without_file_id(real):
        def stat_without_file_id(target):
            found = tuple(real(target))
            return os.stat_result((found[0], 0, *found[2:]))

        return stat_without_file_id

    monkeypatch.setattr(pinned_media.os, "fstat", without_file_id(os.fstat))
    monkeypatch.setattr(pinned_media.os, "lstat", without_file_id(os.lstat))
    with pytest.raises(ValueError, match="unverifiable"):
        open_pinned_media(media)


def test_fallback_refuses_an_unresolved_spelling(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An 8.3 short name or subst drive realpaths elsewhere; the caller must pass a resolved path."""
    media = tmp_path / "LONGNA~1" / "mix.mp3"
    media.parent.mkdir()
    media.write_bytes(b"published")
    _no_descriptor_walk(monkeypatch, "dir_fd")
    real_realpath = os.path.realpath

    def expand_short_name(path, *args, **kwargs):
        return real_realpath(path, *args, **kwargs).replace("LONGNA~1", "Long Name")

    monkeypatch.setattr(pinned_media.os.path, "realpath", expand_short_name)
    with pytest.raises(ValueError, match="already be resolved"):
        open_pinned_media(media)


def test_close_waits_for_an_in_flight_read(tmp_path: Path) -> None:
    import threading

    media = tmp_path / "mix.mp3"
    media.write_bytes(b"0123456789")
    response = PinnedFileResponse(media)
    response._read_lock.acquire()  # a worker-thread read is in flight
    closer = threading.Thread(target=response.close)
    closer.start()
    closer.join(0.2)
    assert closer.is_alive() and not response._source.closed
    response._read_lock.release()
    closer.join(5)
    assert response._source.closed
    with pytest.raises(ValueError):  # never reads through a reused descriptor number
        response._read_at(0, 1)


def test_pinned_audio_response_releases_background_when_nothing_streams(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from starlette.requests import Request

    from podcast_mcp.gui import audio

    media = tmp_path / "mix.wav"
    media.write_bytes(b"RIFF")
    released: list[str] = []
    first = audio.pinned_audio_response(media)
    etag = first.headers["etag"]
    first.close()
    request = Request(
        {"type": "http", "method": "GET", "headers": [(b"if-none-match", etag.encode())]}
    )
    response = audio.pinned_audio_response(
        media, request=request, background=BackgroundTask(released.append, "304")
    )
    assert response.status_code == 304
    assert released == ["304"]
    with pytest.raises(FileNotFoundError):
        audio.pinned_audio_response(
            tmp_path / "missing.wav", background=BackgroundTask(released.append, "missing")
        )
    assert released == ["304", "missing"]

    def broken_headers(_st):
        raise RuntimeError("boom")

    monkeypatch.setattr(audio, "audio_cache_headers", broken_headers)
    with pytest.raises(RuntimeError):
        audio.pinned_audio_response(media, background=BackgroundTask(released.append, "error"))
    assert released == ["304", "missing", "error"]


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

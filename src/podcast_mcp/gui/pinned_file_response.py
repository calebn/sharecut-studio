"""Starlette-compatible ranged response backed by a pinned regular-file descriptor."""

from __future__ import annotations

import asyncio
import os
import threading
from pathlib import Path
from typing import Any

from starlette.background import BackgroundTask
from starlette.responses import FileResponse

from podcast_mcp.util.pinned_media import open_pinned_media


class PinnedFileResponse(FileResponse):
    """Keep FileResponse's range, conditional range, and HEAD logic without path reads."""

    def __init__(
        self, path: Path, *, background: BackgroundTask | None = None, **kwargs: Any
    ) -> None:
        self._source = open_pinned_media(path)
        self._read_lock = threading.Lock()
        self._on_close = background
        try:
            super().__init__(path, stat_result=os.fstat(self._source.fileno()), **kwargs)
        except BaseException:
            self.close()
            raise

    def close(self) -> None:
        """Release the pinned descriptor; safe to call more than once."""
        self._source.close()

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            self.close()
            if self._on_close is not None:
                await self._on_close()

    def _read_at(self, offset: int, length: int) -> bytes:
        if hasattr(os, "pread"):
            return os.pread(self._source.fileno(), length, offset)
        with self._read_lock:  # Windows has no pread; serialize seek + read instead.
            self._source.seek(offset)
            return self._source.read(length)

    async def _chunk(self, offset: int, length: int) -> bytes:
        return await asyncio.to_thread(self._read_at, offset, length)

    async def _handle_simple(self, send: Any, send_header_only: bool, send_pathsend: bool) -> None:
        del send_pathsend  # Never hand a pathname to the ASGI server.
        await send(
            {"type": "http.response.start", "status": self.status_code, "headers": self.raw_headers}
        )
        if send_header_only:
            await send({"type": "http.response.body", "body": b"", "more_body": False})
            return
        size = os.fstat(self._source.fileno()).st_size
        offset = 0
        while offset < size:
            chunk = await self._chunk(offset, min(self.chunk_size, size - offset))
            if not chunk:
                raise OSError("pinned media changed during response")
            offset += len(chunk)
            await send({"type": "http.response.body", "body": chunk, "more_body": offset < size})
        if size == 0:
            await send({"type": "http.response.body", "body": b"", "more_body": False})

    async def _handle_single_range(
        self, send: Any, start: int, end: int, file_size: int, send_header_only: bool
    ) -> None:
        from starlette.datastructures import MutableHeaders

        headers = MutableHeaders(raw=list(self.raw_headers))
        headers["content-range"] = f"bytes {start}-{end - 1}/{file_size}"
        headers["content-length"] = str(end - start)
        await send({"type": "http.response.start", "status": 206, "headers": headers.raw})
        if send_header_only:
            await send({"type": "http.response.body", "body": b"", "more_body": False})
            return
        while start < end:
            chunk = await self._chunk(start, min(self.chunk_size, end - start))
            if not chunk:
                raise OSError("pinned media changed during response")
            start += len(chunk)
            await send({"type": "http.response.body", "body": chunk, "more_body": start < end})

    async def _handle_multiple_ranges(
        self, send: Any, ranges: list[tuple[int, int]], file_size: int, send_header_only: bool
    ) -> None:
        from secrets import token_hex

        from starlette.datastructures import MutableHeaders

        boundary = token_hex(13)
        length, header = self.generate_multipart(
            ranges, boundary, file_size, self.headers["content-type"]
        )
        headers = MutableHeaders(raw=list(self.raw_headers))
        headers["content-type"] = f"multipart/byteranges; boundary={boundary}"
        headers["content-length"] = str(length)
        await send({"type": "http.response.start", "status": 206, "headers": headers.raw})
        if send_header_only:
            await send({"type": "http.response.body", "body": b"", "more_body": False})
            return
        for start, end in ranges:
            await send(
                {"type": "http.response.body", "body": header(start, end), "more_body": True}
            )
            while start < end:
                chunk = await self._chunk(start, min(self.chunk_size, end - start))
                if not chunk:
                    raise OSError("pinned media changed during response")
                start += len(chunk)
                await send({"type": "http.response.body", "body": chunk, "more_body": True})
            await send({"type": "http.response.body", "body": b"\r\n", "more_body": True})
        await send(
            {
                "type": "http.response.body",
                "body": f"--{boundary}--".encode("latin-1"),
                "more_body": False,
            }
        )

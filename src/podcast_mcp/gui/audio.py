"""GUI audio helpers - thin adapters over :class:`~podcast_mcp.services.play.PlayService`.

Path resolution for premix / processed stems / raw media lives in PlayService so
CLI, MCP, and the DAW viewer stay on one code path.
"""

from __future__ import annotations

from os import stat_result
from pathlib import Path
from typing import Any

from fastapi import Request
from fastapi.responses import Response
from starlette.background import BackgroundTask

from podcast_mcp.gui.background import release_background
from podcast_mcp.gui.pinned_file_response import PinnedFileResponse
from podcast_mcp.services.play import PlayService, TransportPath
from podcast_mcp.services.workspace import ProjectWorkspace


def resolve_viewer_audio(
    workspace: ProjectWorkspace,
    *,
    kind: str,
    track_id: str | None = None,
    rerender: bool = False,
    build_stem: bool = False,
) -> Path:
    """Return a WAV path for browser playback via :meth:`PlayService.resolve_transport_path`."""
    return resolve_viewer_transport(
        workspace,
        kind=kind,
        track_id=track_id,
        rerender=rerender,
        build_stem=build_stem,
    ).path


def resolve_viewer_transport(
    workspace: ProjectWorkspace,
    *,
    kind: str,
    track_id: str | None = None,
    rerender: bool = False,
    build_stem: bool = False,
) -> TransportPath:
    """Same as :func:`resolve_viewer_audio` but returns the full transport metadata."""
    return PlayService(workspace).resolve_transport_path(
        kind,
        track_id=track_id,
        rerender=rerender,
        build_stem=build_stem,
    )


def audio_cache_headers(st: stat_result) -> dict[str, str]:
    """Cache metadata for the descriptor pinned by the response."""
    return {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=0, must-revalidate",
        "ETag": f'"{st.st_mtime_ns}-{st.st_size}"',
    }


def pinned_audio_response(
    path: Path,
    *,
    request: Request | None = None,
    cache: bool = True,
    background: BackgroundTask | None = None,
    **kwargs: Any,
) -> PinnedFileResponse | Response:
    """Pin *path* for streaming, with cache headers and an ``If-None-Match`` 304 when *cache*.

    *background* (synchronous, such as an audio slot's ``exit``) runs once streaming ends.
    When nothing will stream (the pin fails, a 304 is returned, or header setup raises),
    the descriptor is closed and *background* is released here instead.
    """
    try:
        response = PinnedFileResponse(path, background=background, **kwargs)
    except BaseException:
        release_background(background)
        raise
    not_modified: dict[str, str] | None = None
    try:
        if cache:
            st = response.stat_result
            assert st is not None  # PinnedFileResponse always passes the pinned fstat
            headers = audio_cache_headers(st)
            inm = request.headers.get("if-none-match") if request is not None else None
            if inm is not None and headers["ETag"] in inm:
                not_modified = headers
            else:
                response.headers.update(headers)
    except BaseException:
        response.close()
        release_background(background)
        raise
    if not_modified is not None:
        response.close()
        release_background(background)
        return Response(status_code=304, headers=not_modified)
    return response


def audio_file_response(
    path: Path,
    *,
    filename: str | None = None,
    request: Request | None = None,
) -> PinnedFileResponse | Response:
    """Stream a WAV with Range + ETag so waveform byte ranges can be cached."""
    return pinned_audio_response(
        path,
        request=request,
        media_type="audio/wav",
        filename=filename or path.name,
        content_disposition_type="inline",
    )

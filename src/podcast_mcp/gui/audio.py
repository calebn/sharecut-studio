"""GUI audio helpers - thin adapters over :class:`~podcast_mcp.services.play.PlayService`.

Path resolution for premix / processed stems / raw media lives in PlayService so
CLI, MCP, and the DAW viewer stay on one code path.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import Request
from fastapi.responses import FileResponse, Response

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


def audio_cache_headers(path: Path) -> dict[str, str]:
    st = path.stat()
    return {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=0, must-revalidate",
        "ETag": f'"{st.st_mtime_ns}-{st.st_size}"',
    }


def audio_file_response(
    path: Path,
    *,
    filename: str | None = None,
    request: Request | None = None,
) -> FileResponse | Response:
    """Stream a file with Range + ETag so waveform byte ranges can be cached."""
    headers = audio_cache_headers(path)
    if request is not None:
        inm = request.headers.get("if-none-match")
        if inm is not None and headers["ETag"] in inm:
            return Response(status_code=304, headers=headers)
    return FileResponse(
        path,
        media_type="audio/wav",
        filename=filename or path.name,
        content_disposition_type="inline",
        headers=headers,
    )

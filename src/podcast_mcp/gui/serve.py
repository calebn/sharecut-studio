"""Entrypoint for background / subprocess GUI server launches."""

from __future__ import annotations

import argparse
from pathlib import Path


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Podcast MCP read-only DAW viewer")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--log-level", default="warning")
    parser.add_argument(
        "--project",
        type=Path,
        default=None,
        help="Pin served project path (reject other ?path= values)",
    )
    args = parser.parse_args(argv)

    from podcast_mcp.gui.bind import gui_server_deps_available, run_gui_server

    if not gui_server_deps_available():
        raise SystemExit("GUI dependencies missing. Install with: uv sync --extra gui")

    from podcast_mcp.gui.routes.deps import ensure_non_loopback_session_auth
    from podcast_mcp.gui.server import create_app

    ensure_non_loopback_session_auth(args.host)
    served = args.project.resolve() if args.project is not None else None
    run_gui_server(
        create_app(served_project=served, bind_host=args.host),
        host=args.host,
        port=args.port,
        log_level=args.log_level,
    )


if __name__ == "__main__":
    main()

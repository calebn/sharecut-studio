#!/usr/bin/env python3
"""Assert a release wheel ships the ShareCut Studio web build (#1085), its contracts and defaults.

Checks that ``index.html`` and every ``./`` file it references sit under the
packaged web root, that the runtime-loaded ``contracts/*.json`` ship as
``podcast_mcp/contracts`` and the default YAMLs as ``podcast_mcp/defaults`` (#1879).
It also asserts the FOSS boundary on the built wheel: no ``podcast_online*`` entries, only
``collaboration`` under ``podcast_mcp.extensions`` in ``entry_points.txt``, and the relay
offline page's static files. With ``--podcast``, also starts the CLI, the MCP tools and the GUI
app with ``podcast_online`` blocked, loads those contracts and defaults from the installed package,
then starts that installed ``podcast gui`` and requires ``/`` to return the wheel's
``index.html`` and each asset to load.

    python scripts/check_wheel_web_build.py dist/podcast_mcp-*.whl
    python scripts/check_wheel_web_build.py dist/podcast_mcp-*.whl --podcast venv/bin/podcast
"""

from __future__ import annotations

import argparse
import configparser
import re
import subprocess
import time
import tomllib
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

_PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"
_HOOK = tomllib.loads(_PYPROJECT.read_text(encoding="utf-8"))["tool"]["hatch"]["build"]["hooks"]
WHEEL_WEB_DIST = _HOOK["custom"]["wheel-web-dist"]

PACKAGED_CONTRACTS = "podcast_mcp/contracts"
PACKAGED_DEFAULTS = "podcast_mcp/defaults"
# Default YAMLs the runtime reads (config.defaults_dir()): the pipeline defaults and the
# global transcript glossary.
RUNTIME_DEFAULTS = ("pipeline.yaml", "transcript_glossary.yaml")
# Contracts the runtime reads (util/contracts.py): ffmpeg_policy, asset_sources,
# timeline_zoom and the edit geometry constants.
RUNTIME_CONTRACTS = (
    "bootstrap-assets.json",
    "ffmpeg-build.json",
    "join-length-limits.json",
    "ripple-scope.json",
    "timeline-zoom.json",
    "trim-edge-limits.json",
)
# podcast_relay/static files the relay's offline page serves (src/podcast_relay/offline.py).
RELAY_STATIC = tuple(
    f"podcast_relay/static/{name}" for name in ("brand-tokens.css", "offline.css", "offline.html")
)
EXTENSIONS_GROUP = "podcast_mcp.extensions"
FOSS_EXTENSIONS = {"collaboration"}
# Runs in the installed interpreter with the private provider made unimportable; ``None`` in
# sys.modules makes ``import podcast_online`` raise ImportError, so any hard dependency fails.
BLOCK_ONLINE_PROBE = """
import sys
sys.modules["podcast_online"] = None
sys.argv = ["podcast", "--help"]
import contextlib
import io
from podcast_mcp.cli.main import app
with contextlib.redirect_stdout(io.StringIO()):
    try:
        app()
    except SystemExit as exc:
        assert exc.code in (0, None), exc.code
import asyncio
from mcp.client import Client
from podcast_mcp.mcp.server import mcp
from podcast_mcp.gui.server import create_app

async def tool_names():
    async with Client(mcp) as client:
        return {tool.name for tool in (await client.list_tools()).tools}

tools = asyncio.run(tool_names())
assert len(tools) >= 10, sorted(tools)
gui = create_app()
assert gui.routes
assert sys.modules["podcast_online"] is None
print(f"podcast_online blocked: CLI starts, {len(tools)} MCP tools, GUI app has {len(gui.routes)} routes")
"""

_LOAD_CONTRACTS = """
import sys
from podcast_mcp.config import defaults as config
from podcast_mcp.project.transcript_context import _GLOBAL_DEFAULTS_PATH
from podcast_mcp.edits import ripple
from podcast_mcp.engines import clips_ops
from podcast_mcp.engines import ranges
from podcast_mcp.util import contracts
from podcast_mcp.util.asset_sources import load_manifest
from podcast_mcp.util.ffmpeg_policy import ffmpeg_policy
from podcast_mcp.util.timeline_zoom import min_zoom_px_per_sec

where = contracts.contracts_dir()
assert where.name == "contracts" and where.parent.name == "podcast_mcp", where
assert "site-packages" in where.parts, where
assert load_manifest()["assets"] and ffmpeg_policy()["version"] and min_zoom_px_per_sec() > 0
assert clips_ops._MIN_CLIP_SPAN_SEC == 0.05 and ranges.SPAN_EPS_S == 1e-9
assert ripple._EDGE_EPS_SEC == 1e-3 and clips_ops.JOIN_GAP_TOLERANCE_SEC == 0.05
assert config.defaults_dir().name == "defaults" and "site-packages" in config.defaults_dir().parts
assert config.load_defaults()["performance"] is not None and _GLOBAL_DEFAULTS_PATH.is_file()
print(where)
"""

_LOCAL_REF = re.compile(r'(?:src|href)="\./([^"]+)"')


def wheel_web_build(wheel: Path) -> tuple[bytes, list[str]]:
    """Return the packaged ``index.html`` and the files it references."""
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())
        index_name = f"{WHEEL_WEB_DIST}/index.html"
        if index_name not in names:
            raise SystemExit(f"{wheel.name}: missing {index_name}")
        index = archive.read(index_name)
    refs = _LOCAL_REF.findall(index.decode("utf-8"))
    missing = [ref for ref in refs if f"{WHEEL_WEB_DIST}/{ref}" not in names]
    if not refs or missing:
        raise SystemExit(f"{wheel.name}: index.html refs {refs}, missing from wheel {missing}")
    return index, refs


def wheel_contracts(wheel: Path) -> None:
    """Require the runtime contracts under ``podcast_mcp/contracts`` and no JSON beside the code."""
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())
    missing = [n for n in RUNTIME_CONTRACTS if f"{PACKAGED_CONTRACTS}/{n}" not in names]
    stray = sorted(n for n in names if n.startswith("podcast_mcp/util/") and n.endswith(".json"))
    if missing or stray:
        raise SystemExit(f"{wheel.name}: contracts missing {missing}, stray util JSON {stray}")


def wheel_defaults(wheel: Path) -> None:
    """Require the default YAMLs under ``podcast_mcp/defaults`` (an install without them reads ``{}``)."""
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())
    missing = [n for n in RUNTIME_DEFAULTS if f"{PACKAGED_DEFAULTS}/{n}" not in names]
    if missing:
        raise SystemExit(f"{wheel.name}: defaults missing {missing}")


def wheel_boundary(wheel: Path) -> None:
    """Require the FOSS boundary: no private provider, collaboration-only extensions, relay static."""
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())
        entry_files = sorted(n for n in names if n.endswith(".dist-info/entry_points.txt"))
        entry_points = archive.read(entry_files[0]).decode("utf-8") if entry_files else None
    online = sorted(n for n in names if n.startswith("podcast_online"))
    if online:
        raise SystemExit(f"{wheel.name}: private podcast_online entries in the wheel: {online}")
    if entry_points is None:
        raise SystemExit(
            f"{wheel.name}: no dist-info/entry_points.txt to read {EXTENSIONS_GROUP} from"
        )
    parser = configparser.ConfigParser(delimiters=("=",), interpolation=None)
    parser.optionxform = str  # type: ignore[assignment,method-assign]
    parser.read_string(entry_points)
    declared = set(parser[EXTENSIONS_GROUP]) if parser.has_section(EXTENSIONS_GROUP) else set()
    if declared != FOSS_EXTENSIONS:
        raise SystemExit(
            f"{wheel.name}: entry_points.txt [{EXTENSIONS_GROUP}] lists {sorted(declared)}, "
            f"expected exactly {sorted(FOSS_EXTENSIONS)}"
        )
    missing = [n for n in RELAY_STATIC if n not in names]
    if missing:
        raise SystemExit(f"{wheel.name}: relay static files missing {missing}")


def installed_without_online(podcast: Path) -> None:
    """Start the CLI, MCP tools and GUI app in the installed package with ``podcast_online`` blocked."""
    python = podcast.parent / "python"
    result = subprocess.run(
        [str(python), "-I", "-c", BLOCK_ONLINE_PROBE],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(f"installed package needs podcast_online:\n{result.stderr}")
    print(result.stdout.strip())


def installed_contracts(podcast: Path) -> None:
    """Load the contracts through the installed package, not the checkout."""
    python = podcast.parent / "python"
    result = subprocess.run(
        [str(python), "-I", "-c", _LOAD_CONTRACTS],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(f"installed package cannot load its contracts:\n{result.stderr}")
    print(f"contracts load from the installed package: {result.stdout.strip()}")


def _get(url: str) -> tuple[int, bytes]:
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def serve_check(podcast: Path, port: int, index: bytes, refs: list[str]) -> None:
    """Start ``podcast gui`` and require the wheel's build at ``/``."""
    base = f"http://127.0.0.1:{port}"
    try:
        _get(f"{base}/")
    except OSError:
        pass
    else:
        raise SystemExit(f"port {port} is already serving; pass a free --port")
    server = subprocess.Popen([str(podcast), "gui", "--no-open", "--port", str(port)])
    try:
        deadline = time.monotonic() + 90
        while True:
            try:
                status, body = _get(f"{base}/")
                break
            except OSError:
                if server.poll() is not None or time.monotonic() > deadline:
                    raise SystemExit("podcast gui did not start") from None
                time.sleep(0.5)
        if status != 200 or body != index:
            raise SystemExit(
                f"GET / returned {status}, not the wheel's index.html:\n{body[:300]!r}"
            )
        print(f"GET / -> {status}, {len(body)} bytes, identical to the wheel's index.html")
        for ref in refs:
            ref_status, _ = _get(f"{base}/{ref}")
            if ref_status != 200:
                raise SystemExit(f"GET /{ref} returned {ref_status}")
        print(f"GET {len(refs)} referenced files -> 200")
    finally:
        server.terminate()
        server.wait(timeout=30)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("wheel", type=Path)
    parser.add_argument("--podcast", type=Path, help="installed podcast executable to serve with")
    parser.add_argument("--port", type=int, default=8796)
    args = parser.parse_args()
    index, refs = wheel_web_build(args.wheel)
    print(f"{args.wheel.name}: {WHEEL_WEB_DIST}/index.html plus {len(refs)} referenced files")
    wheel_contracts(args.wheel)
    print(
        f"{args.wheel.name}: {len(RUNTIME_CONTRACTS)} runtime contracts under {PACKAGED_CONTRACTS}"
    )
    wheel_defaults(args.wheel)
    print(f"{args.wheel.name}: {len(RUNTIME_DEFAULTS)} default YAMLs under {PACKAGED_DEFAULTS}")
    wheel_boundary(args.wheel)
    print(
        f"{args.wheel.name}: no podcast_online, only {sorted(FOSS_EXTENSIONS)} under "
        f"{EXTENSIONS_GROUP}, {len(RELAY_STATIC)} relay static files"
    )
    if args.podcast:
        installed_without_online(args.podcast)
        installed_contracts(args.podcast)
        serve_check(args.podcast, args.port, index, refs)


if __name__ == "__main__":
    main()

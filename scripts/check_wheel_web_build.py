#!/usr/bin/env python3
"""Assert a release wheel ships the Sharecut Studio web build (#1085).

Checks that ``index.html`` and every ``./`` file it references sit under the
packaged web root. With ``--podcast``, also starts that installed ``podcast gui``
and requires ``/`` to return the wheel's ``index.html`` and each asset to load.

    python scripts/check_wheel_web_build.py dist/podcast_mcp-*.whl
    python scripts/check_wheel_web_build.py dist/podcast_mcp-*.whl --podcast venv/bin/podcast
"""

from __future__ import annotations

import argparse
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
    if args.podcast:
        serve_check(args.podcast, args.port, index, refs)


if __name__ == "__main__":
    main()

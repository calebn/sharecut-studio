#!/usr/bin/env python3
"""Run build_sidecar.py from any Tauri hook cwd (gui/desktop or src-tauri).

Windows cmd does not expand POSIX ``$(git …)``; walk parents instead.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def repo_root(start: Path) -> Path:
    for path in [start, *start.parents]:
        if (path / "scripts" / "build_sidecar.py").is_file():
            return path
    raise SystemExit(f"build_sidecar.py not found from {start}")


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        raise SystemExit("usage: tauri_sidecar_hook.py --ensure|--dev-stub|...")
    root = repo_root(Path.cwd().resolve())
    script = root / "scripts" / "build_sidecar.py"
    return subprocess.call([sys.executable, str(script), *args])


if __name__ == "__main__":
    raise SystemExit(main())

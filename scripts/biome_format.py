"""Format generated TypeScript with Biome (shared by codegen exporters)."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "gui" / "web"


def biome_format_ts(raw: str) -> str:
    biome = WEB / "node_modules" / ".bin" / "biome"
    config = WEB / "biome.json"
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        suffix=".ts",
        delete=False,
    ) as tmp:
        tmp.write(raw)
        tmp_path = Path(tmp.name)
    try:
        cmd: list[str]
        extra = ["--config-path", str(config)] if config.is_file() else []
        if biome.is_file():
            cmd = [str(biome), "check", "--write", *extra, str(tmp_path)]
        elif shutil.which("npx"):
            cmd = ["npx", "biome", "check", "--write", *extra, str(tmp_path)]
        else:
            return raw
        subprocess.run(cmd, cwd=WEB, check=False, capture_output=True)
        return tmp_path.read_text(encoding="utf-8")
    finally:
        tmp_path.unlink(missing_ok=True)

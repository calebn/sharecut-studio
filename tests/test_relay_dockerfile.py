"""Regression coverage for the self-contained relay container image."""

from __future__ import annotations

import ast
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RELAY_PACKAGE = ROOT / "src" / "podcast_relay"
DOCKERFILE = ROOT / "deploy" / "relay" / "Dockerfile"


def _copied_source_paths() -> set[Path]:
    """Return repository paths copied into the relay image by its Dockerfile."""
    copied: set[Path] = set()
    for line in DOCKERFILE.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) != 3 or parts[0] != "COPY" or not parts[1].startswith("src/"):
            continue
        source = ROOT / parts[1].rstrip("/")
        if parts[1].endswith("/"):
            copied.update(path for path in source.rglob("*.py"))
        else:
            copied.add(source)
    return copied


def _copy_relay_image_sources(image_root: Path) -> None:
    """Recreate Dockerfile source COPY instructions in a temporary image root."""
    for line in DOCKERFILE.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) != 3 or parts[0] != "COPY" or not parts[1].startswith("src/"):
            continue
        source = ROOT / parts[1].rstrip("/")
        destination = image_root / parts[2]
        if parts[1].endswith("/"):
            shutil.copytree(source, destination)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)


def _relay_podcast_mcp_imports() -> set[Path]:
    """Return source modules imported directly by the relay package."""
    imports: set[Path] = set()
    for path in RELAY_PACKAGE.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom) or not node.module:
                continue
            if not node.module.startswith("podcast_mcp."):
                continue
            module_path = ROOT / "src" / (node.module.replace(".", "/") + ".py")
            assert module_path.is_file(), f"{path.relative_to(ROOT)} imports missing {node.module}"
            imports.add(module_path)
    return imports


def test_relay_dockerfile_copies_every_direct_podcast_mcp_dependency() -> None:
    """The minimal image must still import ``python -m podcast_relay.app``."""
    copied = _copied_source_paths()
    missing = sorted(path.relative_to(ROOT) for path in _relay_podcast_mcp_imports() - copied)
    assert not missing, "relay Dockerfile omits locally imported modules:\n" + "\n".join(
        str(path) for path in missing
    )


def test_relay_image_sources_import_the_entrypoint(tmp_path: Path) -> None:
    """Catch missing transitive local imports without requiring a Docker daemon."""
    _copy_relay_image_sources(tmp_path)
    env = os.environ | {"PYTHONPATH": str(tmp_path)}
    result = subprocess.run(
        [sys.executable, "-c", "import podcast_relay.app"],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr

"""A home folder for the whole test session, so no test touches the developer's real one.

``conftest`` points ``HOME`` here before the first test and fails the session if a file
shows up in it that no third-party tool is known to write. Toolchain caches keep their real
location through the variables in ``TOOLCHAIN_CACHES``.
"""

from __future__ import annotations

from pathlib import Path

TOOLCHAIN_CACHES = {
    "CARGO_HOME": ".cargo",
    "RUSTUP_HOME": ".rustup",
    "UV_CACHE_DIR": ".cache/uv",
    "PIP_CACHE_DIR": ".cache/pip",
    "npm_config_cache": ".npm",
    "PLAYWRIGHT_BROWSERS_PATH": ".cache/ms-playwright",
    "HF_HOME": ".cache/huggingface",
}

# The model cache keeps its real place only where it already exists, so a clean home stays clean.
MODEL_CACHE = ("PODCAST_MCP_CACHE", ".cache/podcast_mcp")

# onnxruntime writes telemetry here; it is not ours and cannot be turned off from outside.
THIRD_PARTY_PREFIXES = (
    ".cache/Microsoft",
    "Library/Application Support/Microsoft",
)


def passthrough_env(real_home: Path, environ: dict[str, str]) -> dict[str, str]:
    """The cache variables to set so tools keep using the caches under ``real_home``."""
    caches = dict(TOOLCHAIN_CACHES)
    if (real_home / MODEL_CACHE[1]).is_dir():
        caches[MODEL_CACHE[0]] = MODEL_CACHE[1]
    return {
        name: str(real_home / relative) for name, relative in caches.items() if name not in environ
    }


def stray_files(home: Path) -> list[str]:
    """Files under ``home`` (relative, sorted) that no known third-party tool wrote; empty folders do not count."""
    found = []
    for path in sorted(home.rglob("*")):
        relative = path.relative_to(home).as_posix()
        if any(relative == p or relative.startswith(p + "/") for p in THIRD_PARTY_PREFIXES):
            continue
        if any(p.startswith(relative + "/") for p in THIRD_PARTY_PREFIXES):
            continue
        if path.is_file() or path.is_symlink():
            found.append(relative)
    return found

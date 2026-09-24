"""Streamed file digest contract shared by artifact consumers."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from podcast_mcp.util.hashing import sha256_file


@pytest.mark.parametrize("data", [b"", b"x", b"abcde"])
def test_sha256_file_across_chunk_boundaries(tmp_path: Path, data: bytes) -> None:
    path = tmp_path / "payload.bin"
    path.write_bytes(data)

    assert sha256_file(path, chunk_size=4) == hashlib.sha256(data).hexdigest()


def test_sha256_file_default_digest(tmp_path: Path) -> None:
    path = tmp_path / "payload.bin"
    path.write_bytes(b"hello")

    assert sha256_file(path) == ("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")


def test_sha256_file_rejects_nonpositive_chunk(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="chunk_size must be positive"):
        sha256_file(tmp_path / "missing", chunk_size=0)

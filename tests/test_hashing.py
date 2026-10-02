"""Streamed file digest contract shared by artifact consumers."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from podcast_mcp.util.hashing import sha256_file, sha256_head_tail, short_digest


def test_short_digest_keeps_text_sha256_prefixes() -> None:
    assert short_digest("abc") == "ba7816bf8f01cfea"
    assert short_digest("abc", 12) == "ba7816bf8f01"
    assert short_digest("abc", length=20) == "ba7816bf8f01cfea4141"
    assert short_digest("é") == "4a99557e4033c353"


@pytest.mark.parametrize("length", [0, -1, 65])
def test_short_digest_rejects_invalid_lengths(length: int) -> None:
    with pytest.raises(ValueError):
        short_digest("abc", length)


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


def test_sha256_head_tail_short_file_hashes_whole(tmp_path: Path) -> None:
    path = tmp_path / "p.bin"
    path.write_bytes(b"abcdef")
    assert sha256_head_tail(path, span=4) == hashlib.sha256(b"abcdef").hexdigest()


def test_sha256_head_tail_hashes_ends_only(tmp_path: Path) -> None:
    path = tmp_path / "p.bin"
    path.write_bytes(b"abcdXXXXwxyz")
    assert sha256_head_tail(path, span=4) == hashlib.sha256(b"abcdwxyz").hexdigest()
    path.write_bytes(b"abcdYYYYwxyz")  # middle-only change
    assert sha256_head_tail(path, span=4) == hashlib.sha256(b"abcdwxyz").hexdigest()
    path.write_bytes(b"abcdXXXXwxyZ")
    assert sha256_head_tail(path, span=4) != hashlib.sha256(b"abcdwxyz").hexdigest()


def test_sha256_head_tail_rejects_nonpositive_span(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="span must be positive"):
        sha256_head_tail(tmp_path / "missing", span=0)

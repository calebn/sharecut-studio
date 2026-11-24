"""A stored zip streamed from files, with its exact length known before the first byte."""

from __future__ import annotations

import io
import os
import time
import zipfile
from pathlib import Path

import pytest

from podcast_mcp.util.zip_stream import (
    ZipMember,
    ZipMemberChanged,
    stored_zip_chunks,
    stored_zip_length,
)

posix_only = pytest.mark.skipif(os.name == "nt", reason="symlinks need privileges on Windows")


def member(root: Path, name: str, data: bytes) -> ZipMember:
    path = root / f"{abs(hash(name))}.bin"
    path.write_bytes(data)
    stat = path.stat()
    return ZipMember(name, path, stat.st_size, stat.st_mtime_ns)


def padded(root: Path, name: str, size: int) -> ZipMember:
    return member(root, name, bytes(index % 251 for index in range(size)))


def archive(members: list[ZipMember], **kwargs: int) -> bytes:
    return b"".join(stored_zip_chunks(members, **kwargs))


def test_a_stored_zip_reads_back_byte_for_byte_at_its_predicted_length(tmp_path: Path) -> None:
    contents = {
        "empty.txt": b"",
        "seven.txt": b"1234567",
        "clips/big.wav": bytes(range(256)) * 280,
        "variants/é-ü/x.mp3": b"id3",
    }
    members = [member(tmp_path, name, data) for name, data in contents.items()]

    body = archive(members)

    assert len(body) == stored_zip_length(members)
    with zipfile.ZipFile(io.BytesIO(body)) as zf:
        assert zf.testzip() is None
        assert zf.namelist() == [
            "empty.txt",
            "seven.txt",
            "clips/big.wav",
            "variants/é-ü/x.mp3",
        ]
        assert {name: zf.read(name) for name in zf.namelist()} == contents
        assert {info.compress_type for info in zf.infolist()} == {zipfile.ZIP_STORED}


@pytest.mark.parametrize(
    "sizes",
    [[499, 500, 501], [999, 1000, 1001, 3000], [10] * 7, [600] * 4],
)
def test_every_zip64_branch_keeps_the_length_exact(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, sizes: list[int]
) -> None:
    monkeypatch.setattr(zipfile, "ZIP64_LIMIT", 1000)
    monkeypatch.setattr(zipfile, "ZIP_FILECOUNT_LIMIT", 5)
    members = [padded(tmp_path, f"m{index}.bin", size) for index, size in enumerate(sizes)]

    body = archive(members)

    assert len(body) == stored_zip_length(members)
    with zipfile.ZipFile(io.BytesIO(body)) as zf:
        assert zf.testzip() is None
        assert [len(zf.read(f"m{index}.bin")) for index in range(len(sizes))] == sizes


def test_a_member_that_changed_after_planning_stops_the_stream(tmp_path: Path) -> None:
    def planned(name: str) -> tuple[ZipMember, ZipMember]:
        return member(tmp_path, f"{name}-a", b"first"), member(tmp_path, f"{name}-b", b"second")

    first, grows = planned("grows")
    grows.path.write_bytes(b"second plus more")
    with pytest.raises(ZipMemberChanged):
        archive([first, grows])

    first, shrinks = planned("shrinks")
    shrinks.path.write_bytes(b"2nd")
    with pytest.raises(ZipMemberChanged):
        archive([first, shrinks])

    first, touched = planned("touched")
    os.utime(touched.path, ns=(touched.mtime_ns + 5_000_000_000, touched.mtime_ns + 5_000_000_000))
    with pytest.raises(ZipMemberChanged):
        archive([first, touched])

    first, gone = planned("gone")
    gone.path.unlink()
    with pytest.raises(OSError):
        archive([first, gone])


@posix_only
def test_a_member_swapped_for_a_symlink_is_never_followed(tmp_path: Path) -> None:
    outside = tmp_path / "outside.txt"
    outside.write_bytes(b"secret")
    victim = member(tmp_path, "victim.txt", b"secret")
    victim.path.unlink()
    victim.path.symlink_to(outside)

    with pytest.raises(OSError):
        archive([victim])


@pytest.mark.parametrize(
    "name",
    ["", "../x", "/x", "a//b", "a\\b", "./x", "a/./b", "a/../b", "a/", "..", "a\0b", "\udcff.wav"],
)
def test_an_unsafe_name_is_refused(tmp_path: Path, name: str) -> None:
    with pytest.raises(ValueError, match="zip member name"):
        ZipMember(name, tmp_path / "x", 0, 0)


def test_a_duplicate_name_is_refused(tmp_path: Path) -> None:
    twice = [member(tmp_path, "a.txt", b"1"), member(tmp_path, "a.txt", b"2")]

    with pytest.raises(ValueError, match="duplicate"):
        stored_zip_length(twice)


def test_no_chunk_holds_more_than_one_read_and_a_header(tmp_path: Path) -> None:
    members = [padded(tmp_path, "a.bin", 50_000), padded(tmp_path, "b.bin", 30_000)]
    chunk_size = 4096

    sizes = [len(chunk) for chunk in stored_zip_chunks(members, chunk_size=chunk_size)]

    assert max(sizes) <= chunk_size + 200
    assert sum(sizes) == stored_zip_length(members)


def test_entry_dates_are_the_file_time_clamped_to_1980(tmp_path: Path) -> None:
    recent = member(tmp_path, "recent.txt", b"r")
    ancient = member(tmp_path, "ancient.txt", b"a")
    stamp = time.mktime((2021, 3, 4, 5, 6, 8, 0, 0, -1))
    os.utime(recent.path, (stamp, stamp))
    os.utime(ancient.path, (0, 0))
    members = [
        ZipMember(m.name, m.path, m.size, m.path.stat().st_mtime_ns) for m in (recent, ancient)
    ]

    with zipfile.ZipFile(io.BytesIO(archive(members))) as zf:
        dates = {info.filename: info.date_time for info in zf.infolist()}

    assert dates == {
        "recent.txt": (2021, 3, 4, 5, 6, 8),
        "ancient.txt": (1980, 1, 1, 0, 0, 0),
    }


def _step(chunks, count: int = 1) -> None:
    for _ in range(count):
        next(chunks)


def test_a_member_truncated_while_it_is_read_stops_the_stream(tmp_path: Path) -> None:
    only = padded(tmp_path, "big.bin", 5000)
    chunks = stored_zip_chunks([only], chunk_size=1000)
    _step(chunks, 2)

    with only.path.open("r+b") as live:
        live.truncate(1500)

    with pytest.raises(ZipMemberChanged, match="ended early|changed while it was read"):
        list(chunks)


def test_a_member_that_grows_while_it_is_read_stops_the_stream(tmp_path: Path) -> None:
    only = padded(tmp_path, "big.bin", 3000)
    chunks = stored_zip_chunks([only], chunk_size=1000)
    _step(chunks, 2)

    with only.path.open("ab") as live:
        live.write(b"more")

    with pytest.raises(ZipMemberChanged, match="grew"):
        list(chunks)


def test_a_same_size_rewrite_during_the_read_stops_the_stream(tmp_path: Path) -> None:
    only = padded(tmp_path, "big.bin", 3000)
    chunks = stored_zip_chunks([only], chunk_size=1000)
    _step(chunks, 2)

    only.path.write_bytes(b"x" * 3000)
    later = only.mtime_ns + 5_000_000_000
    os.utime(only.path, ns=(later, later))

    with pytest.raises(ZipMemberChanged, match="changed"):
        list(chunks)

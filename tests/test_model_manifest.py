from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest
from huggingface_hub.errors import LocalEntryNotFoundError

from podcast_mcp.util import model_manifest
from podcast_mcp.util.model_manifest import (
    PinnedSnapshot,
    PinnedSnapshotMissingError,
    clear_manifest_memo,
    download_pinned_snapshot,
    manifest_files,
    manifest_mismatch,
    missing_files,
    resolve_pinned_snapshot,
)


@pytest.fixture(autouse=True)
def _reset_memo():
    clear_manifest_memo()
    yield
    clear_manifest_memo()


def _write(root: Path, name: str, data: bytes) -> None:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def _sha256(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data).hexdigest()


def test_missing_files_lists_absent_names(tmp_path: Path) -> None:
    _write(tmp_path, "a.txt", b"a")
    manifest = (("a.txt", _sha256(b"a")), ("b.txt", _sha256(b"b")))
    assert missing_files(tmp_path, manifest) == ["b.txt"]


def test_manifest_mismatch_none_on_match(tmp_path: Path) -> None:
    _write(tmp_path, "a.txt", b"a")
    manifest = (("a.txt", _sha256(b"a")),)
    assert manifest_mismatch(tmp_path, manifest) is None


def test_manifest_mismatch_reports_missing_file(tmp_path: Path) -> None:
    manifest = (("missing.txt", _sha256(b"x")),)
    assert manifest_mismatch(tmp_path, manifest) == "missing.txt is missing"


def test_manifest_mismatch_reports_first_differing_file(tmp_path: Path) -> None:
    _write(tmp_path, "a.txt", b"a")
    _write(tmp_path, "b.txt", b"wrong")
    manifest = (("a.txt", _sha256(b"a")), ("b.txt", _sha256(b"b")))
    mismatch = manifest_mismatch(tmp_path, manifest)
    assert mismatch is not None
    assert mismatch.startswith("b.txt sha256 ")
    assert mismatch.endswith("does not match the pin")
    assert _sha256(b"wrong")[:12] in mismatch


def test_manifest_mismatch_reports_only_the_first_of_several(tmp_path: Path) -> None:
    _write(tmp_path, "a.txt", b"wrong-a")
    _write(tmp_path, "b.txt", b"wrong-b")
    manifest = (("a.txt", _sha256(b"a")), ("b.txt", _sha256(b"b")))
    mismatch = manifest_mismatch(tmp_path, manifest)
    assert mismatch is not None
    assert mismatch.startswith("a.txt ")


def test_pinned_snapshot_allow_patterns_matches_manifest_files() -> None:
    manifest = (("a.txt", "x" * 64), ("b/c.txt", "y" * 64))
    snap = PinnedSnapshot(hf_repo="org/repo", revision="deadbeef", file_sha256=manifest)
    assert snap.allow_patterns == manifest_files(manifest)
    assert snap.allow_patterns == ["a.txt", "b/c.txt"]


def test_memoized_hash_reused_for_an_unchanged_file(tmp_path: Path, monkeypatch) -> None:
    _write(tmp_path, "a.txt", b"a")
    manifest = (("a.txt", _sha256(b"a")),)
    calls: list[Path] = []

    def fake_sha256(p: Path) -> str:
        calls.append(p)
        return _sha256(b"a")

    monkeypatch.setattr(model_manifest, "sha256_file", fake_sha256)

    assert manifest_mismatch(tmp_path, manifest, memoize=True) is None
    assert manifest_mismatch(tmp_path, manifest, memoize=True) is None
    assert len(calls) == 1
    assert str((tmp_path / "a.txt").resolve()) not in model_manifest._MEMO_LOCKS


def test_memoized_hash_re_hashes_after_the_file_changes(tmp_path: Path, monkeypatch) -> None:
    _write(tmp_path, "a.txt", b"a")
    manifest = (("a.txt", _sha256(b"a")),)
    calls: list[Path] = []

    def fake_sha256(p: Path) -> str:
        calls.append(p)
        return _sha256(p.read_bytes())

    monkeypatch.setattr(model_manifest, "sha256_file", fake_sha256)

    assert manifest_mismatch(tmp_path, manifest, memoize=True) is None
    _write(tmp_path, "a.txt", b"ab")
    assert manifest_mismatch(tmp_path, manifest, memoize=True) is not None
    assert len(calls) == 2


def test_memoized_mismatch_stays_remembered_until_the_file_changes(
    tmp_path: Path, monkeypatch
) -> None:
    _write(tmp_path, "a.txt", b"a")
    manifest = (("a.txt", _sha256(b"expected")),)
    calls: list[Path] = []

    def fake_sha256(p: Path) -> str:
        calls.append(p)
        return _sha256(b"a")

    monkeypatch.setattr(model_manifest, "sha256_file", fake_sha256)

    assert manifest_mismatch(tmp_path, manifest, memoize=True) is not None
    assert manifest_mismatch(tmp_path, manifest, memoize=True) is not None
    assert len(calls) == 1

    _write(tmp_path, "a.txt", b"ab")
    manifest_mismatch(tmp_path, manifest, memoize=True)
    assert len(calls) == 2


def test_memoize_false_always_hashes(tmp_path: Path, monkeypatch) -> None:
    _write(tmp_path, "a.txt", b"a")
    manifest = (("a.txt", _sha256(b"a")),)
    calls: list[Path] = []

    def fake_sha256(p: Path) -> str:
        calls.append(p)
        return _sha256(b"a")

    monkeypatch.setattr(model_manifest, "sha256_file", fake_sha256)

    manifest_mismatch(tmp_path, manifest, memoize=False)
    manifest_mismatch(tmp_path, manifest, memoize=False)
    assert len(calls) == 2


def test_concurrent_status_checks_hash_an_unchanged_file_once(tmp_path: Path, monkeypatch) -> None:
    _write(tmp_path, "a.txt", b"a")
    manifest = (("a.txt", _sha256(b"a")),)
    calls: list[Path] = []

    def fake_sha256(p: Path) -> str:
        calls.append(p)
        time.sleep(0.05)
        return _sha256(b"a")

    monkeypatch.setattr(model_manifest, "sha256_file", fake_sha256)

    results: list[str | None] = []
    threads = [
        threading.Thread(
            target=lambda: results.append(manifest_mismatch(tmp_path, manifest, memoize=True))
        )
        for _ in range(2)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert results == [None, None]
    assert len(calls) == 1
    assert str((tmp_path / "a.txt").resolve()) not in model_manifest._MEMO_LOCKS


def test_oserror_during_memoized_hash_propagates_and_is_not_cached(
    tmp_path: Path, monkeypatch
) -> None:
    _write(tmp_path, "a.txt", b"a")
    manifest = (("a.txt", _sha256(b"a")),)
    calls = {"n": 0}

    def flaky_sha256(p: Path) -> str:
        calls["n"] += 1
        if calls["n"] == 1:
            raise OSError("vanished")
        return _sha256(b"a")

    monkeypatch.setattr(model_manifest, "sha256_file", flaky_sha256)

    with pytest.raises(OSError):
        manifest_mismatch(tmp_path, manifest, memoize=True)
    assert str((tmp_path / "a.txt").resolve()) not in model_manifest._MEMO_LOCKS

    # Recovers on the next call instead of the OSError being remembered.
    assert manifest_mismatch(tmp_path, manifest, memoize=True) is None
    assert calls["n"] == 2
    assert str((tmp_path / "a.txt").resolve()) not in model_manifest._MEMO_LOCKS


def _pin(tmp_path: Path) -> tuple[PinnedSnapshot, Path]:
    snap = tmp_path / "snap"
    _write(snap, "a.txt", b"a")
    return PinnedSnapshot("org/repo", "deadbeef", (("a.txt", _sha256(b"a")),)), snap


def test_resolve_pinned_snapshot_reads_the_local_cache_only(tmp_path: Path, monkeypatch) -> None:
    pin, snap = _pin(tmp_path)
    seen: dict[str, object] = {}

    def fake(repo, **kwargs):
        seen.update(kwargs)
        return str(snap)

    monkeypatch.setattr("huggingface_hub.snapshot_download", fake, raising=False)
    assert resolve_pinned_snapshot(pin, tmp_path / "cache") == snap
    assert seen["local_files_only"] is True
    assert seen["revision"] == "deadbeef"
    assert seen["allow_patterns"] == ["a.txt"]


def test_resolve_pinned_snapshot_reports_a_partial_download(tmp_path: Path, monkeypatch) -> None:
    pin, snap = _pin(tmp_path)
    (snap / "a.txt").unlink()
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", lambda *a, **k: str(snap), raising=False
    )
    with pytest.raises(PinnedSnapshotMissingError) as excinfo:
        resolve_pinned_snapshot(pin, tmp_path / "cache")
    assert excinfo.value.detail == "partial download"


@pytest.mark.parametrize(
    "error", [LocalEntryNotFoundError("absent"), OSError("broken snapshot symlink")]
)
def test_resolve_pinned_snapshot_maps_hub_errors_to_missing(
    tmp_path: Path, monkeypatch, error: OSError
) -> None:
    pin, _ = _pin(tmp_path)

    def raise_error(*a, **k):
        raise error

    monkeypatch.setattr("huggingface_hub.snapshot_download", raise_error, raising=False)
    with pytest.raises(PinnedSnapshotMissingError):
        resolve_pinned_snapshot(pin, tmp_path / "cache")


def test_download_pinned_snapshot_verifies_the_download(tmp_path: Path, monkeypatch) -> None:
    pin, snap = _pin(tmp_path)
    seen: dict[str, object] = {}

    def fake(repo, **kwargs):
        seen.update(kwargs)
        return str(snap)

    monkeypatch.setattr("huggingface_hub.snapshot_download", fake, raising=False)
    assert download_pinned_snapshot(pin, tmp_path / "cache") == (snap, None)
    assert seen["force_download"] is False
    assert "local_files_only" not in seen


def _fake_download(snap: Path, calls: list[bool], repaired: bytes | None):
    def fake(repo, **kwargs):
        calls.append(kwargs["force_download"])
        if kwargs["force_download"] and repaired is not None:
            (snap / "a.txt").write_bytes(repaired)
        return str(snap)

    return fake


def test_download_pinned_snapshot_refetches_a_cached_mismatch_once(
    tmp_path: Path, monkeypatch
) -> None:
    pin, snap = _pin(tmp_path)
    (snap / "a.txt").write_bytes(b"tampered")
    calls: list[bool] = []
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", _fake_download(snap, calls, b"a"), raising=False
    )
    assert download_pinned_snapshot(pin, tmp_path / "cache") == (snap, None)
    assert calls == [False, True]


def test_download_pinned_snapshot_reports_a_mismatch_the_refetch_keeps(
    tmp_path: Path, monkeypatch
) -> None:
    pin, snap = _pin(tmp_path)
    (snap / "a.txt").write_bytes(b"tampered")
    calls: list[bool] = []
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", _fake_download(snap, calls, None), raising=False
    )
    _, mismatch = download_pinned_snapshot(pin, tmp_path / "cache")
    assert mismatch is not None and mismatch.startswith("a.txt ")
    assert calls == [False, True]


def test_download_pinned_snapshot_with_force_fetches_once(tmp_path: Path, monkeypatch) -> None:
    pin, snap = _pin(tmp_path)
    (snap / "a.txt").write_bytes(b"tampered")
    calls: list[bool] = []
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", _fake_download(snap, calls, None), raising=False
    )
    _, mismatch = download_pinned_snapshot(pin, tmp_path / "cache", force=True)
    assert mismatch is not None
    assert calls == [True]


def test_memoized_hashes_of_different_files_run_in_parallel(tmp_path: Path, monkeypatch) -> None:
    _write(tmp_path, "big.bin", b"big")
    _write(tmp_path, "small.txt", b"small")
    big_started = threading.Event()
    release_big = threading.Event()

    def fake_sha256(p: Path) -> str:
        if p.name == "big.bin":
            big_started.set()
            release_big.wait(5)
            return _sha256(b"big")
        return _sha256(b"small")

    monkeypatch.setattr(model_manifest, "sha256_file", fake_sha256)
    big = threading.Thread(
        target=manifest_mismatch,
        args=(tmp_path, (("big.bin", _sha256(b"big")),)),
        kwargs={"memoize": True},
    )
    big.start()
    assert big_started.wait(5)
    small_result: list[str | None] = []
    small = threading.Thread(
        target=lambda: small_result.append(
            manifest_mismatch(tmp_path, (("small.txt", _sha256(b"small")),), memoize=True)
        )
    )
    small.start()
    small.join(5)
    finished_while_big_hashed = not small.is_alive()
    release_big.set()
    big.join(5)
    small.join(5)
    assert finished_while_big_hashed
    assert small_result == [None]

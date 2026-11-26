from __future__ import annotations

import importlib.util
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
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
    hash_started = threading.Event()
    release_hash = threading.Event()
    lock_contended = threading.Event()

    def fake_sha256(p: Path) -> str:
        calls.append(p)
        hash_started.set()
        assert release_hash.wait(timeout=5)
        return _sha256(b"a")

    monkeypatch.setattr(model_manifest, "sha256_file", fake_sha256)

    real_get = model_manifest._MEMO_LOCKS.get

    class ObservedLock:
        def __init__(self, lock: threading.Lock) -> None:
            self.lock = lock

        def __enter__(self):
            if not self.lock.acquire(blocking=False):
                lock_contended.set()
                if not self.lock.acquire(timeout=5):
                    raise TimeoutError("timed out waiting for the memoized hash lock")
            return self.lock

        def __exit__(self, *_):
            self.lock.release()

    monkeypatch.setattr(
        model_manifest._MEMO_LOCKS,
        "get",
        lambda key: ObservedLock(real_get(key)),
    )

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(manifest_mismatch, tmp_path, manifest, memoize=True)
        try:
            assert hash_started.wait(timeout=5)
            second = executor.submit(manifest_mismatch, tmp_path, manifest, memoize=True)
            assert lock_contended.wait(timeout=5)
        finally:
            release_hash.set()
        assert [first.result(timeout=5), second.result(timeout=5)] == [None, None]

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


def _hub_constants():
    from huggingface_hub import constants

    return constants


_ORIGINAL_CHUNK = 7 * 1024 * 1024


def _plain_http_baseline(monkeypatch) -> object:
    """Pin both settings to known non-plain-HTTP values and return the hub constants."""
    constants = _hub_constants()
    monkeypatch.setattr(constants, "DOWNLOAD_CHUNK_SIZE", _ORIGINAL_CHUNK)
    monkeypatch.setattr(constants, "HF_HUB_DISABLE_XET", False)
    return constants


def _assert_plain_http(constants) -> None:
    assert constants.DOWNLOAD_CHUNK_SIZE == 1024 * 1024
    assert constants.HF_HUB_DISABLE_XET is True


def _assert_restored(constants) -> None:
    assert constants.DOWNLOAD_CHUNK_SIZE == _ORIGINAL_CHUNK
    assert constants.HF_HUB_DISABLE_XET is False


def test_plain_http_hub_sets_both_settings_inside_and_restores_after(monkeypatch) -> None:
    constants = _plain_http_baseline(monkeypatch)

    with model_manifest._plain_http_hub():
        _assert_plain_http(constants)

    _assert_restored(constants)


def test_plain_http_hub_restores_after_an_exception(monkeypatch) -> None:
    constants = _plain_http_baseline(monkeypatch)

    with pytest.raises(RuntimeError, match="boom"):
        with model_manifest._plain_http_hub():
            raise RuntimeError("boom")

    _assert_restored(constants)


def test_plain_http_hub_nested_restores_the_originals_once(monkeypatch) -> None:
    constants = _plain_http_baseline(monkeypatch)

    with model_manifest._plain_http_hub():
        with model_manifest._plain_http_hub():
            _assert_plain_http(constants)
        _assert_plain_http(constants)

    _assert_restored(constants)


def test_plain_http_hub_overlapping_out_of_order_exit_restores_the_originals(
    monkeypatch,
) -> None:
    constants = _plain_http_baseline(monkeypatch)
    first = model_manifest._plain_http_hub()
    second = model_manifest._plain_http_hub()

    first.__enter__()
    try:
        second.__enter__()
        try:
            first.__exit__(None, None, None)
            _assert_plain_http(constants)
        finally:
            second.__exit__(None, None, None)
    finally:
        if constants.DOWNLOAD_CHUNK_SIZE != _ORIGINAL_CHUNK:
            first.__exit__(None, None, None)

    _assert_restored(constants)


@pytest.mark.parametrize("missing", ["DOWNLOAD_CHUNK_SIZE", "HF_HUB_DISABLE_XET"])
def test_plain_http_hub_tolerates_a_missing_attribute_with_a_warning(
    monkeypatch, caplog, missing: str
) -> None:
    constants = _plain_http_baseline(monkeypatch)
    other = "HF_HUB_DISABLE_XET" if missing == "DOWNLOAD_CHUNK_SIZE" else "DOWNLOAD_CHUNK_SIZE"
    monkeypatch.delattr(constants, missing)

    with caplog.at_level(logging.WARNING):
        with model_manifest._plain_http_hub():
            assert not hasattr(constants, missing)
            assert getattr(constants, other) == (
                1024 * 1024 if other == "DOWNLOAD_CHUNK_SIZE" else True
            )

    assert not hasattr(constants, missing)
    assert getattr(constants, other) == (
        _ORIGINAL_CHUNK if other == "DOWNLOAD_CHUNK_SIZE" else False
    )
    warned = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warned) == 1
    assert missing in warned[0].getMessage()


def test_plain_http_hub_warns_once_per_missing_attribute(monkeypatch, caplog) -> None:
    constants = _hub_constants()
    monkeypatch.delattr(constants, "DOWNLOAD_CHUNK_SIZE")
    monkeypatch.delattr(constants, "HF_HUB_DISABLE_XET")

    with caplog.at_level(logging.WARNING):
        with model_manifest._plain_http_hub():
            pass

    messages = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert len(messages) == 2
    assert any("DOWNLOAD_CHUNK_SIZE" in m for m in messages)
    assert any("HF_HUB_DISABLE_XET" in m for m in messages)


@pytest.mark.skipif(importlib.util.find_spec("hf_xet") is None, reason="hf_xet is not installed")
def test_plain_http_hub_makes_xet_unavailable_inside_and_restores_after(monkeypatch) -> None:
    from huggingface_hub.utils import _runtime

    _plain_http_baseline(monkeypatch)
    assert _runtime.is_xet_available() is True

    with model_manifest._plain_http_hub():
        assert _runtime.is_xet_available() is False

    assert _runtime.is_xet_available() is True


def test_download_pinned_snapshot_downloads_inside_the_plain_http_window(
    tmp_path: Path, monkeypatch
) -> None:
    import hashlib

    import huggingface_hub

    constants = _plain_http_baseline(monkeypatch)
    payload = b"model"
    pin = PinnedSnapshot(
        "acme/model", "a" * 40, (("model.bin", hashlib.sha256(payload).hexdigest()),)
    )
    seen: dict[str, object] = {}

    def fake_snapshot_download(*_args: object, **_kwargs: object) -> str:
        seen["chunk"] = constants.DOWNLOAD_CHUNK_SIZE
        seen["xet_disabled"] = constants.HF_HUB_DISABLE_XET
        root = tmp_path / "snapshot"
        root.mkdir(exist_ok=True)
        (root / "model.bin").write_bytes(payload)
        return str(root)

    monkeypatch.setattr(huggingface_hub, "snapshot_download", fake_snapshot_download)

    _, mismatch = download_pinned_snapshot(pin, tmp_path / "hub")

    assert mismatch is None
    assert seen == {"chunk": model_manifest.HUB_CHUNK_BYTES, "xet_disabled": True}
    _assert_restored(constants)


class _GuardedConstants:
    """Stands in for ``huggingface_hub.constants``; records every access made without the lock."""

    values: dict[str, object]
    fail_on: str | None
    unlocked: list[str]

    def __init__(self, fail_on: str | None = None) -> None:
        object.__setattr__(self, "values", {"DOWNLOAD_CHUNK_SIZE": _ORIGINAL_CHUNK})
        self.values["HF_HUB_DISABLE_XET"] = False
        object.__setattr__(self, "fail_on", fail_on)
        object.__setattr__(self, "unlocked", [])

    def __getattr__(self, name: str) -> object:
        values = object.__getattribute__(self, "values")
        if name not in values:
            raise AttributeError(name)
        if not model_manifest._plain_http_lock.locked():
            self.unlocked.append(f"get {name}")
        return values[name]

    def __setattr__(self, name: str, value: object) -> None:
        if not model_manifest._plain_http_lock.locked():
            self.unlocked.append(f"set {name}")
        if name == self.fail_on and value is True:
            raise RuntimeError(f"cannot set {name}")
        self.values[name] = value


def _use_guarded_constants(monkeypatch, fail_on: str | None = None) -> _GuardedConstants:
    import huggingface_hub

    _hub_constants()
    fake = _GuardedConstants(fail_on)
    monkeypatch.setattr(huggingface_hub, "constants", fake)
    return fake


def test_plain_http_hub_rolls_back_a_partial_patch_when_the_second_setting_fails(
    monkeypatch,
) -> None:
    fake = _use_guarded_constants(monkeypatch, fail_on="HF_HUB_DISABLE_XET")

    with pytest.raises(RuntimeError, match="cannot set HF_HUB_DISABLE_XET"):
        with model_manifest._plain_http_hub():
            pytest.fail("the window must not open when a setting cannot be applied")

    assert fake.values["DOWNLOAD_CHUNK_SIZE"] == _ORIGINAL_CHUNK
    assert fake.values["HF_HUB_DISABLE_XET"] is False
    assert model_manifest._plain_http_depth == 0
    assert model_manifest._plain_http_originals == {}


def test_plain_http_hub_changes_the_settings_only_while_holding_its_lock(monkeypatch) -> None:
    fake = _use_guarded_constants(monkeypatch)

    with model_manifest._plain_http_hub():
        assert fake.values["DOWNLOAD_CHUNK_SIZE"] == 1024 * 1024

    assert fake.values["DOWNLOAD_CHUNK_SIZE"] == _ORIGINAL_CHUNK
    assert fake.unlocked == []


def test_plain_http_hub_many_threads_keep_every_access_under_the_lock(
    monkeypatch,
) -> None:
    fake = _use_guarded_constants(monkeypatch)
    workers = 8
    rounds = 50
    inside = threading.Barrier(workers)
    seen_inside: list[int] = []

    def worker() -> None:
        inside.wait(timeout=10)
        for _ in range(rounds):
            with model_manifest._plain_http_hub():
                seen_inside.append(fake.values["DOWNLOAD_CHUNK_SIZE"])

    threads = [threading.Thread(target=worker) for _ in range(workers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)
    assert not any(thread.is_alive() for thread in threads)

    assert set(seen_inside) == {1024 * 1024}
    assert len(seen_inside) == workers * rounds
    assert fake.values["DOWNLOAD_CHUNK_SIZE"] == _ORIGINAL_CHUNK
    assert fake.values["HF_HUB_DISABLE_XET"] is False
    assert model_manifest._plain_http_depth == 0
    assert fake.unlocked == []

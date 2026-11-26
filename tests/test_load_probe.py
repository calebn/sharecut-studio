"""The cached result of loading a model file that passed its pin (#1998)."""

from __future__ import annotations

import os
import threading
from pathlib import Path

import pytest


@pytest.fixture
def onnx_file(tmp_path: Path) -> Path:
    path = tmp_path / "model.onnx"
    path.write_bytes(b"pinned")
    return path


def test_an_unrecorded_file_has_no_failure(onnx_file: Path) -> None:
    from podcast_mcp.engines.models import load_probe

    assert load_probe.failure(onnx_file) is None


def test_a_recorded_failure_is_returned(onnx_file: Path) -> None:
    from podcast_mcp.engines.models import load_probe

    load_probe.record(onnx_file, "RuntimeError: unsupported opset 99")
    assert load_probe.failure(onnx_file) == "RuntimeError: unsupported opset 99"


def test_a_success_clears_an_earlier_failure(onnx_file: Path) -> None:
    from podcast_mcp.engines.models import load_probe

    load_probe.record(onnx_file, "RuntimeError: boom")
    load_probe.record(onnx_file, None)
    assert load_probe.failure(onnx_file) is None


def test_forget_drops_the_failure(onnx_file: Path) -> None:
    from podcast_mcp.engines.models import load_probe

    load_probe.record(onnx_file, "RuntimeError: boom")
    load_probe.forget(onnx_file)
    assert load_probe.failure(onnx_file) is None


def test_a_new_mtime_is_a_miss(onnx_file: Path) -> None:
    from podcast_mcp.engines.models import load_probe

    load_probe.record(onnx_file, "RuntimeError: boom")
    stat = onnx_file.stat()
    os.utime(onnx_file, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))
    assert load_probe.failure(onnx_file) is None


def test_a_new_size_is_a_miss(onnx_file: Path) -> None:
    from podcast_mcp.engines.models import load_probe

    load_probe.record(onnx_file, "RuntimeError: boom")
    stat = onnx_file.stat()
    onnx_file.write_bytes(b"pinned and longer")
    os.utime(onnx_file, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    assert load_probe.failure(onnx_file) is None


def test_a_changed_onnxruntime_version_is_a_miss(
    onnx_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from importlib import metadata

    from podcast_mcp.engines.models import load_probe

    monkeypatch.setattr(metadata, "version", lambda _name: "1.0.0")
    load_probe.record(onnx_file, "RuntimeError: boom")
    monkeypatch.setattr(metadata, "version", lambda _name: "2.0.0")
    assert load_probe.failure(onnx_file) is None


def test_an_absent_onnxruntime_still_keys_the_file(
    onnx_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from importlib import metadata

    from podcast_mcp.engines.models import load_probe

    def absent(_name: str) -> str:
        raise metadata.PackageNotFoundError

    monkeypatch.setattr(metadata, "version", absent)
    load_probe.record(onnx_file, "RuntimeError: boom")
    assert load_probe.failure(onnx_file) == "RuntimeError: boom"


def test_error_text_names_the_file_by_its_basename(tmp_path: Path) -> None:
    from podcast_mcp.engines.models import load_probe

    model = tmp_path / "deep" / "model.onnx"
    model.parent.mkdir()
    exc = RuntimeError(f"Load model from {model} failed")
    text = load_probe.error_text(exc, model)
    assert text == "RuntimeError: Load model from model.onnx failed"
    assert str(tmp_path) not in text


def test_error_text_is_capped_at_200_characters(tmp_path: Path) -> None:
    from podcast_mcp.engines.models import load_probe

    text = load_probe.error_text(RuntimeError("x" * 500), tmp_path / "model.onnx")
    assert len(text) == 200
    assert text.startswith("RuntimeError: xxx")


def test_error_text_names_a_symlinked_file_by_its_basename(tmp_path: Path) -> None:
    from podcast_mcp.engines.models import load_probe

    real = tmp_path / "real" / "model.onnx"
    real.parent.mkdir()
    real.write_bytes(b"x")
    link = tmp_path / "link.onnx"
    link.symlink_to(real)
    text = load_probe.error_text(RuntimeError(f"Load model from {real} failed"), link)
    assert str(tmp_path) not in text


def test_the_key_follows_the_resolved_path(onnx_file: Path, tmp_path: Path) -> None:
    from podcast_mcp.engines.models import load_probe

    link = tmp_path / "link.onnx"
    link.symlink_to(onnx_file)
    load_probe.record(link, "RuntimeError: boom")
    assert load_probe.failure(onnx_file) == "RuntimeError: boom"


def test_a_missing_file_has_no_failure_and_records_nothing(tmp_path: Path) -> None:
    from podcast_mcp.engines.models import load_probe

    gone = tmp_path / "gone.onnx"
    load_probe.record(gone, "RuntimeError: boom")
    assert load_probe.failure(gone) is None
    load_probe.forget(gone)


def test_failure_never_loads_the_model(onnx_file: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from podcast_mcp.engines import onnx_session
    from podcast_mcp.engines.models import load_probe

    def boom(*_a, **_k):
        raise AssertionError("a status read built a session")

    monkeypatch.setattr(onnx_session, "OnnxModel", boom)
    load_probe.record(onnx_file, "RuntimeError: boom")
    assert load_probe.failure(onnx_file) == "RuntimeError: boom"


def test_concurrent_record_forget_and_failure_do_not_raise(onnx_file: Path) -> None:
    from podcast_mcp.engines.models import load_probe

    errors: list[BaseException] = []

    def hammer(n: int) -> None:
        try:
            for i in range(200):
                load_probe.record(onnx_file, f"RuntimeError: {n}-{i}" if i % 2 else None)
                load_probe.failure(onnx_file)
                if i % 50 == 0:
                    load_probe.forget(onnx_file)
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=hammer, args=(n,)) for n in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []

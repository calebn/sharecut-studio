from __future__ import annotations

import re
import urllib.request
from collections.abc import Callable
from pathlib import Path

import pytest

from podcast_mcp.engines import whisper_cpp
from podcast_mcp.engines.models import whisper_cpp_models as wcm
from podcast_mcp.engines.models.registry import (
    ModelNotRemovable,
    model_spec,
    remove_model,
)
from podcast_mcp.engines.models.whisper import (
    DEFAULT_WHISPER_MODEL,
    persist_whisper_model,
    resolve_whisper_model,
    validate_whisper_model,
)
from podcast_mcp.services.pipeline import bootstrap as boot
from podcast_mcp.services.pipeline.config import ensure_whisper_cached_for_run
from podcast_mcp.util import asset_sources, native_ffmpeg, native_whisper
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.host_platform import IOS, MACOS
from podcast_mcp.util.model_missing import ModelMissing

SMALL = "small.en-q5_1"
BASE = "base.en-q5_1"
SMALL_FILE = "ggml-small.en-q5_1.bin"
BASE_FILE = "ggml-base.en-q5_1.bin"


@pytest.fixture
def ios(host: Callable[..., None], monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.setattr(native_ffmpeg, "is_available", lambda: True)
    monkeypatch.setattr(native_ffmpeg, "build_id", lambda: "9.0.2+test")
    monkeypatch.setattr(native_ffmpeg, "is_installed", lambda: True)
    monkeypatch.setattr(native_whisper, "is_installed", lambda: True)
    monkeypatch.delenv("WHISPER_CPP_MODEL", raising=False)
    monkeypatch.delenv("WHISPER_CPP_MODEL_NAME", raising=False)
    monkeypatch.delenv("PODCAST_WHISPER_MODEL", raising=False)
    host(IOS)
    return wcm.whisper_cpp_cache_dir()


def _whisper_row() -> dict:
    return next(m for m in boot.component_status()["models"] if m["id"] == "whisper")


def test_each_variant_maps_to_its_own_file(ios: Path) -> None:
    assert wcm.variant_path(SMALL) == ios / SMALL_FILE
    assert wcm.variant_path(BASE) == ios / BASE_FILE
    assert wcm.DEFAULT_VARIANT == SMALL
    assert whisper_cpp.IOS_MODEL_NAME == SMALL_FILE


def test_an_unknown_variant_is_refused_before_any_path_is_built(ios: Path) -> None:
    with pytest.raises(CodedValueError):
        wcm.variant_path("../../etc/passwd")


def test_the_manifest_pins_both_files_by_size_and_hash() -> None:
    for variant in wcm.VARIANTS:
        entry = asset_sources.asset_entry(variant.asset_id)
        assert entry["filename"] == variant.filename
        assert entry["url"] == (
            f"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{variant.filename}"
        )
        assert re.fullmatch(r"[0-9a-f]{64}", entry["sha256"])
        assert entry["verified"] is True
        assert wcm.size_bytes(variant.id) == entry["size_bytes"]
    assert wcm.size_bytes(SMALL) == 190_098_681
    assert wcm.size_bytes(BASE) == 59_721_011


def test_the_status_payload_on_a_whisper_cpp_host_lists_its_two_variants(ios: Path) -> None:
    status = boot.component_status()
    assert [(m["id"], m["label"], m["size"], m["cached"]) for m in status["whisper_models"]] == [
        (SMALL, "Recommended", "190 MB", False),
        (BASE, "Less accurate", "60 MB", False),
    ]
    assert status["whisper_model"] == SMALL
    row = _whisper_row()
    assert row["model"] == SMALL
    assert row["size"] == "190 MB"
    assert row["size_bytes"] == 190_098_681
    assert row["path"] == str(ios)
    assert row["state"] == "missing"
    assert SMALL in row["hint"]
    assert row["bootstrap"].endswith(f"--whisper-model {SMALL}")


def test_readiness_turns_true_once_the_variant_file_is_on_disk(ios: Path) -> None:
    (ios / SMALL_FILE).write_bytes(b"x")
    status = boot.component_status()
    assert _whisper_row()["state"] == "installed"
    assert [m["cached"] for m in status["whisper_models"]] == [True, False]


def test_a_host_that_is_not_whisper_cpp_keeps_the_faster_whisper_catalog(
    host: Callable[..., None],
) -> None:
    host(MACOS)
    ids = [m["id"] for m in boot.component_status()["whisper_models"]]
    assert "large-v3-turbo" in ids
    assert SMALL not in ids
    assert resolve_whisper_model() == DEFAULT_WHISPER_MODEL
    with pytest.raises(CodedValueError):
        validate_whisper_model(SMALL)
    assert "whisper-cpp" not in str(model_spec("whisper").location())


def test_the_default_follows_the_installed_variant(ios: Path) -> None:
    assert resolve_whisper_model() == SMALL
    assert whisper_cpp.default_model_name() == SMALL_FILE
    (ios / BASE_FILE).write_bytes(b"b")
    assert resolve_whisper_model() == BASE
    assert whisper_cpp.default_model_name() == BASE_FILE
    assert whisper_cpp.resolve_model_path() == ios / BASE_FILE
    (ios / SMALL_FILE).write_bytes(b"s")
    assert resolve_whisper_model() == SMALL
    assert whisper_cpp.resolve_model_path() == ios / SMALL_FILE


def test_a_chosen_variant_beats_the_installed_default(ios: Path) -> None:
    (ios / SMALL_FILE).write_bytes(b"s")
    (ios / BASE_FILE).write_bytes(b"b")
    persist_whisper_model(BASE)
    assert resolve_whisper_model() == BASE
    assert whisper_cpp.resolve_model_path() == ios / BASE_FILE


def test_a_run_needs_the_file_the_run_will_resolve(ios: Path) -> None:
    with pytest.raises(ModelMissing):
        ensure_whisper_cached_for_run()
    (ios / BASE_FILE).write_bytes(b"b")
    ensure_whisper_cached_for_run()
    assert whisper_cpp.resolve_model_path() == ios / BASE_FILE


def test_install_downloads_only_the_chosen_file(ios: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[list[str], Path, str | None]] = []

    def fake_download(urls, dest: Path, *, expected_sha256=None, on_progress=None, **_) -> str:
        calls.append((list(urls), dest, expected_sha256))
        dest.write_bytes(b"1234")
        return "upstream"

    monkeypatch.setattr(wcm, "download_first_ok", fake_download)
    real = wcm.asset_entry
    monkeypatch.setattr(wcm, "asset_entry", lambda asset_id: {**real(asset_id), "size_bytes": 4})

    result = boot.install_model(model_spec("whisper"), whisper_model=BASE)

    [(urls, dest, sha)] = calls
    assert urls == [asset_sources.asset_entry("whisper-cpp-base-en-q5_1")["url"]]
    assert dest == ios / BASE_FILE
    assert sha == asset_sources.asset_entry("whisper-cpp-base-en-q5_1")["sha256"]
    assert sorted(p.name for p in ios.iterdir()) == [BASE_FILE]
    assert result["path"] == str(ios)
    assert resolve_whisper_model() == BASE


def test_install_leaves_a_present_file_alone_unless_forced(
    ios: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (ios / SMALL_FILE).write_bytes(b"keep")

    def refuse(*args, **kwargs):
        raise AssertionError("downloaded a file that is already there")

    monkeypatch.setattr(wcm, "download_first_ok", refuse)
    assert wcm.bootstrap_variant(SMALL) == ios / SMALL_FILE


def test_remove_deletes_only_the_chosen_variant_file(ios: Path) -> None:
    (ios / SMALL_FILE).write_bytes(b"s" * 10)
    (ios / BASE_FILE).write_bytes(b"b" * 7)
    (ios / "ggml-other.bin").write_bytes(b"o")

    assert remove_model("whisper", BASE) == 7

    assert sorted(p.name for p in ios.iterdir()) == ["ggml-other.bin", SMALL_FILE]


def test_remove_cannot_name_a_path_outside_the_cache(ios: Path, tmp_path: Path) -> None:
    outside = tmp_path / "victim.bin"
    outside.write_bytes(b"x")
    with pytest.raises(CodedValueError):
        remove_model("whisper", f"../../../../{outside}")
    assert outside.read_bytes() == b"x"


def test_remove_refuses_a_cache_directory_linked_elsewhere(ios: Path, tmp_path: Path) -> None:
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / SMALL_FILE).write_bytes(b"x")
    ios.rmdir()
    ios.symlink_to(elsewhere, target_is_directory=True)
    with pytest.raises(ModelNotRemovable):
        remove_model("whisper", SMALL)
    assert (elsewhere / SMALL_FILE).exists()


def test_a_removed_file_reads_as_missing_again(ios: Path) -> None:
    (ios / SMALL_FILE).write_bytes(b"s")
    boot.uninstall_model("whisper", SMALL)
    assert _whisper_row()["state"] == "missing"


def test_the_hugging_face_cdn_redirect_is_followed() -> None:
    target = "https://us.aws.cdn.hf.co/xet-bridge-us/abc/def?X-Amz-Signature=1"
    handler = asset_sources._HttpsRedirectHandler()
    request = urllib.request.Request(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/x.bin"
    )
    followed = handler.redirect_request(request, None, 302, "Found", {}, target)
    assert followed is not None
    assert followed.full_url == target
    assert not asset_sources._is_blocked_host("us.aws.cdn.hf.co")


@pytest.mark.parametrize(
    "target", ["http://us.aws.cdn.hf.co/x", "https://127.0.0.1/x", "https://localhost/x"]
)
def test_a_redirect_to_a_plain_or_local_host_is_refused(target: str) -> None:
    handler = asset_sources._HttpsRedirectHandler()
    request = urllib.request.Request("https://huggingface.co/x.bin")
    with pytest.raises(asset_sources.AssetSourceError):
        handler.redirect_request(request, None, 302, "Found", {}, target)

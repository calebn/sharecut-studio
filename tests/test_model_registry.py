from __future__ import annotations

import hashlib
from dataclasses import replace
from pathlib import Path

import pytest

from podcast_mcp.engines.models import registry
from podcast_mcp.engines.models.registry import MODELS, model_spec, models_for
from podcast_mcp.services.pipeline import bootstrap as boot
from podcast_mcp.util import model_assets, model_manifest
from podcast_mcp.util.asset_sources import asset_entry


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("PODCAST_WHISPER_MODEL", raising=False)


def test_registry_rows_and_tiers() -> None:
    assert [(spec.id, spec.setup) for spec in MODELS] == [
        ("whisper", "required"),
        ("rnnoise", "recommended"),
        ("word-aligner", "recommended"),
        ("speaker-ecapa", "recommended"),
    ]
    assert [spec.id for spec in models_for("required", "recommended")] == [
        "whisper",
        "rnnoise",
        "word-aligner",
        "speaker-ecapa",
    ]


def test_bootstrap_views_derive_from_the_registry() -> None:
    assert boot.DEFAULT_FIRST_RUN_COMPONENTS == ("whisper",)
    assert boot.ALL_GUI_COMPONENTS == ("whisper", "rnnoise", "word-aligner", "speaker-ecapa")
    assert not hasattr(boot, "OPTIONAL_COMPONENTS")
    assert not hasattr(boot, "OPT_IN_COMPONENTS")


def test_size_follows_the_whisper_variant() -> None:
    whisper = model_spec("whisper")
    assert whisper.size_label("tiny.en") == "~75 MB"
    assert whisper.size_bytes("tiny.en") == 75_000_000
    assert whisper.size_label("large-v3-turbo") == "~1.6 GB"
    assert whisper.size_bytes("large-v3-turbo") == 1_600_000_000
    assert whisper.size_label("large-v3") == "~3 GB"
    assert whisper.size_bytes("large-v3") == 3_000_000_000


def test_whisper_sizes_cover_the_catalog_and_the_unlisted_fall_back() -> None:
    from podcast_mcp.engines.models.whisper import WHISPER_MODEL_IDS

    whisper = model_spec("whisper")
    assert all(whisper.size_bytes(model) is not None for model in WHISPER_MODEL_IDS)
    assert whisper.size_label("distil-large-v3") == whisper.size
    assert whisper.size_bytes("distil-large-v3") is None
    assert whisper.size_label(None) == whisper.size


def test_size_is_pinned_approximate_or_unknown() -> None:
    assert model_spec("rnnoise").size_bytes(None) == 297646
    assert model_spec("rnnoise").size_label(None) == "~0.3 MB"
    assert model_spec("word-aligner").size_bytes(None) == 360_000_000
    assert model_spec("word-aligner").size_label(None) == "~360 MB"
    assert model_spec("speaker-ecapa").size_bytes(None) == 83_424_609


def test_speaker_ecapa_size_follows_the_manifest() -> None:
    pinned = asset_entry("speaker-ecapa")["size_bytes"]
    assert type(pinned) is int
    assert pinned == 83_424_609
    spec = model_spec("speaker-ecapa")
    assert spec.size_bytes(None) == pinned
    # Python keeps the tilde ("~0.3 MB", "~360 MB"); the GUI's formatBytes drops it.
    assert spec.size_label(None) == f"~{round(pinned / 1_000_000)} MB" == "~83 MB"


def test_the_speaker_status_row_carries_the_manifest_size(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(boot, "resolve_ffmpeg_pair", lambda **_kwargs: None)
    row = next(r for r in boot.component_status()["models"] if r["id"] == "speaker-ecapa")
    assert row["size_bytes"] == 83_424_609
    assert row["size"] == "~83 MB"


@pytest.mark.parametrize("model_id", ["word-aligner", "speaker-ecapa"])
def test_the_size_text_and_the_byte_count_agree(model_id: str) -> None:
    spec = model_spec(model_id)
    megabytes = int(spec.size_label(None).strip("~ MB"))
    assert round((spec.size_bytes(None) or 0) / 1_000_000) == megabytes


def test_the_default_bundle_totals_about_two_gigabytes() -> None:
    total = sum(spec.size_bytes(None) or 0 for spec in models_for("recommended")) + (
        model_spec("whisper").size_bytes("large-v3-turbo") or 0
    )
    assert 1_900_000_000 <= total <= 2_100_000_000


def test_fix_command_names_the_component() -> None:
    assert model_spec("speaker-ecapa").fix_command == "podcast bootstrap --component speaker-ecapa"


def test_component_status_lists_every_registry_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(boot, "resolve_ffmpeg_pair", lambda **_kwargs: None)
    status = boot.component_status()
    assert [row["id"] for row in status["models"]] == [spec.id for spec in MODELS]
    assert [(row["id"], row["tier"], row["purpose"]) for row in status["models"]] == [
        (spec.id, spec.setup, spec.purpose) for spec in MODELS
    ]
    speaker = status["models"][-1]
    assert speaker["state"] == "missing"
    assert speaker["model"] == "speaker-ecapa"
    assert speaker["size"] == "~83 MB"
    assert speaker["size_bytes"] == 83_424_609
    assert speaker["bootstrap"] == "podcast bootstrap --component speaker-ecapa"
    assert status["models"][0]["tier"] == "required"


def test_missing_speaker_override_status_keeps_bootstrap_command(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PODCAST_MCP_SPEAKER_ECAPA_MODEL", str(tmp_path / "missing.onnx"))

    status = boot.model_status("speaker-ecapa")

    assert status["state"] == "missing"
    assert "PODCAST_MCP_SPEAKER_ECAPA_MODEL" in status["hint"]
    assert "missing" in status["hint"]
    assert "working ONNX file" in status["hint"]
    assert "unset" in status["hint"]
    assert status["bootstrap"] == "podcast bootstrap --component speaker-ecapa"


def test_rnnoise_status_follows_the_model_file(tmp_path: Path, monkeypatch) -> None:
    model = tmp_path / "model.rnnn"
    monkeypatch.setenv("PODCAST_MCP_RNNOISE_MODEL", str(model))
    missing = boot.model_status("rnnoise")
    assert missing["state"] == "missing"
    assert missing["bootstrap"] == "podcast bootstrap --component rnnoise"
    assert missing["hint"] == (
        f"RNNoise model not found at {model}. Run `podcast bootstrap --component rnnoise`."
    )
    model.write_bytes(b"x")
    ready = boot.model_status("rnnoise")
    assert ready["state"] == "installed"
    assert "hint" not in ready


def _pin_rnnoise(monkeypatch: pytest.MonkeyPatch, payload: bytes) -> Path:
    entry = {**asset_entry("rnnoise"), "sha256": hashlib.sha256(payload).hexdigest()}
    monkeypatch.setattr(model_assets, "asset_entry", lambda name: entry)
    monkeypatch.delenv("PODCAST_MCP_RNNOISE_MODEL", raising=False)
    path = model_assets.rnnoise_model_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def test_rnnoise_default_wrong_bytes_is_update_needed(monkeypatch: pytest.MonkeyPatch) -> None:
    path = _pin_rnnoise(monkeypatch, b"pinned")
    path.write_bytes(b"truncated")
    row = boot.model_status("rnnoise")
    assert row["state"] == "update_needed"
    assert row["bootstrap"] == "podcast bootstrap --component rnnoise --upgrade"
    assert "does not match its pinned download" in row["hint"]


def test_rnnoise_default_pinned_bytes_is_installed(monkeypatch: pytest.MonkeyPatch) -> None:
    path = _pin_rnnoise(monkeypatch, b"pinned")
    path.write_bytes(b"pinned")
    row = boot.model_status("rnnoise")
    assert row["state"] == "installed"
    assert "hint" not in row


@pytest.mark.parametrize("memoize", [True, False])
def test_rnnoise_status_passes_the_callers_memoize(
    monkeypatch: pytest.MonkeyPatch, memoize: bool
) -> None:
    path = _pin_rnnoise(monkeypatch, b"pinned")
    path.write_bytes(b"pinned")
    seen: list[bool] = []
    real = registry.rnnoise_pin_mismatch

    def spy(model: Path, *, memoize: bool) -> str | None:
        seen.append(memoize)
        return real(model, memoize=memoize)

    monkeypatch.setattr(registry, "rnnoise_pin_mismatch", spy)
    boot.model_status("rnnoise", memoize=memoize)
    assert seen == [memoize]


def test_rnnoise_override_is_never_hashed_or_replaced(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _pin_rnnoise(monkeypatch, b"pinned")
    model = tmp_path / "mine.rnnn"
    model.write_bytes(b"arbitrary user model")
    monkeypatch.setenv("PODCAST_MCP_RNNOISE_MODEL", str(model))

    def boom(path: Path) -> str:
        raise AssertionError(f"hashed {path}")

    monkeypatch.setattr(model_manifest, "sha256_file", boom)
    row = boot.model_status("rnnoise")
    assert row["state"] == "installed"
    assert model.read_bytes() == b"arbitrary user model"


def test_rnnoise_manifest_without_sha256_is_not_checked(monkeypatch: pytest.MonkeyPatch) -> None:
    entry = {k: v for k, v in asset_entry("rnnoise").items() if k != "sha256"}
    monkeypatch.setattr(model_assets, "asset_entry", lambda name: entry)
    monkeypatch.delenv("PODCAST_MCP_RNNOISE_MODEL", raising=False)
    path = model_assets.rnnoise_model_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"anything")
    assert boot.model_status("rnnoise")["state"] == "installed"


def test_status_models_come_only_from_the_registry() -> None:
    status = boot.component_status()
    assert [row["id"] for row in status["models"]] == [spec.id for spec in registry.MODELS]
    assert set(status["tools"]) == {"ffmpeg"}


def test_run_bootstrap_installs_every_named_model(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str | None, bool]] = []

    def stub(spec):
        def install(variant, force, on_progress):
            calls.append((spec.id, variant, force))
            return {"ok": True}

        return replace(spec, install=install)

    monkeypatch.setattr(boot, "model_spec", lambda model_id: stub(model_spec(model_id)))
    out = boot.run_bootstrap(
        ["whisper", "word-aligner", "speaker-ecapa"], whisper_model="small.en", force=True
    )
    assert out["ok"] is True
    assert calls == [
        ("whisper", "small.en", True),
        ("word-aligner", None, True),
        ("speaker-ecapa", None, True),
    ]


def test_a_bad_asset_manifest_degrades_the_rnnoise_size(monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(name: str) -> dict:
        raise RuntimeError("bad manifest")

    monkeypatch.setattr(registry, "asset_entry", broken)
    spec = model_spec("rnnoise")
    assert spec.size_bytes(None) is None
    assert spec.size_label(None) == spec.size
    row = boot.model_status("rnnoise")
    assert row["size_bytes"] is None

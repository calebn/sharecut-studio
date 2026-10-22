from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from podcast_mcp.engines.models import registry
from podcast_mcp.engines.models.registry import MODELS, model_spec, models_for
from podcast_mcp.services.pipeline import bootstrap as boot


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("PODCAST_WHISPER_MODEL", raising=False)


def test_registry_rows_and_tiers() -> None:
    assert [(spec.id, spec.setup) for spec in MODELS] == [
        ("whisper", "required"),
        ("rnnoise", "recommended"),
        ("word-aligner", "offered"),
        ("speaker-ecapa", "offered"),
    ]
    assert [spec.id for spec in models_for("required", "recommended")] == ["whisper", "rnnoise"]


def test_bootstrap_views_derive_from_the_registry() -> None:
    assert boot.DEFAULT_FIRST_RUN_COMPONENTS == ("whisper",)
    assert boot.OPTIONAL_COMPONENTS == ("rnnoise",)
    assert boot.OPT_IN_COMPONENTS == ("word-aligner", "speaker-ecapa")
    assert boot.ALL_GUI_COMPONENTS == ("whisper", "rnnoise", "word-aligner", "speaker-ecapa")


def test_fix_command_names_the_component() -> None:
    assert model_spec("speaker-ecapa").fix_command == "podcast bootstrap --component speaker-ecapa"


def test_component_status_lists_every_registry_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(boot, "resolve_ffmpeg_pair", lambda **_kwargs: None)
    status = boot.component_status()
    assert [name for name in status["components"] if name in boot.ALL_GUI_COMPONENTS] == [
        spec.id for spec in MODELS
    ]
    assert status["default_components"] == ["whisper"]
    assert status["optional_components"] == ["rnnoise"]
    assert status["opt_in_components"] == ["word-aligner", "speaker-ecapa"]
    speaker = status["components"]["speaker-ecapa"]
    assert speaker["ok"] is False
    assert speaker["opt_in"] is True
    assert speaker["required_for_first_run"] is False
    assert speaker["model"] == "speaker-ecapa"
    assert speaker["bootstrap"] == "podcast bootstrap --component speaker-ecapa"
    assert status["components"]["whisper"]["required_for_first_run"] is True


def test_rnnoise_status_follows_the_model_file(tmp_path: Path, monkeypatch) -> None:
    model = tmp_path / "model.rnnn"
    monkeypatch.setenv("PODCAST_MCP_RNNOISE_MODEL", str(model))
    missing = boot.model_status("rnnoise")
    assert missing["ok"] is False
    assert missing["bootstrap"] == "podcast bootstrap --component rnnoise"
    assert missing["hint"] == (
        f"RNNoise model not found at {model}. Run `podcast bootstrap --component rnnoise`."
    )
    model.write_bytes(b"x")
    ready = boot.model_status("rnnoise")
    assert ready["ok"] is True
    assert "hint" not in ready


def test_status_components_come_only_from_the_registry() -> None:
    components = boot.component_status()["components"]
    assert set(components) == {"ffmpeg", *(spec.id for spec in registry.MODELS)}


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

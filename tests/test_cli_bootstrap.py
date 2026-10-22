from __future__ import annotations

import hashlib
import io
import urllib.error
from dataclasses import replace
from pathlib import Path
from unittest.mock import ANY, patch

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.engines.models import registry

runner = CliRunner()
R = "podcast_mcp.engines.models.registry"


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))


def test_bootstrap_unknown_component_errors() -> None:
    result = runner.invoke(app, ["bootstrap", "--component", "bogus"])
    assert result.exit_code == 2
    assert "Unknown component" in result.stderr


@pytest.mark.parametrize("retired", ["nisqa", "silero-vad"])
def test_bootstrap_rejects_retired_components(retired: str) -> None:
    result = runner.invoke(app, ["bootstrap", "--component", retired])
    assert result.exit_code == 2
    assert "Unknown component" in result.stderr


def test_bootstrap_whisper_success() -> None:
    with patch(
        "podcast_mcp.engines.models.registry.bootstrap_whisper_model",
        return_value={
            "ok": True,
            "model": "large-v3-turbo",
            "cache": "/tmp/cache",
            "persist_error": None,
        },
    ) as mocked:
        result = runner.invoke(app, ["bootstrap", "--component", "whisper"])
    assert result.exit_code == 0
    assert "[ok] whisper: /tmp/cache" in result.stdout
    mocked.assert_called_once_with("large-v3-turbo", force=False, on_progress=ANY)


def test_bootstrap_whisper_model_flag() -> None:
    with patch(
        "podcast_mcp.engines.models.registry.bootstrap_whisper_model",
        return_value={
            "ok": True,
            "model": "small.en",
            "cache": "/tmp/cache",
            "persist_error": None,
        },
    ) as mocked:
        result = runner.invoke(
            app,
            ["bootstrap", "--component", "whisper", "--whisper-model", "small.en"],
        )
    assert result.exit_code == 0
    assert "[ok] whisper: /tmp/cache" in result.stdout
    mocked.assert_called_once_with("small.en", force=False, on_progress=ANY)


def test_bootstrap_whisper_model_unknown() -> None:
    result = runner.invoke(
        app,
        ["bootstrap", "--component", "whisper", "--whisper-model", "nope"],
    )
    assert result.exit_code == 2
    assert "Unknown Whisper model" in result.stderr


def test_bootstrap_whisper_import_failure() -> None:
    with patch(
        "podcast_mcp.engines.models.registry.bootstrap_whisper_model",
        side_effect=ImportError("faster-whisper missing"),
    ):
        result = runner.invoke(app, ["bootstrap", "--component", "whisper"])
    assert result.exit_code == 1


def test_bootstrap_whisper_download_failure() -> None:
    with patch(
        "podcast_mcp.engines.models.registry.bootstrap_whisper_model",
        side_effect=urllib.error.URLError("network down"),
    ):
        result = runner.invoke(app, ["bootstrap", "--component", "whisper"])
    assert result.exit_code == 1
    assert "[fail] whisper: Couldn't reach the download server." in result.stderr
    assert "network down" not in result.stderr


def test_bootstrap_unexpected_error_is_reported_generically(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with patch(
        "podcast_mcp.engines.models.registry.bootstrap_whisper_model",
        side_effect=RuntimeError("/srv/cache exploded"),
    ):
        result = runner.invoke(app, ["bootstrap", "--component", "whisper"])
    assert result.exit_code == 1
    assert "[fail] whisper: Whisper speech model could not be installed." in result.stderr
    assert "/srv" not in result.stderr
    assert "/srv/cache exploded" in caplog.text


def test_bootstrap_whisper_persist_failure_still_ok() -> None:
    with patch(
        "podcast_mcp.engines.models.registry.bootstrap_whisper_model",
        return_value={
            "ok": True,
            "model": "large-v3-turbo",
            "cache": "/tmp/cache",
            "persist_error": "disk full",
        },
    ):
        result = runner.invoke(app, ["bootstrap", "--component", "whisper"])
    assert result.exit_code == 0
    assert "could not persist" in result.stderr


def test_bootstrap_whisper_upgrade_forces_download() -> None:
    with patch(
        "podcast_mcp.engines.models.registry.bootstrap_whisper_model",
        return_value={
            "ok": True,
            "model": "large-v3-turbo",
            "cache": "/tmp/cache",
            "persist_error": None,
        },
    ) as mocked:
        result = runner.invoke(app, ["bootstrap", "--component", "whisper", "--upgrade"])
    assert result.exit_code == 0
    mocked.assert_called_once_with("large-v3-turbo", force=True, on_progress=ANY)


def _snapshot_download_stub(snap: Path):
    def stub(*_args, dry_run: bool = False, **_kwargs):
        return [] if dry_run else str(snap)

    return stub


def test_bootstrap_whisper_tampered_snapshot_fails_with_upgrade_hint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from model_pin_helpers import plant_pinned_whisper

    cache = tmp_path / "cache" / "whisper"
    monkeypatch.setattr("podcast_mcp.config.defaults.whisper_cache_dir", lambda: cache)
    snap = plant_pinned_whisper(cache, "small.en", monkeypatch)
    (snap / "vocabulary.txt").write_bytes(b"tampered")
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", _snapshot_download_stub(snap), raising=False
    )
    result = runner.invoke(
        app,
        ["bootstrap", "--component", "whisper", "--whisper-model", "small.en"],
    )
    assert result.exit_code == 1
    assert (
        "[fail] whisper: Whisper speech model downloaded but isn't the expected version. "
        "Run: podcast bootstrap --component whisper --whisper-model small.en --upgrade"
    ) in result.stderr
    assert "vocabulary.txt" not in result.stderr


def test_bootstrap_rnnoise_success(tmp_path: Path) -> None:
    model = tmp_path / "model.rnnn"
    with patch("podcast_mcp.engines.models.registry.bootstrap_rnnoise_model", return_value=model):
        result = runner.invoke(app, ["bootstrap", "--component", "rnnoise"])
    assert result.exit_code == 0
    assert str(model) in result.stdout


def test_bootstrap_rnnoise_failure() -> None:
    with patch(
        "podcast_mcp.engines.models.registry.bootstrap_rnnoise_model",
        side_effect=RuntimeError("network down"),
    ):
        result = runner.invoke(app, ["bootstrap", "--component", "rnnoise"])
    assert result.exit_code == 1


def _stub_installers(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    from dataclasses import replace

    installed: list[str] = []

    def stub(spec):
        def install(variant, force, on_progress):
            installed.append(spec.id)
            return {"ok": True, "path": f"/stub/{spec.id}"}

        return replace(spec, install=install)

    monkeypatch.setattr(registry, "MODELS", tuple(stub(s) for s in registry.MODELS))
    monkeypatch.setattr("podcast_mcp.cli.setup_cmd.MODELS", registry.MODELS)
    return installed


def test_bootstrap_bare_default_installs_the_recommended_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    installed = _stub_installers(monkeypatch)
    result = runner.invoke(app, ["bootstrap"])
    assert result.exit_code == 0
    assert installed == ["whisper", "rnnoise"]
    assert "Bootstrap complete." in result.stdout


def test_bootstrap_all_installs_every_registry_model(monkeypatch: pytest.MonkeyPatch) -> None:
    installed = _stub_installers(monkeypatch)
    result = runner.invoke(app, ["bootstrap", "--component", "all"])
    assert result.exit_code == 0
    assert installed == ["whisper", "rnnoise", "word-aligner", "speaker-ecapa"]
    assert "[ok] speaker-ecapa: /stub/speaker-ecapa" in result.stdout
    assert "[ok] word-aligner: /stub/word-aligner" in result.stdout


def _network_installers_patched():
    return (
        patch(
            f"{R}.bootstrap_whisper_model",
            return_value={"ok": True, "model": "large-v3-turbo", "cache": "/c"},
        ),
        patch(f"{R}.bootstrap_rnnoise_model", return_value=Path("/r")),
        patch(f"{R}.word_aligner_problem", return_value=object()),
        patch(f"{R}.bootstrap_word_aligner", return_value={"ok": True, "path": "/w"}),
    )


class _ModelOpener:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload
        self.requested: list[str] = []

    def open(self, req, timeout: float = 120.0):
        del timeout
        self.requested.append(req.full_url)
        return io.BytesIO(self.payload)


def _stock_speaker_download(monkeypatch: pytest.MonkeyPatch) -> _ModelOpener:
    from podcast_mcp.engines.models import speaker_ecapa
    from podcast_mcp.util import asset_sources

    monkeypatch.delenv("PODCAST_BOOTSTRAP_CDN_BASE", raising=False)
    monkeypatch.delenv("PODCAST_MCP_SPEAKER_ECAPA_MODEL", raising=False)
    payload = b"model-bytes"
    sha = hashlib.sha256(payload).hexdigest()
    real = speaker_ecapa.asset_entry
    monkeypatch.setattr(
        speaker_ecapa, "asset_entry", lambda asset_id: {**real(asset_id), "sha256": sha}
    )
    opener = _ModelOpener(payload)
    monkeypatch.setattr(asset_sources, "_https_opener", lambda: opener)
    return opener


def test_bootstrap_all_installs_speaker_on_a_stock_build(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    opener = _stock_speaker_download(monkeypatch)
    whisper, rnnoise, problem, aligner = _network_installers_patched()
    with whisper, rnnoise, problem, aligner:
        result = runner.invoke(app, ["bootstrap", "--component", "all"])
    assert result.exit_code == 0
    assert opener.requested == [
        "https://cdn.sharecut.studio/models/speaker-ecapa/ecapa-voxceleb-embedding.onnx"
    ]
    assert "[ok] speaker-ecapa:" in result.stdout
    assert "[skip] speaker-ecapa" not in result.stdout
    assert "Bootstrap complete." in result.stdout


def test_bootstrap_speaker_named_explicitly_installs_on_a_stock_build(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    opener = _stock_speaker_download(monkeypatch)
    result = runner.invoke(app, ["bootstrap", "--component", "speaker-ecapa"])
    assert result.exit_code == 0
    assert len(opener.requested) == 1
    assert "[ok] speaker-ecapa:" in result.stdout


def test_bootstrap_failure_of_one_model_does_not_skip_the_rest(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    installed = _stub_installers(monkeypatch)
    failing = replace(registry.MODELS[0], install=lambda variant, force, on_progress: 1 / 0)
    monkeypatch.setattr("podcast_mcp.cli.setup_cmd.MODELS", (failing, *registry.MODELS[1:]))
    result = runner.invoke(app, ["bootstrap", "--component", "all"])
    assert result.exit_code == 1
    assert "[fail] whisper: Whisper speech model could not be installed." in result.stderr
    assert installed == ["rnnoise", "word-aligner", "speaker-ecapa"]


def test_bootstrap_word_aligner_success() -> None:
    with (
        patch("podcast_mcp.engines.models.registry.word_aligner_problem", return_value=object()),
        patch(
            "podcast_mcp.engines.models.registry.bootstrap_word_aligner",
            return_value={"ok": True, "model": "onnx-base", "path": "/x"},
        ),
    ):
        result = runner.invoke(app, ["bootstrap", "--component", "word-aligner"])
    assert result.exit_code == 0
    assert "[ok] word-aligner: /x" in result.stdout


def test_bootstrap_word_aligner_skips_when_cached() -> None:
    with (
        patch("podcast_mcp.engines.models.registry.word_aligner_problem", return_value=None),
        patch("podcast_mcp.engines.models.registry.bootstrap_word_aligner") as bootstrap,
    ):
        result = runner.invoke(app, ["bootstrap", "--component", "word-aligner"])
    assert result.exit_code == 0
    assert "[skip] word-aligner: cached" in result.stdout
    bootstrap.assert_not_called()


def test_bootstrap_word_aligner_upgrade_forces_download() -> None:
    with (
        patch("podcast_mcp.engines.models.registry.word_aligner_problem", return_value=None),
        patch(
            "podcast_mcp.engines.models.registry.bootstrap_word_aligner",
            return_value={"ok": True, "model": "onnx-base", "path": "/x"},
        ) as bootstrap,
    ):
        result = runner.invoke(app, ["bootstrap", "--component", "word-aligner", "--upgrade"])
    assert result.exit_code == 0
    bootstrap.assert_called_once_with("onnx-base", force=True, on_progress=ANY)


def test_bootstrap_word_aligner_failure_exits_1() -> None:
    with (
        patch("podcast_mcp.engines.models.registry.word_aligner_problem", return_value=object()),
        patch(
            "podcast_mcp.engines.models.registry.bootstrap_word_aligner",
            side_effect=TimeoutError("hub down"),
        ),
    ):
        result = runner.invoke(app, ["bootstrap", "--component", "word-aligner"])
    assert result.exit_code == 1
    assert "[fail] word-aligner: Couldn't reach the download server." in result.stderr
    assert "hub down" not in result.stderr


def test_bootstrap_word_aligner_tampered_snapshot_fails_with_upgrade_hint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from model_pin_helpers import pin_word_aligner_to_fake_snapshot

    snap = pin_word_aligner_to_fake_snapshot(tmp_path / "snap", monkeypatch)
    (snap / "vocab.json").write_bytes(b"tampered")
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", _snapshot_download_stub(snap), raising=False
    )
    result = runner.invoke(app, ["bootstrap", "--component", "word-aligner"])
    assert result.exit_code == 1
    assert (
        "[fail] word-aligner: wav2vec2 base (ONNX, English) downloaded but isn't the expected "
        "version. Run: podcast bootstrap --component word-aligner --upgrade"
    ) in result.stderr
    assert "[skip]" not in result.stdout


def test_doctor_reports_rnnoise_and_silero_status() -> None:
    result = runner.invoke(app, ["doctor"])
    assert "rnnoise model" in result.stdout
    assert "silero-vad" in result.stdout

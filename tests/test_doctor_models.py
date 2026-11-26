"""`podcast doctor` reports one line per model registry row (#1998 slice 4).

Whisper keeps its own variant-aware line; every other row (rnnoise, word-aligner,
speaker-ecapa) is built from ``model_record``. No test downloads or loads a model: the
record is faked, or the real record reads an empty scratch cache. The ffmpeg check is stubbed,
so no test depends on the host's ffmpeg.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.setup_cmd import setup_app
from podcast_mcp.engines.models import registry
from podcast_mcp.services.support import doctor as doctor_module
from podcast_mcp.services.support.doctor import DoctorCheck, run_doctor_checks

runner = CliRunner()

ROWS = [spec for spec in registry.MODELS if spec.id != "whisper"]
ROW_IDS = [spec.id for spec in ROWS]


@pytest.fixture(autouse=True)
def _scratch_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    for name in (
        "PODCAST_MCP_RNNOISE_MODEL",
        "PODCAST_MCP_SPEAKER_ECAPA_MODEL",
        "PODCAST_MCP_WORD_ALIGNER_DIR",
    ):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture(autouse=True)
def _has_download_source(monkeypatch):
    """A source build embeds no CDN origin; make the speaker row look like an official build."""
    monkeypatch.setattr(
        "podcast_mcp.services.support.doctor.ordered_http_urls", lambda *a, **k: ["https://x/y"]
    )


@pytest.fixture(autouse=True)
def _stub_ffmpeg():
    """Doctor builds ``FFmpegEngine()`` first; keep these tests independent of the host ffmpeg."""
    engine = MagicMock()
    engine.check_available.return_value = (True, "ffmpeg 9.0.2")
    engine.source = "test"
    with patch("podcast_mcp.services.support.doctor.FFmpegEngine", return_value=engine):
        yield


def _fake_records(monkeypatch, states: dict[str, dict]) -> list[str]:
    """Make ``model_record`` answer from ``states`` (by id); returns the ids it was asked for."""
    asked: list[str] = []

    def fake(model_id, variant=None, *, memoize=True, check_load=True):
        asked.append(model_id)
        spec = registry.model_spec(model_id)
        base = {"id": model_id, "label": spec.label}
        return {**base, **states[model_id]}

    monkeypatch.setattr(registry, "model_record", fake)
    monkeypatch.setattr(doctor_module, "model_record", fake, raising=False)
    return asked


def _lines(label: str) -> list[DoctorCheck]:
    return [c for c in run_doctor_checks().checks if c.message.startswith(f"{label}:")]


def _all(state: dict) -> dict[str, dict]:
    return {spec_id: dict(state) for spec_id in ROW_IDS}


@pytest.mark.parametrize("spec", ROWS, ids=ROW_IDS)
def test_installed_row_is_one_ok_line(spec, monkeypatch):
    asked = _fake_records(monkeypatch, _all({"state": "installed"}))
    lines = _lines(spec.label)
    assert len(lines) == 1
    assert lines[0].status == "ok"
    assert lines[0].message == f"{spec.label}: installed"
    assert spec.id in asked


def test_installed_line_never_prints_a_path(monkeypatch, tmp_path):
    override = tmp_path / "secret-dir" / "x.onnx"
    monkeypatch.setenv("PODCAST_MCP_SPEAKER_ECAPA_MODEL", str(override))
    _fake_records(monkeypatch, _all({"state": "installed"}))
    messages = " ".join(c.message for c in run_doctor_checks().checks)
    assert "secret-dir" not in messages


@pytest.mark.parametrize("spec", ROWS, ids=ROW_IDS)
def test_missing_row_warns_with_the_bootstrap_command(spec, monkeypatch):
    _fake_records(
        monkeypatch,
        _all(
            {
                "state": "missing",
                "hint": "long Studio copy that doctor must not reuse",
                "bootstrap": spec.fix_command,
            }
        ),
    )
    lines = _lines(spec.label)
    assert len(lines) == 1
    assert lines[0].status == "warn"
    assert lines[0].err is True
    assert lines[0].message == (
        f"{spec.label}: not downloaded (run `{spec.fix_command}`; needed for {spec.purpose})"
    )
    assert "long Studio copy" not in lines[0].message  # plain missing: the short form


@pytest.mark.parametrize("spec", ROWS, ids=ROW_IDS)
def test_update_needed_row_fails_with_the_pin_text(spec, monkeypatch):
    hint = f"file does not match its pinned download. Run: {spec.fix_command} --upgrade"
    _fake_records(
        monkeypatch,
        _all(
            {"state": "update_needed", "hint": hint, "bootstrap": f"{spec.fix_command} --upgrade"}
        ),
    )
    lines = _lines(spec.label)
    assert len(lines) == 1
    assert lines[0].status == "fail"
    assert lines[0].err is True
    assert lines[0].message == f"{spec.label}: {hint}"
    report = run_doctor_checks()
    assert not report.passed
    assert report.error_count == len(ROWS)


@pytest.mark.parametrize("spec", ROWS, ids=ROW_IDS)
def test_unsupported_row_warns_with_the_hint_and_passes(spec, monkeypatch):
    hint = "cannot be loaded on this machine: boom. fix it"
    _fake_records(monkeypatch, _all({"state": "unsupported", "hint": hint}))
    lines = _lines(spec.label)
    assert len(lines) == 1
    assert lines[0].status == "warn"
    assert lines[0].err is True
    assert lines[0].message == f"{spec.label}: {hint}"
    assert run_doctor_checks().passed


def test_whisper_is_not_a_registry_row_line_and_is_never_asked_for(monkeypatch):
    asked = _fake_records(monkeypatch, _all({"state": "installed"}))
    report = run_doctor_checks()
    whisper = registry.model_spec("whisper")
    assert "whisper" not in asked
    assert sorted(asked) == sorted(ROW_IDS)
    assert not any(c.message.startswith(f"{whisper.label}:") for c in report.checks)
    assert any(c.message.startswith("whisper model ") for c in report.checks)


def test_each_row_has_exactly_one_line_in_registry_order(monkeypatch):
    _fake_records(monkeypatch, _all({"state": "installed"}))
    messages = [c.message for c in run_doctor_checks().checks]
    positions = []
    for spec in ROWS:
        hits = [i for i, m in enumerate(messages) if m.startswith(f"{spec.label}:")]
        assert len(hits) == 1, spec.id
        positions.append(hits[0])
    assert positions == sorted(positions)


def test_fresh_machine_reports_the_aligner_and_speaker_model_missing():
    report = run_doctor_checks()
    for spec_id in ("word-aligner", "speaker-ecapa"):
        spec = registry.model_spec(spec_id)
        lines = _lines(spec.label)
        assert len(lines) == 1, spec_id
        assert lines[0].status == "warn"
        assert f"run `{spec.fix_command}`" in lines[0].message
    assert report.passed


def test_cli_doctor_prints_model_lines_and_exits_one_only_on_update_needed(monkeypatch):
    spec = registry.model_spec("speaker-ecapa")
    states = _all({"state": "missing", "hint": "h", "bootstrap": "b"})
    _fake_records(monkeypatch, states)
    ok = runner.invoke(setup_app, ["doctor"])
    assert ok.exit_code == 0
    assert (
        f"[warn] {spec.label}: not downloaded (run `{spec.fix_command}`; needed for {spec.purpose})"
    ) in ok.stderr
    states["speaker-ecapa"] = {"state": "update_needed", "hint": "pin text", "bootstrap": "b"}
    bad = runner.invoke(setup_app, ["doctor"])
    assert bad.exit_code == 1
    assert f"[fail] {spec.label}: pin text" in bad.stderr


@pytest.mark.parametrize("spec", ROWS, ids=ROW_IDS)
@pytest.mark.parametrize("state", ["update_needed", "unsupported"])
def test_a_hint_that_starts_with_the_label_is_not_repeated(spec, state, monkeypatch):
    _fake_records(
        monkeypatch,
        _all({"state": state, "hint": f"{spec.label} does not match its pin; run x"}),
    )
    assert [c.message for c in _lines(spec.label)] == [
        f"{spec.label}: does not match its pin; run x"
    ]
    _fake_records(
        monkeypatch, _all({"state": state, "hint": f"{spec.label}: does not match; run x"})
    )
    assert [c.message for c in _lines(spec.label)] == [f"{spec.label}: does not match; run x"]


# The tests below drive the REAL model_record (nothing faked) through doctor.


def test_real_plain_missing_rows_use_the_short_bootstrap_line():
    for spec in ROWS:
        (line,) = _lines(spec.label)
        assert line.status == "warn"
        assert line.message == (
            f"{spec.label}: not downloaded (run `{spec.fix_command}`; needed for {spec.purpose})"
        )


def test_real_speaker_override_missing_prints_the_registry_hint(tmp_path, monkeypatch):
    spec = registry.model_spec("speaker-ecapa")
    monkeypatch.setenv("PODCAST_MCP_SPEAKER_ECAPA_MODEL", str(tmp_path / "missing.onnx"))
    (line,) = _lines(spec.label)
    assert line.status == "warn"
    assert line.err is True
    assert "PODCAST_MCP_SPEAKER_ECAPA_MODEL is missing" in line.message
    assert "or unset it" in line.message
    assert "not downloaded (run" not in line.message
    assert line.message.count(spec.label) == 1


def test_real_rnnoise_override_missing_prints_the_registry_hint(tmp_path, monkeypatch):
    spec = registry.model_spec("rnnoise")
    missing = tmp_path / "missing.rnnn"
    monkeypatch.setenv("PODCAST_MCP_RNNOISE_MODEL", str(missing))
    (line,) = _lines(spec.label)
    assert line.status == "warn"
    assert line.message == (
        f"{spec.label}: RNNoise model not found at {missing}. "
        "Run `podcast bootstrap --component rnnoise`."
    )


def test_real_speaker_source_build_without_a_download_source_prints_the_reason(monkeypatch):
    spec = registry.model_spec("speaker-ecapa")
    monkeypatch.setattr(
        "podcast_mcp.engines.models.speaker_ecapa.ordered_http_urls", lambda *a, **k: []
    )
    monkeypatch.setattr("podcast_mcp.services.support.doctor.ordered_http_urls", lambda *a, **k: [])
    (line,) = _lines(spec.label)
    assert line.status == "warn"
    assert "this build has no download source" in line.message
    assert "docs/setup.md#speaker-model" in line.message
    assert "needed for" not in line.message


def test_real_installed_override_prints_installed_without_the_path(tmp_path, monkeypatch):
    spec = registry.model_spec("speaker-ecapa")
    override = tmp_path / "hidden-place" / "m.onnx"
    override.parent.mkdir()
    override.write_bytes(b"not a model")
    monkeypatch.setenv("PODCAST_MCP_SPEAKER_ECAPA_MODEL", str(override))
    (line,) = _lines(spec.label)
    assert line.status == "ok"
    assert line.message == f"{spec.label}: installed"


def test_doctor_does_not_create_model_directories(tmp_path):
    cache = tmp_path / "cache"
    run_doctor_checks()
    assert not (cache / "word-aligner").exists()

from __future__ import annotations

import os

import pytest
import yaml

from podcast_mcp.config import defaults as config
from podcast_mcp.config.defaults import (
    DEFAULT_MICRO_FADE_MS,
    cache_dir,
    join_micro_fade_ms,
    load_defaults,
    repo_root,
    whisper_cache_dir,
)


def test_repo_root_exists():
    root = repo_root()
    assert (root / "pyproject.toml").is_file()


def test_cache_dirs_are_writable(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    c = cache_dir()
    w = whisper_cache_dir()
    assert c.is_dir()
    assert w.is_dir()


def test_load_defaults_has_master_section():
    defaults = load_defaults()
    assert "master" in defaults
    assert "integrated_lufs" in defaults["master"]


def test_load_defaults_export_formats():
    defaults = load_defaults()
    export = defaults["export"]
    assert export.get("wav") is True
    formats = export.get("formats")
    assert formats and formats[0]["ext"] == "mp3"


def test_load_defaults_analysis_section():
    defaults = load_defaults()
    analysis = defaults["analysis"]
    assert "heuristics" in analysis
    assert analysis["heuristics"]["bleed_dominance_db"] == 6.0


def test_load_defaults_transcribe_model_is_turbo(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("PODCAST_WHISPER_MODEL", raising=False)
    defaults = load_defaults()
    assert defaults["transcribe"]["model"] == "large-v3-turbo"


def test_load_defaults_overlay_whisper_pref(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("PODCAST_WHISPER_MODEL", raising=False)
    from podcast_mcp.engines.models.whisper import persist_whisper_model

    persist_whisper_model("small.en")
    defaults = load_defaults()
    assert defaults["transcribe"]["model"] == "small.en"


def test_load_defaults_keeps_yaml_model_without_pref(tmp_path, monkeypatch):
    fixture = repo_root() / "tests" / "fixtures" / "e2e_pipeline.yaml"
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("PODCAST_WHISPER_MODEL", raising=False)
    monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(fixture))
    defaults = load_defaults()
    assert defaults["transcribe"]["model"] == "base"


def test_load_defaults_invalid_env_does_not_crash(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("PODCAST_WHISPER_MODEL", "nope")
    defaults = load_defaults()
    assert defaults["transcribe"]["model"] == "large-v3-turbo"


def test_load_defaults_missing_override_returns_empty(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(tmp_path / "missing.yaml"))
    assert load_defaults() == {}


@pytest.mark.parametrize("source", ["- master\n", "plain scalar\n"])
def test_load_defaults_rejects_non_mapping_yaml_roots(tmp_path, monkeypatch, source):
    path = tmp_path / "non-mapping.yaml"
    path.write_text(source, encoding="utf-8")
    monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(path))

    with pytest.raises(yaml.YAMLError):
        load_defaults()


def test_load_defaults_rejects_invalid_yaml_timestamp(tmp_path, monkeypatch):
    path = tmp_path / "invalid-timestamp.yaml"
    path.write_text("created_at: 2026-99-99\n", encoding="utf-8")
    monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(path))

    with pytest.raises(yaml.YAMLError):
        load_defaults()


@pytest.mark.parametrize("source", ["", "null\n", "render:\n  join_fade_max_ms: 23\n"])
def test_load_defaults_preserves_mapping_and_empty_root_semantics(tmp_path, monkeypatch, source):
    path = tmp_path / "valid-root.yaml"
    path.write_text(source, encoding="utf-8")
    monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(path))

    result = load_defaults()

    if "render:" in source:
        assert result["render"]["join_fade_max_ms"] == 23
    else:
        assert "render" not in result


def test_load_defaults_rereads_a_changed_file_and_copies_per_caller(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    cfg = tmp_path / "pipeline.yaml"
    cfg.write_text("render:\n  join_fade_max_ms: 25\n", encoding="utf-8")
    monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(cfg))
    first = load_defaults()
    first["render"]["join_fade_max_ms"] = 999
    assert load_defaults()["render"]["join_fade_max_ms"] == 25
    cfg.write_text("render:\n  join_fade_max_ms: 30\n", encoding="utf-8")
    st = cfg.stat()
    os.utime(cfg, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
    assert load_defaults()["render"]["join_fade_max_ms"] == 30


def test_load_defaults_rereads_a_same_size_edit_with_unchanged_mtime(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    cfg = tmp_path / "pipeline.yaml"
    cfg.write_text("render:\n  join_fade_max_ms: 40\n", encoding="utf-8")
    monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(cfg))
    st = cfg.stat()
    assert load_defaults()["render"]["join_fade_max_ms"] == 40
    cfg.write_text("render:\n  join_fade_max_ms: 45\n", encoding="utf-8")
    os.utime(cfg, ns=(st.st_atime_ns, st.st_mtime_ns))
    assert cfg.stat().st_size == st.st_size
    assert load_defaults()["render"]["join_fade_max_ms"] == 45


def test_join_micro_fade_ms_reads_inaudible_cuts_with_default():
    assert join_micro_fade_ms({}) == DEFAULT_MICRO_FADE_MS == 10
    assert join_micro_fade_ms({"inaudible_cuts": {"micro_fade_ms": 7}}) == 7
    assert join_micro_fade_ms(defaults=load_defaults()) == int(
        load_defaults()["inaudible_cuts"]["micro_fade_ms"]
    )


def test_load_defaults_parses_once_per_content_and_returns_private_copies(tmp_path, monkeypatch):
    path = tmp_path / "defaults.yaml"
    path.write_text("mix:\n  premix_peak_ceiling_db: -2.0\n")
    monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(path))
    parses: list[bytes] = []
    real_load = config.yaml.safe_load

    def counted(raw):
        parses.append(raw)
        return real_load(raw)

    monkeypatch.setattr(config.yaml, "safe_load", counted)

    first = load_defaults()
    first["mix"]["premix_peak_ceiling_db"] = -9.0
    second = load_defaults()
    assert second["mix"]["premix_peak_ceiling_db"] == -2.0
    assert len(parses) == 1

    path.write_text("mix:\n  premix_peak_ceiling_db: -3.0\n")
    assert load_defaults()["mix"]["premix_peak_ceiling_db"] == -3.0
    assert len(parses) == 2


@pytest.mark.parametrize(
    "source", ['custom: !!int ""', "custom: !!bool banana", "custom: !!timestamp invalid"]
)
def test_external_scalar_constructor_errors_are_yaml_errors(tmp_path, monkeypatch, source):
    path = tmp_path / "scalar.yaml"
    path.write_text(source, encoding="utf-8")
    monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(path))
    with pytest.raises(yaml.YAMLError):
        load_defaults()
    path.write_text("mix: {premix_peak_ceiling_db: -2.5}\n", encoding="utf-8")
    assert load_defaults()["mix"]["premix_peak_ceiling_db"] == -2.5


def test_yaml_decoder_runtime_error_propagates(tmp_path, monkeypatch):
    path = tmp_path / "decoder.yaml"
    path.write_text("custom: valid\n", encoding="utf-8")
    monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(path))

    def fail(_text):
        raise RuntimeError("decoder programming failure")

    with monkeypatch.context() as patch:
        patch.setattr(config.yaml, "safe_load", fail)
        with pytest.raises(RuntimeError, match="decoder programming failure"):
            load_defaults()
    assert load_defaults()["custom"] == "valid"


@pytest.mark.parametrize(
    "config",
    [
        {},
        {"transcribe": None},
        {"transcribe": {"vad": None, "forced_alignment": {"enabled": None}}},
        {"transcribe": {"vad": {"threshold": "n/a", "speech_pad_ms": "90000"}}},
        {"transcribe": {"decode": {"temperature": [0, "0.4", 9, "n/a"]}}},
        {"transcribe": {"decode": {"temperature": (), "hallucination_silence_threshold": None}}},
        {"transcribe": {"decode": {"temperature": True, "hallucination_silence_threshold": 0}}},
    ],
)
def test_strict_asr_admission_preserves_owned_conversions(config):
    from podcast_mcp.engines.asr_options import AsrOptions

    options = AsrOptions.from_defaults(config, strict_inputs=True)
    assert options == AsrOptions.from_defaults(config)
    assert options.language == "en"
    assert options.vad_threshold == 0.4
    assert options.forced_alignment.requested is None


@pytest.mark.parametrize(
    "config",
    [
        {"transcribe": []},
        {"transcribe": {"vad": "invalid"}},
        {"transcribe": {"language": {}}},
        {"transcribe": {"vad": {"threshold": []}}},
        {"transcribe": {"decode": {"temperature": [0.0, {}]}}},
        {"transcribe": {"silence_filter": {"enabled": []}}},
        {"transcribe": {"forced_alignment": {"min_word_score": {}}}},
    ],
)
def test_strict_asr_admission_rejects_shapes_without_changing_ordinary_resolution(config):
    from podcast_mcp.engines.asr_options import AsrOptions

    AsrOptions.from_defaults(config)
    with pytest.raises(ValueError):
        AsrOptions.from_defaults(config, strict_inputs=True)


@pytest.mark.parametrize(
    "mode,expected",
    [(None, True), (False, True), (0, True), ("off", False), ("auto", True), ("other", True)],
)
def test_strict_gate_fill_admission_keeps_scalar_semantics(mode, expected):
    from podcast_mcp.engines.bleed_gate import bleed_fill_enabled

    config = {"gate_fill": {"mode": mode}}
    assert bleed_fill_enabled(config, strict_inputs=True) is expected
    assert bleed_fill_enabled(config) is expected


def test_strict_analysis_admission_preserves_scalar_conversions():
    from podcast_mcp.engines.audio_audit import AnalysisPolicy

    config = {
        "analysis": {
            "ml_backend": False,
            "transcript_mode": None,
            "reconcile_on_render": 0,
            "heuristics": {
                "min_fade_ms": "12",
                "bleed_dominance_db": "4.5",
                "bleed_text_match_enabled": None,
                "bleed_text_match_min_dominance_db": None,
            },
        }
    }
    policy = AnalysisPolicy.from_defaults(config, strict_inputs=True)
    assert policy == AnalysisPolicy.from_defaults(config)
    assert (policy.min_fade_ms, policy.bleed_dominance_db) == (12, 4.5)
    assert (policy.ml_backend, policy.transcript_mode) == ("false", "None")
    assert policy.reconcile_on_render is False
    assert policy.bleed_text_match_enabled is False

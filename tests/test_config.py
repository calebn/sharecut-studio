from __future__ import annotations

from podcast_mcp.config import (
    cache_dir,
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
    assert analysis["heuristics"]["audibility_rms_db"] == -42.0


def test_load_defaults_transcribe_model_is_turbo(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("PODCAST_WHISPER_MODEL", raising=False)
    defaults = load_defaults()
    assert defaults["transcribe"]["model"] == "large-v3-turbo"


def test_load_defaults_overlay_whisper_pref(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("PODCAST_WHISPER_MODEL", raising=False)
    from podcast_mcp.whisper_models import persist_whisper_model

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

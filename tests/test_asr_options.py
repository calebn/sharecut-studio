from __future__ import annotations

import inspect

import pytest

from podcast_mcp.config import load_defaults
from podcast_mcp.engines.asr_options import AsrOptions


def test_yaml_defaults_equal_dataclass_defaults():
    assert AsrOptions.from_defaults(load_defaults()) == AsrOptions()


def test_forced_alignment_flag_reads_yaml_and_is_not_a_decode_key():
    assert (
        AsrOptions.from_defaults(
            {"transcribe": {"forced_alignment": {"enabled": True}}}
        ).forced_alignment_enabled
        is True
    )
    assert AsrOptions(forced_alignment_enabled=True).decode_key() == AsrOptions().decode_key()


def test_forced_alignment_min_word_score_reads_yaml_bounded_and_is_not_a_decode_key():
    def _score(value):
        return AsrOptions.from_defaults(
            {"transcribe": {"forced_alignment": {"min_word_score": value}}}
        ).forced_alignment_min_word_score

    assert _score(0.2) == pytest.approx(0.2)
    assert _score(5) == pytest.approx(1.0)
    assert _score(-1) == pytest.approx(0.0)
    assert _score("x") == pytest.approx(0.01)
    assert AsrOptions(forced_alignment_min_word_score=0.5).decode_key() == AsrOptions().decode_key()


def test_from_defaults_overrides_and_bounds():
    opts = AsrOptions.from_defaults(
        {
            "transcribe": {
                "vad": {"enabled": False, "threshold": 9, "speech_pad_ms": 100},
                "decode": {
                    "temperature": 0.0,
                    "condition_on_previous_text": False,
                    "hallucination_silence_threshold": 0,
                },
                "silence_filter": {"enabled": False, "peak_dbfs": -50},
            }
        }
    )
    assert not opts.vad_enabled
    assert opts.vad_threshold == 1.0
    assert opts.vad_speech_pad_ms == 100
    assert opts.temperature == (0.0,)
    assert not opts.condition_on_previous_text
    assert opts.hallucination_silence_threshold is None
    assert not opts.silence_filter_enabled
    assert opts.silence_peak_dbfs == -50


def test_from_defaults_tolerates_junk():
    opts = AsrOptions.from_defaults(
        {"transcribe": {"vad": "x", "decode": {"temperature": [], "log_prob_threshold": "n/a"}}}
    )
    assert opts == AsrOptions()


def test_from_defaults_none_threshold_disables_skip():
    opts = AsrOptions.from_defaults(
        {"transcribe": {"decode": {"hallucination_silence_threshold": None}}}
    )
    assert opts.hallucination_silence_threshold is None


def test_transcribe_kwargs_vad_on_and_off():
    on = AsrOptions().transcribe_kwargs()
    assert on["vad_filter"] is True
    assert on["vad_parameters"]["threshold"] == 0.4
    off = AsrOptions(vad_enabled=False).transcribe_kwargs()
    assert off["vad_filter"] is False
    assert "vad_parameters" not in off


def test_prompt_routes_to_initial_prompt_or_hotwords():
    assert AsrOptions().transcribe_kwargs("g")["initial_prompt"] == "g"
    kw = AsrOptions(condition_on_previous_text=False).transcribe_kwargs("g")
    assert kw["hotwords"] == "g"
    assert "initial_prompt" not in kw


def test_decode_key_ignores_vad_params_when_off():
    a = AsrOptions(vad_enabled=False, vad_threshold=0.1).decode_key()
    b = AsrOptions(vad_enabled=False, vad_threshold=0.9).decode_key()
    assert a == b
    assert AsrOptions().decode_key() != a


def test_faster_whisper_defaults_match_installed_signature():
    fw = pytest.importorskip("faster_whisper")
    params = inspect.signature(fw.WhisperModel.transcribe).parameters
    ref = AsrOptions.faster_whisper_defaults()
    assert list(ref.temperature) == list(params["temperature"].default)
    assert ref.no_speech_threshold == params["no_speech_threshold"].default
    assert ref.log_prob_threshold == params["log_prob_threshold"].default
    assert ref.compression_ratio_threshold == params["compression_ratio_threshold"].default
    assert ref.condition_on_previous_text == params["condition_on_previous_text"].default
    assert ref.hallucination_silence_threshold == params["hallucination_silence_threshold"].default
    assert ref.vad_enabled == params["vad_filter"].default
    assert ref.is_faster_whisper_default
    assert not AsrOptions().is_faster_whisper_default


def test_engine_default_options_follow_pipeline_yaml(monkeypatch, tmp_path):
    from podcast_mcp.engines.transcribe import TranscriptionEngine

    cfg = tmp_path / "pipeline.yaml"
    cfg.write_text("transcribe:\n  vad:\n    enabled: false\n", encoding="utf-8")
    monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(cfg))
    assert TranscriptionEngine().options.vad_enabled is False
    assert TranscriptionEngine(options=AsrOptions()).options.vad_enabled is True


def test_transcribe_kwargs_are_accepted_by_installed_faster_whisper():
    fw = pytest.importorskip("faster_whisper")
    params = set(inspect.signature(fw.WhisperModel.transcribe).parameters)
    for opts in (AsrOptions(), AsrOptions(condition_on_previous_text=False)):
        assert set(opts.transcribe_kwargs("vocab")) <= params

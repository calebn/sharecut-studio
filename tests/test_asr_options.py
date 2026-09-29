from __future__ import annotations

import inspect

import pytest

from model_pin_helpers import plant_pinned_word_aligner
from podcast_mcp.config import load_defaults
from podcast_mcp.engines.asr_options import AsrOptions, ForcedAlignment
from podcast_mcp.word_aligner_models import WordAlignerMissingError


def test_yaml_defaults_equal_dataclass_defaults():
    assert AsrOptions.from_defaults(load_defaults()) == AsrOptions()


def _requested(value):
    return AsrOptions.from_defaults({"transcribe": {"forced_alignment": {"enabled": value}}})


def test_forced_alignment_follows_the_installed_model_by_default(monkeypatch, tmp_path):
    hidden = _requested(None).forced_alignment
    assert hidden == ForcedAlignment(requested=None, installed=False)
    assert hidden.enabled is False
    assert hidden.blocked is False
    assert hidden.reason == (
        "unavailable: word aligner 'onnx-base' is not downloaded "
        "(podcast bootstrap --component word-aligner)"
    )
    assert AsrOptions().forced_alignment_enabled is False

    plant_pinned_word_aligner(monkeypatch, tmp_path)
    installed = AsrOptions.from_defaults(load_defaults()).forced_alignment
    assert installed == ForcedAlignment(requested=None, installed=True)
    assert installed.enabled is True
    assert installed.reason == "on by default: word aligner 'onnx-base' is installed"
    assert AsrOptions().forced_alignment_enabled is True


def test_forced_alignment_explicit_false_wins_over_the_installed_model(monkeypatch, tmp_path):
    plant_pinned_word_aligner(monkeypatch, tmp_path)
    off = _requested(False).forced_alignment
    assert off.enabled is False
    assert off.blocked is False
    assert off.reason == "off: transcribe.forced_alignment.enabled is false"
    off.require()


def test_forced_alignment_explicit_true_without_the_model_is_blocked():
    blocked = _requested(True).forced_alignment
    assert blocked.enabled is False
    assert blocked.blocked is True
    assert blocked.reason == (
        "blocked: transcribe.forced_alignment.enabled is true but word aligner 'onnx-base' "
        "is not downloaded (podcast bootstrap --component word-aligner)"
    )
    with pytest.raises(WordAlignerMissingError) as excinfo:
        blocked.require()
    assert "podcast bootstrap --component word-aligner" in str(excinfo.value)
    assert "transcribe.forced_alignment.enabled is true" in str(excinfo.value)


def test_forced_alignment_explicit_true_with_the_model(monkeypatch, tmp_path):
    plant_pinned_word_aligner(monkeypatch, tmp_path)
    on = _requested(True).forced_alignment
    assert on.enabled is True
    assert on.reason == "on: transcribe.forced_alignment.enabled is true"
    assert on.report() == {
        "enabled": True,
        "model": "onnx-base",
        "requested": True,
        "installed": True,
        "blocked": False,
        "reason": "on: transcribe.forced_alignment.enabled is true",
    }
    assert _requested(None).forced_alignment.report()["requested"] is None
    assert _requested(False).forced_alignment.report()["model"] is None


def test_forced_alignment_is_not_a_decode_key(monkeypatch, tmp_path):
    hidden_key = AsrOptions().decode_key()
    plant_pinned_word_aligner(monkeypatch, tmp_path)
    assert _requested(True).decode_key() == hidden_key
    assert _requested(False).decode_key() == hidden_key


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

from __future__ import annotations

import json
from pathlib import Path

import pytest

from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.util.wer import tokens_from_text, word_error_rate

pytestmark = [pytest.mark.e2e, pytest.mark.e2e_slow]

WER_CEILING = 0.12
SAMPLE_IDS = (
    "01_1272-135031-0001",
    "02_1272-135031-0002",
    "03_1272-135031-0003",
)


def test_asr_gold_wer_ceiling(asr_gold_fixture_dir: Path) -> None:
    manifest = json.loads((asr_gold_fixture_dir / "manifest.json").read_text(encoding="utf-8"))
    by_id = {entry["id"]: entry for entry in manifest["utterances"]}
    utterances = [by_id[uid] for uid in SAMPLE_IDS]
    engine = TranscriptionEngine(model_size="base", device="cpu")

    for entry in utterances:
        audio = asr_gold_fixture_dir / entry["audio"]
        reference_path = asr_gold_fixture_dir / entry["reference"]
        reference_text = reference_path.read_text(encoding="utf-8").strip()
        assert reference_text, f"missing reference for {entry['id']}"

        transcript = engine.transcribe_file(audio, language="en")
        hypothesis = " ".join(w.text for w in transcript.words)
        result = word_error_rate(
            tokens_from_text(reference_text),
            tokens_from_text(hypothesis),
        )
        assert result.wer is not None
        assert result.wer <= WER_CEILING, (
            f"{entry['id']}: WER {result.wer:.1%} > {WER_CEILING:.0%}\n"
            f"ref: {reference_text}\n"
            f"hyp: {hypothesis}"
        )

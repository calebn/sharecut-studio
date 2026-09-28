"""#715: reproduce the checked-in shipped-pass numbers with a real run.

``e2e_real`` (not part of ``make test`` / the default suite): needs the pinned
onnx-base word-aligner snapshot cached locally (``podcast bootstrap
--component word-aligner``). Skips rather than fails when it is not cached, so
CI (which never bootstraps opt-in assets) and contributors without the model
are unaffected; run explicitly with ``uv run pytest --no-cov -q -m e2e_real
tests/test_word_align_real.py``.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines.asr_options import AsrOptions
from podcast_mcp.engines.word_align import WordAligner
from podcast_mcp.models.episode import TranscriptWord
from podcast_mcp.word_aligner_models import word_aligner_is_cached
from script_loader import load_script

pytestmark = pytest.mark.e2e_real

WORD_BOUNDARY_DIR = Path(__file__).parent / "fixtures" / "word_boundary"
PROBE_SILENCE_SEC = 1.5
PROBE_NOISE_SEC = 1.5
PROBE_NOISE_DBFS = -50.0

# tests/test_word_boundary_metrics.py::test_checked_in_shipped_pass_report_matches_pipeline_fixture
# pins the same value from the checked-in tests/fixtures/word_boundary/*.onnx-base-pipeline.json
# reports (measured 2026-09-28, see docs/testing.md "Shipped pass results (#715)").
CHECKED_IN_LIBRISPEECH_MAE_MS = 42.97619047619047
NATIVE_LIBRISPEECH_MAE_MS = 82.2619


@pytest.mark.skipif(
    not word_aligner_is_cached(),
    reason="onnx-base word aligner not cached; run `podcast bootstrap --component word-aligner`",
)
def test_pipeline_pass_reproduces_checked_in_mae_below_native(tmp_path: Path) -> None:
    """A real ``run_pipeline_pass`` on ``librispeech`` lands within 1 ms of the checked-in MAE."""
    bfa = load_script("benchmark_forced_aligners", register=True)

    items = bfa.resolve_target("librispeech")
    summary = bfa.run_pipeline_pass(items, runs_dir=tmp_path, target="librispeech")

    scored = summary["scored"]
    assert scored is not None
    assert scored["matched_words"] == 42
    assert scored["reference_words"] == 48
    assert scored["boundary_mae_ms"] == pytest.approx(CHECKED_IN_LIBRISPEECH_MAE_MS, abs=1.0)
    assert scored["boundary_mae_ms"] < NATIVE_LIBRISPEECH_MAE_MS


def _native_words(fixture_id: str) -> list[TranscriptWord]:
    data = json.loads((WORD_BOUNDARY_DIR / f"{fixture_id}.native-base.json").read_text())
    return [TranscriptWord(text=w["text"], start=w["start"], end=w["end"]) for w in data["words"]]


@pytest.mark.skipif(
    not word_aligner_is_cached(),
    reason="onnx-base word aligner not cached; run `podcast bootstrap --component word-aligner`",
)
def test_evidence_floor_separates_real_words_from_silence_and_noise_probes(
    tmp_path: Path,
) -> None:
    """#195: the shipped ``min_word_score`` floor separates real speech from two probes.

    Measured numbers go in docs/testing.md "Aligner evidence floor (#195)".
    """
    bfa = load_script("benchmark_forced_aligners", register=True)
    aligner = WordAligner.load(threads=4)
    floor = AsrOptions().forced_alignment_min_word_score

    # Real words: every LibriSpeech clip's native-base words, force-aligned.
    real_scores: list[float] = []
    for native_json in sorted(WORD_BOUNDARY_DIR.glob("*.native-base.json")):
        fixture_id = native_json.name.removesuffix(".native-base.json")
        words = _native_words(fixture_id)
        result = aligner.align(WORD_BOUNDARY_DIR / f"{fixture_id}.wav", words)
        real_scores.extend(s for s in result.scores if s is not None)
    assert real_scores

    # Probes: a real clip, then digital silence, then seeded low-level noise.
    clip_id = "1988-147956-0023"
    samples = bfa.load_audio(WORD_BOUNDARY_DIR / f"{clip_id}.wav", None)
    rate = bfa.SAMPLE_RATE  # word_boundary fixtures are 16 kHz mono
    duration = samples.size / rate

    silence = np.zeros(round(PROBE_SILENCE_SEC * rate), dtype=np.float32)
    rng = np.random.default_rng(0)
    noise_amplitude = 10 ** (PROBE_NOISE_DBFS / 20)
    noise = rng.standard_normal(round(PROBE_NOISE_SEC * rate)).astype(np.float32) * noise_amplitude

    probe_path = tmp_path / "probe.wav"
    bfa.write_wav16(probe_path, np.concatenate([samples, silence, noise]))

    probe_words = _native_words(clip_id)
    d = duration
    probe_words.append(TranscriptWord(text="hello", start=d + 0.4, end=d + 0.9))
    probe_words.append(TranscriptWord(text="world", start=d + 1.9, end=d + 2.4))

    probe_result = aligner.align(probe_path, probe_words)
    silence_score = probe_result.scores[-2]
    noise_score = probe_result.scores[-1]

    ordered = sorted(real_scores)
    real_min = ordered[0]
    real_p5 = ordered[max(0, round(0.05 * (len(ordered) - 1)))]
    real_median = ordered[len(ordered) // 2]
    print(
        f"real words: n={len(ordered)} min={real_min:.4f} p5={real_p5:.4f} median={real_median:.4f}"
    )
    print(f"silence probe score={silence_score}")
    print(f"noise probe score={noise_score}")

    assert real_min >= 10 * floor
    assert silence_score is not None and silence_score < floor
    assert noise_score is not None and noise_score < floor

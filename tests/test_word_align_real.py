"""#715: reproduce the checked-in shipped-pass numbers with a real run.

``e2e_real`` (not part of ``make test`` / the default suite): needs the pinned
onnx-base word-aligner snapshot cached locally (``podcast bootstrap
--component word-aligner``). Skips rather than fails when it is not cached, so
CI (which never bootstraps opt-in assets) and contributors without the model
are unaffected; run explicitly with ``uv run pytest --no-cov -q -m e2e_real
tests/test_word_align_real.py``.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.word_aligner_models import word_aligner_is_cached
from script_loader import load_script

pytestmark = pytest.mark.e2e_real

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

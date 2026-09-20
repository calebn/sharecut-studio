from __future__ import annotations

import os
from pathlib import Path

FIXTURES_DIR = Path(__file__).resolve().parents[2] / "tests" / "fixtures"
DEFAULT_CANNED = FIXTURES_DIR / "canned_transcript_aligned.json"
E2E_DIALOGUE_PROJECT = FIXTURES_DIR / "aligned_dialogue" / "episode.project.json"
SYNTHETIC_BLEED_PROJECT = FIXTURES_DIR / "synthetic_bleed_60s" / "episode.project.json"
SYNTHETIC_BLEED_PIPELINE = FIXTURES_DIR / "synthetic_bleed_e2e_pipeline.yaml"
ASR_GOLD_DIR = FIXTURES_DIR / "asr_gold"
AMI_BLEED_PROJECT = FIXTURES_DIR / "ami_bleed_60s" / "episode.project.json"
BENCHMARK_THRESHOLDS = FIXTURES_DIR / "benchmark_regression_thresholds.json"

KNOWN_PHRASES = [
    "documented",
    "people",
    "today",
]


def e2e_project_path() -> Path:
    override = os.environ.get("PODCAST_E2E_PROJECT")
    if override:
        p = Path(override).expanduser().resolve()
        if p.is_dir():
            return p / "episode.project.json"
        return p
    return E2E_DIALOGUE_PROJECT.resolve()

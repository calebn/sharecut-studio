from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.e2e_fixture import (
    AMI_BLEED_PROJECT,
    ASR_GOLD_DIR,
    SYNTHETIC_BLEED_PIPELINE,
    SYNTHETIC_BLEED_PROJECT,
    e2e_project_path,
)
from podcast_mcp.project_io import copy_relocated_workspace

_FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
_E2E_PIPELINE = _FIXTURES / "e2e_pipeline.yaml"


@pytest.fixture(autouse=True)
def _e2e_pipeline_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    """E2E uses flag-only reconciliation so short fixture transcripts stay clip-able."""
    monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(_E2E_PIPELINE))


def _copy_fixture_workspace(
    tmp_path: Path,
    project_file: Path,
    *,
    prefix: str,
) -> Path:
    return copy_relocated_workspace(project_file, tmp_path / prefix)


@pytest.fixture(scope="session")
def e2e_project_file() -> Path:
    path = e2e_project_path()
    if not path.is_file():
        pytest.skip(f"e2e project not found: {path}")
    return path


@pytest.fixture
def e2e_workspace(tmp_path: Path, e2e_project_file: Path) -> Path:
    """Copy the aligned_dialogue fixture into tmp so tests can mutate safely."""
    return _copy_fixture_workspace(tmp_path, e2e_project_file, prefix="e2e_ws")


@pytest.fixture(scope="session")
def synthetic_bleed_project_file() -> Path:
    if not SYNTHETIC_BLEED_PROJECT.is_file():
        pytest.skip(f"synthetic bleed fixture not found: {SYNTHETIC_BLEED_PROJECT}")
    return SYNTHETIC_BLEED_PROJECT


@pytest.fixture
def synthetic_bleed_workspace(
    tmp_path: Path,
    synthetic_bleed_project_file: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Path:
    monkeypatch.setenv(
        "PODCAST_MCP_PIPELINE_DEFAULTS",
        str(SYNTHETIC_BLEED_PIPELINE),
    )
    return _copy_fixture_workspace(
        tmp_path,
        synthetic_bleed_project_file,
        prefix="synthetic_bleed_ws",
    )


@pytest.fixture(scope="session")
def asr_gold_fixture_dir() -> Path:
    manifest = ASR_GOLD_DIR / "manifest.json"
    if not manifest.is_file():
        pytest.skip(f"asr_gold fixture not found: {ASR_GOLD_DIR}")
    return ASR_GOLD_DIR


@pytest.fixture(scope="session")
def ami_bleed_project_file() -> Path:
    if not AMI_BLEED_PROJECT.is_file():
        pytest.skip(f"ami bleed fixture not found: {AMI_BLEED_PROJECT}")
    return AMI_BLEED_PROJECT


@pytest.fixture
def ami_bleed_workspace(
    tmp_path: Path,
    ami_bleed_project_file: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Path:
    monkeypatch.setenv(
        "PODCAST_MCP_PIPELINE_DEFAULTS",
        str(SYNTHETIC_BLEED_PIPELINE),
    )
    return _copy_fixture_workspace(
        tmp_path,
        ami_bleed_project_file,
        prefix="ami_bleed_ws",
    )

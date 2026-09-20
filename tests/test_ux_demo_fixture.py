"""Guards for the Sharecut Studio UX demo fixture used by the UX Pages pack."""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.project_store import ProjectStore

ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "tests" / "fixtures" / "sharecut_ux_demo"
PROJECT = DEMO / "episode.project.json"


@pytest.mark.parametrize(
    "rel",
    [
        "episode.project.json",
        "README.md",
        "raw/reference.wav",
        "raw/guest.wav",
    ],
)
def test_ux_demo_fixture_files_exist(rel: str) -> None:
    path = DEMO / rel
    assert path.exists(), f"missing {path}; run python3 scripts/build_ux_demo_fixture.py"


def test_ux_demo_fixture_loads_and_has_showcase_data() -> None:
    project = ProjectStore(PROJECT).load()
    assert project.meta.name == "Sharecut Studio UX demo"
    pending = [d for d in project.edit_decisions if not d.applied]
    assert pending, "expected at least one pending edit for Impact / overlays"
    assert project.review and len(project.review.comments) >= 2
    assert project.editorial.chapters
    assert project.social.clip_candidates
    assert any(
        (w.confidence is not None and w.confidence < 0.5) or w.suppressed
        for tr in project.transcripts
        for w in tr.words
    )
    ref = DEMO / "raw" / "reference.wav"
    assert ref.is_symlink() or ref.is_file()

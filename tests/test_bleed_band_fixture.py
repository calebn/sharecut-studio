"""Guards for the one-band automatic-reduction fixture."""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.project.store import ProjectStore

ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "tests" / "fixtures" / "bleed_band_demo"
PROJECT = DEMO / "episode.sharecut"


@pytest.mark.parametrize(
    "rel",
    ["episode.sharecut", "README.md", "raw/reference.wav", "raw/guest.wav"],
)
def test_bleed_band_fixture_files_exist(rel: str) -> None:
    path = DEMO / rel
    assert path.exists(), f"missing {path}; run python3 scripts/build_bleed_band_fixture.py"


def test_the_fixture_has_exactly_one_automatic_band_on_a_short_clip() -> None:
    project = ProjectStore(PROJECT).load()
    bands = [
        (clip, region)
        for clip in project.timeline.clips
        for region in clip.off_speaker_mute_regions
    ]
    assert len(bands) == 1
    clip, region = bands[0]
    assert clip.track_id == "reference"
    assert clip.source_end - clip.source_start == pytest.approx(20.0)
    assert clip.source_start <= region.start_s < region.end_s <= clip.source_end
    others = [c for c in project.timeline.clips if c.id != clip.id]
    assert others
    assert all(not c.off_speaker_mute_regions for c in others)


def test_the_committed_fixture_matches_what_the_builder_writes(tmp_path: Path) -> None:
    import json
    import sys

    sys.path.insert(0, str(ROOT / "scripts"))
    from build_bleed_band_fixture import build

    rebuilt = build(tmp_path / "bleed_band_demo")
    assert rebuilt is not None
    assert json.loads(rebuilt.read_text(encoding="utf-8")) == json.loads(
        PROJECT.read_text(encoding="utf-8")
    )
    assert (rebuilt.parent / "raw" / "reference.wav").resolve() == (
        ROOT / "tests" / "fixtures" / "aligned_dialogue" / "raw" / "reference.wav"
    ).resolve()

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


def test_ux_demo_audio_and_words_share_the_source_fixture() -> None:
    from podcast_mcp.models import load_project

    source = load_project(DEMO.parent / "aligned_dialogue" / "episode.project.json")
    demo = load_project(PROJECT)
    for original, showcased in zip(source.transcripts, demo.transcripts, strict=True):
        assert original.track_id == showcased.track_id
        assert [(w.text, w.start, w.end) for w in showcased.words] == [
            (w.text, w.start, w.end) for w in original.words
        ]
        assert (DEMO / "raw" / f"{original.track_id}.wav").read_bytes() == (
            DEMO.parent / "aligned_dialogue" / "raw" / f"{original.track_id}.wav"
        ).read_bytes()
    decision = demo.edit_decisions[0]
    transcript = next(t for t in demo.transcripts if t.track_id == decision.track_id)
    assert [(w.text, w.start, w.end) for w in transcript.words if w.suppressed] == [
        ("uncle", decision.start, decision.end)
    ]

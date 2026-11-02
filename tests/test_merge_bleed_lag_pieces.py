"""The one-off merge script keeps what a bleed-lag lane plays (#2861, umbrella #1089)."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import room_tone
from podcast_mcp.engines.clips_ops import split_clip_at
from podcast_mcp.engines.session_timeline import slip_clip_to_shift
from podcast_mcp.models import Clip, EpisodeProject
from podcast_mcp.models.episode import SpeakerIngestAlignment, load_project
from podcast_mcp.project.store import ProjectStore
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document.history import HistoryService
from script_loader import load_script
from test_timed_clip_render import RATE, _frames, _project, _render

script = load_script("merge_bleed_lag_pieces")

BASE_SHIFT = -0.12
FADE_SEC = 0.01
GAP = 0.15
NEG_GOLDEN = {
    "pieces": [(0.12, 182.77, 0.0, 0, 10), (182.85, 240.0, 182.65, 10, 0)],
    "first": (0.12, 240.0),
    "shifts": (-0.12, -0.20),
    "step": (182.77, -0.08, (152.535, 213.085)),
    "gap": 30.275,
}
POS_GOLDEN = {
    "pieces": [(0.2, 182.85, 0.0, 0, 10), (182.77, 240.0, 182.65, 10, 0)],
    "first": (0.2, 240.08),
    "shifts": (-0.2, -0.12),
    "step": (182.85, 0.08, (152.615, 213.005)),
    "gap": 30.195,
}


def _old_lane(
    first: Clip, source_end: float, mids: list[float], shifts: list[float], media: float
) -> list[Clip]:
    pieces = [first.model_copy(update={"source_end": source_end})]
    defaults = load_defaults()
    for mid, before, after in zip(mids, shifts, shifts[1:], strict=False):
        at_timeline = mid + (before + after) / 2
        left, right = split_clip_at(pieces[-1], at_timeline, defaults=defaults)
        pieces[-1:] = [left, right]
    for piece, shift in zip(pieces, shifts, strict=True):
        slipped = slip_clip_to_shift(piece, shift, media_duration=media)
        assert slipped is not None
        piece.source_start, piece.source_end, piece.timeline_start = slipped
    return pieces


def _artifact(shifts: list[float], mids: list[float], gaps: list[float]) -> dict:
    segments: list[dict] = [{"start_sec": 0.0, "shift_sec": shifts[0], "gap_sec": None}]
    segments += [
        {"start_sec": mid, "shift_sec": shift, "gap_sec": [mid - gap, mid + gap]}
        for mid, shift, gap in zip(mids, shifts[1:], gaps, strict=True)
    ]
    return {"bleed_lag_segments": {"host": {"step_cost": 0.5, "segments": segments}}}


def _save(project: EpisodeProject, pieces: list[Clip], shifts: list[float], lane: dict) -> Path:
    project.timeline.clips = pieces
    project.meta.ingest_alignment = {
        f"host:{piece.id}": SpeakerIngestAlignment.from_source_to_timeline_shift(
            shift, align_method="bleed_lag"
        )
        for piece, shift in zip(pieces, shifts, strict=True)
    }
    path = project.artifacts_dir() / "alignment" / "conversation_align.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(lane), encoding="utf-8")
    return ProjectStore(Path(project.meta.workspace_dir)).commit(project)


def _lane(
    tmp_path: Path,
    mids: list[float],
    steps: list[float],
    *,
    first: tuple[float, float] = (0.5, 7.5),
    base: float = BASE_SHIFT,
    media: float = 8.0,
    gaps: list[float] | None = None,
    signal: np.ndarray | None = None,
) -> tuple[EpisodeProject, list[Clip], Path]:
    shifts = [base]
    for delta in steps:
        shifts.append(shifts[-1] + delta)
    head = Clip(
        id="lane",
        track_id="host",
        source_start=first[0],
        source_end=first[1],
        timeline_start=first[0] + base,
    )
    pieces = _old_lane(head, first[1], mids, shifts, media)
    lane = _artifact(shifts, mids, gaps or [GAP] * len(mids))
    project = _project(tmp_path, pieces, signal if signal is not None else _signal(mids, shifts))
    return project, pieces, _save(project, pieces, shifts, lane)


def _signal(mids: list[float], shifts: list[float]) -> np.ndarray:
    signal = 0.3 * np.random.default_rng(7).uniform(-1, 1, 8 * RATE)
    quiet = 0.002 * np.random.default_rng(8).uniform(-1, 1, 8 * RATE)
    for mid in mids:
        lo, hi = _frames(mid - GAP), _frames(mid + GAP)
        signal[lo:hi] = quiet[lo:hi]
    return signal


def _run(path: Path, *flags: str) -> int:
    return script.main([str(path.parent), *flags])


def _geometry(clips: list[Clip]) -> list[tuple[float, float, float, int, int]]:
    return [
        (c.source_start, c.source_end, c.timeline_start, c.fade_in_ms, c.fade_out_ms)
        for c in sorted(clips, key=lambda c: c.timeline_start)
    ]


def _flat(clips: list[Clip]) -> list[float]:
    return [value for row in _geometry(clips) for value in row]


@pytest.mark.parametrize("golden", [NEG_GOLDEN, POS_GOLDEN], ids=["skip", "repeat"])
def test_two_piece_lane_matches_the_pinned_pieces_and_merges_to_one_step(
    golden: dict, tmp_path: Path
) -> None:
    before, after = golden["shifts"]
    _, pieces, path = _lane(
        tmp_path,
        [182.81],
        [after - before],
        first=golden["first"],
        base=before,
        media=240.0,
        gaps=[golden["gap"]],
    )
    assert _flat(pieces) == pytest.approx([v for row in golden["pieces"] for v in row])
    at, delta, quiet = golden["step"]
    loaded = load_project(path)
    rows = script.merge_project(loaded, allow_holes=True)
    (clip,) = loaded.clips
    (step,) = clip.timing.steps
    assert (step.at, step.delta_sec) == pytest.approx((at, delta))
    assert (step.quiet.start_s, step.quiet.end_s) == pytest.approx(quiet)
    assert clip.id == pieces[0].id
    assert rows[0]["runs"] == 1
    (entry,) = loaded.meta.ingest_alignment.values()
    assert list(loaded.meta.ingest_alignment) == ["Host"]
    assert entry.source_to_timeline_shift_sec == pytest.approx(before)
    assert clip.timeline_end == pytest.approx(pieces[-1].timeline_end)


def test_four_piece_mixed_sign_lane_is_one_clip_whose_pieces_follow_the_old_ones(
    tmp_path: Path,
) -> None:
    _, pieces, path = _lane(tmp_path, [2.0, 3.5, 5.0], [-0.08, 0.10, -0.20])
    loaded = load_project(path)
    script.merge_project(loaded, allow_holes=True)
    (clip,) = loaded.clips
    assert [round(s.delta_sec, 6) for s in clip.timing.steps] == [-0.08, 0.10, -0.20]
    assert [s.at for s in clip.timing.steps] == pytest.approx([p.source_end for p in pieces[:-1]])
    virtual = clip.virtual_pieces()
    assert [v[1] for v in virtual] == pytest.approx([p.source_end for p in pieces])
    assert virtual[0][0] == pytest.approx(pieces[0].source_start)
    assert virtual[1][0] == pytest.approx(pieces[1].source_start)
    assert virtual[2][0] == pytest.approx(pieces[1].source_end)
    assert virtual[3][0] == pytest.approx(pieces[3].source_start)
    assert (clip.fade_in_ms, clip.fade_out_ms) == (0, 0)


def test_skip_only_lane_renders_the_same_samples_and_undo_restores_the_pieces(
    tmp_path: Path,
) -> None:
    project, pieces, path = _lane(tmp_path, [2.0, 3.5, 5.0], [-0.08, -0.10, -0.20])
    old = _render(project, tmp_path)
    assert _run(path, "--apply") == 0
    assert (path.parent / "episode.sharecut.pre-2861.bak").is_file()
    merged = load_project(path)
    assert len(merged.clips) == 1
    new = _render(merged, tmp_path)
    assert old.shape == new.shape
    assert np.array_equal(old, new)
    assert _run(path, "--apply") == 0
    assert load_project(path).clips == merged.clips
    HistoryService(ProjectWorkspace.open(str(path))).undo()
    assert _flat(load_project(path).clips) == pytest.approx(_flat(pieces))


def test_repeat_step_is_gated_then_leaves_a_hole_and_nothing_else_differs(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    project, pieces, path = _lane(tmp_path, [3.5], [0.10])
    old = _render(project, tmp_path)
    before = path.read_bytes()
    assert _run(path, "--apply", "--json") == 0
    out = json.loads(capsys.readouterr().out)
    assert [r["reason"] for lane in out["lanes"] for r in lane["refused"]] == ["repeat_hole_gated"]
    assert len(load_project(path).clips) == 2
    assert _run(path, "--apply", "--allow-repeat-holes") == 0
    merged = load_project(path)
    assert len(merged.clips) == 1
    with patch.object(room_tone, "read_room_tone_pool", return_value=None):
        new = _render(merged, tmp_path)
    assert path.read_bytes() != before
    hole_start = _frames(pieces[0].timeline_end)
    hole_end = hole_start + _frames(0.10)
    outside = np.ones(old.shape, dtype=bool)
    outside[hole_start - _frames(FADE_SEC) : hole_end + _frames(FADE_SEC)] = False
    assert old.shape == new.shape
    assert np.array_equal(old[outside], new[outside])
    assert not new[hole_start:hole_end].any()
    assert old[hole_start:hole_end].any()


def test_repeat_hole_plays_room_tone_when_the_track_has_a_pool(tmp_path: Path) -> None:
    _, pieces, path = _lane(tmp_path, [3.5], [0.10])
    assert _run(path, "--apply", "--allow-repeat-holes") == 0
    pool = (room_tone.Sample(5.0, 7.0, -40.0, None),)
    with patch.object(room_tone, "read_room_tone_pool", return_value=pool):
        samples = _render(load_project(path), tmp_path)
    start = _frames(pieces[0].timeline_end)
    assert samples[start + _frames(0.03) : start + _frames(0.07)].any()


def _two_step(tmp_path: Path) -> tuple[Path, list[Clip]]:
    _, pieces, path = _lane(tmp_path, [2.0, 3.5, 5.0], [-0.08, -0.10, -0.20])
    return path, pieces


def _rewrite_artifact(path: Path, edit) -> None:
    artifact = path.parent / "artifacts" / "alignment" / "conversation_align.json"
    data = json.loads(artifact.read_text(encoding="utf-8"))
    edit(data)
    artifact.write_text(json.dumps(data), encoding="utf-8")


def _reasons(path: Path) -> list[str]:
    project = load_project(path)
    rows = script.merge_project(project)
    return [r["reason"] for row in rows for r in row["refused"]]


def test_no_artifact_refuses_every_junction_and_changes_nothing(tmp_path: Path) -> None:
    path, _ = _two_step(tmp_path)
    (path.parent / "artifacts" / "alignment" / "conversation_align.json").unlink()
    before = path.read_bytes()
    assert _reasons(path) == ["no_artifact_match"] * 3
    assert _run(path, "--apply") == 0
    assert path.read_bytes() == before


def test_a_segment_off_by_a_millisecond_does_not_match(tmp_path: Path) -> None:
    path, _ = _two_step(tmp_path)

    def shift(data: dict) -> None:
        data["bleed_lag_segments"]["host"]["segments"][1]["start_sec"] += 1e-3

    _rewrite_artifact(path, shift)
    assert _reasons(path) == ["no_artifact_match"]


def test_a_long_internal_fade_is_a_persons_edit(tmp_path: Path) -> None:
    path, _ = _two_step(tmp_path)
    project = load_project(path)
    project.clips[0].fade_out_ms = 500
    ProjectStore(path).commit(project)
    assert _reasons(path) == ["custom_fade"]


def test_a_lane_that_already_has_timing_is_skipped(tmp_path: Path) -> None:
    path, _ = _two_step(tmp_path)
    project = load_project(path)
    project.clips[0].timing = Clip.model_validate(
        {
            "id": "t",
            "track_id": "host",
            "source_start": 0.0,
            "source_end": 4.0,
            "timeline_start": 0.0,
            "timing": {"steps": [{"at": 1.0, "delta_sec": 0.2}]},
        }
    ).timing
    rows = script.merge_project(project)
    assert rows[0]["skipped"] == ["lane_has_timing"]
    assert len(project.clips) == 4


def test_a_refused_middle_junction_leaves_a_merge_on_each_side(tmp_path: Path) -> None:
    _, _, path = _lane(tmp_path, [1.5, 3.0, 4.5, 6.0], [-0.08, -0.10, -0.06, -0.12])

    def drop_middle(data: dict) -> None:
        data["bleed_lag_segments"]["host"]["segments"][2]["shift_sec"] -= 0.01

    _rewrite_artifact(path, drop_middle)
    project = load_project(path)
    rows = script.merge_project(project)
    assert [r["reason"] for r in rows[0]["refused"]] == ["no_artifact_match"] * 2
    assert len(project.clips) == 3
    assert [len(c.timing.steps) if c.timing else 0 for c in project.clips] == [1, 0, 1]


def test_a_dry_run_writes_nothing(tmp_path: Path) -> None:
    path, _ = _two_step(tmp_path)
    before = path.read_bytes()
    assert _run(path) == 0
    assert path.read_bytes() == before
    assert not list(path.parent.glob("*.bak"))

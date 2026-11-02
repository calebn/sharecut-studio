"""One timed clip plays like the split-and-slipped pieces the aligner used to make (#2860, 4b)."""

from __future__ import annotations

import itertools
import json
import wave
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

import bleed_helpers as bh
from podcast_mcp.edits.conversation_align import align_artifact_path
from podcast_mcp.engines import room_tone
from podcast_mcp.engines.clips_ops import set_track_clips, split_clip_at
from podcast_mcp.engines.session_timeline import slip_clip_to_shift
from podcast_mcp.engines.timeline_render import render_track_from_timeline
from podcast_mcp.engines.ungated_audio import raw_timeline_samples
from podcast_mcp.models import Clip
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.pipeline.service import PipelineService

RESUMES_SEC = 212.9


def _audio(first: float, second: float) -> dict[str, np.ndarray]:
    audio = bh.tracks(bleed={"caleb": {"audra": 0.0}}, gated=("audra",))
    audio["audra"] = bh.relatency(audio["audra"], lambda t: first if t < RESUMES_SEC else second)
    return audio


def _old_pieces(segments: list[dict]) -> list[Clip]:
    """The pieces the aligner used to split the lane into: split at the timeline junction,
    then slip each piece to its segment's shift."""
    whole = Clip(
        id="clip_audra", track_id="audra", source_start=0.0, source_end=240.0, timeline_start=0.0
    )
    pieces = [whole]
    for before, segment in itertools.pairwise(segments):
        at = segment["start_sec"] + (before["shift_sec"] + segment["shift_sec"]) / 2
        pieces[-1:] = list(split_clip_at(pieces[-1], at, defaults={}))
    out = []
    for piece, segment in zip(pieces, segments, strict=True):
        geometry = slip_clip_to_shift(piece, segment["shift_sec"], media_duration=240.0)
        assert geometry is not None
        out.append(
            piece.model_copy(
                update=dict(
                    zip(("source_start", "source_end", "timeline_start"), geometry, strict=True)
                )
            )
        )
    return out


def _render(ws: ProjectWorkspace, tmp_path: Path) -> np.ndarray:
    track = ws.project.tracks[1]
    out = tmp_path / "render.wav"
    with patch.object(room_tone, "read_room_tone_pool", return_value=None):
        render_track_from_timeline(ws.project, track, out, {})
    with wave.open(str(out), "rb") as audio:
        return np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2")


def _both(tmp_path: Path, first: float, second: float):
    audio = _audio(first, second)
    new = bh.workspace(tmp_path / "new", audio)
    PipelineService(new).run(only_step="align_tracks", unattended=True)
    segments = json.loads(align_artifact_path(new.project).read_text())["bleed_lag_segments"][
        "audra"
    ]["segments"]
    old = bh.workspace(tmp_path / "old", audio)
    set_track_clips(old.project, "audra", _old_pieces(segments))
    clip = next(c for c in new.project.clips if c.track_id == "audra")
    return new, old, clip


def test_a_skip_step_plays_the_old_pieces_sample_for_sample(tmp_path: Path) -> None:
    new, old, clip = _both(tmp_path, 0.12, 0.2)

    old_pieces = [c for c in old.project.clips if c.track_id == "audra"]
    assert len([c for c in new.project.clips if c.track_id == "audra"]) == 1
    assert clip.id == "clip_audra"
    got = [v for piece in clip.virtual_pieces() for v in piece]
    want = [v for c in old_pieces for v in (c.source_start, c.source_end, c.timeline_start)]
    assert got == pytest.approx(want, abs=1e-9)
    assert np.array_equal(
        raw_timeline_samples(new.project, "audra"), raw_timeline_samples(old.project, "audra")
    )
    assert np.array_equal(_render(new, tmp_path / "n"), _render(old, tmp_path / "o"))


def test_a_hole_step_plays_the_old_pieces_outside_the_hole_and_is_silent_inside(
    tmp_path: Path,
) -> None:
    new, old, clip = _both(tmp_path, 0.2, 0.12)

    (left, right) = clip.virtual_pieces()
    hole = (round((left[2] + left[1] - left[0]) * bh.RATE), round(right[2] * bh.RATE))
    old_samples = raw_timeline_samples(old.project, "audra")
    new_samples = raw_timeline_samples(new.project, "audra")
    assert hole[1] - hole[0] == round(0.08 * bh.RATE)
    assert new_samples.shape == old_samples.shape
    outside = np.ones(new_samples.shape, dtype=bool)
    outside[hole[0] : hole[1]] = False
    assert np.array_equal(new_samples[outside], old_samples[outside])
    assert not new_samples[hole[0] : hole[1]].any()

    new_render = _render(new, tmp_path / "n")
    old_render = _render(old, tmp_path / "o")
    scale = new_render.size / new_samples.size
    first, last = round(hole[0] * scale), round(hole[1] * scale)
    mask = np.ones(new_render.shape, dtype=bool)
    mask[first:last] = False
    assert np.array_equal(new_render[mask], old_render[mask])
    assert not new_render[first:last].any()

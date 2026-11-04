"""``ProposeSocialClips``: a rerun keeps approved and manual clips, one undo step, host only."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from podcast_mcp.clips import add_manual_social_clip, propose_social_clips
from podcast_mcp.models import (
    CombinedTranscript,
    CombinedUtterance,
    EpisodeProject,
    Track,
    load_project,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import ClipService, HistoryService
from podcast_mcp.services.document_sync.capabilities import HOST_ONLY_DOCUMENT_COMMANDS
from podcast_mcp.services.document_sync.payloads import validate_payload
from podcast_mcp.services.document_sync.registry import apply_command

CMD = "ProposeSocialClips"
DEFAULTS = {"social_clips": {"min_sec": 15, "max_candidates": 5}}


def _utt(start: float, text: str) -> CombinedUtterance:
    return CombinedUtterance(
        track_id="host", speaker="Host", start=start, end=start + 20.0, text=text
    )


def _project(tmp_path) -> EpisodeProject:
    proj = EpisodeProject.create("t", str(tmp_path))
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            _utt(0.0, "What if we tried this approach today?"),
            _utt(100.0, "Why does this work? Here is the secret in 3 steps."),
            _utt(200.0, "Is this the mistake nobody talks about?"),
        ]
    )
    return proj


def test_a_rerun_keeps_approved_clips_and_adds_no_duplicate(tmp_path):
    proj = _project(tmp_path)
    first = propose_social_clips(proj, DEFAULTS)
    assert len(first) == 3
    keep = first[0]
    keep.approved = True
    second = propose_social_clips(proj, DEFAULTS)
    assert keep in proj.social_clip_candidates
    assert keep.id not in {c.id for c in second}
    assert len(second) == 2
    spans = [(c.start, c.end) for c in proj.social_clip_candidates]
    assert len(spans) == len(set(spans)) == 3
    assert {c.id for c in first[1:]}.isdisjoint(c.id for c in proj.social_clip_candidates)


def test_a_rerun_keeps_manual_clips(tmp_path):
    proj = _project(tmp_path)
    proj.timeline.tracks = [Track(id="host", label="host")]
    manual = add_manual_social_clip(proj, track_id="host", start=100.0, end=120.0)
    proposed = propose_social_clips(proj, DEFAULTS)
    assert proposed
    assert manual in proj.social_clip_candidates
    assert all(
        c is manual or c.end <= 100.0 or c.start >= 120.0 for c in proj.social_clip_candidates
    )


def test_unapproved_candidates_are_replaced(tmp_path):
    proj = _project(tmp_path)
    first = propose_social_clips(proj, DEFAULTS)
    second = propose_social_clips(proj, DEFAULTS)
    assert {c.id for c in first}.isdisjoint(c.id for c in proj.social_clip_candidates)
    assert len(second) == 3


def test_replace_all_discards_approved_clips_too(tmp_path):
    proj = _project(tmp_path)
    first = propose_social_clips(proj, DEFAULTS)
    first[0].approved = True
    propose_social_clips(proj, DEFAULTS, replace_existing="all")
    assert not any(c.approved for c in proj.social_clip_candidates)
    assert len(proj.social_clip_candidates) == 3


def test_the_limit_counts_new_proposals_only(tmp_path):
    proj = _project(tmp_path)
    first = propose_social_clips(proj, DEFAULTS)
    first[0].approved = True
    second = propose_social_clips(proj, DEFAULTS, max_clips=1)
    assert len(second) == 1
    assert len(proj.social_clip_candidates) == 2


@pytest.fixture
def ws(minimal_project):
    project = load_project(minimal_project)
    project.timeline.tracks = [Track(id="host", label="host")]
    project.timeline.duration_sec = 400.0
    project.combined_transcript = CombinedTranscript(
        utterances=[_utt(0.0, "What if we tried this approach today?")]
    )
    save_project(project)
    return ProjectWorkspace.open(minimal_project)


def test_the_command_proposes_as_one_undo_step(ws):
    out = apply_command(ws, CMD, {"max_clips": 2})
    assert out["proposed"] == len(out["ids"])
    ws.reload()
    after = [c.id for c in ws.project.social_clip_candidates]
    assert after == out["ids"]
    HistoryService(ws).undo()
    assert ws.project.social_clip_candidates == []


def test_the_command_and_the_service_share_the_keep_rule(ws):
    first = ClipService(ws).propose()
    ClipService(ws).approve([first[0].id])
    out = apply_command(ws, CMD, {})
    assert out["ids"] == []
    ws.reload()
    assert [c.id for c in ws.project.social_clip_candidates] == [first[0].id]


def test_the_payload_refuses_a_non_positive_max():
    assert validate_payload(CMD, {})["max_clips"] is None
    with pytest.raises(ValidationError):
        validate_payload(CMD, {"max_clips": 0})


def test_the_command_is_host_only():
    assert CMD in HOST_ONLY_DOCUMENT_COMMANDS

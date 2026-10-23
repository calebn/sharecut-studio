"""Approving a cut reads only the local audio and the whole-track level profile.

A verdict that starts reading one of ``BLEED_PATH_READS`` fails here instead of silently
turning a local edit into a whole-track one.
"""

from __future__ import annotations

import traceback
from pathlib import Path
from unittest.mock import patch

import bleed_helpers as bh
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import cut_safety
from podcast_mcp.edits.cut_application import approve_edits
from podcast_mcp.edits.cut_proof import shared_timeline_rms_caches
from podcast_mcp.edits.transcript_cuts import append_remove_decision
from podcast_mcp.engines import track_evidence
from podcast_mcp.engines.audio_audit import TrackRmsCacheSet
from podcast_mcp.models import ClipMuteRegion, EpisodeProject

BLEED_PATH_READS = ("path_samples", "echo_pairs", "copy_path", "lane_lag_steps", "leak_paths")
MUTE = (50.45, 50.8)
CUT = (50.6, 51.1)


def _project(tmp_path: Path) -> EpisodeProject:
    """Three mics where each hears the others, caleb with an accepted mute inside the cut."""
    audio = bh.tracks(
        bleed={
            "caleb": {"audra": 0.005},
            "audra": {"caleb": 0.004},
            "lana": {"caleb": 0.006},
        }
    )
    project = bh.workspace(tmp_path, audio).project
    caleb = next(clip for clip in project.clips if clip.track_id == "caleb")
    caleb.mute_regions = [ClipMuteRegion(start_s=MUTE[0], end_s=MUTE[1])]
    append_remove_decision(
        project,
        "caleb",
        *CUT,
        decision_id="pause",
        review_required=False,
        defaults=load_defaults(),
    )
    return project


def _approve_reading(project: EpisodeProject) -> tuple[dict[str, list[str]], list[str]]:
    """Approve the cut; return who called each bleed-path read, and the evidence reads that ran."""
    reads: dict[str, list[str]] = {}
    tracks_heard: list[str] = []

    def spy(name: str):
        original = getattr(TrackRmsCacheSet, name)

        def spied(self, *args, **kwargs):
            frames = traceback.extract_stack()[:-1]
            reads.setdefault(name, []).append(
                " <- ".join(f"{f.name} ({Path(f.filename).name}:{f.lineno})" for f in frames[-4:])
            )
            return original(self, *args, **kwargs)

        return spied

    original_heard = track_evidence.heard

    def spied_heard(*args, **kwargs):
        tracks_heard.append(args[1])
        return original_heard(*args, **kwargs)

    defaults = load_defaults()
    with (
        patch.multiple(TrackRmsCacheSet, **{name: spy(name) for name in BLEED_PATH_READS}),
        patch.object(track_evidence, "heard", spied_heard),
    ):
        assert approve_edits(project, ["pause"], defaults=defaults) == 1
    return reads, tracks_heard


def test_approving_a_cut_never_reads_the_bleed_path(tmp_path):
    project = _project(tmp_path)

    reads, tracks_heard = _approve_reading(project)

    assert tracks_heard == ["caleb"]
    assert reads == {}, "a verdict on approve read the whole-track bleed path:\n" + "\n".join(
        f"{name}: {where[0]}" for name, where in reads.items()
    )


def test_the_scene_has_bleed_pairs_so_the_ledger_is_not_vacuous(tmp_path):
    project = _project(tmp_path)
    caches = shared_timeline_rms_caches(project, defaults=load_defaults())

    pairs = {(pair.source_track_id, pair.bleed_track_id) for pair in caches.echo_pairs()}

    assert ("caleb", "audra") in pairs and ("audra", "caleb") in pairs


def test_a_verdict_that_reads_the_bleed_path_fails_the_ledger(tmp_path):
    project = _project(tmp_path)
    real = cut_safety.observe_source_cut

    def reading(*args, **kwargs):
        caches = shared_timeline_rms_caches(args[0], defaults=load_defaults())
        caches.path_samples("caleb")
        caches.echo_pairs()
        caches.copy_path("caleb", "audra")
        caches.lane_lag_steps(args[0], "caleb")
        caches.leak_paths("audra")
        return real(*args, **kwargs)

    with patch.object(cut_safety, "observe_source_cut", reading):
        reads, _tracks_heard = _approve_reading(project)

    assert set(reads) == set(BLEED_PATH_READS)
    assert all("reading" in where[0] for where in reads.values())

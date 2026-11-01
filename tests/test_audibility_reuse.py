from __future__ import annotations

import copy
import json
import threading
from pathlib import Path
from typing import Any
from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.transcript_precorrect import run_precorrect_transcript
from podcast_mcp.engines import audio_audit
from podcast_mcp.engines.audibility_reuse import audibility_run_scope
from podcast_mcp.engines.audio_audit import (
    AnalysisPolicy,
    build_reconciliation_caches,
    compute_word_audibility_map,
)
from podcast_mcp.engines.transcript_reconcile import reconcile_transcript
from podcast_mcp.models import Clip, EpisodeProject, Track, TrackRole
from podcast_mcp.models.episode import SourceRecording
from test_transcript_reconcile import _echo_stem_project, _voice, _write_stem

DEFAULTS = load_defaults()
POLICY = AnalysisPolicy(transcript_mode="reconcile", bleed_text_match_enabled=True)


@pytest.fixture
def builds():
    real = audio_audit._measure_word_audibility
    calls: list[str | None] = []

    def spy(project, track_id, *args, **kwargs):
        calls.append(track_id)
        return real(project, track_id, *args, **kwargs)

    with patch.object(audio_audit, "_measure_word_audibility", spy):
        yield calls


def _map(project: EpisodeProject, policy: AnalysisPolicy = POLICY) -> list[dict[str, Any]]:
    caches = build_reconciliation_caches(project, defaults=DEFAULTS)
    return compute_word_audibility_map(project, policy=policy, caches=caches, defaults=DEFAULTS)


def _pipeline_consumers(project: EpisodeProject) -> dict[str, Any]:
    first = reconcile_transcript(
        project, policy=POLICY, dry_run=False, update_status=True, defaults=DEFAULTS
    )
    precorrect = run_precorrect_transcript(project, dry_run=False, policy=POLICY, defaults=DEFAULTS)
    second = reconcile_transcript(
        project, policy=POLICY, dry_run=False, update_status=True, defaults=DEFAULTS
    )
    return {
        "first": first.to_dict(),
        "precorrect": precorrect.to_dict(),
        "second": second.to_dict(),
        "transcripts": [json.loads(tr.model_dump_json()) for tr in project.transcripts],
        "combined": json.loads(project.combined_transcript.model_dump_json())
        if project.combined_transcript
        else None,
    }


def test_three_pipeline_consumers_build_the_map_once(tmp_path: Path, builds: list) -> None:
    project = _echo_stem_project(tmp_path)

    with audibility_run_scope():
        _pipeline_consumers(project)

    assert builds == [None]


def test_without_a_run_scope_every_consumer_builds(tmp_path: Path, builds: list) -> None:
    project = _echo_stem_project(tmp_path)

    _pipeline_consumers(project)

    assert len(builds) == 3


def test_outputs_are_byte_identical_with_and_without_the_run_scope(tmp_path: Path) -> None:
    plain = _echo_stem_project(tmp_path / "plain")
    shared = _echo_stem_project(tmp_path / "shared")

    expected = _pipeline_consumers(plain)
    with audibility_run_scope():
        actual = _pipeline_consumers(shared)

    def dumped(value: dict[str, Any], root: Path) -> str:
        return json.dumps(value, sort_keys=True).replace(str(root), "<ws>")

    assert dumped(actual, tmp_path / "shared") == dumped(expected, tmp_path / "plain")
    assert any(w["suppressed"] for w in actual["transcripts"][1]["words"])


def test_a_hit_returns_the_rows_a_fresh_build_returns(tmp_path: Path, builds: list) -> None:
    project = _echo_stem_project(tmp_path)

    with audibility_run_scope():
        first = _map(project)
        second = _map(project)
    fresh = _map(project)

    assert builds == [None, None]
    assert first == second == fresh


def test_changed_text_and_suppressed_flags_are_restamped_on_a_hit(
    tmp_path: Path, builds: list
) -> None:
    project = _echo_stem_project(tmp_path)

    with audibility_run_scope():
        before = _map(project)
        host = project.transcript_for_track("host")
        assert host is not None
        host.words[0] = host.words[0].model_copy(update={"text": "changed", "suppressed": True})
        after = _map(project)

    assert builds == [None]
    changed = next(r for r in after if r["track_id"] == "host" and r["word_index"] == 0)
    original = next(r for r in before if r["track_id"] == "host" and r["word_index"] == 0)
    assert (changed["text"], changed["suppressed"]) == ("changed", True)
    assert {**changed, "text": original["text"], "suppressed": original["suppressed"]} == original
    assert after == _map(project)


def test_a_moved_word_span_rebuilds(tmp_path: Path, builds: list) -> None:
    project = _echo_stem_project(tmp_path)

    with audibility_run_scope():
        _map(project)
        guest = project.transcript_for_track("guest")
        assert guest is not None
        guest.words[0] = guest.words[0].model_copy(update={"start": 11.05})
        moved = _map(project)

    assert builds == [None, None]
    assert moved == _map(project)


def test_a_changed_policy_rebuilds(tmp_path: Path, builds: list) -> None:
    project = _echo_stem_project(tmp_path)

    with audibility_run_scope():
        _map(project)
        _map(project, AnalysisPolicy(transcript_mode="reconcile", bleed_dominance_db=9.0))

    assert builds == [None, None]


def test_a_rewritten_audio_file_rebuilds(tmp_path: Path, builds: list) -> None:
    project = _echo_stem_project(tmp_path)

    with audibility_run_scope():
        first = _map(project)
        quieter = _voice(20.0, seed=3) * np.float32(0.1)
        _write_stem(tmp_path / "raw" / "guest.wav", quieter)
        _write_stem(project.artifacts_dir() / "tracks" / "guest.wav", quieter)
        second = _map(project)

    assert builds == [None, None]
    assert second != first
    assert second == _map(project)


def test_a_track_scoped_map_is_never_shared(tmp_path: Path, builds: list) -> None:
    project = _echo_stem_project(tmp_path)
    caches = build_reconciliation_caches(project, defaults=DEFAULTS)

    with audibility_run_scope():
        for _ in range(2):
            compute_word_audibility_map(
                project, track_id="host", policy=POLICY, caches=caches, defaults=DEFAULTS
            )

    assert builds == ["host", "host"]


def test_a_transcript_gated_project_is_never_shared(tmp_path: Path, builds: list) -> None:
    project = _echo_stem_project(tmp_path)
    track = project.track_by_id("host")
    assert track is not None
    track.transcript_gate = True

    with audibility_run_scope():
        caches = build_reconciliation_caches(project, defaults=DEFAULTS)
        assert caches.audio_identity is None
        _map(project)
        _map(project)

    assert builds == [None, None]


def test_consumers_cannot_change_what_the_run_keeps(tmp_path: Path, builds: list) -> None:
    project = _echo_stem_project(tmp_path)

    with audibility_run_scope():
        first = _map(project)
        pristine = copy.deepcopy(first)
        for row in first:
            row["audibility_status"] = "mutated"
            row["track_rms_db"]["host"] = 123.0
            row["text"] = "mutated"
        second = _map(project)
        for row in second:
            row["track_rms_db"].clear()
        third = _map(project)

    assert builds == [None]
    assert third == pristine


def test_the_map_is_not_shared_across_run_scopes(tmp_path: Path, builds: list) -> None:
    project = _echo_stem_project(tmp_path)

    with audibility_run_scope():
        _map(project)
    with audibility_run_scope():
        _map(project)

    assert builds == [None, None]


def test_a_nested_run_scope_shares_the_outer_one(tmp_path: Path, builds: list) -> None:
    project = _echo_stem_project(tmp_path)

    with audibility_run_scope():
        _map(project)
        with audibility_run_scope():
            _map(project)

    assert builds == [None]


def test_a_reader_with_different_defaults_builds_its_own_rows(tmp_path: Path, builds: list) -> None:
    project = _echo_stem_project(tmp_path)
    other = {**copy.deepcopy(DEFAULTS), "marker": 1}

    with audibility_run_scope():
        compute_word_audibility_map(
            project,
            policy=POLICY,
            caches=build_reconciliation_caches(project, defaults=DEFAULTS),
            defaults=DEFAULTS,
        )
        compute_word_audibility_map(
            project,
            policy=POLICY,
            caches=build_reconciliation_caches(project, defaults=other),
            defaults=other,
        )

    assert builds == [None, None]


def test_a_cache_set_that_fell_back_is_never_shared(tmp_path: Path, builds: list) -> None:
    project = _echo_stem_project(tmp_path)

    with audibility_run_scope():
        full = build_reconciliation_caches(project, defaults=DEFAULTS)
        assert full.audio_identity is not None
        with (
            patch.object(audio_audit, "_fresh_stem_path", return_value=None),
            patch.object(audio_audit, "raw_samples_on_timeline", side_effect=OSError("gone")),
        ):
            degraded = build_reconciliation_caches(project, defaults=DEFAULTS)
        assert degraded.audio_identity is None


def test_a_lane_timed_through_another_tracks_clip_is_never_shared(
    tmp_path: Path, builds: list
) -> None:
    project = _echo_stem_project(tmp_path)
    project.timeline.clips[:] = [c for c in project.timeline.clips if c.track_id != "guest"]
    project.timeline.tracks.append(Track(id="mus", label="mus", role=TrackRole.MUSIC))
    project.sources.append(SourceRecording(id="gsrc", path="raw/guest.wav"))
    moved = Clip(
        id="cm",
        track_id="mus",
        source_id="gsrc",
        source_start=0.0,
        source_end=20.0,
        timeline_start=0.0,
    )
    project.timeline.clips.append(moved)

    with audibility_run_scope():
        _map(project)
        moved.timeline_start = 1.5
        shared = _map(project)

    assert builds == [None, None]
    assert shared == _map(project)


def test_an_identity_that_cannot_be_read_degrades_the_set_instead_of_failing(
    tmp_path: Path,
) -> None:
    project = _echo_stem_project(tmp_path)

    with (
        audibility_run_scope(),
        patch.object(
            audio_audit.audibility_reuse, "audio_identity", side_effect=ValueError("duration")
        ),
    ):
        caches = build_reconciliation_caches(project, defaults=DEFAULTS)

    assert caches.audio_identity is None
    assert caches.caches


def test_defaults_holding_a_cancel_check_are_shared_without_copying(
    tmp_path: Path, builds: list
) -> None:
    project = _echo_stem_project(tmp_path)
    live = {**DEFAULTS, "_pipeline_cancel_check": threading.Event().is_set}

    with audibility_run_scope():
        for _ in range(2):
            compute_word_audibility_map(
                project,
                policy=POLICY,
                caches=build_reconciliation_caches(project, defaults=live),
                defaults=live,
            )

    assert builds == [None]

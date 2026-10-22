from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.cut_proof import shared_timeline_rms_caches
from podcast_mcp.engines.audio_audit import TrackRmsCache, TrackRmsCacheSet
from podcast_mcp.util.batch_scope import frozen_state


def test_shared_timeline_rms_caches_decodes_once_per_proof_block(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    builds: list[int] = []

    def fake_build(_project: object, **kwargs: object) -> TrackRmsCacheSet:
        builds.append(len(builds) + 1)
        return TrackRmsCacheSet(caches={"host": TrackRmsCache(samples=np.zeros(8))})

    monkeypatch.setattr(
        "podcast_mcp.edits.cut_proof.build_track_rms_caches",
        fake_build,
    )
    monkeypatch.setattr("podcast_mcp.edits.cut_proof.dialogue_track_ids", lambda _p: ["host"])
    project = SimpleNamespace()

    with frozen_state():
        first = shared_timeline_rms_caches(project, defaults=load_defaults())  # type: ignore[arg-type]
        again = shared_timeline_rms_caches(project, defaults=load_defaults())  # type: ignore[arg-type]
        assert builds == []  # nothing is decoded until a proof reads a track

        assert first.get("host") is again.get("host")

    assert first is again
    assert builds == [1]

    shared_timeline_rms_caches(project, defaults=load_defaults()).get("host")  # type: ignore[arg-type]
    assert builds == [1, 2]

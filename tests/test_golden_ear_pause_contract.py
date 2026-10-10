from __future__ import annotations

import wave

import pytest

from podcast_mcp.models import EditDecision, EditDecisionType
from podcast_mcp.project_store import ProjectStore
from podcast_mcp.services.document import EditService
from podcast_mcp.services.document.golden_ear import (
    _equalize_clip_lengths,
    build_golden_ear,
    copy_relocated_project,
)
from test_golden_ear_harness import FIXTURE, _wav_pcm


@pytest.mark.parametrize("short_first", [False, True])
def test_equalize_owner_preserves_pcm_in_both_argument_orders(tmp_path, short_first):
    short, long = tmp_path / "short.wav", tmp_path / "long.wav"
    short_pcm = b"\x20\x01\xe0\xfe" * 4_000
    long_pcm = b"\x40\x02\xc0\xfd" * 8_000
    for path, pcm in ((short, short_pcm), (long, long_pcm)):
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(16_000)
            handle.writeframes(pcm)
    assert _wav_pcm(short) == (8_000, 2, short_pcm)
    assert _wav_pcm(long) == (16_000, 2, long_pcm)
    paths = (short, long) if short_first else (long, short)
    assert _equalize_clip_lengths(*paths) is True
    assert _wav_pcm(short) == (16_000, 2, short_pcm + b"\0" * 16_000)
    assert _wav_pcm(long) == (16_000, 2, long_pcm)


@pytest.mark.parametrize(
    ("cut_sec", "pad_sec", "cause"),
    [(0.4, 0.6, "pause_imperceptible"), (2.0, None, "pause_imperceptible")],
)
def test_golden_build_refuses_invalid_pause_without_changing_source(
    tmp_path, monkeypatch, cut_sec, pad_sec, cause
):
    from podcast_mcp.edits.source_removals import ScopeChangedAtApproval

    source = copy_relocated_project(FIXTURE, tmp_path / "source")
    store = ProjectStore(source)
    project = store.load()
    project.edit_decisions = [
        EditDecision(
            id="invalid-pause",
            track_id="reference",
            type=EditDecisionType.REMOVE,
            start=14,
            end=14 + cut_sec,
            reason="pause:2.00s",
            applied=False,
            replace_gap_sec=pad_sec,
        )
    ]
    store.commit(project)
    before = source.read_bytes()
    monkeypatch.setattr(EditService, "propose_tighten", lambda self, **kwargs: [])
    with pytest.raises(ScopeChangedAtApproval) as held:
        build_golden_ear(source, tmp_path / "invalid-golden", limit=1, seed=0, classes="pause")
    assert held.value.held[0].reason == cause
    assert source.read_bytes() == before
    assert [row.id for row in store.load().edit_decisions] == ["invalid-pause"]

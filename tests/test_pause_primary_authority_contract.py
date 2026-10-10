from __future__ import annotations

import os

import numpy as np
import pytest

from pause_policy_public_helpers import (
    configure,
    defaults,
    files,
    pause,
    project,
    room,
    voice,
    workspace,
    write_wav,
)
from podcast_mcp.engines.timeline_render import render_track_from_timeline
from podcast_mcp.models import (
    Clip,
    MediaAsset,
    SourceRecording,
    Track,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.services.document import EditService
from podcast_mcp.util.wav import open_wav


def _unrelated_transcript_first(result, tmp_path, *, has_after):
    write_wav(tmp_path / "raw/unrelated.wav", room(seed=1927))
    result.sources.append(SourceRecording(id="unrelated", path="raw/unrelated.wav", duration_sec=6))
    words = [TranscriptWord(text="foreign-before", start=0, end=0.2)]
    if has_after:
        words.append(TranscriptWord(text="foreign-after", start=5, end=5.2))
    result.transcripts.insert(0, Transcript(track_id="host", source_id="unrelated", words=words))


@pytest.mark.parametrize("explicit_first", [False, True])
def test_saved_clean_primary_pause_uses_own_flanks(tmp_path, monkeypatch, explicit_first):
    cfg = defaults(acoustic=False)
    configure(monkeypatch, cfg)
    result = project(tmp_path)
    result.edit_decisions = [pause("primary", start=0.3, end=4.7, gap=None)]
    if explicit_first:
        _unrelated_transcript_first(result, tmp_path, has_after=False)
    ws = workspace(result)
    assert EditService(ws).approve(["primary"]) == 1
    assert ws.project.edit_decisions == []
    assert len(ws.project.editorial.edit_log) == 1


@pytest.mark.parametrize("explicit_first", [False, True])
def test_saved_primary_pause_retains_literal_air_between_its_real_words(
    tmp_path, monkeypatch, explicit_first
):
    cfg = defaults(acoustic=False)
    configure(monkeypatch, cfg)
    result = project(tmp_path)
    samples = room()
    for start, end in [(0, 0.2), (1, 1.2), (5, 5.2)]:
        voice(samples, start, end)
    write_wav(tmp_path / "raw/host.wav", samples)
    result.transcripts[0].words = [
        TranscriptWord(text="real-before", start=0, end=0.2),
        TranscriptWord(text="real-after", start=1, end=1.2),
        TranscriptWord(text="later", start=5, end=5.2),
    ]
    result.edit_decisions = [pause("primary", start=0.3, end=0.9, gap=None)]
    if explicit_first:
        _unrelated_transcript_first(result, tmp_path, has_after=True)
    ws = workspace(result)
    assert EditService(ws).approve(["primary"]) == 1
    kept_original_air = sum(
        max(0.0, min(clip.source_end, 1.0) - max(clip.source_start, 0.2))
        for clip in ws.project.clips
        if clip.track_id == "host" and clip.source_id is None
    )
    assert kept_original_air >= 0.55 - 1e-6
    record = ws.project.editorial.edit_log[0]
    assert record.source_end > record.source_start
    assert record.params["loss_sec"] > 0
    assert record.params["replace_gap_sec"] is None
    assert record.params["pad_samples"] == []


@pytest.mark.parametrize("parked_alias", [False, True])
def test_saved_pause_shifts_actual_implicit_peer_playback_or_holds_atomically(
    tmp_path, monkeypatch, parked_alias
):
    from podcast_mcp.edits.source_removals import ScopeChangedAtApproval

    cfg = defaults(acoustic=False)
    configure(monkeypatch, cfg)
    result = project(tmp_path)
    peer_audio = room(seed=1928)
    voice(peer_audio, 0, 0.2)
    voice(peer_audio, 5, 5.2)
    write_wav(tmp_path / "raw/peer.wav", peer_audio)
    os.link(tmp_path / "raw/peer.wav", tmp_path / "raw/peer-alias.wav")
    write_wav(tmp_path / "raw/parking.wav", room(seconds=7, seed=1929))
    result.tracks += [
        Track(id="peer", label="Peer", media=MediaAsset(path="raw/peer.wav", duration_sec=6)),
        Track(
            id="parking", label="Parking", media=MediaAsset(path="raw/parking.wav", duration_sec=7)
        ),
    ]
    result.sources.append(
        SourceRecording(id="peer-alias", path="raw/peer-alias.wav", duration_sec=6)
    )
    if parked_alias:
        result.clips.append(
            Clip(
                id="parked-peer-air",
                track_id="parking",
                source_id="peer-alias",
                source_start=1,
                source_end=2,
                timeline_start=6,
            )
        )
    result.transcripts.append(
        Transcript(
            track_id="peer",
            words=[
                TranscriptWord(text="peer-before", start=0, end=0.2),
                TranscriptWord(text="peer-after", start=5, end=5.2),
            ],
        )
    )
    result.edit_decisions = [pause("primary", start=0.3, end=4.7, gap=None)]
    ws = workspace(result)

    def render_samples(name):
        path = render_track_from_timeline(
            ws.project, ws.project.track_by_id("peer"), tmp_path / name, cfg
        )
        with open_wav(path) as stream:
            assert stream.getsampwidth() == 2
            return stream.getframerate(), np.frombuffer(
                stream.readframes(stream.getnframes()), dtype="<i2"
            ).reshape(-1, stream.getnchannels())

    rate, before = render_samples("implicit-before.wav")
    original_word = before[round(5.05 * rate) : round(5.19 * rate)]
    assert np.max(np.abs(original_word.astype(np.int32))) > 1000
    assert not [clip for clip in ws.project.clips if clip.track_id == "peer"]
    assert ws.project.track_by_id("peer").timeline_empty is False
    saved_bytes = ws.path.read_bytes()
    before_model = ws.project.model_dump(mode="json")
    before_files = files(tmp_path)
    if parked_alias:
        with pytest.raises(ScopeChangedAtApproval):
            EditService(ws).approve(["primary"])
        assert ws.path.read_bytes() == saved_bytes
        assert ws.project.model_dump(mode="json") == before_model
        assert files(tmp_path) == before_files
        return
    assert EditService(ws).approve(["primary"]) == 1
    record = ws.project.editorial.edit_log[0]
    loss = record.params["loss_sec"]
    assert loss > 0
    after_rate, after = render_samples("implicit-after.wav")
    assert after_rate == rate
    shifted_word = after[round((5.05 - loss) * rate) : round((5.19 - loss) * rate)]
    np.testing.assert_array_equal(shifted_word, original_word)


@pytest.mark.parametrize("primary_is_filler", [False, True])
def test_public_proposal_collects_primary_words_and_skips_foreign_source_words(
    tmp_path, monkeypatch, primary_is_filler
):
    cfg = defaults(acoustic=False)
    cfg["tighten"].update(
        filler_words=["um"],
        isolated_filler_candidates=True,
        min_filler_cluster=1,
        max_pause_sec=99,
    )
    configure(monkeypatch, cfg)
    result = project(tmp_path)
    samples = room()
    for start, end in [(0, 0.2), (1, 1.2), (5, 5.2)]:
        voice(samples, start, end)
    write_wav(tmp_path / "raw/host.wav", samples)
    result.transcripts[0].words = [
        TranscriptWord(text="before", start=0, end=0.2),
        TranscriptWord(text="um" if primary_is_filler else "keep", start=1, end=1.2),
        TranscriptWord(text="after", start=5, end=5.2),
    ]
    write_wav(tmp_path / "raw/unrelated.wav", room(seed=1930))
    result.sources.append(SourceRecording(id="unrelated", path="raw/unrelated.wav", duration_sec=6))
    result.transcripts.insert(
        0,
        Transcript(
            track_id="host",
            source_id="unrelated",
            words=[
                TranscriptWord(text="foreign-before", start=0, end=0.2),
                TranscriptWord(text="other" if primary_is_filler else "um", start=1, end=1.2),
                TranscriptWord(text="foreign-after", start=5, end=5.2),
            ],
        ),
    )
    ws = workspace(result)
    before_clips = [clip.model_dump(mode="json") for clip in ws.project.clips]
    proposal = EditService(ws).propose_tighten(intensity="medium")
    filler_decisions = [
        decision for decision in proposal.decisions if decision.reason.startswith("filler:um")
    ]
    assert bool(filler_decisions) is primary_is_filler
    assert all(
        decision.track_id == "host" and not decision.applied for decision in filler_decisions
    )
    assert [clip.model_dump(mode="json") for clip in ws.project.clips] == before_clips
    assert ws.project.editorial.edit_log == []


def test_intentionally_empty_peer_with_parked_alias_still_approves_and_shifts_actual_pcm(
    tmp_path, monkeypatch
):
    cfg = defaults(acoustic=False)
    configure(monkeypatch, cfg)
    result = project(tmp_path)
    samples = room(seed=1931)
    voice(samples, 0, 0.2)
    voice(samples, 5, 5.2)
    write_wav(tmp_path / "raw/peer.wav", samples)
    os.link(tmp_path / "raw/peer.wav", tmp_path / "raw/peer-alias.wav")
    write_wav(tmp_path / "raw/parking.wav", room(seed=1932))
    result.tracks += [
        Track(
            id="peer",
            label="Peer",
            media=MediaAsset(path="raw/peer.wav", duration_sec=6),
            timeline_empty=True,
        ),
        Track(
            id="parking", label="Parking", media=MediaAsset(path="raw/parking.wav", duration_sec=6)
        ),
    ]
    result.sources.append(
        SourceRecording(id="peer-alias", path="raw/peer-alias.wav", duration_sec=6)
    )
    result.clips.append(
        Clip(
            id="parked-peer",
            track_id="parking",
            source_id="peer-alias",
            source_start=0,
            source_end=6,
            timeline_start=0,
        )
    )
    words = [
        TranscriptWord(text="peer-before", start=0, end=0.2),
        TranscriptWord(text="peer-after", start=5, end=5.2),
    ]
    result.transcripts += [
        Transcript(track_id="peer", words=words),
        Transcript(track_id="parking", source_id="peer-alias", words=words),
    ]
    result.edit_decisions = [pause("primary", start=0.3, end=4.7, gap=None)]
    ws = workspace(result)

    def render_samples(name):
        path = render_track_from_timeline(
            ws.project, ws.project.track_by_id("parking"), tmp_path / name, cfg
        )
        with open_wav(path) as stream:
            assert stream.getsampwidth() == 2
            return stream.getframerate(), np.frombuffer(
                stream.readframes(stream.getnframes()), dtype="<i2"
            ).reshape(-1, stream.getnchannels())

    rate, before = render_samples("intentional-empty-before.wav")
    original_word = before[round(5.05 * rate) : round(5.19 * rate)]
    assert np.max(np.abs(original_word.astype(np.int32))) > 1000
    assert EditService(ws).approve(["primary"]) == 1
    loss = ws.project.editorial.edit_log[0].params["loss_sec"]
    assert loss > 0
    assert ws.project.track_by_id("peer").timeline_empty is True
    assert not [clip for clip in ws.project.clips if clip.track_id == "peer"]
    after_rate, after = render_samples("intentional-empty-after.wav")
    assert after_rate == rate
    shifted_word = after[round((5.05 - loss) * rate) : round((5.19 - loss) * rate)]
    np.testing.assert_array_equal(shifted_word, original_word)

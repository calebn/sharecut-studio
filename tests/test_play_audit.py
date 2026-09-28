from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.engines.play_audit import (
    changed_render_hashes,
    clear_invalidations_if_current,
    dialogue_render_hashes,
    expected_stem_duration_sec,
    mix_render_hash,
    probe_wav_duration_sec,
    stem_duration_matches_timeline,
    stem_fingerprint,
    stem_is_fresh,
    stem_matches,
    track_render_hash,
    write_stem_hash,
)
from podcast_mcp.engines.reconciliation_state import audio_state_fingerprint
from podcast_mcp.engines.render_invalidations import record_invalidation
from podcast_mcp.models import (
    AutomationEnvelope,
    AutomationPoint,
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
)


def test_envelope_ids_do_not_change_audio_hashes(tmp_path) -> None:
    project = EpisodeProject.create("envelope", str(tmp_path))
    project.timeline.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE))
    project.automation_envelopes = [
        AutomationEnvelope(
            track_id="host",
            points=[AutomationPoint(id="first", time=0.0, value=1.0)],
        )
    ]
    render_hash = track_render_hash(project, "host")
    reconciliation_hash = audio_state_fingerprint(project)
    project.automation_envelopes[0].points[0] = AutomationPoint(id="second", time=0.0, value=1.0)
    assert track_render_hash(project, "host") == render_hash
    assert audio_state_fingerprint(project) == reconciliation_hash
    project.automation_envelopes[0].points[0].value = 0.5
    assert track_render_hash(project, "host") != render_hash
    assert audio_state_fingerprint(project) != reconciliation_hash


def test_track_render_hash_changes_with_edit(tmp_path) -> None:
    ws = tmp_path / "ws"
    ws.mkdir()
    project = EpisodeProject.create("h", str(ws))
    project.timeline.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    )
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        )
    ]
    h1 = track_render_hash(project, "host")
    project.edit_decisions.append(
        EditDecision(
            id="e1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.0,
            end=2.0,
            applied=True,
        )
    )
    h2 = track_render_hash(project, "host")
    assert h1 != h2


def test_track_render_hash_changes_with_join_mode(tmp_path) -> None:
    from podcast_mcp.models import ClipJoinMode

    ws = tmp_path / "ws_join"
    ws.mkdir()
    project = EpisodeProject.create("join", str(ws))
    project.timeline.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE))
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=5.0,
            timeline_start=0.0,
            fade_out_ms=10,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=5.0,
            source_end=10.0,
            timeline_start=5.0,
            fade_in_ms=10,
            join_in_mode=ClipJoinMode.FADE,
        ),
    ]
    h1 = track_render_hash(project, "host")
    project.clips[1].join_in_mode = ClipJoinMode.CROSSFADE
    h2 = track_render_hash(project, "host")
    assert h1 != h2


def test_track_render_hash_changes_with_effect_bypass(tmp_path) -> None:
    from podcast_mcp.models import ProcessingChain, ProcessingEffect

    ws = tmp_path / "ws_bypass"
    ws.mkdir()
    project = EpisodeProject.create("bypass", str(ws))
    project.timeline.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE))
    project.mix.processing_chains = [
        ProcessingChain(
            track_id="host",
            effects=[
                ProcessingEffect(effect="highpass", params={"frequency": 80}),
            ],
        )
    ]
    h1 = track_render_hash(project, "host")
    project.processing_chains[0].effects[0].bypass = True
    h2 = track_render_hash(project, "host")
    assert h1 != h2


def test_stem_fresh_after_write(tmp_path, sample_wav) -> None:
    ws = tmp_path / "ws2"
    ws.mkdir()
    (ws / "artifacts" / "tracks").mkdir(parents=True)
    project = EpisodeProject.create("h2", str(ws))
    project.timeline.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE))
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    ]
    stem = ws / "artifacts" / "tracks" / "host.wav"
    stem.write_bytes(sample_wav.read_bytes())
    write_stem_hash(project, "host")
    assert stem_is_fresh(project, "host")


def test_stem_not_fresh_when_duration_mismatches(tmp_path, sample_wav) -> None:
    ws = tmp_path / "ws3"
    ws.mkdir()
    (ws / "artifacts" / "tracks").mkdir(parents=True)
    project = EpisodeProject.create("h3", str(ws))
    project.timeline.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE))
    # Timeline extent ~1s, stem is ~2s (source-length bug).
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=0.0,
        )
    ]
    stem = ws / "artifacts" / "tracks" / "host.wav"
    stem.write_bytes(sample_wav.read_bytes())
    write_stem_hash(project, "host")
    assert not stem_is_fresh(project, "host")
    assert expected_stem_duration_sec(project, "host") == pytest.approx(1.0)
    assert not stem_duration_matches_timeline(project, "host")


def test_track_render_hash_includes_render_semantics_rev(tmp_path, sample_wav, monkeypatch) -> None:
    """A renderer semantics bump must stale stems (and segment-cache keys) with no edit."""
    import podcast_mcp.engines.play_audit as play_audit
    from podcast_mcp.engines.timeline_render import RENDER_SEMANTICS_REV

    ws = tmp_path / "ws_rev"
    (ws / "artifacts" / "tracks").mkdir(parents=True)
    project = EpisodeProject.create("rev", str(ws))
    project.timeline.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE))
    project.timeline.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=2.0, timeline_start=0.0)
    ]
    (ws / "artifacts" / "tracks" / "host.wav").write_bytes(sample_wav.read_bytes())
    write_stem_hash(project, "host")
    before = track_render_hash(project, "host")
    assert stem_is_fresh(project, "host")

    monkeypatch.setattr(play_audit, "RENDER_SEMANTICS_REV", RENDER_SEMANTICS_REV + 1)

    assert track_render_hash(project, "host") != before
    assert not stem_is_fresh(project, "host")


def test_track_render_hash_ignores_clip_list_order(tmp_path) -> None:
    project = EpisodeProject.create("order", str(tmp_path))
    project.timeline.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE))
    first = Clip(id="a", track_id="host", source_start=0.0, source_end=1.0, timeline_start=0.0)
    second = Clip(id="b", track_id="host", source_start=2.0, source_end=3.0, timeline_start=1.0)
    project.timeline.clips = [first, second]
    in_order = track_render_hash(project, "host")

    project.timeline.clips = [second, first]

    assert track_render_hash(project, "host") == in_order


def test_clear_invalidations_if_current_keeps_an_edit_made_meanwhile(tmp_path) -> None:
    project = EpisodeProject.create("inv", str(tmp_path))
    project.timeline.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE))
    snapshot = project.model_copy(deep=True)
    record_invalidation(project, track_ids=["host"])
    edited = project.model_copy(deep=True)
    edited.track_by_id("host").gain_db = 3.0
    assert clear_invalidations_if_current(project, snapshot, "host", current=edited) is False
    assert len(project.render.invalidations) == 1
    assert clear_invalidations_if_current(project, snapshot, "host") is True
    assert project.render.invalidations == []
    assert clear_invalidations_if_current(project, snapshot, "host") is False


def test_mix_render_hash_includes_mix_semantics_rev(monkeypatch) -> None:
    """A mix semantics bump re-mixes premixes summed the old way."""
    import podcast_mcp.engines.play_audit as play_audit
    from podcast_mcp.engines.ffmpeg import MIX_SEMANTICS_REV

    before = mix_render_hash({"host": 0.0})
    monkeypatch.setattr(play_audit, "MIX_SEMANTICS_REV", MIX_SEMANTICS_REV + 1)
    assert mix_render_hash({"host": 0.0}) != before
    assert mix_render_hash({"host": 0.0}, -1.0) != mix_render_hash({"host": 0.0}, -2.0)
    assert mix_render_hash({"host": 0.0}) == mix_render_hash({"host": 0.0}, -1.0)


def test_reconciliation_fingerprint_ignores_music_envelopes(tmp_path) -> None:
    project = EpisodeProject.create("fp_music", str(tmp_path))
    project.timeline.tracks += [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE),
        Track(id="bed", label="Bed", role=TrackRole.MUSIC),
    ]
    before = audio_state_fingerprint(project)
    project.automation_envelopes = [
        AutomationEnvelope(
            track_id="bed",
            points=[AutomationPoint(time=0.0, value=0.0), AutomationPoint(time=2.0, value=1.0)],
        )
    ]
    assert audio_state_fingerprint(project) == before
    project.automation_envelopes.append(
        AutomationEnvelope(track_id="host", points=[AutomationPoint(time=0.0, value=0.5)])
    )
    assert audio_state_fingerprint(project) != before


def test_wav_duration_probe_is_cached_per_file_revision(tmp_path, sample_wav, monkeypatch) -> None:
    import os

    from podcast_mcp.engines.ffmpeg import AudioProbe, FFmpegEngine

    wav = tmp_path / "stem.wav"
    wav.write_bytes(sample_wav.read_bytes())
    calls: list[Path] = []

    def fake(self, path, **_k):
        calls.append(path)
        return AudioProbe(duration_sec=2.0, sample_rate=48000, channels=1)

    monkeypatch.setattr(FFmpegEngine, "probe", fake)

    assert probe_wav_duration_sec(wav) == 2.0
    assert probe_wav_duration_sec(wav) == 2.0
    assert len(calls) == 1

    st = wav.stat()
    os.utime(wav, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))

    assert probe_wav_duration_sec(wav) == 2.0
    assert len(calls) == 2


def test_failed_wav_duration_probe_is_not_cached(tmp_path, sample_wav, monkeypatch) -> None:
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    wav = tmp_path / "stem.wav"
    wav.write_bytes(sample_wav.read_bytes())
    calls: list[Path] = []

    def fake(self, path, **_k):
        calls.append(path)
        raise RuntimeError("probe failed")

    monkeypatch.setattr(FFmpegEngine, "probe", fake)

    assert probe_wav_duration_sec(wav) is None
    assert probe_wav_duration_sec(wav) is None
    assert len(calls) == 2


def test_render_status_reuses_the_stem_probe(tmp_path, sample_wav, monkeypatch) -> None:
    from podcast_mcp.engines.ffmpeg import AudioProbe, FFmpegEngine
    from podcast_mcp.engines.render_status import render_status_report

    ws = tmp_path / "ws"
    (ws / "artifacts" / "tracks").mkdir(parents=True)
    project = EpisodeProject.create("reuse", str(ws))
    project.timeline.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE))
    project.timeline.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=2.0, timeline_start=0.0)
    ]
    stem = ws / "artifacts" / "tracks" / "host.wav"
    stem.write_bytes(sample_wav.read_bytes())
    write_stem_hash(project, "host")
    calls: list[Path] = []

    def fake(self, path, **_k):
        calls.append(path)
        return AudioProbe(duration_sec=2.0, sample_rate=48000, channels=1)

    monkeypatch.setattr(FFmpegEngine, "probe", fake)

    report1 = render_status_report(project)
    report2 = render_status_report(project)

    assert report1["tracks"]["host"]["stem_is_fresh"] is True
    assert report2["tracks"]["host"]["stem_is_fresh"] is True
    assert len(calls) == 1


def test_stem_matches_uses_the_fingerprint_not_the_live_project(tmp_path, sample_wav) -> None:
    ws = tmp_path / "ws"
    (ws / "artifacts" / "tracks").mkdir(parents=True)
    project = EpisodeProject.create("fp", str(ws))
    project.timeline.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE))
    project.timeline.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=2.0, timeline_start=0.0)
    ]
    stem = ws / "artifacts" / "tracks" / "host.wav"
    stem.write_bytes(sample_wav.read_bytes())
    write_stem_hash(project, "host")
    assert stem_is_fresh(project, "host")

    fp = stem_fingerprint(project, "host")

    project.clips[0].source_end = 1.0
    assert stem_matches(project, "host", fp) is True
    assert stem_is_fresh(project, "host") is False

    fp2 = stem_fingerprint(project, "host")
    assert stem_matches(project, "host", fp2) is False


def test_changed_render_hashes() -> None:
    before = {"a": "1", "b": "2"}
    after = {"a": "1", "b": "3", "c": "4"}
    assert changed_render_hashes(before, after) == ["b", "c"]


def test_reconciliation_fingerprint_accepts_precomputed_render_hashes(tmp_path) -> None:
    project = EpisodeProject.create("fp", str(tmp_path))
    project.timeline.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE))
    project.timeline.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=2.0, timeline_start=0.0)
    ]
    assert audio_state_fingerprint(project, dialogue_render_hashes(project)) == (
        audio_state_fingerprint(project)
    )

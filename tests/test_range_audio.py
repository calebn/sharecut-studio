from __future__ import annotations

import array
import math
import subprocess
import wave

import pytest

from podcast_mcp.edits.range_edits import range_geometry, range_media_seal
from podcast_mcp.models import Clip, MediaAsset, Track
from podcast_mcp.models.episode import ExactRangeTarget, RangeInterval
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import PlayService
from podcast_mcp.services.media.bounce import BounceRequest, BounceService


def seed(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    raw = ws.project.workspace_path() / "raw" / "tone.wav"
    raw.parent.mkdir(exist_ok=True)
    samples = array.array(
        "h", (int(8000 * math.sin(2 * math.pi * 440 * i / 48000)) for i in range(6 * 48000))
    )
    with wave.open(str(raw), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(48000)
        audio.writeframes(samples.tobytes())
    ws.project.tracks = [Track(id="a", label="A", media=MediaAsset(path="raw/tone.wav"))]
    ws.project.clips = [
        Clip(id="a-full", track_id="a", source_start=0, source_end=6, timeline_start=0)
    ]
    ws.project.timeline.duration_sec = 6
    spans = [RangeInterval(start=1, end=2), RangeInterval(start=4, end=5)]
    target = ExactRangeTarget(
        intervals=spans,
        track_ids=["a"],
        clips=range_geometry(ws.project, spans, ["a"]),
        media_seals={"a": range_media_seal(ws.project, "a")},
    )
    return ws, target, raw


def pcm(path):
    from podcast_mcp.util.binaries import resolve_ffmpeg

    decoded = subprocess.run(
        [
            resolve_ffmpeg(),
            "-v",
            "error",
            "-i",
            str(path),
            "-f",
            "s16le",
            "-ac",
            "1",
            "-ar",
            "48000",
            "pipe:1",
        ],
        check=True,
        capture_output=True,
    )
    samples = array.array("h")
    samples.frombytes(decoded.stdout)
    return samples


@pytest.mark.parametrize("action", ["play", "bounce", "guest_play"])
def test_exact_audio_preserves_duration_and_silent_unselected_gap(minimal_project, action):
    ws, target, raw = seed(minimal_project)
    if action == "bounce":
        output = BounceService(ws).bounce(BounceRequest(exact_range=target))[0]
    else:
        output = PlayService(ws).play_selected_range(
            target, full_mix_path=raw if action == "guest_play" else None
        )
    samples = pcm(output)
    assert len(samples) == 4 * 48000
    assert max(abs(v) for v in samples[4800:43200]) > 1000
    assert max(abs(v) for v in samples[48000 : 3 * 48000]) == 0
    assert max(abs(v) for v in samples[3 * 48000 + 4800 : 4 * 48000 - 4800]) > 1000


def test_concurrent_host_and_guest_previews_keep_separate_pcm(minimal_project, tmp_path):
    from concurrent.futures import ThreadPoolExecutor

    ws, target, raw = seed(minimal_project)
    mix = tmp_path / "full-mix.wav"
    with wave.open(str(raw), "rb") as source:
        frames = array.array("h")
        frames.frombytes(source.readframes(source.getnframes()))
    with wave.open(str(mix), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(48000)
        output.writeframes(array.array("h", (int(v * 1.5) for v in frames)).tobytes())
    play = PlayService(ws)
    with ThreadPoolExecutor(max_workers=2) as pool:
        host_job = pool.submit(play.play_selected_range, target)
        guest_job = pool.submit(play.play_selected_range, target, full_mix_path=mix)
        host, guest = host_job.result(), guest_job.result()
    assert host != guest
    assert "selected-tracks" in host.name
    assert "full-mix" in guest.name
    assert 7000 < max(abs(v) for v in pcm(host)[:48000]) < 9000
    assert 11000 < max(abs(v) for v in pcm(guest)[:48000]) < 13000
    before = host.read_bytes()
    again = play.play_selected_range(target, full_mix_path=mix)
    assert again not in {host, guest}
    assert host.read_bytes() == before


@pytest.mark.parametrize("moved", [False, True])
def test_full_cut_retains_authoritative_extent_in_full_stem(minimal_project, tmp_path, moved):
    from podcast_mcp.config import load_defaults
    from podcast_mcp.edits.range_edits import edit_selected_range
    from podcast_mcp.engines.timeline_render import render_track_from_timeline
    from podcast_mcp.models import load_project, save_project

    ws, _target, _raw = seed(minimal_project)
    ws.project.tracks[0].media.duration_sec = 6
    ws.project.timeline.duration_sec = None
    if moved:
        ws.project.clips[0].timeline_start = 10
        spans = [RangeInterval(start=10, end=16)]
        duration = 16
    else:
        ws.project.clips = []
        spans = [RangeInterval(start=0, end=6)]
        duration = 6
    selection = ExactRangeTarget(
        intervals=spans,
        track_ids=["a"],
        clips=range_geometry(ws.project, spans, ["a"]),
        media_seals={"a": range_media_seal(ws.project, "a")},
    )
    edit_selected_range(
        ws.project, selection, "cut", propose=False, reason="host:range", action_id="full-cut"
    )
    save_project(ws.project)
    project = load_project(minimal_project)
    rendered = render_track_from_timeline(
        project, project.tracks[0], tmp_path / "empty.wav", load_defaults()
    )
    samples = pcm(rendered)
    assert len(samples) == duration * 48000
    assert max(abs(v) for v in samples) == 0
    assert project.timeline.duration_sec == duration
    bounce = BounceService(ProjectWorkspace.open(minimal_project)).bounce()[0]
    assert len(pcm(bounce)) == duration * 48000


def test_exact_pending_preview_invalidates_after_peer_mix_change(minimal_project):
    from podcast_mcp.edits.range_edits import edit_selected_range, range_is_current

    ws, target, _raw = seed(minimal_project)
    ws.project.tracks.append(Track(id="b", label="B", media=MediaAsset(path="raw/tone.wav")))
    ws.project.clips.append(
        Clip(id="b-full", track_id="b", source_start=0, source_end=6, timeline_start=0)
    )
    edit_selected_range(
        ws.project, target, "cut", propose=True, reason="guest:suggest", action_id="proposal"
    )
    play = PlayService(ws)
    first = play.play_pending_preview("proposal", pad_sec=0, dry_run=True).wav_path
    before = pcm(first)
    ws.project.tracks[1].fader_db = -20
    assert range_is_current(ws.project, target)
    assert play.pending_preview_cached_wav("proposal", pad_sec=0) is None
    second = play.play_pending_preview("proposal", pad_sec=0, dry_run=True).wav_path
    assert first != second
    after = pcm(second)
    assert max(abs(v) for v in before[:48000]) > 7000
    assert max(abs(v) for v in after[:48000]) < 900
    assert play.pending_preview_cached_wav("proposal", pad_sec=0) == second


@pytest.mark.parametrize("mode", ["current", "suggested", "ab"])
def test_exact_pending_preview_rejects_isolated_source_before_play_or_cache(minimal_project, mode):
    from unittest.mock import patch

    from podcast_mcp.edits.range_edits import edit_selected_range

    ws, target, _raw = seed(minimal_project)
    edit_selected_range(
        ws.project, target, "cut", propose=True, reason="guest:suggest", action_id="proposal"
    )
    play = PlayService(ws)
    with patch.object(play, "play") as current:
        with pytest.raises(ValueError, match="full mix"):
            play.play_pending_preview("proposal", mode=mode, source="track:a", dry_run=True)
        current.assert_not_called()
    with pytest.raises(ValueError, match="full mix"):
        play.pending_preview_cached_wav("proposal", mode=mode, source="track:a")


def test_range_play_and_bounce_apply_staging_gain_and_fader_once(minimal_project):
    ws, target, _raw = seed(minimal_project)
    ws.project.tracks[0].gain_db = -6
    ws.project.tracks[0].fader_db = -6
    play = pcm(PlayService(ws).play_selected_range(target))
    bounced = pcm(BounceService(ws).bounce(BounceRequest(exact_range=target))[0])
    assert len(play) == len(bounced) == 4 * 48000
    assert 1950 < max(abs(v) for v in play[:48000]) < 2050
    assert 1950 < max(abs(v) for v in bounced[:48000]) < 2050


@pytest.mark.parametrize("mode,duration", [("suggested", 4), ("ab", 8.4)])
def test_exact_pending_all_muted_mix_is_duration_correct_silence(minimal_project, mode, duration):
    from podcast_mcp.edits.range_edits import edit_selected_range

    ws, target, _raw = seed(minimal_project)
    ws.project.tracks[0].muted = True
    edit_selected_range(
        ws.project, target, "cut", propose=True, reason="guest:range", action_id="silent"
    )
    output = (
        PlayService(ws).play_pending_preview("silent", mode=mode, pad_sec=0, dry_run=True).wav_path
    )
    samples = pcm(output)
    assert len(samples) == round(duration * 48000)
    assert max(abs(v) for v in samples) == 0


@pytest.mark.parametrize(
    "caps,stale,expected",
    [(["view"], False, 200), (["play", "comment"], False, 403), (["view"], True, 400)],
)
def test_guest_range_http_requires_view_and_returns_full_mix(
    minimal_project, monkeypatch, caps, stale, expected
):
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.models import save_project
    from podcast_mcp.services.collaboration.review import ReviewService
    from podcast_mcp.services.collaboration.share import ShareService

    ws, target, raw = seed(minimal_project)
    save_project(ws.project)
    from podcast_mcp.engines.play_audit import publish_stem

    publish_stem(ws.project, "a", lambda output: output.write_bytes(raw.read_bytes()))
    mix = ws.project.artifacts_dir() / "premix.wav"
    mix.parent.mkdir(parents=True, exist_ok=True)
    mix.write_bytes(raw.read_bytes())
    monkeypatch.setenv("PODCAST_REMOTE_MCP", "1")
    version = ReviewService(ws).publish(label="range-test")
    share = ShareService(ws).create(
        review_version_id=version["id"], public_base_url="https://share.example", capabilities=caps
    )
    if stale:
        ws.project.tracks[0].fader_db = -6
        save_project(ws.project)
    response = TestClient(create_app()).post(
        f"/api/review/{share['token']}/daw/range-audio",
        json={"action": "play", "target": target.model_dump(mode="json")},
    )
    assert response.status_code == expected, (
        response.text if expected != 200 else response.status_code
    )
    if expected == 200:
        assert response.headers["content-type"] == "audio/wav"
        returned = raw.parent / "returned.wav"
        returned.write_bytes(response.content)
        assert len(pcm(returned)) == 4 * 48000
    elif stale:
        assert "Mix out of date" in response.text

from __future__ import annotations

import hashlib
import importlib.util
import shutil
import sys
import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits.range_edits import build_range_target
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.timeline_render import render_track_segment
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, SourceRecording, Track
from podcast_mcp.models.episode import RangeInterval
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "lab_bleed"
_MANIFEST_SPEC = importlib.util.spec_from_file_location(
    "lab_bleed_manifest", FIXTURE_DIR / "manifest.py"
)
assert _MANIFEST_SPEC is not None and _MANIFEST_SPEC.loader is not None
_MANIFEST_MODULE = importlib.util.module_from_spec(_MANIFEST_SPEC)
sys.modules[_MANIFEST_SPEC.name] = _MANIFEST_MODULE
_MANIFEST_SPEC.loader.exec_module(_MANIFEST_MODULE)
CASES = _MANIFEST_MODULE.CASES
CLIP_PADDING_SEC = _MANIFEST_MODULE.CLIP_PADDING_SEC


def decoded_pcm(path: Path, output: Path) -> tuple[np.ndarray, int, int]:
    FFmpegEngine().extract_segment(path, output, 0.0, 10_000.0)
    with wave.open(str(output), "rb") as audio:
        frames = audio.getnframes()
        rate = audio.getframerate()
        channels = audio.getnchannels()
        samples = np.frombuffer(audio.readframes(frames), dtype="<i2").reshape(frames, channels)
    return samples, rate, channels


def pcm_digest(samples: np.ndarray) -> str:
    return hashlib.sha256(samples.astype("<i2", copy=False).tobytes()).hexdigest()


def read_pcm(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as audio:
        return np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2").reshape(-1, 2)


def make_workspace(tmp_path: Path) -> ProjectWorkspace:
    project = EpisodeProject.create("lab bleed fixtures", str(tmp_path))
    project.ensure_dirs()
    for case in CASES:
        for track_id, audio in case["audio"].items():
            raw = tmp_path / "raw" / audio["file"]
            shutil.copyfile(FIXTURE_DIR / audio["file"], raw)
            source_id = f"{case['name']}_{track_id}"
            if not any(track.id == track_id for track in project.tracks):
                project.tracks.append(
                    Track(
                        id=track_id,
                        label=track_id.title(),
                        media=MediaAsset(
                            path=f"raw/{audio['file']}",
                            duration_sec=audio["frames"] / audio["sample_rate"],
                            sample_rate=audio["sample_rate"],
                            channels=audio["channels"],
                        ),
                    )
                )
            project.sources.append(
                SourceRecording(
                    id=source_id,
                    path=f"raw/{audio['file']}",
                    speaker=track_id,
                    label=case["name"],
                    duration_sec=audio["frames"] / audio["sample_rate"],
                    sample_rate=audio["sample_rate"],
                    channels=audio["channels"],
                )
            )
            project.clips.append(
                Clip(
                    id=source_id,
                    track_id=track_id,
                    source_id=source_id,
                    source_start=0.0,
                    source_end=audio["frames"] / audio["sample_rate"],
                    timeline_start=case["historical_reviewed_timeline_interval"][0]
                    - CLIP_PADDING_SEC,
                )
            )
        project.timeline.duration_sec = max(
            project.timeline.duration_sec or 0.0,
            case["historical_reviewed_timeline_interval"][1] + CLIP_PADDING_SEC,
        )
    ws = ProjectWorkspace(tmp_path / "episode.project.json", project)
    ws.save()
    return ws


def render(
    ws: ProjectWorkspace, track_id: str, start: float, end: float, output: Path
) -> np.ndarray:
    render_track_segment(ws.project, track_id, start, end, output, {})
    return read_pcm(output)


def host_approve(path: Path, decision_id: str):
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    return TestClient(create_app()).post(
        "/api/document/command",
        params={"path": str(path)},
        json={
            "type": "ApproveEdits",
            "payload": {"ids": [decision_id]},
            "client_id": "fixture-reviewer",
            "role": "viewer",
            "client_seq": 1,
        },
    )


@pytest.mark.parametrize(
    ("case", "track_id", "audio"),
    [(case, track, audio) for case in CASES for track, audio in case["audio"].items()],
    ids=[f"{case['name']}-{track}" for case in CASES for track in case["audio"]],
)
def test_committed_clip_hash_native_format_and_nonzero_pcm(
    tmp_path: Path, case: dict, track_id: str, audio: dict
) -> None:
    path = FIXTURE_DIR / audio["file"]
    assert hashlib.sha256(path.read_bytes()).hexdigest() == audio["file_sha256"]
    samples, rate, channels = decoded_pcm(path, tmp_path / "decoded.wav")
    assert (
        (rate, channels, len(samples))
        == (
            audio["sample_rate"],
            audio["channels"],
            audio["frames"],
        )
        == (
            48000,
            2,
            round(
                (case["source_interval"][1] - case["source_interval"][0] + 2 * CLIP_PADDING_SEC)
                * 48000
            ),
        )
    )
    assert pcm_digest(samples) == audio["pcm_sha256"]
    assert np.any(samples)


@pytest.mark.parametrize(
    "case", [case for case in CASES if case["mute"] is not None], ids=lambda case: case["name"]
)
def test_pending_then_host_approved_mute_changes_only_reviewed_caleb_scope(
    tmp_path: Path, case: dict
) -> None:
    ws = make_workspace(tmp_path)
    start, end = case["historical_reviewed_timeline_interval"]
    padding = CLIP_PADDING_SEC
    before_path = tmp_path / "before.wav"
    before = render(ws, "caleb", start - padding, end + padding, before_path)
    assert np.any(before)
    peers_before = {
        track_id: render(
            ws, track_id, start - padding, end + padding, tmp_path / f"{track_id}-before.wav"
        )
        for track_id in case["tracks"]
        if track_id != "caleb"
    }
    direct_before = render(ws, "caleb", 100.0, 103.0, tmp_path / "direct-before.wav")
    raw_hashes = {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (tmp_path / "raw").glob("*.flac")
    }

    target = build_range_target(
        ws.project,
        [RangeInterval(start=start, end=end)],
        ["caleb"],
    )
    action_id = f"lab-bleed-{case['name']}"
    EditService(ws).edit_selected_range(
        target,
        "mute",
        propose=True,
        reason="owner-reviewed fixture scope",
        action_id=action_id,
    )
    pending = ProjectWorkspace.open(ws.path)
    pending_pcm = render(pending, "caleb", start - padding, end + padding, tmp_path / "pending.wav")
    np.testing.assert_array_equal(pending_pcm, before)
    assert not any(clip.mute_regions for clip in pending.project.clips)
    np.testing.assert_array_equal(
        render(pending, "caleb", 100.0, 103.0, tmp_path / "direct-pending.wav"), direct_before
    )

    response = host_approve(ws.path, action_id)
    assert response.status_code == 200, response.text
    applied = ProjectWorkspace.open(ws.path)
    after = render(applied, "caleb", start - padding, end + padding, tmp_path / "after.wav")
    first = round(padding * 48000)
    selected_frames = round((end - start) * 48000)
    fade_frames = round(0.005 * 48000)
    assert np.any(np.concatenate((before[:first], before[first + selected_frames :])))
    np.testing.assert_array_equal(after[:first], before[:first])
    np.testing.assert_array_equal(
        after[first + fade_frames : first + selected_frames - fade_frames], 0
    )
    np.testing.assert_array_equal(
        after[first + selected_frames :], before[first + selected_frames :]
    )
    fade_in_gain = 1 - np.arange(fade_frames) / fade_frames
    fade_out_gain = np.arange(fade_frames) / fade_frames
    expected_fade_in = np.rint(before[first : first + fade_frames] * fade_in_gain[:, None])
    expected_fade_out = np.rint(
        before[first + selected_frames - fade_frames : first + selected_frames]
        * fade_out_gain[:, None]
    )
    assert (
        np.max(
            np.abs(
                after[first : first + fade_frames].astype(np.int32)
                - expected_fade_in.astype(np.int32)
            )
        )
        <= 1
    )
    assert (
        np.max(
            np.abs(
                after[first + selected_frames - fade_frames : first + selected_frames].astype(
                    np.int32
                )
                - expected_fade_out.astype(np.int32)
            )
        )
        <= 1
    )
    for track_id, peer_before in peers_before.items():
        peer_after = render(
            applied, track_id, start - padding, end + padding, tmp_path / f"{track_id}-after.wav"
        )
        np.testing.assert_array_equal(peer_after, peer_before)
    np.testing.assert_array_equal(
        render(applied, "caleb", 100.0, 103.0, tmp_path / "direct-after.wav"), direct_before
    )
    assert raw_hashes == {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (tmp_path / "raw").glob("*.flac")
    }

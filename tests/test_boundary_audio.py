"""Real PCM checks for unsaved, rendered boundary auditions."""

from __future__ import annotations

import hashlib
import math
import struct
import wave
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlparse

import pytest
from fastapi.testclient import TestClient
from filelock import Timeout

from podcast_mcp.config import load_defaults, mix_peak_ceiling_db
from podcast_mcp.edits.timeline_ops import roll_clip_join
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.play_audit import mix_gains, write_premix_hash
from podcast_mcp.engines.timeline_render import render_track_from_timeline
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import (
    ArchivedTranscriptWord,
    Clip,
    ClipJoinMode,
    MediaAsset,
    ProcessingChain,
    ProcessingEffect,
    SourceRecording,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.services.app.workspace import ProjectWorkspace
from podcast_mcp.services.document import PlayService
from podcast_mcp.services.document.boundary import (
    RollBoundaryEdit,
    RollBoundaryTarget,
    boundary_context,
)
from podcast_mcp.services.document_sync.errors import DocumentConflictError
from podcast_mcp.services.review import ReviewService
from podcast_mcp.services.share import ShareService


def _tone(path: Path, frequency: float, *, loud_prefix: bool = False) -> None:
    rate = 48_000
    samples = [
        int(
            (30_000 if loud_prefix and n < rate // 4 else 11_000)
            * math.sin(2 * math.pi * frequency * n / rate)
        )
        for n in range(2 * rate)
    ]
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(struct.pack(f"<{len(samples)}h", *samples))


def _samples(path: Path) -> tuple[int, ...]:
    with wave.open(str(path), "rb") as wav:
        raw = wav.readframes(wav.getnframes())
    return struct.unpack(f"<{len(raw) // 2}h", raw)


def _project(path: Path, *, loud_outside: bool = False, fader_db: float = -3) -> ProjectWorkspace:
    ws = ProjectWorkspace.open(path)
    raw = ws.project.workspace_path() / "raw"
    _tone(raw / "host.wav", 443, loud_prefix=loud_outside)
    _tone(raw / "other.wav", 659)
    ws.project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2),
            gain_db=2,
            fader_db=fader_db,
        )
    ]
    ws.project.sources = [SourceRecording(id="other", path="raw/other.wav", duration_sec=2)]
    ws.project.processing_chains = [
        ProcessingChain(
            track_id="host",
            effects=[ProcessingEffect(effect="highpass", params={"frequency": 80})],
        )
    ]
    ws.project.clips = [
        Clip(
            id="left",
            track_id="host",
            source_start=0,
            source_end=1.2,
            timeline_start=0,
            fade_out_ms=700,
        ),
        Clip(
            id="right",
            track_id="host",
            source_id="other",
            source_start=0.2,
            source_end=1.4,
            timeline_start=1.2,
            fade_in_ms=700,
            join_in_mode=ClipJoinMode.CROSSFADE,
        ),
    ]
    ws.save()
    return ws


def _id(url: str) -> str:
    return urlparse(url).path.split("/")[-2]


def _full_track_samples(project, out: Path) -> tuple[int, ...]:
    stem = out.with_name(f"{out.stem}_stem.wav")
    track = project.track_by_id("host")
    assert track is not None
    defaults = load_defaults()
    render_track_from_timeline(project, track, stem, defaults)
    FFmpegEngine().mix_tracks(
        [(stem, track.output_gain_db)], out, peak_ceiling_db=mix_peak_ceiling_db(defaults)
    )
    return _samples(out)


def test_boundary_audio_is_real_unsaved_crossfade_and_stale_safe(minimal_project: Path) -> None:
    ws = _project(minimal_project)
    target = RollBoundaryTarget(left_clip_id="left", right_clip_id="right")
    token = boundary_context(ws.project, target).token
    project_before = minimal_project.read_bytes()
    history_index = ws.project.history_dir() / "index.json"
    history_before = history_index.read_bytes() if history_index.is_file() else None

    service = PlayService(ws)
    pair = service.audition_boundary(
        target,
        RollBoundaryEdit(left_clip_id="left", right_clip_id="right", delta_sec=0.1),
        token,
    )
    current = service.boundary_audio_path(_id(pair.current.url), "current", token)
    proposed = service.boundary_audio_path(_id(pair.proposed.url), "proposed", token)
    assert pair.actual_edit.delta_sec == pytest.approx(0.1)
    assert pair.current.seam_offset_sec == pytest.approx(0.75)
    assert pair.proposed.seam_offset_sec == pytest.approx(0.75)
    assert current.is_file() and proposed.is_file()
    assert not list((ws.project.artifacts_dir() / "play_cache").glob("boundary_full_*.wav"))
    a, b = _samples(current), _samples(proposed)
    around = slice(30_000, 42_000)
    assert sum(abs(x - y) for x, y in zip(a[around], b[around], strict=True)) > 100_000
    # The crossfade, both recording clocks, and the fader agree with a complete
    # committed-track render at the seam, even though the draft is never saved.
    saved = ProjectWorkspace.open(minimal_project).project
    draft = saved.model_copy(deep=True)
    roll_clip_join(draft, "left", "right", 0.1)
    full_current = _full_track_samples(saved, ws.project.artifacts_dir() / "full_current.wav")
    full_proposed = _full_track_samples(draft, ws.project.artifacts_dir() / "full_proposed.wav")
    for window, heard, full in (
        (pair.current, a, full_current),
        (pair.proposed, b, full_proposed),
    ):
        offset = round(window.window_start_sec * 48_000)
        seam = round(window.seam_offset_sec * 48_000)
        segment = slice(seam - 5_000, seam + 5_000)
        reference = full[offset + segment.start : offset + segment.stop]
        assert len(reference) == segment.stop - segment.start
        assert max(abs(x - y) for x, y in zip(heard[segment], reference, strict=True)) < 100
    assert minimal_project.read_bytes() == project_before
    assert (history_index.read_bytes() if history_index.is_file() else None) == history_before

    other = ProjectWorkspace.open(minimal_project)
    other.project.clips[0].source_end = 1.25
    other.save()
    with pytest.raises(DocumentConflictError):
        service.boundary_audio_path(_id(pair.current.url), "current", token)


def test_boundary_cache_distinguishes_sub_centisecond_windows(minimal_project: Path) -> None:
    ws = _project(minimal_project)
    service = PlayService(ws)
    token = hashlib.sha256(b"cache-test").hexdigest()
    first = service._boundary_render(ws.project, "host", token, "current", 0.4500, 1.9500)
    second = service._boundary_render(ws.project, "host", token, "current", 0.4505, 1.9505)
    assert first != second


def test_outside_window_peak_controls_the_heard_seam_gain(minimal_project: Path) -> None:
    ws = _project(minimal_project, loud_outside=True, fader_db=6)
    target = RollBoundaryTarget(left_clip_id="left", right_clip_id="right")
    token = boundary_context(ws.project, target).token
    pair = PlayService(ws).audition_boundary(
        target,
        RollBoundaryEdit(left_clip_id="left", right_clip_id="right", delta_sec=0.1),
        token,
    )
    heard = _samples(PlayService(ws).boundary_audio_path(_id(pair.current.url), "current", token))
    full = _full_track_samples(ws.project, ws.project.artifacts_dir() / "loud_full.wav")
    seam = round(pair.current.seam_offset_sec * 48_000)
    offset = round(pair.current.window_start_sec * 48_000)
    heard_window = heard[seam - 4_000 : seam + 4_000]
    full_window = full[offset + seam - 4_000 : offset + seam + 4_000]
    assert max(abs(a - b) for a, b in zip(heard_window, full_window, strict=True)) < 100


def test_edit_landing_during_render_cannot_issue_stale_audio(
    minimal_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _project(minimal_project)
    target = RollBoundaryTarget(left_clip_id="left", right_clip_id="right")
    token = boundary_context(ws.project, target).token
    service = PlayService(ws)
    render = service._boundary_render
    landed = False

    def edit_after_first_render(*args, **kwargs):
        nonlocal landed
        result = render(*args, **kwargs)
        if not landed:
            landed = True
            other = ProjectWorkspace.open(minimal_project)
            other.project.clips[0].source_end = 1.25
            other.save()
        return result

    monkeypatch.setattr(service, "_boundary_render", edit_after_first_render)
    with pytest.raises(DocumentConflictError):
        service.audition_boundary(
            target,
            RollBoundaryEdit(left_clip_id="left", right_clip_id="right", delta_sec=0.1),
            token,
        )


def test_proposed_audio_mutes_restored_archived_ignored_word(minimal_project: Path) -> None:
    ws = _project(minimal_project)
    ws.project.transcripts = [
        Transcript(
            track_id="host",
            archived_words=[
                ArchivedTranscriptWord(
                    ordinal=0,
                    word=TranscriptWord(text="discard", start=1.21, end=1.27, ignored=True),
                )
            ],
        )
    ]
    ws.save()
    target = RollBoundaryTarget(left_clip_id="left", right_clip_id="right")
    token = boundary_context(ws.project, target).token
    service = PlayService(ws)
    pair = service.audition_boundary(
        target,
        RollBoundaryEdit(left_clip_id="left", right_clip_id="right", delta_sec=0.1),
        token,
    )
    heard = _samples(service.boundary_audio_path(_id(pair.proposed.url), "proposed", token))

    restored = ws.project.model_copy(deep=True)
    roll_clip_join(restored, "left", "right", 0.1)
    assert [(word.text, word.ignored) for word in restored.transcripts[0].words] == [
        ("discard", True)
    ]
    full_muted = _full_track_samples(restored, ws.project.artifacts_dir() / "restored_ignored.wav")
    audible = restored.model_copy(deep=True)
    audible.transcripts[0].words[0].ignored = False
    full_audible = _full_track_samples(audible, ws.project.artifacts_dir() / "restored_audible.wav")
    begin = round(1.22 * 48_000)
    end = round(1.26 * 48_000)
    assert (
        sum(abs(a - b) for a, b in zip(full_muted[begin:end], full_audible[begin:end], strict=True))
        > 100_000
    )
    offset = round(pair.proposed.window_start_sec * 48_000)
    heard_span = heard[begin - offset : end - offset]
    assert max(abs(a - b) for a, b in zip(heard_span, full_muted[begin:end], strict=True)) < 100


def test_host_routes_stream_issued_range_and_reject_stale_geometry(
    minimal_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _project(minimal_project)
    target = RollBoundaryTarget(left_clip_id="left", right_clip_id="right")
    geometry = [item.model_dump() for item in boundary_context(ws.project, target).geometry]
    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict")
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", "boundary-host-token")
    with TestClient(create_app(served_project=minimal_project)) as client:
        body = {
            "path": str(minimal_project),
            "target": target.model_dump(),
            "expected_geometry": geometry,
        }
        assert client.post("/api/boundary/context", json=body).status_code == 403
        stale = client.post(
            "/api/boundary/context?token=boundary-host-token",
            json={**body, "expected_geometry": []},
        )
        assert stale.status_code == 409
        context = client.post("/api/boundary/context?token=boundary-host-token", json=body)
        assert context.status_code == 200
        revision = context.json()["token"]
        audition = client.post(
            "/api/boundary/audition?token=boundary-host-token",
            json={
                "path": str(minimal_project),
                "target": target.model_dump(),
                "edit": RollBoundaryEdit(
                    left_clip_id="left", right_clip_id="right", delta_sec=0.1
                ).model_dump(),
                "expected_token": revision,
                "pad_sec": 0.75,
            },
        )
        assert audition.status_code == 200
        url = audition.json()["proposed"]["url"]
        assert client.get(url, headers={"Range": "bytes=0-127"}).status_code == 403
        audio = client.get(f"{url}&token=boundary-host-token", headers={"Range": "bytes=0-127"})
        assert audio.status_code == 206
        assert audio.headers["content-range"].startswith("bytes 0-127/")
        assert len(audio.content) == 128


def test_busy_boundary_render_uses_project_busy_response(
    minimal_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _project(minimal_project)
    target = RollBoundaryTarget(left_clip_id="left", right_clip_id="right")
    revision = boundary_context(ws.project, target).token

    @contextmanager
    def busy(*_args, **_kwargs):
        raise Timeout("held-render-lock")
        yield

    monkeypatch.setattr("podcast_mcp.services.document.play.render_lock", busy)
    with TestClient(create_app(served_project=minimal_project)) as client:
        response = client.post(
            "/api/boundary/audition",
            json={
                "path": str(minimal_project),
                "target": target.model_dump(),
                "edit": RollBoundaryEdit(
                    left_clip_id="left", right_clip_id="right", delta_sec=0.1
                ).model_dump(),
                "expected_token": revision,
            },
        )
    assert response.status_code == 503
    assert response.headers["x-sharecut-error-code"] == "project_busy"


def test_edit_share_gets_guarded_context(
    minimal_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PODCAST_EXTENSIONS", "collaboration")
    ws = _project(minimal_project)
    premix = ws.project.artifacts_dir() / "premix.wav"
    premix.write_bytes((ws.project.workspace_path() / "raw" / "host.wav").read_bytes())
    write_premix_hash(ws.project, mix_gains(ws.project))
    version = ReviewService(ws).publish(label="boundary-share")
    view = ShareService(ws).create(review_version_id=version["id"], capabilities=["view"])
    edit = ShareService(ws).create(review_version_id=version["id"], capabilities=["view", "edit"])
    target = RollBoundaryTarget(left_clip_id="left", right_clip_id="right")
    geometry = [item.model_dump() for item in boundary_context(ws.project, target).geometry]
    body = {"target": target.model_dump(), "expected_geometry": geometry}
    with TestClient(create_app()) as client:
        denied = client.post(f"/api/review/{view['token']}/daw/boundary/context", json=body)
        allowed = client.post(f"/api/review/{edit['token']}/daw/boundary/context", json=body)
        stale = client.post(
            f"/api/review/{edit['token']}/daw/boundary/context",
            json={**body, "expected_geometry": []},
        )
    assert denied.status_code == 403
    assert allowed.status_code == 200
    assert allowed.json()["token"]
    assert stale.status_code == 409

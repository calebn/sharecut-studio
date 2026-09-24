from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from unittest.mock import patch

from podcast_mcp.engines.peaks import (
    PEAKS_FFMPEG_TIMEOUT_SEC,
    ensure_track_peaks,
    generate_peaks,
    peaks_generation_pending,
    schedule_track_peaks,
    wait_peaks_jobs,
    write_silent_peaks,
)
from podcast_mcp.models import MediaAsset, Track
from podcast_mcp.services.peaks import lookup_track_peaks, peaks_unavailable_body
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.util.timeline_zoom import overview_bins_per_sec, overview_decode_hz


def test_ensure_track_peaks_skips_unsafe_id(minimal_project, sample_wav):
    ws = ProjectWorkspace.open(minimal_project)
    raw = Path(ws.project.workspace_dir) / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "import.wav"
    dest.write_bytes(Path(sample_wav).read_bytes())
    track = Track(
        id="../evil",
        label="Evil",
        media=MediaAsset(path="raw/import.wav", duration_sec=1.0),
    )
    assert ensure_track_peaks(ws.project, track) is None
    escaped = (ws.project.artifacts_dir() / "peaks").resolve().parent.parent / "evil.json"
    assert not escaped.exists()
    peaks_dir = ws.project.artifacts_dir() / "peaks"
    assert not peaks_dir.exists() or not any(peaks_dir.iterdir())


def test_ensure_track_peaks_skips_outward_symlink(minimal_project, sample_wav, tmp_path):
    ws = ProjectWorkspace.open(minimal_project)
    raw = ws.project.workspace_path() / "raw"
    raw.mkdir(exist_ok=True)
    (raw / "import.wav").write_bytes(sample_wav.read_bytes())
    peaks = ws.project.artifacts_dir() / "peaks"
    peaks.mkdir(parents=True, exist_ok=True)
    (peaks / "host.json").symlink_to(tmp_path / "outside.json")
    track = Track(id="host", label="Host", media=MediaAsset(path="raw/import.wav"))
    assert ensure_track_peaks(ws.project, track) is None
    assert not (tmp_path / "outside.json").exists()


def test_generate_peaks_uint8_overview_and_timeout(tmp_path, sample_wav):
    out = tmp_path / "peaks.json"
    path = generate_peaks(Path(sample_wav), out)
    assert path == out
    assert out.is_file()
    assert not (tmp_path / ".peaks.json.tmp").exists()
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert isinstance(payload.get("peaks"), list)
    assert payload.get("encoding") == "uint8"
    assert payload.get("sample_rate") == overview_decode_hz()
    assert abs(float(payload["bins_per_sec"]) - overview_bins_per_sec()) < 1e-6
    assert payload.get("peaks")
    assert all(isinstance(v, int) and 0 <= v <= 255 for v in payload["peaks"])

    with patch("podcast_mcp.engines.peaks.run") as run:
        run.return_value.stdout = b""
        generate_peaks(Path(sample_wav), tmp_path / "other.json")
        assert run.call_args.kwargs["timeout"] == PEAKS_FFMPEG_TIMEOUT_SEC
        cmd = run.call_args.args[0]
        assert cmd[cmd.index("-threads") + 1] == "1"


def test_ensure_track_peaks_skips_rewrite_when_bins_match(minimal_project, sample_wav):
    ws = ProjectWorkspace.open(minimal_project)
    raw = Path(ws.project.workspace_dir) / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "import.wav"
    dest.write_bytes(Path(sample_wav).read_bytes())
    track = Track(
        id="host",
        label="Host",
        media=MediaAsset(path="raw/import.wav", duration_sec=1.0),
    )
    first = ensure_track_peaks(ws.project, track)
    assert first is not None and first.is_file()
    mtime = first.stat().st_mtime_ns
    with patch("podcast_mcp.engines.peaks.generate_peaks") as gen:
        again = ensure_track_peaks(ws.project, track)
        gen.assert_not_called()
    assert again == first
    assert first.stat().st_mtime_ns == mtime


def test_ensure_track_peaks_rewrites_when_media_mtime_changes(minimal_project, sample_wav):
    ws = ProjectWorkspace.open(minimal_project)
    raw = Path(ws.project.workspace_dir) / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "import.wav"
    dest.write_bytes(Path(sample_wav).read_bytes())
    track = Track(
        id="host",
        label="Host",
        media=MediaAsset(path="raw/import.wav", duration_sec=1.0),
    )
    first = ensure_track_peaks(ws.project, track)
    assert first is not None
    os.utime(dest, (0, time.time() + 10))
    with patch("podcast_mcp.engines.peaks.generate_peaks") as gen:
        gen.side_effect = lambda *a, **k: first
        ensure_track_peaks(ws.project, track)
        gen.assert_called_once()


def test_schedule_track_peaks_does_not_block(minimal_project, sample_wav):
    ws = ProjectWorkspace.open(minimal_project)
    raw = Path(ws.project.workspace_dir) / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "import.wav"
    dest.write_bytes(Path(sample_wav).read_bytes())
    track = Track(
        id="host",
        label="Host",
        media=MediaAsset(path="raw/import.wav", duration_sec=1.0),
    )

    def _slow(*_a, **_k):
        time.sleep(0.4)
        return dest

    with patch("podcast_mcp.engines.peaks.generate_peaks", side_effect=_slow):
        t0 = time.monotonic()
        schedule_track_peaks(ws.project, track)
        assert time.monotonic() - t0 < 0.2
        wait_peaks_jobs()


def test_payload_bins_per_sec_falls_back_to_rate_and_spp():
    from podcast_mcp.engines.peaks import _payload_bins_per_sec

    assert _payload_bins_per_sec({"bins_per_sec": 16}) == 16.0
    assert _payload_bins_per_sec({"sample_rate": 8000, "samples_per_pixel": 500}) == 16.0
    assert _payload_bins_per_sec({}) is None


def test_shutdown_peaks_pool_is_idempotent():
    from podcast_mcp.engines.peaks import _peaks_pool, _shutdown_peaks_pool

    _peaks_pool()
    _shutdown_peaks_pool()
    _shutdown_peaks_pool()


def test_write_silent_peaks_is_current_for_its_source(tmp_path):
    audio = tmp_path / "silent.wav"
    audio.write_bytes(b"RIFF")
    out = write_silent_peaks(audio, tmp_path / "peaks" / "silent.json", 2.0)
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["source"] == str(audio)
    assert payload["source_size"] == 4
    assert payload["bins_per_sec"] == overview_bins_per_sec()
    assert payload["peaks"] == [0] * int(2.0 * overview_bins_per_sec())


def test_write_silent_peaks_records_source_override(tmp_path):
    audio = tmp_path / "staging.wav"
    audio.write_bytes(b"RIFF")
    final = tmp_path / "final" / "raw.wav"
    out = write_silent_peaks(audio, tmp_path / "silent.json", 1.0, source=final)
    assert json.loads(out.read_text(encoding="utf-8"))["source"] == str(final)


def test_schedule_track_peaks_dedupes_pending_jobs(minimal_project, sample_wav):
    ws = ProjectWorkspace.open(minimal_project)
    raw = Path(ws.project.workspace_dir) / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "import.wav"
    dest.write_bytes(Path(sample_wav).read_bytes())
    track = Track(
        id="host",
        label="Host",
        media=MediaAsset(path="raw/import.wav", duration_sec=1.0),
    )

    release = threading.Event()
    calls = []

    def _blocked(*a, **k):
        calls.append(1)
        release.wait(timeout=5)
        return dest

    with patch("podcast_mcp.engines.peaks.generate_peaks", side_effect=_blocked):
        assert peaks_generation_pending(ws.project, track) is False
        first = schedule_track_peaks(ws.project, track)
        second = schedule_track_peaks(ws.project, track)
        assert first is True
        assert second is True
        assert peaks_generation_pending(ws.project, track) is True
        release.set()
        wait_peaks_jobs()

    assert len(calls) == 1
    assert peaks_generation_pending(ws.project, track) is False


def test_schedule_track_peaks_remembers_failed_source(minimal_project, sample_wav):
    ws = ProjectWorkspace.open(minimal_project)
    raw = Path(ws.project.workspace_dir) / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "import.wav"
    dest.write_bytes(Path(sample_wav).read_bytes())
    track = Track(
        id="host",
        label="Host",
        media=MediaAsset(path="raw/import.wav", duration_sec=1.0),
    )

    with patch("podcast_mcp.engines.peaks.generate_peaks", side_effect=RuntimeError("boom")):
        scheduled = schedule_track_peaks(ws.project, track)
        assert scheduled is True
        wait_peaks_jobs()

    with patch("podcast_mcp.engines.peaks.generate_peaks") as gen:
        retried = schedule_track_peaks(ws.project, track)
        assert retried is False
        gen.assert_not_called()

    os.utime(dest, (0, time.time() + 10))
    with patch("podcast_mcp.engines.peaks.generate_peaks") as gen:
        gen.side_effect = lambda *a, **k: dest
        retried_after_change = schedule_track_peaks(ws.project, track)
        assert retried_after_change is True
        wait_peaks_jobs()
        gen.assert_called_once()


def test_schedule_track_peaks_no_media_gives_false(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    track = Track(id="host", label="Host")
    assert schedule_track_peaks(ws.project, track) is False
    assert peaks_generation_pending(ws.project, track) is False


def test_lookup_track_peaks_states(minimal_project, sample_wav):
    ws = ProjectWorkspace.open(minimal_project)
    raw = Path(ws.project.workspace_dir) / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "import.wav"
    dest.write_bytes(Path(sample_wav).read_bytes())
    track = Track(
        id="host",
        label="Host",
        media=MediaAsset(path="raw/import.wav", duration_sec=1.0),
    )
    ws.project.tracks.append(track)

    unknown = lookup_track_peaks(ws.project, "nonexistent")
    assert unknown.path is None
    assert unknown.generating is False

    release = threading.Event()
    real_generate_peaks = generate_peaks

    def _delayed(*a, **k):
        release.wait(timeout=5)
        return real_generate_peaks(*a, **k)

    with patch("podcast_mcp.engines.peaks.generate_peaks", side_effect=_delayed):
        first = lookup_track_peaks(ws.project, "host")
        assert first.path is None
        assert first.generating is True

        pending = lookup_track_peaks(ws.project, "host")
        assert pending.path is None
        assert pending.generating is True

        release.set()
        wait_peaks_jobs()

    ready = lookup_track_peaks(ws.project, "host")
    assert ready.path is not None
    assert ready.path.is_file()
    assert ready.generating is False


def test_peaks_unavailable_body_shape():
    assert peaks_unavailable_body("host", generating=True) == {
        "available": False,
        "track_id": "host",
        "generating": True,
    }
    assert peaks_unavailable_body("host", generating=False) == {
        "available": False,
        "track_id": "host",
        "generating": False,
    }

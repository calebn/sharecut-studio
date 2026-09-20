from __future__ import annotations

import subprocess
from pathlib import Path

from podcast_mcp.engines.session_clock import (
    estimate_session_start_in_file,
    file_time_for_session,
    first_speech_onset_sec,
)
from podcast_mcp.ingest.consolidate import consolidate_speakers
from podcast_mcp.ingest.manifest import IngestManifest


def _tone(path: Path, duration: float = 2.0) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:duration={duration}",
            "-ac",
            "1",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


def test_file_time_for_session() -> None:
    assert file_time_for_session(10.0, 960.0, 4.0) == 966.0


def test_estimate_session_start_late_recorder(tmp_path: Path) -> None:
    ref = tmp_path / "ref.wav"
    late = tmp_path / "late.wav"
    _tone(ref)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=duration=5",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:duration=2",
            "-filter_complex",
            "[0:a][1:a]concat=n=2:v=0:a=1[out]",
            "-map",
            "[out]",
            str(late),
        ],
        check=True,
        capture_output=True,
    )
    onset_ref = first_speech_onset_sec(ref, search_start_sec=0, search_end_sec=10)
    onset_late = first_speech_onset_sec(late, search_start_sec=0, search_end_sec=10)
    assert onset_ref is not None and onset_late is not None
    delay = estimate_session_start_in_file(ref, late, session_hint_sec=0)
    assert delay >= 4.0


def test_consolidate_uses_session_start_in_file(sample_wav: Path, tmp_path: Path) -> None:
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    ref = audio_dir / "host.wav"
    guest = audio_dir / "guest.wav"
    ref.write_bytes(sample_wav.read_bytes())
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=duration=3",
            "-i",
            str(sample_wav),
            "-filter_complex",
            "[0:a][1:a]concat=n=2:v=0:a=1[out]",
            "-map",
            "[out]",
            str(guest),
        ],
        check=True,
        capture_output=True,
    )
    manifest_path = tmp_path / "ingest.yaml"
    manifest_path.write_text(
        """
session:
  reference_speaker: Host
  hint_sec: 0
speakers:
  - name: Host
    sources: [host.wav]
  - name: Guest
    sources: [guest.wav]
""",
        encoding="utf-8",
    )
    manifest = IngestManifest.load(manifest_path)
    result = consolidate_speakers(
        manifest,
        audio_dir,
        tmp_path / "raw",
        extract_start_sec=0.0,
        extract_duration_sec=1.0,
        align_mode="audio",
    )
    assert result.session_start_in_file_sec["Guest"] >= 2.0

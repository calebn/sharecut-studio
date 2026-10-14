from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from podcast_mcp.engines.session_clock import file_time_for_session
from podcast_mcp.ingest.consolidate import consolidate_speakers
from podcast_mcp.ingest.manifest import IngestManifest


def test_file_time_for_session() -> None:
    assert file_time_for_session(10.0, 960.0, 4.0) == 966.0


def _consolidate(sample_wav: Path, tmp_path: Path, guest_start: str):
    """Host plus a guest whose file opens with 3 s of silence."""
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    (audio_dir / "host.wav").write_bytes(sample_wav.read_bytes())
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
            str(audio_dir / "guest.wav"),
        ],
        check=True,
        capture_output=True,
    )
    manifest_path = tmp_path / "ingest.yaml"
    manifest_path.write_text(
        f"""
session:
  reference_speaker: Host
speakers:
  - name: Host
    sources: [host.wav]
  - name: Guest
    sources: [guest.wav]
{guest_start}""",
        encoding="utf-8",
    )
    return consolidate_speakers(
        IngestManifest.load(manifest_path),
        audio_dir,
        tmp_path / "raw",
        extract_start_sec=0.0,
        extract_duration_sec=1.0,
        align_mode="audio",
    )


def test_consolidate_uses_the_manifest_session_start(sample_wav: Path, tmp_path: Path) -> None:
    result = _consolidate(sample_wav, tmp_path, "    session_start_in_file_sec: 3.0\n")
    assert result.session_start_in_file_sec["Guest"] == pytest.approx(3.0)


def test_consolidate_guesses_no_session_start_from_speech_onsets(
    sample_wav: Path, tmp_path: Path
) -> None:
    """Two speakers' first words are not one event: an omitted start is 0, never an estimate."""
    result = _consolidate(sample_wav, tmp_path, "")
    assert result.session_start_in_file_sec == {"Host": 0.0, "Guest": 0.0}

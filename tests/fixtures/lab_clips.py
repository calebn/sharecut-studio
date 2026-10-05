"""Lossless clip extraction from a pinned Sharecut Podcast Lab checkout.

Shared by the ``lab_*`` fixture generators. Each generator owns its manifest;
this module owns revision and hash checks, native-frame slicing, FLAC
round-trip verification, and comparison with committed clips.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import tempfile
import wave
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from podcast_mcp.engines.ffmpeg import FFmpegEngine

ZOOM_ORIGINAL_DIR = Path("source") / "zoom_original"


@dataclass(frozen=True)
class LabClip:
    track: str
    filename: str
    start_s: float
    end_s: float
    expected: Mapping[str, Any]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def pcm_bytes(path: Path) -> bytes:
    with wave.open(str(path), "rb") as audio:
        return audio.readframes(audio.getnframes())


def pcm_sha256(path: Path) -> str:
    return hashlib.sha256(pcm_bytes(path)).hexdigest()


def decode_pcm16_wav(source: Path, output: Path) -> None:
    subprocess.run(
        [
            FFmpegEngine().ffmpeg,
            "-y",
            "-i",
            str(source),
            "-map",
            "0:a:0",
            "-vn",
            "-c:a",
            "pcm_s16le",
            str(output),
        ],
        check=True,
        capture_output=True,
    )


def encode_flac(source_wav: Path, output: Path) -> None:
    subprocess.run(
        [
            FFmpegEngine().ffmpeg,
            "-y",
            "-i",
            str(source_wav),
            "-map",
            "0:a:0",
            "-vn",
            "-c:a",
            "flac",
            str(output),
        ],
        check=True,
        capture_output=True,
    )


def write_window(source_wav: Path, output_wav: Path, start_s: float, end_s: float) -> None:
    with wave.open(str(source_wav), "rb") as source:
        rate = source.getframerate()
        first = round(start_s * rate)
        last = round(end_s * rate)
        if abs(first / rate - start_s) > 1e-7 or abs(last / rate - end_s) > 1e-7:
            raise ValueError(f"interval {start_s}..{end_s} does not land on native sample frames")
        source.setpos(first)
        frames = source.readframes(last - first)
        if len(frames) != (last - first) * source.getnchannels() * source.getsampwidth():
            raise ValueError(f"short decode while extracting {start_s}..{end_s}")
        with wave.open(str(output_wav), "wb") as output:
            output.setnchannels(source.getnchannels())
            output.setsampwidth(source.getsampwidth())
            output.setframerate(rate)
            output.writeframes(frames)


def verify_lab_checkout(lab_root: Path, revision: str, file_hashes: Mapping[Path, str]) -> None:
    """Reject a lab checkout at another revision or with changed source files."""
    actual_revision = subprocess.run(
        ["git", "-C", str(lab_root), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if actual_revision != revision:
        raise ValueError(f"lab revision is {actual_revision}, expected {revision}")
    for relative, expected in file_hashes.items():
        actual = sha256(lab_root / relative)
        if actual != expected:
            raise ValueError(f"{relative} SHA-256 is {actual}, expected {expected}")


def zoom_original_hashes(source_files: Mapping[str, Mapping[str, Any]]) -> dict[Path, str]:
    return {ZOOM_ORIGINAL_DIR / info["filename"]: info["sha256"] for info in source_files.values()}


def extract_lab_clips(
    lab_root: Path,
    source_files: Mapping[str, Mapping[str, Any]],
    clips: Sequence[LabClip],
    *,
    output_dir: Path | None,
    verify_dir: Path | None,
    check_window: Callable[[LabClip, Path], None] | None = None,
) -> None:
    """Slice each clip from its fully decoded original and verify it against the manifest.

    Prints one JSON line of measured seals per clip before comparing, so a new
    manifest case can be filled from the output. ``output_dir`` receives FLACs
    only after every clip verifies; ``verify_dir`` compares decoded PCM with
    committed FLACs. ``check_window`` sees each verified window WAV.
    """
    if output_dir:
        output_dir.mkdir(parents=True, exist_ok=True)
    generated: list[tuple[Path, Path]] = []
    with tempfile.TemporaryDirectory(prefix="lab-clips-") as temporary:
        work = Path(temporary)
        for track, source_info in source_files.items():
            track_clips = [clip for clip in clips if clip.track == track]
            if not track_clips:
                continue
            source_wav = work / f"{track}-full.wav"
            decode_pcm16_wav(lab_root / ZOOM_ORIGINAL_DIR / source_info["filename"], source_wav)
            with wave.open(str(source_wav), "rb") as full:
                format_and_length = (
                    full.getframerate(),
                    full.getnchannels(),
                    f"s{full.getsampwidth() * 8}",
                    full.getnframes(),
                )
            expected_source = (
                source_info["sample_rate"],
                source_info["channels"],
                source_info["sample_format"],
                source_info["frames"],
            )
            if format_and_length != expected_source:
                raise ValueError(
                    f"{track} decode is {format_and_length}, expected {expected_source}"
                )
            for clip in track_clips:
                stem = Path(clip.filename).stem
                window = work / f"{stem}.wav"
                flac = work / clip.filename
                write_window(source_wav, window, clip.start_s, clip.end_s)
                encode_flac(window, flac)
                decoded = work / f"{stem}-decoded.wav"
                decode_pcm16_wav(flac, decoded)
                if pcm_bytes(window) != pcm_bytes(decoded):
                    raise ValueError(f"FLAC did not decode losslessly for {clip.filename}")
                with wave.open(str(window), "rb") as audio:
                    measured = {
                        "channels": audio.getnchannels(),
                        "sample_rate": audio.getframerate(),
                        "frames": audio.getnframes(),
                        "pcm_sha256": pcm_sha256(window),
                    }
                print(
                    json.dumps(
                        {
                            "track": track,
                            "file": clip.filename,
                            **measured,
                            "file_sha256": sha256(flac),
                        }
                    )
                )
                if any(clip.expected.get(key) != value for key, value in measured.items()):
                    raise ValueError(
                        f"decoded source PCM changed for {clip.filename}; review and update manifest"
                    )
                if check_window:
                    check_window(clip, window)
                if output_dir:
                    generated.append((flac, output_dir / clip.filename))
                if verify_dir:
                    committed = verify_dir / clip.filename
                    committed_wav = work / f"committed-{stem}.wav"
                    decode_pcm16_wav(committed, committed_wav)
                    if pcm_sha256(committed_wav) != pcm_sha256(window):
                        raise ValueError(f"decoded PCM differs from committed clip {committed}")
            source_wav.unlink()
        for source, destination in generated:
            shutil.copyfile(source, destination)

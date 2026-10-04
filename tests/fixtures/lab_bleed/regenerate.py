from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
import wave
from pathlib import Path

from manifest import CASES, CLIP_PADDING_SEC, LAB_REVISION, SOURCE_FILES

from podcast_mcp.engines.ffmpeg import FFmpegEngine


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def pcm_sha256(path: Path) -> str:
    with wave.open(str(path), "rb") as audio:
        return hashlib.sha256(audio.readframes(audio.getnframes())).hexdigest()


def pcm_bytes(path: Path) -> bytes:
    with wave.open(str(path), "rb") as audio:
        return audio.readframes(audio.getnframes())


def decode_full_source(engine: FFmpegEngine, source: Path, output: Path) -> None:
    subprocess.run(
        [
            engine.ffmpeg,
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


def write_case_window(source_wav: Path, output_wav: Path, start_s: float, end_s: float) -> None:
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


def decode_flac(engine: FFmpegEngine, flac: Path, output_wav: Path) -> None:
    subprocess.run(
        [
            engine.ffmpeg,
            "-y",
            "-i",
            str(flac),
            "-map",
            "0:a:0",
            "-vn",
            "-c:a",
            "pcm_s16le",
            str(output_wav),
        ],
        check=True,
        capture_output=True,
    )


def verify_historical_window(
    historical_dir: Path,
    track: str,
    start_s: float,
    end_s: float,
    window_start_s: float,
    expected: Path,
) -> None:
    historical = historical_dir / f"{track}.wav"
    with wave.open(str(historical), "rb") as audio:
        if audio.getnchannels() != 2 or audio.getframerate() != 48000 or audio.getsampwidth() != 2:
            raise ValueError(f"historical audition file is not stereo 48 kHz PCM16: {historical}")
        first = round(start_s * audio.getframerate())
        last = round(end_s * audio.getframerate())
        audio.setpos(first)
        actual = audio.readframes(last - first)
    with wave.open(str(expected), "rb") as audio:
        first = round((start_s - window_start_s) * audio.getframerate())
        last = first + round((end_s - start_s) * audio.getframerate())
        audio.setpos(first)
        expected_selected = audio.readframes(last - first)
    if actual != expected_selected:
        raise ValueError(
            f"{track} {start_s}..{end_s} differs from historical audition WAV {historical}"
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lab-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--verify-dir", type=Path)
    parser.add_argument("--historical-dir", type=Path)
    args = parser.parse_args()
    if args.output_dir is None and args.verify_dir is None:
        parser.error("provide --output-dir to regenerate or --verify-dir to verify committed clips")

    lab_root = args.lab_root.resolve()
    revision = subprocess.run(
        ["git", "-C", str(lab_root), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if revision != LAB_REVISION:
        raise ValueError(f"lab revision is {revision}, expected {LAB_REVISION}")

    for source_info in SOURCE_FILES.values():
        path = lab_root / "source" / "zoom_original" / source_info["filename"]
        actual = sha256(path)
        if actual != source_info["sha256"]:
            raise ValueError(f"{path.name} SHA-256 is {actual}, expected {source_info['sha256']}")

    engine = FFmpegEngine()
    output_dir = args.output_dir.resolve() if args.output_dir else None
    if output_dir:
        output_dir.mkdir(parents=True, exist_ok=True)
    generated: list[tuple[Path, Path]] = []
    with tempfile.TemporaryDirectory(prefix="lab-bleed-") as temporary:
        work = Path(temporary)
        for track, source_info in SOURCE_FILES.items():
            source = lab_root / "source" / "zoom_original" / source_info["filename"]
            source_wav = work / f"{track}-full.wav"
            decode_full_source(engine, source, source_wav)
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
            for case in CASES:
                if track not in case["tracks"]:
                    continue
                filename = f"{case['name']}-{track}.flac"
                window = work / f"{case['name']}-{track}.wav"
                flac = work / filename
                window_interval = (
                    case["source_interval"][0] - CLIP_PADDING_SEC,
                    case["source_interval"][1] + CLIP_PADDING_SEC,
                )
                write_case_window(source_wav, window, *window_interval)
                subprocess.run(
                    [
                        engine.ffmpeg,
                        "-y",
                        "-i",
                        str(window),
                        "-map",
                        "0:a:0",
                        "-vn",
                        "-c:a",
                        "flac",
                        str(flac),
                    ],
                    check=True,
                    capture_output=True,
                )
                decoded = work / f"{case['name']}-{track}-decoded.wav"
                decode_flac(engine, flac, decoded)
                if pcm_bytes(window) != pcm_bytes(decoded):
                    raise ValueError(f"FLAC did not decode losslessly for {filename}")
                expected = case["audio"][track]
                with wave.open(str(window), "rb") as audio:
                    actual_format = (audio.getnchannels(), audio.getframerate(), audio.getnframes())
                expected_format = (
                    expected["channels"],
                    expected["sample_rate"],
                    expected["frames"],
                )
                if actual_format != expected_format or pcm_sha256(window) != expected["pcm_sha256"]:
                    raise ValueError(
                        f"decoded source PCM changed for {filename}; review and update manifest"
                    )
                if args.historical_dir:
                    verify_historical_window(
                        args.historical_dir,
                        track,
                        *case["source_interval"],
                        window_interval[0],
                        expected=window,
                    )
                if output_dir:
                    generated.append((flac, output_dir / filename))
                if args.verify_dir:
                    committed = args.verify_dir / filename
                    committed_wav = work / f"committed-{filename}.wav"
                    decode_flac(engine, committed, committed_wav)
                    if pcm_sha256(committed_wav) != pcm_sha256(window):
                        raise ValueError(f"decoded PCM differs from committed clip {committed}")
                with wave.open(str(window), "rb") as audio:
                    frames = audio.getnframes()
                print(
                    json.dumps(
                        {
                            "case": case["name"],
                            "track": track,
                            "file": filename,
                            "frames": frames,
                            "pcm_sha256": pcm_sha256(window),
                            "file_sha256": sha256(flac),
                        }
                    )
                )
            source_wav.unlink()
        for source, destination in generated:
            shutil.copyfile(source, destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

from __future__ import annotations

import argparse
import sys
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lab_clips import (
    LabClip,
    extract_lab_clips,
    verify_lab_checkout,
    zoom_original_hashes,
)
from manifest import CASES, CLIP_PADDING_SEC, LAB_REVISION, SOURCE_FILES


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
    verify_lab_checkout(lab_root, LAB_REVISION, zoom_original_hashes(SOURCE_FILES))
    cases = {}
    clips = []
    for case in CASES:
        for track in case["tracks"]:
            clip = LabClip(
                track=track,
                filename=f"{case['name']}-{track}.flac",
                start_s=case["source_interval"][0] - CLIP_PADDING_SEC,
                end_s=case["source_interval"][1] + CLIP_PADDING_SEC,
                expected=case["audio"][track],
            )
            cases[clip.filename] = case
            clips.append(clip)

    def check_historical(clip: LabClip, window: Path) -> None:
        if args.historical_dir:
            verify_historical_window(
                args.historical_dir,
                clip.track,
                *cases[clip.filename]["source_interval"],
                clip.start_s,
                expected=window,
            )

    extract_lab_clips(
        lab_root,
        SOURCE_FILES,
        clips,
        output_dir=args.output_dir.resolve() if args.output_dir else None,
        verify_dir=args.verify_dir,
        check_window=check_historical,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

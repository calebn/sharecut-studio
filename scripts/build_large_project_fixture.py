#!/usr/bin/env python3
"""Create a disposable long-form project for browser performance profiling.

The generated project uses sparse silent WAVs. It is a UI/data-shape fixture,
not an audio fidelity fixture, and must never be written below
``tests/fixtures`` or committed. The output is suitable for
``DAW_E2E_PROJECT`` and can be removed after the benchmark.
"""

from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SOURCE_FIXTURE = ROOT / "tests" / "fixtures" / "aligned_dialogue"
DEFAULT_DURATION = 2 * 60 * 60
DEFAULT_CLIPS = 1_200
DEFAULT_UTTERANCES = 10_000
TRACKS = ("reference", "guest")


def _word(index: int, start: float, end: float) -> dict[str, Any]:
    return {
        "text": f"benchmark-{index:05d}",
        "start": round(start, 3),
        "end": round(end, 3),
        "confidence": 0.95,
    }


def _write_sparse_wav(path: Path, duration: float) -> None:
    """Create a seekable silent WAV whose data payload consumes no blocks."""
    sample_rate, channels, sample_width = 48_000, 1, 2
    data_size = int(duration * sample_rate * channels * sample_width)
    byte_rate = sample_rate * channels * sample_width
    header = b"RIFF" + struct.pack("<I", 36 + data_size) + b"WAVE"
    header += b"fmt " + struct.pack(
        "<IHHIIHH",
        16,
        1,
        channels,
        sample_rate,
        byte_rate,
        channels * sample_width,
        sample_width * 8,
    )
    header += b"data" + struct.pack("<I", data_size)
    with path.open("wb") as wav:
        wav.write(header)
        wav.truncate(44 + data_size)


def build_project(
    output: Path,
    *,
    duration: float = DEFAULT_DURATION,
    clip_count: int = DEFAULT_CLIPS,
    utterance_count: int = DEFAULT_UTTERANCES,
) -> Path:
    """Write a valid project with unique clips and alternating speaker turns."""
    if duration <= 0 or clip_count < 2 or utterance_count < 2:
        raise ValueError("duration must be positive; counts must be at least two")
    if clip_count % len(TRACKS):
        raise ValueError("clip count must be divisible by the track count")
    output.mkdir(parents=True, exist_ok=False)
    project = json.loads((SOURCE_FIXTURE / "episode.project.json").read_text(encoding="utf-8"))
    project["meta"]["name"] = "large-project benchmark (disposable)"
    project["meta"]["workspace_dir"] = "."
    project["timeline"]["duration_sec"] = duration
    source_duration = duration
    for track in project["timeline"]["tracks"]:
        track["media"]["duration_sec"] = source_duration
    for source in project["sources"]:
        source["duration_sec"] = source_duration
        source["sample_rate"] = 48_000
        source["channels"] = 1

    clips: list[dict[str, Any]] = []
    clip_duration = duration / (clip_count // len(TRACKS))
    for index in range(clip_count):
        track_id = TRACKS[index % len(TRACKS)]
        start = (index // len(TRACKS)) * clip_duration
        source_start = start
        clips.append(
            {
                "id": f"benchmark-clip-{index:05d}",
                "track_id": track_id,
                "source_start": round(source_start, 3),
                "source_end": round(source_start + clip_duration, 3),
                "timeline_start": round(start, 3),
                "source_id": None,
            }
        )
    project["timeline"]["clips"] = clips

    words_per_track = (utterance_count + 1) // 2
    spacing = source_duration / max(words_per_track, 1)
    transcripts = []
    for track_id in TRACKS:
        words = []
        for local_index in range(words_per_track):
            global_index = local_index * 2 + (0 if track_id == "reference" else 1)
            if global_index >= utterance_count:
                break
            start = local_index * spacing
            words.append(_word(global_index, start, min(start + spacing * 0.55, source_duration)))
        transcripts.append({"track_id": track_id, "language": "en", "words": words})
    project["transcripts"]["per_track"] = transcripts
    # Keep the combined view explicit: the normal merge groups close words into
    # long turns, which would benchmark one pathological DOM node instead of a
    # realistic alternating-speaker transcript.  Each projected utterance is a
    # single word, with a stable source clock and speaker.
    project["transcripts"]["combined"] = {
        "utterances": sorted(
            [
                {
                    "track_id": track["track_id"],
                    "speaker": track["track_id"],
                    "start": word["start"],
                    "end": word["end"],
                    "text": word["text"],
                }
                for track in transcripts
                for word in track["words"]
            ],
            key=lambda utterance: (utterance["start"], utterance["track_id"]),
        )
    }

    (output / "episode.project.json").write_text(
        json.dumps(project, indent=2) + "\n", encoding="utf-8"
    )
    raw = output / "raw"
    raw.mkdir()
    sources = output / "sources"
    sources.mkdir()
    for track_id in TRACKS:
        _write_sparse_wav(raw / f"{track_id}.wav", duration)
        _write_sparse_wav(sources / f"{track_id}.wav", duration)
    return output / "episode.project.json"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True, help="new disposable output directory")
    parser.add_argument("--duration", type=float, default=DEFAULT_DURATION)
    parser.add_argument("--clips", type=int, default=DEFAULT_CLIPS)
    parser.add_argument("--utterances", type=int, default=DEFAULT_UTTERANCES)
    args = parser.parse_args()
    print(
        build_project(
            args.out,
            duration=args.duration,
            clip_count=args.clips,
            utterance_count=args.utterances,
        )
    )


if __name__ == "__main__":
    main()

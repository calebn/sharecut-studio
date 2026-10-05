from __future__ import annotations

import argparse
import json
import re
import sys
from itertools import pairwise
from pathlib import Path
from pprint import pformat
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lab_clips import LabClip, extract_lab_clips, verify_lab_checkout, zoom_original_hashes
from manifest import (
    ASR_FILES,
    CASES,
    FILLER_TOKENS,
    LAB_REVISION,
    MIN_PAUSE_SEC,
    SOURCE_FILES,
    TRACK_LABELS,
)

from podcast_mcp.edits.track_media import apply_full_span_media
from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.models import EpisodeProject, Track, TrackRole, Transcript, TranscriptWord
from podcast_mcp.project_store import ProjectStore

ASR_DIR = Path("source") / "asr"
CREATED_AT = "2026-10-05T00:00:00+00:00"


def window_words(words: list[dict[str, Any]], start: float, end: float) -> list[dict[str, Any]]:
    return [word for word in words if word["start"] >= start and word["end"] <= end]


def asr_labels(
    words_by_track: dict[str, list[dict[str, Any]]], interval: tuple[float, float]
) -> tuple[dict[str, Any], ...]:
    labels = []
    for track, words in words_by_track.items():
        inside = window_words(words, *interval)
        for word in inside:
            if re.sub(r"[^a-z]", "", word["text"].lower()) in FILLER_TOKENS:
                labels.append(
                    {
                        "kind": "filler",
                        "track": track,
                        "source_interval": (round(word["start"], 3), round(word["end"], 3)),
                        "text": word["text"],
                        "label_source": "asr_seed",
                    }
                )
        for before, after in pairwise(inside):
            gap = (round(before["end"], 3), round(after["start"], 3))
            if gap[1] - gap[0] >= MIN_PAUSE_SEC:
                labels.append(
                    {
                        "kind": "pause",
                        "track": track,
                        "source_interval": gap,
                        "text": f"{before['text']} ... {after['text']}",
                        "label_source": "asr_seed",
                    }
                )
    return tuple(
        sorted(labels, key=lambda label: (label["source_interval"], label["track"], label["kind"]))
    )


def write_project(
    case_dir: Path, case: dict[str, Any], words_by_track: dict[str, list[dict[str, Any]]]
) -> None:
    start, end = case["source_interval"]
    project = EpisodeProject.create(f"Lab tighten {case['name']}", str(case_dir))
    project.meta.created_at = CREATED_AT
    for track_id in SOURCE_FILES:
        track = Track(
            id=track_id,
            label=TRACK_LABELS[track_id],
            role=TrackRole.DIALOGUE,
            speaker=track_id,
        )
        project.tracks.append(track)
        apply_full_span_media(
            project,
            track,
            store_path=f"raw/{track_id}.flac",
            audio_path=case_dir / "raw" / f"{track_id}.flac",
        )
        next(clip for clip in project.clips if clip.track_id == track_id).id = f"{track_id}_clip"
    project.transcripts = [
        Transcript(
            track_id=track_id,
            language="en",
            words=[
                TranscriptWord.model_validate(
                    {
                        **word,
                        "start": round(word["start"] - start, 3),
                        "end": round(word["end"] - start, 3),
                    }
                )
                for word in window_words(words, start, end)
            ],
        )
        for track_id, words in words_by_track.items()
    ]
    project.transcript_data.combined = TranscriptionEngine().merge_transcripts(project)
    ProjectStore(case_dir / "episode.project.json").commit(project)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lab-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--verify-dir", type=Path)
    args = parser.parse_args()

    lab_root = args.lab_root.resolve()
    output_dir = args.output_dir.resolve()
    verify_lab_checkout(
        lab_root,
        LAB_REVISION,
        zoom_original_hashes(SOURCE_FILES)
        | {ASR_DIR / info["filename"]: info["sha256"] for info in ASR_FILES.values()},
    )
    words_by_track = {
        track: json.loads((lab_root / ASR_DIR / info["filename"]).read_text())["words"]
        for track, info in ASR_FILES.items()
    }
    for case in CASES:
        labels = asr_labels(words_by_track, case["source_interval"])
        if labels != case["labels"]:
            print(pformat(labels, sort_dicts=False))
            raise ValueError(f"ASR labels changed for {case['name']}; review and update manifest")

    extract_lab_clips(
        lab_root,
        SOURCE_FILES,
        [
            LabClip(
                track=track,
                filename=f"{case['name']}/raw/{track}.flac",
                start_s=case["source_interval"][0],
                end_s=case["source_interval"][1],
                expected=case["audio"].get(track, {}),
            )
            for case in CASES
            for track in SOURCE_FILES
        ],
        output_dir=output_dir,
        verify_dir=args.verify_dir,
    )
    for case in CASES:
        write_project(output_dir / case["name"], case, words_by_track)
        if args.verify_dir:
            project_file = Path(case["name"]) / "episode.project.json"
            if (output_dir / project_file).read_text() != (
                args.verify_dir / project_file
            ).read_text():
                raise ValueError(f"regenerated {project_file} differs from {args.verify_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Build ami_bleed_60s from AMI word XML + synthetic audio at labeled timings."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO / "src"))

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.models.episode import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.project_store import ProjectStore

# Import parser from sibling script
sys.path.insert(0, str(_REPO / "scripts"))
from build_synthetic_bleed_fixture import (
    _apply_bleed_events,
    _render_clean_track,
    _validate_bleed,
)
from import_ami_words import import_meeting_words

DEFAULT_MEETING = "ES2002a"
DEFAULT_SLICE = (120.0, 180.0)


def _slice_words(words: list[TranscriptWord], start: float, end: float) -> list[TranscriptWord]:
    out: list[TranscriptWord] = []
    for w in words:
        if w.end <= start or w.start >= end:
            continue
        out.append(
            TranscriptWord(
                text=w.text,
                start=max(0.0, w.start - start),
                end=min(end - start, w.end - start),
                confidence=w.confidence,
            )
        )
    return [w for w in out if w.end > w.start]


def _overlap_bleed_events(
    host_words: list[TranscriptWord],
    guest_words: list[TranscriptWord],
    *,
    host_gain_db: float = -8.0,
    guest_gain_db: float = -24.0,
    pad: float = 0.15,
) -> list[dict]:
    windows: list[tuple[float, float]] = []
    for hw in host_words:
        for gw in guest_words:
            lo = max(hw.start, gw.start) - pad
            hi = min(hw.end, gw.end) + pad
            if hi - lo > 0.08:
                windows.append((lo, hi))
    if not windows:
        return []
    windows.sort()
    merged: list[tuple[float, float]] = []
    for lo, hi in windows:
        if merged and lo <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], hi))
        else:
            merged.append((lo, hi))
    return [
        {
            "window": {"start": lo, "end": hi},
            "duck": {"into": "host", "gain_db": -30},
            "inject": [
                {"from": "guest", "into": "host", "gain_db": host_gain_db},
                {"from": "host", "into": "guest", "gain_db": guest_gain_db},
            ],
        }
        for lo, hi in merged
    ]


def build_from_words_dir(
    words_dir: Path,
    out_root: Path,
    *,
    meeting: str = DEFAULT_MEETING,
    slice_sec: tuple[float, float] = DEFAULT_SLICE,
    validate: bool = True,
) -> None:
    per_speaker = import_meeting_words(
        words_dir,
        meeting_id=meeting,
        speakers=["A", "B"],
    )
    start, end = slice_sec
    duration = end - start
    host_words = _slice_words(per_speaker["A"], start, end)
    guest_words = _slice_words(per_speaker["B"], start, end)
    host_tuples = [(w.text, w.start, w.end) for w in host_words]
    guest_tuples = [(w.text, w.start, w.end) for w in guest_words]

    engine = FFmpegEngine()
    build_dir = out_root / "_build"
    if build_dir.exists():
        import shutil

        shutil.rmtree(build_dir)
    build_dir.mkdir(parents=True, exist_ok=True)

    clean = {
        "host": _render_clean_track(
            engine,
            words=host_tuples,
            freq=440,
            out_dir=build_dir / "host",
            track_id="host",
            duration_sec=duration,
        ),
        "guest": _render_clean_track(
            engine,
            words=guest_tuples,
            freq=880,
            out_dir=build_dir / "guest",
            track_id="guest",
            duration_sec=duration,
        ),
    }
    bleed_events = _overlap_bleed_events(host_words, guest_words)
    mixed = _apply_bleed_events(
        engine,
        tracks=clean,
        bleed_events=bleed_events,
        out_dir=build_dir,
    )

    raw = out_root / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    (raw / "host.wav").write_bytes(mixed["host"].read_bytes())
    (raw / "guest.wav").write_bytes(mixed["guest"].read_bytes())

    gt = out_root / "ground_truth"
    gt.mkdir(parents=True, exist_ok=True)
    for tid, words in (("host", host_words), ("guest", guest_words)):
        payload = {
            "track_id": tid,
            "language": "en",
            "words": [w.model_dump() for w in words],
        }
        (gt / f"{tid}.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    (gt / "manifest.yaml").write_text(
        yaml.safe_dump(
            {
                "source": "AMI Meeting Corpus word timings + synthetic audio",
                "meeting": meeting,
                "slice_sec": [start, end],
                "license": "CC BY 4.0",
                "bleed_events": bleed_events,
            },
            sort_keys=False,
        ),
        encoding="utf-8",
    )

    project = EpisodeProject.create("ami bleed 60s", str(out_root.resolve()))
    project.timeline.duration_sec = duration
    for tid, speaker in (("host", "Speaker A"), ("guest", "Speaker B")):
        project.timeline.tracks.append(
            Track(
                id=tid,
                label=speaker,
                role=TrackRole.DIALOGUE,
                speaker=speaker,
                media=MediaAsset(
                    path=f"raw/{tid}.wav",
                    duration_sec=duration,
                    sample_rate=48000,
                    channels=1,
                ),
            )
        )
        project.timeline.clips.append(
            Clip(
                id=f"clip_{tid}",
                track_id=tid,
                source_start=0.0,
                source_end=duration,
                timeline_start=0.0,
            )
        )
    project.transcripts = [
        Transcript(track_id="host", language="en", words=host_words),
        Transcript(track_id="guest", language="en", words=guest_words),
    ]
    project.combined_transcript = TranscriptionEngine().merge_transcripts(project)
    project_path = out_root / "episode.project.json"
    ProjectStore(project_path).commit(project)

    expected = {
        "min_bleed_words_total": 1,
        "source": "AMI word timings with synthetic overlap bleed",
        "overlap_windows": len(bleed_events),
    }
    if validate:
        expected["observed_bleed_words"] = _validate_bleed(
            project_path,
            min_bleed_total=1,
        )
    (out_root / "expected_metrics.json").write_text(
        json.dumps(expected, indent=2),
        encoding="utf-8",
    )
    (out_root / "README.md").write_text(
        "# ami_bleed_60s\n\n"
        "AMI ES2002a word-level labels (speakers A/B, 60s slice) with "
        "synthetic audio and overlap-derived bleed.\n\n"
        "Regenerate: `./scripts/download_fixture_ami.sh`\n",
        encoding="utf-8",
    )
    (out_root / ".gitignore").write_text("_build/\nartifacts/\nhistory/\n", encoding="utf-8")
    for cleanup in (out_root / "artifacts", out_root / "_build", out_root / "history"):
        if cleanup.is_dir():
            import shutil

            shutil.rmtree(cleanup)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--words-dir", type=Path, required=True)
    parser.add_argument(
        "--output",
        type=Path,
        default=_REPO / "tests" / "fixtures" / "ami_bleed_60s",
    )
    parser.add_argument("--meeting", default=DEFAULT_MEETING)
    parser.add_argument("--slice-start", type=float, default=DEFAULT_SLICE[0])
    parser.add_argument("--slice-end", type=float, default=DEFAULT_SLICE[1])
    parser.add_argument("--no-validate", action="store_true")
    args = parser.parse_args()
    build_from_words_dir(
        args.words_dir.resolve(),
        args.output.resolve(),
        meeting=args.meeting,
        slice_sec=(args.slice_start, args.slice_end),
        validate=not args.no_validate,
    )
    print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

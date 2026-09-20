#!/usr/bin/env python3
"""Convert AMI NITE word XML files to podcast_mcp transcript JSON."""

from __future__ import annotations

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO / "src"))

from podcast_mcp.models.episode import TranscriptWord

_NS = {"nite": "http://nite.sourceforge.net/"}


def _local(tag: str) -> str:
    return tag.split("}")[-1] if "}" in tag else tag


def parse_ami_words_xml(path: Path) -> list[TranscriptWord]:
    root = ET.parse(path).getroot()
    words: list[TranscriptWord] = []
    for elem in root.iter():
        if _local(elem.tag) != "w":
            continue
        text = (elem.text or "").strip()
        if not text or text in {".", ",", "?", "!"}:
            continue
        start = elem.get("starttime") or elem.get("{http://nite.sourceforge.net/}starttime")
        end = elem.get("endtime") or elem.get("{http://nite.sourceforge.net/}endtime")
        if start is None or end is None:
            continue
        try:
            s = float(start)
            e = float(end)
        except ValueError:
            continue
        if e <= s:
            continue
        words.append(
            TranscriptWord(
                text=text,
                start=s,
                end=e,
                confidence=0.99,
            )
        )
    words.sort(key=lambda w: w.start)
    return words


def speaker_from_filename(path: Path) -> str:
    # ES2002a.A.words.xml -> A
    m = re.search(r"\.([A-Z])\.words\.xml$", path.name, re.I)
    if m:
        return m.group(1).upper()
    return path.stem


def import_meeting_words(
    words_dir: Path,
    *,
    meeting_id: str,
    speakers: list[str] | None = None,
) -> dict[str, list[TranscriptWord]]:
    pattern = f"{meeting_id}.*.words.xml"
    files = sorted(words_dir.glob(pattern))
    if not files:
        files = sorted(words_dir.glob("*.words.xml"))
    out: dict[str, list[TranscriptWord]] = {}
    for path in files:
        spk = speaker_from_filename(path)
        if speakers and spk not in speakers:
            continue
        out[spk] = parse_ami_words_xml(path)
    return out


def write_ground_truth(
    out_dir: Path,
    per_speaker: dict[str, list[TranscriptWord]],
    *,
    track_map: dict[str, str] | None = None,
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    track_map = track_map or {}
    for spk, words in per_speaker.items():
        track_id = track_map.get(spk, spk.lower())
        payload = {
            "track_id": track_id,
            "language": "en",
            "words": [w.model_dump() for w in words],
        }
        (out_dir / f"{track_id}.json").write_text(
            json.dumps(payload, indent=2),
            encoding="utf-8",
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("words_dir", type=Path, help="Directory with AMI *.words.xml")
    parser.add_argument("--meeting", default="ES2002a")
    parser.add_argument("--speakers", nargs="*", default=["A", "B"])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--track-map",
        default="A:host,B:guest",
        help="Comma-separated AMI speaker:track_id pairs",
    )
    args = parser.parse_args()
    track_map = dict(pair.split(":") for pair in args.track_map.split(",") if ":" in pair)
    per_speaker = import_meeting_words(
        args.words_dir,
        meeting_id=args.meeting,
        speakers=args.speakers,
    )
    if not per_speaker:
        raise SystemExit(f"no word files found in {args.words_dir}")
    write_ground_truth(args.output, per_speaker, track_map=track_map)
    print(f"Imported {len(per_speaker)} tracks to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

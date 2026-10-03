#!/usr/bin/env python3
"""Compose the aligned-dialogue fixture offline from checked-in LibriSpeech speech.

Run ``uv run python scripts/build_aligned_dialogue_audio.py``. Whole utterances
are resampled to mono PCM16 at 48 kHz, without trimming, stretching or gain.
Published MFA-derived boundaries are shifted into each placement's source clock.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
import wave
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO / "src"))

from podcast_mcp.e2e_fixture import DEFAULT_CANNED, FIXTURES_DIR
from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.models import Transcript, TranscriptWord, load_project
from podcast_mcp.project_store import ProjectStore
from podcast_mcp.util.binaries import resolve_ffmpeg

FIXTURE = FIXTURES_DIR / "aligned_dialogue"
GOLD_DIR = FIXTURES_DIR / "word_boundary"
SAMPLE_RATE = 48_000
DURATION_SEC = 60.0


@dataclass(frozen=True)
class SpeechClip:
    clip_id: str
    audio_sha256: str
    gold_sha256: str


@dataclass(frozen=True)
class TrackLayout:
    track_id: str
    clip: SpeechClip
    placements_sec: tuple[float, ...]
    session_start_in_file_sec: float
    source_duration_sec: float


LAYOUT = (
    TrackLayout(
        "reference",
        SpeechClip(
            "6241-61943-0003",
            "8d1217eb43a8e46f825bc25cdf2cfed9d2f797520e1c0e1624cbf22208468540",
            "05fd4c4286af48a4dc81024841f51c65ecadee92be6552bf3afa412d16eb7ac8",
        ),
        (2.0, 35.0),
        0.0,
        90.0,
    ),
    TrackLayout(
        "guest",
        SpeechClip(
            "1988-147956-0023",
            "60726751a107f923f62d1f4c271751c07ae4c6ec511d4ba009e8182720184f53",
            "69db76f58d58ede2a659fd10b726d93b2ed886c10f1f1272bfe960aaa6048158",
        ),
        (8.0, 43.0),
        98.0,
        180.0,
    ),
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_wav_int16(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as wf:
        if wf.getnchannels() != 1 or wf.getsampwidth() != 2:
            raise ValueError(f"expected mono PCM16 WAV: {path}")
        return np.frombuffer(wf.readframes(wf.getnframes()), dtype="<i2").copy(), wf.getframerate()


def write_wav_int16(path: Path, samples: np.ndarray, sample_rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(samples.astype("<i2").tobytes())


def load_clip(clip: SpeechClip, gold_dir: Path) -> tuple[np.ndarray, list[TranscriptWord]]:
    audio_path = gold_dir / f"{clip.clip_id}.wav"
    gold_path = gold_dir / f"{clip.clip_id}.gold.json"
    for path, digest in ((audio_path, clip.audio_sha256), (gold_path, clip.gold_sha256)):
        if sha256(path) != digest:
            raise ValueError(f"SHA-256 mismatch: {path}")
    gold = json.loads(gold_path.read_text())
    if gold["audio_sha256"] != clip.audio_sha256 or gold["id"] != clip.clip_id:
        raise ValueError("gold labels identify a different audio clip")
    with tempfile.TemporaryDirectory() as tmp:
        output = Path(tmp) / "resampled.wav"
        subprocess.run(
            [
                resolve_ffmpeg(),
                "-y",
                "-v",
                "error",
                "-i",
                str(audio_path),
                "-ar",
                str(SAMPLE_RATE),
                "-ac",
                "1",
                "-c:a",
                "pcm_s16le",
                "-map_metadata",
                "-1",
                "-fflags",
                "+bitexact",
                str(output),
            ],
            check=True,
            timeout=120,
        )
        samples, _ = read_wav_int16(output)
    words = [TranscriptWord.model_validate({**word, "confidence": 0.95}) for word in gold["words"]]
    previous_end = 0.0
    for word in words:
        if not word.text or word.start < previous_end or word.end <= word.start:
            raise ValueError("invalid or overlapping gold word boundaries")
        if word.end > samples.size / SAMPLE_RATE:
            raise ValueError("gold words extend beyond the audio")
        previous_end = word.end
    if not words:
        raise ValueError("gold labels contain no words")
    return samples, words


def compose_track(
    clip: np.ndarray,
    placements_sec: Sequence[float],
    *,
    duration_sec: float,
    sample_rate: int = SAMPLE_RATE,
) -> np.ndarray:
    """Copy every complete utterance, rejecting overlapping or out-of-range placements."""
    output = np.zeros(round(duration_sec * sample_rate), dtype=np.int16)
    previous_end = 0
    for offset in placements_sec:
        start = round(offset * sample_rate)
        end = start + clip.size
        if start < previous_end:
            raise ValueError("utterance placements overlap or start before zero")
        if end > output.size:
            raise ValueError("utterance runs past the track end")
        output[start:end] = clip
        previous_end = end
    return output


def pad_source(
    raw: np.ndarray,
    *,
    offset_sec: float,
    duration_sec: float,
    sample_rate: int,
) -> np.ndarray:
    return compose_track(raw, (offset_sec,), duration_sec=duration_sec, sample_rate=sample_rate)


def build_fixture(fixture: Path, canned: Path, gold_dir: Path = GOLD_DIR) -> None:
    project_path = fixture / "episode.project.json"
    project = load_project(project_path)
    transcripts = []
    manifest_tracks = []
    outputs: dict[str, str] = {}
    for layout in LAYOUT:
        clip, words = load_clip(layout.clip, gold_dir)
        raw = compose_track(clip, layout.placements_sec, duration_sec=DURATION_SEC)
        source = pad_source(
            raw,
            offset_sec=layout.session_start_in_file_sec,
            duration_sec=layout.source_duration_sec,
            sample_rate=SAMPLE_RATE,
        )
        for folder, samples in (("raw", raw), ("sources", source)):
            path = fixture / folder / f"{layout.track_id}.wav"
            write_wav_int16(path, samples, SAMPLE_RATE)
            outputs[str(path.relative_to(fixture))] = sha256(path)
        transcripts.append(
            Transcript(
                track_id=layout.track_id,
                language="en",
                words=[
                    word.model_copy(
                        update={
                            "start": round(word.start + offset, 8),
                            "end": round(word.end + offset, 8),
                        }
                    )
                    for offset in layout.placements_sec
                    for word in words
                ],
            )
        )
        manifest_tracks.append(
            {
                "track_id": layout.track_id,
                "clip_id": layout.clip.clip_id,
                "audio_sha256": layout.clip.audio_sha256,
                "gold_sha256": layout.clip.gold_sha256,
                "placements_sec": layout.placements_sec,
                "session_start_in_file_sec": layout.session_start_in_file_sec,
                "source_duration_sec": layout.source_duration_sec,
                "resampled_frames": clip.size,
            }
        )
    project.transcript_data.per_track = transcripts
    project.transcript_data.combined = TranscriptionEngine().merge_transcripts(project)
    ProjectStore(project_path).commit(project)
    canned.write_text(
        json.dumps(
            {"per_track": [t.model_dump(mode="json", by_alias=True) for t in transcripts]}, indent=2
        )
        + "\n"
    )
    (fixture / "fixture.meta.json").write_text(
        json.dumps(
            {
                "duration_sec": DURATION_SEC,
                "track_ids": [t.track_id for t in LAYOUT],
                "known_phrases": ["uncle", "delighted", "questioned"],
                "provenance_manifest": "provenance.json",
            },
            indent=2,
        )
        + "\n"
    )
    (fixture / "provenance.json").write_text(
        json.dumps(
            {
                "license": "CC-BY-4.0",
                "license_url": "https://creativecommons.org/licenses/by/4.0/",
                "audio_source": "https://www.openslr.org/12",
                "audio_attribution": "LibriSpeech, Panayotov, Chen, Povey and Khudanpur, ICASSP 2015",
                "labels_source": "https://huggingface.co/datasets/gilkeyio/librispeech-alignments",
                "labels_attribution": "gilkeyio/librispeech-alignments",
                "text_reference": "LibriSpeech reference text",
                "boundary_reference": "Published MFA-derived boundaries, not human-verified timings",
                "composition": "Whole utterances; ffmpeg mono PCM16 48000 Hz resampling; no trim, stretch or gain",
                "tracks": manifest_tracks,
                "output_sha256": outputs,
            },
            indent=2,
        )
        + "\n"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=FIXTURE)
    parser.add_argument("--canned", type=Path, default=DEFAULT_CANNED)
    parser.add_argument("--gold-dir", type=Path, default=GOLD_DIR)
    args = parser.parse_args(argv)
    build_fixture(args.fixture, args.canned, args.gold_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Build tests/fixtures/aligned_dialogue speech from Piper TTS at canned word times (#801).

Regenerates ``raw/{reference,guest}.wav`` and ``sources/{reference,guest}.wav`` by
synthesizing the canned transcript (``tests/fixtures/canned_transcript_aligned.json``) with
Piper TTS voices, placed exactly at the canned words' start/end times, and rewrites the
``transcripts/{reference,guest}.json`` write-through mirrors to match.

Piper is not a project dependency (it is a one-off regeneration tool, like
``build_synthetic_bleed_fixture.py`` is for ffmpeg); run this with:

    uv run --with piper-tts==1.8.0 python scripts/build_aligned_dialogue_audio.py

See ``tests/fixtures/aligned_dialogue/README.md`` for voice licensing and provenance.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import subprocess
import sys
import tempfile
import wave
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import yaml

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO / "src"))

from podcast_mcp.e2e_fixture import DEFAULT_CANNED, FIXTURES_DIR
from podcast_mcp.models import load_project
from podcast_mcp.project_store import ProjectStore
from podcast_mcp.util.binaries import resolve_ffmpeg

FIXTURE = FIXTURES_DIR / "aligned_dialogue"
PIPER_VOICES_REPO = "rhasspy/piper-voices"
PIPER_VOICES_REVISION = "c10ece1aade47bb51c153c893d14e5bf8e5b7117"
VOICES = {
    "reference": "en/en_US/norman/medium/en_US-norman-medium.onnx",
    "guest": "en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx",
}
SAMPLE_RATE = 48_000
SOURCE_DURATION_SEC = {"reference": 90.0, "guest": 180.0}  # current sources/*.wav lengths
PHRASE_MAX_SLOT_SEC = (
    0.5  # words faster than this in a contiguous run are synthesized as one phrase
)
JOIN_GAP_SEC = 0.05  # max gap between words of one phrase
ONSET_PAD_SEC = 0.02  # silence between the canned start and the speech onset
TAIL_GUARD_SEC = 0.04  # silence kept before the canned end (inaudible-cut search room)
MIN_LENGTH_SCALE = 0.3  # Piper speed-up floor
TARGET_PEAK = 0.7
FADE_SEC = 0.005
TRIM_THRESHOLD = 0.02  # fraction of the clip peak treated as silence when trimming


@dataclass(frozen=True)
class Segment:
    text: str
    start: float
    end: float


# (text, length_scale) -> (float32 mono audio, sample_rate)
Synthesize = Callable[[str, float], tuple[np.ndarray, int]]


def plan_segments(words: Sequence[Mapping[str, Any]]) -> list[Segment]:
    """Group a contiguous run of short words into one phrase; leave slow words separate."""
    ordered = sorted(words, key=lambda w: w["start"])
    segments: list[Segment] = []
    run: list[Mapping[str, Any]] = []

    def flush() -> None:
        if not run:
            return
        if len(run) >= 2:
            text = " ".join(str(w["text"]) for w in run)
            segments.append(Segment(text, float(run[0]["start"]), float(run[-1]["end"])))
        else:
            w = run[0]
            segments.append(Segment(str(w["text"]), float(w["start"]), float(w["end"])))
        run.clear()

    for w in ordered:
        if run:
            prev = run[-1]
            joins = (
                w["start"] - prev["end"] <= JOIN_GAP_SEC
                and (prev["end"] - prev["start"]) < PHRASE_MAX_SLOT_SEC
                and (w["end"] - w["start"]) < PHRASE_MAX_SLOT_SEC
            )
            if not joins:
                flush()
        run.append(w)
    flush()
    return segments


def trim_silence(audio: np.ndarray, threshold: float = TRIM_THRESHOLD) -> np.ndarray:
    """Drop leading/trailing samples below ``threshold`` of the clip's own peak."""
    if audio.size == 0:
        return audio
    peak = float(np.abs(audio).max())
    if peak <= 0.0:
        return audio[:0]
    loud = np.flatnonzero(np.abs(audio) >= threshold * peak)
    if loud.size == 0:
        return audio[:0]
    return audio[loud[0] : loud[-1] + 1]


def _fade(audio: np.ndarray, sr: int) -> np.ndarray:
    n = min(round(FADE_SEC * sr), audio.size // 2)
    if n <= 0:
        return audio
    out = audio.copy()
    ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
    out[:n] *= ramp
    out[-n:] *= ramp[::-1]
    return out


def fit_segment(segment: Segment, synthesize: Synthesize) -> tuple[np.ndarray, int]:
    """Synthesize ``segment.text`` to fit inside its own time slot, speeding up then truncating."""
    target = segment.end - segment.start - ONSET_PAD_SEC - TAIL_GUARD_SEC
    audio, sr = synthesize(segment.text, 1.0)
    audio = trim_silence(audio)
    dur = audio.size / sr
    if dur > target > 0:
        scale = max(MIN_LENGTH_SCALE, 0.97 * target / dur)
        audio, sr = synthesize(segment.text, scale)
        audio = trim_silence(audio)
        dur = audio.size / sr
    target_samples = max(round(target * sr), 0)
    if audio.size > target_samples:
        print(
            f"warning: truncating {segment.text!r} ({dur:.3f}s -> {target:.3f}s)",
            file=sys.stderr,
        )
        audio = _loudest_window(audio, target_samples)
    return _fade(audio.astype(np.float32), sr), sr


def _loudest_window(audio: np.ndarray, n: int) -> np.ndarray:
    """The contiguous ``n``-sample slice of ``audio`` with the most energy.

    Truncating to the loudest window (rather than always the head) avoids landing on a
    quiet onset ramp when a word must be cut down to a slot much shorter than its natural
    length (short filler words like "um" against a 0.2 s canned slot, in particular).
    """
    if n <= 0 or audio.size <= n:
        return audio[:n]
    energy = np.cumsum(np.concatenate([[0.0], audio.astype(np.float64) ** 2]))
    window_energy = energy[n:] - energy[:-n]
    start = int(np.argmax(window_energy))
    return audio[start : start + n]


def render_track(
    segments: Sequence[Segment], synthesize: Synthesize, *, duration_sec: float
) -> tuple[np.ndarray, int]:
    """Fit and place every segment's speech into a silent track of ``duration_sec`` seconds."""
    fitted = [fit_segment(seg, synthesize) for seg in segments]
    rates = {sr for _, sr in fitted}
    if len(rates) > 1:
        raise ValueError(f"mixed sample rates from synthesizer: {sorted(rates)}")
    sr = next(iter(rates)) if rates else SAMPLE_RATE
    out = np.zeros(round(duration_sec * sr), dtype=np.float32)
    prev_end = 0
    for seg, (clip, _sr) in zip(segments, fitted, strict=True):
        start_sample = round((seg.start + ONSET_PAD_SEC) * sr)
        end_sample = start_sample + clip.size
        if start_sample < prev_end:
            raise ValueError(f"segment {seg.text!r} overlaps the previous segment")
        if end_sample > out.size:
            raise ValueError(f"segment {seg.text!r} runs past the track end")
        out[start_sample:end_sample] = clip
        prev_end = end_sample
    peak = float(np.abs(out).max())
    if peak > 0:
        out = out * (TARGET_PEAK / peak)
    return out, sr


def pad_source(
    raw: np.ndarray, *, offset_sec: float, duration_sec: float, sample_rate: int
) -> np.ndarray:
    """Zero-pad ``raw`` into a track of ``duration_sec`` seconds starting at ``offset_sec``."""
    total = round(duration_sec * sample_rate)
    offset = round(offset_sec * sample_rate)
    if offset + raw.size > total:
        raise ValueError("raw audio does not fit inside the padded source duration")
    out = np.zeros(total, dtype=raw.dtype)
    out[offset : offset + raw.size] = raw
    return out


def exact_length(samples: np.ndarray, n: int) -> np.ndarray:
    """Truncate, or zero-pad at the end, to exactly ``n`` samples."""
    if samples.size == n:
        return samples
    if samples.size > n:
        return samples[:n]
    pad = np.zeros(n - samples.size, dtype=samples.dtype)
    return np.concatenate([samples, pad])


def to_int16(audio: np.ndarray) -> np.ndarray:
    return np.clip(np.round(audio * 32767), -32768, 32767).astype(np.int16)


def read_wav_int16(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as wf:
        sr = wf.getframerate()
        raw = wf.readframes(wf.getnframes())
    return np.frombuffer(raw, dtype=np.int16).copy(), sr


def write_wav_int16(path: Path, samples: np.ndarray, sample_rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(samples.astype(np.int16).tobytes())


# --- Side-effect helpers (network, ffmpeg, piper); kept out of the pure functions above so
# those can be unit-tested with a fake synthesizer. ---


def resample_int16(samples: np.ndarray, from_sr: int, to_sr: int) -> np.ndarray:
    if from_sr == to_sr:
        return samples
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "in.wav"
        dst = Path(tmp) / "out.wav"
        write_wav_int16(src, samples, from_sr)
        subprocess.run(
            [
                resolve_ffmpeg(),
                "-y",
                "-v",
                "error",
                "-i",
                str(src),
                "-ar",
                str(to_sr),
                "-ac",
                "1",
                "-c:a",
                "pcm_s16le",
                "-map_metadata",
                "-1",
                "-fflags",
                "+bitexact",
                str(dst),
            ],
            check=True,
            timeout=120,
        )
        out, _sr = read_wav_int16(dst)
    return out


def download_voice(rel_path: str) -> Path:
    from huggingface_hub import hf_hub_download

    hf_hub_download(PIPER_VOICES_REPO, rel_path + ".json", revision=PIPER_VOICES_REVISION)
    return Path(hf_hub_download(PIPER_VOICES_REPO, rel_path, revision=PIPER_VOICES_REVISION))


def piper_synthesizer(model_path: Path) -> Synthesize:
    try:
        from piper import PiperVoice, SynthesisConfig
    except ImportError as exc:
        raise SystemExit(
            "piper-tts missing: run with "
            "`uv run --with piper-tts==1.8.0 python scripts/build_aligned_dialogue_audio.py`"
        ) from exc

    voice = PiperVoice.load(str(model_path))

    def synthesize(text: str, scale: float) -> tuple[np.ndarray, int]:
        chunks = list(voice.synthesize(text, syn_config=SynthesisConfig(length_scale=scale)))
        audio = np.concatenate([c.audio_float_array for c in chunks]).astype(np.float32)
        return audio, chunks[0].sample_rate

    return synthesize


def write_transcript_mirrors(fixture: Path) -> None:
    project = load_project(fixture / "episode.project.json")
    ProjectStore(fixture / "episode.project.json")._mirror_transcript_cache(project)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=FIXTURE)
    parser.add_argument("--canned", type=Path, default=DEFAULT_CANNED)
    args = parser.parse_args(argv)
    fixture: Path = args.fixture

    duration = float(json.loads((fixture / "fixture.meta.json").read_text())["duration_sec"])
    ingest = yaml.safe_load((fixture / "ingest.yaml").read_text())
    offsets = {s["name"]: float(s["session_start_in_file_sec"]) for s in ingest["speakers"]}
    canned = json.loads(args.canned.read_text())
    words_by_track = {t["track_id"]: t["words"] for t in canned["per_track"]}

    for track in ("reference", "guest"):
        segments = plan_segments(words_by_track[track])
        voice_path = download_voice(VOICES[track])
        synth = piper_synthesizer(voice_path)
        stderr_buf = io.StringIO()
        with contextlib.redirect_stderr(stderr_buf):
            audio, sr = render_track(segments, synth, duration_sec=duration)
        captured = stderr_buf.getvalue()
        sys.stderr.write(captured)
        truncated = captured.count("warning: truncating")
        raw = exact_length(
            resample_int16(to_int16(audio), sr, SAMPLE_RATE), round(duration * SAMPLE_RATE)
        )
        write_wav_int16(fixture / "raw" / f"{track}.wav", raw, SAMPLE_RATE)
        source = pad_source(
            raw,
            offset_sec=offsets[track],
            duration_sec=SOURCE_DURATION_SEC[track],
            sample_rate=SAMPLE_RATE,
        )
        write_wav_int16(fixture / "sources" / f"{track}.wav", source, SAMPLE_RATE)
        print(f"{track}: {len(segments)} segments, {truncated} truncated")

    write_transcript_mirrors(fixture)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

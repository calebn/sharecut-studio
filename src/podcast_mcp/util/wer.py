from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from podcast_mcp.models.episode import Transcript, TranscriptWord


def normalize_token(text: str) -> str:
    return re.sub(r"[^\w']+", "", text.lower())


def tokens_from_text(text: str) -> list[str]:
    return [t for t in (normalize_token(w) for w in text.split()) if t]


def tokens_from_words(words: list[TranscriptWord]) -> list[str]:
    return [t for w in words if (t := normalize_token(w.text))]


def speech_windows(
    words: list[TranscriptWord],
    *,
    gap_sec: float = 1.0,
    pad_sec: float = 0.35,
) -> list[tuple[float, float]]:
    timed = [w for w in words if w.end > w.start]
    if not timed:
        return []
    timed.sort(key=lambda w: w.start)
    windows: list[tuple[float, float]] = []
    start = timed[0].start
    end = timed[0].end
    for word in timed[1:]:
        if word.start - end > gap_sec:
            windows.append((max(0.0, start - pad_sec), end + pad_sec))
            start = word.start
            end = word.end
        else:
            end = max(end, word.end)
    windows.append((max(0.0, start - pad_sec), end + pad_sec))
    return windows


def words_in_windows(
    words: list[TranscriptWord],
    windows: list[tuple[float, float]],
) -> list[TranscriptWord]:
    if not windows:
        return []
    kept: list[TranscriptWord] = []
    for word in words:
        if word.end <= word.start:
            continue
        mid = (word.start + word.end) / 2.0
        if any(lo <= mid <= hi for lo, hi in windows):
            kept.append(word)
    kept.sort(key=lambda w: w.start)
    return kept


@dataclass(frozen=True)
class WerResult:
    reference_count: int
    substitutions: int
    insertions: int
    deletions: int
    wer: float | None
    reference_text: str
    hypothesis_text: str

    @property
    def errors(self) -> int:
        return self.substitutions + self.insertions + self.deletions


def word_error_rate(reference: list[str], hypothesis: list[str]) -> WerResult:
    ref = [normalize_token(t) for t in reference if normalize_token(t)]
    hyp = [normalize_token(t) for t in hypothesis if normalize_token(t)]
    n = len(ref)
    m = len(hyp)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        dp[i][0] = i
    for j in range(1, m + 1):
        dp[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            if ref[i - 1] == hyp[j - 1]:
                dp[i][j] = dp[i - 1][j - 1]
            else:
                dp[i][j] = min(
                    dp[i - 1][j] + 1,
                    dp[i][j - 1] + 1,
                    dp[i - 1][j - 1] + 1,
                )
    i, j = n, m
    sub = ins = delete = 0
    while i > 0 or j > 0:
        if i > 0 and j > 0 and ref[i - 1] == hyp[j - 1]:
            i -= 1
            j -= 1
        elif i > 0 and j > 0 and dp[i][j] == dp[i - 1][j - 1] + 1:
            sub += 1
            i -= 1
            j -= 1
        elif j > 0 and dp[i][j] == dp[i][j - 1] + 1:
            ins += 1
            j -= 1
        else:
            delete += 1
            i -= 1
    wer = None if n == 0 else round((sub + ins + delete) / n, 4)
    return WerResult(
        reference_count=n,
        substitutions=sub,
        insertions=ins,
        deletions=delete,
        wer=wer,
        reference_text=" ".join(ref),
        hypothesis_text=" ".join(hyp),
    )


def load_ground_truth_words(path: Path) -> dict[str, list[TranscriptWord]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if "per_track" in data:
        out: dict[str, list[TranscriptWord]] = {}
        for entry in data.get("per_track", []):
            track_id = str(entry["track_id"])
            words = [TranscriptWord.model_validate(w) for w in entry.get("words", [])]
            out[track_id] = words
        return out
    if "words" in data and "track_id" in data:
        return {str(data["track_id"]): [TranscriptWord.model_validate(w) for w in data["words"]]}
    raise ValueError(f"unsupported ground truth format: {path}")


def load_fixture_transcripts(fixture: Path) -> dict[str, list[TranscriptWord]]:
    tx_dir = fixture / "transcripts"
    out: dict[str, list[TranscriptWord]] = {}
    for path in sorted(tx_dir.glob("*.json")):
        if path.stem.endswith("_combined") or path.stem == "combined":
            continue
        if "_" in path.stem and len(path.stem.split("_")[-1]) >= 8:
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        if "words" not in data:
            continue
        track_id = str(data.get("track_id") or path.stem)
        out[track_id] = [TranscriptWord.model_validate(w) for w in data["words"]]
    return out


def clip_words_to_duration(
    words: list[TranscriptWord],
    max_duration_sec: float,
) -> list[TranscriptWord]:
    return [w for w in words if w.start < max_duration_sec]


def accuracy_for_track(
    *,
    track_id: str,
    reference_words: list[TranscriptWord],
    hypothesis: Transcript,
) -> WerResult:
    windows = speech_windows(reference_words)
    ref_tokens = tokens_from_words(reference_words)
    hyp_words = words_in_windows(hypothesis.words, windows)
    hyp_tokens = tokens_from_words(hyp_words)
    return word_error_rate(ref_tokens, hyp_tokens)

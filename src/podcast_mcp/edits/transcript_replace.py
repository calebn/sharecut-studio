from __future__ import annotations

import hashlib
import json
import unicodedata
from dataclasses import dataclass
from typing import Any

from podcast_mcp.edits.transcript_correct import build_phrase_replacement, correct_transcript_word
from podcast_mcp.edits.transcript_sync import rebuild_combined
from podcast_mcp.models import EpisodeProject, Transcript, TranscriptWord


def _token_parts(text: str) -> tuple[str, str, str]:
    start, end = 0, len(text)
    while start < end and unicodedata.category(text[start]).startswith("P"):
        start += 1
    while end > start and unicodedata.category(text[end - 1]).startswith("P"):
        end -= 1
    return text[:start], text[start:end], text[end:]


@dataclass(frozen=True)
class TranscriptReplacement:
    transcript: Transcript
    start: int
    words: tuple[TranscriptWord, ...]
    tokens: tuple[str, ...]

    def record(self) -> dict[str, Any]:
        return {
            "track_id": self.transcript.track_id,
            "source_id": self.transcript.source_id,
            "start_word_index": self.start,
            "end_word_index": self.start + len(self.words) - 1,
            "before": " ".join(word.text for word in self.words),
            "after": " ".join(self.tokens),
            "start": self.words[0].start,
            "end": self.words[-1].end,
            "retimes_words": len(self.words) != len(self.tokens),
        }


@dataclass(frozen=True)
class TranscriptReplacementPlan:
    matches: tuple[TranscriptReplacement, ...]
    skipped_words: int
    token: str

    def preview(self) -> dict[str, Any]:
        return {
            "matches": [match.record() for match in self.matches],
            "count": len(self.matches),
            "skipped_words": self.skipped_words,
            "preview_token": self.token,
        }


def plan_transcript_replacement(
    project: EpisodeProject, search: str, replacement: str, *, match_case: bool = False
) -> TranscriptReplacementPlan:
    query = tuple(_token_parts(token)[1] for token in search.split())
    new_tokens = tuple(replacement.split())
    if not query or not all(query):
        raise ValueError("Enter a word or phrase to find.")
    if not new_tokens or not all(any(char.isalnum() for char in token) for token in new_tokens):
        raise ValueError("Each replacement token must contain a letter or number.")
    normalized = query if match_case else tuple(token.casefold() for token in query)
    matches: list[TranscriptReplacement] = []
    skipped = 0
    keys = [transcript.key for transcript in project.transcripts]
    if len(set(keys)) != len(keys):
        raise ValueError("Transcript source identities are ambiguous; regenerate the transcript.")
    for transcript in project.transcripts:
        words = transcript.words
        skipped += sum(bool(word.suppressed or word.ignored) for word in words)
        index = 0
        while index + len(query) <= len(words):
            selected = tuple(words[index : index + len(query)])
            parts = tuple(_token_parts(word.text) for word in selected)
            values = tuple(part[1] if match_case else part[1].casefold() for part in parts)
            if any(word.suppressed or word.ignored for word in selected) or values != normalized:
                index += 1
                continue
            if len(selected) == len(new_tokens):
                tokens = tuple(
                    ("" if _token_parts(token)[0] else part[0])
                    + token
                    + ("" if _token_parts(token)[2] else part[2])
                    for part, token in zip(parts, new_tokens, strict=True)
                )
            else:
                tokens = (
                    ("" if _token_parts(new_tokens[0])[0] else parts[0][0]) + new_tokens[0],
                    *new_tokens[1:],
                )
                tokens = (
                    *tokens[:-1],
                    tokens[-1] + ("" if _token_parts(new_tokens[-1])[2] else parts[-1][2]),
                )
            if tokens != tuple(word.text for word in selected):
                matches.append(TranscriptReplacement(transcript, index, selected, tokens))
            index += len(query)
    fingerprint = {
        "search": search,
        "replacement": replacement,
        "match_case": match_case,
        "matches": [
            {**match.record(), "words": [word.model_dump(mode="json") for word in match.words]}
            for match in matches
        ],
    }
    token = hashlib.sha256(json.dumps(fingerprint, sort_keys=True).encode()).hexdigest()
    return TranscriptReplacementPlan(tuple(matches), skipped, token)


def apply_transcript_replacement(project: EpisodeProject, plan: TranscriptReplacementPlan) -> int:
    grouped: dict[tuple[str, str | None], list[TranscriptReplacement]] = {}
    for match in plan.matches:
        grouped.setdefault(match.transcript.key, []).append(match)
    for matches in grouped.values():
        transcript = matches[0].transcript
        if len(matches[0].words) == len(matches[0].tokens):
            for match in matches:
                for offset, text in enumerate(match.tokens):
                    correct_transcript_word(transcript, match.start + offset, text)
        else:
            words: list[TranscriptWord] = []
            cursor = 0
            for match in matches:
                words.extend(transcript.words[cursor : match.start])
                words.extend(
                    build_phrase_replacement(
                        match.words,
                        " ".join(match.tokens),
                        preserve_audibility_lock=True,
                    )
                )
                cursor = match.start + len(match.words)
            words.extend(transcript.words[cursor:])
            transcript.words = words
        transcript.user_edited = True
    if plan.matches:
        rebuild_combined(project)
    return len(plan.matches)

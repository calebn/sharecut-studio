from __future__ import annotations

import re
from pathlib import Path

from podcast_mcp.models import Transcript, TranscriptWord
from podcast_mcp.models.words_revision import set_word, set_words, words_revision

SRC = Path(__file__).resolve().parents[1] / "src" / "podcast_mcp"
WRITER = SRC / "models" / "words_revision.py"
WORDS_ASSIGNMENT = re.compile(r"\.words(\[[^\]\n]*\])?\s*=(?!=)")
ALLOWLIST: dict[str, int] = {}


def _word(text: str, start: float) -> TranscriptWord:
    return TranscriptWord(text=text, start=start, end=start + 0.2)


def test_transcript_words_are_written_only_through_set_word_and_set_words():
    found: dict[str, int] = {}
    for path in sorted(SRC.rglob("*.py")):
        if path == WRITER:
            continue
        count = sum(
            1
            for line in path.read_text(encoding="utf-8").splitlines()
            if WORDS_ASSIGNMENT.search(line.split("#", 1)[0])
        )
        if count:
            found[str(path.relative_to(SRC))] = count

    assert found == ALLOWLIST


def test_set_word_replaces_one_word_and_moves_the_revision():
    transcript = Transcript(track_id="a", words=[_word("a", 0.0), _word("b", 1.0)])
    before = words_revision()

    set_word(transcript, 1, _word("c", 1.0))

    assert [w.text for w in transcript.words] == ["a", "c"]
    assert words_revision() != before


def test_set_words_replaces_the_list_and_moves_the_revision():
    transcript = Transcript(track_id="a", words=[_word("a", 0.0)])
    before = words_revision()

    set_words(transcript, [_word("x", 0.0), _word("y", 1.0)])

    assert [w.text for w in transcript.words] == ["x", "y"]
    assert words_revision() != before

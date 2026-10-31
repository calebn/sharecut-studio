from __future__ import annotations

import ast
from pathlib import Path

from podcast_mcp.models import Transcript, TranscriptWord
from podcast_mcp.models.words_revision import set_word, set_words, words_revision

SRC = Path(__file__).resolve().parents[1] / "src" / "podcast_mcp"
WRITER = SRC / "models" / "words_revision.py"
LIST_MUTATORS = frozenset(
    {"append", "extend", "insert", "pop", "remove", "clear", "sort", "reverse"}
)
ALLOWLIST: dict[str, int] = {}


def _is_words(node: ast.AST) -> bool:
    return isinstance(node, ast.Attribute) and node.attr == "words"


def _writes_words(target: ast.AST) -> bool:
    if isinstance(target, ast.Tuple | ast.List):
        return any(_writes_words(element) for element in target.elts)
    if isinstance(target, ast.Starred):
        return _writes_words(target.value)
    if isinstance(target, ast.Subscript):
        return _is_words(target.value)
    return _is_words(target)


def _word_writes(tree: ast.AST) -> int:
    count = 0
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            count += sum(_writes_words(target) for target in node.targets)
        elif isinstance(node, ast.AugAssign | ast.AnnAssign):
            count += _writes_words(node.target)
        elif isinstance(node, ast.Delete):
            count += sum(_writes_words(target) for target in node.targets)
        elif (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr in LIST_MUTATORS
            and _is_words(node.func.value)
        ):
            count += 1
    return count


def _word(text: str, start: float) -> TranscriptWord:
    return TranscriptWord(text=text, start=start, end=start + 0.2)


def test_transcript_words_are_written_only_through_set_word_and_set_words():
    found: dict[str, int] = {}
    for path in sorted(SRC.rglob("*.py")):
        if path == WRITER:
            continue
        count = _word_writes(ast.parse(path.read_text(encoding="utf-8"), filename=str(path)))
        if count:
            found[str(path.relative_to(SRC))] = count

    assert found == ALLOWLIST


def test_the_scan_sees_every_form_of_word_write():
    source = (
        "a.words = x\n"
        "a.words[i] = x\n"
        "a.words[idx[0]] += x\n"
        "a.words += x\n"
        "a.words, n = x, 1\n"
        "del a.words[0]\n"
        "a.words.append(w)\n"
        "a.words.sort()\n"
        "b.words_total = 1\n"
        "a.words[0].suppressed = True\n"
    )

    assert _word_writes(ast.parse(source)) == 8


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

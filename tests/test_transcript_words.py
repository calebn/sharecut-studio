from __future__ import annotations

import copy
import operator
import pickle

import pytest

from podcast_mcp.models import Transcript, TranscriptWord, TranscriptWords
from podcast_mcp.models.words_revision import words_revision


def _tr() -> Transcript:
    return Transcript(
        track_id="host",
        words=[
            TranscriptWord(text="a", start=0.0, end=0.2),
            TranscriptWord(text="b", start=0.3, end=0.5),
        ],
    )


def test_words_are_tracked_after_validation_default_and_round_trip():
    tr = _tr()
    assert isinstance(tr.words, TranscriptWords)
    assert isinstance(Transcript(track_id="h").words, TranscriptWords)
    round_tripped = Transcript.model_validate_json(tr.model_dump_json())
    assert isinstance(round_tripped.words, TranscriptWords)
    assert round_tripped.words == tr.words
    assert type(tr.model_dump()["words"]) is list


def test_assigning_words_wraps_and_bumps():
    tr = _tr()
    before = words_revision()
    tr.words = [TranscriptWord(text="c", start=0.0, end=0.1)]
    assert type(tr.words) is TranscriptWords
    assert words_revision() > before


def test_assigning_another_transcripts_words_copies_the_list():
    a = _tr()
    b = _tr()
    b.words = a.words
    assert b.words is not a.words
    assert b.words == a.words
    b.words.append(TranscriptWord(text="z", start=1.0, end=1.1))
    assert len(a.words) == 2
    assert Transcript(track_id="c", words=a.words).words is not a.words


_MUTATORS = [
    pytest.param(lambda words, w: words.__setitem__(0, w), id="setitem"),
    pytest.param(lambda words, w: operator.setitem(words, slice(0, 1), [w]), id="setitem_slice"),
    pytest.param(lambda words, w: operator.delitem(words, 0), id="delitem"),
    pytest.param(lambda words, w: operator.iadd(words, [w]), id="iadd"),
    pytest.param(lambda words, w: operator.imul(words, 2), id="imul"),
    pytest.param(lambda words, w: words.append(w), id="append"),
    pytest.param(lambda words, w: words.extend([w]), id="extend"),
    pytest.param(lambda words, w: words.insert(0, w), id="insert"),
    pytest.param(lambda words, w: words.pop(), id="pop"),
    pytest.param(lambda words, w: words.remove(words[0]), id="remove"),
    pytest.param(lambda words, w: words.clear(), id="clear"),
    pytest.param(lambda words, w: words.sort(key=lambda x: -x.start), id="sort"),
    pytest.param(lambda words, w: words.reverse(), id="reverse"),
]


@pytest.mark.parametrize("mutate", _MUTATORS)
def test_every_list_mutator_bumps_revision(mutate):
    tr = _tr()
    words = tr.words
    w = TranscriptWord(text="z", start=1.0, end=1.1)
    before = words_revision()
    result = mutate(words, w)
    assert words_revision() > before
    if isinstance(result, list):
        assert result is words
        assert isinstance(result, TranscriptWords)


def test_word_field_assignment_bumps_revision():
    tr = _tr()
    w = tr.words[0]
    before = words_revision()
    w.suspect_hallucination = True
    assert words_revision() > before
    before2 = words_revision()
    w.start = 1.0
    assert words_revision() > before2


def test_equal_word_field_assignment_does_not_bump():
    tr = _tr()
    w = tr.words[0]
    before = words_revision()
    w.suspect_hallucination = False
    w.start = 0.0
    w.text = "a"
    assert words_revision() == before
    w.suspect_hallucination = True
    assert words_revision() > before


def test_memoize_words_reuses_until_a_words_change():
    tr = _tr()
    other = _tr()
    calls = 0

    def compute():
        nonlocal calls
        calls += 1
        return "value"

    assert tr.memoize_words("k", compute) == "value"
    assert tr.memoize_words("k", compute) == "value"
    assert calls == 1

    tr.words[0].suppressed = True
    assert tr.memoize_words("k", compute) == "value"
    assert calls == 2

    # A change to a *different* transcript's words also invalidates (global revision).
    other.words[0].suppressed = True
    assert tr.memoize_words("k", compute) == "value"
    assert calls == 3

    calls_other_key = 0

    def compute_other():
        nonlocal calls_other_key
        calls_other_key += 1
        return "other"

    assert tr.memoize_words("k2", compute_other) == "other"
    assert tr.memoize_words("k2", compute_other) == "other"
    assert calls_other_key == 1


def test_copies_start_with_empty_memo_and_do_not_bump():
    tr = _tr()
    calls = 0

    def compute():
        nonlocal calls
        calls += 1
        return calls

    assert tr.memoize_words("k", compute) == 1
    assert tr.memoize_words("k", compute) == 1
    assert calls == 1

    revision_before = words_revision()

    deep = copy.deepcopy(tr)
    assert isinstance(deep.words, TranscriptWords)
    assert deep.memoize_words("k", compute) == 2
    assert words_revision() == revision_before

    model_deep = tr.model_copy(deep=True)
    assert isinstance(model_deep.words, TranscriptWords)
    assert model_deep.memoize_words("k", compute) == 3
    assert words_revision() == revision_before

    pickled = pickle.loads(pickle.dumps(tr))
    assert isinstance(pickled.words, TranscriptWords)
    assert pickled.memoize_words("k", compute) == 4
    assert words_revision() == revision_before

    shallow = tr.model_copy()
    assert shallow.words is tr.words
    assert shallow.memoize_words("k", compute) == 1


def test_memoize_words_on_untracked_list_computes_every_call():
    tr = _tr()
    untracked = tr.model_copy(update={"words": [TranscriptWord(text="x", start=0.0, end=0.1)]})
    assert type(untracked.words) is list
    calls = 0

    def compute():
        nonlocal calls
        calls += 1
        return calls

    assert untracked.memoize_words("k", compute) == 1
    assert untracked.memoize_words("k", compute) == 2
    assert calls == 2

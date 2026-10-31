"""Guest free text (notes, reasons, vocabulary terms) refuses control characters."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from podcast_mcp.gui.schemas import (
    GuestRefineDoneRequest,
    GuestRefineWaiveRequest,
    GuestVocabularyPutRequest,
)

BAD = ["a\x00b", "a\x07b", "a\x1b[31m", "a\x7fb", "a\u202eb", "a\x85b", "a\u2066b"]


@pytest.mark.parametrize("text", BAD)
def test_a_control_character_in_a_note_a_reason_or_a_term_is_refused(text: str) -> None:
    with pytest.raises(ValidationError):
        GuestRefineDoneRequest(notes=text)
    with pytest.raises(ValidationError):
        GuestRefineWaiveRequest(reason=text)
    with pytest.raises(ValidationError):
        GuestVocabularyPutRequest(terms=[text], guest_names=[], base_revision=None)
    with pytest.raises(ValidationError):
        GuestVocabularyPutRequest(terms=[], guest_names=[text], base_revision=None)


@pytest.mark.parametrize("text", ["a\nb", "a\r\nb", "a\u2028b", "a\u2029b"])
def test_a_vocabulary_term_is_a_single_line(text: str) -> None:
    with pytest.raises(ValidationError):
        GuestVocabularyPutRequest(terms=[text], guest_names=[], base_revision=None)
    with pytest.raises(ValidationError):
        GuestVocabularyPutRequest(terms=[], guest_names=[text], base_revision=None)
    assert GuestRefineDoneRequest(notes=text).notes == text


def test_line_breaks_and_tabs_stay_welcome_in_free_text() -> None:
    text = "first line\r\nsecond\tcolumn\nthird, with é and 日本語"
    assert GuestRefineDoneRequest(notes=text).notes == text
    assert GuestRefineWaiveRequest(reason=text).reason == text
    request = GuestVocabularyPutRequest(
        terms=["Kübler-Ross"], guest_names=["Zoë"], base_revision=None
    )
    assert request.terms == ["Kübler-Ross"]


def test_a_term_is_trimmed_and_a_tab_inside_it_is_kept() -> None:
    request = GuestVocabularyPutRequest(
        terms=["  Kübler-Ross\r\n", "Kübler\tRoss\n"], guest_names=["Zoë\r"], base_revision=None
    )
    assert request.terms == ["Kübler-Ross", "Kübler\tRoss"]
    assert request.guest_names == ["Zoë"]


@pytest.mark.parametrize("char", list("\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069"))
def test_every_bidi_override_and_isolate_is_refused(char: str) -> None:
    with pytest.raises(ValidationError):
        GuestRefineDoneRequest(notes=f"a{char}b")


def test_joiners_in_persian_and_emoji_text_are_kept_in_every_field() -> None:
    text = "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645 \U0001f469\u200d\U0001f4bb \U0001f3f3\ufe0f\u200d\U0001f308"
    assert GuestRefineDoneRequest(notes=text).notes == text
    assert GuestRefineWaiveRequest(reason=text).reason == text
    request = GuestVocabularyPutRequest(terms=[text], guest_names=[text], base_revision=None)
    assert request.terms == [text]

"""A speaker enrolled with no voice sample is refused, not left to cluster (#2053)."""

from __future__ import annotations

import pytest

from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.media import SpeakerService
from podcast_mcp.util.coded_error import CodedValueError
from test_speaker_split import mixed_ws  # noqa: F401


def _no_audio(*_args, **_kwargs):
    raise AssertionError("read audio")


@pytest.mark.parametrize("dry_run", [True, False])
def test_an_enrolled_name_with_no_spans_is_refused_before_any_audio_is_read(
    mixed_ws: ProjectWorkspace,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
    dry_run: bool,
) -> None:
    monkeypatch.setattr("podcast_mcp.services.media.speaker.load_mono_full", _no_audio)

    with pytest.raises(CodedValueError) as raised:
        SpeakerService(mixed_ws).split_speakers(
            "room",
            speaker_count=2,
            names=["Ana", "Ben"],
            enrollment={"Ana": [(0.5, 4.0)], "Ben": []},
            dry_run=dry_run,
        )

    assert raised.value.code == "enrollment_empty"
    assert str(raised.value) == (
        "Ben has no voice sample. Pick a stretch where only Ben is talking, or leave Ben out."
    )


def test_the_preflight_refuses_it_too(mixed_ws: ProjectWorkspace) -> None:  # noqa: F811
    with pytest.raises(CodedValueError) as raised:
        SpeakerService(mixed_ws).check_split(
            "room", speaker_count=2, names=["Ana", "Ben"], enrollment={"Ana": []}
        )

    assert raised.value.code == "enrollment_empty"
    assert "Ana has no voice sample" in str(raised.value)

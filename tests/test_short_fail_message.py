"""A failed job's one-line message names no host path, spaces in the path included."""

from __future__ import annotations

import pytest

from podcast_mcp.services.jobs.job import short_fail_message


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        (
            "ffmpeg failed: /Users/al/Shows/Episode 12 with Dani/raw/dani.wav: No such file or directory",
            "ffmpeg failed: No such file or directory",
        ),
        (
            "Could not read /Users/al/My Show: permission denied",
            "Could not read: permission denied",
        ),
        (r"Could not read C:\Users\Al Smith\Ep 12\raw\a.wav", "Could not read"),
        ("Could not read C:/Users/Al Smith/Ep 12/a.wav: gone", "Could not read: gone"),
        ("Could not read '/Users/al/My Show/a b.wav' twice", "Could not read twice"),
        ('Could not read "/Users/al/My Show/a b.wav" twice', "Could not read twice"),
        ("Could not read (/Users/al/My Show/a b.wav) twice", "Could not read twice"),
        (
            "copy /Users/al/My Show/a.wav: failed, then /Users/al/Other Show/b.wav: gone",
            "copy: failed, then: gone",
        ),
        ("cannot open /Users/al/My Show/a b.wav", "cannot open"),
        ("path=/Users/al/My Show/a b.wav: refused", "path=: refused"),
    ],
)
def test_an_absolute_path_is_removed_whole_with_its_spaces(line, expected):
    out = short_fail_message(line)
    assert out == expected
    for word in ("Show", "Smith", "Shows", "Dani", "Users", "wav", "Episode"):
        assert word not in (out or "")


@pytest.mark.parametrize(
    "line",
    [
        "No audio found for track host",
        "Download failed: https://example.com/models/a.bin: 404",
        "Could not read raw/a.wav: missing",
        "and/or retry, 50% done",
        "Unattended run will not auto-waive guest -35.60s (bleed)",
    ],
)
def test_a_relative_path_a_url_and_plain_text_stay(line):
    assert short_fail_message(line) == line


def test_an_empty_remainder_falls_back_to_the_phase():
    assert short_fail_message("/Users/al/My Show/a b.wav", phase="align") == "align"
    assert short_fail_message("'/Users/al/My Show': ", phase="mix") == "mix"
    assert short_fail_message(r"C:\Users\Al Smith\Ep 12", phase=None) is None


def test_the_cap_and_the_first_line_stay():
    assert len(short_fail_message("x" * 250) or "") == 200
    assert short_fail_message("first line /a b\nsecond") == "first line"

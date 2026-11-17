"""A failed job's one-line message names no host path, spaces in the path included."""

from __future__ import annotations

import pytest

from podcast_mcp.services.jobs.job import short_fail_message


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        (
            "ffmpeg failed: /Users/host/Shows/Episode 12 with Dani/raw/dani.wav: No such file or directory",
            "ffmpeg failed: No such file or directory",
        ),
        (
            "Could not read /Users/host/My Show: permission denied",
            "Could not read: permission denied",
        ),
        (r"Could not read C:\Users\Al Smith\Ep 12\raw\a.wav", "Could not read"),
        ("Could not read C:/Users/Al Smith/Ep 12/a.wav: gone", "Could not read: gone"),
        ("Could not read '/Users/host/My Show/a b.wav' twice", "Could not read twice"),
        ('Could not read "/Users/host/My Show/a b.wav" twice', "Could not read twice"),
        ("Could not read (/Users/host/My Show/a b.wav) twice", "Could not read twice"),
        (
            "copy /Users/host/My Show/a.wav: failed, then /Users/host/Other Show/b.wav: gone",
            "copy: failed, then: gone",
        ),
        ("cannot open /Users/host/My Show/a b.wav", "cannot open"),
        ("path=/Users/host/My Show/a b.wav: refused", "path=: refused"),
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
    assert short_fail_message("/Users/host/My Show/a b.wav", phase="align") == "align"
    assert short_fail_message("'/Users/host/My Show': ", phase="mix") == "mix"
    assert short_fail_message(r"C:\Users\Al Smith\Ep 12", phase=None) is None


def test_the_cap_and_the_first_line_stay():
    assert len(short_fail_message("x" * 250) or "") == 200
    assert short_fail_message("first line /a b\nsecond") == "first line"


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        (r"\\nas\share dir\a.wav: denied", "denied"),
        ("/Users/host/My Show/a.wav: No such file", "No such file"),
        ("C:\\Users\\Al Smith\\a.wav: gone", "gone"),
    ],
)
def test_a_path_that_opens_the_line_leaves_no_separator(line, expected):
    assert short_fail_message(line) == expected


def test_a_lone_slash_is_not_a_path():
    # The old per-token rule drops the bare slash (it did before the path rule existed); the
    # words around it stay.
    assert short_fail_message("Progress 50 / 100 frames") == "Progress 50 100 frames"
    assert short_fail_message("Progress 50 /") == "Progress 50"


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ("/Volumes/Backup/dani.wav is not a valid WAV", "is not a valid WAV"),
        ("/p/a.wav and /p/b.wav are the same file", "are the same file"),
        ("/Users/host/My Show/a b.wav is not a valid WAV", "is not a valid WAV"),
        ("'/Volumes/Backup/dani.wav is not a valid WAV", "is not a valid WAV"),
        ("/p", None),
        ("/Users/host/My Show/a b.wav", None),
        ("cannot open /Users/host/My Show/a b.wav", "cannot open"),
    ],
)
def test_a_path_that_opens_the_line_with_no_end_mark_ends_at_its_last_separator_token(
    line, expected
):
    out = short_fail_message(line)
    assert out == expected
    for word in ("Volumes", "Backup", "dani", "Show", "Users"):
        assert word not in (out or "")


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ("No such file '/home/host/Dani's Ep/raw/dani.wav'", "No such file"),
        ("failed (/home/host/My (v2) Ep/raw/dani.wav) because x", "failed because x"),
        ("failed [/home/host/My [v2] Ep/raw/dani.wav] because x", "failed because x"),
        ("No such file '/home/host/Dani's Ep/raw/dani.wav' twice", "No such file twice"),
    ],
)
def test_a_closer_only_closes_where_it_is_not_inside_a_word_and_brackets_nest(line, expected):
    out = short_fail_message(line)
    assert out == expected
    for word in ("Dani", "Ep", "raw", "dani", "v2"):
        assert word not in (out or "")


def test_a_huge_first_line_is_only_examined_for_its_first_2000_characters():
    import time

    shapes = [
        ("'/a' " * 60000) + ": x",
        "'/a b' " * 40000,
        "(/a (b) " * 40000,
        "x " + ("/a b " * 60000),
    ]
    for shape in shapes:
        start = time.perf_counter()
        out = short_fail_message(shape)
        assert time.perf_counter() - start < 0.5
        assert out is None or len(out) <= 200

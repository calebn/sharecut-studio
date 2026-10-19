"""A context's stdout/stderr go to its own sink; everything else is untouched (#1733)."""

from __future__ import annotations

import contextvars
import sys
import threading

import pytest
import typer

from podcast_mcp.util.stream_routing import capture


def test_captured_output_reaches_the_sinks_not_the_console(
    capsys: pytest.CaptureFixture[str],
) -> None:
    seen_out: list[str] = []
    seen_err: list[str] = []
    with capture(stdout=seen_out.append, stderr=seen_err.append):
        print("plain")
        typer.echo("echoed")
        typer.echo("oops", err=True)
        assert sys.stdout.isatty() is False
    assert "".join(seen_out) == "plain\nechoed\n"
    assert "".join(seen_err) == "oops\n"
    assert capsys.readouterr() == ("", "")


def test_output_outside_a_capture_reaches_the_console(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with capture(stdout=lambda _text: None, stderr=lambda _text: None):
        pass
    print("after")
    assert capsys.readouterr().out == "after\n"


def test_two_contexts_at_once_keep_their_own_output(
    capsys: pytest.CaptureFixture[str],
) -> None:
    results: dict[str, list[str]] = {"a": [], "b": []}
    both_inside = threading.Barrier(2)

    def run(name: str) -> None:
        with capture(stdout=results[name].append, stderr=lambda _text: None):
            both_inside.wait(10)
            print(f"from {name}")
            both_inside.wait(10)

    threads = [
        threading.Thread(target=contextvars.Context().run, args=(run, name)) for name in results
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    assert "".join(results["a"]) == "from a\n"
    assert "".join(results["b"]) == "from b\n"


def test_a_thread_the_command_starts_writes_to_the_console(
    capsys: pytest.CaptureFixture[str],
) -> None:
    seen: list[str] = []
    with capture(stdout=seen.append, stderr=lambda _text: None):
        worker = threading.Thread(target=print, args=("from a worker",))
        worker.start()
        worker.join(10)
    assert seen == []
    assert capsys.readouterr().out == "from a worker\n"

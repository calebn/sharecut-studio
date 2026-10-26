"""Hand a project command to the Studio that serves the project (#1733).

Two halves share one argument reader. The CLI side (``try_hand_off``) decides whether a
command belongs to a project a Studio is serving and, if so, sends it there and relays the
output. The Studio side (``execute_command``) runs the same ``podcast`` app in a worker
thread with its output routed back to the caller. Running the unmodified command in Studio
keeps every flag, refusal and edit-log attribution identical to a direct run; the only
difference is that Studio, not a second process, writes the project.

A command is handed off only when it names a ``--project`` and is not one of the groups
that act on the caller's machine (the viewer itself, audio playback, recording, tunnels,
setup). Relative paths in the arguments are made absolute first, because Studio's working
directory is not the caller's.
"""

from __future__ import annotations

import contextlib
import os
import sys
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import typer

from podcast_mcp import settings
from podcast_mcp.cli.cancel import bind_handoff_cancel
from podcast_mcp.services.app import (
    DIRECT_ENV_VAR,
    HandoffLost,
    HandoffRefused,
    StudioHost,
    StudioUnresponsive,
    hand_off,
    locate_studio,
)
from podcast_mcp.util.project_state import render_cancel_scope
from podcast_mcp.util.stream_routing import Sink, capture

#: Top-level commands that never run in Studio: they start the viewer, act on the caller's
#: audio device, microphone or terminal, manage the install, or take no project.
NOT_HANDED_OFF = frozenset(
    {
        "gui",
        "play",
        "record",
        "tunnel",
        "relay",
        "fixture",
        "config",
        "setup",
        "doctor",
        "bootstrap",
        "session",
    }
)
# Set while Studio runs a handed-off command: that command is already in the one writer,
# so it must not hand itself off again.
_running_for_caller: ContextVar[bool] = ContextVar("running_for_caller", default=False)
_HELP_TOKENS = frozenset({"--help", "-h"})
_PROJECT_OPTION = "--project"


@dataclass(frozen=True)
class HandoffPlan:
    """A command ready to run in Studio: every path in ``argv`` is absolute."""

    argv: list[str]
    project: Path


# Typer vendors its own click, so the command objects here are duck-typed: a group has
# ``commands``, a parameter says whether it is an ``option`` or an ``argument``, and a path
# parameter's type is named ``path`` (or ``filename`` for a file argument).
Command = Any
Parameter = Any


def is_group(command: Command) -> bool:
    return hasattr(command, "commands")


def is_option(param: Parameter) -> bool:
    return param.param_type_name == "option"


def _options(command: Command) -> dict[str, Parameter]:
    return {
        name: param
        for param in command.params
        if is_option(param)
        for name in (*param.opts, *param.secondary_opts)
    }


def takes_path(param: Parameter) -> bool:
    return bool(param.type.name in {"path", "filename"})


def _absolute(value: str, cwd: Path) -> str:
    # Resolve symlinks first, as the OS does for a direct run (``link/..`` is not lexical).
    return os.path.realpath(cwd / Path(value).expanduser())


def _split_root_options(root: Command, argv: list[str]) -> tuple[list[str], list[str]] | None:
    """Split ``argv`` into the root group's own flags and the subcommand tokens."""
    options = _options(root)
    index = 0
    while index < len(argv) and argv[index].startswith("-"):
        option = options.get(argv[index])
        if option is None or not option.is_flag:
            return None
        index += 1
    return argv[:index], argv[index:]


def _resolve_leaf(root: Command, tokens: list[str]) -> tuple[Command, str, list[str]] | None:
    """The leaf command the tokens name, its top-level group name and its own tokens."""
    if not tokens:
        return None
    top = tokens[0]
    command = root
    while is_group(command):
        if not tokens or tokens[0].startswith("-"):
            return None
        found = command.commands.get(tokens[0])
        if found is None:
            return None
        command, tokens = found, tokens[1:]
    return command, top, tokens


def _absolutize(
    leaf: Command, tokens: list[str], cwd: Path
) -> tuple[list[str], Path | None] | None:
    """Make the path arguments absolute; return the tokens and the ``--project`` path.

    None when the tokens cannot be read safely (an unknown flag shape, a path read from
    stdin), so the command runs directly.
    """
    options = _options(leaf)
    out = list(tokens)
    positional: list[int] = []
    project: Path | None = None
    index = 0
    while index < len(out):
        token = out[index]
        if token == "--":
            positional.extend(range(index + 1, len(out)))
            break
        if token.startswith("-") and token != "-":
            name, equals, inline = (
                token.partition("=") if token.startswith("--") else (token, "", "")
            )
            param = options.get(name)
            if param is None:
                return None
            if param.is_flag or param.count:
                index += 1
                continue
            if param.nargs != 1:
                return None
            if equals:
                value, slot = inline, None
            else:
                if index + 1 >= len(out):
                    return None
                value, slot = out[index + 1], index + 1
            if takes_path(param):
                if value == "-":
                    return None
                value = _absolute(value, cwd)
                if equals:
                    out[index] = f"{name}={value}"
                elif slot is not None:
                    out[slot] = value
            if name == _PROJECT_OPTION:
                project = Path(value)
            index += 1 if equals else 2
            continue
        positional.append(index)
        index += 1
    arguments = [p for p in leaf.params if not is_option(p)]
    cursor = 0
    for argument in arguments:
        take = len(positional) - cursor if argument.nargs == -1 else argument.nargs
        slots = positional[cursor : cursor + take]
        cursor += take
        if takes_path(argument):
            for slot in slots:
                if out[slot] == "-":
                    return None
                out[slot] = _absolute(out[slot], cwd)
    return out, project


def plan_handoff(root: Command, argv: list[str], cwd: Path) -> HandoffPlan | None:
    """The handoff for ``argv`` (everything after ``podcast``), or None to run it directly."""
    if any(token in _HELP_TOKENS for token in argv):
        return None
    split = _split_root_options(root, argv)
    if split is None:
        return None
    root_flags, tokens = split
    resolved = _resolve_leaf(root, tokens)
    if resolved is None:
        return None
    leaf, top, leaf_tokens = resolved
    if top in NOT_HANDED_OFF:
        return None
    absolutized = _absolutize(leaf, leaf_tokens, cwd)
    if absolutized is None or absolutized[1] is None:
        return None
    named = tokens[: len(tokens) - len(leaf_tokens)]
    return HandoffPlan([*root_flags, *named, *absolutized[0]], absolutized[1])


def _root_flags(ctx: Any) -> list[str]:
    flags: list[str] = []
    if ctx.params.get("progress") is False:
        flags.append("--no-progress")
    if ctx.params.get("json_progress"):
        flags.append("--json-progress")
    if ctx.params.get("no_input"):
        flags.append("--no-input")
    return flags


def try_hand_off(root: Command, ctx: Any) -> int | None:
    """Run the invoked command in the Studio serving its project; None means run it here."""
    if ctx.resilient_parsing or _running_for_caller.get() or settings.raw(DIRECT_ENV_VAR):
        return None
    sub_tokens = [*getattr(ctx, "_protected_args", []), *ctx.args]
    plan = plan_handoff(root, [*_root_flags(ctx), *sub_tokens], Path.cwd())
    if plan is None:
        return None
    try:
        host = locate_studio(plan.project)
    except StudioUnresponsive as silent:
        typer.echo(f"Error: {silent}", err=True)
        return 1
    if host is None:
        return None
    try:
        return hand_off(
            host,
            argv=plan.argv,
            project=str(plan.project),
            cwd=str(Path.cwd()),
            out=sys.stdout,
            err=sys.stderr,
        )
    except HandoffRefused as refusal:
        if refusal.code in _RUN_DIRECT_CODES:
            if refusal.code in _SAY_DIRECT_CODES:
                typer.echo(f"Note: {refusal.detail} Writing directly instead.", err=True)
            return None
        typer.echo(_refused_message(host, refusal), err=True)
        return 1
    except HandoffLost as lost:
        typer.echo(f"Error: {lost}", err=True)
        return 1


#: Studio is not the writer for this command (stale announcement, another project, an older
#: or newer build): nothing is lost by writing directly.
_RUN_DIRECT_CODES = frozenset(
    {"unreachable", "not_served", "not_eligible", "protocol", "env_differs"}
)
_SAY_DIRECT_CODES = frozenset({"protocol", "env_differs"})


def _refused_message(host: StudioHost, refusal: HandoffRefused) -> str:
    return (
        f"Error: Studio (pid {host.pid}) is serving this project but would not run the command: "
        f"{refusal.detail} Close the project in Studio, or set {DIRECT_ENV_VAR}=1 to write "
        "directly (this can fail with 'Project is busy' while Studio holds the project)."
    )


@contextmanager
def _cancel_scope(cancel: Callable[[], bool]) -> Iterator[None]:
    with contextlib.ExitStack() as stack:
        stack.enter_context(render_cancel_scope(cancel))
        stack.enter_context(bind_handoff_cancel(cancel))
        yield


def execute_command(
    argv: list[str], *, cancel: Callable[[], bool], stdout: Sink, stderr: Sink
) -> int:
    """Run ``podcast <argv>`` here, in this thread, and return its exit code.

    Output goes to the sinks, not Studio's console. ``cancel`` is polled by anything that
    honours a cancel request (pipeline steps, render waits), so Ctrl+C in the caller stops
    the command the way it does a direct run.
    """
    from podcast_mcp.cli.main import app

    token = _running_for_caller.set(True)
    try:
        with capture(stdout=stdout, stderr=stderr), _cancel_scope(cancel):
            return _run(app, argv, stderr)
    finally:
        _running_for_caller.reset(token)


def _run(app: Any, argv: list[str], stderr: Sink) -> int:
    try:
        app(args=argv, prog_name="podcast", standalone_mode=True)
    except SystemExit as exit_:
        return _exit_code(exit_.code, stderr)
    return 0


def _exit_code(code: object, stderr: Sink) -> int:
    if code is None:
        return 0
    if isinstance(code, int):
        return code
    stderr(f"{code}\n")
    return 1

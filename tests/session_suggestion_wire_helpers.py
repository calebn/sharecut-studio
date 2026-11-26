"""Shared surfaces, runner and normalizer for the staged-session wire-pin modules."""

from __future__ import annotations

import itertools
import json
import re
from contextlib import nullcontext
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

from fastapi.testclient import TestClient
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp.tools import review as review_tools
from podcast_mcp.models import Clip, Track, TrackRole
from podcast_mcp.services.document import SessionSuggestionService
from podcast_mcp.services.document_sync import host_command_result, submit_host_document_command
from podcast_mcp.services.document_sync.handlers import session_suggestion as handlers
from test_record_replace_accept import SID, _stage_replace, _words
from test_record_session_preview import _insert, _replace, _stage_files
from test_record_session_takes import THREE_TAKES, _said

_ISO = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?\+00:00")
_CLIPS = re.compile(r"\bclip_[0-9a-f]{8}\b")
_HASH = re.compile(r'(?<=")[0-9a-f]{16}(?=")')
_CODED = re.compile(r"^(?P<message>.*) \(code (?P<code>[a-z_]+)\)$", re.S)
_CLIENTS = itertools.count()
_COMMANDS = {
    "skip": "SkipSessionSuggestion",
    "select": "SelectSessionTake",
    "accept": "AcceptSessionSuggestion",
}

ALL_SURFACES = ("service", "handler", "host", "mcp", "cli", "web")
READ_SURFACES = ("service", "mcp", "cli", "web")
COMMAND_SURFACES = ("service", "handler", "host", "mcp", "cli", "web")


@dataclass(frozen=True)
class Step:
    """One call: ``op`` is skip, takes, select, accept or list, or do (``fn(ws)``, no output)."""

    op: str
    take: int | None = None
    override: bool = False
    sid: str | None = None
    status: str | None = None
    fn: Any = None


@dataclass(frozen=True)
class Scenario:
    build: Any
    steps: tuple[Step, ...]
    surfaces: tuple[str, ...] = ALL_SURFACES
    context: Any = None


def dump(value: Any) -> str:
    return json.dumps(value, sort_keys=True)


def normalize(value: Any, ws: Any) -> Any:
    """Workspace paths become <ws>; timestamps, clip ids and 16-hex hashes become tokens."""
    text = dump(value)
    for root in {str(ws.path.parent), str(ws.path.parent.resolve())}:
        text = text.replace(root, "<ws>")
    seen: dict[str, str] = {}

    def token(match: re.Match[str], kind: str) -> str:
        return seen.setdefault(match.group(0), f"<{kind}{len(seen)}>")

    text = _ISO.sub("<ts>", text)
    text = _CLIPS.sub(lambda m: token(m, "clip:"), text)
    text = _HASH.sub(lambda m: token(m, "hash:"), text)
    return json.loads(text)


def _payload(step: Step, sid: str) -> dict[str, Any]:
    if step.op == "select":
        return {"suggestion_id": sid, "take_index": step.take}
    if step.op == "accept":
        return {
            "suggestion_id": sid,
            "take_index": step.take,
            "override_audio_checks": step.override,
        }
    return {"suggestion_id": sid}


def _error(exc: BaseException) -> dict[str, Any]:
    return {"error": {"code": getattr(exc, "code", None), "message": str(exc)}}


def _service(ws, step: Step, sid: str) -> Any:
    service = SessionSuggestionService(ws)
    if step.op == "skip":
        return service.skip(sid)
    if step.op == "takes":
        return service.takes(sid)
    if step.op == "select":
        return service.select_take(sid, step.take)
    if step.op == "list":
        return service.list(status=step.status)
    return service.accept(sid, take_index=step.take, override_audio_checks=step.override)


def _handler(ws, step: Step, sid: str) -> Any:
    payload = _payload(step, sid)
    if step.op == "skip":
        return handlers.skip_session_suggestion(ws, payload)
    if step.op == "select":
        return handlers.select_session_take(ws, payload)
    if step.op == "accept":
        return handlers.accept_session_suggestion(ws, payload)
    return _service(ws, step, sid)


def _host(ws, step: Step, sid: str) -> Any:
    if step.op in _COMMANDS:
        reply = submit_host_document_command(ws.path, _COMMANDS[step.op], _payload(step, sid))
        return host_command_result(reply)
    return _service(ws, step, sid)


def _mcp_raw(ws, step: Step, sid: str) -> str:
    path = str(ws.path)
    if step.op == "skip":
        raw = review_tools.skip_session_suggestion_tool(path, sid)
    elif step.op == "takes":
        raw = review_tools.list_session_takes_tool(path, sid)
    elif step.op == "select":
        raw = review_tools.select_session_take_tool(path, sid, step.take)
    elif step.op == "list":
        raw = review_tools.list_session_suggestions_tool(path, step.status or "")
    else:
        raw = review_tools.accept_session_suggestion_tool(path, sid, step.take, step.override)
    return raw


def _mcp(ws, step: Step, sid: str) -> Any:
    return json.loads(_mcp_raw(ws, step, sid))


def cli_args(ws, step: Step, sid: str) -> list[str]:
    base = ["--project", str(ws.path)]
    ident = ["--id", sid]
    if step.op == "list":
        args = ["review", "session-suggestions", *base]
        return [*args, "--status", step.status] if step.status is not None else args
    if step.op == "skip":
        return ["review", "skip-session-suggestion", *base, *ident]
    if step.op == "takes":
        return ["review", "session-takes", *base, *ident]
    if step.op == "select":
        return ["review", "select-session-take", *base, *ident, "--take", str(step.take)]
    args = ["review", "accept-session-suggestion", *base, *ident]
    if step.take is not None:
        args += ["--take", str(step.take)]
    if step.override:
        args.append("--override-audio-checks")
    return args


def cli_outcome(result) -> dict[str, Any]:
    """The JSON a CLI call printed, or its exit code with the words it gave on stderr."""
    if result.exit_code == 0:
        return {"ok": json.loads(result.stdout)}
    text = result.stderr.strip()
    match = _CODED.match(text)
    if match is not None and "\n" not in match.group("message"):
        return {"error": {"code": match.group("code"), "message": match.group("message")}}
    return {"cli_exit": result.exit_code, "stderr": result.stderr}


def _cli(ws, step: Step, sid: str) -> Any:
    return cli_outcome(CliRunner().invoke(app, cli_args(ws, step, sid)))


def web_error(reply) -> dict[str, Any]:
    detail = reply.json()["detail"]
    message = detail["detail"] if isinstance(detail, dict) else detail
    return {"error": {"code": reply.headers.get("X-Sharecut-Error-Code"), "message": message}}


def web_reply(ws, step: Step, sid: str, *, route: bool):
    """The HTTP reply for ``step``: the read and select routes, or the document command."""
    query = {"path": str(ws.path), "suggestion_id": sid}
    with TestClient(create_app()) as client:
        if route and step.op == "takes":
            return client.get("/api/session-suggestion/takes", params=query)
        if route and step.op == "select":
            return client.post(
                "/api/session-suggestion/select-take", params={**query, "take_index": step.take}
            )
        return client.post(
            f"/api/document/command?path={quote(str(ws.path))}",
            json={
                "type": _COMMANDS[step.op],
                "payload": _payload(step, sid),
                "client_id": f"wire-{next(_CLIENTS)}",
                "client_seq": 1,
            },
        )


def _web(ws, step: Step, sid: str) -> Any:
    if step.op not in _COMMANDS and step.op != "takes":
        return _service(ws, step, sid)
    route = step.op == "takes" or step.op == "select"
    reply = web_reply(ws, step, sid, route=route)
    if reply.status_code != 200:
        return web_error(reply)
    return reply.json() if route else reply.json()["command"]["payload"]["result"]


_SURFACES = {
    "service": _service,
    "handler": _handler,
    "host": _host,
    "mcp": _mcp,
    "cli": _cli,
    "web": _web,
}


def call(surface: str, ws, step: Step, sid: str) -> dict[str, Any]:
    """One surface call as an outcome: ``{"ok": result}`` or ``{"error": {code, message}}``."""
    if surface == "cli":
        outcome = _cli(ws, step, sid)
        return outcome if outcome.keys() != {"ok"} else {"ok": normalize(outcome["ok"], ws)}
    try:
        result = _SURFACES[surface](ws, step, sid)
    except Exception as exc:
        return _error(exc)
    if isinstance(result, dict) and result.keys() == {"error"}:
        return result
    return {"ok": normalize(result, ws)}


def scrub(text: str, ws) -> str:
    """Raw text with the workspace path, timestamps and clip ids replaced."""
    for root in {str(ws.path.parent), str(ws.path.parent.resolve())}:
        text = text.replace(root, "<ws>")
    return _CLIPS.sub("<clip>", _ISO.sub("<ts>", text))


def _exception_shape(exc: BaseException) -> dict[str, Any]:
    return {"raised": type(exc).__name__, "code": getattr(exc, "code", None), "message": str(exc)}


def shape(surface: str, ws, step: Step, sid: str) -> dict[str, Any]:
    """What a surface hands back before any parsing: raw text, status, exit code or exception."""
    sid = sid if step.sid is None else step.sid
    if surface == "cli":
        result = CliRunner().invoke(app, cli_args(ws, step, sid))
        return {
            "exit_code": result.exit_code,
            "stdout": scrub(result.stdout, ws),
            "stderr": scrub(result.stderr, ws),
        }
    if surface == "mcp":
        try:
            return {"text": scrub(_mcp_raw(ws, step, sid), ws)}
        except Exception as exc:
            return _exception_shape(exc)
    if surface == "web":
        route = step.op in ("takes", "select")
        reply = web_reply(ws, step, sid, route=route)
        body = scrub(reply.text, ws) if route or reply.status_code != 200 else "<command reply>"
        return {
            "status": reply.status_code,
            "error_code": reply.headers.get("X-Sharecut-Error-Code"),
            "body": body,
        }
    try:
        result = _SURFACES[surface](ws, step, sid)
    except Exception as exc:
        return _exception_shape(exc)
    return {"returned": type(result).__name__, "keys": list(result)}


def raw(surface: str, ws, step: Step, sid: str) -> Any:
    """The parsed result of a successful call with its key order kept."""
    sid = sid if step.sid is None else step.sid
    result = _SURFACES[surface](ws, step, sid)
    return result["ok"] if surface == "cli" else result


def history_steps(ws) -> int:
    ws.reload()
    return len(ws.project.history.entries)


def run(ws, scenario: Scenario, surface: str) -> dict[str, Any]:
    """Build the scenario, run every step on ``surface``, give outcomes and history steps added."""
    sid = scenario.build(ws)
    base = history_steps(ws)
    outcomes = []
    added = []
    with scenario.context() if scenario.context else nullcontext():
        for step in scenario.steps:
            if step.op == "do":
                step.fn(ws)
                continue
            outcomes.append(call(surface, ws, step, sid if step.sid is None else step.sid))
            added.append(history_steps(ws) - base)
    return {"outcomes": outcomes, "history_steps_added": added}


def stage_replace(ws, from_sec, to_sec, takes, **kwargs) -> str:
    return _replace(ws, from_sec, to_sec, takes, **kwargs)


def stage_insert(ws, at_sec, durations, **kwargs) -> str:
    return _insert(ws, at_sec, durations, **kwargs)


def add_music_track(ws, *, clip_start: float = 8.0) -> None:
    def build(project) -> None:
        project.tracks.append(Track(id="music", label="Music", role=TrackRole.MUSIC))
        project.clips.append(
            Clip(
                id="music-bed",
                track_id="music",
                source_id="src-host",
                source_start=0.0,
                source_end=2.0,
                timeline_start=clip_start,
            )
        )

    ws.mutate("music", "musicked", build)


def guest_speech(ws) -> None:
    _words(ws, "guest", ("so", 2.5, 2.8), ("plan", 3.0, 3.4))


def stage_files(ws) -> None:
    ws.reload()
    _stage_files(ws)


def stage_unanchored_replace(ws, from_sec, to_sec, takes, **kwargs) -> str:
    sid = _stage_replace(ws, from_sec, to_sec, takes, capture=False, **kwargs)
    stage_files(ws)
    return sid


def say(ws, take_index: int, *texts: str) -> None:
    _said(ws, take_index, *texts)


__all__ = [
    "ALL_SURFACES",
    "COMMAND_SURFACES",
    "READ_SURFACES",
    "SID",
    "THREE_TAKES",
    "Scenario",
    "Step",
    "add_music_track",
    "call",
    "cli_args",
    "cli_outcome",
    "dump",
    "guest_speech",
    "history_steps",
    "normalize",
    "raw",
    "run",
    "say",
    "scrub",
    "shape",
    "stage_files",
    "stage_insert",
    "stage_replace",
    "stage_unanchored_replace",
    "web_error",
]

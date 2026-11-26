"""Render-state builders and surface runners shared by the render_status wire-pin modules."""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi.testclient import TestClient
from typer.testing import CliRunner

from edit_wire_helpers import build_workspace, write_wav
from podcast_mcp.cli.main import app
from podcast_mcp.engines.balance import balance_basis_digest
from podcast_mcp.engines.play_audit import (
    mix_gains,
    premix_path,
    write_premix_hash,
    write_stem_hash,
)
from podcast_mcp.engines.reconciliation_state import mark_reconciliation_fresh
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp.tools import timeline
from podcast_mcp.models.episode import BalanceBasis
from podcast_mcp.project.store import save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService
from podcast_mcp.util.tracks import stem_path

OLD = 1_700_000_000.0
NEW = 1_700_000_100.0


def stems(ws: ProjectWorkspace, host: float = 6.0, guest: float = 6.0) -> ProjectWorkspace:
    project = ProjectWorkspace.open(ws.path).project
    for tid, seconds in (("host", host), ("guest", guest)):
        write_wav(stem_path(project, tid), seconds)
        os.utime(stem_path(project, tid), (OLD, OLD))
    return ProjectWorkspace.open(ws.path)


def hashed(ws: ProjectWorkspace, *tracks: str) -> ProjectWorkspace:
    project = ProjectWorkspace.open(ws.path).project
    for tid in tracks:
        write_stem_hash(project, tid, defaults=ws.effective_config())
    return ProjectWorkspace.open(ws.path)


def premix(ws: ProjectWorkspace, mtime: float = NEW) -> ProjectWorkspace:
    project = ProjectWorkspace.open(ws.path).project
    write_wav(premix_path(project), 6.0)
    os.utime(premix_path(project), (mtime, mtime))
    write_premix_hash(
        project,
        mix_gains(project),
        trim_db=0.0,
        peak_ceiling_db=None,
        defaults=ws.effective_config(),
    )
    return ProjectWorkspace.open(ws.path)


def edit(ws: ProjectWorkspace, change: Callable[[Any], None]) -> ProjectWorkspace:
    project = ProjectWorkspace.open(ws.path).project
    change(project)
    save_project(project)
    return ProjectWorkspace.open(ws.path)


def fresh(root: Path) -> ProjectWorkspace:
    """Both stems hashed, a premix newer than them, reconciliation current."""
    ws = premix(hashed(stems(build_workspace(root)), "host", "guest"))
    return edit(ws, lambda p: mark_reconciliation_fresh(p, defaults=ws.effective_config()))


def fader(project) -> None:
    project.track_by_id("host").fader_db = -3.0


def muted(project) -> None:
    project.track_by_id("host").muted = True


def shorten_host_clip(project) -> None:
    project.timeline.clips[0].source_end = 5.0


def balance(project) -> None:
    project.track_by_id("host").balance_basis = BalanceBasis(
        digest="outdated", measured_lufs=-19.5, speech_gated=True
    )
    project.track_by_id("guest").balance_basis = BalanceBasis(
        digest=balance_basis_digest(project, "guest") or "", measured_lufs=-20.0, speech_gated=False
    )


def flagged(project) -> None:
    project.last_reconciliation_hash = "0123456789abcdef"
    project.reconciliation_stale = True


def service_status(ws: ProjectWorkspace) -> Any:
    return EditService(ws).render_status()


def mcp_status(ws: ProjectWorkspace) -> Any:
    return json.loads(timeline.render_status_tool(str(ws.path)))


def cli_status(ws: ProjectWorkspace) -> Any:
    result = CliRunner().invoke(app, ["edit", "render-status", "--project", str(ws.path)])
    assert result.exit_code == 0, result.output
    return json.loads(result.output)


def web_view(ws: ProjectWorkspace) -> dict[str, Any]:
    with TestClient(create_app()) as client:
        reply = client.get(f"/api/document/state?path={quote(str(ws.path))}&phase=full")
    assert reply.status_code == 200, reply.text
    return reply.json()["project"]


def web_status(ws: ProjectWorkspace) -> Any:
    status = web_view(ws)["render_status"]
    assert set(status["proxy_hashes"]) == {"host", "guest"}
    del status["proxy_hashes"]
    return status


STATUS_SURFACES = {
    "service": service_status,
    "mcp": mcp_status,
    "cli": cli_status,
    "web": web_status,
}

from __future__ import annotations

import json
import shutil
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi.testclient import TestClient

from e2e_fixture import E2E_DIALOGUE_PROJECT
from podcast_mcp.edits.range_target import build_range_target
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project
from podcast_mcp.models.episode import RangeInterval
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc

UNCLE = 1
MOODY = 6


@dataclass
class AlignedShareWorld:
    client: TestClient
    path: Path
    tokens: dict[str, str]

    def target(self, word_index: int) -> dict[str, Any]:
        project = load_project(self.path)
        word = project.transcripts[0].words[word_index]
        return build_range_target(
            project, [RangeInterval(start=word.start, end=word.end)], ["reference"]
        ).model_dump(mode="json")

    def host(self, type_: str, payload: dict[str, Any]):
        url = f"/api/document/command?path={quote(str(self.path))}"
        return self.client.post(url, json=_body(type_, payload, "viewer"))

    def guest(self, link: str, type_: str, payload: dict[str, Any]):
        url = f"/api/review/{self.tokens[link]}/daw/document/command"
        return self.client.post(url, json=_body(type_, payload, "guest"))

    def mcp(self, link: str, type_: str, payload: dict[str, Any]) -> dict[str, Any]:
        arguments = {"type": type_, "payload": payload, "command_id": f"cmd_{uuid.uuid4().hex}"}
        return handle_mcp_jsonrpc(
            self.tokens[link],
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "guest_submit_document_command", "arguments": arguments},
            },
        )


def _body(type_: str, payload: dict[str, Any], role: str) -> dict[str, Any]:
    return {
        "type": type_,
        "payload": payload,
        "client_id": f"c-{uuid.uuid4().hex[:6]}",
        "client_seq": None,
        "role": role,
        "command_id": f"cmd_{uuid.uuid4().hex}",
    }


def build_aligned_share_world(tmp_path: Path, links: Mapping[str, list[str]]) -> AlignedShareWorld:
    destination = tmp_path / "aligned"
    shutil.copytree(
        E2E_DIALOGUE_PROJECT.parent,
        destination,
        ignore=shutil.ignore_patterns("history", "export", "_build", "artifacts", "sync.db*"),
    )
    path = destination / "episode.sharecut"
    data = json.loads(path.read_text())
    data["meta"]["workspace_dir"] = str(destination)
    path.write_text(json.dumps(data))
    with write_grant(WriteGrantKind.DISPATCHER):
        workspace = ProjectWorkspace.open(path)
        workspace.project.artifacts_dir().mkdir(parents=True, exist_ok=True)
        shutil.copy(
            destination / "raw" / "reference.wav", workspace.project.artifacts_dir() / "premix.wav"
        )
        version = ReviewService(workspace).publish(label="fixture")["id"]
        tokens = {
            link: ShareService(workspace).create(
                review_version_id=version, capabilities=capabilities
            )["token"]
            for link, capabilities in links.items()
        }
    return AlignedShareWorld(TestClient(create_app()), path, tokens)

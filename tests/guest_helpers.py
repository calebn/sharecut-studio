"""Shared by the guest transcript tests: the seeded project and the small MCP/HTTP readers."""

from __future__ import annotations

import json
import wave

from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
from podcast_mcp.models import (
    MediaAsset,
    SourceRecording,
    Track,
    Transcript,
    TranscriptWord,
    load_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.share import lookup_share
from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc


def seed_transcript_project(minimal_project, sample_wav, *, with_take: bool) -> ProjectWorkspace:
    """A project with a host track and a three-word transcript (and a second take if asked)."""
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.artifacts_dir().mkdir(parents=True, exist_ok=True)
    (ws.project.artifacts_dir() / "premix.wav").write_bytes(sample_wav.read_bytes())
    for name in ("host", "take"):
        with wave.open(str(ws.project.raw_dir() / f"{name}.wav"), "wb") as audio:
            audio.setparams((1, 2, 1000, 0, "NONE", "not compressed"))
            audio.writeframes(bytes(20000))
    ws.project.tracks = [
        Track(
            id="host",
            label="Host",
            role="dialogue",
            media=MediaAsset(path="raw/host.wav", duration_sec=10, sample_rate=1000),
        )
    ]
    ws.project.sources = [
        SourceRecording(id="take", path="raw/take.wav", duration_sec=10, sample_rate=1000)
    ]
    ws.project.transcripts = [
        Transcript(
            track_id="host",
            user_edited=True,
            words=[
                TranscriptWord(text=text, start=i * 0.5, end=i * 0.5 + 0.4)
                for i, text in enumerate(["Hello", "there", "friends."])
            ],
        )
    ]
    if with_take:
        ws.project.transcripts.append(
            Transcript(
                track_id="host",
                source_id="take",
                words=[TranscriptWord(text="again", start=1.0, end=1.4)],
            )
        )
    ws.save()
    return ws


def raising(error):
    """A stand-in method that raises *error*."""

    def raiser(self, *_args, **_kwargs):
        raise error

    return raiser


def share_id(world, link: str = "editor") -> str:
    return lookup_share(world.tokens[link])["id"]


def sidecar(world) -> dict:
    return json.loads(REFINE_GATE.path(load_project(world.ws.path)).read_text())


def call_tool(world, name: str, arguments: dict | None = None, link: str = "editor") -> dict:
    """``tools/call`` of *name* on the *link* share of ``world.tokens``."""
    return handle_mcp_jsonrpc(
        world.tokens[link],
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments or {}},
        },
    )


def mcp_ok(res: dict):
    assert "error" not in res, res
    assert res["result"]["isError"] is False, res
    return res["result"]["structuredContent"]


def mcp_refusal(res: dict) -> tuple[str, str]:
    """The ``error_code`` and text of a tool-level refusal."""
    assert "error" not in res, res
    result = res["result"]
    assert result["isError"] is True, res
    return result["structuredContent"]["error_code"], result["content"][0]["text"]

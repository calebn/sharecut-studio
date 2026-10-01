"""Public media service boundary and lazy import contract."""

from __future__ import annotations

import importlib
import subprocess
import sys

import pytest


@pytest.mark.parametrize(
    ("name", "module"),
    [
        ("BounceService", "bounce"),
        ("IngestService", "ingest"),
        ("ensure_audio_in_workspace", "media_store"),
        ("presigned_proxy_urls", "proxy_media"),
        ("review_guest_audio_path", "review_media"),
        ("SpeakerService", "speaker"),
        ("TranscriptService", "transcript"),
        ("TranscriptPrecorrectService", "transcript_precorrect"),
        ("TranscriptRefineService", "transcript_refine"),
        ("tile_bytes", "waveform"),
    ],
)
def test_media_facade_resolves_original_object(name: str, module: str) -> None:
    facade = importlib.import_module("podcast_mcp.services.media")
    implementation = importlib.import_module(f"podcast_mcp.services.media.{module}")
    assert name in facade.__all__
    assert getattr(facade, name) is getattr(implementation, name)


def test_media_facade_rejects_unknown_name() -> None:
    facade = importlib.import_module("podcast_mcp.services.media")
    unknown = "missing_media_export"
    with pytest.raises(AttributeError, match="missing_media_export"):
        getattr(facade, unknown)


def test_media_facade_cold_import_does_not_load_implementations() -> None:
    script = """
import sys
import podcast_mcp.services.media
assert not any(name.startswith('podcast_mcp.services.media.') for name in sys.modules)
"""
    subprocess.run([sys.executable, "-c", script], check=True)

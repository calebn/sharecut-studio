from __future__ import annotations

import os
import subprocess
from unittest.mock import patch

from podcast_mcp.services.support.doctor import ffmpeg_probe_info


def test_missing_explicit_companion_reports_actionable_pair_failure(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("PODCAST_MCP_FFMPEG", raising=False)
    explicit = tmp_path / "custom-ffprobe"
    explicit.write_bytes(b"nonexecutable probe")
    monkeypatch.setenv("PATH", "")
    monkeypatch.setenv("PODCAST_MCP_FFPROBE", str(explicit))

    with (
        patch("podcast_mcp.util.binaries.run") as admission_probe,
        patch("podcast_mcp.util.process.run") as diagnostic_probe,
    ):
        info = ffmpeg_probe_info()

    admission_probe.assert_not_called()
    diagnostic_probe.assert_not_called()
    for name in ("ffmpeg", "ffprobe"):
        assert info[name]["ok"] is False
        assert info[name]["source"] == "unavailable"
        assert "executable ffmpeg sibling" in info[name]["version"]
        assert "Supply both explicit commands" in info[name]["version"]


def test_admitted_explicit_pair_retains_diagnostic_source(tmp_path, monkeypatch):
    for name in ("ffmpeg", "ffprobe"):
        command = tmp_path / (name + (".exe" if os.name == "nt" else ""))
        command.write_bytes(b"version probe fixture")
        command.chmod(0o755)
        monkeypatch.setenv(f"PODCAST_MCP_{name.upper()}", str(command))

    def version(argv, **kwargs):
        name = os.path.basename(argv[0]).removesuffix(".exe")
        assert argv[1:] == ["-version"]
        return subprocess.CompletedProcess(argv, 0, f"{name} version 9.0.2\n", "")

    with (
        patch("podcast_mcp.util.binaries.run", side_effect=version),
        patch("podcast_mcp.util.process.run", side_effect=version),
    ):
        info = ffmpeg_probe_info()
    assert info["ffmpeg"]["ok"] is True
    assert info["ffmpeg"]["source"] == "explicit"
    assert info["ffprobe"]["ok"] is True

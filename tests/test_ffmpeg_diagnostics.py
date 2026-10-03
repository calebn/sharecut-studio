from __future__ import annotations

import subprocess
from unittest.mock import patch

from podcast_mcp.services.support.doctor import ffmpeg_probe_info


def test_missing_pair_diagnostics_preserve_explicit_ffprobe(tmp_path, monkeypatch):
    from podcast_mcp.util import binaries

    monkeypatch.setattr(binaries.platform, "system", lambda: "Linux")
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("PODCAST_MCP_FFMPEG", raising=False)
    explicit = tmp_path / "explicit" / "custom-ffprobe"
    explicit.parent.mkdir()
    explicit.write_bytes(b"explicit probe")
    ambient = tmp_path / "ambient"
    ambient.mkdir()
    (ambient / "ffprobe").write_bytes(b"unrelated probe")
    monkeypatch.setenv("PATH", str(ambient))
    monkeypatch.setenv("PODCAST_MCP_FFPROBE", str(explicit))

    with patch("podcast_mcp.util.process.run") as run:
        run.return_value = subprocess.CompletedProcess(
            [str(explicit), "-version"], 0, "ffprobe version selected-build\n", ""
        )
        info = ffmpeg_probe_info()

    run.assert_called_once_with(
        [str(explicit), "-version"], capture_output=True, text=True, timeout=10
    )
    assert info["ffmpeg"]["ok"] is False
    assert info["ffprobe"] == {
        "ok": True,
        "version": "ffprobe version selected-build",
        "path": "custom-ffprobe",
    }

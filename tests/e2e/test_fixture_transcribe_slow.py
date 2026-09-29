from __future__ import annotations

import re

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.e2e_fixture import KNOWN_PHRASES
from podcast_mcp.models import load_project

pytestmark = [pytest.mark.e2e, pytest.mark.e2e_slow]
runner = CliRunner()


def test_live_transcribe(e2e_workspace) -> None:
    result = runner.invoke(
        app,
        ["transcribe", "--project", str(e2e_workspace)],
    )
    assert result.exit_code == 0, result.stdout + result.stderr
    proj = load_project(e2e_workspace)
    assert {t.track_id for t in proj.transcripts if t.words} >= {"reference", "guest"}
    heard = set(
        re.findall(r"[a-z']+", " ".join(w.text for t in proj.transcripts for w in t.words).lower())
    )
    missing = [p for p in KNOWN_PHRASES if p not in heard]
    assert not missing, f"live ASR missed {missing}; heard {sorted(heard)}"

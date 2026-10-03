from __future__ import annotations

import json

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.e2e_fixture import DEFAULT_CANNED
from podcast_mcp.models import load_project
from podcast_mcp.util.wer import tokens_from_text, word_error_rate

pytestmark = [pytest.mark.e2e, pytest.mark.e2e_slow]
runner = CliRunner()
WER_CEILING = 0.12


def test_live_transcribe(e2e_workspace) -> None:
    reference = json.loads(DEFAULT_CANNED.read_text(encoding="utf-8"))
    result = runner.invoke(
        app,
        ["transcribe", "--project", str(e2e_workspace), "--model", "base"],
    )
    assert result.exit_code == 0, result.stdout + result.stderr
    proj = load_project(e2e_workspace)
    transcripts = {t.track_id: t for t in proj.transcripts}
    assert {t.track_id for t in proj.transcripts if t.words} >= {"reference", "guest"}
    for track in reference["per_track"]:
        reference_text = " ".join(w["text"] for w in track["words"])
        hypothesis_text = " ".join(w.text for w in transcripts[track["track_id"]].words)
        assert (
            len(tokens_from_text(reference_text))
            == {"reference": 42, "guest": 24}[track["track_id"]]
        )
        score = word_error_rate(tokens_from_text(reference_text), tokens_from_text(hypothesis_text))
        assert score.wer is not None
        assert score.wer <= WER_CEILING, (
            f"{track['track_id']}: WER {score.wer:.1%} > {WER_CEILING:.0%}\n"
            f"ref: {reference_text}\nhyp: {hypothesis_text}"
        )

from __future__ import annotations

import pytest

from podcast_mcp.models import load_project
from podcast_mcp.pipeline.runner import PipelineRunner


def test_runner_records_error_and_reraises(minimal_project, monkeypatch):
    proj = load_project(minimal_project)

    def boom(_p, _d):
        raise RuntimeError("step failed")

    import podcast_mcp.pipeline.runner as runner_mod

    monkeypatch.setitem(runner_mod._STEP_MAP, "merge_transcript", boom)
    runner = PipelineRunner(defaults={})
    with pytest.raises(RuntimeError, match="step failed"):
        runner.run(proj, only_step="merge_transcript")
    run = proj.pipeline_runs[-1]
    assert run.steps[-1].status == "error"
    assert "step failed" in (run.steps[-1].message or "")

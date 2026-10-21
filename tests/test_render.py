from __future__ import annotations

from unittest.mock import MagicMock, patch

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines.reconciliation_state import mark_reconciliation_fresh
from podcast_mcp.models import EpisodeProject
from podcast_mcp.services.pipeline.preview import render_preview_result, rerender_preview
from podcast_mcp.util.progress import (
    RecordingProgress,
    bind_progress,
    progress_task,
    resolve_progress_task,
)


def test_rerender_preview_ok(tmp_path):
    proj = EpisodeProject.create("t", str(tmp_path))
    proj.ensure_dirs()
    premix = proj.artifacts_dir() / "premix.wav"
    premix.write_bytes(b"x")

    with (
        patch("podcast_mcp.services.pipeline.preview.PipelineRunner") as runner_cls,
        patch("podcast_mcp.services.pipeline.preview.maybe_auto_reconcile") as auto_rec,
    ):
        runner_cls.return_value.run = MagicMock()
        auto_rec.return_value = {"status_updates": 0}
        info = rerender_preview(proj, defaults=load_defaults())

    assert info["ok"] is True
    assert info["path"] == str(premix)
    auto_rec.assert_called_once()
    assert info["reconciliation"] == {"status_updates": 0, "stale": False}


def test_rerender_preview_nested_reconcile_does_not_blow_total(tmp_path):
    proj = EpisodeProject.create("t", str(tmp_path))
    proj.ensure_dirs()
    (proj.artifacts_dir() / "premix.wav").write_bytes(b"x")
    rec = RecordingProgress()

    def nested_reconcile(*_args, **_kwargs):
        with resolve_progress_task(
            "reconcile",
            "Reconciling",
            total=50,
            prefer_parent=False,
        ) as child:
            for _ in range(50):
                child.advance(1)
        return {"status_updates": 50}

    with (
        bind_progress(rec),
        progress_task("wrap", "Wrap", total=3, reporter=rec) as parent,
        patch("podcast_mcp.services.pipeline.preview.PipelineRunner") as runner_cls,
        patch(
            "podcast_mcp.services.pipeline.preview.maybe_auto_reconcile",
            side_effect=nested_reconcile,
        ),
    ):
        runner_cls.return_value.run = MagicMock()
        info = rerender_preview(proj, progress=rec, reconcile=True, defaults=load_defaults())

    assert info["ok"] is True
    assert parent.total == 3
    assert parent.current <= 3
    render_updates = [
        e for e in rec.events if e.task_id == "wrap" and e.kind == "update" and e.total is not None
    ]
    assert render_updates
    assert all(e.total == 3 for e in render_updates)
    assert any(e.kind == "start" and e.task_id == "reconcile" for e in rec.events)


def test_render_preview_result_without_file(tmp_path):
    proj = EpisodeProject.create("t", str(tmp_path))
    proj.ensure_dirs()
    out = render_preview_result(proj, rerender=False, defaults=load_defaults())
    assert '"ok": false' in out or '"ok": false' in out.replace(" ", "")


def test_render_preview_result_rerenders(tmp_path):
    proj = EpisodeProject.create("t", str(tmp_path))
    proj.ensure_dirs()
    premix = proj.artifacts_dir() / "premix.wav"
    premix.write_bytes(b"x")
    with (
        patch("podcast_mcp.services.pipeline.preview.PipelineRunner") as runner_cls,
        patch(
            "podcast_mcp.services.pipeline.preview.maybe_auto_reconcile",
            return_value={"status_updates": 1},
        ),
    ):
        runner_cls.return_value.run = MagicMock()
        out = render_preview_result(proj, rerender=True, defaults=load_defaults())
    assert '"ok": true' in out.replace(" ", "") or '"ok": true' in out
    assert "reconciliation" in out


def test_rerender_preview_skips_reconcile_and_missing_premix(tmp_path):
    proj = EpisodeProject.create("t", str(tmp_path))
    proj.ensure_dirs()

    with (
        patch("podcast_mcp.services.pipeline.preview.PipelineRunner") as runner_cls,
        patch("podcast_mcp.services.pipeline.preview.mark_reconciliation_stale") as stale,
    ):
        runner_cls.return_value.run = MagicMock()
        info = rerender_preview(proj, reconcile=False, defaults=load_defaults())

    assert info["ok"] is False
    assert info["path"] is None
    stale.assert_called_once()


def test_rerender_preview_skips_reconcile_when_fresh(tmp_path):
    proj = EpisodeProject.create("t", str(tmp_path))
    proj.ensure_dirs()
    (proj.artifacts_dir() / "premix.wav").write_bytes(b"x")
    mark_reconciliation_fresh(proj, defaults=load_defaults())

    with (
        patch("podcast_mcp.services.pipeline.preview.PipelineRunner") as runner_cls,
        patch("podcast_mcp.services.pipeline.preview.maybe_auto_reconcile") as auto_rec,
    ):
        runner_cls.return_value.run = MagicMock()
        info = rerender_preview(proj, reconcile=True, defaults=load_defaults())

    auto_rec.assert_not_called()
    assert info["ok"] is True
    assert "reconciliation" not in info
    assert proj.reconciliation_stale is False


def test_rerender_preview_clears_stale_flag_after_mix_when_audio_unchanged(tmp_path):
    proj = EpisodeProject.create("t", str(tmp_path))
    proj.ensure_dirs()
    (proj.artifacts_dir() / "premix.wav").write_bytes(b"x")
    mark_reconciliation_fresh(proj, defaults=load_defaults())

    def fake_run(project, *, only_step=None, progress=None, **kwargs):
        if only_step == "assemble_timeline":
            project.reconciliation_stale = True

    with (
        patch("podcast_mcp.services.pipeline.preview.PipelineRunner") as runner_cls,
        patch("podcast_mcp.services.pipeline.preview.maybe_auto_reconcile") as auto_rec,
    ):
        runner_cls.return_value.run = MagicMock(side_effect=fake_run)
        rerender_preview(proj, reconcile=True, defaults=load_defaults())

    auto_rec.assert_not_called()
    assert proj.reconciliation_stale is False


def test_rerender_preview_missing_premix_keeps_reconciliation(tmp_path):
    proj = EpisodeProject.create("t", str(tmp_path))
    proj.ensure_dirs()

    with (
        patch("podcast_mcp.services.pipeline.preview.PipelineRunner") as runner_cls,
        patch("podcast_mcp.services.pipeline.preview.maybe_auto_reconcile") as auto_rec,
    ):
        runner_cls.return_value.run = MagicMock()
        auto_rec.return_value = {"status_updates": 2}
        info = rerender_preview(proj, reconcile=True, defaults=load_defaults())

    assert info["ok"] is False
    assert info["reconciliation"] == {"status_updates": 2, "stale": False}

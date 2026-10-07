from __future__ import annotations

from typing import Any

from mcp.server import MCPServer

from podcast_mcp.mcp.args import JsonObject, JsonObjectList
from podcast_mcp.mcp.serialize import to_json
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.pipeline import PipelineService, format_export_qc_lines
from podcast_mcp.util.project_state import current_cancel_check


def _run_message(last_step: str, job_result: dict[str, Any] | None) -> str:
    """`Completed through <step>` plus the export QC verdict lines when this run exported."""
    qc = job_result or {}
    lines = [f"Completed through {last_step}"]
    lines.extend(format_export_qc_lines(qc.get("export_qc"), qc.get("export_qc_path")))
    return "\n".join(lines)


def pipeline_run(
    project_path: str,
    from_step: str | None = None,
    only_step: str | None = None,
    unattended: bool | None = None,
    skip_steps: list[str] | None = None,
    config: JsonObject | None = None,
    use_working_set: bool = True,
    force_transcribe: bool = False,
    retime_words: bool = False,
) -> str:
    """Run the production pipeline. Optional skip_steps (step names) / config (object) override yaml.

    When use_working_set is true (default), also reads/writes the GUI session
    working set so agents and Sharecut Studio share the same visible config.
    Omit ``unattended`` to leave the working-set Batch mode unchanged.
    Existing transcripts are reused; ``force_transcribe=true`` re-runs ASR for this run
    only (not persisted). ``retime_words=true`` re-times stored transcripts with the forced
    aligner from their ASR cache for this run only (no Whisper; hand-edited transcripts are
    skipped); check ``transcript_timing.json`` → ``forced_alignment.retime`` for skipped and
    failed tracks; not with ``force_transcribe``. It fails before changing any transcript
    when the word aligner is not downloaded (the error names
    ``podcast bootstrap --component word-aligner``). Forced alignment is otherwise on by
    default whenever that model is installed (``transcribe.forced_alignment.enabled`` unset);
    ``forced_alignment.reason`` in ``transcript_timing.json`` says what a run resolved to.
    Replacing edited transcripts is refused when
    ``unattended``; run attended, or the user confirms with Studio Re-transcribe.
    Returns ``Completed through <step>``; when this run exported, the next lines are
    the export QC verdict (same as CLI ``pipeline run``).
    """
    from podcast_mcp.services.pipeline import (
        config_store,
        merge_pipeline_config,
        skip_steps_from_enabled,
        transcribe_run_config,
    )

    ws = ProjectWorkspace.open(project_path)
    store = config_store()
    working = store.get(ws.path) if use_working_set else None

    if config is not None:
        config = merge_pipeline_config(config)
    elif working is not None:
        config = working.config

    if skip_steps is None and working is not None and working.enabled_steps is not None:
        skip_steps = skip_steps_from_enabled(working.enabled_steps)

    run_config = transcribe_run_config(config, force=force_transcribe, retime_words=retime_words)

    if use_working_set:
        store.put(ws.path, config=config, unattended=unattended)
    run_unattended = (
        bool(unattended)
        if unattended is not None
        else bool(working.unattended if working is not None else False)
    )
    from podcast_mcp.gui.jobs import studio_job_manager

    jobs = studio_job_manager()
    if jobs is not None:
        job = jobs.start(
            ws.path,
            from_step=from_step,
            only_step=only_step,
            skip_steps=skip_steps,
            unattended=run_unattended,
            config=run_config,
        )
        jobs.wait(job)
        if job.status == "error":
            raise RuntimeError(job.error or job.message or "Pipeline failed")
        if job.status == "cancelled":
            raise RuntimeError(job.message or "Pipeline cancelled")
        return _run_message(job.result_step or "", job.result)

    result = PipelineService(ws).run(
        from_step=from_step,
        only_step=only_step,
        skip_steps=skip_steps,
        unattended=run_unattended,
        config=run_config,
    )
    return _run_message(result.last_step, result.job_result())


def pipeline_get_config_tool(project_path: str) -> str:
    """Return effective pipeline config, step metadata, and param schema (same as GUI).

    ``forced_alignment`` is the resolved Precise word boundaries state (``enabled``,
    ``requested``, ``installed``, ``blocked``, ``reason``): on by default when the word
    aligner is downloaded, unavailable until then (#780).
    """
    from podcast_mcp.services.pipeline import build_config_payload

    ws = ProjectWorkspace.open(project_path)
    return to_json(build_config_payload(ws.path))


def pipeline_set_config_tool(
    project_path: str,
    config: JsonObject | None = None,
    enabled_steps: list[str] | None = None,
    unattended: bool | None = None,
    reset: bool = False,
) -> str:
    """Update the shared GUI/agent pipeline working set (visible params)."""
    from podcast_mcp.services.pipeline import build_config_payload, config_store

    ws = ProjectWorkspace.open(project_path)
    config_store().put(
        ws.path,
        config=config,
        enabled_steps=enabled_steps,
        unattended=unattended,
        reset=reset,
    )
    return to_json(build_config_payload(ws.path))


def pipeline_analyze_tool(project_path: str, apply: bool = False) -> str:
    """Heuristic Analyze: propose pipeline param patches from audio diagnostics."""
    from podcast_mcp.services.pipeline import analyze_working_set

    ws = ProjectWorkspace.open(project_path)
    return to_json(analyze_working_set(ws.path, ws.project, apply=apply))


def set_envelope(
    project_path: str,
    track_id: str,
    points: JsonObjectList,
    expected_points: JsonObjectList | None = None,
) -> str:
    """Set the volume automation envelope for a track from ``[{time, value}]`` points.

    Submits a ``SetEnvelope`` document command (same lock, conflict check, undo
    history, and GUI fanout as a DAW edit). ``expected_points`` is the
    ``[{id, time, value}]`` list you last read; if the envelope changed since,
    the call fails with a conflict instead of overwriting the edit. When
    omitted, the envelope as read at call time is the baseline.
    """
    from podcast_mcp.edits.envelopes import volume_envelope_baseline
    from podcast_mcp.services.document_sync import (
        host_command_result,
        submit_host_document_command,
    )

    if expected_points is None:
        expected_points = volume_envelope_baseline(
            ProjectWorkspace.open(project_path).project, track_id
        )
    result = submit_host_document_command(
        project_path,
        "SetEnvelope",
        {"track_id": track_id, "points": points, "expected_points": expected_points},
    )
    count = host_command_result(result).get("count", 0)
    return f"Envelope set for {track_id} ({count} points)"


def render_preview(project_path: str, rerender: bool = True) -> str:
    """Render a preview mix and return its status and path."""
    ws = ProjectWorkspace.open(project_path)
    info = PipelineService(ws).render_preview(rerender=rerender)
    return to_json(info)


def render_final(project_path: str) -> str:
    """Render the final mastered export and return its path."""
    ws = ProjectWorkspace.open(project_path)
    path = PipelineService(ws).render_final()
    return str(path)


def export_audio_tool(
    project_path: str,
    formats: JsonObjectList | None = None,
) -> str:
    """Encode mastered audio to export/ using pipeline.yaml formats, or ``formats`` objects.

    All or nothing: files replace ``export/`` only after every one is written. When the client
    cancels the request (``notifications/cancelled``) the encode stops, the tool raises
    ``CancelledProgress("Export cancelled")`` and an earlier export is left untouched. The
    client has stopped waiting by then, so the SDK sends no result for the cancelled request.
    """
    ws = ProjectWorkspace.open(project_path)
    result = PipelineService(ws).export_audio(formats, cancel_check=current_cancel_check())
    return to_json(result.job_result())


def bounce_audio_tool(
    project_path: str,
    track_ids: list[str] | None = None,
    start_s: float | None = None,
    end_s: float | None = None,
    formats: list[str] | None = None,
) -> str:
    """Bounce selected (or all) stems to export/bounces/ without mastering.

    Times are timeline seconds. ``track_ids`` lists the stems, or omit for all
    non-muted mixable tracks. ``formats`` lists extensions (e.g. ``["wav", "mp3"]``);
    default wav only.
    """
    from podcast_mcp.services.media import BounceRequest, BounceService

    ws = ProjectWorkspace.open(project_path)
    paths = BounceService(ws).bounce(
        BounceRequest(
            track_ids=track_ids,
            start_s=start_s,
            end_s=end_s,
            formats=formats,
        )
    )
    return to_json([str(p) for p in paths])


def register(mcp: MCPServer) -> None:
    """Register pipeline and render tools on the MCP server."""
    for fn in (
        pipeline_run,
        pipeline_get_config_tool,
        pipeline_set_config_tool,
        pipeline_analyze_tool,
        set_envelope,
        render_preview,
        render_final,
        export_audio_tool,
        bounce_audio_tool,
    ):
        mcp.tool()(fn)

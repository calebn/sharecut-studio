from __future__ import annotations

import json

from mcp.server import MCPServer

from podcast_mcp.mcp.serialize import to_json
from podcast_mcp.services import PipelineService, ProjectWorkspace


def pipeline_run(
    project_path: str,
    from_step: str | None = None,
    only_step: str | None = None,
    unattended: bool | None = None,
    skip_steps_json: str | None = None,
    config_json: str | None = None,
    use_working_set: bool = True,
) -> str:
    """Run the production pipeline. Optional skip_steps_json / config_json override yaml.

    When use_working_set is true (default), also reads/writes the GUI session
    working set so agents and Sharecut Studio share the same visible config.
    Omit ``unattended`` to leave the working-set Batch mode unchanged.
    """
    from podcast_mcp.services.pipeline_config import (
        config_store,
        merge_pipeline_config,
        skip_steps_from_enabled,
    )

    ws = ProjectWorkspace.open(project_path)
    store = config_store()
    working = store.get(ws.path) if use_working_set else None

    config = None
    if config_json:
        parsed = json.loads(config_json)
        if not isinstance(parsed, dict):
            raise ValueError("config_json must be a JSON object")
        config = merge_pipeline_config(parsed)
    elif working is not None:
        config = working.config

    skip_steps = None
    if skip_steps_json:
        parsed_skip = json.loads(skip_steps_json)
        if not isinstance(parsed_skip, list):
            raise ValueError("skip_steps_json must be a JSON array of step names")
        skip_steps = [str(s) for s in parsed_skip]
    elif working is not None and working.enabled_steps is not None:
        skip_steps = skip_steps_from_enabled(working.enabled_steps)

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
            config=config,
        )
        jobs.wait(job)
        if job.status == "error":
            raise RuntimeError(job.error or job.message or "Pipeline failed")
        if job.status == "cancelled":
            raise RuntimeError(job.message or "Pipeline cancelled")
        return f"Completed through {job.result_step or ''}"

    step = PipelineService(ws).run(
        from_step=from_step,
        only_step=only_step,
        skip_steps=skip_steps,
        unattended=run_unattended,
        config=config,
    )
    return f"Completed through {step}"


def pipeline_get_config_tool(project_path: str) -> str:
    """Return effective pipeline config, step metadata, and param schema (same as GUI)."""
    from podcast_mcp.services.pipeline_config import build_config_payload

    ws = ProjectWorkspace.open(project_path)
    return to_json(build_config_payload(ws.path))


def pipeline_set_config_tool(
    project_path: str,
    config_json: str | None = None,
    enabled_steps_json: str | None = None,
    unattended: bool | None = None,
    reset: bool = False,
) -> str:
    """Update the shared GUI/agent pipeline working set (visible params)."""
    from podcast_mcp.services.pipeline_config import build_config_payload, config_store

    ws = ProjectWorkspace.open(project_path)
    config = json.loads(config_json) if config_json else None
    enabled = json.loads(enabled_steps_json) if enabled_steps_json else None
    if config is not None and not isinstance(config, dict):
        raise ValueError("config_json must be a JSON object")
    if enabled is not None and not isinstance(enabled, list):
        raise ValueError("enabled_steps_json must be a JSON array")
    config_store().put(
        ws.path,
        config=config,
        enabled_steps=[str(s) for s in enabled] if enabled is not None else None,
        unattended=unattended,
        reset=reset,
    )
    return to_json(build_config_payload(ws.path))


def pipeline_analyze_tool(project_path: str, apply: bool = False) -> str:
    """Heuristic Analyze: propose pipeline param patches from audio diagnostics."""
    from podcast_mcp.services.pipeline_config import (
        build_config_payload,
        config_store,
        suggest_pipeline_tuning,
    )

    ws = ProjectWorkspace.open(project_path)
    working = config_store().get(ws.path)
    result = suggest_pipeline_tuning(ws.project, base_config=working.config)
    if apply:
        config_store().put(ws.path, config=result["proposed_config"])
        result["applied"] = True
        result["config"] = build_config_payload(ws.path)
    else:
        result["applied"] = False
    return to_json(result)


def set_envelope(
    project_path: str,
    track_id: str,
    points_json: str,
    expected_points_json: str | None = None,
) -> str:
    """Set the volume automation envelope for a track from JSON points.

    Submits a ``SetEnvelope`` document command (same lock, conflict check, undo
    history, and GUI fanout as a DAW edit). ``expected_points_json`` is the
    ``[{id, time, value}]`` list you last read; if the envelope changed since,
    the call fails with a conflict instead of overwriting the edit. When
    omitted, the envelope as read at call time is the baseline.
    """
    from podcast_mcp.edits.envelopes import volume_envelope_baseline
    from podcast_mcp.mcp.tools.agent_document import submit_host_document_command

    if expected_points_json is None:
        expected = volume_envelope_baseline(ProjectWorkspace.open(project_path).project, track_id)
    else:
        expected = json.loads(expected_points_json)
    result = submit_host_document_command(
        project_path,
        "SetEnvelope",
        {"track_id": track_id, "points": json.loads(points_json), "expected_points": expected},
    )
    payload = (result.get("command") or {}).get("payload") or {}
    count = (payload.get("result") or {}).get("count", 0)
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
    formats_json: str | None = None,
) -> str:
    """Encode mastered audio to export/ using pipeline.yaml formats or a JSON override."""
    ws = ProjectWorkspace.open(project_path)
    formats: list[dict] | None = None
    if formats_json:
        parsed = json.loads(formats_json)
        if not isinstance(parsed, list):
            raise ValueError("formats_json must be a JSON array of format objects")
        formats = parsed
    paths = PipelineService(ws).export_audio(formats)
    return to_json([str(p) for p in paths])


def bounce_audio_tool(
    project_path: str,
    track_ids_json: str | None = None,
    start_s: float | None = None,
    end_s: float | None = None,
    formats_json: str | None = None,
) -> str:
    """Bounce selected (or all) stems to export/bounces/ without mastering.

    Times are timeline seconds. ``track_ids_json`` is a JSON string array, or omit
    for all non-muted mixable tracks. ``formats_json`` is a JSON array of extensions
    (e.g. ``["wav","mp3"]``); default wav only.
    """
    from podcast_mcp.services import BounceRequest, BounceService

    ws = ProjectWorkspace.open(project_path)
    track_ids: list[str] | None = None
    if track_ids_json:
        parsed = json.loads(track_ids_json)
        if not isinstance(parsed, list) or not all(isinstance(x, str) for x in parsed):
            raise ValueError("track_ids_json must be a JSON array of strings")
        track_ids = parsed
    formats: list[str] | None = None
    if formats_json:
        parsed_fmt = json.loads(formats_json)
        if not isinstance(parsed_fmt, list) or not all(isinstance(x, str) for x in parsed_fmt):
            raise ValueError("formats_json must be a JSON array of extension strings")
        formats = parsed_fmt
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

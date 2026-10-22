"""MCP tools that download a model an action refused for (``model_needed``)."""

from __future__ import annotations

from mcp.server import MCPServer

from podcast_mcp.mcp.serialize import to_json
from podcast_mcp.services.pipeline import BootstrapRequest, run_bootstrap
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.progress import resolve_progress
from podcast_mcp.util.project_state import current_cancel_check


def model_download(component: str, whisper_model: str | None = None, upgrade: bool = False) -> str:
    """Download one model, only after the user agrees: ask first, never call this on your own.

    ``component`` is the ``model.id`` of a ``model_needed`` refusal (``whisper``, ``rnnoise``,
    ``word-aligner`` or ``speaker-ecapa``); ``whisper_model`` picks the Whisper size and
    ``upgrade`` re-fetches a model that no longer matches its pin. With ShareCut Studio running
    this starts a download job and returns its ``job_id``: poll ``model_download_status``.
    Without Studio it downloads in this call, which can take minutes for Whisper, and reports
    progress while it runs.
    """
    from podcast_mcp.services.jobs import studio_job_manager

    try:
        BootstrapRequest.of([component], whisper_model=whisper_model)
    except CodedValueError as exc:
        if exc.code != "bootstrap_components_unsupported":
            raise
        raise CodedValueError(
            f"unknown model {component!r}; pick the id from the model_needed refusal",
            code="unknown_model",
        ) from None
    jobs = studio_job_manager()
    if jobs is not None:
        job, adopted = jobs.start_bootstrap(
            components=[component], whisper_model=whisper_model, force=upgrade
        )
        return to_json(
            {
                "ok": True,
                "job_id": job.id,
                "adopted": adopted,
                "components": list(job.components),
                "message": f"Downloading {component}; poll model_download_status(job_id={job.id!r}).",
            }
        )
    out = run_bootstrap(
        [component],
        whisper_model=whisper_model,
        force=upgrade,
        progress=resolve_progress(),
        cancel_check=current_cancel_check(),
    )
    result = out["results"][component]
    return to_json({"ok": bool(result.get("ok")), "components": [component], "result": result})


def model_download_status(job_id: str | None = None) -> str:
    """Report a model download started by model_download: status, current file and any failure.

    Omit ``job_id`` for the latest download. Without ShareCut Studio there are no jobs, so
    the answer is ``{"running": false}``.
    """
    from podcast_mcp.services.jobs import studio_job_manager

    jobs = studio_job_manager()
    job = jobs.get_bootstrap_job(job_id) if jobs is not None else None
    if job is None:
        return to_json({"running": False})
    snap = job.snapshot()
    return to_json(
        {
            "job_id": snap["id"],
            "status": snap["status"],
            "download": snap["download"],
            "failure": snap["failure"],
        }
    )


def register(mcp: MCPServer) -> None:
    for fn in (model_download, model_download_status):
        mcp.tool()(fn)

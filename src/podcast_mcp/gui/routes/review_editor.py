"""Editor-only twins of owner routes, under ``/api/review/{token}/daw/*``.

Each twin is a row in ``GUEST_OWNER_ROUTES``, reached through ``guest_route(name)``. No handler
takes a path from the client.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from podcast_mcp.gui.job_events import GUEST_STREAM_SLOTS
from podcast_mcp.gui.routes.deps import coded_http_error
from podcast_mcp.gui.routes.guest_errors import guest_boundary
from podcast_mcp.gui.routes.share_common import check_share_token, rate_limit_share
from podcast_mcp.gui.routes.sse_common import guest_job_events_response
from podcast_mcp.gui.schemas import (
    GuestExportRequest,
    GuestPipelineRunRequest,
    GuestRefineDoneRequest,
    GuestRefineWaiveRequest,
    GuestReplacementPreviewRequest,
    GuestSpeakerMoveLaneSpanRequest,
    GuestSpeakerSplitRequest,
    GuestTranscriptExportRequest,
    GuestVocabularyPutRequest,
    GuestWordTimingContextRequest,
    TranscriptRefineStatusView,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration import (
    GUEST_OWNER_ROUTES,
    SHARE_ACTOR_PREFIX,
    GuestRefusal,
    GuestRoute,
    ShareSource,
    guest_cancel_job,
    guest_job_status_view,
    guest_move_lane_span,
    guest_only_keys,
    guest_owner_route,
    guest_projected_job,
    guest_start_export,
    guest_start_pipeline_run,
    guest_start_speaker_split,
    lookup_guest_job,
    require_share_edit,
    share_review_source,
)
from podcast_mcp.services.document import (
    ExportBusyError,
    TranscriptEmptyError,
    TranscriptService,
    TranscriptTimingChangedError,
    WordTimingTarget,
)
from podcast_mcp.services.jobs import (
    GUEST_EXPORT_KINDS,
    GUEST_PIPELINE_KINDS,
    GUEST_RENDER_KINDS,
    GUEST_SPEAKER_KINDS,
    Job,
    guest_job_view,
)
from podcast_mcp.services.media import (
    TranscriptChangedSinceReviewError,
    TranscriptPrecorrectService,
    TranscriptRefineService,
    VocabularyConflictError,
)
from podcast_mcp.util.coded_error import CodedError, guest_message_for_code
from podcast_mcp.util.guest_render import require_guest_render

router = APIRouter()
log = logging.getLogger(__name__)


def _named(dependency: Callable[..., Any], name: str) -> Callable[..., Any]:
    dependency.guest_route_name = name  # type: ignore[attr-defined]
    return dependency


def _share_scope(name: str) -> Callable[[str], tuple[dict[str, Any], ProjectWorkspace]]:
    row = guest_owner_route(name)

    def dependency(token: str) -> tuple[dict[str, Any], ProjectWorkspace]:
        check_share_token(token)
        rate_limit_share(token, row.rate_kind)
        with guest_boundary(log, "review request"):
            if row.needs_guest_render:
                require_guest_render()
            return require_share_edit(token)

    return dependency


def guest_route(name: str) -> Callable[[str], ProjectWorkspace]:
    """Dependency for the twin registered as *name*; returns the share's workspace.

    An unregistered name fails at import, so a twin cannot be mounted without a row.
    """
    scope = _share_scope(name)

    def dependency(token: str) -> ProjectWorkspace:
        return scope(token)[1]

    return _named(dependency, name)


@dataclass(frozen=True)
class GuestActor:
    ws: ProjectWorkspace
    source: ShareSource


def guest_actor_route(name: str) -> Callable[[str], GuestActor]:
    """Like ``guest_route``, for a twin that records who acted: ``share:`` plus the share's id."""
    scope = _share_scope(name)

    def dependency(token: str) -> GuestActor:
        row, ws = scope(token)
        with guest_boundary(log, "review request"):
            return GuestActor(ws, share_review_source(row))

    return _named(dependency, name)


STREAMS_FULL = "Too many open streams on this link"
GUEST_NOTE_PREFIX = "From an Editor link: "
GUEST_VOCABULARY_KEYS = (
    "terms",
    "guest_names",
    "prompt_limit",
    "revision",
    "needs_retranscription",
)
GUEST_EXPORT_FILE_KEYS = ("format", "name", "bytes", "language", "written", "current")
GUEST_EXPORTED_KEYS = ("format", "name", "mime", "language", "bytes", "modified", "current")
EXPORT_SLOTS = threading.BoundedSemaphore(2)


@dataclass(frozen=True)
class GuestJobScope:
    ws: ProjectWorkspace
    job: Job
    kinds: frozenset[str]


@contextmanager
def _http_refusals() -> Iterator[None]:
    """A twin core refuses with ``GuestRefusal``; this route answers with its status and text."""
    try:
        yield
    except GuestRefusal as exc:
        raise coded_http_error(exc.status, str(exc), code=exc.code) from exc


@contextmanager
def _guest_call(operation: str) -> Iterator[None]:
    with guest_boundary(log, operation), _http_refusals():
        yield


def guest_job_route(
    name: str, kinds: frozenset[str]
) -> Callable[[str, str, Request], GuestJobScope]:
    """Like ``guest_route``, for a ``{job_id}`` route: the job is the share's or it is a 404.

    An unknown id, another project's job, a job of a kind this route does not serve and a job
    with no project all answer alike, so the route says nothing about which jobs exist.
    """
    workspace = guest_route(name)

    def dependency(token: str, job_id: str, request: Request) -> GuestJobScope:
        ws = workspace(token)
        with _guest_call("review job lookup"):
            job = lookup_guest_job(request.app.state.jobs, ws, job_id, kinds)
        return GuestJobScope(ws, job, kinds)

    return _named(dependency, name)


RenderPreviewWorkspace = Annotated[ProjectWorkspace, Depends(guest_route("render_preview"))]
PipelineRunWorkspace = Annotated[ProjectWorkspace, Depends(guest_route("pipeline_run"))]
PipelineStatusWorkspace = Annotated[ProjectWorkspace, Depends(guest_route("pipeline_status"))]
RenderPreviewStatusScope = Annotated[
    GuestJobScope, Depends(guest_job_route("render_preview_status", GUEST_RENDER_KINDS))
]
PipelineJobScope = Annotated[
    GuestJobScope, Depends(guest_job_route("pipeline_job_status", GUEST_PIPELINE_KINDS))
]
PipelineEventsScope = Annotated[
    GuestJobScope, Depends(guest_job_route("pipeline_job_events", GUEST_PIPELINE_KINDS))
]
PipelineCancelScope = Annotated[
    GuestJobScope, Depends(guest_job_route("pipeline_job_cancel", GUEST_PIPELINE_KINDS))
]
ExportStartActor = Annotated[GuestActor, Depends(guest_actor_route("export_start"))]
ExportStatusWorkspace = Annotated[ProjectWorkspace, Depends(guest_route("export_status"))]
ExportJobScope = Annotated[
    GuestJobScope, Depends(guest_job_route("export_job_status", GUEST_EXPORT_KINDS))
]
ExportEventsScope = Annotated[
    GuestJobScope, Depends(guest_job_route("export_job_events", GUEST_EXPORT_KINDS))
]
ExportCancelScope = Annotated[
    GuestJobScope, Depends(guest_job_route("export_job_cancel", GUEST_EXPORT_KINDS))
]
VocabularyGetWorkspace = Annotated[
    ProjectWorkspace, Depends(guest_route("transcript_vocabulary_get"))
]
VocabularyPutWorkspace = Annotated[
    ProjectWorkspace, Depends(guest_route("transcript_vocabulary_put"))
]
RefineStatusWorkspace = Annotated[
    ProjectWorkspace, Depends(guest_route("transcript_refine_status"))
]
RefineDoneActor = Annotated[GuestActor, Depends(guest_actor_route("transcript_refine_done"))]
RefineWaiveActor = Annotated[GuestActor, Depends(guest_actor_route("transcript_refine_waive"))]
ReplacementPreviewWorkspace = Annotated[
    ProjectWorkspace, Depends(guest_route("transcript_replacement_preview"))
]
WordTimingContextWorkspace = Annotated[
    ProjectWorkspace, Depends(guest_route("transcript_word_timing_context"))
]
TranscriptExportWorkspace = Annotated[ProjectWorkspace, Depends(guest_route("transcript_export"))]
TranscriptExportsWorkspace = Annotated[ProjectWorkspace, Depends(guest_route("transcript_exports"))]
SpeakerSplitActor = Annotated[GuestActor, Depends(guest_actor_route("speaker_split"))]
SpeakerStatusWorkspace = Annotated[ProjectWorkspace, Depends(guest_route("speaker_status"))]
SpeakerJobScope = Annotated[
    GuestJobScope, Depends(guest_job_route("speaker_job_status", GUEST_SPEAKER_KINDS))
]
SpeakerEventsScope = Annotated[
    GuestJobScope, Depends(guest_job_route("speaker_job_events", GUEST_SPEAKER_KINDS))
]
SpeakerCancelScope = Annotated[
    GuestJobScope, Depends(guest_job_route("speaker_job_cancel", GUEST_SPEAKER_KINDS))
]
SpeakerMoveLaneSpanActor = Annotated[
    GuestActor, Depends(guest_actor_route("speaker_move_lane_span"))
]


def _projected(job: Job, scope: GuestJobScope) -> dict[str, Any]:
    with _http_refusals():
        return guest_projected_job(job, scope.ws, scope.kinds)


@router.post("/api/review/{token}/daw/render-preview", status_code=202)
def post_daw_render_preview(request: Request, ws: RenderPreviewWorkspace) -> dict[str, Any]:
    """Uses the same ``JobManager`` lock as the host GUI so concurrent host and guest renders cannot race."""
    with guest_boundary(log, "review render"):
        job = request.app.state.jobs.start_render_preview(ws.path)

    projected = guest_job_view(job, ws.path, GUEST_RENDER_KINDS)
    if projected is None:
        raise coded_http_error(
            500, "Render preview job unavailable", code="render_preview_job_unavailable"
        )
    return {"job": projected}


@router.get("/api/review/{token}/daw/render-preview/{job_id}")
def get_daw_render_preview(scope: RenderPreviewStatusScope) -> dict[str, Any]:
    return _projected(scope.job, scope)


@router.post("/api/review/{token}/daw/pipeline/run", status_code=202)
def post_daw_pipeline_run(
    request: Request, req: GuestPipelineRunRequest, ws: PipelineRunWorkspace
) -> dict[str, Any]:
    """Runs the host's working-set config for this project and never writes it."""
    with _guest_call("review pipeline run"):
        return guest_start_pipeline_run(
            request.app.state.jobs,
            ws,
            from_step=req.from_step,
            only_step=req.only_step,
            skip_steps=req.skip_steps,
            force_transcribe=req.force_transcribe,
            retime_words=req.retime_words,
        )


@router.get("/api/review/{token}/daw/pipeline/status")
def get_daw_pipeline_status(request: Request, ws: PipelineStatusWorkspace) -> dict[str, Any]:
    with guest_boundary(log, "review pipeline status"):
        return guest_job_status_view(request.app.state.jobs, ws, GUEST_PIPELINE_KINDS)


@router.get("/api/review/{token}/daw/pipeline/jobs/{job_id}")
def get_daw_pipeline_job(scope: PipelineJobScope) -> dict[str, Any]:
    return _projected(scope.job, scope)


def _job_events(token: str, scope: GuestJobScope) -> StreamingResponse:
    lease = GUEST_STREAM_SLOTS.acquire(token)
    if lease is None:
        raise coded_http_error(429, STREAMS_FULL, code="rate_limited", headers={"Retry-After": "5"})

    def still_shared() -> bool:
        try:
            _row, current = require_share_edit(token)
        except Exception:
            log.info("guest event stream closed: share no longer reachable", exc_info=True)
            return False
        return current.path == scope.ws.path

    try:
        return guest_job_events_response(
            scope.job, scope.ws.path, scope.kinds, lease=lease, still_shared=still_shared
        )
    except BaseException:
        lease.release()
        raise


def _cancelled(request: Request, scope: GuestJobScope, operation: str) -> dict[str, Any]:
    with _guest_call(operation):
        return guest_cancel_job(request.app.state.jobs, scope.ws, scope.job, scope.kinds)


@router.get("/api/review/{token}/daw/pipeline/jobs/{job_id}/events")
def get_daw_pipeline_job_events(token: str, scope: PipelineEventsScope) -> StreamingResponse:
    return _job_events(token, scope)


@router.post("/api/review/{token}/daw/pipeline/jobs/{job_id}/cancel")
def post_daw_pipeline_job_cancel(request: Request, scope: PipelineCancelScope) -> dict[str, Any]:
    """Runs with ``PODCAST_GUEST_RENDER`` off, so the host can stop a job after turning it off."""
    return _cancelled(request, scope, "review pipeline cancel")


@router.post("/api/review/{token}/daw/export", status_code=202)
def post_daw_export(
    request: Request, req: GuestExportRequest, who: ExportStartActor
) -> dict[str, Any]:
    """Exports into the project's own export folder; the client names formats, never a path."""
    with _guest_call("review export"):
        return guest_start_export(request.app.state.jobs, who.ws, who.source, req.formats)


@router.get("/api/review/{token}/daw/export/status")
def get_daw_export_status(request: Request, ws: ExportStatusWorkspace) -> dict[str, Any]:
    with guest_boundary(log, "review export status"):
        return guest_job_status_view(request.app.state.jobs, ws, GUEST_EXPORT_KINDS)


@router.get("/api/review/{token}/daw/export/jobs/{job_id}")
def get_daw_export_job(scope: ExportJobScope) -> dict[str, Any]:
    return _projected(scope.job, scope)


@router.get("/api/review/{token}/daw/export/jobs/{job_id}/events")
def get_daw_export_job_events(token: str, scope: ExportEventsScope) -> StreamingResponse:
    return _job_events(token, scope)


@router.post("/api/review/{token}/daw/export/jobs/{job_id}/cancel")
def post_daw_export_job_cancel(request: Request, scope: ExportCancelScope) -> dict[str, Any]:
    return _cancelled(request, scope, "review export cancel")


def _refused(status: int, code: str) -> HTTPException:
    return coded_http_error(status, guest_message_for_code(code), code=code)


def _guest_note(text: str | None) -> str | None:
    return f"{GUEST_NOTE_PREFIX}{text.strip()}" if text and text.strip() else None


def _refine_view(report: dict[str, Any]) -> dict[str, Any]:
    source = report.get("source")
    guest = isinstance(source, str) and source.startswith(SHARE_ACTOR_PREFIX)
    return {**report, "notes": "", "source": "guest" if guest else source}


@router.get("/api/review/{token}/daw/transcript/vocabulary")
def get_daw_transcript_vocabulary(ws: VocabularyGetWorkspace) -> dict[str, Any]:
    with guest_boundary(log, "review vocabulary"):
        return guest_only_keys(
            TranscriptPrecorrectService.vocabulary_status(ws.path), GUEST_VOCABULARY_KEYS
        )


@router.put("/api/review/{token}/daw/transcript/vocabulary")
def put_daw_transcript_vocabulary(
    token: str, req: GuestVocabularyPutRequest, ws: VocabularyPutWorkspace
) -> dict[str, Any]:
    with guest_boundary(log, "review vocabulary save"):
        try:
            saved = TranscriptPrecorrectService(ws).set_vocabulary(
                terms=req.terms, guest_names=req.guest_names, base_revision=req.base_revision
            )
        except VocabularyConflictError as exc:
            raise _refused(409, "vocabulary_conflict") from exc
    log.info("guest vocabulary saved token=%s", token[:8])
    return guest_only_keys(saved, GUEST_VOCABULARY_KEYS)


@router.get(
    "/api/review/{token}/daw/transcript/refine/status", response_model=TranscriptRefineStatusView
)
def get_daw_transcript_refine_status(ws: RefineStatusWorkspace) -> dict[str, Any]:
    with guest_boundary(log, "review transcript check"):
        return _refine_view(TranscriptRefineService(ws).gate_status())


@router.post(
    "/api/review/{token}/daw/transcript/refine/done", response_model=TranscriptRefineStatusView
)
def post_daw_transcript_refine_done(
    req: GuestRefineDoneRequest, who: RefineDoneActor
) -> dict[str, Any]:
    with guest_boundary(log, "review transcript check"):
        try:
            report = TranscriptRefineService(who.ws).mark_checked(
                notes=_guest_note(req.notes),
                source=who.source,
                expected_fingerprint=req.expected_fingerprint,
            )
        except TranscriptChangedSinceReviewError as exc:
            raise _refused(409, "transcript_changed") from exc
    return _refine_view(report)


@router.post(
    "/api/review/{token}/daw/transcript/refine/waive", response_model=TranscriptRefineStatusView
)
def post_daw_transcript_refine_waive(
    req: GuestRefineWaiveRequest, who: RefineWaiveActor
) -> dict[str, Any]:
    with guest_boundary(log, "review transcript waiver"):
        refine = TranscriptRefineService(who.ws)
        report = refine.gate_status()
        if not report["clear"]:
            refine.waive(reason=_guest_note(req.reason) or "", source=who.source)
            report = refine.gate_status()
        return _refine_view(report)


@router.post("/api/review/{token}/daw/transcript/replacement-preview")
def post_daw_transcript_replacement_preview(
    req: GuestReplacementPreviewRequest, ws: ReplacementPreviewWorkspace
) -> dict[str, Any]:
    with guest_boundary(log, "review replacement preview"):
        return TranscriptService(ws).preview_transcript_replacement(
            req.search, req.replacement, match_case=req.match_case
        )


@router.post("/api/review/{token}/daw/transcript/word-timing-context")
def post_daw_transcript_word_timing_context(
    req: GuestWordTimingContextRequest, ws: WordTimingContextWorkspace
) -> dict[str, Any]:
    with guest_boundary(log, "review word timing"):
        try:
            return TranscriptService(ws).word_timing_context(
                WordTimingTarget(**req.target.model_dump()),
                expected_text=req.expected_word.text,
                expected_start=req.expected_word.start,
                expected_end=req.expected_word.end,
            )
        except TranscriptTimingChangedError as exc:
            raise _refused(409, "transcript_timing_changed") from exc
        except CodedError:
            raise
        except (KeyError, FileNotFoundError) as exc:
            raise _refused(404, "word_not_found") from exc


@router.post("/api/review/{token}/daw/transcript/export")
def post_daw_transcript_export(
    token: str, req: GuestTranscriptExportRequest, ws: TranscriptExportWorkspace
) -> dict[str, Any]:
    """Writes into the project's export folder; a write waits for no more than two at once."""
    if not req.dry_run and not EXPORT_SLOTS.acquire(blocking=False):
        raise _refused(503, "export_busy")
    try:
        with guest_boundary(log, "review transcript export"):
            try:
                result = TranscriptService(ws).export(
                    req.formats, dry_run=req.dry_run, with_text=req.with_text
                )
            except ExportBusyError as exc:
                raise _refused(503, "export_busy") from exc
            except TranscriptEmptyError as exc:
                raise _refused(409, "transcript_empty") from exc
    finally:
        if not req.dry_run:
            EXPORT_SLOTS.release()
    if not req.dry_run:
        log.info("guest transcript export token=%s formats=%s", token[:8], ",".join(req.formats))
    view = asdict(result)
    view["files"] = [guest_only_keys(row, GUEST_EXPORT_FILE_KEYS) for row in view["files"]]
    return view


@router.get("/api/review/{token}/daw/transcript/exports")
def get_daw_transcript_exports(ws: TranscriptExportsWorkspace) -> list[dict[str, Any]]:
    with guest_boundary(log, "review transcript exports"):
        return [
            guest_only_keys(asdict(row), GUEST_EXPORTED_KEYS)
            for row in TranscriptService(ws).exported()
        ]


@router.post("/api/review/{token}/daw/speaker/split", status_code=202)
def post_daw_speaker_split(
    request: Request, req: GuestSpeakerSplitRequest, who: SpeakerSplitActor
) -> dict[str, Any]:
    """Splits one of the project's tracks; a missing model is the fixed 409, never a download."""
    with _guest_call("review speaker split"):
        return guest_start_speaker_split(
            request.app.state.jobs,
            who.ws,
            who.source,
            track_id=req.track_id,
            speaker_count=req.speaker_count,
            names=req.names,
            enrollment=req.enrollment,
        )


@router.get("/api/review/{token}/daw/speaker/status")
def get_daw_speaker_status(request: Request, ws: SpeakerStatusWorkspace) -> dict[str, Any]:
    with guest_boundary(log, "review speaker status"):
        return guest_job_status_view(request.app.state.jobs, ws, GUEST_SPEAKER_KINDS)


@router.get("/api/review/{token}/daw/speaker/jobs/{job_id}")
def get_daw_speaker_job(scope: SpeakerJobScope) -> dict[str, Any]:
    return _projected(scope.job, scope)


@router.get("/api/review/{token}/daw/speaker/jobs/{job_id}/events")
def get_daw_speaker_job_events(token: str, scope: SpeakerEventsScope) -> StreamingResponse:
    return _job_events(token, scope)


@router.post("/api/review/{token}/daw/speaker/jobs/{job_id}/cancel")
def post_daw_speaker_job_cancel(request: Request, scope: SpeakerCancelScope) -> dict[str, Any]:
    return _cancelled(request, scope, "review speaker cancel")


@router.post("/api/review/{token}/daw/speaker/move-lane-span")
def post_daw_speaker_move_lane_span(
    req: GuestSpeakerMoveLaneSpanRequest, who: SpeakerMoveLaneSpanActor
) -> dict[str, Any]:
    with _guest_call("review speaker move"):
        return guest_move_lane_span(
            who.ws,
            who.source,
            from_lane=req.from_lane,
            to_lane=req.to_lane,
            timeline_start=req.timeline_start,
            timeline_end=req.timeline_end,
        )


def check_guest_router(router: APIRouter, registry: Mapping[str, GuestRoute]) -> None:
    """Refuse a router with a route that lacks a registered ``guest_route`` or differs from its
    row, and a row with no route."""
    mounted: set[str] = set()
    for route in router.routes:
        names = [
            name
            for dep in route.dependant.dependencies  # type: ignore[attr-defined]
            if (name := getattr(dep.call, "guest_route_name", None))
        ]
        if len(names) != 1 or names[0] not in registry:
            raise RuntimeError(f"{route.path} has no registered guest_route dependency")  # type: ignore[attr-defined]
        row = registry[names[0]]
        if route.path != row.path or route.methods != {row.method}:  # type: ignore[attr-defined]
            raise RuntimeError(f"{route.path} does not match the {row.name} row")  # type: ignore[attr-defined]
        mounted.add(names[0])
    if mounted != set(registry):
        raise RuntimeError(f"guest routes without a handler: {sorted(set(registry) - mounted)}")


check_guest_router(router, GUEST_OWNER_ROUTES)

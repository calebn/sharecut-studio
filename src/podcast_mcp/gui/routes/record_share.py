"""Public record-share routes — token-scoped, no review mix or host paths."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import secrets
from typing import Any

from anyio import CancelScope
from fastapi import APIRouter, Header, Query, Request, WebSocket, WebSocketDisconnect
from starlette.concurrency import run_in_threadpool
from starlette.websockets import WebSocketState

from podcast_mcp.gui.routes.guest_errors import guest_boundary, guest_ws_error
from podcast_mcp.gui.routes.guest_ws_common import (
    admit_guest_ws,
    guest_ws_reject,
    guest_ws_share_row,
)
from podcast_mcp.gui.routes.record_upload_http import (
    ClippingParam,
    ClippingTruncatedParam,
    UploadKindParam,
    ingest_record_upload_request,
)
from podcast_mcp.gui.routes.share_common import (
    check_share_token,
    rate_limit_share,
    share_features_manifest,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration import (
    CAP_JOIN,
    CAP_MONITOR,
    SHARE_KIND_RECORD,
    has_capability,
    lookup_share,
    open_share_workspace,
    record_bootstrap,
    share_id_of,
)
from podcast_mcp.services.record import (
    CLIENT_VISIBLE_AUTHZ_CODES,
    UPLOAD_KIND_ROOM_TONE,
    LeaseInUseError,
    RecordAuthzError,
    RecordRole,
    RecordSessionService,
    RecordUploadService,
    RoomFullError,
    filter_record_event_for_guest,
    observer_view,
    parse_participant_id,
    parse_upload_kind,
    record_hub_key,
    route_record_ws_message,
)
from podcast_mcp.services.remote_mcp import get_host_limiters, host_rate_limit_enabled
from podcast_mcp.services.session_sync import get_hub, guest_display_name
from podcast_mcp.util.coded_error import CodedKeyError, CodedPermissionError, CodedValueError
from podcast_mcp.util.ws_limits import GUEST_FRAME_MAX_BYTES

router = APIRouter()
log = logging.getLogger(__name__)

_INVITE_CLOSED_FRAME = {"plane": "record", "type": "Error", "code": "invite_closed"}


@router.get("/api/rec/{token}/bootstrap")
def get_record_bootstrap(token: str) -> dict[str, Any]:
    row = check_share_token(token, kind=SHARE_KIND_RECORD)
    rate_limit_share(token, "read")
    with guest_boundary(log, "record bootstrap"):
        return record_bootstrap(row)


@router.get("/api/rec/{token}/features")
def get_record_features(token: str, request: Request) -> dict[str, Any]:
    check_share_token(token, kind=SHARE_KIND_RECORD)
    rate_limit_share(token, "read")
    with guest_boundary(log, "record features"):
        return share_features_manifest(request)


def _stamp_of(event: dict[str, Any]) -> int:
    snapshot = event.get("snapshot")
    stamp = snapshot.get("server_time_ns") if isinstance(snapshot, dict) else None
    return stamp if isinstance(stamp, int) else 0


def _record_still_valid(token: str) -> bool:
    try:
        row = lookup_share(token, kind=SHARE_KIND_RECORD)
    except (KeyError, FileNotFoundError):
        return False
    return has_capability(row.get("capabilities"), CAP_MONITOR)


@router.websocket("/api/rec/{token}/ws")
async def record_ws(
    websocket: WebSocket,
    token: str,
    client_id: str | None = Query(None),
    name: str | None = Query(None),
    observe: str | None = Query(None),
) -> None:
    try:
        row = await guest_ws_share_row(websocket, token, kind=SHARE_KIND_RECORD)
        if row is None:
            return
        if not has_capability(row.get("capabilities"), CAP_MONITOR):
            await guest_ws_reject(websocket, 4403, "monitor capability required")
            return
        role_raw = str(row.get("role") or "guest")
        if role_raw not in ("guest", "producer"):
            await guest_ws_reject(websocket, 4403, "invalid record role")
            return
        role: RecordRole = role_raw  # type: ignore[assignment]
        session_id = str(row.get("session_id") or "")
        if not session_id:
            await guest_ws_reject(websocket, 4403, "record room missing")
            return
        _row, ws_proj = await run_in_threadpool(open_share_workspace, token, kind=SHARE_KIND_RECORD)
        share_id = share_id_of(row)
        conn = await admit_guest_ws(websocket, token, share_id=share_id, log_label="record ws")
        if conn is None:
            return
    except Exception as exc:
        failure = guest_ws_error(exc, logger=log, operation="record admission")
        await guest_ws_reject(websocket, failure.close_code, failure.close_reason)
        return

    caps = list(row.get("capabilities") or [])
    hub = get_hub()
    hub_key = record_hub_key(ws_proj.project)
    connection_id = secrets.token_hex(8)
    guest_client_id = client_id or f"rec-{connection_id}"
    participant_id: str | None = None
    svc: RecordSessionService | None = None
    joined = False
    watching = observe == "1" and role == "producer"
    counted = False
    send_lock = asyncio.Lock()
    q = None
    guard = None

    def _connection_valid() -> bool:
        return (
            svc is not None
            and _record_still_valid(token)
            and (participant_id is None or svc.participant_active(participant_id))
            # A look that has not joined follows its invite: the pump closes it at its
            # next room event, and this recheck catches a look that gets none.
            and (not watching or joined or svc.invite_closed(share_id) is None)
        )

    def _closed_invite_frame() -> dict[str, Any] | None:
        # Worker thread. A socket that has not joined fails its share check only on its link
        # or, for a look, its invite, so a good link plus a closed invite means a look.
        if svc is None or joined:
            return None
        if not _record_still_valid(token) or svc.invite_closed(share_id) is None:
            return None
        return dict(_INVITE_CLOSED_FRAME)

    def _participant_runtime_valid() -> bool:
        return svc is not None and (
            participant_id is None or svc.participant_not_removed_in_runtime(participant_id)
        )

    try:
        svc = await run_in_threadpool(RecordSessionService, ws_proj.project, session_id=session_id)
        guard = await conn.start(
            _connection_valid,
            send_gate=_participant_runtime_valid,
            invalid_frame=_closed_invite_frame,
        )
        loop = asyncio.get_running_loop()
        # No cross-process lease (#695): only this GUI process writes record state (WebRTC
        # signaling); `podcast record land` writes the session journal, which the session
        # and daw sockets' watcher already follows.
        q = hub.subscribe(hub_key, loop)
        counted_at = 0
        if watching:
            stamp = await run_in_threadpool(svc.watch, connection_id, share_id)
            counted = stamp is not None
            counted_at = stamp or 0
            if not counted:
                if not await run_in_threadpool(svc.is_current_room):
                    await guard.close(4403, "record room ended")
                elif await run_in_threadpool(svc.invite_closed, share_id) is not None:
                    await guard.send_json(dict(_INVITE_CLOSED_FRAME))
                    await guard.close(4403, "invite closed")
                else:
                    await guard.close(4429, "too many looking in")
                return

        async def _pump() -> None:
            assert q is not None
            try:
                while True:
                    event = await q.get()
                    # One hold of the send lock covers every check and the send. A Join holds
                    # it from start to answer, so once it is ours `joined` is settled.
                    async with send_lock:
                        if (
                            watching
                            and not joined
                            and await run_in_threadpool(svc.invite_closed, share_id) is not None
                        ):
                            # The invite closed: a look gets what a Join gets, and never a
                            # frame that shows the room after the closure.
                            await guard.send_json(dict(_INVITE_CLOSED_FRAME))
                            await guard.close(4403, "invite closed")
                            return
                        if not await guard.share_ok_on_frame() or not _participant_runtime_valid():
                            await guard.close_invalid("participant removed or share revoked")
                            return
                        snap_in = event.get("snapshot")
                        if isinstance(snap_in, dict) and snap_in.get("session_id") != session_id:
                            # A remint swaps the room under an open socket: never relay the
                            # new one.
                            await guard.close(4403, "record room ended")
                            return
                        if joined:
                            view = filter_record_event_for_guest(
                                event,
                                participant_id=participant_id or "",
                                role=role,
                            )
                        elif watching:
                            # Never show a room that has not been told: frames built before
                            # this socket was counted carry a count without it.
                            frame = None if _stamp_of(event) < counted_at else observer_view(event)
                            view = None if frame is None else dict(frame)
                        else:
                            view = None
                        if view is None:
                            continue
                        await guard.send_json(view)
                    if guard.closed:
                        return
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("record pump failed share=%s", share_id)
                with contextlib.suppress(Exception):
                    await guard.close(1011, "record pump failed")
                raise

        conn.spawn(_pump())

        while True:
            try:
                text = await websocket.receive_text()
            except WebSocketDisconnect:
                break
            except RuntimeError:
                if guard.closed:
                    break
                raise
            if guard.closed:
                break
            if not await guard.share_ok_on_frame() or not _participant_runtime_valid():
                await guard.close_invalid("participant removed or share revoked")
                break
            if len(text) > GUEST_FRAME_MAX_BYTES:
                if guard.note_malformed():
                    await guard.close(4400, "too many malformed frames")
                    break
                continue
            try:
                msg = json.loads(text)
            except ValueError:
                if guard.note_malformed():
                    await guard.close(4400, "too many malformed frames")
                    break
                continue
            if not isinstance(msg, dict) or msg.get("type") != "Record":
                await guard.send_json({"plane": "record", "type": "Error", "code": "join_first"})
                continue
            command_type = str(msg.get("command_type") or "")
            raw_payload = msg.get("payload")
            payload: dict[str, Any] = raw_payload if isinstance(raw_payload, dict) else {}
            if host_rate_limit_enabled() and command_type not in (
                "Heartbeat",
                "HeadphonesAck",
            ):
                lim = get_host_limiters()
                conn_key = f"{token}:{connection_id}"
                if command_type == "Signal":
                    if not lim.guest_ws_record_signal.allow(conn_key).allowed:
                        await guard.send_json(
                            {"plane": "record", "type": "Error", "code": "rate_limited"}
                        )
                        continue
                    if not lim.guest_ws_record_signal_token.allow(token).allowed:
                        await guard.send_json(
                            {"plane": "record", "type": "Error", "code": "rate_limited"}
                        )
                        continue
                else:
                    if not lim.guest_ws_record.allow(conn_key).allowed:
                        await guard.send_json(
                            {"plane": "record", "type": "Error", "code": "rate_limited"}
                        )
                        continue
                    if not lim.guest_ws_record_token.allow(token).allowed:
                        await guard.send_json(
                            {"plane": "record", "type": "Error", "code": "rate_limited"}
                        )
                        continue
            try:
                try:
                    client_seq = int(msg.get("client_seq") or 1)
                except (ValueError, TypeError, OverflowError) as exc:
                    raise CodedValueError(
                        "invalid client sequence", code="invalid_record_request"
                    ) from exc
                if not joined:
                    if command_type != "Join":
                        await guard.send_json(
                            {"plane": "record", "type": "Error", "code": "join_first"}
                        )
                        continue
                    # The pump filters by who this socket is, so it waits out the Join:
                    # nothing else goes out between the Join and the Snapshot that follows.
                    async with send_lock:
                        try:
                            echo, snap = await run_in_threadpool(
                                svc.join,
                                share_id=share_id,
                                role=role,
                                display_name=guest_display_name(
                                    payload.get("display_name") or name
                                ),
                                participant_id=payload.get("participant_id"),
                                lease=payload.get("lease"),
                                client_id=guest_client_id,
                                connection_id=connection_id,
                                capabilities=caps,
                                client_seq=client_seq,
                                watching_connection_id=connection_id if counted else None,
                            )
                        except Exception:
                            if counted and not await run_in_threadpool(
                                svc.is_watching, connection_id
                            ):
                                # A refused Join could not put the count back: never leave
                                # an uncounted looker.
                                await guard.close(4403, "record room ended")
                            raise
                        participant_id = str(echo["participant_id"])
                        joined = True
                        filtered_join = filter_record_event_for_guest(
                            {"plane": "record", "type": "Snapshot", "snapshot": snap},
                            participant_id=participant_id,
                            role=role,
                        )
                        snap_out = (filtered_join or {}).get("snapshot", snap)
                        await guard.send_json(
                            {
                                "plane": "record",
                                "type": "Echo",
                                **echo,
                            }
                        )
                        await guard.send_json(
                            {
                                "plane": "record",
                                "type": "Snapshot",
                                "snapshot": snap_out,
                            }
                        )
                    continue
                echo, _seq = await run_in_threadpool(
                    route_record_ws_message,
                    svc,
                    msg,
                    client_id=guest_client_id,
                    role=role,
                    participant_id=participant_id,
                    seq=client_seq,
                    capabilities=caps,
                    connection_id=connection_id,
                )
                filtered_echo = filter_record_event_for_guest(
                    echo,
                    participant_id=participant_id or "",
                    role=role,
                )
                await guard.send_json(filtered_echo or echo)
            except LeaseInUseError:
                await guard.send_json({"plane": "record", "type": "Error", "code": "lease_in_use"})
            except RecordAuthzError as exc:
                code = str(exc)
                if code not in CLIENT_VISIBLE_AUTHZ_CODES:
                    code = "forbidden"
                await guard.send_json({"plane": "record", "type": "Error", "code": code})
                if code == "invite_closed":
                    # 4403 is the only close code every shipped client treats as
                    # terminal; any other code makes an older bundle reconnect in a loop.
                    await guard.close(4403, "invite closed")
                    break
            except RoomFullError:
                await guard.send_json({"plane": "record", "type": "Error", "code": "room_full"})
            except Exception as exc:
                failure = guest_ws_error(exc, logger=log, operation="record command")
                if failure.close_code == 1011:
                    await guard.close(1011, failure.detail)
                    break
                await guard.send_json(
                    {
                        "plane": "record",
                        "type": "Error",
                        "code": "invalid_state",
                        "detail": failure.detail,
                        "error_code": failure.code,
                    }
                )
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        failure = guest_ws_error(exc, logger=log, operation="record socket")
        with contextlib.suppress(Exception):
            if websocket.application_state == WebSocketState.CONNECTING:
                await guest_ws_reject(websocket, failure.close_code, failure.close_reason)
            elif guard is not None:
                await guard.close(failure.close_code, failure.close_reason)
            else:
                await websocket.close(code=failure.close_code, reason=failure.detail)
    finally:
        with CancelScope(shield=True):
            try:
                if q is not None:
                    hub.unsubscribe(hub_key, q)
                await conn.stop_tasks()
            finally:
                try:
                    if svc is not None and counted:
                        await run_in_threadpool(svc.unwatch, connection_id)
                finally:
                    try:
                        if svc is not None and participant_id is not None:
                            await run_in_threadpool(
                                svc.disconnect, participant_id, connection_id=connection_id
                            )
                    finally:
                        conn.release()


def _guest_upload_ctx(
    token: str,
) -> tuple[RecordUploadService, RecordSessionService, str, str, ProjectWorkspace]:
    row = lookup_share(token, kind=SHARE_KIND_RECORD)
    if not has_capability(row.get("capabilities"), CAP_JOIN):
        raise CodedPermissionError("join capability required", code="record_join_required")
    _, ws = open_share_workspace(token, kind=SHARE_KIND_RECORD)
    session_id = str(row.get("session_id") or "")
    if not session_id:
        raise CodedKeyError("no active record room", code="record_room_not_found")
    return (
        RecordUploadService(ws.project),
        RecordSessionService(ws.project, session_id=session_id),
        session_id,
        share_id_of(row),
        ws,
    )


def _require_guest_lease(
    svc: RecordSessionService, share_id: str, participant_id: str, lease: str
) -> str:
    pid = parse_participant_id(participant_id)
    if not lease or not svc.verify_lease(pid, lease, share_id=share_id):
        raise CodedPermissionError("invalid lease", code="invalid_lease")
    return pid


def _require_guest_upload_consent(
    svc: RecordSessionService, pid: str, kind: str | None, take_index: int
) -> None:
    parsed = parse_upload_kind(kind)
    scoped_take = None if parsed == UPLOAD_KIND_ROOM_TONE else take_index
    if not svc.upload_consented(pid, take_index=scoped_take):
        raise CodedPermissionError("consent required", code="record_consent_required")


@router.get("/api/rec/{token}/upload")
def get_record_upload_status(
    token: str,
    x_record_participant: str = Header(..., alias="X-Record-Participant"),
    x_record_lease: str = Header(..., alias="X-Record-Lease"),
) -> dict[str, Any]:
    check_share_token(token, kind=SHARE_KIND_RECORD)
    rate_limit_share(token, "read")
    with guest_boundary(log, "record upload"):
        uploader, session, session_id, share_id, _ws = _guest_upload_ctx(token)
        pid = _require_guest_lease(session, share_id, x_record_participant, x_record_lease)
        return uploader.status(session_id=session_id, participant_id=pid)


@router.post("/api/rec/{token}/upload")
async def post_record_upload(
    request: Request,
    token: str,
    take_index: int = Query(...),
    segment_index: int = Query(...),
    part_seq: int = Query(...),
    sha256: str = Query(""),
    file_sha256: str | None = Query(None),
    final: bool = Query(False),
    expected_parts: int | None = Query(None, ge=1),
    join_offset_ms: int | None = Query(None),
    clipping: ClippingParam = None,
    clipping_truncated: ClippingTruncatedParam = False,
    kind: UploadKindParam = None,
    x_record_participant: str = Header(..., alias="X-Record-Participant"),
    x_record_lease: str = Header(..., alias="X-Record-Lease"),
):
    check_share_token(token, kind=SHARE_KIND_RECORD)
    rate_limit_share(token, "mutate")
    with guest_boundary(log, "record upload"):
        uploader, session, session_id, share_id, ws = _guest_upload_ctx(token)
        pid = _require_guest_lease(session, share_id, x_record_participant, x_record_lease)
        _require_guest_upload_consent(session, pid, kind, take_index)

        def before_ingest() -> None:
            _require_guest_lease(session, share_id, x_record_participant, x_record_lease)
            _require_guest_upload_consent(session, pid, kind, take_index)

        return await ingest_record_upload_request(
            request,
            uploader,
            session_id=session_id,
            participant_id=pid,
            take_index=take_index,
            segment_index=segment_index,
            part_seq=part_seq,
            sha256=sha256,
            file_sha256=file_sha256,
            final=final,
            expected_parts=expected_parts,
            join_offset_ms=join_offset_ms,
            clipping=clipping,
            clipping_truncated=clipping_truncated,
            workspace=ws,
            clip_scope=pid,
            kind=kind,
            before_ingest=before_ingest,
        )


@router.delete("/api/rec/{token}/upload")
def delete_record_upload(
    token: str,
    kind: UploadKindParam = None,
    x_record_participant: str = Header(..., alias="X-Record-Participant"),
    x_record_lease: str = Header(..., alias="X-Record-Lease"),
) -> dict[str, Any]:
    check_share_token(token, kind=SHARE_KIND_RECORD)
    rate_limit_share(token, "mutate")
    with guest_boundary(log, "record upload"):
        uploader, session, session_id, share_id, _ws = _guest_upload_ctx(token)
        pid = _require_guest_lease(session, share_id, x_record_participant, x_record_lease)
        parsed = parse_upload_kind(kind)
        if parsed != UPLOAD_KIND_ROOM_TONE:
            raise CodedValueError("only room_tone can be revoked", code="record_upload_refused")
        uploader.revoke_room_tone(session_id, pid)
        return {"revoked": True, "kind": UPLOAD_KIND_ROOM_TONE}

from typing import TYPE_CHECKING

from podcast_mcp.util.lazy_exports import resolve_export

if TYPE_CHECKING:
    from podcast_mcp.services.record.commands import (
        CLIENT_VISIBLE_AUTHZ_CODES,
        RecordAuthzError,
    )
    from podcast_mcp.services.record.control import RecordControlService
    from podcast_mcp.services.record.landing import (
        RecordLandingError,
        RecordLandingService,
        RecordTakeOpenError,
        purge_session_land_rollbacks,
        release_session_land_lock,
        remove_session_land_lock_file,
    )
    from podcast_mcp.services.record.preflight import (
        Unsaved,
        describe_unsaved_takes,
        land_first_would_work,
        left_behind_message,
        refuse_land_first,
        unsaved_fields,
        unsaved_takes,
        with_unsaved_takes,
    )
    from podcast_mcp.services.record.reducer import (
        RecordStateError,
        RoomFullError,
    )
    from podcast_mcp.services.record.service import (
        LeaseInUseError,
        RecordSessionService,
        assert_no_open_take,
        begin_record_session,
        connection_holds,
        filter_record_event_for_guest,
        invalidate_record_session_cache,
        record_hub_key,
        route_record_ws_message,
    )
    from podcast_mcp.services.record.sessions import (
        list_record_sessions,
        persist_session_summary,
    )
    from podcast_mcp.services.record.state import (
        HOST_PARTICIPANT_ID,
        RecordRole,
        parse_session_target,
    )
    from podcast_mcp.services.record.upload import (
        CLIPPING_MAX_REGIONS,
        CLIPPING_PARAM_MAX_CHARS,
        ROOM_TONE_MAX_PCM_BYTES,
        ROOM_TONE_SEGMENT_INDEX,
        ROOM_TONE_TAKE_INDEX,
        UPLOAD_KIND_ROOM_TONE,
        RecordUploadError,
        RecordUploadService,
        parse_participant_id,
        parse_upload_kind,
    )

__all__ = [
    "CLIENT_VISIBLE_AUTHZ_CODES",
    "CLIPPING_MAX_REGIONS",
    "CLIPPING_PARAM_MAX_CHARS",
    "HOST_PARTICIPANT_ID",
    "ROOM_TONE_MAX_PCM_BYTES",
    "ROOM_TONE_SEGMENT_INDEX",
    "ROOM_TONE_TAKE_INDEX",
    "UPLOAD_KIND_ROOM_TONE",
    "LeaseInUseError",
    "RecordAuthzError",
    "RecordControlService",
    "RecordLandingError",
    "RecordLandingService",
    "RecordRole",
    "RecordSessionService",
    "RecordStateError",
    "RecordTakeOpenError",
    "RecordUploadError",
    "RecordUploadService",
    "RoomFullError",
    "Unsaved",
    "assert_no_open_take",
    "begin_record_session",
    "connection_holds",
    "describe_unsaved_takes",
    "filter_record_event_for_guest",
    "invalidate_record_session_cache",
    "land_first_would_work",
    "left_behind_message",
    "list_record_sessions",
    "parse_participant_id",
    "parse_session_target",
    "parse_upload_kind",
    "persist_session_summary",
    "purge_session_land_rollbacks",
    "record_hub_key",
    "refuse_land_first",
    "release_session_land_lock",
    "remove_session_land_lock_file",
    "route_record_ws_message",
    "unsaved_fields",
    "unsaved_takes",
    "with_unsaved_takes",
]

_MODULE_BY_NAME = {
    "CLIENT_VISIBLE_AUTHZ_CODES": "commands",
    "CLIPPING_MAX_REGIONS": "upload",
    "CLIPPING_PARAM_MAX_CHARS": "upload",
    "HOST_PARTICIPANT_ID": "state",
    "LeaseInUseError": "service",
    "ROOM_TONE_MAX_PCM_BYTES": "upload",
    "ROOM_TONE_SEGMENT_INDEX": "upload",
    "ROOM_TONE_TAKE_INDEX": "upload",
    "RecordAuthzError": "commands",
    "RecordControlService": "control",
    "RecordLandingError": "landing",
    "RecordLandingService": "landing",
    "RecordTakeOpenError": "landing",
    "RecordRole": "state",
    "RecordSessionService": "service",
    "RecordStateError": "reducer",
    "RecordUploadError": "upload",
    "RecordUploadService": "upload",
    "RoomFullError": "reducer",
    "UPLOAD_KIND_ROOM_TONE": "upload",
    "assert_no_open_take": "service",
    "begin_record_session": "service",
    "connection_holds": "service",
    "describe_unsaved_takes": "preflight",
    "filter_record_event_for_guest": "service",
    "invalidate_record_session_cache": "service",
    "parse_participant_id": "upload",
    "parse_session_target": "state",
    "parse_upload_kind": "upload",
    "purge_session_land_rollbacks": "landing",
    "record_hub_key": "service",
    "release_session_land_lock": "landing",
    "remove_session_land_lock_file": "landing",
    "route_record_ws_message": "service",
    "unsaved_fields": "preflight",
    "unsaved_takes": "preflight",
    "Unsaved": "preflight",
    "land_first_would_work": "preflight",
    "list_record_sessions": "sessions",
    "persist_session_summary": "sessions",
    "left_behind_message": "preflight",
    "refuse_land_first": "preflight",
    "with_unsaved_takes": "preflight",
}


def __getattr__(name: str) -> object:
    return resolve_export(name, package=__name__, namespace=globals(), modules=_MODULE_BY_NAME)

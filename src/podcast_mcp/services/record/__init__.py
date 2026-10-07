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
    from podcast_mcp.services.record.reducer import (
        RecordStateError,
        RoomFullError,
    )
    from podcast_mcp.services.record.service import (
        LeaseInUseError,
        RecordSessionService,
        assert_no_open_take,
        begin_record_session,
        filter_record_event_for_guest,
        record_hub_key,
        route_record_ws_message,
    )
    from podcast_mcp.services.record.state import (
        HOST_PARTICIPANT_ID,
        RecordRole,
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
    "assert_no_open_take",
    "begin_record_session",
    "filter_record_event_for_guest",
    "parse_participant_id",
    "parse_upload_kind",
    "purge_session_land_rollbacks",
    "record_hub_key",
    "release_session_land_lock",
    "remove_session_land_lock_file",
    "route_record_ws_message",
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
    "filter_record_event_for_guest": "service",
    "parse_participant_id": "upload",
    "parse_upload_kind": "upload",
    "purge_session_land_rollbacks": "landing",
    "record_hub_key": "service",
    "release_session_land_lock": "landing",
    "remove_session_land_lock_file": "landing",
    "route_record_ws_message": "service",
}


def __getattr__(name: str) -> object:
    return resolve_export(name, package=__name__, namespace=globals(), modules=_MODULE_BY_NAME)

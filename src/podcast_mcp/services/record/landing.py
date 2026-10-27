"""Copy ACK'd keepers into raw/ and register one clip per segment."""

from __future__ import annotations

import json
import logging
import threading
import time
import wave
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import Any

from filelock import Timeout as FileLockTimeout

from podcast_mcp.edits.clipping_regions import clipping_regions_from_ms
from podcast_mcp.edits.comments import add_comment, delete_comment
from podcast_mcp.edits.insert_anchor import (
    capture_insert_anchor,
    capture_range_anchors,
    pending_anchor_holder,
)
from podcast_mcp.edits.record_placement import place_room_tone, place_take_clip, upsert_source
from podcast_mcp.edits.session_suggestions import (
    drop_staged_room_tone,
    drop_staged_segment,
    drop_staged_takes,
    ensure_session_suggestion,
    hold_room_tone,
    session_suggestion_for,
    session_suggestion_id,
    stage_comments,
    staged_comment_ids,
    upsert_staged_take,
)
from podcast_mcp.engines.render_invalidations import record_invalidation
from podcast_mcp.engines.room_tone import room_tone_source_id
from podcast_mcp.engines.track_ids import slug_track_id
from podcast_mcp.engines.track_media import refresh_timeline_duration
from podcast_mcp.models import (
    EpisodeProject,
    InsertAnchor,
    RecordSessionRecord,
    SessionSuggestion,
    StagedComment,
    StagedRoomTone,
    StagedTake,
)
from podcast_mcp.project.history.summary import record_land_title
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document_sync import after_agent_mutation
from podcast_mcp.services.media import schedule_track_waveforms, unique_raw_path
from podcast_mcp.services.record.landing_math import (
    clip_timeline_s,
    duration_error_ms,
    duration_s,
    expected_span_s,
    needs_align_fallback,
    overlap_window_s,
    record_session_number,
    record_source_prefix,
    session_landed_before,
    session_numbered,
    session_placement,
    session_start_present,
    session_take_offsets_s,
)
from podcast_mcp.services.record.landing_rollback import (
    PriorRegistration,
    capture_prior,
    media_from_remaining_clip,
    prior_from_json,
    prior_to_json,
    registration_present,
    revert_registration,
)
from podcast_mcp.services.record.live_comments import (
    LIVE_COMMENT_ID_PREFIX,
    RecordLiveCommentStore,
    live_comment_store_for,
)
from podcast_mcp.services.record.service import RecordSessionService
from podcast_mcp.services.record.state import (
    HOST_PARTICIPANT_ID,
    LAND_TAKE_OPEN_MSG,
    RECORDED_ROLES,
    InsertTarget,
    RecordSnapshot,
    ReplaceTarget,
    SessionTarget,
    TakeState,
    take_recording_duration_ms,
)
from podcast_mcp.services.record.track_match import TrackMatch, resolve_session_tracks
from podcast_mcp.services.record.upload import (
    ROOM_TONE_MAX_PCM_BYTES,
    ROOM_TONE_TAKE_INDEX,
    LandRollbackKey,
    RecordUploadService,
    parse_participant_id,
    parse_session_id,
    parse_upload_index,
)
from podcast_mcp.util.atomic_json import copy_file_atomic
from podcast_mcp.util.coded_error import CodedError
from podcast_mcp.util.file_locks import hold_shared_file_lock, unlink_if_unheld
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.util.keyed_lock import KeyedLocks
from podcast_mcp.util.progress import resolve_progress_task
from podcast_mcp.util.project_state import (
    FileRevision,
    file_revision,
    project_state_lock,
    record_land_lock_path,
)
from podcast_mcp.util.wav import open_wav

log = logging.getLogger(__name__)

AlignFn = Callable[[EpisodeProject], None]

_LAND_LOCKS: KeyedLocks[str, threading.Lock] = KeyedLocks(threading.Lock)

# A land includes WAV hashing, copies, and drift measurement, so allow more than the
# 30 s project commit lock, but never wait forever on a hung process (#503).
RECORD_LAND_LOCK_TIMEOUT_SEC = 120.0

STAGED_TARGET_KINDS = ("insert", "replace")

RECORD_LAND_ROLLBACK_RETRY_BASE_SEC = 30
RECORD_LAND_ROLLBACK_RETRY_MAX_SEC = 1800

_MOOT_BED = "room-tone bed revision changed or unknown"


def rollback_retry_after_ns(attempts: int, now_ns: int) -> int:
    """When a deferred rollback that has failed *attempts* retries may run again."""
    delay = min(
        RECORD_LAND_ROLLBACK_RETRY_BASE_SEC * 2 ** min(max(attempts - 1, 0), 16),
        RECORD_LAND_ROLLBACK_RETRY_MAX_SEC,
    )
    return now_ns + delay * 1_000_000_000


def release_session_land_lock(session_id: str) -> None:
    """Drop the per-session land lock after the room ends."""
    _LAND_LOCKS.discard_idle(session_id)


def remove_session_land_lock_file(workspace_dir: Path, session_id: str) -> None:
    """Best-effort delete of a room's land lock file once the room has ended.

    Skipped while any holder, in this or another process, still has the lock, and on
    platforms that refuse to unlink an open file.
    """
    path = record_land_lock_path(workspace_dir, session_id)
    if not path.exists():
        return
    unlink_if_unheld(path)


@contextmanager
def room_land_lock(workspace_dir: Path, session_id: str) -> Iterator[None]:
    """Hold one room's land lock: the in-process session lock, then the cross-process file lock.

    Waits at most ``RECORD_LAND_LOCK_TIMEOUT_SEC`` for another process, then raises
    ``RecordLandingError('land in progress')``. Only a timeout on entry becomes that
    error; a filelock.Timeout raised inside the body propagates unchanged.
    """
    with _LAND_LOCKS.get(session_id), ExitStack() as stack:
        try:
            stack.enter_context(
                hold_shared_file_lock(
                    record_land_lock_path(workspace_dir, session_id),
                    timeout=RECORD_LAND_LOCK_TIMEOUT_SEC,
                )
            )
        except FileLockTimeout as exc:
            raise RecordLandingError("land in progress") from exc
        yield


_UNDO_HINT = "undo the record_land step through history to remove the stale registration"


def purge_session_land_rollbacks(project: EpisodeProject, session_id: str) -> None:
    """Drop a revoked room's deferred rollbacks: landing can no longer retry them.

    Runs under the room's land lock, so an in-flight land finishes and defers its
    rollbacks first instead of writing a row after the purge.
    """
    try:
        with room_land_lock(project.workspace_path(), session_id):
            purged = RecordUploadService(project).clear_session_land_rollbacks(session_id)
    except Exception:
        log.exception(
            "could not purge deferred land rollbacks session=%s; if a rollback was pending, %s",
            session_id,
            _UNDO_HINT,
        )
        return
    if purged:
        log.warning(
            "purged %d deferred land rollbacks of revoked room session=%s; %s",
            purged,
            session_id,
            _UNDO_HINT,
        )


class RecordLandingError(CodedError, ValueError):
    """Refuse to land or discard a take."""

    code = "record_land_refused"


class SessionSuggestionClosedError(RecordLandingError):
    """A land into a staged session that was accepted or skipped (``code`` ``session_suggestion_closed``)."""

    code = "session_suggestion_closed"


class InsertAnchorTakenError(RecordLandingError):
    """A second pending insert session at one spot (``code`` ``insert_anchor_taken``)."""

    code = "insert_anchor_taken"


class TakeAlreadyPlacedError(RecordLandingError):
    """Discard of a take an accepted session already placed (``code`` ``take_already_placed``)."""

    code = "take_already_placed"


class RecordTakeOpenError(RecordLandingError):
    """Host land refused while a take is recording or paused (``code`` ``take_open``)."""

    code = "take_open"

    def __init__(self) -> None:
        super().__init__(LAND_TAKE_OPEN_MSG)


def record_source_id(
    session_id: str, take_index: int, participant_id: str, segment_index: int
) -> str:
    return f"{record_source_prefix(session_id)}{take_index}-{participant_id}-{segment_index}"


def wav_pcm_info(path: Path) -> tuple[int, int, int]:
    """Return (sample_rate, channels, nframes) from a PCM WAV we assembled."""
    try:
        with open_wav(path) as wf:
            sample_rate = int(wf.getframerate() or 0)
            channels = int(wf.getnchannels() or 0)
            nframes = int(wf.getnframes() or 0)
            width = int(wf.getsampwidth() or 0)
            comptype = str(wf.getcomptype() or "NONE")
    except (OSError, wave.Error) as exc:
        raise RecordLandingError("invalid full-quality recording wav") from exc
    if sample_rate <= 0 or nframes < 0 or width not in (1, 2) or comptype != "NONE":
        raise RecordLandingError("invalid full-quality recording wav")
    return sample_rate, channels or 1, nframes


def _wav_duration_s(path: Path) -> float | None:
    try:
        if not path.is_file():
            return None
        rate, _channels, samples = wav_pcm_info(path)
    except (OSError, RecordLandingError):
        return None
    return duration_s(samples, rate)


def _acked_recorded_by_take(
    segments: list[dict[str, Any]],
    *,
    tombstoned: set[int],
    roles: Mapping[str, str] | None,
) -> dict[int, dict[str, list[dict[str, Any]]]]:
    by_take: dict[int, dict[str, list[dict[str, Any]]]] = {}
    for row in segments:
        if not row.get("file_ack"):
            continue
        take_idx = int(row["take_index"])
        if take_idx in tombstoned:
            continue
        pid = str(row["participant_id"])
        if roles is not None and roles.get(pid) not in RECORDED_ROLES:
            continue
        by_take.setdefault(take_idx, {}).setdefault(pid, []).append(row)
    for people in by_take.values():
        for rows in people.values():
            rows.sort(key=lambda item: int(item["segment_index"]))
    return by_take


def _first_overlapping_indexes(
    ref_rows: list[dict[str, Any]],
    other_rows: list[dict[str, Any]],
    ref_durs: list[float | None],
    other_durs: list[float | None],
) -> tuple[int, int] | None:
    for i, ref in enumerate(ref_rows):
        ref_dur = ref_durs[i]
        if ref_dur is None:
            continue
        ref_join = int(ref.get("join_offset_ms") or 0)
        for j, other in enumerate(other_rows):
            other_dur = other_durs[j]
            if other_dur is None:
                continue
            other_join = int(other.get("join_offset_ms") or 0)
            if overlap_window_s(ref_join, ref_dur, other_join, other_dur) is not None:
                return i, j
    return None


def _segment_duration_error_ms(
    rows: list[dict[str, Any]],
    durs: list[float | None],
    *,
    take_duration_ms: int,
) -> float | None:
    errors: list[float] = []
    for index, row in enumerate(rows):
        actual = durs[index]
        if actual is None:
            continue
        next_join = (
            int(rows[index + 1].get("join_offset_ms") or 0) if index + 1 < len(rows) else None
        )
        error = duration_error_ms(
            actual,
            expected_span_s(
                int(row.get("join_offset_ms") or 0),
                take_duration_ms=take_duration_ms,
                next_join_offset_ms=next_join,
            ),
        )
        if error is not None:
            errors.append(error)
    if not errors:
        return None
    return max(errors, key=abs)


def measure_keeper_drifts(
    *,
    session_id: str,
    takes: list[TakeState],
    segments: list[dict[str, Any]],
    acked_wav: Callable[[str, int, str, int], Path],
    tombstoned: set[int],
    roles: Mapping[str, str] | None = None,
) -> tuple[float | None, list[dict[str, Any]]]:
    """Sample-count vs recording-clock error on overlapping file-acked segments.

    Isolated dry keepers have no shared waveform, so this does not run GCC-PHAT.
    Fewer than two recorded ACKs, a missing file, or no overlapping pair leaves
    ``drift_ms`` null (unknown), never a fail-open 0.
    """
    grouped = _acked_recorded_by_take(segments, tombstoned=tombstoned, roles=roles)
    details: list[dict[str, Any]] = []
    abs_values: list[float] = []
    unverified = False
    take_by_index = {int(take.take_index): take for take in takes}
    for take_index, by_pid in sorted(grouped.items()):
        take = take_by_index.get(take_index)
        if take is None or not session_start_present(take) or len(by_pid) < 2:
            continue
        take_ms = take_recording_duration_ms(take)
        if HOST_PARTICIPANT_ID in by_pid:
            ref_pid = HOST_PARTICIPANT_ID
        else:
            ref_pid = min(
                by_pid,
                key=lambda pid: (int(by_pid[pid][0].get("join_offset_ms") or 0), pid),
            )
        durations: dict[str, list[float | None]] = {}
        for pid, rows in by_pid.items():
            durs: list[float | None] = []
            for row in rows:
                try:
                    path = acked_wav(
                        session_id,
                        take_index,
                        pid,
                        int(row["segment_index"]),
                    )
                    durs.append(_wav_duration_s(path))
                except (OSError, RecordLandingError, TypeError, ValueError):
                    durs.append(None)
            durations[pid] = durs
        ref_rows = by_pid[ref_pid]
        ref_durs = durations[ref_pid]
        if all(item is None for item in ref_durs):
            unverified = True
            continue
        for pid, rows in by_pid.items():
            overlap = True
            if pid != ref_pid:
                overlap = (
                    _first_overlapping_indexes(ref_rows, rows, ref_durs, durations[pid]) is not None
                )
            error = _segment_duration_error_ms(rows, durations[pid], take_duration_ms=take_ms)
            if pid != ref_pid and not overlap:
                unverified = True
                details.append(
                    {
                        "participant_id": pid,
                        "take_index": take_index,
                        "drift_ms": None,
                        "confidence": 0.0,
                        "duration_error_ms": error,
                    }
                )
                continue
            if error is None:
                unverified = True
            else:
                abs_values.append(abs(error))
            details.append(
                {
                    "participant_id": pid,
                    "take_index": take_index,
                    "drift_ms": error,
                    "confidence": 1.0 if error is not None else 0.0,
                    "duration_error_ms": error,
                    **({"reference": True} if pid == ref_pid else {}),
                }
            )
    if unverified or not abs_values:
        return None, details
    return max(abs_values), details


class RecordLandingService:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.workspace = workspace
        session_id = RecordSessionService.active_session_id(workspace.project)
        if not session_id:
            raise FileNotFoundError("no active record room")
        self.session_id = parse_session_id(session_id)
        self._bound_project: EpisodeProject | None = None
        self._bound_room: RecordSessionService | None = None
        self._bound_upload: RecordUploadService | None = None
        self._plan: dict[str, TrackMatch] | None = None

    # Bound to the current ``workspace.project``: ``reload()``
    # replaces that object during a land (#503); ``mutate()`` adopts a newer saved project in
    # place. The services are rebuilt only when the project object changes.
    def _rebind(self) -> EpisodeProject:
        project = self.workspace.project
        if project is not self._bound_project:
            self._bound_project = project
            self._bound_room = None
            self._bound_upload = None
        return project

    @property
    def _room(self) -> RecordSessionService:
        project = self._rebind()
        if self._bound_room is None:
            self._bound_room = RecordSessionService(project, session_id=self.session_id)
        return self._bound_room

    @property
    def _upload(self) -> RecordUploadService:
        project = self._rebind()
        if self._bound_upload is None:
            self._bound_upload = RecordUploadService(project)
        return self._bound_upload

    @property
    def _comments(self) -> RecordLiveCommentStore:
        return live_comment_store_for(self.workspace.project)

    @contextmanager
    def _land_guard(self) -> Iterator[None]:
        """Serialize land and discard for this room across threads and processes.

        The session lock orders threads. The workspace file lock orders processes
        (GUI ACK auto-land vs. a CLI or MCP ``record land``), so each land's re-read
        of the saved project sees the previous land's commit and landed marks (#503).
        Waits at most ``RECORD_LAND_LOCK_TIMEOUT_SEC`` for another process, then raises
        ``RecordLandingError('land in progress')`` so callers can retry. Exclusion relies
        on OS advisory file locks, which network or synced filesystems may not honour (see
        recording-session.md § Timeline landing).
        """
        with room_land_lock(self.workspace.project.workspace_path(), self.session_id):
            yield

    def _snapshot(self) -> RecordSnapshot:
        return RecordSnapshot.model_validate(self._room.snapshot())

    def land(
        self,
        *,
        align: AlignFn | None = None,
        drift_ms: float | None = None,
    ) -> dict[str, Any]:
        """Land every file-ACKed keeper, room-tone bed and live comment of this room.

        Land re-reads the saved project first (``workspace.reload()``; ``mutate()``
        re-reads under the cross-process lock), so the workspace must hold no unsaved
        edits. Unsaved edits on ``workspace.project`` are discarded only when another
        writer committed since this workspace loaded or last committed, and the land
        commits on the saved copy. Callers open a request-scoped ``ProjectWorkspace`` (#503).
        """
        with self._land_guard():
            try:
                return self._land_locked(align=align, drift_ms=drift_ms)
            except (SessionSuggestionClosedError, InsertAnchorTakenError):
                raise
            except Exception:
                self._mark_pending_land_failed()
                raise

    def _mark_pending_land_failed(self) -> None:
        status = self._upload.status(session_id=self.session_id)
        for row in status["segments"] + self._upload.room_tone_status(session_id=self.session_id):
            if row.get("file_ack") and not row.get("landed"):
                self._upload.mark_land_failed(
                    session_id=self.session_id,
                    take_index=int(row["take_index"]),
                    participant_id=str(row["participant_id"]),
                    segment_index=int(row["segment_index"]),
                    expected_sha256=row.get("file_sha256"),
                )

    def _land_locked(
        self,
        *,
        align: AlignFn | None,
        drift_ms: float | None,
        reload: bool = True,
        session_closed: bool | None = None,
    ) -> dict[str, Any]:
        try:
            return self._land_planned(
                align=align, drift_ms=drift_ms, reload=reload, session_closed=session_closed
            )
        finally:
            self._plan = None

    def _land_planned(
        self,
        *,
        align: AlignFn | None,
        drift_ms: float | None,
        reload: bool = True,
        session_closed: bool | None = None,
    ) -> dict[str, Any]:
        if reload:
            # Land callers open their workspace before the body read / land lock wait;
            # adopt any land another request committed meanwhile (#503).
            self.workspace.reload()
        self._retry_deferred_rollbacks()
        snap = self._snapshot()
        # One answer to "who is on which track" for this whole land, so the pre-lock checks and
        # the placement under the lock cannot disagree.
        self._plan = self._track_matches(self.workspace.project, snap)
        tombstoned = self._upload.tombstoned_takes(self.session_id)
        staged = snap.target.kind in STAGED_TARGET_KINDS
        anchor_s = (
            round(
                session_placement(self.workspace.project.clips, self.session_id, snap.target) * 1000
            )
            / 1000.0
        )
        offsets = session_take_offsets_s(
            snap.takes,
            self.workspace.project.clips,
            self.session_id,
            snap.target,
            tombstoned=tombstoned,
        )
        names = {
            person.participant_id: person.display_name
            for person in snap.participants
            if person.role in RECORDED_ROLES
        }
        roles = {person.participant_id: person.role for person in snap.participants}
        status = self._upload.status(session_id=self.session_id)
        pending = [
            row
            for row in status["segments"]
            if row.get("file_ack")
            and int(row["take_index"]) not in tombstoned
            and (not row.get("landed") or (staged and self._staged_source_missing(row, roles)))
        ]
        pending.sort(
            key=lambda row: (
                int(row["take_index"]),
                str(row["participant_id"]),
                int(row["segment_index"]),
            )
        )
        pending_room_tone = [
            row
            for row in self._upload.room_tone_status(session_id=self.session_id)
            if row.get("file_ack")
            and (
                not row.get("landed") or self._room_tone_missing(str(row["participant_id"]), staged)
            )
        ]
        refuse_closed = session_closed is None
        closed = staged and (
            self._suggestion_closed() if session_closed is None else session_closed
        )
        if closed:
            if pending or pending_room_tone:
                self._refuse_closed(refuse_closed)
            pending, pending_room_tone = [], []
        if pending and staged and isinstance(snap.target, InsertTarget):
            held = session_suggestion_for(self.workspace.project, self.session_id)
            self._refuse_taken_anchor(
                self.workspace.project,
                held.anchor
                if held is not None
                else capture_insert_anchor(self.workspace.project, snap.target.at_sec),
            )
        for row in pending_room_tone:
            acked = self._gate_acked(row, roles, mark=False)
            if acked is None:
                continue
            try:
                size = acked.stat().st_size
            except OSError:
                size = 0
            if size > ROOM_TONE_MAX_PCM_BYTES + 44:
                raise RecordLandingError("room tone too large")
        copied: list[dict[str, Any]] = []
        room_tone_copied: list[dict[str, Any]] = []
        with resolve_progress_task(
            "record_land_tool",
            "Landing full-quality recordings",
            total=max(len(pending) + len(pending_room_tone), 1),
            prefer_parent=True,
        ) as progress:
            progress.set_phase("drift", "Checking sample-count vs recording clock")
            if pending:
                measured_drift, drift_rows = measure_keeper_drifts(
                    session_id=self.session_id,
                    takes=snap.takes,
                    segments=list(status["segments"]),
                    acked_wav=self._upload.acked_wav,
                    tombstoned=tombstoned,
                    roles=roles,
                )
            else:
                measured_drift, drift_rows = None, []
            if drift_ms is None:
                drift_ms = measured_drift
            log.info(
                "record land drift session=%s max_abs_ms=%s per_participant=%s",
                self.session_id,
                drift_ms,
                drift_rows,
            )
            progress.set_phase("copy", "Copying full-quality recordings into raw/")
            for row in pending:
                pid = str(row["participant_id"])
                take = int(row["take_index"])
                segment = int(row["segment_index"])
                acked = self._gate_acked(row, roles)
                if acked is None:
                    progress.advance()
                    continue
                try:
                    sample_rate, channels, samples = wav_pcm_info(acked)
                    join_ms = int(row.get("join_offset_ms") or 0)
                    clipping = clipping_regions_from_ms(
                        row.get("clipping_regions"), duration_s(samples, sample_rate)
                    )
                    take_offset = offsets.get(take, 0.0)
                    source_id = record_source_id(self.session_id, take, pid, segment)
                    _dest, rel = _copy_into_raw(
                        self.workspace.project,
                        acked,
                        source_id,
                        expected_sha256=row.get("file_sha256"),
                    )
                except (OSError, RecordLandingError) as exc:
                    log.warning(
                        "record land skipped keeper session=%s take=%s pid=%s seg=%s: %s",
                        self.session_id,
                        take,
                        pid,
                        segment,
                        exc,
                    )
                    progress.advance()
                    continue
                copied.append(
                    {
                        "participant_id": pid,
                        "take_index": take,
                        "segment_index": segment,
                        "join_offset_ms": join_ms,
                        "timeline_s": clip_timeline_s(take_offset, join_ms),
                        "staged_offset_s": clip_timeline_s(take_offset - anchor_s, join_ms),
                        "duration_s": duration_s(samples, sample_rate),
                        "sample_rate": sample_rate,
                        "channels": channels,
                        "rel": rel,
                        "source_id": source_id,
                        "file_sha256": row.get("file_sha256"),
                        "label": names.get(pid) or pid,
                        "clipping": clipping,
                        "clipping_truncated": bool(row.get("clipping_truncated")),
                    }
                )
                progress.advance()
            progress.set_phase("copy", "Copying room-tone beds into raw/")
            for row in pending_room_tone:
                pid = str(row["participant_id"])
                take = int(row["take_index"])
                segment = int(row["segment_index"])
                acked = self._gate_acked(row, roles)
                if acked is None:
                    progress.advance()
                    continue
                sample_rate, channels, samples = wav_pcm_info(acked)
                rel = _copy_room_tone(self.workspace.project, acked, self.session_id, pid)
                room_tone_copied.append(
                    {
                        "participant_id": pid,
                        "take_index": take,
                        "segment_index": segment,
                        "duration_s": duration_s(samples, sample_rate),
                        "sample_rate": sample_rate,
                        "channels": channels,
                        "rel": rel,
                        "file_sha256": row.get("file_sha256"),
                        "label": names.get(pid) or pid,
                    }
                )
                progress.advance()
            if not pending and not pending_room_tone:
                progress.advance()

        pending_comments = [
            row
            for row in self._comments.list_unlanded(self.session_id)
            if int(row["take_index"]) not in tombstoned
        ]
        if staged:
            pending_comments = self._unstaged_comments(pending_comments, copied)
            if closed and pending_comments:
                self._refuse_closed(refuse_closed)
                pending_comments = []
        fallback = needs_align_fallback(snap.takes, tombstoned=tombstoned, drift_ms=drift_ms)
        if not copied and not pending_comments and not room_tone_copied:
            return {
                "session_id": self.session_id,
                "clips": [],
                "comments": [],
                "align_fallback": fallback,
                "ingest_suggest": False,
                "drift_ms": drift_ms,
                "drift": drift_rows,
                "deferred_rollbacks_pending": self._deferred_rollbacks_pending(),
                "staged": [],
            }

        # Hash each copy once, before any project lock (#365); under it only a stat runs.
        workspace_dir = Path(self.workspace.project.workspace_dir)
        for item in copied + room_tone_copied:
            item["raw_revision"] = _verified_file_revision(
                workspace_dir / str(item["rel"]), item.get("file_sha256")
            )

        session_params: dict[str, Any] = {"session_id": self.session_id}
        label = "record land"
        planning_project = self.workspace.project
        if any(
            self._copied_raw_matches(planning_project, item) and self._ack_generation_current(item)
            for item in copied
        ):
            label = record_land_title(
                record_session_number(planning_project, self.session_id),
                first=not session_landed_before(planning_project, self.session_id),
                staged=staged,
            )
            session_params["session_staged"] = staged

        # ``mutate`` runs on the project it re-reads under the cross-process
        # project lock. It can be newer than the copy planned from above when a
        # non-land writer (edit, share, comment) committed meanwhile. Land and
        # discard are serialized by the session land lock, other writers are not.
        # Everything written here is re-derived from ``project``:
        # ``_copied_raw_matches``, the source/clip/track upserts, and
        # ``_land_live_comments``, which upserts by id. The earlier inputs come from
        # the record session store (``snap`` offsets, ``fallback``) or only widen what
        # is re-applied (the room-tone set from ``_room_tone_missing``).
        # Re-registering a bed is an idempotent upsert, so a stale planning read
        # cannot drop or corrupt newer project state.
        def mutate(project: EpisodeProject) -> dict[str, Any]:
            landed_before = session_landed_before(project, self.session_id)
            landed_clips: list[dict[str, Any]] = []
            staged_takes: list[dict[str, Any]] = []
            accepted: list[dict[str, Any]] = []
            touched: set[str] = set()
            matches = self._plan if self._plan is not None else self._track_matches(project, snap)
            for item in copied:
                if not self._copied_raw_matches(project, item):
                    self._mark_copied_failed(item)
                    continue
                if not self._ack_generation_current(item):
                    _log_superseded(self.session_id, item)
                    continue
                track_id, item["label"] = _track_for(matches, item)
                source_id = str(item["source_id"])
                rel = str(item["rel"])
                prior = capture_prior(
                    project, track_id=track_id, source_id=source_id, rel=rel, room_tone=False
                )
                previous_rel = prior.source.path if prior.source is not None else None
                if staged:
                    upsert_source(
                        project,
                        source_id=source_id,
                        rel=rel,
                        speaker=str(item["label"]),
                        duration_s=float(item["duration_s"]),
                        sample_rate=int(item["sample_rate"]),
                        channels=int(item["channels"]),
                        clipping_regions=item["clipping"],
                        clipping_truncated=bool(item["clipping_truncated"]),
                    )
                    number = _number_session(project, self.session_id, snap.target)
                    session_params.update(session_number=number, session_first=not landed_before)
                    suggestion = session_suggestion_for(project, self.session_id)
                    if suggestion is None:
                        proposed = _proposed_suggestion(
                            project, self.session_id, number, snap.target
                        )
                        self._refuse_taken_anchor(project, proposed.anchor)
                        suggestion = ensure_session_suggestion(project, proposed)
                    elif suggestion.status != "pending":
                        raise SessionSuggestionClosedError(_closed_message(suggestion))
                    upsert_staged_take(
                        suggestion,
                        StagedTake(
                            take_index=int(item["take_index"]),
                            track_id=track_id,
                            track_label=str(item["label"]),
                            segment_index=int(item["segment_index"]),
                            source_id=source_id,
                            offset_s=float(item["staged_offset_s"]),
                            duration_s=float(item["duration_s"]),
                        ),
                    )
                    accepted.append({**item, "prior": prior})
                    staged_takes.append(
                        {
                            "suggestion_id": suggestion.id,
                            "track_id": track_id,
                            "source_id": source_id,
                            "participant_id": item["participant_id"],
                            "take_index": item["take_index"],
                            "segment_index": item["segment_index"],
                            "offset_s": float(item["staged_offset_s"]),
                            "duration_s": float(item["duration_s"]),
                            "raw_path": rel,
                        }
                    )
                    continue
                clip = place_take_clip(
                    project,
                    track_id=track_id,
                    label=str(item["label"]),
                    source_id=source_id,
                    rel=rel,
                    timeline_s=float(item["timeline_s"]),
                    duration_s=float(item["duration_s"]),
                    sample_rate=int(item["sample_rate"]),
                    channels=int(item["channels"]),
                    previous_rel=previous_rel,
                    clipping_regions=item["clipping"],
                    clipping_truncated=bool(item["clipping_truncated"]),
                )
                touched.add(track_id)
                accepted.append({**item, "prior": prior})
                landed_clips.append(
                    {
                        "clip_id": clip.id,
                        "track_id": track_id,
                        "source_id": source_id,
                        "participant_id": item["participant_id"],
                        "take_index": item["take_index"],
                        "segment_index": item["segment_index"],
                        "timeline_start": clip.timeline_start,
                        "duration_s": float(item["duration_s"]),
                        "raw_path": rel,
                    }
                )
            for item in room_tone_copied:
                if not self._copied_raw_matches(project, item):
                    self._mark_copied_failed(item)
                    continue
                if not self._ack_generation_current(item):
                    _log_superseded(self.session_id, item)
                    continue
                track_id, item["label"] = _track_for(matches, item)
                rel = str(item["rel"])
                prior = capture_prior(
                    project,
                    track_id=track_id,
                    source_id=room_tone_source_id(track_id),
                    rel=rel,
                    room_tone=True,
                )
                if staged:
                    owner = session_suggestion_for(project, self.session_id)
                    if owner is None:
                        continue
                    if owner.status != "pending":
                        raise SessionSuggestionClosedError(_closed_message(owner))
                    hold_room_tone(
                        owner,
                        StagedRoomTone(
                            track_id=track_id,
                            track_label=str(item["label"]),
                            source_id=room_tone_source_id(track_id),
                            path=rel,
                            duration_s=float(item["duration_s"]),
                            sample_rate=int(item["sample_rate"]),
                            channels=int(item["channels"]),
                        ),
                    )
                    accepted.append({**item, "prior": prior})
                    continue
                place_room_tone(
                    project,
                    track_id=track_id,
                    label=str(item["label"]),
                    rel=rel,
                    duration_s=float(item["duration_s"]),
                    sample_rate=int(item["sample_rate"]),
                    channels=int(item["channels"]),
                )
                touched.add(track_id)
                accepted.append({**item, "prior": prior})
            if landed_clips:
                number = _number_session(project, self.session_id, snap.target)
                first = not landed_before
                session_params.update(session_number=number, session_first=first)
                refresh_timeline_duration(project)
                if touched:
                    record_invalidation(project, track_ids=sorted(touched), reason="other")
                if fallback and align is not None:
                    align(project)
            elif touched:
                record_invalidation(project, track_ids=sorted(touched), reason="other")
            if staged:
                held = self._hold_comments(project, pending_comments, offsets, anchor_s)
                return {
                    "clips": [],
                    "comments": [],
                    "accepted": accepted,
                    "staged": staged_takes,
                    "staged_comments": held,
                }
            landed_comments = _land_live_comments(project, pending_comments, offsets)
            return {
                "clips": landed_clips,
                "comments": landed_comments,
                "accepted": accepted,
                "staged": [],
            }

        with self.workspace.transaction():
            try:
                landed = self.workspace.mutate(
                    f"before {label}",
                    f"after {label}",
                    mutate,
                    operation="record_land",
                    params=session_params,
                )
            except (SessionSuggestionClosedError, InsertAnchorTakenError):
                for item in copied + room_tone_copied:
                    self._discard_copy(item)
                raise
            except Exception:
                for item in copied + room_tone_copied:
                    self._mark_copied_failed(item)
                raise
            confirmed: set[tuple[str, int, int]] = set()
            stale: list[dict[str, Any]] = []
            for item in landed["accepted"]:
                key = (
                    str(item["participant_id"]),
                    int(item["take_index"]),
                    int(item["segment_index"]),
                )
                if self._mark_registered_landing(
                    key[0],
                    key[1],
                    key[2],
                    expected_sha256=item["file_sha256"],
                    verified=(
                        (workspace_dir / str(item["rel"])).resolve(),
                        item.get("raw_revision"),
                    ),
                ):
                    confirmed.add(key)
                elif not self._ack_generation_current(item):
                    stale.append(item)
            if stale:
                self._rollback_or_defer(stale)
        clips = [
            item
            for item in landed["clips"]
            if (str(item["participant_id"]), int(item["take_index"]), int(item["segment_index"]))
            in confirmed
        ]
        comments = list(landed["comments"])
        staged_takes = [
            item
            for item in landed["staged"]
            if (str(item["participant_id"]), int(item["take_index"]), int(item["segment_index"]))
            in confirmed
        ]
        self._comments.mark_landed(
            self.session_id,
            [str(row["id"]) for row in comments],
        )
        for track_id in {str(item["track_id"]) for item in clips}:
            track = self.workspace.project.track_by_id(track_id)
            if track is not None and track.media is not None:
                schedule_track_waveforms(
                    self.workspace.project, track, defaults=self.workspace.effective_config()
                )

        after_agent_mutation(self.workspace)
        return {
            "session_id": self.session_id,
            "clips": clips,
            "comments": comments,
            "staged": staged_takes,
            "align_fallback": fallback,
            "ingest_suggest": False,
            "drift_ms": drift_ms,
            "drift": drift_rows,
            "deferred_rollbacks_pending": self._deferred_rollbacks_pending(),
        }

    def delete_take(self, take_index: int) -> dict[str, Any]:
        """Discard take ``take_index`` (clips, sources, live comments), then land what remains.

        Same precondition as ``land``: the discard and the land re-read the saved
        project, so unsaved edits on ``workspace.project`` are discarded.
        """
        take = parse_upload_index(take_index, name="take_index")
        with self._land_guard():
            return self._delete_take_locked(take)

    def _delete_take_locked(self, take: int) -> dict[str, Any]:
        snap = self._snapshot()
        if snap.take_index == take and snap.state in ("recording", "paused"):
            raise RecordLandingError("take is still open")
        if not self._upload.take_manifest_terminal(self.session_id, take):
            raise RecordLandingError("take manifest is not terminal")
        prefix = f"rec-{self.session_id}-{take}-"
        comment_ids = self._comments.ids_for_take(self.session_id, take)

        was_closed = [False]

        def mutate(project: EpisodeProject) -> None:
            placed = session_suggestion_for(project, self.session_id)
            was_closed[0] = placed is not None and placed.status != "pending"
            if (
                placed is not None
                and placed.status == "accepted"
                and any(row.take_index == take for row in placed.takes)
            ):
                raise TakeAlreadyPlacedError(
                    f"Take {take} is already on the timeline as part of Session "
                    f"{placed.session_number}. Undo the accept to discard it."
                )
            drop_ids = {src.id for src in project.sources if src.id.startswith(prefix)}
            drop_tracks = {clip.track_id for clip in project.clips if clip.source_id in drop_ids}
            project.sources = [src for src in project.sources if src.id not in drop_ids]
            project.clips = [clip for clip in project.clips if clip.source_id not in drop_ids]
            drop_staged_takes(project, self.session_id, take)
            kept = {clip.track_id for clip in project.clips}
            project.tracks = [
                track for track in project.tracks if track.id not in drop_tracks or track.id in kept
            ]
            for comment_id in comment_ids:
                if str(comment_id).startswith(LIVE_COMMENT_ID_PREFIX):
                    delete_comment(project, comment_id)
            refresh_timeline_duration(project)

        self.workspace.mutate(
            f"before discard take {take}",
            f"after discard take {take}",
            mutate,
            operation="record_discard_take",
            params={"take_index": take},
        )
        self._upload.tombstone_take(self.session_id, take)
        self._comments.delete_take(self.session_id, take)
        # The discard mutation just re-read and committed the project under the land lock.
        landed = self._land_locked(
            align=None, drift_ms=None, reload=False, session_closed=was_closed[0]
        )
        after_agent_mutation(self.workspace)
        landed["discarded_take"] = take
        return landed

    def _staged_source_missing(self, row: Mapping[str, Any], roles: Mapping[str, str]) -> bool:
        """A landed keeper of a staged session whose source the project no longer holds.

        Undoing the staging land removes the source but leaves the upload row landed; staging
        again re-registers it.
        """
        pid = str(row["participant_id"])
        if roles.get(pid) == "producer":
            return False
        source_id = self._landed_source_id(pid, int(row["take_index"]), int(row["segment_index"]))
        return self.workspace.project.source_by_id(source_id) is None

    def _suggestion_closed(self) -> bool:
        suggestion = session_suggestion_for(self.workspace.project, self.session_id)
        return suggestion is not None and suggestion.status != "pending"

    def _refuse_closed(self, refuse: bool) -> None:
        if not refuse:
            return
        suggestion = session_suggestion_for(self.workspace.project, self.session_id)
        if suggestion is not None:
            raise SessionSuggestionClosedError(_closed_message(suggestion))

    def _refuse_taken_anchor(self, project: EpisodeProject, anchor: InsertAnchor | None) -> None:
        holder = (
            pending_anchor_holder(project, anchor, self.session_id) if anchor is not None else None
        )
        if holder is not None:
            raise InsertAnchorTakenError(
                f"Session {holder.session_number} is already staged at this spot. "
                "Accept or skip it first, or record at another spot."
            )

    def _unstaged_comments(
        self, rows: list[dict[str, Any]], copied: Sequence[Mapping[str, Any]]
    ) -> list[dict[str, Any]]:
        """Live comments a staged land still has to hold: their take has a staged segment, they do not."""
        suggestion = session_suggestion_for(self.workspace.project, self.session_id)
        held = staged_comment_ids(suggestion) if suggestion is not None else set()
        takes = {take.take_index for take in suggestion.takes} if suggestion is not None else set()
        takes |= {int(item["take_index"]) for item in copied}
        return [
            row
            for row in rows
            if str(row["comment_id"]) not in held and int(row["take_index"]) in takes
        ]

    def _hold_comments(
        self,
        project: EpisodeProject,
        rows: list[dict[str, Any]],
        offsets: Mapping[int, float],
        anchor_s: float,
    ) -> list[dict[str, Any]]:
        suggestion = session_suggestion_for(project, self.session_id)
        if suggestion is None:
            return []
        held = staged_comment_ids(suggestion)
        fresh = [row for row in rows if str(row["comment_id"]) not in held]
        stage_comments(
            suggestion,
            [
                (
                    int(row["take_index"]),
                    StagedComment(
                        id=str(row["comment_id"]),
                        body=str(row["body"]),
                        author=str(row["author"]),
                        recording_ms=int(row["recording_ms"]),
                        timeline_offset_s=max(
                            offsets.get(int(row["take_index"]), 0.0) - anchor_s, 0.0
                        ),
                    ),
                )
                for row in fresh
            ],
        )
        after = staged_comment_ids(suggestion)
        return [
            {"id": str(row["comment_id"]), "take_index": int(row["take_index"])}
            for row in fresh
            if str(row["comment_id"]) in after
        ]

    def _track_matches(
        self, project: EpisodeProject, snap: RecordSnapshot | None = None
    ) -> dict[str, TrackMatch]:
        snap = snap or self._snapshot()
        return resolve_session_tracks(
            project, self.session_id, snap.participants, self._room.track_choices()
        )

    def _track_id_for(self, participant_id: str) -> str:
        plan = self._plan if self._plan is not None else self._track_matches(self.workspace.project)
        match = plan.get(participant_id)
        return match.track_id if match is not None else slug_track_id(participant_id)

    def _room_tone_missing(self, participant_id: str, staged: bool = False) -> bool:
        track_id = self._track_id_for(participant_id)
        if staged:
            suggestion = session_suggestion_for(self.workspace.project, self.session_id)
            return suggestion is None or all(
                bed.track_id != track_id for bed in suggestion.room_tone
            )
        track = self.workspace.project.track_by_id(track_id)
        return track is None or track.room_tone is None

    def _landed_source_id(self, participant_id: str, take_index: int, segment_index: int) -> str:
        if take_index == ROOM_TONE_TAKE_INDEX:
            return room_tone_source_id(self._track_id_for(participant_id))
        return record_source_id(self.session_id, take_index, participant_id, segment_index)

    def _mark_missing_acked(
        self,
        participant_id: str,
        take_index: int,
        segment_index: int,
        *,
        expected_sha256: str | None,
    ) -> None:
        """Acked WAV is gone: stay landed only if the registered source holds this row's bytes (#223).

        Room-tone source ids are per participant, so a re-recorded bed would otherwise
        match the previous bed's file; comparing ``file_sha256`` rejects that.
        """
        self._mark_registered_landing(
            participant_id, take_index, segment_index, expected_sha256=expected_sha256
        )

    def _mark_registered_landing(
        self,
        participant_id: str,
        take_index: int,
        segment_index: int,
        *,
        expected_sha256: str | None,
        verified: tuple[Path, FileRevision | None] | None = None,
    ) -> bool:
        """Mark landed only while the registered source still holds the row's bytes.

        Hashing runs outside the project lock (#365); under it a stat confirms the file is
        unchanged and still registered, so the source check and the upload decision stay
        atomic against writers in every process (#309, #213): ``transaction()`` adopts another
        process's commit before the re-check. A same-size rewrite within the file-system mtime
        granularity is not detected. ``verified`` is the ``(path, revision)``
        hashed before the land's lock; pass it when called under that lock so nothing hashes.
        """
        source_id = self._landed_source_id(participant_id, take_index, segment_index)
        with project_state_lock(self.workspace.project):
            registered = self._landing_file(self.workspace.project, source_id, take_index)
        revision: FileRevision | None = None
        if registered is not None:
            if verified is not None:
                # Called under the land's project lock: never hash here.
                revision = verified[1] if verified[0] == registered[0] else None
            else:
                revision = _verified_file_revision(registered[0], expected_sha256)
        with self.workspace.transaction() as project:
            current = self._landing_file(project, source_id, take_index)
            present = (
                registered is not None
                and current is not None
                and current[0] == registered[0]
                and _same_revision(current[0], revision)
            )
            if present:
                return self._upload.mark_landed(
                    session_id=self.session_id,
                    take_index=take_index,
                    participant_id=participant_id,
                    segment_index=segment_index,
                    expected_sha256=expected_sha256,
                )
            log.warning(
                "record land source missing or mismatched session=%s take=%s pid=%s seg=%s",
                self.session_id,
                take_index,
                participant_id,
                segment_index,
            )
            self._upload.mark_land_failed(
                session_id=self.session_id,
                take_index=take_index,
                participant_id=participant_id,
                segment_index=segment_index,
                expected_sha256=expected_sha256,
            )
            return False

    def _landing_file(
        self, project: EpisodeProject, source_id: str, take_index: int
    ) -> tuple[Path, str] | None:
        if take_index == ROOM_TONE_TAKE_INDEX:
            suggestion = session_suggestion_for(project, self.session_id)
            if suggestion is None:
                return _registered_source_file(project, source_id)
            bed = next((bed for bed in suggestion.room_tone if bed.source_id == source_id), None)
            if bed is not None:
                dest = (Path(project.workspace_dir) / bed.path).resolve()
                return (dest, bed.path) if dest.is_file() else None
        return _registered_source_file(project, source_id)

    def _copied_raw_matches(self, project: EpisodeProject, item: dict[str, Any]) -> bool:
        """Check under the lock, with one stat, that the copy hashed before the lock is unchanged."""
        return _same_revision(
            Path(project.workspace_dir) / str(item["rel"]), item.get("raw_revision")
        )

    def _discard_copy(self, item: dict[str, Any]) -> None:
        rel = str(item["rel"])
        project = self.workspace.project
        if any(source.path == rel for source in project.sources):
            return
        try:
            (Path(project.workspace_dir) / rel).unlink(missing_ok=True)
        except OSError:
            log.warning("could not remove unplaced copy session=%s rel=%s", self.session_id, rel)

    def _mark_copied_failed(self, item: dict[str, Any]) -> None:
        self._upload.mark_land_failed(
            session_id=self.session_id,
            take_index=int(item["take_index"]),
            participant_id=str(item["participant_id"]),
            segment_index=int(item["segment_index"]),
            expected_sha256=item["file_sha256"],
        )

    def _ack_generation_current(self, item: dict[str, Any]) -> bool:
        """False when a re-ACK or revoke changed the upload row since we copied it."""
        expected = item.get("file_sha256")
        if not expected:
            return False
        current = self._upload.acked_file_sha256(
            session_id=self.session_id,
            take_index=int(item["take_index"]),
            participant_id=str(item["participant_id"]),
            segment_index=int(item["segment_index"]),
        )
        return current == expected

    def _rollback_stale(self, stale: list[dict[str, Any]]) -> None:
        """Revert project media landing registered for items whose ACK went stale."""
        log.warning(
            "record land rolling back stale ACK generation session=%s items=%s",
            self.session_id,
            [(item["participant_id"], item["take_index"], item["segment_index"]) for item in stale],
        )
        superseded = [
            (str(item["participant_id"]), int(item["take_index"]), int(item["segment_index"]))
            for item in stale
        ]

        def mutate(project: EpisodeProject) -> None:
            touched: set[str] = set()
            for item in reversed(stale):
                prior: PriorRegistration = item["prior"]
                if (
                    prior.room_tone
                    and self._copied_raw_matches(project, item)
                    and drop_staged_room_tone(project, self.session_id, prior.track_id, prior.rel)
                ):
                    continue
                if not self._rollback_applies(project, item):
                    continue
                if revert_registration(project, prior) and not drop_staged_segment(
                    project, self.session_id, prior.source_id
                ):
                    touched.add(prior.track_id)
            if touched:
                refresh_timeline_duration(project)
                record_invalidation(project, track_ids=sorted(touched), reason="other")

        self.workspace.mutate(
            "before record land stale ACK rollback",
            "after record land stale ACK rollback",
            mutate,
            operation="record_land_rollback",
            params={"session_id": self.session_id, "superseded": superseded},
        )

    def _rollback_applies(self, project: EpisodeProject, item: dict[str, Any]) -> bool:
        """Whether *item*'s stale registration is still in the project to undo.

        Beds share one fixed raw path per participant, so the path guard in
        ``revert_registration`` can't tell generations apart; a newer bed already
        overwrote the stale bytes -- keep it.
        """
        prior: PriorRegistration = item["prior"]
        if not registration_present(project, prior):
            return False
        return not prior.room_tone or self._copied_raw_matches(project, item)

    def _rollback_or_defer(self, stale: list[dict[str, Any]]) -> None:
        """Persist *stale*, roll it back, and clear it; on failure keep it for the next land.

        Never raises: confirmed items already committed and were marked landed. The rows
        are written before the rollback runs but after the ``record_land`` commit, so a
        crash between that commit and this call still loses the rollback. Persisting is
        best effort: if it fails the rollback still runs. A failed rollback leaves the
        stale registration until the next land retries it; meanwhile ``track.media`` is
        moved off the stale keeper rels.
        """
        try:
            self._defer_rollbacks(stale)
        except Exception:
            log.exception(
                "record land could not persist deferred rollback session=%s", self.session_id
            )
        try:
            self._rollback_stale(stale)
        except Exception:
            log.exception("record land stale ACK rollback failed session=%s", self.session_id)
            self._drop_failed_write()
            self._repoint_stale_media(stale)
            return
        self._clear_deferred(stale)

    def _rollback_key(self, item: Mapping[str, Any]) -> LandRollbackKey:
        return LandRollbackKey(
            session_id=self.session_id,
            take_index=int(item["take_index"]),
            participant_id=str(item["participant_id"]),
            segment_index=int(item["segment_index"]),
            file_sha256=str(item["file_sha256"]),
        )

    def _defer_rollbacks(self, items: list[dict[str, Any]]) -> None:
        for item in items:
            revision = item.get("raw_revision")
            self._upload.defer_land_rollback(
                self._rollback_key(item),
                raw_rel=str(item["rel"]),
                raw_revision=list(revision) if revision is not None else [],
                prior_json=prior_to_json(item["prior"]),
            )

    def _clear_deferred(self, items: Sequence[Mapping[str, Any]]) -> None:
        try:
            for item in items:
                self._upload.clear_land_rollback(self._rollback_key(item))
        except Exception:
            log.exception(
                "record land could not clear deferred rollback session=%s", self.session_id
            )

    def _note_retry_failed(self, rows: Sequence[Mapping[str, Any]]) -> None:
        now = time.time_ns()
        try:
            for row in rows:
                attempts = int(row.get("attempts") or 0) + 1
                self._upload.note_land_rollback_failure(
                    self._rollback_key(row),
                    retry_after_ns=rollback_retry_after_ns(attempts, now),
                )
        except Exception:
            log.exception(
                "record land could not record deferred rollback attempt session=%s",
                self.session_id,
            )

    def _deferred_rollbacks_pending(self) -> int | None:
        """Deferred rollbacks still stored for this room (None when the store can't be read)."""
        try:
            return len(self._upload.land_rollbacks(session_id=self.session_id))
        except Exception:
            log.exception(
                "record land could not count deferred rollbacks session=%s", self.session_id
            )
            return None

    def _drop_failed_write(self) -> None:
        """A failed mutation leaves in-memory state ahead of disk; re-read the saved project."""
        try:
            self.workspace.discard_changes()
        except Exception:
            log.exception(
                "record land could not reload after failed write session=%s", self.session_id
            )

    def _moot_reason(self, project: EpisodeProject, item: dict[str, Any]) -> str | None:
        """Why a deferred rollback no longer applies, or None while it is still due."""
        if self._ack_generation_current(item):
            return "ACK generation current again"
        if not registration_present(project, item["prior"]):
            return "stale registration gone"
        if not self._rollback_applies(project, item):
            return _MOOT_BED
        return None

    def _retry_deferred_rollbacks(self) -> None:
        """Re-run rollbacks a previous land could not commit; never fails the land.

        A failed retry backs its rows off exponentially (``retry_after_ns``); rows still
        backing off are skipped. An unreadable row is kept and backed off too.
        """
        try:
            rows = self._upload.land_rollbacks(session_id=self.session_id)
        except Exception:
            log.exception(
                "record land could not read deferred rollbacks session=%s", self.session_id
            )
            return
        now = time.time_ns()
        project = self.workspace.project
        due: list[dict[str, Any]] = []
        drop: list[dict[str, Any]] = []
        failed: list[dict[str, Any]] = []
        for row in rows:
            if int(row.get("retry_after_ns") or 0) > now:
                continue
            try:
                item = _item_from_deferred(row)
            except Exception:
                log.warning(
                    "kept unreadable deferred rollback session=%s take=%s pid=%s seg=%s",
                    self.session_id,
                    row.get("take_index"),
                    row.get("participant_id"),
                    row.get("segment_index"),
                )
                failed.append(row)
                continue
            reason = self._moot_reason(project, item)
            if reason is None:
                due.append(item)
                continue
            log.log(
                logging.WARNING if reason == _MOOT_BED else logging.INFO,
                "dropped moot deferred rollback session=%s take=%s pid=%s seg=%s reason=%s",
                self.session_id,
                item["take_index"],
                item["participant_id"],
                item["segment_index"],
                reason,
            )
            drop.append(item)
        if drop:
            self._clear_deferred(drop)
        if failed:
            self._note_retry_failed(failed)
        if not due:
            return
        try:
            self._rollback_stale(due)
        except Exception:
            log.exception("deferred stale ACK rollback failed session=%s", self.session_id)
            self._drop_failed_write()
            self._note_retry_failed(due)
            return
        self._clear_deferred(due)

    def _repoint_stale_media(self, stale: list[dict[str, Any]]) -> None:
        """Best effort: after a failed rollback, set ``track.media`` to what the rollback would.

        That is the stale item's ``prior.media`` when it is not itself a stale rel, else the
        earliest clip whose source is not stale. A later retry of the rollback then leaves
        ``track.media`` as an immediate rollback would have.
        """
        priors: dict[str, PriorRegistration] = {
            str(item["rel"]): item["prior"] for item in stale if not item["prior"].room_tone
        }
        if not priors:
            return
        skip = frozenset(prior.source_id for prior in priors.values())

        def needs(project: EpisodeProject) -> list[str]:
            return sorted(
                t.id for t in project.tracks if t.media is not None and t.media.path in priors
            )

        try:
            if not needs(self.workspace.project):
                return

            def mutate(project: EpisodeProject) -> None:
                ids = needs(project)
                for track_id in ids:
                    track = project.track_by_id(track_id)
                    if track is None or track.media is None:
                        continue
                    prior_media = priors[track.media.path].media
                    if prior_media is not None and prior_media.path not in priors:
                        track.media = prior_media.model_copy(deep=True)
                    else:
                        track.media = media_from_remaining_clip(
                            project, track_id, skip_source_ids=skip
                        )
                if ids:
                    record_invalidation(project, track_ids=ids, reason="other")

            self.workspace.mutate(
                "before record land media repair",
                "after record land media repair",
                mutate,
                operation="record_land_media_repair",
                params={"session_id": self.session_id},
            )
        except Exception:
            log.exception("record land media repair failed session=%s", self.session_id)
            self._drop_failed_write()

    def _gate_acked(
        self,
        row: dict[str, Any],
        roles: Mapping[str, str],
        *,
        mark: bool = True,
    ) -> Path | None:
        pid = str(row["participant_id"])
        take = int(row["take_index"])
        segment = int(row["segment_index"])
        if roles.get(pid) == "producer":
            if mark:
                self._upload.mark_landed(
                    session_id=self.session_id,
                    take_index=take,
                    participant_id=pid,
                    segment_index=segment,
                    expected_sha256=row.get("file_sha256"),
                )
            return None
        acked = self._upload.acked_wav(self.session_id, take, pid, segment)
        if not acked.is_file():
            if mark:
                self._mark_missing_acked(pid, take, segment, expected_sha256=row.get("file_sha256"))
            return None
        return acked


def _item_from_deferred(row: dict[str, Any]) -> dict[str, Any]:
    """Rebuild a landing item from a persisted deferred-rollback row."""
    revision = json.loads(str(row["raw_revision"]))
    return {
        "take_index": int(row["take_index"]),
        "participant_id": str(row["participant_id"]),
        "segment_index": int(row["segment_index"]),
        "file_sha256": str(row["file_sha256"]),
        "rel": str(row["raw_rel"]),
        "raw_revision": tuple(revision) if revision else None,
        "prior": prior_from_json(str(row["prior_json"])),
        "attempts": int(row.get("attempts") or 0),
    }


def _track_for(matches: Mapping[str, TrackMatch], item: Mapping[str, Any]) -> tuple[str, str]:
    """The track id and label a copied item lands on: matched by name, else a fresh track."""
    pid = str(item["participant_id"])
    match = matches.get(pid)
    if match is None:
        return slug_track_id(pid), str(item["label"])
    return match.track_id, match.track_label


def _log_superseded(session_id: str, item: dict[str, Any]) -> None:
    log.info(
        "record land skipped superseded ACK session=%s take=%s pid=%s seg=%s",
        session_id,
        item.get("take_index"),
        item.get("participant_id"),
        item.get("segment_index"),
    )


def _verified_file_revision(path: Path, expected_sha256: str | None) -> FileRevision | None:
    """Hash ``path`` outside any project lock; its revision when the bytes match (#365).

    The revision is read before and after hashing, so a file replaced or rewritten
    meanwhile returns None. Under the lock ``_same_revision`` then costs one stat.
    """
    if not expected_sha256:
        return None
    try:
        before = file_revision(path)
        if sha256_file(path) != expected_sha256:
            return None
        return before if file_revision(path) == before else None
    except OSError:
        return None


def _same_revision(path: Path, revision: FileRevision | None) -> bool:
    if revision is None:
        return False
    try:
        return file_revision(path) == revision
    except OSError:
        return False


def _registered_source_file(project: EpisodeProject, source_id: str) -> tuple[Path, str] | None:
    """``(absolute path, rel)`` of ``sources[source_id]`` when that file exists on disk."""
    existing = project.source_by_id(source_id)
    if existing is None:
        return None
    dest = (Path(project.workspace_dir) / existing.path).resolve()
    return (dest, existing.path) if dest.is_file() else None


def room_tone_raw_rel(session_id: str, participant_id: str) -> str:
    """Return the session-qualified raw path for a room-tone bed."""
    sid = parse_session_id(session_id)
    pid = parse_participant_id(participant_id)
    return f"raw/room-tone/{sid}/{pid}.wav"


def _copy_into_raw(
    project: EpisodeProject,
    acked: Path,
    source_id: str,
    *,
    expected_sha256: str | None = None,
) -> tuple[Path, str]:
    """Copy *acked* into ``raw/`` and return ``(dest, workspace-relative path)``.

    *source_id* is used to reuse an already registered source file and to
    name a fresh ``unique_raw_path``. Landed-state checks use
    ``_registered_source_file`` with the row's SHA-256 in
    ``_mark_missing_acked``, not this helper.
    """
    ws = Path(project.workspace_dir)
    registered = _registered_source_file(project, source_id)
    if registered is not None and expected_sha256:
        try:
            if sha256_file(registered[0]) == expected_sha256:
                return registered
        except OSError:
            pass
    dest = unique_raw_path(ws, f"{source_id}.wav")
    copy_file_atomic(acked, dest)
    rel = str(dest.relative_to(ws)).replace("\\", "/")
    return dest, rel


def _copy_room_tone(
    project: EpisodeProject, acked: Path, session_id: str, participant_id: str
) -> str:
    ws = Path(project.workspace_dir)
    rel = room_tone_raw_rel(session_id, participant_id)
    copy_file_atomic(acked, ws / rel)
    return rel


def _closed_message(suggestion: SessionSuggestion) -> str:
    return (
        f"Session {suggestion.session_number} was {suggestion.status}, so it takes no more "
        "recordings. Record again as a new session."
    )


def _land_live_comments(
    project: EpisodeProject,
    rows: list[dict[str, Any]],
    offsets: dict[int, float],
) -> list[dict[str, Any]]:
    landed: list[dict[str, Any]] = []
    for row in rows:
        take = int(row["take_index"])
        cid = str(row["comment_id"])
        who = str(row["author"])
        existing = next((item for item in project.comments if item.id == cid), None)
        if existing is not None and existing.author != who:
            continue
        timeline_s = offsets.get(take, 0.0) + int(row["recording_ms"]) / 1000.0
        comment = add_comment(
            project,
            body=str(row["body"]),
            author=who,
            timeline_start=timeline_s,
            comment_id=cid,
        )
        landed.append(
            {
                "id": comment.id,
                "body": comment.body,
                "author": comment.author,
                "take_index": take,
                "recording_ms": int(row["recording_ms"]),
                "timeline_start": comment.timeline_start,
            }
        )
    return landed


def _number_session(project: EpisodeProject, session_id: str, target: SessionTarget) -> int:
    """The session's number, stored in ``record_sessions`` the first time it is asked for."""
    number = record_session_number(project, session_id)
    if not session_numbered(project, session_id):
        project.editorial.record_sessions.append(
            RecordSessionRecord(session_id=session_id, number=number, target_kind=target.kind)
        )
    return number


def _proposed_suggestion(
    project: EpisodeProject, session_id: str, number: int, target: SessionTarget
) -> SessionSuggestion:
    suggestion_id = session_suggestion_id(session_id)
    if isinstance(target, InsertTarget):
        return SessionSuggestion(
            id=suggestion_id,
            kind="insert",
            session_id=session_id,
            session_number=number,
            at_sec=target.at_sec,
            anchor=capture_insert_anchor(project, target.at_sec),
        )
    if isinstance(target, ReplaceTarget):
        anchor, end_anchor = capture_range_anchors(
            project, target.from_sec, target.to_sec, list(target.track_ids)
        )
        return SessionSuggestion(
            id=suggestion_id,
            kind="replace",
            session_id=session_id,
            session_number=number,
            from_sec=target.from_sec,
            to_sec=target.to_sec,
            track_ids=list(target.track_ids),
            anchor=anchor,
            end_anchor=end_anchor,
        )
    raise RecordLandingError(f"a {target.kind} session cannot be staged")

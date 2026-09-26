"""Copy ACK'd keepers into raw/ and register one clip per segment."""

from __future__ import annotations

import logging
import threading
import wave
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager, suppress
from pathlib import Path
from typing import Any

from filelock import FileLock
from filelock import Timeout as FileLockTimeout

from podcast_mcp.edits.clipping_regions import clipping_regions_from_ms
from podcast_mcp.edits.clips_ops import new_clip_id
from podcast_mcp.edits.comments import add_comment, delete_comment
from podcast_mcp.edits.timeline_ops import room_tone_source_id
from podcast_mcp.edits.track_ids import slug_track_id
from podcast_mcp.edits.track_media import refresh_timeline_duration
from podcast_mcp.engines.render_invalidations import record_invalidation
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    SourceClippingRegion,
    SourceRecording,
    Track,
    TrackRole,
)
from podcast_mcp.services.document_sync import after_agent_mutation
from podcast_mcp.services.media_store import unique_raw_path
from podcast_mcp.services.record.landing_math import (
    clip_timeline_s,
    duration_error_ms,
    duration_s,
    expected_span_s,
    needs_align_fallback,
    overlap_window_s,
    session_start_present,
    take_offsets_s,
)
from podcast_mcp.services.record.landing_rollback import (
    PriorRegistration,
    capture_prior,
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
    RECORDED_ROLES,
    RecordSnapshot,
    TakeState,
    take_recording_duration_ms,
)
from podcast_mcp.services.record.upload import (
    ROOM_TONE_MAX_PCM_BYTES,
    ROOM_TONE_TAKE_INDEX,
    RecordUploadService,
    parse_participant_id,
    parse_session_id,
    parse_upload_index,
    record_artifacts_dir,
)
from podcast_mcp.services.waveform import schedule_track_waveforms
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.util.atomic_json import copy_file_atomic
from podcast_mcp.util.file_locks import shared_file_lock
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.util.progress import resolve_progress_task
from podcast_mcp.util.project_state import project_state_lock

log = logging.getLogger(__name__)

AlignFn = Callable[[EpisodeProject], None]

_LAND_LOCKS_GUARD = threading.Lock()
_LAND_LOCKS: dict[str, threading.Lock] = {}

# A land includes WAV hashing, copies, and drift measurement, so allow more than the
# 30 s project commit lock, but never wait forever on a hung process (#503).
RECORD_LAND_LOCK_TIMEOUT_SEC = 120.0


def _session_land_lock(session_id: str) -> threading.Lock:
    with _LAND_LOCKS_GUARD:
        lock = _LAND_LOCKS.get(session_id)
        if lock is None:
            lock = threading.Lock()
            _LAND_LOCKS[session_id] = lock
        return lock


def release_session_land_lock(session_id: str) -> None:
    """Drop the per-session land lock after the room ends."""
    with _LAND_LOCKS_GUARD:
        lock = _LAND_LOCKS.get(session_id)
        if lock is None or lock.locked():
            return
        _LAND_LOCKS.pop(session_id, None)


def record_land_lock_path(workspace_dir: Path, session_id: str) -> Path:
    """Cross-process land/discard lock for one room (only coordinates, stores nothing).

    Per session, like the in-process lock, so overlapping rooms in one workspace do not
    block each other.
    """
    return record_artifacts_dir(workspace_dir) / f"land-{session_id}.lock"


def remove_session_land_lock_file(workspace_dir: Path, session_id: str) -> None:
    """Best-effort delete of a room's land lock file once the room has ended.

    Skipped while any holder, in this or another process, still has the lock, and on
    platforms that refuse to unlink an open file.
    """
    path = record_land_lock_path(workspace_dir, session_id)
    if not path.exists():
        return
    probe = FileLock(str(path), thread_local=False)
    try:
        probe.acquire(timeout=0)
    except FileLockTimeout:
        return
    try:
        with suppress(OSError):
            path.unlink()
    finally:
        probe.release()


class RecordLandingError(ValueError):
    """Refuse to land or discard a take."""


def record_source_id(
    session_id: str, take_index: int, participant_id: str, segment_index: int
) -> str:
    return f"rec-{session_id}-{take_index}-{participant_id}-{segment_index}"


def wav_pcm_info(path: Path) -> tuple[int, int, int]:
    """Return (sample_rate, channels, nframes) from a PCM WAV we assembled."""
    try:
        with path.open("rb") as fh, wave.open(fh, "rb") as wf:
            sample_rate = int(wf.getframerate() or 0)
            channels = int(wf.getnchannels() or 0)
            nframes = int(wf.getnframes() or 0)
            width = int(wf.getsampwidth() or 0)
            comptype = str(wf.getcomptype() or "NONE")
    except (OSError, wave.Error) as exc:
        raise RecordLandingError("invalid keeper wav") from exc
    if sample_rate <= 0 or nframes < 0 or width not in (1, 2) or comptype != "NONE":
        raise RecordLandingError("invalid keeper wav")
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
        with _session_land_lock(self.session_id):
            file_lock = shared_file_lock(
                record_land_lock_path(self.workspace.project.workspace_path(), self.session_id),
                timeout=RECORD_LAND_LOCK_TIMEOUT_SEC,
            )
            try:
                file_lock.acquire(timeout=RECORD_LAND_LOCK_TIMEOUT_SEC)
            except FileLockTimeout as exc:
                raise RecordLandingError("land in progress") from exc
            try:
                yield
            finally:
                file_lock.release()

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
    ) -> dict[str, Any]:
        if reload:
            # Land callers open their workspace before the body read / land lock wait;
            # adopt any land another request committed meanwhile (#503).
            self.workspace.reload()
        snap = self._snapshot()
        tombstoned = self._upload.tombstoned_takes(self.session_id)
        offsets = take_offsets_s(snap.takes, tombstoned=tombstoned)
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
            and not row.get("landed")
            and int(row["take_index"]) not in tombstoned
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
            and (not row.get("landed") or self._room_tone_missing(str(row["participant_id"])))
        ]
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
            "Landing record keepers",
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
            progress.set_phase("copy", "Copying keepers into raw/")
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
            }

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
            landed_clips: list[dict[str, Any]] = []
            accepted: list[dict[str, Any]] = []
            touched: set[str] = set()
            for item in copied:
                if not self._copied_raw_matches(project, item):
                    self._mark_copied_failed(item)
                    continue
                if not self._ack_generation_current(item):
                    _log_superseded(self.session_id, item)
                    continue
                track_id = slug_track_id(str(item["participant_id"]))
                source_id = str(item["source_id"])
                rel = str(item["rel"])
                prior = capture_prior(
                    project, track_id=track_id, source_id=source_id, rel=rel, room_tone=False
                )
                previous_rel = prior.source.path if prior.source is not None else None
                _ensure_track(project, track_id, label=str(item["label"]))
                _upsert_source(
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
                clip = _upsert_clip(
                    project,
                    track_id=track_id,
                    source_id=source_id,
                    timeline_s=float(item["timeline_s"]),
                    duration_s=float(item["duration_s"]),
                )
                track = project.track_by_id(track_id)
                if track is not None:
                    if track.media is None or track.media.path == previous_rel:
                        track.media = MediaAsset(
                            path=rel,
                            duration_sec=float(item["duration_s"]),
                            sample_rate=int(item["sample_rate"]),
                            channels=int(item["channels"]),
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
                pid = str(item["participant_id"])
                track_id = slug_track_id(pid)
                rel = str(item["rel"])
                prior = capture_prior(
                    project,
                    track_id=track_id,
                    source_id=room_tone_source_id(track_id),
                    rel=rel,
                    room_tone=True,
                )
                track = _ensure_track(project, track_id, label=str(item["label"]))
                track.room_tone = MediaAsset(
                    path=rel,
                    duration_sec=float(item["duration_s"]),
                    sample_rate=int(item["sample_rate"]),
                    channels=int(item["channels"]),
                )
                _upsert_source(
                    project,
                    source_id=room_tone_source_id(track_id),
                    rel=rel,
                    speaker=str(item["label"]),
                    duration_s=float(item["duration_s"]),
                    sample_rate=int(item["sample_rate"]),
                    channels=int(item["channels"]),
                )
                touched.add(track_id)
                accepted.append({**item, "prior": prior})
            if landed_clips:
                refresh_timeline_duration(project)
                if touched:
                    record_invalidation(project, track_ids=sorted(touched), reason="other")
                if fallback and align is not None:
                    align(project)
            elif touched:
                record_invalidation(project, track_ids=sorted(touched), reason="other")
            landed_comments = _land_live_comments(project, pending_comments, offsets)
            return {"clips": landed_clips, "comments": landed_comments, "accepted": accepted}

        with project_state_lock(self.workspace.project):
            try:
                landed = self.workspace.mutate(
                    "before record land",
                    "after record land",
                    mutate,
                    operation="record_land",
                    params={"session_id": self.session_id},
                )
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
                    key[0], key[1], key[2], expected_sha256=item["file_sha256"]
                ):
                    confirmed.add(key)
                elif not self._ack_generation_current(item):
                    stale.append(item)
            if stale:
                try:
                    self._rollback_stale(stale)
                except Exception:
                    # Confirmed items already committed and were marked landed;
                    # don't fail a successful land. A re-ACK'd row stays pending,
                    # so the next land() replaces its registration. A revoked
                    # room-tone row is deleted, so its stale registration stays
                    # until removed by hand or undone through history.
                    log.exception(
                        "record land stale ACK rollback failed session=%s", self.session_id
                    )
        clips = [
            item
            for item in landed["clips"]
            if (str(item["participant_id"]), int(item["take_index"]), int(item["segment_index"]))
            in confirmed
        ]
        comments = list(landed["comments"])
        self._comments.mark_landed(
            self.session_id,
            [str(row["id"]) for row in comments],
        )
        for track_id in {str(item["track_id"]) for item in clips}:
            track = self.workspace.project.track_by_id(track_id)
            if track is not None and track.media is not None:
                schedule_track_waveforms(self.workspace.project, track)

        after_agent_mutation(self.workspace)
        return {
            "session_id": self.session_id,
            "clips": clips,
            "comments": comments,
            "align_fallback": fallback,
            "ingest_suggest": False,
            "drift_ms": drift_ms,
            "drift": drift_rows,
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

        def mutate(project: EpisodeProject) -> None:
            drop_ids = {src.id for src in project.sources if src.id.startswith(prefix)}
            drop_tracks = {clip.track_id for clip in project.clips if clip.source_id in drop_ids}
            project.sources = [src for src in project.sources if src.id not in drop_ids]
            project.clips = [clip for clip in project.clips if clip.source_id not in drop_ids]
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
        landed = self._land_locked(align=None, drift_ms=None, reload=False)
        after_agent_mutation(self.workspace)
        landed["discarded_take"] = take
        return landed

    def _room_tone_missing(self, participant_id: str) -> bool:
        track = self.workspace.project.track_by_id(slug_track_id(participant_id))
        return track is None or track.room_tone is None

    def _landed_source_id(self, participant_id: str, take_index: int, segment_index: int) -> str:
        if take_index == ROOM_TONE_TAKE_INDEX:
            return room_tone_source_id(slug_track_id(participant_id))
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
    ) -> bool:
        """Keep the source check and upload decision inside the project mutation lock."""
        with project_state_lock(self.workspace.project):
            source_id = self._landed_source_id(participant_id, take_index, segment_index)
            registered = _registered_source_file(self.workspace.project, source_id)
            present = False
            if registered is not None and expected_sha256:
                try:
                    present = sha256_file(registered[0]) == expected_sha256
                except OSError:
                    present = False
            if present and registered is not None:
                checked_again = _registered_source_file(self.workspace.project, source_id)
                present = checked_again is not None and checked_again[0] == registered[0]
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

    def _copied_raw_matches(self, project: EpisodeProject, item: dict[str, Any]) -> bool:
        """Check copied bytes before registering project media."""
        expected = item.get("file_sha256")
        raw = Path(project.workspace_dir) / str(item["rel"])
        present = False
        if expected:
            with suppress(OSError):
                present = sha256_file(raw) == expected
        return present

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
                if prior.room_tone and not self._copied_raw_matches(project, item):
                    # Beds share one fixed raw path per participant, so the path
                    # guard in revert_registration can't tell generations apart;
                    # a newer bed already overwrote the stale bytes -- keep it.
                    continue
                if revert_registration(project, prior):
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


def _log_superseded(session_id: str, item: dict[str, Any]) -> None:
    log.info(
        "record land skipped superseded ACK session=%s take=%s pid=%s seg=%s",
        session_id,
        item.get("take_index"),
        item.get("participant_id"),
        item.get("segment_index"),
    )


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


def _ensure_track(project: EpisodeProject, track_id: str, *, label: str) -> Track:
    track = project.track_by_id(track_id)
    if track is not None:
        return track
    track = Track(
        id=track_id,
        label=label,
        role=TrackRole.DIALOGUE,
        speaker=label,
    )
    project.tracks.append(track)
    return track


def _upsert_source(
    project: EpisodeProject,
    *,
    source_id: str,
    rel: str,
    speaker: str,
    duration_s: float,
    sample_rate: int,
    channels: int,
    clipping_regions: list[SourceClippingRegion] | None = None,
    clipping_truncated: bool = False,
) -> SourceRecording:
    existing = project.source_by_id(source_id)
    if existing is not None:
        if clipping_regions is not None:
            existing.clipping_regions = list(clipping_regions)
            existing.clipping_truncated = clipping_truncated
        existing.path = rel
        existing.speaker = speaker
        existing.duration_sec = duration_s
        existing.sample_rate = sample_rate
        existing.channels = channels
        return existing
    src = SourceRecording(
        id=source_id,
        path=rel,
        speaker=speaker,
        label=source_id,
        duration_sec=duration_s,
        sample_rate=sample_rate,
        channels=channels,
        clipping_regions=list(clipping_regions or []),
        clipping_truncated=clipping_truncated,
    )
    project.sources.append(src)
    return src


def _upsert_clip(
    project: EpisodeProject,
    *,
    track_id: str,
    source_id: str,
    timeline_s: float,
    duration_s: float,
) -> Clip:
    existing = next(
        (
            clip
            for clip in project.clips
            if clip.source_id == source_id and clip.track_id == track_id
        ),
        None,
    )
    if existing is not None:
        existing.source_start = 0.0
        existing.source_end = duration_s
        existing.timeline_start = timeline_s
        return existing
    clip = Clip(
        id=new_clip_id(),
        track_id=track_id,
        source_start=0.0,
        source_end=duration_s,
        timeline_start=timeline_s,
        source_id=source_id,
    )
    project.clips.append(clip)
    return clip

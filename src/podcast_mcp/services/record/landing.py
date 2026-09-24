"""Copy ACK'd keepers into raw/ and register one clip per segment."""

from __future__ import annotations

import logging
import shutil
import threading
import wave
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from podcast_mcp.edits.clips_ops import new_clip_id
from podcast_mcp.edits.comments import add_comment, delete_comment
from podcast_mcp.edits.timeline_ops import room_tone_source_id
from podcast_mcp.edits.track_ids import slug_track_id
from podcast_mcp.edits.track_media import refresh_timeline_duration
from podcast_mcp.engines.peaks import schedule_track_peaks
from podcast_mcp.engines.render_invalidations import record_invalidation
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, SourceRecording, Track, TrackRole
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
from podcast_mcp.services.record.live_comments import (
    LIVE_COMMENT_ID_PREFIX,
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
)
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.util.progress import resolve_progress_task
from podcast_mcp.util.project_state import project_state_lock

log = logging.getLogger(__name__)

AlignFn = Callable[[EpisodeProject], None]

_LAND_LOCKS_GUARD = threading.Lock()
_LAND_LOCKS: dict[str, threading.Lock] = {}


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
        self._room = RecordSessionService(workspace.project, session_id=self.session_id)
        self._upload = RecordUploadService(workspace.project)
        self._comments = live_comment_store_for(workspace.project)

    def _snapshot(self) -> RecordSnapshot:
        return RecordSnapshot.model_validate(self._room.snapshot())

    def land(
        self,
        *,
        align: AlignFn | None = None,
        drift_ms: float | None = None,
    ) -> dict[str, Any]:
        with _session_land_lock(self.session_id):
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
                )

    def _land_locked(
        self,
        *,
        align: AlignFn | None,
        drift_ms: float | None,
    ) -> dict[str, Any]:
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
                    take_offset = offsets.get(take, 0.0)
                    source_id = record_source_id(self.session_id, take, pid, segment)
                    _dest, rel = _copy_into_raw(self.workspace.project, acked, source_id)
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
                rel = _copy_room_tone(self.workspace.project, acked, pid)
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

        def mutate(project: EpisodeProject) -> dict[str, Any]:
            landed_clips: list[dict[str, Any]] = []
            touched: set[str] = set()
            for item in copied:
                track_id = slug_track_id(str(item["participant_id"]))
                source_id = str(item["source_id"])
                rel = str(item["rel"])
                _ensure_track(project, track_id, label=str(item["label"]))
                _upsert_source(
                    project,
                    source_id=source_id,
                    rel=rel,
                    speaker=str(item["label"]),
                    duration_s=float(item["duration_s"]),
                    sample_rate=int(item["sample_rate"]),
                    channels=int(item["channels"]),
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
                    if track.media is None:
                        track.media = MediaAsset(
                            path=rel,
                            duration_sec=float(item["duration_s"]),
                            sample_rate=int(item["sample_rate"]),
                            channels=int(item["channels"]),
                        )
                    touched.add(track_id)
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
                pid = str(item["participant_id"])
                track_id = slug_track_id(pid)
                track = _ensure_track(project, track_id, label=str(item["label"]))
                rel = str(item["rel"])
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
            if copied:
                refresh_timeline_duration(project)
                if touched:
                    record_invalidation(project, track_ids=sorted(touched), reason="other")
                if fallback and align is not None:
                    align(project)
            elif room_tone_copied and touched:
                record_invalidation(project, track_ids=sorted(touched), reason="other")
            landed_comments = _land_live_comments(project, pending_comments, offsets)
            return {"clips": landed_clips, "comments": landed_comments}

        landed = self.workspace.mutate(
            "before record land",
            "after record land",
            mutate,
            operation="record_land",
            params={"session_id": self.session_id},
        )
        clips = list(landed["clips"])
        comments = list(landed["comments"])
        for item in copied + room_tone_copied:
            self._mark_registered_landing(
                str(item["participant_id"]),
                int(item["take_index"]),
                int(item["segment_index"]),
                expected_sha256=item["file_sha256"],
            )
        self._comments.mark_landed(
            self.session_id,
            [str(row["id"]) for row in comments],
        )
        for track_id in {slug_track_id(str(item["participant_id"])) for item in copied}:
            track = self.workspace.project.track_by_id(track_id)
            if track is not None and track.media is not None:
                schedule_track_peaks(self.workspace.project, track)

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
        take = parse_upload_index(take_index, name="take_index")
        with _session_land_lock(self.session_id):
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
        landed = self._land_locked(align=None, drift_ms=None)
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
    ) -> None:
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
                self._upload.mark_landed(
                    session_id=self.session_id,
                    take_index=take_index,
                    participant_id=participant_id,
                    segment_index=segment_index,
                )
                return
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
                )
            return None
        acked = self._upload.acked_wav(self.session_id, take, pid, segment)
        if not acked.is_file():
            if mark:
                self._mark_missing_acked(pid, take, segment, expected_sha256=row.get("file_sha256"))
            return None
        return acked


def _registered_source_file(project: EpisodeProject, source_id: str) -> tuple[Path, str] | None:
    """``(absolute path, rel)`` of ``sources[source_id]`` when that file exists on disk."""
    existing = next((src for src in project.sources if src.id == source_id), None)
    if existing is None:
        return None
    dest = (Path(project.workspace_dir) / existing.path).resolve()
    return (dest, existing.path) if dest.is_file() else None


def _copy_into_raw(
    project: EpisodeProject,
    acked: Path,
    source_id: str,
    *,
    dest: Path | None = None,
) -> tuple[Path, str]:
    """Copy *acked* into ``raw/`` and return ``(dest, workspace-relative path)``.

    *source_id* is used only when *dest* is None: to reuse an already registered
    source file and to name a fresh ``unique_raw_path``. With an explicit *dest*
    (room tone), *source_id* is ignored and *acked* is always copied to *dest*.
    Landed-state checks use ``_registered_source_file`` with the row's SHA-256
    in ``_mark_missing_acked``, not this helper.
    """
    ws = Path(project.workspace_dir)
    if dest is None:
        registered = _registered_source_file(project, source_id)
        if registered is not None:
            return registered
        dest = unique_raw_path(ws, f"{source_id}.wav")
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(acked, dest)
    rel = str(dest.relative_to(ws)).replace("\\", "/")
    return dest, rel


def _copy_room_tone(project: EpisodeProject, acked: Path, participant_id: str) -> str:
    ws = Path(project.workspace_dir)
    pid = parse_participant_id(participant_id)
    dest = ws / "raw" / "room-tone" / f"{pid}.wav"
    _dest, rel = _copy_into_raw(project, acked, room_tone_source_id(slug_track_id(pid)), dest=dest)
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
) -> SourceRecording:
    existing = next((src for src in project.sources if src.id == source_id), None)
    if existing is not None:
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

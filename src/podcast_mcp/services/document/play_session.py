"""Staged-session preview: the window around an insert or replace, before and after Accept."""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Any

from podcast_mcp.edits.pending_preview import DEFAULT_AB_GAP_SEC, DEFAULT_SESSION_PAD_SEC
from podcast_mcp.edits.session_suggestions import apply_session_suggestion_for_preview
from podcast_mcp.engines.room_tone import room_tone_bed_digest, room_tone_pool_digest
from podcast_mcp.models import EpisodeProject, SessionSuggestion
from podcast_mcp.util.atomic_json import write_text_atomic
from podcast_mcp.util.batch_scope import batch_scope
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.fingerprint import file_stamp
from podcast_mcp.util.hashing import short_digest
from podcast_mcp.util.process import run
from podcast_mcp.util.project_state import RENDER_LOCK_TIMEOUT_SEC, snapshot_project

from .play_pending import _PENDING_SIDES, _PlayPending, _window_render_lock

log = logging.getLogger(__name__)


class _NotCached(Exception):
    """A cached-only preview found a side it would have to render."""


# Bump when accepting a session, or the way a window is mixed, changes what a cached window plays.
SESSION_PREVIEW_REV = 2
# The shortest window a preview renders, as in a pending preview.
_MIN_WINDOW_SEC = 0.05


def _timeline_end(project: EpisodeProject) -> float:
    return max((clip.timeline_end for clip in project.clips), default=0.0)


def _digest(*parts: Any) -> str:
    return hashlib.sha256(
        json.dumps(parts, sort_keys=True, default=str, separators=(",", ":")).encode()
    ).hexdigest()


class _PlaySession(_PlayPending):
    def hear_session_suggestion(
        self,
        row: SessionSuggestion,
        take_index: int | None,
        *,
        mode: str = "ab",
        pad_sec: float = DEFAULT_SESSION_PAD_SEC,
        gap_sec: float = DEFAULT_AB_GAP_SEC,
        rerender: bool = False,
        dry_run: bool = False,
        player: str | None = None,
        lock_timeout: float = RENDER_LOCK_TIMEOUT_SEC,
        cached_only: bool = False,
    ) -> dict[str, Any] | None:
        """The window around a pending staged session as it is now, after Accept, or both.

        Suggested accepts the session on a snapshot with the same function Accept runs (the
        speech hold overridden, because this only previews), so it is what Accept ships.
        Both sides are mixed at the headroom trim of the project as it is now, so their
        loudness is comparable; a snapshot never measures a trim of its own. ``take_index`` is
        the take of a replace, already chosen by the caller; Current ignores it. With
        ``cached_only`` a side that is not already rendered gives None, and nothing is rendered.
        """
        kind = (mode or "ab").strip().lower()
        if kind not in _PENDING_SIDES:
            raise CodedValueError(
                "mode must be current, suggested, or ab", code="compare_mode_invalid"
            )
        pad = max(0.0, float(pad_sec))
        gap = max(0.0, float(gap_sec if gap_sec is not None else DEFAULT_AB_GAP_SEC))
        # One scope for the sides: a path resolution or decode of an unchanged file is paid once.
        try:
            with batch_scope():
                sides = {
                    side: self._session_side(
                        row,
                        take_index,
                        side,
                        pad,
                        rerender=rerender,
                        lock_timeout=lock_timeout,
                        cached_only=cached_only,
                    )
                    for side in _PENDING_SIDES[kind]
                }
        except _NotCached:
            return None
        current = sides.get("current")
        suggested = sides.get("suggested")
        wav: Path
        player_cmd: list[str] | None = None
        if current is not None and suggested is not None:
            joined = self.play_ab_wavs(
                current["wav"],
                suggested["wav"],
                gap_sec=gap,
                dry_run=dry_run,
                player=player,
                publish_audition=False,
            )
            wav, player_cmd = joined.wav_path, joined.player_cmd
        else:
            wav = (current or suggested or {})["wav"]
            player_cmd = None if dry_run else self._player_command(player, wav)
            if player_cmd:
                run(player_cmd, check=True)
        detail = suggested or {}
        return {
            "suggestion_id": row.id,
            "kind": row.kind,
            "mode": kind,
            "take_index": detail.get("take_index"),
            "pad_sec": pad,
            "wav": str(wav),
            "player": player_cmd,
            "current": _side_view(current, ("start_s", "end_s")),
            "suggested": _side_view(suggested, ("start_s", "end_s", "delta_s")),
            "delta_s": detail.get("delta_s"),
            "removed_s": detail.get("removed_s"),
            "span_s": detail.get("span_s"),
            "speech": detail.get("speech"),
            "speech_message": detail.get("speech_message"),
        }

    def _staged_files_key(self, row: SessionSuggestion) -> list[Any]:
        """Identity of the staged recordings, which are not in the project until Accept."""
        root = self.project.workspace_path()
        paths = [
            (source.path if (source := self.project.source_by_id(take.source_id)) else "")
            for take in row.takes
        ] + [bed.path for bed in row.room_tone]
        stamps: list[Any] = []
        for rel in sorted(set(paths)):
            try:
                stamp = file_stamp(root / rel)
                stamps.append([rel, stamp.size, stamp.mtime_ns])
            except OSError:
                stamps.append([rel, None])
        return stamps

    def _session_key(
        self, row: SessionSuggestion, take_index: int | None, side: str, pad: float
    ) -> str:
        """What a window plays. Current does not read the take, so a take change keeps it."""
        project = self.project
        if side == "current":
            staged: Any = row.model_dump(
                mode="json", include={"id", "kind", "status", "anchor", "end_anchor", "track_ids"}
            )
            take: int | None = None
            files: list[Any] = []
        else:
            # The pick (selected_take) is not read: the chosen take is passed in and in the
            # key, so a pick of the take already previewed stays a cache hit.
            staged = row.model_dump(mode="json", exclude={"selected_take"})
            take = take_index
            files = self._staged_files_key(row)
        return _digest(
            SESSION_PREVIEW_REV,
            side,
            pad,
            staged,
            take,
            files,
            self._mix_key(),
            # Accept ripples every dialogue clip, and reads the words it would remove.
            [
                _digest([item.model_dump(mode="json") for item in project.clips]),
                _digest([item.model_dump(mode="json") for item in project.tracks]),
                _digest([item.model_dump(mode="json") for item in project.sources]),
                _digest([item.model_dump(mode="json") for item in project.edit_decisions]),
                _digest(project.transcript_data.model_dump_json()),
            ],
            self._defaults,
            room_tone_pool_digest(project),
            room_tone_bed_digest(project),
        )

    def _session_window_path(self, key: str, side: str) -> Path:
        path = (
            self.project.artifacts_dir() / "play_cache" / f"session_{side}_{short_digest(key)}.wav"
        )
        self._play_cache_dir(path)
        return path

    def _read_session_side(self, wav: Path) -> dict[str, Any] | None:
        """The cached side (its WAV and the result beside it), or None when either is missing."""
        meta = wav.with_suffix(".json")
        if not wav.is_file():
            return None
        try:
            data = json.loads(meta.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(data, dict):
            return None
        self._mark_play_cache_used(wav)
        return {**data, "wav": wav}

    def _session_side(
        self,
        row: SessionSuggestion,
        take_index: int | None,
        side: str,
        pad: float,
        *,
        rerender: bool,
        lock_timeout: float,
        cached_only: bool = False,
    ) -> dict[str, Any]:
        key = self._session_key(row, take_index, side, pad)
        out = self._session_window_path(key, side)
        if not rerender and (hit := self._read_session_side(out)) is not None:
            return hit
        if cached_only:
            raise _NotCached
        # A warm and the first Play render the same content-addressed window at once; the
        # second waits and reads the first's files.
        with _window_render_lock(out):
            if not rerender and (hit := self._read_session_side(out)) is not None:
                return hit
            return self._render_session_side(
                row, take_index, side, pad, out, lock_timeout=lock_timeout
            )

    def _render_session_side(
        self,
        row: SessionSuggestion,
        take_index: int | None,
        side: str,
        pad: float,
        out: Path,
        *,
        lock_timeout: float,
    ) -> dict[str, Any]:
        snapshot = snapshot_project(self.project)
        done = apply_session_suggestion_for_preview(
            snapshot, row.id, take_index=take_index, defaults=self._defaults
        )
        start = max(0.0, done.start_s - pad)
        if side == "current":
            project = self.project
            end = min(_timeline_end(self.project), done.start_s + done.removed_s + pad)
            meta: dict[str, Any] = {}
        else:
            project = snapshot
            end = min(_timeline_end(snapshot), done.start_s + done.span_s + pad)
            meta = {
                "take_index": done.take_index,
                "delta_s": done.span_s - done.removed_s,
                "removed_s": done.removed_s,
                "span_s": done.span_s,
                "speech": done.speech.model_dump(mode="json") if done.speech else None,
                "speech_message": done.speech_message,
            }
        end = max(end, start + _MIN_WINDOW_SEC)
        # The live project's trim, for both sides: measuring the snapshot's would render
        # its stems over the live ones.
        trim = self.mix_trim_db(lock_timeout=lock_timeout)
        self._render_mix_window(project, start, end, out, trim_db=trim)
        meta = {"start_s": start, "end_s": end, **meta}
        # The result lands after the WAV, so a WAV without it is a miss.
        write_text_atomic(out.with_suffix(".json"), json.dumps(meta))
        self._mark_play_cache_used(out)
        return {**meta, "wav": out}


def _side_view(side: dict[str, Any] | None, keys: tuple[str, ...]) -> dict[str, Any] | None:
    if side is None:
        return None
    return {"wav": str(side["wav"]), **{key: side[key] for key in keys if key in side}}

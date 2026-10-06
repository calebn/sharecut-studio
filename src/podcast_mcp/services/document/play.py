from __future__ import annotations

import functools
import hashlib
import json
import logging
import math
import os
import platform
import re
import secrets
import shutil
import tempfile
import threading
import time
import wave
from collections import OrderedDict
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path

from filelock import Timeout

from podcast_mcp.config import load_defaults, mix_peak_ceiling_db
from podcast_mcp.edits.pending_preview import (
    DEFAULT_AB_GAP_SEC,
    PendingPreviewWindow,
    apply_for_suggested,
    resolve_pending_preview,
)
from podcast_mcp.edits.timeline_ops import roll_clip_join, trim_clip_edge
from podcast_mcp.edits.transcript_cuts import search_transcript
from podcast_mcp.engines.ffmpeg import MIX_SEMANTICS_REV, FFmpegEngine
from podcast_mcp.engines.play_audit import (
    clear_invalidations_if_current,
    mix_gains,
    mix_render_hash,
    premix_is_stale,
    premix_path,
    publish_stem,
    read_premix_trim_db,
    stem_fingerprint,
    stem_is_fresh,
    stem_matches,
    stem_path,
    stem_revision,
    track_render_hash,
)
from podcast_mcp.engines.timeline_render import render_track_from_timeline, render_track_segment
from podcast_mcp.engines.timemap import TimelineMapError, timeline_range_to_source
from podcast_mcp.engines.transcript_gated_play import (
    dialogue_tracks_for_play,
    transcript_gate_fingerprint,
    word_intervals,
)
from podcast_mcp.models import EpisodeProject, Track, TrackRole
from podcast_mcp.models.episode import ExactRangeTarget
from podcast_mcp.project_store import ProjectStore
from podcast_mcp.render import rerender_preview
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.media import schedule_stem_waveforms
from podcast_mcp.services.session_sync import publish_agent_play
from podcast_mcp.util.atomic_render import render_atomic
from podcast_mcp.util.file_locks import hold_shared_file_lock
from podcast_mcp.util.hashing import short_digest
from podcast_mcp.util.process import run
from podcast_mcp.util.project_state import (
    RENDER_LOCK_TIMEOUT_SEC,
    RenderBusyError,
    project_commit_lock,
    render_lock,
    snapshot_project,
)
from podcast_mcp.util.tracks import recording_audio_path

from .boundary import (
    BoundaryAudioWindow,
    BoundaryAudition,
    RollBoundaryEdit,
    RollBoundaryTarget,
    TrimBoundaryEdit,
    TrimBoundaryTarget,
    assert_boundary_token,
    boundary_context,
)

log = logging.getLogger(__name__)

# Full-stem rebuild on --rerender is only worth it for long windows. Short
# auditions use segment render (faster, and avoids silent stem-slice races).
_FULL_STEM_RERENDER_MIN_SEC = 60.0
_PLAY_CACHE_MAX_AGE_SEC = 7 * 24 * 60 * 60
_PLAY_CACHE_MIN_EVICT_AGE_SEC = 60 * 60
_PLAY_CACHE_MAX_FILES = 512
_PLAY_CACHE_HARD_MAX_FILES = 4096
_PLAY_CACHE_LOCK_TIMEOUT_SEC = 30.0
# Playback never queues behind an export or Refresh (#482): processed segment play,
# premix rerender and transport stem builds wait this long for the render lock, then
# play a segment render or the premix/stem already on disk instead of rebuilding.
_PLAY_RENDER_LOCK_TIMEOUT_SEC = 2.0
_BOUNDARY_CATALOG_MAX = 128
_BOUNDARY_CATALOG_TTL_SEC = 10 * 60
_boundary_catalog_lock = threading.Lock()
# Pending-preview sides each mode renders.
_PENDING_SIDES = {
    "current": ("current",),
    "suggested": ("suggested",),
    "ab": ("current", "suggested"),
}


@dataclass(frozen=True)
class _BoundaryAudioEntry:
    project_path: Path
    target: TrimBoundaryTarget | RollBoundaryTarget
    token: str
    current_path: Path
    proposed_path: Path
    expires_at: float


_boundary_catalog: OrderedDict[str, _BoundaryAudioEntry] = OrderedDict()


def _wav_peak_abs(path: Path) -> float | None:
    """Peak absolute sample in [0, 1], or None if unreadable."""
    try:
        import wave

        with wave.open(str(path), "rb") as w:
            n = w.getnframes()
            if n <= 0 or w.getsampwidth() != 2:
                return None
            raw = w.readframes(n)
        import struct

        samples = struct.unpack(f"<{len(raw) // 2}h", raw)
        if not samples:
            return None
        return max(abs(s) for s in samples) / 32768.0
    except Exception:
        return None


@functools.lru_cache(maxsize=64)
def _stem_mix_trim_db(stems: tuple[tuple[Path, float, str], ...], ceiling_db: float) -> float:
    """Headroom trim of ``(stem, gain, stem hash)`` mixed at those gains.

    The stem hash (``track_render_hash``) keys the cache on the stem's content."""
    return FFmpegEngine().peak_trim_db([(path, gain) for path, gain, _hash in stems], ceiling_db)


@dataclass
class PlayRequest:
    source: str
    start_sec: float
    end_sec: float
    query: str | None = None
    match_index: int = 0
    padding_sec: float = 1.0
    raw: bool = False
    rerender: bool = False
    compare: bool = False
    follow_transcript: bool = False


@dataclass
class PlayResult:
    """One audition. ``render_busy``: a premix ``--rerender`` lost the render-lock race
    (``RenderBusyError``) and the premix already on disk, possibly stale, was played."""

    wav_path: Path
    player_cmd: list[str] | None
    source_label: str
    start_sec: float
    end_sec: float
    tier: str
    compare_segments: list[dict] | None = None
    render_busy: bool = False


@dataclass(frozen=True)
class TransportPath:
    """Full on-disk WAV for continuous transport (GUI Range streaming).

    Distinct from :meth:`PlayService.play`, which always extracts a segment into
    ``play_cache/``. CLI/MCP segment audition and the DAW transport share the
    same path resolution helpers (``_ensure_premix``, ``ensure_stem``,
    ``track_audio_path``).

    ``render_busy`` is True when a premix rerender or stem build lost the render-lock race
    (``RenderBusyError``) and the premix or stem already on disk, possibly stale, is served
    instead. A project-lock timeout after a successful render serves the fresh file
    without the flag.
    """

    path: Path
    source: str
    tier: str
    stem_is_fresh: bool | None = None
    render_busy: bool = False


# Tiers whose audio already carries the track's staging gain_db.
_GAIN_BAKED_TIERS = frozenset({"segment_render", "segment_cache"})


def _compose_gain_db(track: Track | None, tier: str) -> float:
    """Gain to mix a composed track at: its output gain, minus any baked part.

    Segment renders bake the staging ``gain_db``; stems and raw audio do not.
    The fader is a mix control, so it's never baked and always applies here.
    """
    if track is None:
        return 0.0
    if tier in _GAIN_BAKED_TIERS:
        return float(track.fader_db)
    return float(track.output_gain_db)


def _mix_cache_extra(inputs: list[tuple[Path, float]]) -> str:
    """Play-cache key part for a mix: each input's path, mtime and gain."""
    return ":".join(
        f"{path}:{path.stat().st_mtime_ns if path.is_file() else 0}:{gain}" for path, gain in inputs
    )


def _cache_last_used(path: Path) -> float:
    """Last-use time of a play-cache WAV: its filesystem ``st_atime``.

    ``_refresh_cache_access`` renews this lease whenever PlayService serves or
    reuses the WAV, and eviction reads it only through this function. The seam
    lets tests pin last-use times (#735); it does not make production LRU
    exact. External readers (Spotlight, backup or sync agents) also bump atime,
    so a WAV PlayService has not served can look recently used and outlive
    files it served more recently. ``_PLAY_CACHE_MAX_FILES`` and
    ``_PLAY_CACHE_HARD_MAX_FILES`` still bound the cache.
    Raises ``FileNotFoundError`` when the file is gone.
    """
    return path.stat().st_atime


class PlayService:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.ws = workspace
        self.project = workspace.project
        self._defaults = load_defaults()

    @staticmethod
    def issued_boundary_project(opaque_id: str) -> Path:
        """Resolve an issued audition capability without accepting a client path."""
        with _boundary_catalog_lock:
            entry = _boundary_catalog.get(opaque_id)
            if entry is None or entry.expires_at < time.monotonic():
                _boundary_catalog.pop(opaque_id, None)
                raise FileNotFoundError("boundary audition expired; listen again")
            return entry.project_path

    def _play_cache_dir(self, *protected: Path) -> Path:
        """Keep old generated auditions bounded without touching active outputs."""
        out_dir = self.project.artifacts_dir() / "play_cache"
        out_dir.mkdir(parents=True, exist_ok=True)
        with hold_shared_file_lock(out_dir / ".cache.lock", timeout=_PLAY_CACHE_LOCK_TIMEOUT_SEC):
            now = time.time()
            candidates: list[tuple[float, Path]] = []
            for path in protected:
                self._refresh_cache_access(path, out_dir)
            for path in out_dir.glob("*.wav"):
                if path.is_symlink() or not path.is_file():
                    continue
                try:
                    accessed = _cache_last_used(path)
                except FileNotFoundError:
                    continue
                candidates.append((accessed, path))
            candidates.sort(key=lambda item: item[0], reverse=True)
            protected_paths = {path.resolve() for path in protected}
            unprotected_index = 0
            for index, (_, path) in enumerate(candidates):
                if path.resolve() in protected_paths:
                    continue
                # Re-stat under the lock: a concurrent serve may have refreshed it.
                try:
                    age = now - _cache_last_used(path)
                except FileNotFoundError:
                    continue
                if age <= _PLAY_CACHE_MIN_EVICT_AGE_SEC:
                    continue
                if (
                    age > _PLAY_CACHE_MAX_AGE_SEC
                    or unprotected_index >= _PLAY_CACHE_HARD_MAX_FILES
                    or index >= _PLAY_CACHE_MAX_FILES
                ):
                    path.unlink(missing_ok=True)
                unprotected_index += 1
        return out_dir

    @staticmethod
    def _refresh_cache_access(path: Path, out_dir: Path) -> None:
        if path.parent != out_dir or path.is_symlink():
            return
        with suppress(FileNotFoundError):
            stat = path.stat()
            os.utime(path, ns=(time.time_ns(), stat.st_mtime_ns), follow_symlinks=False)

    def _mark_play_cache_used(self, path: Path) -> None:
        """Refresh an audition lease before returning a cached WAV to a caller."""
        out_dir = self.project.artifacts_dir() / "play_cache"
        with hold_shared_file_lock(out_dir / ".cache.lock", timeout=_PLAY_CACHE_LOCK_TIMEOUT_SEC):
            self._refresh_cache_access(path, out_dir)

    def _boundary_window(
        self, project: EpisodeProject, track_id: str, seam_sec: float, pad_sec: float
    ) -> tuple[float, float]:
        track_clips = [c for c in project.clips if c.track_id == track_id]
        if not track_clips:
            raise ValueError("boundary track has no clips to audition")
        track_end = max(c.timeline_end for c in track_clips)
        start = max(0.0, seam_sec - pad_sec)
        end = min(track_end, seam_sec + pad_sec)
        if end - start < 0.02:
            raise ValueError("boundary has too little audio to audition")
        return start, end

    def _boundary_render(
        self,
        project: EpisodeProject,
        track_id: str,
        token: str,
        state: str,
        start: float,
        end: float,
    ) -> Path:
        track = project.track_by_id(track_id)
        if track is None:
            raise ValueError(f"unknown track {track_id!r}")
        ceiling = mix_peak_ceiling_db(self._defaults)
        identity = {
            "project": str(self.ws.path.resolve()),
            "token": token,
            "state": state,
            "track": track_render_hash(project, track_id),
            "fader_db": track.fader_db,
            "start": start,
            "end": end,
            "defaults": self._defaults,
            "mix_semantics": MIX_SEMANTICS_REV,
            "ceiling_db": ceiling,
        }
        raw = json.dumps(identity, sort_keys=True, separators=(",", ":"), default=str)
        digest = hashlib.sha256(raw.encode()).hexdigest()
        cache = self.project.artifacts_dir() / "play_cache"
        output = cache / f"boundary_{digest}_audition.wav"
        self._play_cache_dir(output)
        if not output.is_file():
            stem_fd, stem_name = tempfile.mkstemp(
                prefix="boundary_full_stem_", suffix=".wav", dir=cache
            )
            os.close(stem_fd)
            stem = Path(stem_name)
            try:
                mix_fd, mix_name = tempfile.mkstemp(
                    prefix="boundary_full_mix_", suffix=".wav", dir=cache
                )
                os.close(mix_fd)
                mix = Path(mix_name)
                try:
                    engine = FFmpegEngine()
                    render_track_from_timeline(project, track, stem, self._defaults, engine=engine)
                    engine.mix_tracks(
                        [(stem, float(track.output_gain_db))], mix, peak_ceiling_db=ceiling
                    )
                    render_atomic(output, lambda tmp: engine.extract_segment(mix, tmp, start, end))
                finally:
                    mix.unlink(missing_ok=True)
            finally:
                stem.unlink(missing_ok=True)
        self._mark_play_cache_used(output)
        return output

    def audition_boundary(
        self,
        target: TrimBoundaryTarget | RollBoundaryTarget,
        edit: TrimBoundaryEdit | RollBoundaryEdit,
        expected_token: str,
        *,
        pad_sec: float = 0.75,
    ) -> BoundaryAudition:
        """Hear saved and proposed affected-track windows without publishing a project."""
        if not math.isfinite(pad_sec) or not 0.1 <= pad_sec <= 2.0:
            raise ValueError("pad_sec must be between 0.1 and 2 seconds")
        if isinstance(target, TrimBoundaryTarget):
            if not isinstance(edit, TrimBoundaryEdit) or (
                target.clip_id != edit.clip_id or target.edge != edit.edge
            ):
                raise ValueError("edit does not match boundary target")
        elif not isinstance(edit, RollBoundaryEdit) or (
            target.left_clip_id != edit.left_clip_id or target.right_clip_id != edit.right_clip_id
        ):
            raise ValueError("edit does not match boundary target")

        with self.ws.transaction() as saved:
            current_context = assert_boundary_token(saved, target, expected_token)
            current = snapshot_project(saved)
        proposed = current.model_copy(deep=True)
        if isinstance(edit, TrimBoundaryEdit):
            trim_clip_edge(proposed, edit.clip_id, edit.edge, edit.source_sec, mode=edit.mode)
            actual_sec = next(c for c in proposed.clips if c.id == edit.clip_id)
            actual_edit: TrimBoundaryEdit | RollBoundaryEdit = edit.model_copy(
                update={
                    "source_sec": (
                        actual_sec.source_start if edit.edge == "in" else actual_sec.source_end
                    )
                }
            )
        else:
            left_before = next(c for c in current.clips if c.id == edit.left_clip_id)
            roll_clip_join(proposed, edit.left_clip_id, edit.right_clip_id, edit.delta_sec)
            left_after = next(c for c in proposed.clips if c.id == edit.left_clip_id)
            actual_edit = edit.model_copy(
                update={"delta_sec": left_after.source_end - left_before.source_end}
            )
        proposed_context = boundary_context(proposed, target)
        track_id = current_context.track_id
        current_seam = current_context.current.timeline_sec
        proposed_seam = proposed_context.current.timeline_sec
        current_start, current_end = self._boundary_window(current, track_id, current_seam, pad_sec)
        proposed_start, proposed_end = self._boundary_window(
            proposed, track_id, proposed_seam, pad_sec
        )
        with render_lock(self.project, timeout=_PLAY_RENDER_LOCK_TIMEOUT_SEC):
            current_path = self._boundary_render(
                current, track_id, expected_token, "current", current_start, current_end
            )
            proposed_path = self._boundary_render(
                proposed, track_id, expected_token, "proposed", proposed_start, proposed_end
            )
        with self.ws.transaction() as saved:
            assert_boundary_token(saved, target, expected_token)
            opaque_id = secrets.token_urlsafe(18)
            entry = _BoundaryAudioEntry(
                project_path=self.ws.path.resolve(),
                target=target,
                token=expected_token,
                current_path=current_path,
                proposed_path=proposed_path,
                expires_at=time.monotonic() + _BOUNDARY_CATALOG_TTL_SEC,
            )
            with _boundary_catalog_lock:
                _boundary_catalog[opaque_id] = entry
                while len(_boundary_catalog) > _BOUNDARY_CATALOG_MAX:
                    _boundary_catalog.popitem(last=False)

        def window(
            path: Path, start: float, end: float, seam: float, side: str
        ) -> BoundaryAudioWindow:
            with wave.open(str(path), "rb") as wav:
                duration = wav.getnframes() / wav.getframerate()
            return BoundaryAudioWindow(
                url=f"/api/boundary/audition/{opaque_id}/{side}?expected_token={expected_token}",
                window_start_sec=start,
                window_end_sec=end,
                duration_sec=duration,
                seam_offset_sec=seam - start,
            )

        return BoundaryAudition(
            token=expected_token,
            actual_edit=actual_edit,
            current=window(current_path, current_start, current_end, current_seam, "current"),
            proposed=window(proposed_path, proposed_start, proposed_end, proposed_seam, "proposed"),
        )

    def boundary_audio_path(self, opaque_id: str, side: str, expected_token: str) -> Path:
        """Resolve one issued, unexpired cache file after host and token checks."""
        if side not in {"current", "proposed"}:
            raise ValueError("unknown boundary audition side")
        with _boundary_catalog_lock:
            entry = _boundary_catalog.get(opaque_id)
            if entry is None or entry.expires_at < time.monotonic():
                _boundary_catalog.pop(opaque_id, None)
                raise FileNotFoundError("boundary audition expired; listen again")
        if entry.project_path != self.ws.path.resolve() or entry.token != expected_token:
            raise FileNotFoundError("boundary audition is unavailable")
        with self.ws.transaction() as saved:
            assert_boundary_token(saved, entry.target, expected_token)
        path = entry.current_path if side == "current" else entry.proposed_path
        cache = (self.project.artifacts_dir() / "play_cache").resolve()
        if path.is_symlink() or path.parent.resolve() != cache or not path.is_file():
            raise FileNotFoundError("boundary audition expired; listen again")
        self._mark_play_cache_used(path)
        return path

    def resolve_transport_path(
        self,
        kind: str,
        *,
        track_id: str | None = None,
        source_id: str | None = None,
        rerender: bool = False,
        build_stem: bool = False,
    ) -> TransportPath:
        """Resolve a full WAV for browser/DAW transport (no segment extract).

        ``kind`` mirrors GUI audition modes and CLI ``--source`` families:

        - ``premix`` - ``artifacts/premix.wav`` (same as ``podcast play --source premix``)
        - ``review`` / ``review:<id>`` - frozen review mix under ``artifacts/review/``
        - ``stem`` / ``processed`` - processed stem for ``track_id``
          (``podcast play --source processed:<id>`` artifact)
        - ``raw`` / ``track`` - source media (``podcast play --source track:<id>``)
        """
        normalized = kind.strip().lower()
        if source_id is not None and normalized not in ("raw", "track"):
            raise ValueError("source_id is only supported for raw/track transport")
        if normalized == "premix":
            # Transport streaming must not rebuild on every GET; use rerender=True
            # (CLI --rerender / ?rerender=1) when a rebuild is intentional.
            busy = False
            if rerender:
                path, busy = self._ensure_premix(rerender=True)
            else:
                path = premix_path(self.project)
                if not path.is_file():
                    raise FileNotFoundError(
                        "premix.wav not found; run render-preview or pipeline first"
                    )
            return TransportPath(
                path=path.resolve(),
                source="premix",
                tier="premix",
                render_busy=busy,
            )

        if normalized == "review" or normalized.startswith("review:"):
            from podcast_mcp.edits.review_versions import version_audio_path

            if normalized.startswith("review:"):
                version_id = normalized.split(":", 1)[1].strip()
            else:
                version_id = (track_id or "").strip() or (
                    self.project.review.active_version_id or ""
                )
            if not version_id:
                raise ValueError(
                    "review version id required (kind=review:<id>, track_id=, "
                    "or set review.active_version_id)"
                )
            path = version_audio_path(self.project, version_id)
            return TransportPath(
                path=path,
                source=f"review:{version_id}",
                tier="review",
            )

        if normalized in ("stem", "processed", "fx"):
            if not track_id:
                raise ValueError("track_id required for stem/processed transport")
            if self.project.track_by_id(track_id) is None:
                raise KeyError(f"unknown track {track_id!r}")
            busy = False
            if rerender or build_stem:
                try:
                    path = self.ensure_stem(track_id, lock_timeout=_PLAY_RENDER_LOCK_TIMEOUT_SEC)
                # RenderBusyError, or the commit-lock timeout from ensure_stem's invalidation
                # clear, which runs after its publish: then the stem on disk is the fresh one.
                except Timeout as exc:
                    path = stem_path(self.project, track_id)
                    if not path.is_file():
                        raise
                    busy = isinstance(exc, RenderBusyError)
                    log.info("render or project busy; streaming the existing %s stem", track_id)
            else:
                path = stem_path(self.project, track_id)
                if not path.is_file():
                    raise FileNotFoundError(
                        f"processed stem missing for {track_id!r}; "
                        "run assemble_timeline or pass build_stem=True"
                    )
            return TransportPath(
                path=path.resolve(),
                source=f"processed:{track_id}",
                tier="stem",
                stem_is_fresh=stem_is_fresh(self.project, track_id),
                render_busy=busy,
            )

        if normalized in ("raw", "track"):
            if not track_id:
                raise ValueError("track_id required for raw/track transport")
            path = recording_audio_path(self.project, track_id, source_id)
            if not path.is_file():
                raise FileNotFoundError(f"raw media not found: {path}")
            return TransportPath(
                path=path.resolve(),
                source=f"source:{source_id}" if source_id is not None else f"track:{track_id}",
                tier="raw",
            )

        raise ValueError(
            f"unknown transport kind {kind!r}; "
            "use premix, review[:id], stem/processed, or raw/track"
        )

    def play(
        self,
        req: PlayRequest,
        *,
        dry_run: bool = False,
        player: str | None = None,
        publish_audition: bool = True,
    ) -> PlayResult:
        if req.follow_transcript:
            return self._play_follow_transcript(
                req, dry_run=dry_run, player=player, publish_audition=publish_audition
            )
        if req.compare:
            return self._play_compare(
                req, dry_run=dry_run, player=player, publish_audition=publish_audition
            )
        source, start, end = self._resolve_source_and_times(req)
        if req.raw and source.startswith("processed:"):
            source = "track:" + source.split(":", 1)[1]

        wav_path, tier, ext_start, ext_end, busy = self._resolve_audio(
            source, start, end, rerender=req.rerender
        )
        self._mark_play_cache_used(wav_path)

        cmd = None if dry_run else self._player_command(player, wav_path)
        if cmd:
            run(cmd, check=True)
        result = PlayResult(
            wav_path=wav_path,
            player_cmd=cmd,
            source_label=source,
            start_sec=ext_start,
            end_sec=ext_end,
            tier=tier,
            render_busy=busy,
        )
        if publish_audition:
            # Prefer timeline bounds from the request resolution (start/end),
            # not extract offsets (raw track:* returns source-media seconds).
            timeline_start, timeline_end = start, end
            if source.startswith("track:"):
                timeline_start, timeline_end = start, end
            self._publish_audition(
                req,
                result,
                dry_run=dry_run,
                timeline_start=timeline_start,
                timeline_end=timeline_end,
            )
        return result

    def _publish_audition(
        self,
        req: PlayRequest,
        result: PlayResult,
        *,
        dry_run: bool,
        timeline_start: float,
        timeline_end: float,
    ) -> None:
        publish_agent_play(
            self.project,
            timeline_start_sec=timeline_start,
            timeline_end_sec=timeline_end,
            source=result.source_label,
            tier=result.tier,
            dry_run=dry_run,
            query=req.query,
            match_index=req.match_index if req.query is not None else None,
            wav=result.wav_path,
            compare_segments=result.compare_segments,
        )

    def _resolve_source_and_times(self, req: PlayRequest) -> tuple[str, float, float]:
        if req.query:
            matches = search_transcript(self.project, req.query)
            if not matches:
                raise ValueError(f"no transcript match for {req.query!r}")
            if req.match_index < 0 or req.match_index >= len(matches):
                raise ValueError(
                    f"match index {req.match_index} out of range (0..{len(matches) - 1})"
                )
            m = matches[req.match_index]
            if m.timeline_start is None or m.timeline_end is None:
                raise ValueError(
                    f"transcript match for {req.query!r} falls in removed timeline material"
                )
            start = max(0.0, m.timeline_start - req.padding_sec)
            end = m.timeline_end + req.padding_sec
            if req.source in ("premix", "export"):
                return req.source, start, end
            if req.raw or req.source.startswith("track:"):
                return f"track:{m.track_id}", start, end
            return f"processed:{m.track_id}", start, end

        if req.end_sec <= req.start_sec:
            raise ValueError("end must be after start")
        return req.source, req.start_sec, req.end_sec

    def _resolve_audio(
        self,
        source: str,
        timeline_start: float,
        timeline_end: float,
        *,
        rerender: bool,
    ) -> tuple[Path, str, float, float, bool]:
        """Audio for one source; the last item is ``render_busy`` (only a premix rerender sets it)."""
        if source.startswith("processed:"):
            tid = source.split(":", 1)[1]
            path, tier, ext_start, ext_end = self._processed_audio(
                tid, timeline_start, timeline_end, rerender=rerender
            )
            return path, tier, ext_start, ext_end, False
        if source.startswith("track:"):
            tid = source.split(":", 1)[1]
            try:
                media, ext_start, ext_end = timeline_range_to_source(
                    self.project, tid, timeline_start, timeline_end
                )
            except TimelineMapError as exc:
                raise ValueError(str(exc)) from exc
            out = self._cache_path(f"raw_{tid}", timeline_start, timeline_end, media)
            if not out.is_file():
                FFmpegEngine().extract_segment(media, out, ext_start, ext_end)
            return out, "raw", ext_start, ext_end, False
        if source == "premix":
            path, busy = self._ensure_premix(rerender=rerender)
            out = self._cache_path("premix", timeline_start, timeline_end, path)
            if not out.is_file():
                FFmpegEngine().extract_segment(path, out, timeline_start, timeline_end)
            return out, "premix", timeline_start, timeline_end, busy
        if source == "export":
            path = self._latest_export_wav()
            out = self._cache_path("export", timeline_start, timeline_end, path)
            if not out.is_file():
                FFmpegEngine().extract_segment(path, out, timeline_start, timeline_end)
            return out, "export", timeline_start, timeline_end, False
        raise ValueError(
            f"unknown source {source!r}; use processed:<id>, track:<id>, premix, or export"
        )

    def _processed_audio(
        self,
        track_id: str,
        timeline_start: float,
        timeline_end: float,
        *,
        rerender: bool,
    ) -> tuple[Path, str, float, float]:
        # Decide from a bounded fingerprint read under the state lock; deep-copy the
        # project only when a segment must render (#358).
        fingerprint = stem_fingerprint(self.project, track_id)
        edit_hash = fingerprint.render_hash
        stem = stem_path(self.project, track_id)
        window = max(0.0, timeline_end - timeline_start)

        use_stem = True
        if rerender:
            try:
                with render_lock(self.project, timeout=_PLAY_RENDER_LOCK_TIMEOUT_SEC):
                    self._invalidate_processed_cache(track_id)
                    # Short windows: invalidate and segment-render only. Rebuilding a
                    # multi-hour stem for a 3s audition is slow and has produced
                    # all-zero extracts when the stem slice raced the rewrite.
                    if window > _FULL_STEM_RERENDER_MIN_SEC:
                        self.ensure_stem(track_id)
            except Timeout:
                # RenderBusyError, or the commit-lock timeout from ensure_stem's invalidation clear.
                # The segment render below plays the current edits, so this is not render_busy.
                log.info("render or project busy; playing %s from a segment render", track_id)
                use_stem = False

        # Freshness includes timeline-duration match; mismatched stems fall through
        # to segment render so timeline seconds are never treated as source offsets.
        # Read the stem's identity before its hash: a publish that swaps the stem while we
        # extract must not have its bytes played under this hash (#356).
        revision = stem_revision(self.project, track_id)
        fresh = stem_matches(self.project, track_id, fingerprint)
        if use_stem and fresh and revision is not None:
            out = self._cache_path(
                f"stem_{track_id}_{edit_hash}",
                timeline_start,
                timeline_end,
                stem,
            )
            if not out.is_file() or rerender:
                render_atomic(
                    out,
                    lambda tmp: FFmpegEngine().extract_segment(
                        stem, tmp, timeline_start, timeline_end
                    ),
                )
            if stem_revision(self.project, track_id) == revision:
                peak = _wav_peak_abs(out)
                if peak is not None and peak > 1e-5:
                    return out, "stem", timeline_start, timeline_end
            out.unlink(missing_ok=True)

        cache = self._segment_cache_path(track_id, timeline_start, timeline_end, edit_hash)
        if cache.is_file() and not rerender:
            return cache, "segment_cache", timeline_start, timeline_end

        # Miss: render one snapshot and key the cache by that snapshot's hash, so the key
        # names the rendered bytes even if an edit landed after the fingerprint (#220).
        render_project = snapshot_project(self.project)
        render_hash = track_render_hash(render_project, track_id)
        if render_hash != edit_hash:
            cache = self._segment_cache_path(track_id, timeline_start, timeline_end, render_hash)
            if cache.is_file() and not rerender:
                return cache, "segment_cache", timeline_start, timeline_end
        render_track_segment(
            render_project,
            track_id,
            timeline_start,
            timeline_end,
            cache,
            self._defaults,
        )
        return cache, "segment_render", timeline_start, timeline_end

    def _ensure_premix(self, *, rerender: bool) -> tuple[Path, bool]:
        """The premix path and ``render_busy`` (a rerender lost the render-lock race)."""
        premix = premix_path(self.project)
        busy = False
        if rerender or not premix.is_file():
            try:
                # Bounded wait; rerender_preview's own @with_render_lock re-enters this hold.
                with render_lock(self.project, timeout=_PLAY_RENDER_LOCK_TIMEOUT_SEC):
                    # A render takes seconds: merge the save so an edit committed meanwhile survives.
                    self.project = self.ws.checkpoint()
                    try:
                        rerender_preview(self.project)
                        self.ws.save_merged()
                    except BaseException:
                        # Drop the failed render's partial in-memory state and the checkpoint
                        # (as HistoryService._move does), so a reused workspace matches the file.
                        self.project = self.ws.discard_changes()
                        raise
            except Timeout as exc:
                if not premix.is_file():
                    raise
                # A commit-lock timeout from save_merged comes after the render: premix is fresh.
                busy = isinstance(exc, RenderBusyError)
                log.info("render or project busy; playing the existing premix")
        if not premix.is_file():
            raise FileNotFoundError("premix.wav not found; run render-preview or pipeline first")
        return premix, busy

    def _invalidate_processed_cache(self, track_id: str) -> None:
        """Delete the track's stem, its hash and its play-cache extracts. Caller holds ``render_lock``."""
        import shutil

        stem = stem_path(self.project, track_id)
        stem.unlink(missing_ok=True)
        hash_path = stem.parent / f"{track_id}.hash"
        hash_path.unlink(missing_ok=True)
        cache_dir = self.project.artifacts_dir() / "play_cache"
        if not cache_dir.is_dir():
            return
        seen: set[Path] = set()
        for pattern in (f"*_{track_id}_*", f"*{track_id}*"):
            for p in cache_dir.glob(pattern):
                if p in seen:
                    continue
                seen.add(p)
                if p.name.startswith("compose_"):
                    continue
                if p.is_dir():
                    shutil.rmtree(p, ignore_errors=True)
                else:
                    p.unlink(missing_ok=True)

    def ensure_stem(self, track_id: str, *, lock_timeout: float = RENDER_LOCK_TIMEOUT_SEC) -> Path:
        """Render full processed stem (assemble_timeline for one track).

        ``lock_timeout`` bounds the render-lock wait (playback passes 2 s).
        """
        from podcast_mcp.engines.ffmpeg import FFmpegEngine

        with render_lock(self.project, timeout=lock_timeout):
            render_project = snapshot_project(self.project)
            track = render_project.track_by_id(track_id)
            if not track:
                raise ValueError(f"unknown track {track_id!r}")
            out = publish_stem(
                render_project,
                track_id,
                lambda tmp: FFmpegEngine().render_dialogue_track(
                    render_project, track, tmp, self._defaults
                ),
                clear_invalidations=False,
            )
            # project_commit_lock takes project_state_lock first, so the live-project clear
            # below is serialized with snapshots and pipeline step publishes.
            with project_commit_lock(self.project):
                store = ProjectStore(self.ws.path)
                stored_project = store.load()
                if clear_invalidations_if_current(stored_project, render_project, track_id):
                    store.commit(stored_project)
                clear_invalidations_if_current(self.project, render_project, track_id)
        schedule_stem_waveforms(self.project, [track_id])
        return out

    def _segment_cache_path(
        self,
        track_id: str,
        start: float,
        end: float,
        edit_hash: str,
    ) -> Path:
        out_dir = self.project.artifacts_dir() / "play_cache"
        path = out_dir / f"processed_{track_id}_{start:.2f}_{end:.2f}_{edit_hash}.wav"
        self._play_cache_dir(path)
        return path

    def _latest_export_wav(self) -> Path:
        export = self.project.export_dir()
        wavs = sorted(export.glob("*.wav"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not wavs:
            raise FileNotFoundError(f"no WAV files in {export}")
        return wavs[0]

    def _cache_path(self, label: str, start: float, end: float, src: Path, extra: str = "") -> Path:
        # Include mtime so re-rendered stems invalidate prior extracts even when
        # the path and edit hash are unchanged.
        mtime = src.stat().st_mtime_ns if src.is_file() else 0
        key = f"{src}:{mtime}:{label}:{start:.3f}:{end:.3f}:{extra}"
        digest = short_digest(key)
        safe = re.sub(r"[^a-z0-9_-]+", "_", label.lower())[:40]
        out_dir = self.project.artifacts_dir() / "play_cache"
        path = out_dir / f"{safe}_{digest}.wav"
        self._play_cache_dir(src, path)
        return path

    def _play_follow_transcript(
        self,
        req: PlayRequest,
        *,
        dry_run: bool = False,
        player: str | None = None,
        publish_audition: bool = True,
    ) -> PlayResult:
        source, start, end = self._resolve_source_and_times(req)
        if end <= start:
            raise ValueError("end must be after start")

        single_tid: str | None = None
        if source.startswith("processed:") or source.startswith("track:"):
            single_tid = source.split(":", 1)[1]

        if req.compare:
            result = self._play_follow_transcript_compare(
                req, start, end, dry_run=dry_run, player=player
            )
        elif single_tid and source not in ("premix", "export"):
            result = self._play_follow_transcript_track(
                single_tid, start, end, req.rerender, dry_run=dry_run, player=player
            )
        else:
            result = self._play_follow_transcript_mix(
                start, end, req.rerender, dry_run=dry_run, player=player
            )
        if publish_audition:
            self._publish_audition(
                req,
                result,
                dry_run=dry_run,
                timeline_start=start,
                timeline_end=end,
            )
        return result

    def _follow_transcript_audio(
        self,
        track_id: str,
        start: float,
        end: float,
        *,
        rerender: bool,
    ) -> tuple[Path, str, float, float]:
        track = self.project.track_by_id(track_id)
        if track is None:
            raise ValueError(f"track {track_id!r} not found")
        if track.transcript_gate:
            return self._processed_audio(track_id, start, end, rerender=rerender)
        render_project = snapshot_project(self.project)
        render_track = render_project.track_by_id(track_id)
        assert render_track is not None
        render_track.transcript_gate = True
        render_track.transcript_gate_scope = None
        fingerprint = track_render_hash(render_project, track_id)
        cache = self._segment_cache_path(track_id, start, end, fingerprint)
        if not cache.is_file() or rerender:
            render_atomic(
                cache,
                lambda temporary: render_track_segment(
                    render_project,
                    track_id,
                    start,
                    end,
                    temporary,
                    self._defaults,
                ),
            )
        return cache, "segment_render", start, end

    def _play_follow_transcript_track(
        self,
        track_id: str,
        start: float,
        end: float,
        rerender: bool,
        *,
        dry_run: bool,
        player: str | None,
    ) -> PlayResult:
        segment, tier, _, _ = self._follow_transcript_audio(track_id, start, end, rerender=rerender)
        # Same level rule as the gated mix and play_compose: output gain minus what the tier baked.
        gain_db = _compose_gain_db(self.project.track_by_id(track_id), tier)
        intervals = word_intervals(self.project, track_id, start, end)
        fp = transcript_gate_fingerprint(self.project, [track_id], start, end)
        out = self._cache_path(
            f"follow_{track_id}_{fp}",
            start,
            end,
            segment,
            extra=(
                f"mix{MIX_SEMANTICS_REV}:tp{mix_peak_ceiling_db(self._defaults):g}:gain={gain_db}"
            ),
        )
        if not out.is_file():
            ceiling = mix_peak_ceiling_db(self._defaults)
            render_atomic(
                out,
                lambda tmp: FFmpegEngine().mix_tracks(
                    [(segment, gain_db)], tmp, peak_ceiling_db=ceiling
                ),
            )
        self._mark_play_cache_used(out)
        cmd = None if dry_run else self._player_command(player, out)
        if cmd:
            run(cmd, check=True)
        return PlayResult(
            wav_path=out,
            player_cmd=cmd,
            source_label=f"follow-transcript:processed:{track_id}",
            start_sec=start,
            end_sec=end,
            tier="transcript_gated",
            compare_segments=[
                {
                    "source": f"follow-transcript:processed:{track_id}",
                    "wav": str(out),
                    "tier": "transcript_gated",
                    "intervals": [{"start": s, "end": e} for s, e in intervals],
                }
            ],
        )

    def _play_follow_transcript_mix(
        self,
        start: float,
        end: float,
        rerender: bool,
        *,
        dry_run: bool,
        player: str | None,
    ) -> PlayResult:
        track_ids = dialogue_tracks_for_play(self.project)
        if not track_ids:
            raise ValueError("follow-transcript mix requires dialogue tracks")

        segments: list[tuple[str, Path]] = []
        gains_db: dict[str, float] = {}
        for tid in track_ids:
            seg, tier, _, _ = self._follow_transcript_audio(tid, start, end, rerender=rerender)
            segments.append((tid, seg))
            # Segment renders bake the staging gain; stems don't, and neither bakes the fader.
            gains_db[tid] = _compose_gain_db(self.project.track_by_id(tid), tier)

        intervals_by_track = {
            tid: [(s - start, e - start) for s, e in word_intervals(self.project, tid, start, end)]
            for tid in track_ids
        }
        fp = transcript_gate_fingerprint(self.project, track_ids, start, end)
        label = f"follow_mix_{fp}"
        ceiling = mix_peak_ceiling_db(self._defaults)
        out = self._cache_path(
            label,
            start,
            end,
            segments[0][1],
            extra=(
                f"mix{MIX_SEMANTICS_REV}:tp{ceiling:g}:"
                f"{_mix_cache_extra([(seg, gains_db[tid]) for tid, seg in segments])}"
            ),
        )
        if not out.is_file():
            render_atomic(
                out,
                lambda tmp: FFmpegEngine().mix_tracks(
                    [(segment, gains_db[tid]) for tid, segment in segments],
                    tmp,
                    peak_ceiling_db=ceiling,
                ),
            )
        self._mark_play_cache_used(out)
        cmd = None if dry_run else self._player_command(player, out)
        if cmd:
            run(cmd, check=True)
        return PlayResult(
            wav_path=out,
            player_cmd=cmd,
            source_label="follow-transcript:mix",
            start_sec=start,
            end_sec=end,
            tier="transcript_gated_mix",
            compare_segments=[
                {
                    "source": "follow-transcript:mix",
                    "wav": str(out),
                    "tier": "transcript_gated_mix",
                    "tracks": track_ids,
                    "intervals_by_track": {
                        tid: [{"start": s + start, "end": e + start} for s, e in iv]
                        for tid, iv in intervals_by_track.items()
                    },
                }
            ],
        )

    def _play_follow_transcript_compare(
        self,
        req: PlayRequest,
        start: float,
        end: float,
        *,
        dry_run: bool = False,
        player: str | None = None,
    ) -> PlayResult:
        track_ids = dialogue_tracks_for_play(self.project)
        if not track_ids:
            raise ValueError("follow-transcript compare requires dialogue tracks")

        segments: list[dict] = []
        last_wav: Path | None = None
        last_cmd: list[str] | None = None

        for tid in track_ids:
            result = self._play_follow_transcript_track(
                tid, start, end, req.rerender, dry_run=dry_run, player=player
            )
            seg = result.compare_segments[0] if result.compare_segments else {}
            segments.append(
                {
                    "source": result.source_label,
                    "wav": str(result.wav_path),
                    "tier": result.tier,
                    "intervals": seg.get("intervals", []),
                }
            )
            last_wav = result.wav_path
            last_cmd = result.player_cmd

        mix_result = self._play_follow_transcript_mix(
            start, end, req.rerender, dry_run=dry_run, player=player
        )
        segments.append(
            {
                "source": mix_result.source_label,
                "wav": str(mix_result.wav_path),
                "tier": mix_result.tier,
                "intervals_by_track": (
                    mix_result.compare_segments[0].get("intervals_by_track", {})
                    if mix_result.compare_segments
                    else {}
                ),
            }
        )
        last_wav = mix_result.wav_path
        last_cmd = mix_result.player_cmd

        return PlayResult(
            wav_path=last_wav or Path("."),
            player_cmd=last_cmd,
            source_label="follow-transcript:compare",
            start_sec=start,
            end_sec=end,
            tier="transcript_gated_compare",
            compare_segments=segments,
        )

    def _play_compare(
        self,
        req: PlayRequest,
        *,
        dry_run: bool = False,
        player: str | None = None,
        publish_audition: bool = True,
    ) -> PlayResult:
        if req.end_sec <= req.start_sec:
            raise ValueError("end must be after start")
        dialogue = [
            t
            for t in self.project.tracks
            if t.role == TrackRole.DIALOGUE and t.media and not t.muted
        ]
        if not dialogue:
            raise ValueError("compare requires dialogue tracks")

        segments: list[dict] = []
        last_wav: Path | None = None
        last_cmd: list[str] | None = None
        order: list[tuple[str, str]] = [
            *(("track", t.id) for t in dialogue),
            ("premix", "premix"),
        ]
        busy = False
        for kind, label in order:
            sub = PlayRequest(
                source=f"track:{label}" if kind == "track" else "premix",
                start_sec=req.start_sec,
                end_sec=req.end_sec,
                rerender=req.rerender,
            )
            result = self.play(sub, dry_run=dry_run, player=player, publish_audition=False)
            segments.append(
                {
                    "source": result.source_label,
                    "wav": str(result.wav_path),
                    "tier": result.tier,
                }
            )
            last_wav = result.wav_path
            last_cmd = result.player_cmd
            busy = busy or result.render_busy

        result = PlayResult(
            wav_path=last_wav or Path("."),
            player_cmd=last_cmd,
            source_label="compare",
            start_sec=req.start_sec,
            end_sec=req.end_sec,
            tier="compare",
            compare_segments=segments,
            render_busy=busy,
        )
        if publish_audition:
            self._publish_audition(
                req,
                result,
                dry_run=dry_run,
                timeline_start=req.start_sec,
                timeline_end=req.end_sec,
            )
        return result

    def audition_context(
        self,
        timeline_start: float,
        timeline_end: float,
        *,
        skew_warn_sec: float | None = None,
        detail: str = "summary",
        include_dsp: bool = True,
    ) -> dict:
        """Caption + skew + freshness report for a timeline window."""
        from podcast_mcp.edits.audition_context import (
            DEFAULT_SKEW_WARN_SEC,
            build_audition_context,
        )
        from podcast_mcp.services.pipeline import prosody_params_for

        return build_audition_context(
            self.project,
            timeline_start,
            timeline_end,
            skew_warn_sec=(DEFAULT_SKEW_WARN_SEC if skew_warn_sec is None else skew_warn_sec),
            detail=detail,  # type: ignore[arg-type]
            include_dsp=include_dsp,
            prosody_params=prosody_params_for(self.ws.path),
        )

    def prosody_overlay(self) -> dict:
        """Timeline-mapped prosody profile per dialogue track for the DAW overlay (#719)."""
        from podcast_mcp.edits.prosody_profile import prosody_overlay
        from podcast_mcp.services.pipeline import prosody_params_for

        return prosody_overlay(self.project, params=prosody_params_for(self.ws.path))

    def play_compose(
        self,
        track_ids: list[str],
        start_sec: float,
        end_sec: float,
        *,
        tier: str = "processed",
        rerender: bool = False,
        dry_run: bool = False,
        player: str | None = None,
        publish_audition: bool = True,
    ) -> PlayResult:
        """Mix selected tracks for a timeline window into play_cache (no project mutation)."""
        if end_sec <= start_sec:
            raise ValueError("end must be after start")
        kind = (tier or "processed").strip().lower()
        if kind not in {"processed", "raw"}:
            raise ValueError("tier must be processed or raw")
        ids = [tid.strip() for tid in track_ids if tid and str(tid).strip()]
        if not ids:
            raise ValueError("track_ids must not be empty")
        known = {t.id for t in self.project.tracks}
        unknown = [tid for tid in ids if tid not in known]
        if unknown:
            raise ValueError(f"unknown track_ids: {sorted(unknown)}")

        segments: list[tuple[Path, float]] = []
        for tid in ids:
            source = f"track:{tid}" if kind == "raw" else f"processed:{tid}"
            wav, tier_used, _, _, _ = self._resolve_audio(
                source, start_sec, end_sec, rerender=rerender
            )
            track = self.project.track_by_id(tid)
            segments.append((wav, _compose_gain_db(track, tier_used)))

        ceiling = mix_peak_ceiling_db(self._defaults)
        extra = f"mix{MIX_SEMANTICS_REV}:tp{ceiling:g}:{_mix_cache_extra(segments)}"
        out = self._cache_path(
            f"compose_{kind}_{'-'.join(ids)}",
            start_sec,
            end_sec,
            segments[0][0],
            extra=extra,
        )
        if not out.is_file() or rerender:
            render_atomic(
                out, lambda tmp: FFmpegEngine().mix_tracks(segments, tmp, peak_ceiling_db=ceiling)
            )
        self._mark_play_cache_used(out)

        cmd = None if dry_run else self._player_command(player, out)
        if cmd:
            run(cmd, check=True)
        result = PlayResult(
            wav_path=out,
            player_cmd=cmd,
            source_label=f"compose:{kind}:{','.join(ids)}",
            start_sec=start_sec,
            end_sec=end_sec,
            tier="compose",
        )
        if publish_audition:
            self._publish_audition(
                PlayRequest(
                    source=result.source_label,
                    start_sec=start_sec,
                    end_sec=end_sec,
                ),
                result,
                dry_run=dry_run,
                timeline_start=start_sec,
                timeline_end=end_sec,
            )
        return result

    def play_ab_wavs(
        self,
        wav_a: Path | str,
        wav_b: Path | str,
        *,
        gap_sec: float = 0.4,
        dry_run: bool = False,
        player: str | None = None,
        publish_audition: bool = False,
        start_sec: float = 0.0,
        end_sec: float = 0.0,
    ) -> PlayResult:
        """Play A then B with a short silence gap (one concat WAV, one player)."""
        path_a = Path(wav_a)
        path_b = Path(wav_b)
        if not path_a.is_file():
            raise FileNotFoundError(f"A wav not found: {path_a}")
        if not path_b.is_file():
            raise FileNotFoundError(f"B wav not found: {path_b}")

        gap = max(0.0, float(gap_sec))
        out = self._ab_concat_path(path_a, path_b, gap)
        if not out.is_file():
            render_atomic(out, lambda tmp: self._write_ab_concat(path_a, path_b, tmp, gap_sec=gap))
        self._mark_play_cache_used(out)

        cmd = None if dry_run else self._player_command(player, out)
        if cmd:
            run(cmd, check=True)
        result = PlayResult(
            wav_path=out,
            player_cmd=cmd,
            source_label="ab",
            start_sec=start_sec,
            end_sec=end_sec if end_sec > start_sec else start_sec,
            tier="ab_concat",
            compare_segments=[
                {"label": "A", "wav": str(path_a.resolve())},
                {"label": "gap_sec", "gap_sec": gap},
                {"label": "B", "wav": str(path_b.resolve())},
            ],
        )
        if publish_audition and end_sec > start_sec:
            self._publish_audition(
                PlayRequest(
                    source="ab",
                    start_sec=start_sec,
                    end_sec=end_sec,
                ),
                result,
                dry_run=dry_run,
                timeline_start=start_sec,
                timeline_end=end_sec,
            )
        return result

    def play_history_ab(
        self,
        before_index: int,
        after_index: int,
        req: PlayRequest,
        *,
        gap_sec: float = 0.4,
        dry_run: bool = False,
        player: str | None = None,
    ) -> PlayResult:
        """Extract the same range at two history indices, then play A→gap→B."""
        from .history import HistoryService

        if before_index == after_index:
            raise ValueError("before_index and after_index must differ")

        hist = HistoryService(self.ws)
        out_dir = self._play_cache_dir()
        # Include snapshot ids so re-recording the same indices cannot reuse
        # stale A/B wavs after history was rewritten (goto + new mutate).
        entries = list(self.project.history.entries)
        before_id = entries[before_index].id if 0 <= before_index < len(entries) else ""
        after_id = entries[after_index].id if 0 <= after_index < len(entries) else ""
        pair_key = (
            f"{before_index}:{before_id}:{after_index}:{after_id}:"
            f"{req.source}:{req.start_sec:.3f}:{req.end_sec:.3f}:"
            f"{req.rerender}:{gap_sec:.3f}"
        )
        digest = short_digest(pair_key)
        stable_a = out_dir / f"ab_hist_{digest}_a.wav"
        stable_b = out_dir / f"ab_hist_{digest}_b.wav"

        hist.goto(before_index)
        self.project = self.ws.project
        a_result = self.play(req, dry_run=True, publish_audition=False)
        shutil.copy2(a_result.wav_path, stable_a)
        self._mark_play_cache_used(stable_a)

        hist.goto(after_index)
        self.project = self.ws.project
        b_result = self.play(req, dry_run=True, publish_audition=False)
        shutil.copy2(b_result.wav_path, stable_b)
        self._mark_play_cache_used(stable_b)

        return self.play_ab_wavs(
            stable_a,
            stable_b,
            gap_sec=gap_sec,
            dry_run=dry_run,
            player=player,
            publish_audition=True,
            start_sec=req.start_sec,
            end_sec=req.end_sec,
        )

    def play_selected_range(
        self, target: ExactRangeTarget, *, full_mix_path: Path | None = None
    ) -> Path:
        from podcast_mcp.edits.range_edits import resolve_range
        from podcast_mcp.services.media import render_range_audio

        with self.ws.transaction() as project:
            target = resolve_range(project, target)
            current = snapshot_project(project)
        digest = short_digest(json.dumps(target.model_dump(mode="json"), sort_keys=True))
        context = "full-mix" if full_mix_path is not None else "selected-tracks"
        output = (
            self._play_cache_dir() / f"selected-range-{context}-{digest}-{secrets.token_hex(8)}.wav"
        )
        render_atomic(
            output,
            lambda temporary: render_range_audio(
                current, target, temporary, full_mix_path=full_mix_path
            ),
        )
        self._mark_play_cache_used(output)
        return output

    def play_pending_preview(
        self,
        edit_id: str,
        *,
        mode: str = "suggested",
        pad_sec: float = 0.5,
        gap_sec: float = 0.4,
        dry_run: bool = False,
        player: str | None = None,
        rerender: bool = False,
    ) -> PlayResult:
        """Current / Suggested / A/B full mix around a pending edit.

        Each side mixes its window from per-track segment renders at the headroom trim the
        premix gets for the current mix (``mix_trim_db``): Current from the project as it
        is, Suggested after approving the edit on a snapshot, so it is what approving ships.
        Neither reads ``premix.wav``.
        """
        kind = (mode or "suggested").strip().lower()
        if kind not in _PENDING_SIDES:
            raise ValueError("mode must be current, suggested, or ab")
        window = resolve_pending_preview(self.project, edit_id, pad_sec=pad_sec)
        if kind != "current" and window.suggest_reason:
            raise ValueError(window.suggest_reason)
        wavs = [
            self._pending_window_wav(window, side, rerender=rerender)
            for side in _PENDING_SIDES[kind]
        ]
        if kind == "ab":
            return self.play_ab_wavs(
                wavs[0],
                wavs[1],
                gap_sec=gap_sec if gap_sec is not None else DEFAULT_AB_GAP_SEC,
                dry_run=dry_run,
                player=player,
                publish_audition=False,
                start_sec=window.play_start,
                end_sec=window.play_end,
            )
        cmd = None if dry_run else self._player_command(player, wavs[0])
        if cmd:
            run(cmd, check=True)
        return PlayResult(
            wav_path=wavs[0],
            player_cmd=cmd,
            source_label=f"pending:{kind}",
            start_sec=window.play_start,
            end_sec=window.play_end,
            tier=f"pending_{kind}",
        )

    def pending_preview_cached_wav(
        self,
        edit_id: str,
        *,
        mode: str = "suggested",
        pad_sec: float = 0.5,
        gap_sec: float = 0.4,
    ) -> Path | None:
        """Return the pending-preview WAV if it already exists (no FFmpeg)."""
        kind = (mode or "suggested").strip().lower()
        if kind not in _PENDING_SIDES:
            raise ValueError("mode must be current, suggested, or ab")
        window = resolve_pending_preview(self.project, edit_id, pad_sec=pad_sec)
        if kind != "current" and window.suggest_reason:
            raise ValueError(window.suggest_reason)
        paths = [self._pending_window_path(window, side) for side in _PENDING_SIDES[kind]]
        if not all(path.is_file() for path in paths):
            return None
        if kind == "ab":
            gap = gap_sec if gap_sec is not None else DEFAULT_AB_GAP_SEC
            out = self._ab_concat_path(paths[0], paths[1], max(0.0, float(gap)))
        else:
            out = paths[0]
        self._mark_play_cache_used(out)
        return out if out.is_file() else None

    def _ab_concat_path(self, wav_a: Path, wav_b: Path, gap: float) -> Path:
        key = (
            f"{wav_a.resolve()}:{wav_a.stat().st_mtime_ns}:"
            f"{wav_b.resolve()}:{wav_b.stat().st_mtime_ns}:{gap:.3f}"
        )
        digest = short_digest(key)
        out_dir = self.project.artifacts_dir() / "play_cache"
        path = out_dir / f"ab_concat_{digest}.wav"
        self._play_cache_dir(wav_a, wav_b, path)
        return path

    def _mix_key(self) -> str:
        """What the mix plays: the mix hash, and each mixed track's stem hash."""
        gains = mix_gains(self.project)
        return json.dumps(
            {
                "mix": mix_render_hash(gains, mix_peak_ceiling_db(self._defaults)),
                "stems": {
                    track_id: track_render_hash(self.project, track_id) for track_id in gains
                },
            },
            sort_keys=True,
        )

    def mix_trim_db(self) -> float:
        """The headroom trim ``premix.hash`` would record for the current mix, without mixing.

        A fresh premix already records it. Otherwise the premix's own ``peak_trim_db``
        measures the current stems (rendering any that are stale), cached in memory by the
        stems' hashes, gains and the ceiling.
        """
        gains = mix_gains(self.project)
        if not gains:
            return 0.0
        if premix_path(self.project).is_file() and not premix_is_stale(
            self.project, self._defaults
        ):
            recorded = read_premix_trim_db(self.project)
            if recorded is not None:
                return recorded
        for track_id in gains:
            if not stem_is_fresh(self.project, track_id):
                self.ensure_stem(track_id)
        return _stem_mix_trim_db(
            tuple(
                (stem_path(self.project, track_id), gain, track_render_hash(self.project, track_id))
                for track_id, gain in gains.items()
            ),
            mix_peak_ceiling_db(self._defaults),
        )

    def _pending_window_path(self, window: PendingPreviewWindow, side: str) -> Path:
        edit = next(e for e in self.project.edit_decisions if e.id == window.edit_id)
        key = json.dumps(
            {
                "window": [window.play_start, window.play_end],
                "edit": edit.model_dump(mode="json"),
                "mix": self._mix_key(),
                "defaults": self._defaults,
            },
            sort_keys=True,
        )
        out_dir = self.project.artifacts_dir() / "play_cache"
        path = out_dir / f"pending_{side}_{short_digest(key)}.wav"
        self._play_cache_dir(path)
        return path

    def _pending_window_wav(
        self, window: PendingPreviewWindow, side: str, *, rerender: bool
    ) -> Path:
        out = self._pending_window_path(window, side)
        if out.is_file() and not rerender:
            self._mark_play_cache_used(out)
            return out
        if side == "suggested":
            project = snapshot_project(self.project)
            play_end = apply_for_suggested(project, window)
        else:
            project, play_end = self.project, window.play_end
        trim = self.mix_trim_db()
        with tempfile.TemporaryDirectory(dir=out.parent) as directory:
            segments: list[tuple[Path, float]] = []
            for track in project.tracks:
                if track.muted or track.media is None:
                    continue
                segment = Path(directory) / f"{track.id}.wav"
                render_track_segment(
                    project, track.id, window.play_start, play_end, segment, self._defaults
                )
                segments.append((segment, track.fader_db))
            if segments:
                render_atomic(
                    out,
                    lambda temporary: FFmpegEngine().mix_tracks(segments, temporary, trim_db=trim),
                )
            else:
                render_atomic(
                    out,
                    lambda temporary: FFmpegEngine().silence(
                        temporary, play_end - window.play_start
                    ),
                )
        self._mark_play_cache_used(out)
        return out

    def _write_ab_concat(self, wav_a: Path, wav_b: Path, out: Path, *, gap_sec: float) -> Path:
        """Write A + optional silence + B into ``out`` (pcm_s16le)."""
        eng = FFmpegEngine()
        if gap_sec <= 1e-9:
            return eng.join_audio_parts([wav_a, wav_b], out)

        with wave.open(str(wav_a), "rb") as w:
            rate = w.getframerate() or 48000
            channels = w.getnchannels() or 1

        ch_layout = "mono" if channels <= 1 else "stereo"
        silence = out.with_name(f".{out.stem}_gap.wav")
        cmd_sil = [
            eng.ffmpeg,
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"anullsrc=r={rate}:cl={ch_layout}",
            "-t",
            f"{gap_sec:.6f}",
            "-acodec",
            "pcm_s16le",
            str(silence),
        ]
        run(cmd_sil, check=True, capture_output=True)
        try:
            # Filter concat so mismatched layouts still join cleanly.
            cmd = [
                eng.ffmpeg,
                "-y",
                "-i",
                str(wav_a),
                "-i",
                str(silence),
                "-i",
                str(wav_b),
                "-filter_complex",
                "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]",
                "-map",
                "[out]",
                "-acodec",
                "pcm_s16le",
                str(out),
            ]
            run(cmd, check=True, capture_output=True)
        finally:
            silence.unlink(missing_ok=True)
        return out

    def _player_command(self, player: str | None, wav: Path) -> list[str]:
        if player:
            return [player, str(wav)]
        if platform.system() == "Darwin":
            return ["afplay", str(wav)]
        return ["ffplay", "-nodisp", "-autoexit", str(wav)]

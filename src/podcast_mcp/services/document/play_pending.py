"""Pending-cut preview: the current and suggested windows rendered, cached and warmed."""

from __future__ import annotations

import hashlib
import json
import logging
import tempfile
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from podcast_mcp.edits.pending_preview import (
    DEFAULT_AB_GAP_SEC,
    DEFAULT_PAD_SEC,
    MAX_PAD_SEC,
    MIN_PAD_SEC,
    PendingPreviewSpan,
    PendingPreviewWindow,
    apply_for_suggested,
    resolve_pending_preview,
)
from podcast_mcp.engines.effect_filters import ADAPTIVE_EFFECTS
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.room_tone import (
    record_room_tone_pool,
    room_tone_bed_digest,
    room_tone_pool_digest,
)
from podcast_mcp.engines.timeline_render import render_track_segment
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.atomic_render import render_atomic
from podcast_mcp.util.batch_scope import batch_scope
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.hashing import short_digest
from podcast_mcp.util.process import run
from podcast_mcp.util.project_state import (
    RENDER_LOCK_TIMEOUT_SEC,
    snapshot_project,
)
from podcast_mcp.util.wav import open_wav

from .play_compose import _PlayCompose
from .play_headroom import _PlayHeadroom
from .play_support import PlayResult

log = logging.getLogger(__name__)

# Seconds of lead-in a window renders (and drops) on a track with an adaptive effect; loudnorm's
# residual against the whole stem falls from about -16 dB (cold) to about -50 dB at 12 s.
PENDING_WARMUP_SEC = 15.0

# The pad range the GUI routes validate against, from the one place the service validates it.
PENDING_PREVIEW_PAD_DEFAULT_SEC = DEFAULT_PAD_SEC
PENDING_PREVIEW_PAD_MIN_SEC = MIN_PAD_SEC
PENDING_PREVIEW_PAD_MAX_SEC = MAX_PAD_SEC


# Pending-preview sides each mode renders.
_PENDING_SIDES = {
    "current": ("current",),
    "suggested": ("suggested",),
    "ab": ("current", "suggested"),
}


_WINDOW_LOCKS: dict[str, threading.Lock] = {}
_WINDOW_LOCKS_GUARD = threading.Lock()


@contextmanager
def _window_render_lock(path: Path) -> Iterator[None]:
    """One render of a content-addressed preview window at a time in this process."""
    with _WINDOW_LOCKS_GUARD:
        lock = _WINDOW_LOCKS.setdefault(str(path), threading.Lock())
    with lock:
        try:
            yield
        finally:
            with _WINDOW_LOCKS_GUARD:
                _WINDOW_LOCKS.pop(str(path), None)


def _warmup_sec(project: EpisodeProject, track_id: str) -> float:
    """Lead-in a window render needs on ``track_id``: 0 unless its chain has an adaptive effect."""
    chain = next((c for c in project.processing_chains if c.track_id == track_id), None)
    if chain is None or not any(
        fx.effect in ADAPTIVE_EFFECTS and not fx.bypass for fx in chain.effects
    ):
        return 0.0
    return PENDING_WARMUP_SEC


class _PlayPending(_PlayCompose, _PlayHeadroom):
    def play_pending_preview(
        self,
        edit_id: str,
        *,
        mode: str = "suggested",
        pad_sec: float = DEFAULT_PAD_SEC,
        gap_sec: float = DEFAULT_AB_GAP_SEC,
        dry_run: bool = False,
        player: str | None = None,
        rerender: bool = False,
        lock_timeout: float = RENDER_LOCK_TIMEOUT_SEC,
    ) -> PlayResult:
        """Current / Suggested / A/B full mix around a pending edit.

        Each side mixes its window from per-track segment renders at the headroom trim the
        premix gets for the current mix (``mix_trim_db``): Current from the project as it
        is, Suggested after approving the edit on a snapshot, so it is what approving ships.
        Neither reads ``premix.wav``.

        The window is the edit plus ``pad_sec`` on each side (0 to 10 s, clamped to the
        timeline's ends). The result's ``start_sec`` / ``end_sec`` are where the played
        file sits on its own timeline (the Suggested file ends where the edited timeline
        does); ``pending_preview_span`` says the same for a file already rendered.
        """
        kind = (mode or "suggested").strip().lower()
        if kind not in _PENDING_SIDES:
            raise CodedValueError(
                "mode must be current, suggested, or ab", code="compare_mode_invalid"
            )
        window = resolve_pending_preview(self.project, edit_id, pad_sec=pad_sec)
        if kind != "current" and window.suggest_reason:
            raise CodedValueError(window.suggest_reason, code="pending_preview_unavailable")
        # One scope for the sides: a path resolution or decode of an unchanged file is paid
        # once, not once per word the Suggested side's approval re-optimizes against.
        with batch_scope():
            wavs = [
                self._pending_window_wav(window, side, rerender=rerender, lock_timeout=lock_timeout)
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
        span = self._span(window, kind, wavs[0])
        return PlayResult(
            wav_path=wavs[0],
            player_cmd=cmd,
            source_label=f"pending:{kind}",
            start_sec=span.start_sec,
            end_sec=span.end_sec,
            tier=f"pending_{kind}",
        )

    def pending_preview_cached_wav(
        self,
        edit_id: str,
        *,
        mode: str = "suggested",
        pad_sec: float = DEFAULT_PAD_SEC,
        gap_sec: float = DEFAULT_AB_GAP_SEC,
    ) -> Path | None:
        """Return the pending-preview WAV if it already exists (no FFmpeg)."""
        kind = (mode or "suggested").strip().lower()
        if kind not in _PENDING_SIDES:
            raise CodedValueError(
                "mode must be current, suggested, or ab", code="compare_mode_invalid"
            )
        window = resolve_pending_preview(self.project, edit_id, pad_sec=pad_sec)
        if kind != "current" and window.suggest_reason:
            raise CodedValueError(window.suggest_reason, code="pending_preview_unavailable")
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

    def pending_preview_span(
        self, edit_id: str, wav: Path, *, mode: str, pad_sec: float = DEFAULT_PAD_SEC
    ) -> PendingPreviewSpan:
        """Where the rendered ``wav`` of ``mode`` sits, so a player can place its playheads."""
        kind = (mode or "suggested").strip().lower()
        if kind not in _PENDING_SIDES:
            raise CodedValueError(
                "mode must be current, suggested, or ab", code="compare_mode_invalid"
            )
        window = resolve_pending_preview(self.project, edit_id, pad_sec=pad_sec)
        return self._span(window, kind, wav)

    @staticmethod
    def _span(window: PendingPreviewWindow, kind: str, wav: Path) -> PendingPreviewSpan:
        end = window.play_end
        if kind == "suggested":
            # The edited timeline is shorter or longer than the current one by what the edit
            # took out or paced in, so the file's own length says where it ends.
            with open_wav(wav) as audio:
                end = window.play_start + audio.getnframes() / audio.getframerate()
        return PendingPreviewSpan(
            edit_id=window.edit_id,
            mode=kind,
            pad_sec=window.pad_sec,
            start_sec=window.play_start,
            end_sec=end,
            edit_start_sec=window.timeline_start,
            edit_end_sec=window.timeline_end,
        )

    def warm_pending_preview(
        self,
        edit_id: str | None = None,
        *,
        pad_sec: float = DEFAULT_PAD_SEC,
        lock_timeout: float = RENDER_LOCK_TIMEOUT_SEC,
    ) -> dict[str, Any]:
        """Do a pending preview's slow work now, so the first Play around is a cached file.

        That is the mix trim and each track's whole-track level profile (which approving
        the edit on a snapshot reads for the Suggested side), then, for ``edit_id``, the
        Current / Suggested / A/B renders themselves at ``pad_sec`` (a window is cached per
        pad, so warm the pad the Play will ask for).

        Returns the trim and each pre-rendered side's status (``ready``, ``unavailable`` for an
        edit that cannot be previewed that way, ``failed`` for a render that errored), so the
        caller can retry a failure instead of taking it for done. ``lock_timeout`` is the
        render-lock wait of each stem render (the caller holds the lock for the edit renders).
        """
        from podcast_mcp.edits.audio_cache import (
            JUMP_SAMPLE_RATE,
            WAVEFORM_SAMPLE_RATE,
            track_level_profile,
        )

        trim = self.mix_trim_db(lock_timeout=lock_timeout)
        for track in self.project.tracks:
            if track.media is None:
                continue
            for rate in (WAVEFORM_SAMPLE_RATE, JUMP_SAMPLE_RATE):
                try:
                    track_level_profile(self.project, track.id, sample_rate=rate, record=True)
                except (OSError, ValueError, KeyError):
                    log.debug("level profile warm skipped for %s", track.id, exc_info=True)
            try:
                record_room_tone_pool(self.project, track.id)
            except (OSError, ValueError, KeyError):
                log.debug("room tone pool skipped for %s", track.id, exc_info=True)
        sides: dict[str, str] = {}
        if edit_id is not None:
            for mode in _PENDING_SIDES:
                try:
                    self.play_pending_preview(
                        edit_id,
                        mode=mode,
                        pad_sec=pad_sec,
                        dry_run=True,
                        lock_timeout=lock_timeout,
                    )
                    sides[mode] = "ready"
                except (CodedValueError, KeyError, ValueError):
                    log.debug("pending %s not warmed for %s", mode, edit_id, exc_info=True)
                    sides[mode] = "unavailable"
                except OSError:
                    log.warning("pending %s warm failed for %s", mode, edit_id, exc_info=True)
                    sides[mode] = "failed"
        return {"trim_db": trim, "sides": sides}

    def _pending_window_path(self, window: PendingPreviewWindow, side: str) -> Path:
        edit = next(e for e in self.project.edit_decisions if e.id == window.edit_id)
        key = json.dumps(
            {
                "window": [window.play_start, window.play_end],
                "pad_sec": window.pad_sec,
                # Bump when a side renders differently for the same inputs.
                "render_rev": 2,
                "edit": edit.model_dump(mode="json"),
                "mix": self._mix_key(),
                # The Suggested side re-optimizes the cut against every track's words.
                "transcripts": hashlib.sha256(
                    self.project.transcript_data.model_dump_json().encode()
                ).hexdigest(),
                "defaults": self._defaults,
                "room_tone_pool": room_tone_pool_digest(self.project),
                "room_tone_bed": room_tone_bed_digest(self.project),
            },
            sort_keys=True,
        )
        out_dir = self.project.artifacts_dir() / "play_cache"
        path = out_dir / f"pending_{side}_{short_digest(key)}.wav"
        self._play_cache_dir(path)
        return path

    def _pending_window_wav(
        self,
        window: PendingPreviewWindow,
        side: str,
        *,
        rerender: bool,
        lock_timeout: float = RENDER_LOCK_TIMEOUT_SEC,
    ) -> Path:
        out = self._pending_window_path(window, side)
        if out.is_file() and not rerender:
            self._mark_play_cache_used(out)
            return out
        # The edit warm and the first Play around render the same content-addressed window
        # at once; the second waits for the first and reads its file instead of rendering it.
        with _window_render_lock(out):
            if out.is_file() and not rerender:
                self._mark_play_cache_used(out)
                return out
            return self._render_pending_window(window, side, out, lock_timeout=lock_timeout)

    def _render_pending_window(
        self,
        window: PendingPreviewWindow,
        side: str,
        out: Path,
        *,
        lock_timeout: float,
    ) -> Path:
        if side == "suggested":
            project = snapshot_project(self.project)
            play_end = apply_for_suggested(project, window, defaults=self._defaults)
        else:
            project, play_end = self.project, window.play_end
        trim = self.mix_trim_db(lock_timeout=lock_timeout)
        self._render_mix_window(project, window.play_start, play_end, out, trim_db=trim)
        self._mark_play_cache_used(out)
        return out

    def _render_mix_window(
        self, project: EpisodeProject, start: float, end: float, out: Path, *, trim_db: float
    ) -> None:
        """Mix ``project``'s audible tracks over ``[start, end]`` into ``out`` at ``trim_db``."""
        with tempfile.TemporaryDirectory(dir=out.parent) as directory:
            segments: list[tuple[Path, float]] = []
            for track in project.tracks:
                if track.muted or track.media is None:
                    continue
                segment = Path(directory) / f"{track.id}.wav"
                warm = min(start, _warmup_sec(project, track.id))
                if warm > 0:
                    # Adaptive filters (loudnorm, noise reduction, dynamics) depend on the audio
                    # before the window: render lead-in and drop it, so the window sounds as it
                    # does inside the whole-episode stem.
                    lead = Path(directory) / f"{track.id}.lead.wav"
                    render_track_segment(project, track.id, start - warm, end, lead, self._defaults)
                    FFmpegEngine().extract_segment(lead, segment, warm, warm + (end - start))
                else:
                    render_track_segment(project, track.id, start, end, segment, self._defaults)
                segments.append((segment, track.fader_db))
            if segments:
                render_atomic(
                    out,
                    lambda temporary: FFmpegEngine().mix_tracks(
                        segments, temporary, trim_db=trim_db
                    ),
                )
            else:
                render_atomic(out, lambda temporary: FFmpegEngine().silence(temporary, end - start))

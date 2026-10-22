"""Processed audio, premix and stem resolution, and the transport path (see :mod:`.play`)."""

from __future__ import annotations

import logging
from pathlib import Path

from filelock import Timeout

from podcast_mcp.edits.transcript_search import search_transcript
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.media_probe import has_several_audio_streams
from podcast_mcp.engines.play_audit import (
    clear_invalidations_if_current,
    premix_path,
    publish_stem,
    stem_fingerprint,
    stem_hash_path,
    stem_is_fresh,
    stem_matches,
    stem_revision,
    track_render_hash,
)
from podcast_mcp.engines.timeline_render import render_track_segment
from podcast_mcp.engines.timemap import timeline_range_to_source
from podcast_mcp.services.media import schedule_stem_waveforms
from podcast_mcp.services.pipeline import rerender_preview
from podcast_mcp.services.session_sync import publish_agent_play
from podcast_mcp.util.atomic_render import render_atomic
from podcast_mcp.util.coded_error import CodedFileNotFoundError, CodedKeyError, CodedValueError
from podcast_mcp.util.project_state import (
    RENDER_LOCK_TIMEOUT_SEC,
    RenderBusyError,
    render_lock,
    snapshot_project,
)
from podcast_mcp.util.tracks import recording_audio_path, stem_path, unknown_track
from podcast_mcp.util.wav import open_wav

from .play_cache import _PlayCache
from .play_support import PlayRequest, PlayResult, TransportPath

log = logging.getLogger(__name__)


_FULL_STEM_RERENDER_MIN_SEC = 60.0
# Playback never queues behind an export or Refresh (#482): processed segment play,
# premix rerender and transport stem builds wait this long for the render lock, then
# play a segment render or the premix/stem already on disk instead of rebuilding.
_PLAY_RENDER_LOCK_TIMEOUT_SEC = 2.0


def _wav_peak_abs(path: Path) -> float | None:
    """Peak absolute sample in [0, 1], or None if unreadable."""
    try:
        with open_wav(path) as w:
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


class _PlayStems(_PlayCache):
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
            raise CodedValueError(
                "source_id is only supported for raw/track transport",
                code="transport_source_id_unsupported",
            )
        if normalized == "premix":
            # Transport streaming must not rebuild on every GET; use rerender=True
            # (CLI --rerender / ?rerender=1) when a rebuild is intentional.
            busy = False
            if rerender:
                path, busy = self._ensure_premix(rerender=True)
            else:
                path = premix_path(self.project)
                if not path.is_file():
                    raise CodedFileNotFoundError(
                        "premix.wav not found; run render-preview or pipeline first",
                        code="no_mix",
                    )
            return TransportPath(
                path=path.resolve(),
                source="premix",
                tier="premix",
                render_busy=busy,
            )

        if normalized == "review" or normalized.startswith("review:"):
            from podcast_mcp.services.collaboration import version_audio_path

            if normalized.startswith("review:"):
                version_id = normalized.split(":", 1)[1].strip()
            else:
                version_id = (track_id or "").strip() or (
                    self.project.review.active_version_id or ""
                )
            if not version_id:
                raise CodedValueError(
                    "review version id required (kind=review:<id>, track_id=, "
                    "or set review.active_version_id)",
                    code="review_version_required",
                )
            path = version_audio_path(self.project, version_id)
            return TransportPath(
                path=path,
                source=f"review:{version_id}",
                tier="review",
            )

        if normalized in ("stem", "processed", "fx"):
            if not track_id:
                raise CodedValueError(
                    "track_id required for stem/processed transport",
                    code="transport_track_required",
                )
            if self.project.track_by_id(track_id) is None:
                raise CodedKeyError(f"unknown track {track_id!r}", code="track_not_found")
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
                    raise CodedFileNotFoundError(
                        f"processed stem missing for {track_id!r}; "
                        "run assemble_timeline or pass build_stem=True",
                        code="file_not_found",
                    )
            return TransportPath(
                path=path.resolve(),
                source=f"processed:{track_id}",
                tier="stem",
                stem_is_fresh=stem_is_fresh(self.project, track_id, defaults=self._defaults),
                render_busy=busy,
            )

        if normalized in ("raw", "track"):
            if not track_id:
                raise CodedValueError(
                    "track_id required for raw/track transport", code="transport_track_required"
                )
            path = recording_audio_path(self.project, track_id, source_id)
            if not path.is_file():
                raise CodedFileNotFoundError(
                    f"raw media for track {track_id} not found", code="file_not_found"
                )
            return TransportPath(
                path=path.resolve(),
                source=f"source:{source_id}" if source_id is not None else f"track:{track_id}",
                tier="raw",
            )

        raise CodedValueError(
            f"unknown transport kind {kind!r}; "
            "use premix, review[:id], stem/processed, or raw/track",
            code="transport_kind_unknown",
        )

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
            matches = search_transcript(self.project, req.query, defaults=self._defaults)
            if not matches:
                raise CodedValueError(
                    f"no transcript match for {req.query!r}", code="no_transcript_match"
                )
            if req.match_index < 0 or req.match_index >= len(matches):
                raise CodedValueError(
                    f"match index {req.match_index} out of range (0..{len(matches) - 1})",
                    code="transcript_match_out_of_range",
                )
            m = matches[req.match_index]
            if m.timeline_start is None or m.timeline_end is None:
                raise CodedValueError(
                    f"transcript match for {req.query!r} falls in removed timeline material",
                    code="transcript_match_removed",
                )
            start = max(0.0, m.timeline_start - req.padding_sec)
            end = m.timeline_end + req.padding_sec
            if req.source in ("premix", "export"):
                return req.source, start, end
            if req.raw or req.source.startswith("track:"):
                return f"track:{m.track_id}", start, end
            return f"processed:{m.track_id}", start, end

        if req.end_sec <= req.start_sec:
            raise CodedValueError("end must be after start", code="range_end_before_start")
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
            media, ext_start, ext_end = timeline_range_to_source(
                self.project, tid, timeline_start, timeline_end
            )
            out = self._cache_path(
                f"raw_{tid}",
                timeline_start,
                timeline_end,
                media,
                extra="a0" if has_several_audio_streams(media) else "",
            )
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
        raise CodedValueError(
            f"unknown source {source!r}; use processed:<id>, track:<id>, premix, or export",
            code="play_source_unknown",
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
        fingerprint = stem_fingerprint(self.project, track_id, defaults=self._defaults)
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
        render_hash = track_render_hash(render_project, track_id, defaults=self._defaults)
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
                        rerender_preview(self.project, defaults=self._defaults)
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
            raise CodedFileNotFoundError(
                "premix.wav not found; run render-preview or pipeline first", code="no_mix"
            )
        return premix, busy

    def _invalidate_processed_cache(self, track_id: str) -> None:
        """Delete the track's stem, its hash and its play-cache extracts. Caller holds ``render_lock``."""
        import shutil

        stem = stem_path(self.project, track_id)
        stem.unlink(missing_ok=True)
        hash_path = stem_hash_path(self.project, track_id)
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
                raise unknown_track(track_id)
            out = publish_stem(
                render_project,
                track_id,
                lambda tmp: FFmpegEngine().render_dialogue_track(
                    render_project, track, tmp, self._defaults
                ),
                clear_invalidations=False,
                defaults=self._defaults,
            )
            # The transaction takes project_state_lock first, so the clear is serialized
            # with snapshots and pipeline step publishes.
            with self.ws.transaction() as project:
                if clear_invalidations_if_current(
                    project, render_project, track_id, defaults=self._defaults
                ):
                    self.ws.save()
        schedule_stem_waveforms(self.project, [track_id], defaults=self._defaults)
        return out

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
            raise unknown_track(track_id)
        if track.transcript_gate:
            return self._processed_audio(track_id, start, end, rerender=rerender)
        render_project = snapshot_project(self.project)
        render_track = render_project.track_by_id(track_id)
        assert render_track is not None
        render_track.transcript_gate = True
        render_track.transcript_gate_scope = None
        fingerprint = track_render_hash(render_project, track_id, defaults=self._defaults)
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

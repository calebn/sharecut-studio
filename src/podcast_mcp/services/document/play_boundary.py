"""Boundary audition: the issued-capability catalog and the trim and roll previews."""

from __future__ import annotations

import hashlib
import json
import math
import os
import secrets
import tempfile
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

from podcast_mcp.config.defaults import mix_peak_ceiling_db
from podcast_mcp.edits.cut_application import apply_trim
from podcast_mcp.edits.ripple import plan_trim
from podcast_mcp.edits.timeline_ops import roll_clip_join
from podcast_mcp.engines.ffmpeg import MIX_SEMANTICS_REV, FFmpegEngine
from podcast_mcp.engines.play_audit import (
    track_render_hash,
)
from podcast_mcp.engines.timeline_render import render_track_from_timeline
from podcast_mcp.models import CutIntent, EpisodeProject
from podcast_mcp.util.atomic_render import render_atomic
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.project_state import (
    render_lock,
    snapshot_project,
)
from podcast_mcp.util.tracks import unknown_track
from podcast_mcp.util.wav import open_wav

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
from .play_cache import _PlayCache
from .play_stems import _PLAY_RENDER_LOCK_TIMEOUT_SEC

_BOUNDARY_CATALOG_MAX = 128
_BOUNDARY_CATALOG_TTL_SEC = 10 * 60
_boundary_catalog_lock = threading.Lock()


@dataclass(frozen=True)
class _BoundaryAudioEntry:
    project_path: Path
    target: TrimBoundaryTarget | RollBoundaryTarget
    token: str
    current_path: Path
    proposed_path: Path
    expires_at: float


_boundary_catalog: OrderedDict[str, _BoundaryAudioEntry] = OrderedDict()


class _PlayBoundary(_PlayCache):
    @staticmethod
    def issued_boundary_project(opaque_id: str) -> Path:
        """Resolve an issued audition capability without accepting a client path."""
        with _boundary_catalog_lock:
            entry = _boundary_catalog.get(opaque_id)
            if entry is None or entry.expires_at < time.monotonic():
                _boundary_catalog.pop(opaque_id, None)
                raise FileNotFoundError("boundary audition expired; listen again")
            return entry.project_path

    def _boundary_window(
        self, project: EpisodeProject, track_id: str, seam_sec: float, pad_sec: float
    ) -> tuple[float, float]:
        track_clips = [c for c in project.clips if c.track_id == track_id]
        if not track_clips:
            raise CodedValueError(
                "boundary track has no clips to audition", code="boundary_track_empty"
            )
        track_end = max(c.timeline_end for c in track_clips)
        start = max(0.0, seam_sec - pad_sec)
        end = min(track_end, seam_sec + pad_sec)
        if end - start < 0.02:
            raise CodedValueError(
                "boundary has too little audio to audition", code="boundary_audio_too_short"
            )
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
            raise unknown_track(track_id)
        ceiling = mix_peak_ceiling_db(self._defaults)
        identity = {
            "project": str(self.ws.path.resolve()),
            "token": token,
            "state": state,
            "track": track_render_hash(project, track_id, defaults=self._defaults),
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
            raise CodedValueError(
                "pad_sec must be between 0.1 and 2 seconds", code="boundary_pad_out_of_range"
            )
        if isinstance(target, TrimBoundaryTarget):
            if not isinstance(edit, TrimBoundaryEdit) or (
                target.clip_id != edit.clip_id
                or target.edge != edit.edge
                or target.mode != edit.mode
            ):
                raise CodedValueError(
                    "edit does not match boundary target", code="boundary_edit_mismatch"
                )
        elif not isinstance(edit, RollBoundaryEdit) or (
            target.left_clip_id != edit.left_clip_id or target.right_clip_id != edit.right_clip_id
        ):
            raise CodedValueError(
                "edit does not match boundary target", code="boundary_edit_mismatch"
            )

        with self.ws.transaction() as saved:
            current_context = assert_boundary_token(
                saved, target, expected_token, defaults=self._defaults
            )
            current = snapshot_project(saved)
        proposed = current.model_copy(deep=True)
        if isinstance(edit, TrimBoundaryEdit):
            plan = plan_trim(proposed, edit.clip_id, edit.edge, edit.source_sec, edit.mode)
            if not plan.unchanged:
                apply_trim(
                    proposed,
                    plan,
                    application_intent=CutIntent.HUMAN_BOUNDARIES,
                    defaults=self._defaults,
                )
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
            roll_clip_join(
                proposed,
                edit.left_clip_id,
                edit.right_clip_id,
                edit.delta_sec,
                defaults=self._defaults,
            )
            left_after = next(c for c in proposed.clips if c.id == edit.left_clip_id)
            actual_edit = edit.model_copy(
                update={"delta_sec": left_after.source_end - left_before.source_end}
            )
        proposed_context = boundary_context(proposed, target, defaults=self._defaults)
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
            assert_boundary_token(saved, target, expected_token, defaults=self._defaults)
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
            with open_wav(path) as wav:
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
            raise CodedValueError("unknown boundary audition side", code="boundary_side_unknown")
        with _boundary_catalog_lock:
            entry = _boundary_catalog.get(opaque_id)
            if entry is None or entry.expires_at < time.monotonic():
                _boundary_catalog.pop(opaque_id, None)
                raise FileNotFoundError("boundary audition expired; listen again")
        if entry.project_path != self.ws.path.resolve() or entry.token != expected_token:
            raise FileNotFoundError("boundary audition is unavailable")
        with self.ws.transaction() as saved:
            assert_boundary_token(saved, entry.target, expected_token, defaults=self._defaults)
        path = entry.current_path if side == "current" else entry.proposed_path
        cache = (self.project.artifacts_dir() / "play_cache").resolve()
        if path.is_symlink() or path.parent.resolve() != cache or not path.is_file():
            raise FileNotFoundError("boundary audition expired; listen again")
        self._mark_play_cache_used(path)
        return path

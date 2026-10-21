"""Mix headroom: the trim that keeps a premix under the peak ceiling."""

from __future__ import annotations

import functools
import json
import logging
from pathlib import Path

from podcast_mcp.config.defaults import mix_peak_ceiling_db
from podcast_mcp.engines.ffmpeg import MIX_SEMANTICS_REV, FFmpegEngine
from podcast_mcp.engines.play_audit import (
    mix_gains,
    mix_render_hash,
    premix_is_stale,
    premix_path,
    read_premix_trim_db,
    stem_hash_matches,
    stem_is_fresh,
    track_render_hash,
)
from podcast_mcp.util.atomic_json import write_text_atomic
from podcast_mcp.util.hashing import short_digest
from podcast_mcp.util.project_state import (
    RENDER_LOCK_TIMEOUT_SEC,
    FileRevision,
    file_revision,
)
from podcast_mcp.util.tracks import stem_path

from .play_stems import _PlayStems

log = logging.getLogger(__name__)


@functools.lru_cache(maxsize=64)
def _stem_mix_trim_db(stems: tuple[tuple[Path, float, str], ...], ceiling_db: float) -> float:
    """Headroom trim of ``(stem, gain, stem hash)`` mixed at those gains.

    The stem hash (``track_render_hash``) keys the cache on the stem's content."""
    return FFmpegEngine().peak_trim_db([(path, gain) for path, gain, _hash in stems], ceiling_db)


def _read_mix_trim_record(path: Path) -> float | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))["trim_db"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not -120 <= value <= 0:
        return None
    return float(value)


def _stem_revisions(stems: tuple[tuple[Path, float, str], ...]) -> list[FileRevision] | None:
    try:
        return [file_revision(path) for path, _gain, _hash in stems]
    except OSError:
        return None


def _write_mix_trim_record(path: Path, trim_db: float) -> None:
    """Keep the newest few records: each is tiny, and an old mix never returns."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        write_text_atomic(path, json.dumps({"trim_db": trim_db}))
        stale = sorted(path.parent.glob("mix_trim_*.json"), key=lambda p: p.stat().st_mtime)[:-8]
        for old in stale:
            old.unlink(missing_ok=True)
    except OSError:
        log.debug("mix trim record not written to %s", path, exc_info=True)


class _PlayHeadroom(_PlayStems):
    def _mix_key(self) -> str:
        """What the mix plays: the mix hash, and each mixed track's stem hash."""
        gains = mix_gains(self.project)
        return json.dumps(
            {
                "mix": mix_render_hash(
                    gains, mix_peak_ceiling_db(self._defaults), defaults=self._defaults
                ),
                "stems": {
                    track_id: track_render_hash(self.project, track_id, defaults=self._defaults)
                    for track_id in gains
                },
            },
            sort_keys=True,
        )

    def mix_trim_db(self, *, lock_timeout: float = RENDER_LOCK_TIMEOUT_SEC) -> float:
        """The headroom trim ``premix.hash`` would record for the current mix, without mixing.

        A fresh premix already records it. Otherwise the trim is read from the on-disk record
        of an earlier measurement of the same stems, gains and ceiling. Only a mix never
        measured renders its stale stems and measures their true peak over the whole episode,
        a pass that scales with episode length; it is recorded for the next preview.

        ``lock_timeout`` bounds the render-lock wait of each stem render. The true-peak pass
        only reads the stems, which are replaced atomically, so it runs without the lock.
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
        ceiling = mix_peak_ceiling_db(self._defaults)
        record = self._mix_trim_record_path(gains, ceiling)
        cached = _read_mix_trim_record(record)
        if cached is not None:
            return cached
        for track_id in gains:
            if not stem_is_fresh(self.project, track_id, defaults=self._defaults):
                self.ensure_stem(track_id, lock_timeout=lock_timeout)
        stems = tuple(
            (
                stem_path(self.project, track_id),
                gain,
                track_render_hash(self.project, track_id, defaults=self._defaults),
            )
            for track_id, gain in gains.items()
        )
        before = _stem_revisions(stems)
        trim = _stem_mix_trim_db(stems, ceiling)
        steady = before is not None and _stem_revisions(stems) == before
        if steady and all(
            stem_hash_matches(self.project, track_id, stem_hash)
            for track_id, (_path, _gain, stem_hash) in zip(gains, stems, strict=True)
        ):
            _write_mix_trim_record(record, trim)
        else:
            # A stem replaced mid-pass (a render started meanwhile) leaves a mix of old and
            # new audio in the measurement, or the stems no longer match the key they were
            # read under: use it for this preview, but neither record nor memoize it.
            _stem_mix_trim_db.cache_clear()
        return trim

    def _mix_trim_record_path(self, gains: dict[str, float], ceiling: float) -> Path:
        key = json.dumps(
            {
                "ceiling": ceiling,
                "rev": MIX_SEMANTICS_REV,
                "stems": {
                    track_id: [
                        gain,
                        track_render_hash(self.project, track_id, defaults=self._defaults),
                    ]
                    for track_id, gain in gains.items()
                },
            },
            sort_keys=True,
        )
        return self.project.artifacts_dir() / "play_cache" / f"mix_trim_{short_digest(key)}.json"

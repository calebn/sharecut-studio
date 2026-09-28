from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from podcast_mcp.config import mix_peak_ceiling_db
from podcast_mcp.edits.clips_ops import clips_for_track
from podcast_mcp.edits.mute_regions import IgnoredWordRegions, mute_regions_payload
from podcast_mcp.engines.ffmpeg import MIX_SEMANTICS_REV
from podcast_mcp.engines.timeline_render import RENDER_SEMANTICS_REV
from podcast_mcp.models import AutomationEnvelope, EpisodeProject
from podcast_mcp.util.atomic_json import write_text_atomic
from podcast_mcp.util.atomic_render import render_atomic
from podcast_mcp.util.project_state import FileRevision, file_revision, project_state_lock
from podcast_mcp.util.tracks import dialogue_track_ids, mixed_dialogue_track_ids
from podcast_mcp.util.tracks import stem_path as track_stem_path

log = logging.getLogger(__name__)

# Stems are timeline-clock WAVs; tolerate encoder/container rounding.
STEM_DURATION_TOLERANCE_SEC = 0.25


def envelope_audio_payload(envelope: AutomationEnvelope | None) -> dict[str, Any] | None:
    """Describe audible envelope state without editorial point identities."""
    if envelope is None:
        return None
    return {
        "track_id": envelope.track_id,
        "parameter": envelope.parameter,
        "points": [{"time": point.time, "value": point.value} for point in envelope.points],
    }


def track_render_hash(project: EpisodeProject, track_id: str) -> str:
    """Fingerprint what a track's stem and segment renders bake in (edits, clips, FX).

    Includes ``RENDER_SEMANTICS_REV`` so stems and play segments rendered under
    older renderer rules are treated as stale after a semantics change.
    """
    track = project.track_by_id(track_id)
    chain = next((c for c in project.processing_chains if c.track_id == track_id), None)
    env = project.volume_envelope_for(track_id)
    edits = [
        {
            "id": e.id,
            "start": e.start,
            "end": e.end,
            "type": e.type.value,
            "applied": e.applied,
        }
        for e in project.edit_decisions
        if e.track_id == track_id and e.applied
    ]
    clips = []
    ignored_lookup = IgnoredWordRegions(project)
    for c in clips_for_track(project, track_id):
        clip_payload: dict[str, Any] = {
            "source_start": c.source_start,
            "source_end": c.source_end,
            "timeline_start": c.timeline_start,
            "fade_in_ms": c.fade_in_ms,
            "fade_out_ms": c.fade_out_ms,
            "join_in_mode": c.join_in_mode.value,
            "mute_regions": mute_regions_payload(c.mute_regions),
        }
        ignored_regions = mute_regions_payload(ignored_lookup.for_clip(c))
        if ignored_regions:
            clip_payload["ignored_words"] = ignored_regions
        clips.append(clip_payload)
    payload: dict[str, Any] = {
        "render_rev": RENDER_SEMANTICS_REV,
        "track_id": track_id,
        "gain_db": track.gain_db if track else 0.0,
        # Stems never bake the mix mute (the mix step skips muted tracks). The
        # key stays, always false, so stem hashes written before it stay valid.
        "muted": False,
        "transcript_gate": bool(track.transcript_gate) if track else False,
        "edits": edits,
        "clips": clips,
        "chain": chain.model_dump() if chain else None,
        "envelope": envelope_audio_payload(env),
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def dialogue_render_hashes(project: EpisodeProject) -> dict[str, str]:
    """``track_render_hash`` of every dialogue track (muted too), by id."""
    return {tid: track_render_hash(project, tid) for tid in dialogue_track_ids(project)}


def changed_render_hashes(before: Mapping[str, str], after: Mapping[str, str]) -> list[str]:
    """Track ids in ``after`` whose render hash differs from (or is missing in) ``before``."""
    return [tid for tid, h in after.items() if before.get(tid) != h]


def proxy_render_hash(project: EpisodeProject, track_id: str) -> str:
    """16-hex fingerprint of FX source-clock render inputs.

    Includes: source media identity (path name, size, mtime_ns),
    processing chain, transcript_gate + suppressed-word state.
    Excludes: clips, edit decisions, envelope, gain_db, muted.
    """
    from podcast_mcp.util.tracks import track_audio_path

    track = project.track_by_id(track_id)
    chain = next((c for c in project.processing_chains if c.track_id == track_id), None)
    media_identity: dict[str, Any] | None = None
    try:
        src = track_audio_path(project, track_id)
        if src.is_file():
            st = src.stat()
            media_identity = {
                "name": src.name,
                "size": st.st_size,
                "mtime_ns": st.st_mtime_ns,
            }
        else:
            media_identity = {"name": src.name, "size": None, "mtime_ns": None}
    except ValueError:
        media_identity = None
    tr = project.transcript_for_track(track_id)
    suppressed = (
        [
            {"i": i, "s": round(w.start, 4), "e": round(w.end, 4)}
            for i, w in enumerate(tr.words)
            if w.suppressed
        ]
        if tr
        else []
    )
    payload: dict[str, Any] = {
        "track_id": track_id,
        "media": media_identity,
        "transcript_gate": bool(track.transcript_gate) if track else False,
        "chain": chain.model_dump() if chain else None,
        "suppressed": suppressed,
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


PREMIX_NAME = "premix.wav"
PREMIX_HASH_NAME = "premix.hash"


def _read_hash(path: Path) -> str | None:
    """A render's hash sidecar, or None when it's missing or empty."""
    try:
        return path.read_text(encoding="utf-8").strip() or None
    except FileNotFoundError:
        return None


def _write_hash(path: Path, h: str) -> str:
    """Write a hash sidecar atomically, so a reader never sees half of it."""
    write_text_atomic(path, h + "\n")
    return h


def _clear_hash(path: Path) -> None:
    """Delete a hash sidecar, so the render beside it reads as stale."""
    path.unlink(missing_ok=True)


def stem_path(project: EpisodeProject, track_id: str) -> Path:
    return track_stem_path(project, track_id)


def stem_hash_path(project: EpisodeProject, track_id: str) -> Path:
    return project.artifacts_dir() / "tracks" / f"{track_id}.hash"


def read_stem_hash(project: EpisodeProject, track_id: str) -> str | None:
    return _read_hash(stem_hash_path(project, track_id))


def clear_stem_hash(project: EpisodeProject, track_id: str) -> None:
    _clear_hash(stem_hash_path(project, track_id))


def stem_revision(project: EpisodeProject, track_id: str) -> FileRevision | None:
    """The stem's file identity (replaced whole on every publish), or None when missing."""
    try:
        return file_revision(stem_path(project, track_id))
    except FileNotFoundError:
        return None


def publish_stem(
    project: EpisodeProject,
    track_id: str,
    render: Callable[[Path], object],
    *,
    clear_invalidations: bool = True,
) -> Path:
    """Render ``artifacts/tracks/<id>.wav`` from ``project`` and publish it with its hash (#356).

    ``project`` is the snapshot ``render`` reads; the hash is computed from the same one.
    Order: render into a unique sibling temp, drop the old hash, swap the WAV in, write
    the new hash. A hash on disk only ever names the bytes beside it, and a reader holding
    the old file keeps reading it whole. ``engines.history_stale.mark_history_move_stale``
    reads a sidecar without ``render_lock`` and relies on this order; do not reorder it.
    Callers hold ``render_lock`` (worker threads of a holder excepted); that is what keeps
    two publishes of one stem from interleaving.
    """
    render_atomic(
        stem_path(project, track_id),
        render,
        before_replace=lambda: clear_stem_hash(project, track_id),
        reap_partials=True,
    )
    write_stem_hash(project, track_id, clear_invalidations=clear_invalidations)
    return stem_path(project, track_id)


def write_stem_hash(
    project: EpisodeProject,
    track_id: str,
    *,
    clear_invalidations: bool = True,
) -> str:
    """Persist stem content hash; optionally clear diagnostic invalidations.

    When rendering stems in parallel, pass ``clear_invalidations=False`` and
    clear on the main thread after ``run_parallel`` so the cause journal is
    not mutated concurrently.
    """
    h = _write_hash(stem_hash_path(project, track_id), track_render_hash(project, track_id))
    if clear_invalidations:
        from podcast_mcp.engines.render_invalidations import (
            clear_invalidations_for_tracks,
        )

        clear_invalidations_for_tracks(project, [track_id])
    return h


def clear_invalidations_if_current(
    project: EpisodeProject,
    snapshot: EpisodeProject,
    track_id: str,
    *,
    current: EpisodeProject | None = None,
) -> bool:
    """Clear ``project``'s invalidations for ``track_id`` if a stem from ``snapshot`` is current.

    Current means ``track_render_hash`` of ``current`` (default ``project``) equals the
    snapshot's, so an edit made while the stem rendered keeps its cause journal. Returns
    whether the journal changed.
    """
    from podcast_mcp.engines.render_invalidations import clear_invalidations_for_tracks

    reference = current if current is not None else project
    if track_render_hash(reference, track_id) != track_render_hash(snapshot, track_id):
        return False
    before = [(inv.id, tuple(inv.track_ids)) for inv in project.render.invalidations]
    clear_invalidations_for_tracks(project, [track_id])
    return [(inv.id, tuple(inv.track_ids)) for inv in project.render.invalidations] != before


def expected_stem_duration_sec(project: EpisodeProject, track_id: str) -> float | None:
    """Timeline end of the last placed clip (stem length when assemble is correct)."""
    from podcast_mcp.engines.session_timeline import SessionTimeline

    extent = SessionTimeline(project).timeline_extent(track_id)
    if extent is None:
        return None
    return float(extent[0])


# One entry per probed file revision (a path, a 4-tuple and a float: well under 1 KB).
# 1024 holds the stems, premix and master of dozens of projects, so a busy project in a
# multi-project MCP or GUI process does not evict another's stem probes (#427).
WAV_DURATION_CACHE_SIZE = 1024


@lru_cache(maxsize=WAV_DURATION_CACHE_SIZE)
def _cached_wav_duration_sec(path: str, revision: FileRevision) -> float:
    """ffprobe ``path`` once per ``file_revision``; ``revision`` is only a cache key."""
    del revision  # cache key only
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    return float(FFmpegEngine().probe(Path(path)).duration_sec)


def probe_wav_duration_sec(path: Path) -> float | None:
    """Duration of the WAV at ``path`` in seconds, or None when missing or unreadable.

    Probes through ffprobe, so it reads any encoding a render writes. The header-only
    readers ``services.golden_ear._wav_duration_sec`` (stdlib ``wave``) and
    ``services.record.landing._wav_duration_s`` (PCM uploads it already validates)
    stay separate on purpose: they avoid a subprocess per file.

    Cached in-process per resolved path and ``file_revision`` (device, inode, size,
    mtime), so render status and freshness checks on an unchanged stem spawn no ffprobe
    (#427). Stems, premix and master are swapped in whole (``render_atomic``), so a
    publish always re-probes. Failures are not cached. Every caller (stems, premix,
    master, the ingest WAVs in ``conversation_align``, the gate temp in
    ``transcript_bleed_mute``) must write a new file or change its size or mtime: an
    in-place rewrite that keeps both (possible with coarse filesystem timestamps) is
    unsupported and keeps the old duration. ``_cached_wav_duration_sec.cache_clear()``
    drops every entry.
    """
    if not path.is_file():
        return None
    try:
        return _cached_wav_duration_sec(str(path.resolve()), file_revision(path))
    except Exception as exc:
        log.debug("probe failed for %s: %s", path, exc)
        return None


def probe_stem_duration_sec(project: EpisodeProject, track_id: str) -> float | None:
    return probe_wav_duration_sec(stem_path(project, track_id))


def _stem_duration_ok(
    project: EpisodeProject,
    track_id: str,
    expected: float | None,
    tolerance_sec: float = STEM_DURATION_TOLERANCE_SEC,
) -> bool:
    if expected is None:
        return True
    actual = probe_stem_duration_sec(project, track_id)
    return actual is not None and actual <= expected + tolerance_sec


def stem_duration_matches_timeline(
    project: EpisodeProject,
    track_id: str,
    *,
    tolerance_sec: float = STEM_DURATION_TOLERANCE_SEC,
) -> bool:
    """True when stem is not longer than the session timeline (wrong timebase).

    Applied edit decisions can shorten a stem before clips are rewritten, so a
    shorter stem is allowed. A stem *longer* than ``timeline_extent`` is the
    classic source-length / wrong-clock failure mode.
    """
    return _stem_duration_ok(
        project, track_id, expected_stem_duration_sec(project, track_id), tolerance_sec
    )


def stem_is_fresh(project: EpisodeProject, track_id: str) -> bool:
    """Hash matches current edit state and stem is not longer than timeline."""
    stem = stem_path(project, track_id)
    if not stem.is_file():
        return False
    stored = read_stem_hash(project, track_id)
    if stored != track_render_hash(project, track_id):
        return False
    return stem_duration_matches_timeline(project, track_id)


def stem_hash_matches(project: EpisodeProject, track_id: str, render_hash: str) -> bool:
    """The stem WAV exists and its hash sidecar names ``render_hash``."""
    return (
        stem_path(project, track_id).is_file() and read_stem_hash(project, track_id) == render_hash
    )


@dataclass(frozen=True)
class StemFingerprint:
    """What a track's stem must match to be fresh, read without copying the project (#358)."""

    render_hash: str
    expected_duration_sec: float | None


def stem_fingerprint(project: EpisodeProject, track_id: str) -> StemFingerprint:
    """``track_render_hash`` and the expected stem length, read together under the state lock.

    Costs what this track's clips, edits, FX and transcript words cost, not a deep copy
    of the project (transcripts of other tracks, history). A mutation cannot tear it.
    """
    with project_state_lock(project):
        return StemFingerprint(
            track_render_hash(project, track_id),
            expected_stem_duration_sec(project, track_id),
        )


def stem_matches(project: EpisodeProject, track_id: str, fingerprint: StemFingerprint) -> bool:
    """``stem_is_fresh`` against ``fingerprint`` instead of the live project.

    Reads only files: the stem, its hash sidecar, and its (cached) probed duration.
    """
    if not stem_hash_matches(project, track_id, fingerprint.render_hash):
        return False
    return _stem_duration_ok(project, track_id, fingerprint.expected_duration_sec)


def mix_gains(project: EpisodeProject) -> dict[str, float]:
    """The tracks the mix step mixes (media, not muted) and each one's output gain."""
    return {t.id: t.output_gain_db for t in project.tracks if t.media and not t.muted}


def mix_render_hash(gains: Mapping[str, float], peak_ceiling_db: float | None = None) -> str:
    """Fingerprint a mix: which tracks, at what output gain, in any order.

    Stem audio is covered by each stem's own hash and the premix-vs-stem mtime
    check. The mix step adds only this, so a volume or mute change stales the
    premix without staling any stem. Includes ``MIX_SEMANTICS_REV``, so premixes
    summed under older mix rules (1/N amix) re-mix once. Also includes the premix
    true-peak ceiling (None reads the configured default), so changing
    ``mix.premix_peak_ceiling_db`` re-mixes.
    """
    ceiling = mix_peak_ceiling_db() if peak_ceiling_db is None else float(peak_ceiling_db)
    payload = {
        "mix_rev": MIX_SEMANTICS_REV,
        "peak_ceiling_db": round(ceiling, 2),
        "gains": sorted((track_id, round(float(gain), 4)) for track_id, gain in gains.items()),
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def premix_path(project: EpisodeProject) -> Path:
    return project.artifacts_dir() / PREMIX_NAME


def premix_hash_path(project: EpisodeProject) -> Path:
    return project.artifacts_dir() / PREMIX_HASH_NAME


def _premix_sidecar(project: EpisodeProject) -> list[str]:
    """``premix.hash`` split into ``[mix hash, peak ceiling dBTP]`` (older files: hash only)."""
    raw = _read_hash(premix_hash_path(project))
    return raw.split() if raw else []


def read_premix_hash(project: EpisodeProject) -> str | None:
    parts = _premix_sidecar(project)
    return parts[0] if parts else None


def read_premix_ceiling_db(project: EpisodeProject) -> float | None:
    """The true-peak ceiling ``premix.wav`` was mixed under, or None when not recorded."""
    parts = _premix_sidecar(project)
    if len(parts) < 2:
        return None
    try:
        return float(parts[1])
    except ValueError:
        return None


def write_premix_hash(
    project: EpisodeProject, gains: Mapping[str, float], *, peak_ceiling_db: float | None = None
) -> str:
    """Record the mix ``premix.wav`` was just mixed from (``track id -> gain``).

    The sidecar holds the mix hash, then the peak ceiling it was mixed under, so a
    caller without the run's config can still judge the premix (``premix_stale_vs_mix``).
    """
    ceiling = mix_peak_ceiling_db() if peak_ceiling_db is None else float(peak_ceiling_db)
    h = mix_render_hash(gains, ceiling)
    write_text_atomic(premix_hash_path(project), f"{h}\n{round(ceiling, 2)}\n")
    return h


def clear_premix_hash(project: EpisodeProject) -> None:
    _clear_hash(premix_hash_path(project))


def premix_stale_vs_mix(project: EpisodeProject, defaults: Mapping[str, Any] | None = None) -> bool:
    """True when the saved mix settings changed since ``premix.wav`` was mixed.

    A premix mixed before this hash existed predates saved volumes, so it's
    stale once a fader moves off 0 dB. It also counts stale once a track is
    muted: older mixes skipped muted tracks too, but nothing records which,
    so a project with a hand-set mute re-mixes once. ``defaults`` is the pipeline config
    whose ``mix.premix_peak_ceiling_db`` the premix must match. With None (render status,
    review publish: no run config at hand) the ceiling recorded in ``premix.hash`` is used,
    falling back to ``load_defaults()`` for a hash without one, so a per-project ceiling
    override doesn't read as stale.
    """
    if not premix_path(project).is_file():
        return False
    stored = read_premix_hash(project)
    if stored is None:
        return any(t.fader_db or t.muted for t in project.tracks if t.media)
    if defaults is None:
        recorded = read_premix_ceiling_db(project)
        ceiling = mix_peak_ceiling_db() if recorded is None else recorded
    else:
        ceiling = mix_peak_ceiling_db(defaults)
    return stored != mix_render_hash(mix_gains(project), ceiling)


def _mtime(path: Path) -> float | None:
    """A file's mtime, or None when it's missing (or swapped out mid-check)."""
    try:
        return path.stat().st_mtime
    except FileNotFoundError:
        return None


def _stem_newer_than(project: EpisodeProject, track_id: str, premix_mtime: float) -> bool | None:
    """Whether a track's stem was rendered after the premix, or None when it's missing."""
    stem_mtime = _mtime(stem_path(project, track_id))
    if stem_mtime is None:
        return None
    return stem_mtime > premix_mtime


def premix_stale_vs_stems(project: EpisodeProject) -> bool:
    """True when a stem the mix plays was rendered after ``premix.wav``."""
    premix_mtime = _mtime(premix_path(project))
    if premix_mtime is None:
        return False
    return any(
        _stem_newer_than(project, tid, premix_mtime) for tid in mixed_dialogue_track_ids(project)
    )


def premix_is_stale(project: EpisodeProject, defaults: Mapping[str, Any] | None = None) -> bool:
    """True when ``premix.wav`` no longer matches what the mix would play now.

    Covers the saved mix (volume, mute), a stem rendered after the premix, and a
    rendered stem the mix plays that's behind its edits, clips or FX, in one pass
    over the mixed stems. A missing stem is unknown rather than stale, and no
    premix is not stale: callers check that it exists. ``defaults`` works as in
    ``premix_stale_vs_mix``.
    """
    premix_mtime = _mtime(premix_path(project))
    if premix_mtime is None:
        return False
    if premix_stale_vs_mix(project, defaults):
        return True
    for tid in mixed_dialogue_track_ids(project):
        newer = _stem_newer_than(project, tid, premix_mtime)
        if newer is None:
            continue  # a missing stem is unknown, not stale
        if newer or not stem_is_fresh(project, tid):
            return True
    return False


MASTERED_NAME = "mastered.wav"
MASTERED_HASH_NAME = "mastered.hash"


def mastered_path(project: EpisodeProject) -> Path:
    return project.artifacts_dir() / MASTERED_NAME


def mastered_hash_path(project: EpisodeProject) -> Path:
    return project.artifacts_dir() / MASTERED_HASH_NAME


def master_source_hash(project: EpisodeProject) -> str | None:
    """Fingerprint the premix a master is built from, or None with no premix.

    Every mix swaps ``premix.wav`` in whole, so its size and mtime move with
    each one; the mix hash adds which tracks it played and at what gain.
    """
    try:
        st = premix_path(project).stat()
    except FileNotFoundError:
        return None
    payload = {"mix": read_premix_hash(project), "size": st.st_size, "mtime_ns": st.st_mtime_ns}
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def read_mastered_hash(project: EpisodeProject) -> str | None:
    return _read_hash(mastered_hash_path(project))


def clear_mastered_hash(project: EpisodeProject) -> None:
    _clear_hash(mastered_hash_path(project))


def write_mastered_hash(project: EpisodeProject, source_hash: str | None) -> str | None:
    """Record the premix ``mastered.wav`` was mastered from.

    ``source_hash`` is ``master_source_hash`` captured before mastering. If the
    premix changed since (a Refresh while loudnorm ran), nothing is recorded, so
    the master stays stale instead of vouching for a premix it never read.
    """
    if source_hash is None or master_source_hash(project) != source_hash:
        clear_mastered_hash(project)
        return None
    return _write_hash(mastered_hash_path(project), source_hash)


def mastered_is_fresh(project: EpisodeProject) -> bool:
    """True when ``mastered.wav`` was mastered from the current ``premix.wav``.

    A master with no hash (mastered before it existed, or whose last master
    failed) is stale: export re-masters it, and publishing refuses it until then
    while ``premix.wav`` exists (with no premix, publish ships ``mastered.wav``).
    """
    if not mastered_path(project).is_file():
        return False
    stored = read_mastered_hash(project)
    return stored is not None and stored == master_source_hash(project)

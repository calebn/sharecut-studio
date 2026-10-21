"""Request and result types and the helpers every play module shares (see :mod:`.play`)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from podcast_mcp.models import Track
from podcast_mcp.util.fingerprint import mtime_ns_if_file


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
    return ":".join(f"{path}:{mtime_ns_if_file(path)}:{gain}" for path, gain in inputs)

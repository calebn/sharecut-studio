"""Lightweight range / stem bounce to ``export/bounces/`` (no master QC)."""

from __future__ import annotations

import shutil
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from podcast_mcp.config import load_defaults, mix_peak_ceiling_db
from podcast_mcp.edits.range_edits import resolve_range
from podcast_mcp.engines.timeline_render import timeline_duration_sec
from podcast_mcp.export.audio import specs_from_extensions, write_audio_formats
from podcast_mcp.export.names import sanitize_export_stem
from podcast_mcp.models import Track, TrackRole
from podcast_mcp.models.episode import ExactRangeTarget
from podcast_mcp.pipeline.helpers import ffmpeg
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.media.range_audio import append_range_gap
from podcast_mcp.util.parallel import run_parallel
from podcast_mcp.util.progress import raise_if_cancel_requested, resolve_progress_task
from podcast_mcp.util.project_state import snapshot_project

BOUNCE_CANCELLED = "Bounce cancelled"


@dataclass(frozen=True)
class BounceRequest:
    """Shared bounce params for GUI, CLI, and MCP."""

    track_ids: list[str] | None = None
    start_s: float | None = None
    end_s: float | None = None
    formats: list[str] | None = None
    exact_range: ExactRangeTarget | None = None


_BOUNCEABLE_ROLES = (
    TrackRole.DIALOGUE,
    TrackRole.MUSIC,
    TrackRole.INTRO,
    TrackRole.OUTRO,
    TrackRole.SFX,
)


def _slug(parts: list[str]) -> str:
    raw = "_".join(p for p in parts if p)
    return sanitize_export_stem(raw, fallback="bounce", replacement="-", ascii_only=True)


def _bounceable_tracks(project, wanted: set[str] | None) -> list[Track]:
    tracks: list[Track] = []
    for track in project.tracks:
        if wanted is not None and track.id not in wanted:
            continue
        if wanted is None and track.muted:
            continue
        if track.role not in _BOUNCEABLE_ROLES or not track.media:
            continue
        tracks.append(track)
    return tracks


def _render_private_stems(
    project,
    tracks: list[Track],
    stem_dir: Path,
    *,
    defaults: dict,
    eng,
    on_stem: Callable[[str, int, int], None] | None = None,
) -> list[tuple[Path, float]]:
    """Render bounce stems into ``stem_dir`` — never touch shared ``artifacts/tracks/``.

    Deliberately not ``publish_stem`` / ``render_lock``: these stems are private to this
    bounce (no ``.hash``, no other reader or writer), so the #356/#482 publish rules for
    the shared stem cache do not apply. Never point ``stem_dir`` at ``artifacts/tracks``.
    """
    stem_dir.mkdir(parents=True, exist_ok=True)

    def render_one(track: Track) -> tuple[str, Path, float]:
        out = stem_dir / f"{track.id}.wav"
        eng.render_dialogue_track(project, track, out, defaults)
        return track.id, out, float(track.output_gain_db)

    max_workers = defaults.get("performance", {}).get("max_workers")
    rendered: dict[str, tuple[Path, float]] = {}
    n = len(tracks)
    for done, (tid, path, gain) in enumerate(
        run_parallel(tracks, render_one, max_workers=max_workers),
        start=1,
    ):
        rendered[tid] = (path, gain)
        if on_stem is not None:
            on_stem(tid, done, n)
    return [rendered[t.id] for t in tracks if t.id in rendered]


class BounceService:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.ws = workspace

    def validate(self, req: BounceRequest | None = None) -> list[Track]:
        """Raise ``ValueError`` when the request cannot bounce; return tracks."""
        req = req or BounceRequest()
        project = self.ws.project
        if req.start_s is not None and req.end_s is not None and req.end_s <= req.start_s:
            raise ValueError("end_s must be greater than start_s")

        if req.exact_range is not None:
            if req.track_ids is not None or req.start_s is not None or req.end_s is not None:
                raise ValueError("Exact range cannot be combined with track_ids or start/end")
            resolve_range(project, req.exact_range)
        ids = req.exact_range.track_ids if req.exact_range is not None else req.track_ids
        wanted = set(ids) if ids is not None else None
        if wanted is not None:
            unknown = wanted - {t.id for t in project.tracks}
            if unknown:
                raise ValueError(f"unknown track_ids: {sorted(unknown)}")

        tracks = _bounceable_tracks(project, wanted)
        if not tracks:
            raise ValueError("no bounceable tracks (missing media or empty selection)")
        return tracks

    def bounce(
        self,
        req: BounceRequest | None = None,
        *,
        cancel_check: Callable[[], bool] | None = None,
    ) -> list[Path]:
        req = req or BounceRequest()
        with self.ws.transaction():
            tracks = self.validate(req)
            project = snapshot_project(self.ws.project)
        tracks = [t for t in project.tracks if t.id in {track.id for track in tracks}]

        raise_if_cancel_requested(cancel_check, BOUNCE_CANCELLED)

        out_dir = project.export_dir() / "bounces"
        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        stem_label = _slug(
            [
                project.name,
                "bounce",
                "-".join(t.id for t in tracks[:4]),
                stamp,
            ]
        )
        stem_dir = out_dir / f".{stem_label}.stems"
        mixed = out_dir / f".{stem_label}.mix.wav"
        trimmed: Path | None = None

        defaults = load_defaults()
        eng = ffmpeg()
        formats = list(req.formats or ["wav"])
        with resolve_progress_task(
            "bounce",
            "Bouncing stems",
            total=max(1, len(tracks) + 2 + len(formats)),
            prefer_parent=True,
        ) as prog:
            try:
                prog.set_phase("render_stems", f"Rendering {len(tracks)} stems…")
                mix_inputs = _render_private_stems(
                    project,
                    tracks,
                    stem_dir,
                    defaults=defaults,
                    eng=eng,
                    on_stem=lambda tid, done, n: prog.advance(
                        1, message=f"Stem {tid} ({done}/{n})"
                    ),
                )
                if not mix_inputs:
                    raise ValueError("no bounceable tracks (missing media or empty selection)")
                raise_if_cancel_requested(cancel_check, BOUNCE_CANCELLED)

                prog.set_phase("mix", "Mixing bounce…")
                eng.mix_tracks(mix_inputs, mixed, peak_ceiling_db=mix_peak_ceiling_db(defaults))
                prog.advance(1, message="Mix ready")
                raise_if_cancel_requested(cancel_check, BOUNCE_CANCELLED)
                source = mixed
                if req.exact_range is not None:
                    prog.set_phase("trim", "Preparing selected intervals…")
                    parts: list[Path] = []
                    for index, interval in enumerate(req.exact_range.intervals):
                        raise_if_cancel_requested(cancel_check, BOUNCE_CANCELLED)
                        append_range_gap(eng, parts, stem_dir, index, req.exact_range.intervals)
                        part = stem_dir / f"range-{index}.wav"
                        eng.extract_segment(mixed, part, interval.start, interval.end)
                        parts.append(part)
                    trimmed = out_dir / f".{stem_label}.trim.wav"
                    eng.join_audio_parts(parts, trimmed)
                    source = trimmed
                else:
                    start = float(req.start_s) if req.start_s is not None else 0.0
                    mixed_dur = float(eng.probe(mixed).duration_sec)
                    if req.end_s is not None:
                        end = float(req.end_s)
                    else:
                        extent = float(timeline_duration_sec(project) or 0.0)
                        end = min(extent, mixed_dur) if extent > 0 else mixed_dur
                    needs_trim = start > 1e-3 or end < mixed_dur - 1e-3
                    if needs_trim:
                        if end <= start:
                            raise ValueError("end_s must be greater than start_s")
                        prog.set_phase("trim", "Trimming bounce range…")
                        trimmed = out_dir / f".{stem_label}.trim.wav"
                        eng.extract_segment(mixed, trimmed, start, end)
                        source = trimmed
                prog.advance(1, message="Range ready")
                raise_if_cancel_requested(cancel_check, BOUNCE_CANCELLED)

                prog.set_phase("encode", f"Writing {', '.join(formats)}…")
                written = write_audio_formats(
                    eng,
                    source,
                    out_dir / stem_label,
                    specs_from_extensions(req.formats),
                    metadata={"title": f"{project.name} bounce", "album": project.name},
                )
                prog.advance(len(formats), message="Bounce complete")
                return written
            finally:
                mixed.unlink(missing_ok=True)
                if trimmed is not None:
                    trimmed.unlink(missing_ok=True)
                shutil.rmtree(stem_dir, ignore_errors=True)

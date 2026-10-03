from __future__ import annotations

from pathlib import Path

from podcast_mcp.edits.range_edits import resolve_range
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.models import EpisodeProject
from podcast_mcp.models.episode import ExactRangeTarget, RangeInterval


def append_range_gap(
    engine: FFmpegEngine,
    parts: list[Path],
    directory: Path,
    index: int,
    intervals: list[RangeInterval],
) -> None:
    if index == 0:
        return
    gap = intervals[index].start - intervals[index - 1].end
    if gap > 0:
        silence = directory / f"gap-{index}.wav"
        audio = engine.probe(parts[-1])
        engine.silence(silence, gap, sample_rate=audio.sample_rate, channels=audio.channels)
        parts.append(silence)


def render_range_audio(
    project: EpisodeProject,
    target: ExactRangeTarget,
    output_path: Path,
    *,
    full_mix_path: Path | None = None,
) -> Path:
    from tempfile import TemporaryDirectory

    from podcast_mcp.config import load_defaults, mix_peak_ceiling_db
    from podcast_mcp.engines.timeline_render import render_track_segment

    target = resolve_range(project, target)
    defaults = load_defaults()
    engine = FFmpegEngine()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=output_path.parent) as directory:
        islands: list[Path] = []
        for index, interval in enumerate(target.intervals):
            append_range_gap(engine, islands, Path(directory), index, target.intervals)
            island = Path(directory) / f"island-{index}.wav"
            if full_mix_path is not None:
                engine.extract_segment(full_mix_path, island, interval.start, interval.end)
            else:
                stems = []
                for tid in target.track_ids:
                    track = project.track_by_id(tid)
                    if track is None or track.media is None:
                        continue
                    stem = Path(directory) / f"{index}-{tid}.wav"
                    render_track_segment(project, tid, interval.start, interval.end, stem, defaults)
                    stems.append((stem, track.fader_db))
                if stems:
                    engine.mix_tracks(stems, island, peak_ceiling_db=mix_peak_ceiling_db(defaults))
                else:
                    engine.silence(island, interval.end - interval.start)
            islands.append(island)
        engine.join_audio_parts(islands, output_path)
    return output_path

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.engines.ffmpeg import ENCODE_CANCELLED, FFmpegEngine
from podcast_mcp.export.audio import (
    ExportFormatSpec,
    export_wav_enabled,
    render_audio_formats,
    resolve_export_formats,
)
from podcast_mcp.export.names import sanitize_export_stem
from podcast_mcp.export.transcript import (
    combined_transcript_markdown,
    resolve_caption_limits,
    utterances_to_srt,
)
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.atomic_render import render_atomic_all
from podcast_mcp.util.progress import raise_if_cancel_requested


def export_episode_deliverables(
    project: EpisodeProject,
    eng: FFmpegEngine,
    source_wav: Path,
    defaults: EffectiveConfig,
    *,
    cancel_check: Callable[[], bool] | None = None,
) -> list[Path]:
    """Publish episode audio and edited transcripts after all files are prepared.

    Callers hold render_lock. Preparation failure or cancellation before publication
    preserves previous outputs. Final replacements are not a cross-file transaction.
    """
    export_cfg = defaults.get("export", {})
    stem = project.export_dir() / sanitize_export_stem(project.name)
    specs = [ExportFormatSpec(ext="wav")] if export_wav_enabled(export_cfg) else []
    specs.extend(resolve_export_formats(export_cfg))
    transcripts: dict[Path, str] = {}
    if project.transcripts or project.combined_transcript:
        limits = resolve_caption_limits(export_cfg)
        transcripts[stem.with_name(f"{stem.name}.md")] = combined_transcript_markdown(
            project, defaults
        )
        transcripts[stem.with_name(f"{stem.name}.srt")] = utterances_to_srt(project, limits=limits)
    destinations = [stem.with_suffix(f".{spec.ext}") for spec in specs] + list(transcripts)

    def render(temps: list[Path]) -> None:
        render_audio_formats(
            eng,
            source_wav,
            list(zip(specs, temps[: len(specs)], strict=True)),
            metadata={"title": project.name, "album": project.name},
            max_workers=defaults.get("performance", {}).get("max_workers"),
            cancel_check=cancel_check,
        )
        for output, content in zip(temps[len(specs) :], transcripts.values(), strict=True):
            output.write_text(content, encoding="utf-8")

    return render_atomic_all(
        destinations,
        render,
        before_publish=lambda: raise_if_cancel_requested(cancel_check, ENCODE_CANCELLED),
        reap_partials=True,
    )

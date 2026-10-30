from __future__ import annotations

from collections.abc import Callable
from contextlib import suppress
from pathlib import Path

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.engines.ffmpeg import ENCODE_CANCELLED, FFmpegEngine
from podcast_mcp.export.audio import (
    ExportFormatSpec,
    export_wav_enabled,
    render_audio_formats,
    resolve_export_formats,
)
from podcast_mcp.export.chapters import render_chapters_json
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
    persist_project: Callable[[], object] | None = None,
) -> list[Path]:
    """Publish episode audio, edited transcripts and chapters after all files are prepared.

    A project without chapters has its previous ``.chapters.json`` removed after the new
    set is published. A crash or a locked file in between leaves the previous list behind.

    The podcast feed file (``<stem>.feed.xml``) is refreshed last when the listing has no
    blocker; a failure there never fails the export (``feed.writer.write_after_export``).
    ``persist_project`` saves the project before the feed file is published, so the guid and
    number the feed carries are never lost.

    Callers hold render_lock. Preparation failure or cancellation before publication
    preserves previous outputs. Final replacements are not a cross-file transaction.
    """
    export_cfg = defaults.get("export", {})
    stem = project.export_dir() / sanitize_export_stem(project.name)
    specs = [ExportFormatSpec(ext="wav")] if export_wav_enabled(export_cfg) else []
    specs.extend(resolve_export_formats(export_cfg))
    sidecars: dict[Path, str] = {}
    if project.transcripts or project.combined_transcript:
        limits = resolve_caption_limits(export_cfg)
        sidecars[stem.with_name(f"{stem.name}.md")] = combined_transcript_markdown(
            project, defaults
        )
        sidecars[stem.with_name(f"{stem.name}.srt")] = utterances_to_srt(project, limits=limits)
    chapters_path = stem.with_name(f"{stem.name}.chapters.json")
    if project.chapters:
        sidecars[chapters_path] = render_chapters_json(project.chapters)
    destinations = [stem.with_suffix(f".{spec.ext}") for spec in specs] + list(sidecars)

    def render(temps: list[Path]) -> None:
        render_audio_formats(
            eng,
            source_wav,
            list(zip(specs, temps[: len(specs)], strict=True)),
            metadata={"title": project.name, "album": project.name},
            max_workers=defaults.get("performance", {}).get("max_workers"),
            cancel_check=cancel_check,
        )
        for output, content in zip(temps[len(specs) :], sidecars.values(), strict=True):
            output.write_text(content, encoding="utf-8")

    written = render_atomic_all(
        destinations,
        render,
        before_publish=lambda: raise_if_cancel_requested(cancel_check, ENCODE_CANCELLED),
        reap_partials=True,
    )
    if chapters_path not in sidecars:
        with suppress(OSError):
            chapters_path.unlink(missing_ok=True)
    # The feed file follows the audio it names. Imported here: the feed reads export names.
    from podcast_mcp.feed.writer import write_after_export

    write_after_export(project, persist=persist_project)
    return written

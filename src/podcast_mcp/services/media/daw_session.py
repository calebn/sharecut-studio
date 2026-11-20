"""Read-only saved project export with atomic publication of the portable media."""

from __future__ import annotations

from pathlib import Path
from shutil import copyfileobj

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.export.daw_timeline import DawMedia, build_daw_timeline
from podcast_mcp.export.reaper_project import reaper_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.atomic_file import atomic_write, publish_completed_file
from podcast_mcp.util.atomic_json import write_text_atomic
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.owned_stage import OwnedStage
from podcast_mcp.util.pinned_media import open_pinned_media
from podcast_mcp.util.wav import rendered_wav_is_complete


def _package_media(asset: DawMedia, destination: Path, engine: FFmpegEngine) -> None:
    staged_source = destination.with_suffix(".source")
    with open_pinned_media(asset.path) as source:
        atomic_write(staged_source, lambda output: copyfileobj(source, output))
    packaged = staged_source
    if not rendered_wav_is_complete(staged_source):
        packaged = destination.with_suffix(".converted.wav")
        engine.export_audio(
            staged_source,
            packaged,
            codec="pcm_f32le",
            format="wav",
            extra_args=["-map", "0:a:0", "-map_metadata", "-1", "-rf64", "auto"],
        )
        staged_source.unlink()
    if not rendered_wav_is_complete(packaged):
        raise CodedValueError(
            f"Incomplete WAV media for {asset.path.name}.", code="daw_export_incomplete_wav"
        )
    probe = engine.probe(packaged)
    if (
        probe.sample_rate != asset.sample_rate
        or probe.channels != asset.channels
        or round(probe.require_duration_sec() * probe.sample_rate) != asset.frames
    ):
        raise CodedValueError(
            f"WAV media changed while exporting {asset.path.name}.", code="daw_export_media_changed"
        )
    publish_completed_file(packaged, destination)


def export_reaper_session(project_path: Path, destination: Path) -> Path:
    """Export into a new directory and return its editable session file."""
    workspace = ProjectWorkspace.open(project_path, adopt=False)
    timeline = build_daw_timeline(workspace.project)
    if not timeline.media:
        raise CodedValueError("The saved episode has no audio to export.", code="daw_export_empty")
    session = reaper_project(timeline)
    target = destination.expanduser().absolute()
    name = target.name
    if name in {"", ".", ".."}:
        raise CodedValueError(
            "Choose a new directory for the REAPER session.", code="daw_export_bad_destination"
        )
    stage = OwnedStage(target.parent.resolve(strict=True))
    try:
        (stage.path / "media").mkdir()
        engine = FFmpegEngine()
        for asset in timeline.media:
            _package_media(asset, stage.path / asset.package_name, engine)
        write_text_atomic(stage.path / "session.rpp", session)
        stage.publish(name)
    finally:
        stage.close()
    return stage.root / name / "session.rpp"

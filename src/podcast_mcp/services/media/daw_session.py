"""Read-only saved project export with atomic publication of the portable media."""

from __future__ import annotations

import wave
from collections.abc import Callable
from contextlib import ExitStack
from fractions import Fraction
from pathlib import Path
from shutil import copyfileobj
from tempfile import TemporaryDirectory
from typing import IO
from zipfile import ZipFile

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.export.aaf_project import AAF_SESSION_NAME, require_aaf_writer, write_aaf
from podcast_mcp.export.audition_project import AUDITION_SESSION_NAME, audition_project
from podcast_mcp.export.daw_format import DawFormat
from podcast_mcp.export.daw_timeline import DawMedia, DawTimeline, build_daw_timeline
from podcast_mcp.export.reaper_project import reaper_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.atomic_file import atomic_write, publish_completed_file
from podcast_mcp.util.atomic_json import write_text_atomic
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.owned_stage import OwnedStage, owned_stage_supported
from podcast_mcp.util.pinned_media import open_pinned_media
from podcast_mcp.util.progress import CancelledProgress, resolve_progress_task
from podcast_mcp.util.wav import open_wav, rendered_wav_is_complete

SessionWriter = Callable[[DawTimeline, Path], None]
MAX_AAF_WAV_BYTES = 0xFFFFFFFF


def _package_media(
    asset: DawMedia,
    destination: Path,
    engine: FFmpegEngine,
    *,
    sample_rate: int | None = None,
) -> None:
    target_rate = sample_rate or asset.sample_rate
    expected_frames = round(Fraction(asset.frames * target_rate, asset.sample_rate))
    staged_source = destination.with_suffix(".source")
    with open_pinned_media(asset.path) as source:
        atomic_write(staged_source, lambda output: copyfileobj(source, output))
    packaged = staged_source
    if target_rate != asset.sample_rate or not rendered_wav_is_complete(staged_source):
        packaged = destination.with_suffix(".converted.wav")
        extra_args = ["-map", "0:a:0", "-map_metadata", "-1", "-rf64", "auto"]
        if target_rate != asset.sample_rate:
            extra_args.extend(
                ["-af", f"aresample={target_rate},atrim=end_sample={expected_frames}"]
            )
        engine.export_audio(
            staged_source,
            packaged,
            codec="pcm_f32le",
            format="wav",
            sample_rate=target_rate if target_rate != asset.sample_rate else None,
            channels=asset.channels,
            extra_args=extra_args,
        )
        staged_source.unlink()
    if not rendered_wav_is_complete(packaged):
        raise CodedValueError(
            f"Incomplete WAV media for {asset.path.name}.", code="daw_export_incomplete_wav"
        )
    probe = engine.probe(packaged)
    if (
        probe.sample_rate != target_rate
        or probe.channels != asset.channels
        or round(probe.require_duration_sec() * probe.sample_rate) != expected_frames
    ):
        raise CodedValueError(
            f"WAV media changed while exporting {asset.path.name}.", code="daw_export_media_changed"
        )
    publish_completed_file(packaged, destination)


def _write_reaper_session(timeline: DawTimeline, stage_root: Path) -> None:
    (stage_root / "media").mkdir()
    engine = FFmpegEngine()
    for asset in timeline.media:
        _package_media(asset, stage_root / asset.package_name, engine)
    write_text_atomic(stage_root / "session.rpp", reaper_project(timeline))


def _write_aaf_session(timeline: DawTimeline, stage_root: Path) -> None:
    require_aaf_writer()
    engine = FFmpegEngine()
    with TemporaryDirectory(prefix=".aaf-media-", dir=stage_root) as media_root_text:
        media_root = Path(media_root_text)
        media_paths = {
            asset.package_name: _prepare_aaf_media(asset, media_root, engine)
            for asset in timeline.media
        }
        write_aaf(timeline, media_paths, stage_root / AAF_SESSION_NAME)


def _write_audition_session(timeline: DawTimeline, stage_root: Path) -> None:
    session = audition_project(timeline)
    (stage_root / "media").mkdir()
    engine = FFmpegEngine()
    for asset in timeline.media:
        _package_media(
            asset,
            stage_root / asset.package_name,
            engine,
            sample_rate=session.sample_rate,
        )
    session.write(stage_root / AUDITION_SESSION_NAME)


def _valid_aaf_pcm(path: Path, asset: DawMedia) -> bool:
    try:
        if path.stat().st_size > MAX_AAF_WAV_BYTES or not rendered_wav_is_complete(path):
            return False
        with open_wav(path) as audio:
            return (
                audio.getcomptype() == "NONE"
                and audio.getsampwidth() in (2, 3)
                and audio.getnchannels() == asset.channels
                and audio.getframerate() == asset.sample_rate
                and audio.getnframes() == asset.frames
            )
    except (EOFError, OSError, ValueError, wave.Error):
        return False


def _oversized_aaf_wav(path: Path) -> bool:
    if path.stat().st_size <= MAX_AAF_WAV_BYTES:
        return False
    try:
        with path.open("rb") as source:
            header = source.read(12)
        return header[:4] in (b"RIFF", b"RF64") and header[8:12] == b"WAVE"
    except OSError:
        return False


def _prepare_aaf_media(asset: DawMedia, media_root: Path, engine: FFmpegEngine) -> Path:
    stem = Path(asset.package_name).stem
    staged_source = media_root / f"{stem}.source.wav"
    prepared = media_root / f"{stem}.wav"
    with open_pinned_media(asset.path) as source:
        atomic_write(staged_source, lambda output: copyfileobj(source, output))
    if _oversized_aaf_wav(staged_source):
        raise CodedValueError(
            f"{asset.path.name} is too large for the AAF writer's WAV limit.",
            code="aaf_export_pcm_too_large",
        )
    if _valid_aaf_pcm(staged_source, asset):
        staged_source.replace(prepared)
    else:
        engine.export_audio(
            staged_source,
            prepared,
            codec="pcm_s24le",
            format="wav",
            sample_rate=asset.sample_rate,
            channels=asset.channels,
            extra_args=["-map", "0:a:0", "-map_metadata", "-1"],
        )
        staged_source.unlink()
    if prepared.stat().st_size > MAX_AAF_WAV_BYTES:
        raise CodedValueError(
            f"{asset.path.name} is too large for the AAF writer's WAV limit.",
            code="aaf_export_pcm_too_large",
        )
    if not _valid_aaf_pcm(prepared, asset):
        prepared.unlink(missing_ok=True)
        raise CodedValueError(
            f"Could not prepare {asset.path.name} as supported AAF PCM.",
            code="aaf_export_pcm_unsupported",
        )
    return prepared


_SESSION_WRITERS: dict[DawFormat, tuple[str, SessionWriter]] = {
    DawFormat.RPP: ("session.rpp", _write_reaper_session),
    DawFormat.AAF: (AAF_SESSION_NAME, _write_aaf_session),
    DawFormat.SESX: (AUDITION_SESSION_NAME, _write_audition_session),
}


def _saved_timeline(workspace: ProjectWorkspace) -> DawTimeline:
    timeline = build_daw_timeline(workspace.project)
    if not timeline.media:
        raise CodedValueError("The saved episode has no audio to export.", code="daw_export_empty")
    return timeline


def _export_session(
    project_path: Path,
    destination: Path,
    format: DawFormat,
) -> Path:
    """Open a saved project once and publish one writer-owned package atomically."""
    timeline = _saved_timeline(ProjectWorkspace.open(project_path, adopt=False))
    target = destination.expanduser().absolute()
    name = target.name
    if name in {"", ".", ".."}:
        raise CodedValueError(
            "Choose a new directory for the export.", code="daw_export_bad_destination"
        )
    stage = OwnedStage(target.parent.resolve(strict=True))
    try:
        session_name, writer = _SESSION_WRITERS[format]
        writer(timeline, stage.path)
        session = stage.path / session_name
        if not session.is_file():
            raise CodedValueError(
                "The session writer did not produce its expected file.",
                code="daw_export_session_missing",
            )
        stage.publish(name)
    finally:
        stage.close()
    return stage.root / name / session_name


def export_reaper_session(project_path: Path, destination: Path) -> Path:
    """Export into a new directory and return its editable session file."""
    return _export_session(project_path, destination, DawFormat.RPP)


def export_aaf_session(project_path: Path, destination: Path) -> Path:
    """Export a self-contained experimental AAF into a new directory."""
    return _export_session(project_path, destination, DawFormat.AAF)


def export_audition_session(project_path: Path, destination: Path) -> Path:
    """Export an experimental SESX session and its portable WAV media."""
    return _export_session(project_path, destination, DawFormat.SESX)


def daw_format_blocker(format: DawFormat) -> str | None:
    if not owned_stage_supported():
        return "This computer cannot create editable DAW packages."
    if format is DawFormat.AAF:
        try:
            require_aaf_writer()
        except CodedValueError:
            return "This installation does not include the optional AAF writer."
    return None


def export_daw_archive(
    project_path: Path, format: DawFormat, job_id: str, cancel_check: Callable[[], bool]
) -> str:
    """Publish a new package per job, containing only the writer's named outputs."""

    def check_cancelled() -> None:
        if cancel_check():
            raise CancelledProgress("DAW export cancelled")

    check_cancelled()
    workspace = ProjectWorkspace.open(project_path, adopt=False)
    timeline = _saved_timeline(workspace)
    root = workspace.project.export_dir()
    root.mkdir(parents=True, exist_ok=True)
    directory = f"daw-{job_id}"
    name, writer = _SESSION_WRITERS[format]
    members = [name]
    if format != DawFormat.AAF:
        members.extend(asset.package_name for asset in timeline.media)

    with (
        ExitStack() as stages,
        resolve_progress_task(
            "daw_export", "Preparing session audio", total=len(members) + 2
        ) as progress,
    ):
        progress.set_phase("media", "Preparing session audio")
        media = OwnedStage(root)
        stages.callback(media.close)
        writer(timeline, media.path)
        progress.advance(message="Session audio ready")
        progress.set_phase("archive", "Packing the session and audio")
        package = OwnedStage(root)
        stages.callback(package.close)

        def zip_session(output: IO[bytes]) -> None:
            with ZipFile(output, "w") as archive:
                for member in members:
                    check_cancelled()
                    with (
                        open_pinned_media(media.path / member) as source,
                        archive.open(member, "w", force_zip64=True) as target,
                    ):
                        while chunk := source.read(1024 * 1024):
                            check_cancelled()
                            target.write(chunk)
                            progress.advance(0)
                    progress.advance(message=f"Packed {member}")

        atomic_write(package.path / format.archive_name, zip_session)
        check_cancelled()
        progress.set_phase("publish", "Saving the session package")
        package.publish(directory)
        progress.advance(message="DAW session exported")
    return f"{directory}/{format.archive_name}"

"""Read-only saved project export with atomic publication of the portable media."""

from __future__ import annotations

import struct
from collections.abc import Callable
from pathlib import Path
from shutil import copyfileobj
from tempfile import TemporaryDirectory

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.export.aaf_project import AAF_SESSION_NAME, require_aaf_writer, write_aaf
from podcast_mcp.export.daw_timeline import DawMedia, DawTimeline, build_daw_timeline
from podcast_mcp.export.reaper_project import reaper_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.atomic_file import atomic_write, publish_completed_file
from podcast_mcp.util.atomic_json import write_text_atomic
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.owned_stage import OwnedStage
from podcast_mcp.util.pinned_media import open_pinned_media
from podcast_mcp.util.wav import rendered_wav_is_complete

SessionWriter = Callable[[DawTimeline, Path], None]


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


def _valid_aaf_pcm(path: Path, asset: DawMedia) -> bool:
    try:
        content = path.read_bytes()
        if len(content) < 12 or content[:4] != b"RIFF" or content[8:12] != b"WAVE":
            return False
        fmt: bytes | None = None
        data_size: int | None = None
        offset = 12
        while offset + 8 <= len(content):
            chunk_id = content[offset : offset + 4]
            chunk_size = struct.unpack_from("<I", content, offset + 4)[0]
            start, end = offset + 8, offset + 8 + chunk_size
            if end > len(content):
                return False
            if chunk_id == b"fmt ":
                fmt = content[start:end]
            elif chunk_id == b"data":
                data_size = chunk_size
            offset = end + (chunk_size & 1)
        if fmt is None or len(fmt) < 16 or data_size is None:
            return False
        format_tag, channels, rate, _, block_align, bits = struct.unpack_from("<HHIIHH", fmt)
        if format_tag == 0xFFFE:
            if len(fmt) < 40 or fmt[24:40] != bytes.fromhex("0100000000001000800000aa00389b71"):
                return False
        elif format_tag != 1:
            return False
        width = bits // 8
        return (
            bits in (16, 24)
            and channels == asset.channels
            and rate == asset.sample_rate
            and block_align == channels * width
            and data_size == asset.frames * block_align
        )
    except (OSError, struct.error):
        return False


def _prepare_aaf_media(asset: DawMedia, media_root: Path, engine: FFmpegEngine) -> Path:
    stem = Path(asset.package_name).stem
    staged_source = media_root / f"{stem}.source.wav"
    prepared = media_root / f"{stem}.wav"
    with open_pinned_media(asset.path) as source:
        atomic_write(staged_source, lambda output: copyfileobj(source, output))
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
    if not _valid_aaf_pcm(prepared, asset):
        prepared.unlink(missing_ok=True)
        raise CodedValueError(
            f"Could not prepare {asset.path.name} as supported AAF PCM.",
            code="aaf_export_pcm_unsupported",
        )
    if prepared.stat().st_size > 0xFFFFFFFF:
        raise CodedValueError(
            f"{asset.path.name} is too large for the AAF writer's WAV limit.",
            code="aaf_export_pcm_too_large",
        )
    return prepared


def _export_session(
    project_path: Path,
    destination: Path,
    session_name: str,
    writer: SessionWriter,
) -> Path:
    """Open a saved project once and publish one writer-owned package atomically."""
    workspace = ProjectWorkspace.open(project_path, adopt=False)
    timeline = build_daw_timeline(workspace.project)
    if not timeline.media:
        raise CodedValueError("The saved episode has no audio to export.", code="daw_export_empty")
    target = destination.expanduser().absolute()
    name = target.name
    if name in {"", ".", ".."}:
        raise CodedValueError(
            "Choose a new directory for the REAPER session.", code="daw_export_bad_destination"
        )
    stage = OwnedStage(target.parent.resolve(strict=True))
    try:
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
    return _export_session(project_path, destination, "session.rpp", _write_reaper_session)


def export_aaf_session(project_path: Path, destination: Path) -> Path:
    """Export a self-contained experimental AAF into a new directory."""
    return _export_session(project_path, destination, AAF_SESSION_NAME, _write_aaf_session)

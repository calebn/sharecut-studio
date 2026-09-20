from __future__ import annotations

import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.parallel import run_parallel


def sanitize_export_stem(name: str) -> str:
    """Make a project name safe for use as an export filename stem.

    Path separators in names (e.g. "Part 1/2") would otherwise create nested
    directories under export/ instead of a single file.
    """
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_")
    return cleaned or "episode"


@dataclass(frozen=True)
class ExportFormatSpec:
    ext: str
    codec: str | None = None
    format: str | None = None
    bitrate_kbps: int | None = None
    sample_rate: int | None = None
    channels: int | None = None
    extra_args: tuple[str, ...] = ()

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> ExportFormatSpec:
        ext = str(raw.get("ext") or raw.get("extension") or "").lstrip(".").lower()
        if not ext:
            raise ValueError("export format requires 'ext' (e.g. mp3, flac, opus)")
        extra = raw.get("extra_args") or []
        if isinstance(extra, str):
            extra = [extra]
        return cls(
            ext=ext,
            codec=raw.get("codec"),
            format=raw.get("format"),
            bitrate_kbps=raw.get("bitrate_kbps"),
            sample_rate=raw.get("sample_rate"),
            channels=raw.get("channels"),
            extra_args=tuple(str(a) for a in extra),
        )


def resolve_export_formats(export_cfg: dict[str, Any]) -> list[ExportFormatSpec]:
    """Return encoded deliverables from pipeline export config."""
    if "formats" in export_cfg:
        raw_list = export_cfg.get("formats") or []
        return [ExportFormatSpec.from_dict(item) for item in raw_list]
    bitrate = int(export_cfg.get("mp3_bitrate_kbps", 128))
    return [
        ExportFormatSpec(ext="mp3", codec="libmp3lame", bitrate_kbps=bitrate),
    ]


def export_wav_enabled(export_cfg: dict[str, Any]) -> bool:
    return bool(export_cfg.get("wav", True))


def specs_from_extensions(formats: list[str] | None) -> list[ExportFormatSpec]:
    """Map extension strings (e.g. bounce/GUI) to format specs."""
    exts = formats if formats else ["wav"]
    specs: list[ExportFormatSpec] = []
    for raw in exts:
        ext = str(raw).lstrip(".").lower()
        if not ext:
            continue
        if ext == "wav":
            specs.append(ExportFormatSpec(ext="wav"))
        elif ext == "mp3":
            specs.append(ExportFormatSpec(ext="mp3", codec="libmp3lame", bitrate_kbps=192))
        else:
            specs.append(ExportFormatSpec.from_dict({"ext": ext}))
    if not specs:
        specs.append(ExportFormatSpec(ext="wav"))
    return specs


def write_audio_formats(
    eng: FFmpegEngine,
    source_wav: Path,
    out_stem: Path,
    specs: list[ExportFormatSpec],
    *,
    metadata: dict[str, str] | None = None,
    max_workers: int | None = None,
) -> list[Path]:
    """Copy/encode ``source_wav`` to ``out_stem.{ext}`` for each format spec.

    WAV with no codec is a plain file copy; all other specs are FFmpeg encodes
    (concurrent via ``run_parallel``). Shared by bounce and episode deliverables.
    """
    out_stem.parent.mkdir(parents=True, exist_ok=True)
    meta = metadata or {}
    written: list[Path] = []
    encode_specs: list[ExportFormatSpec] = []

    for spec in specs:
        if spec.ext == "wav" and spec.codec is None:
            out = out_stem.with_suffix(".wav")
            shutil.copy(source_wav, out)
            written.append(out)
        else:
            encode_specs.append(spec)

    def encode_one(spec: ExportFormatSpec) -> Path:
        out = out_stem.with_suffix(f".{spec.ext}")
        eng.export_audio(
            source_wav,
            out,
            codec=spec.codec,
            format=spec.format,
            bitrate_kbps=spec.bitrate_kbps,
            sample_rate=spec.sample_rate,
            channels=spec.channels,
            metadata=meta,
            extra_args=list(spec.extra_args) or None,
        )
        return out

    written.extend(run_parallel(encode_specs, encode_one, max_workers=max_workers))
    return written


def export_episode_audio(
    project: EpisodeProject,
    eng: FFmpegEngine,
    source_wav: Path,
    export_cfg: dict[str, Any],
    *,
    metadata: dict[str, str] | None = None,
    max_workers: int | None = None,
) -> list[Path]:
    """Write episode audio deliverables under export/ from a mastered WAV."""
    project.export_dir().mkdir(parents=True, exist_ok=True)
    meta = metadata or {
        "title": project.name,
        "album": project.name,
    }
    specs: list[ExportFormatSpec] = []
    if export_wav_enabled(export_cfg):
        specs.append(ExportFormatSpec(ext="wav"))
    specs.extend(resolve_export_formats(export_cfg))
    return write_audio_formats(
        eng,
        source_wav,
        project.export_dir() / sanitize_export_stem(project.name),
        specs,
        metadata=meta,
        max_workers=max_workers,
    )

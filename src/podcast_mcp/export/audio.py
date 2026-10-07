from __future__ import annotations

import shutil
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from podcast_mcp.engines.ffmpeg import ENCODE_CANCELLED, FFmpegEngine
from podcast_mcp.export.names import sanitize_export_stem
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.atomic_render import render_atomic_all
from podcast_mcp.util.parallel import run_parallel
from podcast_mcp.util.progress import raise_if_cancel_requested


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
    cancel_check: Callable[[], bool] | None = None,
    reap_partials: bool = False,
) -> list[Path]:
    """Copy/encode ``source_wav`` to ``out_stem.{ext}`` for each format spec.

    WAV with no codec is a plain file copy; all other specs are FFmpeg encodes
    (concurrent via ``run_parallel``). Shared by bounce and episode deliverables.
    Every file is written to a temp and all replace their destinations only after
    the last one is done: a failure, or ``cancel_check()`` turning true (which also
    stops a running encode), leaves earlier files with these names untouched.
    ``reap_partials`` deletes temps a crashed earlier run left; pass it only while
    holding the lock that serializes writers of these files.
    """
    meta = metadata or {}
    dests = [out_stem.with_suffix(f".{spec.ext}") for spec in specs]

    def render(temps: list[Path]) -> None:
        encodes: list[tuple[ExportFormatSpec, Path]] = []
        for spec, tmp in zip(specs, temps, strict=True):
            if spec.ext == "wav" and spec.codec is None:
                raise_if_cancel_requested(cancel_check, ENCODE_CANCELLED)
                shutil.copy(source_wav, tmp)
            else:
                encodes.append((spec, tmp))

        def encode_one(job: tuple[ExportFormatSpec, Path]) -> None:
            spec, tmp = job
            eng.export_audio(
                source_wav,
                tmp,
                codec=spec.codec,
                format=spec.format,
                bitrate_kbps=spec.bitrate_kbps,
                sample_rate=spec.sample_rate,
                channels=spec.channels,
                metadata=meta,
                extra_args=list(spec.extra_args) or None,
                cancel_check=cancel_check,
            )

        run_parallel(encodes, encode_one, max_workers=max_workers)

    return render_atomic_all(
        dests,
        render,
        before_publish=lambda: raise_if_cancel_requested(cancel_check, ENCODE_CANCELLED),
        reap_partials=reap_partials,
    )


def export_episode_audio(
    project: EpisodeProject,
    eng: FFmpegEngine,
    source_wav: Path,
    export_cfg: dict[str, Any],
    *,
    metadata: dict[str, str] | None = None,
    max_workers: int | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> list[Path]:
    """Write episode audio deliverables under export/ from a mastered WAV.

    All or nothing (see ``write_audio_formats``). Callers hold ``render_lock``.
    """
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
        cancel_check=cancel_check,
        reap_partials=True,
    )

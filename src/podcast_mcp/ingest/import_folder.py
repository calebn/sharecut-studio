from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from podcast_mcp.engines.ffmpeg import AudioProbe, FFmpegEngine
from podcast_mcp.util.workspace_paths import resolve_within

AUDIO_EXTENSIONS = frozenset({".wav", ".aif", ".aiff", ".flac", ".m4a", ".mp3", ".aac", ".ogg"})
DEFAULT_MAX_FILES = 32
DEFAULT_MAX_TOTAL_DURATION_SEC = 12 * 3600
MANY_FILES_WARN = 8
SHORT_FILE_RATIO = 0.5
VendorHint = Literal["zoom", "riverside", "zencastr", "squadcast", "unknown"]

_VENDOR_TOKENS: tuple[str, ...] = ("zoom", "riverside", "zencastr", "squadcast")
_NOISE_TOKENS = frozenset(
    {
        "audio",
        "track",
        "recording",
        "raw",
        "wav",
        "mp3",
        "m4a",
        "flac",
        "aac",
        "ogg",
        "zoom",
        "riverside",
        "zencastr",
        "squadcast",
    }
)
_MIX_TOKENS = ("mix", "combined")
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
_LONG_DIGITS_RE = re.compile(r"\d{8,}")
_GUID_RE = re.compile(
    r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}",
    re.IGNORECASE,
)
_CAMEL_RE = re.compile(r"(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")


@dataclass
class ScannedFile:
    path: Path
    filename: str
    speaker_label: str
    duration_sec: float
    sample_rate: int
    channels: int


@dataclass
class FolderScan:
    audio_dir: Path
    files: list[ScannedFile]
    skipped: list[ScannedFile]
    vendor_hint: VendorHint
    warnings: list[str] = field(default_factory=list)


def filename_stem_parts(filename: str) -> list[str]:
    """Tokenize a recorder filename the same way ``derive_speaker_label`` does."""
    stem = Path(filename).stem
    stem = _GUID_RE.sub(" ", stem)
    stem = _DATE_RE.sub(" ", stem)
    stem = _LONG_DIGITS_RE.sub(" ", stem)
    stem = _CAMEL_RE.sub(" ", stem)
    return [p for p in re.split(r"[\s_\-.]+", stem) if p]


def derive_speaker_label(filename: str, fallback_index: int = 1) -> str:
    """Conservative speaker label from a recorder filename.

    Strips the extension, vendor/noise tokens (``audio``, ``track``, ``recording``,
    ``raw``, ``wav``, dates, long digit runs, GUID-like ids, Zoom/Riverside/
    Zencastr/SquadCast), splits on ``_`` ``-`` ``.`` and camelCase, then
    title-cases the remainder. Role words such as ``host`` / ``guest`` are kept
    (``host-caleb.wav`` → ``Host Caleb``). Empty remainder → ``speaker_{n}``.
    """
    words = [
        p
        for p in filename_stem_parts(filename)
        if p.lower() not in _NOISE_TOKENS and not p.isdigit()
    ]
    if not words:
        return f"speaker_{fallback_index}"
    return " ".join(_title_word(w) for w in words)


def detect_vendor_hint(*texts: str) -> VendorHint:
    blob = " ".join(texts).lower()
    for token in _VENDOR_TOKENS:
        if token in blob:
            return token  # type: ignore[return-value]
    return "unknown"


def scan_recorder_folder(
    audio_dir: Path,
    *,
    engine: FFmpegEngine | None = None,
    max_files: int = DEFAULT_MAX_FILES,
    max_total_duration_sec: float = DEFAULT_MAX_TOTAL_DURATION_SEC,
    on_probe: Callable[[int, int, str], None] | None = None,
) -> FolderScan:
    """List audio in *audio_dir*, probe via FFmpeg, and derive speaker labels.

    Does not copy files or write a manifest. Refuses child symlinks that resolve
    outside *audio_dir*. Mix-named files (``*mix*``, ``*combined*``, ``*stereo*``)
    are skipped unless they are the only audio files.
    """
    root = _require_readable_dir(audio_dir)
    candidates = _list_audio_candidates(audio_dir, root)
    kept, skipped = _partition_mix_files(candidates)
    if len(kept) > max_files:
        raise ValueError(f"recorder folder has {len(kept)} audio files; bound is {max_files}")
    if not kept:
        raise ValueError(f"no audio files found in {audio_dir}")

    probe_engine = engine or FFmpegEngine()
    files: list[ScannedFile] = []
    total_duration = 0.0
    for index, path in enumerate(kept, start=1):
        probe = _probe_audio(probe_engine, path)
        total_duration += probe.duration_sec
        if total_duration > max_total_duration_sec:
            raise ValueError(
                f"probed duration {total_duration:.1f}s exceeds bound {max_total_duration_sec:.1f}s"
            )
        files.append(
            ScannedFile(
                path=path,
                filename=path.name,
                speaker_label=derive_speaker_label(path.name, fallback_index=index),
                duration_sec=probe.duration_sec,
                sample_rate=probe.sample_rate,
                channels=probe.channels,
            )
        )
        if on_probe is not None:
            on_probe(index, len(kept), path.name)

    skipped_rows = [
        ScannedFile(
            path=path,
            filename=path.name,
            speaker_label=derive_speaker_label(path.name, fallback_index=i),
            duration_sec=0.0,
            sample_rate=0,
            channels=0,
        )
        for i, path in enumerate(skipped, start=1)
    ]
    vendor_hint = detect_vendor_hint(root.name, *(p.name for p in kept), *(p.name for p in skipped))
    warnings = _scan_warnings(files)
    if skipped:
        warnings.append(
            "skipped mix/combined/stereo filename(s): " + ", ".join(p.name for p in skipped)
        )
    return FolderScan(
        audio_dir=root,
        files=files,
        skipped=skipped_rows,
        vendor_hint=vendor_hint,
        warnings=warnings,
    )


def _require_readable_dir(audio_dir: Path) -> Path:
    if not audio_dir.is_dir():
        raise ValueError(f"not a readable directory: {audio_dir}")
    try:
        root = audio_dir.resolve()
        next(audio_dir.iterdir(), None)
    except OSError as exc:
        raise ValueError(f"not a readable directory: {audio_dir}") from exc
    return root


def _list_audio_candidates(audio_dir: Path, root: Path) -> list[Path]:
    try:
        entries = list(audio_dir.iterdir())
    except OSError as exc:
        raise ValueError(f"cannot read directory: {audio_dir}") from exc
    out: list[Path] = []
    for entry in sorted(entries, key=lambda p: p.name.lower()):
        if entry.name.startswith("."):
            continue
        if entry.suffix.lower() not in AUDIO_EXTENSIONS:
            continue
        _refuse_symlink_escape(entry, root)
        if not entry.is_file():
            continue
        out.append(entry)
    return out


def _refuse_symlink_escape(entry: Path, root: Path) -> None:
    try:
        resolve_within(root, str(entry.absolute()))
    except OSError as exc:
        raise ValueError(f"cannot resolve path: {entry.name}") from exc
    except ValueError:
        raise ValueError(f"symlink escapes recorder folder: {entry.name}") from None


def _is_mix_name(name: str) -> bool:
    stem = Path(name).stem.lower()
    parts = re.split(r"[\s_\-.]+", stem)
    return any(part in _MIX_TOKENS for part in parts if part)


def _partition_mix_files(candidates: list[Path]) -> tuple[list[Path], list[Path]]:
    mix = [p for p in candidates if _is_mix_name(p.name)]
    keep = [p for p in candidates if not _is_mix_name(p.name)]
    if keep:
        return keep, mix
    return candidates, []


def _probe_audio(engine: FFmpegEngine, path: Path) -> AudioProbe:
    return engine.probe(path, untrusted=True)


def _title_word(word: str) -> str:
    if any(ch.isupper() for ch in word[1:]):
        return word
    return word[:1].upper() + word[1:].lower()


def _scan_warnings(files: list[ScannedFile]) -> list[str]:
    warnings: list[str] = []
    labels = [row.speaker_label for row in files]
    seen: set[str] = set()
    dupes: list[str] = []
    for label in labels:
        if label in seen and label not in dupes:
            dupes.append(label)
        seen.add(label)
    if dupes:
        warnings.append("duplicate speaker labels: " + ", ".join(dupes))
    if len(files) > MANY_FILES_WARN:
        warnings.append(f"{len(files)} files found (typical recorder export is ≤ 8)")
    rates = {row.sample_rate for row in files}
    if len(rates) > 1:
        warnings.append("sample-rate mismatch: " + ", ".join(str(r) for r in sorted(rates)))
    channels = {row.channels for row in files}
    if 1 in channels and any(ch > 1 for ch in channels):
        warnings.append("mono and stereo files mixed in the same folder")
    if len(files) >= 2:
        durations = sorted(row.duration_sec for row in files)
        mid = len(durations) // 2
        median = durations[mid] if len(durations) % 2 else (durations[mid - 1] + durations[mid]) / 2
        if median > 0:
            short = [row.filename for row in files if row.duration_sec < SHORT_FILE_RATIO * median]
            if short:
                warnings.append(
                    "much shorter than the rest (late joiner / partial): " + ", ".join(short)
                )
    return warnings

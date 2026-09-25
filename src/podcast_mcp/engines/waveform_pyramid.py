"""``.wfpk`` v1 min/max/RMS peak pyramids for media files (see ``docs/waveform.md``).

A pyramid belongs to one media file. Its key (``media_key``) hashes the
workspace-relative path, size and mtime, so a file on disk is never stale:
changed media gets a new key and a new file. Files live under
``artifacts/peaks/{ref_slug}.{key}.wfpk``.

Layout (little-endian): a 64-byte header, ``level_count`` level entries of
``{u32 spp, u32 bins, u64 data_offset}``, then each level's bins as
``i16 min, i16 max, i16 rms``. Level ``l`` has ``spp = base_spp * factor**l``;
bin ``i`` covers frames ``[i*spp, min((i+1)*spp, total))``. Levels are added
while the coarsest one has more than ``bins_per_tile`` bins.

Build (``build_levels``) is pure numpy over float32 ``(frames, channels)``
chunks; decode (``decode_media``) uses a stdlib WAV fast path and falls back to
``FFmpegEngine.stream_pcm_f32``. Background builds run on a small job pool
keyed by pyramid key (``schedule_pyramid_build``).
"""

from __future__ import annotations

import atexit
import contextlib
import functools
import hashlib
import logging
import os
import re
import shutil
import struct
import time
import wave
from collections import OrderedDict
from collections.abc import Callable, Generator, Iterable
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock
from typing import IO

import numpy as np

from podcast_mcp.edits.track_ids import SAFE_TRACK_ID
from podcast_mcp.engines.ffmpeg import PCM_STREAM_CHUNK_FRAMES, FFmpegEngine
from podcast_mcp.util.progress import progress_task
from podcast_mcp.util.timeline_zoom import (
    base_samples_per_bin,
    bins_per_data_tile,
    level_factor,
    pcm_block_frames,
    waveform_format_version,
)
from podcast_mcp.util.workspace_paths import resolve_within

log = logging.getLogger(__name__)

MAGIC = b"WFPK"
HEADER_BYTES = 64
LEVEL_ENTRY_BYTES = 16
BIN_BYTES = 6
INT16_FULL_SCALE = 32767
TMP_MAX_AGE_SEC = 86_400.0
# read_pcm_minmax windows are capped at this many contract PCM blocks.
PCM_WINDOW_MAX_BLOCKS = 4

# magic, version, header_bytes, sample_rate, channels, total_frames, base_spp,
# level_factor, level_count, bins_per_tile, bin_bytes, flags, 24 reserved bytes.
HEADER_STRUCT = struct.Struct("<4sHHIIQIHHIHH24x")
LEVEL_STRUCT = struct.Struct("<IIQ")
_BIN_DTYPE = np.dtype("<i2")

_KEY_RE = re.compile(r"^[0-9a-f]{20}$")


@dataclass(frozen=True)
class PyramidLevel:
    spp: int
    bins: int
    data_offset: int


@dataclass(frozen=True)
class PyramidMeta:
    version: int
    header_bytes: int
    sample_rate: int
    channels: int
    total_frames: int
    base_spp: int
    level_factor: int
    bins_per_tile: int
    levels: tuple[PyramidLevel, ...]


# --- Build -------------------------------------------------------------------


def _ceil_div(a: int, b: int) -> int:
    return -(-a // b)


def _bin_counts(n_bins: int, spp: int, total_frames: int, channels: int) -> np.ndarray:
    """Samples per bin (frames x channels); only the tail bin can be short."""
    counts = np.full(n_bins, float(spp * channels), dtype=np.float64)
    if n_bins:
        counts[-1] = float((total_frames - (n_bins - 1) * spp) * channels)
    return counts


def _quantize(mn: np.ndarray, mx: np.ndarray, sumsq: np.ndarray, counts: np.ndarray) -> np.ndarray:
    """int16 ``(bins, 3)``; min floors and max ceils so the envelope never under-reports."""
    out = np.empty((len(mn), 3), dtype=np.int16)
    full = float(INT16_FULL_SCALE)
    out[:, 0] = np.clip(np.floor(mn.astype(np.float64) * full), -full, full)
    out[:, 1] = np.clip(np.ceil(mx.astype(np.float64) * full), -full, full)
    with np.errstate(invalid="ignore", divide="ignore"):
        rms = np.sqrt(sumsq / counts)
    out[:, 2] = np.clip(np.round(np.nan_to_num(rms) * full), 0.0, full)
    return out


def _reduce(
    mn: np.ndarray, mx: np.ndarray, sumsq: np.ndarray, factor: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """One coarser level: pad with neutral values (+inf, -inf, 0) and fold by *factor*."""
    pad = (-len(mn)) % factor
    if pad:
        mn = np.concatenate([mn, np.full(pad, np.inf, dtype=mn.dtype)])
        mx = np.concatenate([mx, np.full(pad, -np.inf, dtype=mx.dtype)])
        sumsq = np.concatenate([sumsq, np.zeros(pad, dtype=sumsq.dtype)])
    return (
        mn.reshape(-1, factor).min(axis=1),
        mx.reshape(-1, factor).max(axis=1),
        sumsq.reshape(-1, factor).sum(axis=1),
    )


def _pyramid_from_level0(
    mn: np.ndarray,
    mx: np.ndarray,
    sumsq: np.ndarray,
    *,
    total_frames: int,
    channels: int,
    base_spp: int,
    factor: int,
    bins_per_tile: int,
) -> list[np.ndarray]:
    spp = base_spp
    levels = [_quantize(mn, mx, sumsq, _bin_counts(len(mn), spp, total_frames, channels))]
    while len(mn) > bins_per_tile:
        mn, mx, sumsq = _reduce(mn, mx, sumsq, factor)
        spp *= factor
        levels.append(_quantize(mn, mx, sumsq, _bin_counts(len(mn), spp, total_frames, channels)))
    return levels


def _knobs(
    base_spp: int | None, factor: int | None, bins_per_tile: int | None
) -> tuple[int, int, int]:
    spp = base_samples_per_bin() if base_spp is None else base_spp
    fac = level_factor() if factor is None else factor
    bpt = bins_per_data_tile() if bins_per_tile is None else bins_per_tile
    if spp < 1 or fac < 2 or bpt < 1:
        raise ValueError("invalid pyramid knobs")
    return spp, fac, bpt


def build_levels(
    chunks: Iterable[np.ndarray],
    *,
    sample_rate: int,
    channels: int,
    base_spp: int | None = None,
    factor: int | None = None,
    bins_per_tile: int | None = None,
) -> tuple[int, list[np.ndarray]]:
    """Reduce float32 ``(frames, channels)`` chunks to ``(total_frames, levels)``.

    Each level is an int16 ``(bins, 3)`` array of ``(min, max, rms)``. Level 0
    folds ``base_spp``-frame slices (the remainder carries into the next chunk);
    min/max run over frames x channels and RMS over every sample. Empty input
    gives one level with 0 bins.
    """
    if sample_rate < 1 or channels < 1:
        raise ValueError("sample_rate and channels must be >= 1")
    spp, fac, bpt = _knobs(base_spp, factor, bins_per_tile)
    carry = np.zeros((0, channels), dtype=np.float32)
    mins: list[np.ndarray] = []
    maxs: list[np.ndarray] = []
    sums: list[np.ndarray] = []
    total = 0
    for chunk in chunks:
        arr = np.asarray(chunk, dtype=np.float32)
        if arr.ndim == 1 and channels == 1:
            arr = arr.reshape(-1, 1)
        if arr.ndim != 2 or arr.shape[1] != channels:
            raise ValueError(f"chunk shape {arr.shape} does not match {channels} channel(s)")
        if not len(arr):
            continue
        arr = np.nan_to_num(arr, nan=0.0, posinf=1.0, neginf=-1.0)
        total += len(arr)
        buf = np.concatenate([carry, arr]) if len(carry) else arr
        n_full = len(buf) // spp
        if n_full:
            body = buf[: n_full * spp].reshape(n_full, spp * channels)
            mins.append(body.min(axis=1))
            maxs.append(body.max(axis=1))
            wide = body.astype(np.float64)
            sums.append(np.einsum("ij,ij->i", wide, wide))
        carry = buf[n_full * spp :].copy()
    if len(carry):
        tail = carry.reshape(-1)
        mins.append(np.array([tail.min()], dtype=np.float32))
        maxs.append(np.array([tail.max()], dtype=np.float32))
        wide_tail = tail.astype(np.float64)
        sums.append(np.array([float(np.dot(wide_tail, wide_tail))]))
    if not mins:
        return 0, [np.zeros((0, 3), dtype=np.int16)]
    levels = _pyramid_from_level0(
        np.concatenate(mins),
        np.concatenate(maxs),
        np.concatenate(sums),
        total_frames=total,
        channels=channels,
        base_spp=spp,
        factor=fac,
        bins_per_tile=bpt,
    )
    return total, levels


# --- File I/O ------------------------------------------------------------------


def _fsync_dir(path: Path) -> None:
    """Persist a rename in directory *path* (best effort; no-op where dirs cannot be opened)."""
    with contextlib.suppress(OSError):
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def _publish(out: Path, write: Callable[[IO[bytes]], None]) -> Path:
    """Write via a unique sibling temp file, fsync, then ``os.replace`` into *out*.

    An existing *out* is replaced: pyramids are content-addressed, so a valid
    one gets identical bytes and a corrupt one (torn write, disk damage) is
    repaired.
    """
    out.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(
        dir=out.parent, prefix=f".{out.name}.", suffix=".tmp", delete=False
    ) as fh:
        tmp = Path(fh.name)
        try:
            write(fh)
            fh.flush()
            os.fsync(fh.fileno())
        except BaseException:
            fh.close()
            tmp.unlink(missing_ok=True)
            raise
    try:
        os.replace(tmp, out)
    except OSError:
        tmp.unlink(missing_ok=True)
        raise
    _fsync_dir(out.parent)
    return out


def write_pyramid(
    out: Path,
    *,
    sample_rate: int,
    channels: int,
    total_frames: int,
    levels: list[np.ndarray],
    base_spp: int | None = None,
    factor: int | None = None,
    bins_per_tile: int | None = None,
) -> Path:
    """Serialize *levels* (from ``build_levels``) to a ``.wfpk`` file atomically."""
    spp, fac, bpt = _knobs(base_spp, factor, bins_per_tile)
    if not levels:
        raise ValueError("a pyramid needs at least one level")
    header_bytes = HEADER_BYTES + LEVEL_ENTRY_BYTES * len(levels)
    header = HEADER_STRUCT.pack(
        MAGIC,
        waveform_format_version(),
        header_bytes,
        sample_rate,
        channels,
        total_frames,
        spp,
        fac,
        len(levels),
        bpt,
        BIN_BYTES,
        0,
    )
    table = bytearray()
    offset = header_bytes
    level_spp = spp
    for level in levels:
        if level.ndim != 2 or level.shape[1] != 3:
            raise ValueError("each level must be a (bins, 3) array")
        if len(level) != _ceil_div(total_frames, level_spp):
            raise ValueError("level bin count does not match total_frames")
        table += LEVEL_STRUCT.pack(level_spp, len(level), offset)
        offset += len(level) * BIN_BYTES
        level_spp *= fac

    def _write(fh: IO[bytes]) -> None:
        fh.write(header)
        fh.write(bytes(table))
        for level in levels:
            fh.write(np.ascontiguousarray(level, dtype=_BIN_DTYPE).tobytes())

    return _publish(out, _write)


def read_meta(path: Path) -> PyramidMeta:
    """Parse and validate a ``.wfpk`` header; ``ValueError`` on any inconsistency."""
    size = path.stat().st_size
    with path.open("rb") as fh:
        head = fh.read(HEADER_BYTES)
        if len(head) < HEADER_BYTES:
            raise ValueError("truncated pyramid header")
        (
            magic,
            version,
            header_bytes,
            sample_rate,
            channels,
            total_frames,
            base_spp,
            factor,
            level_count,
            bins_per_tile,
            bin_bytes,
            _flags,
        ) = HEADER_STRUCT.unpack(head)
        if magic != MAGIC:
            raise ValueError("not a .wfpk file")
        if version != waveform_format_version():
            raise ValueError(f"unsupported .wfpk version {version}")
        if bin_bytes != BIN_BYTES:
            raise ValueError(f"unsupported bin size {bin_bytes}")
        if level_count < 1 or header_bytes != HEADER_BYTES + LEVEL_ENTRY_BYTES * level_count:
            raise ValueError("bad pyramid level table size")
        if sample_rate < 1 or channels < 1 or base_spp < 1 or factor < 2 or bins_per_tile < 1:
            raise ValueError("bad pyramid header fields")
        table = fh.read(LEVEL_ENTRY_BYTES * level_count)
    if len(table) < LEVEL_ENTRY_BYTES * level_count:
        raise ValueError("truncated pyramid level table")
    levels: list[PyramidLevel] = []
    prev_spp = 0
    for idx in range(level_count):
        spp, bins, data_offset = LEVEL_STRUCT.unpack_from(table, idx * LEVEL_ENTRY_BYTES)
        if spp <= prev_spp:
            raise ValueError("pyramid spp must increase per level")
        if bins != _ceil_div(total_frames, spp):
            raise ValueError("pyramid bin count does not match total_frames")
        if data_offset < header_bytes or data_offset + bins * BIN_BYTES > size:
            raise ValueError("pyramid level data out of bounds")
        levels.append(PyramidLevel(spp=spp, bins=bins, data_offset=data_offset))
        prev_spp = spp
    if levels[0].spp != base_spp:
        raise ValueError("level 0 spp must equal base_spp")
    return PyramidMeta(
        version=version,
        header_bytes=header_bytes,
        sample_rate=sample_rate,
        channels=channels,
        total_frames=total_frames,
        base_spp=base_spp,
        level_factor=factor,
        bins_per_tile=bins_per_tile,
        levels=tuple(levels),
    )


def read_bins(path: Path, meta: PyramidMeta, level: int, start_bin: int, count: int) -> bytes:
    """Raw ``(min, max, rms)`` int16 bins ``[start_bin, start_bin+count)``, clipped at level end."""
    if not 0 <= level < len(meta.levels):
        raise ValueError(f"level {level} out of range")
    if start_bin < 0 or count < 0:
        raise ValueError("start_bin and count must be >= 0")
    lv = meta.levels[level]
    end = min(start_bin + count, lv.bins)
    if start_bin >= end:
        return b""
    with path.open("rb") as fh:
        fh.seek(lv.data_offset + start_bin * BIN_BYTES)
        return fh.read((end - start_bin) * BIN_BYTES)


# --- Decode --------------------------------------------------------------------


@dataclass(frozen=True)
class _WavInfo:
    sample_rate: int
    channels: int
    width: int
    frames: int


# Trailing RIFF chunks (``LIST``, ``id3 ``...) after an empty ``data`` chunk.
_RIFF_CHUNK_ID = re.compile(rb"[\x20-\x7e]{4}")
_MAX_TRAILING_CHUNKS = 16


def _only_riff_chunks(path: Path, offset: int, size: int) -> bool:
    """True when bytes ``[offset, size)`` of *path* are whole RIFF chunks (e.g. ``LIST``).

    Tells an empty ``data`` chunk followed by metadata apart from a 0-size
    header in front of real samples. A missing final pad byte is tolerated.
    """
    pos = offset
    with path.open("rb") as fh:
        for _ in range(_MAX_TRAILING_CHUNKS):
            if size - pos < 8:
                break
            fh.seek(pos)
            head = fh.read(8)
            if _RIFF_CHUNK_ID.fullmatch(head[:4]) is None:
                return False
            chunk_size = int.from_bytes(head[4:8], "little")
            pos += 8 + chunk_size + (chunk_size & 1)
    return pos in (size, size + 1)


def _wav_info(path: Path) -> _WavInfo | None:
    """Integer-PCM WAV params for the stdlib fast path, else ``None`` (use ffmpeg).

    The header's ``data`` size must fit the file: a streamed or truncated WAV
    that declares 0, ``0xFFFFFFFF`` or more bytes than it holds goes to ffmpeg,
    which decodes what is actually there. An empty ``data`` chunk followed only by
    whole RIFF chunks (``LIST``, ``id3 ``) stays on the fast path.
    """
    try:
        with path.open("rb") as fh, wave.open(fh, "rb") as wf:
            data_offset = fh.tell()  # ``wave`` stops right after the data chunk header
            info = _WavInfo(
                wf.getframerate(), wf.getnchannels(), wf.getsampwidth(), wf.getnframes()
            )
            comptype = wf.getcomptype()
            size = os.fstat(fh.fileno()).st_size
    except (wave.Error, EOFError):
        return None
    if comptype != "NONE" or info.width not in (1, 2, 3, 4) or info.sample_rate < 1:
        return None
    frame_bytes = info.width * info.channels
    available = size - data_offset
    if info.frames * frame_bytes > available:
        return None  # overstated or 0xFFFFFFFF data size
    if (
        info.frames == 0
        and available >= frame_bytes
        and not _only_riff_chunks(path, data_offset, size)
    ):
        return None  # 0-size header in front of real samples
    return info


def _pcm_to_f32(raw: bytes | bytearray, width: int, channels: int) -> np.ndarray:
    """Integer PCM bytes to ``(frames, channels)`` float32 in [-1, 1)."""
    frame_bytes = width * channels
    raw = raw[: len(raw) - len(raw) % frame_bytes]
    if width == 1:
        vals = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif width == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        packed = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        vals = ((packed ^ 0x800000) - 0x800000).astype(np.float32) / float(1 << 23)
    else:
        ints = np.frombuffer(raw, dtype=f"<i{width}")
        vals = (ints.astype(np.float64) / float(1 << (8 * width - 1))).astype(np.float32)
    return vals.reshape(-1, channels)


def _iter_wav(path: Path, info: _WavInfo, chunk_frames: int) -> Generator[np.ndarray, None, None]:
    frame_bytes = info.width * info.channels
    with wave.open(str(path), "rb") as wf:
        while True:
            want = chunk_frames * frame_bytes
            buf = bytearray()
            while len(buf) < want:
                part = wf.readframes((want - len(buf)) // frame_bytes)
                if not part:
                    break
                buf += part
            if len(buf) >= frame_bytes:
                yield _pcm_to_f32(buf, info.width, info.channels)
            if len(buf) < want:
                return


def decode_media(
    path: Path, *, engine: FFmpegEngine | None = None
) -> tuple[int, int, Generator[np.ndarray, None, None]]:
    """``(sample_rate, channels, chunks)`` of float32 ``(frames, channels)`` arrays.

    Integer-PCM WAVs (widths 1-4, uncompressed) decode with the stdlib; anything
    ``wave`` rejects (extensible/float WAVs on 3.11, compressed media) streams
    through ``FFmpegEngine.stream_pcm_f32``.
    """
    info = _wav_info(path)
    if info is not None:
        return info.sample_rate, info.channels, _iter_wav(path, info, PCM_STREAM_CHUNK_FRAMES)
    eng = engine or FFmpegEngine()
    return eng.stream_pcm_f32(path)


def _minmax_int16(data: np.ndarray) -> np.ndarray:
    """Per-frame ``(min, max)`` across channels as int16, floored/ceiled outward.

    NaN counts as 0 and ±inf as ±1, as in ``build_levels``.
    """
    full = float(INT16_FULL_SCALE)
    out = np.empty((len(data), 2), dtype=np.int16)
    if len(data):
        # A NaN would win min/max and cast to an undefined int16, hiding the
        # other channels' peaks.
        data = np.nan_to_num(data, nan=0.0, posinf=1.0, neginf=-1.0)
        # Reduce across channels in float32 (exact), then widen only (n,) arrays.
        lo = data.min(axis=1).astype(np.float64)
        hi = data.max(axis=1).astype(np.float64)
        out[:, 0] = np.clip(np.floor(lo * full), -full, full)
        out[:, 1] = np.clip(np.ceil(hi * full), -full, full)
    return out


def read_pcm_minmax(
    path: Path,
    start_frame: int,
    frames: int,
    *,
    sample_rate: int | None = None,
    channels: int | None = None,
    engine: FFmpegEngine | None = None,
) -> np.ndarray:
    """int16 ``(n, 2)`` per-frame min/max across channels for ``[start, start+frames)``.

    ``n`` is clipped at end of media. WAVs read a bounded ``setpos``/``readframes``
    window; other media decode through ``FFmpegEngine.decode_window_f32``
    (``sample_rate``/``channels`` default to a probe).
    *frames* is capped at ``PCM_WINDOW_MAX_BLOCKS * pcm_block_frames()``; larger
    windows raise ``ValueError``.
    """
    if start_frame < 0 or frames < 0:
        raise ValueError("start_frame and frames must be >= 0")
    max_frames = PCM_WINDOW_MAX_BLOCKS * pcm_block_frames()
    if frames > max_frames:
        raise ValueError(f"PCM window of {frames} frames exceeds {max_frames}")
    info = _wav_info(path)
    if info is not None:
        start = min(start_frame, info.frames)
        count = min(frames, info.frames - start)
        with wave.open(str(path), "rb") as wf:
            wf.setpos(start)
            raw = wf.readframes(count)
        return _minmax_int16(_pcm_to_f32(raw, info.width, info.channels))
    eng = engine or FFmpegEngine()
    if sample_rate is None or channels is None:
        probe = eng.probe(path, untrusted=True)
        sample_rate, channels = probe.sample_rate, max(1, probe.channels)
    return _minmax_int16(eng.decode_window_f32(path, start_frame, frames, sample_rate, channels))


# --- Keys and files -------------------------------------------------------------


def media_key(rel_posix: str, size: int, mtime_ns: int) -> str:
    """20-hex pyramid key for a media file (workspace-relative POSIX path, size, mtime).

    Deliberately not ``util.project_state.file_revision``: that includes device
    and inode, which change when a workspace is copied or restored, while this
    key is persisted in ``.wfpk`` file names and must survive both. The format
    version is hashed in, so a format bump never reuses old files.
    """
    raw = f"{waveform_format_version()}|{rel_posix}|{size}|{mtime_ns}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]


def ref_slug(kind: str, ref_id: str) -> str:
    """Filename-safe slug for a media ref: ``{kind}-{id}`` or ``{kind}-h{sha1[:12]}``.

    Ids that are not ``SAFE_TRACK_ID`` are hashed rather than slugified
    (``edits.track_ids.slug_track_id`` is lossy, so two refs could share a
    slug and prune each other's pyramids). sha1 here is a name, not security.
    """
    if SAFE_TRACK_ID.fullmatch(ref_id):
        return f"{kind}-{ref_id}"
    digest = hashlib.sha1(ref_id.encode("utf-8"), usedforsecurity=False).hexdigest()
    return f"{kind}-h{digest[:12]}"


def pyramid_path(peaks_dir: Path, slug: str, key: str) -> Path:
    """``peaks_dir/{slug}.{key}.wfpk``; ``ValueError`` if it would escape *peaks_dir*."""
    if not SAFE_TRACK_ID.fullmatch(slug) or not _KEY_RE.fullmatch(key):
        raise ValueError("invalid pyramid slug or key")
    return resolve_within(peaks_dir, f"{slug}.{key}.wfpk")


def _valid_pyramid(path: Path) -> bool:
    """True when *path* parses with ``read_meta``."""
    try:
        read_meta(path)
    except (OSError, ValueError):
        return False
    return True


def prune_ref_pyramids(peaks_dir: Path, slug: str, live_key: str) -> None:
    """Keep *live_key* plus the newest other key for *slug*; drop day-old temp files."""
    pattern = re.compile(rf"^{re.escape(slug)}\.([0-9a-f]{{20}})\.wfpk$")
    others: list[tuple[int, Path]] = []
    for path in peaks_dir.glob(f"{slug}.*.wfpk"):
        match = pattern.fullmatch(path.name)
        if match is None or match.group(1) == live_key:
            continue
        with contextlib.suppress(OSError):
            others.append((path.stat().st_mtime_ns, path))
    others.sort(key=lambda item: item[0], reverse=True)
    for _, stale in others[1:]:
        with contextlib.suppress(OSError):
            stale.unlink()
    cutoff = time.time() - TMP_MAX_AGE_SEC
    for tmp in peaks_dir.glob(".*.tmp"):
        with contextlib.suppress(OSError):
            if tmp.stat().st_mtime < cutoff:
                tmp.unlink()


def reuse_existing_pyramid(peaks_dir: Path, key: str, out: Path) -> bool:
    """Link (or copy) a valid ``*.{key}.wfpk`` to *out*; ``True`` when *out* now exists.

    Files that fail ``read_meta`` are never trusted: a bad candidate is
    skipped, and a bad *out* is replaced atomically (a copy here, or the
    caller's rebuild through ``write_pyramid``) rather than unlinked, so a
    valid file another build publishes meanwhile is never removed.
    """
    replace = out.exists()
    if replace and _valid_pyramid(out):
        return True
    for candidate in sorted(peaks_dir.glob(f"*.{key}.wfpk")):
        if candidate == out or not _valid_pyramid(candidate):
            continue
        if not replace:
            try:
                os.link(candidate, out)
            except FileExistsError:
                return True
            except OSError:
                pass
            else:
                return True
        try:
            _publish(out, functools.partial(_copy_into, candidate))
        except OSError:
            continue
        return True
    return False


def _copy_into(src: Path, fh: IO[bytes]) -> None:
    """Stream *src* into an open temp file (link fallback for ``reuse_existing_pyramid``)."""
    with src.open("rb") as rd:
        shutil.copyfileobj(rd, fh)


def write_synthetic_pyramid(
    out: Path,
    *,
    sample_rate: int,
    total_frames: int,
    seed: int,
    silent: bool = False,
) -> Path:
    """Write a deterministic mono speech-like pyramid for *total_frames* without decoding.

    Phrases (0.3-3 s, syllable-modulated) alternate with pauses (0.1-1.2 s);
    ``silent=True`` writes all-zero bins. Used for large-project fixtures.
    """
    if sample_rate < 1 or total_frames < 0:
        raise ValueError("invalid synthetic pyramid size")
    spp, fac, bpt = _knobs(None, None, None)
    n_bins = _ceil_div(total_frames, spp)
    amp = np.zeros(n_bins, dtype=np.float64)
    if not silent and n_bins:
        rng = np.random.default_rng(seed)
        bins_per_sec = sample_rate / spp
        t_bin = np.arange(n_bins, dtype=np.float64) / bins_per_sec
        pos = 0
        talking = bool(rng.integers(0, 2))
        while pos < n_bins:
            if talking:
                length = max(1, int(rng.uniform(0.3, 3.0) * bins_per_sec))
                seg = slice(pos, min(pos + length, n_bins))
                level = rng.uniform(0.15, 0.7)
                rate = rng.uniform(3.0, 6.0)
                syll = 0.35 + 0.65 * np.abs(np.sin(np.pi * rate * t_bin[seg]))
                amp[seg] = level * syll
            else:
                length = max(1, int(rng.uniform(0.1, 1.2) * bins_per_sec))
            pos += length
            talking = not talking
        amp *= rng.uniform(0.85, 1.0, size=n_bins)
        amp += rng.uniform(0.0, 0.004, size=n_bins)
    amp = np.minimum(amp, 1.0)
    mn = (-amp).astype(np.float32)
    mx = amp.astype(np.float32)
    counts = _bin_counts(n_bins, spp, total_frames, 1)
    sumsq = (amp * 0.35) ** 2 * counts
    levels = _pyramid_from_level0(
        mn,
        mx,
        sumsq,
        total_frames=total_frames,
        channels=1,
        base_spp=spp,
        factor=fac,
        bins_per_tile=bpt,
    )
    return write_pyramid(
        out,
        sample_rate=sample_rate,
        channels=1,
        total_frames=total_frames,
        levels=levels,
    )


def build_pyramid(ref: str, key: str, audio: Path, out: Path) -> Path:
    """Synchronously build (or reuse) the pyramid for *audio* at *out*, then prune.

    *out* must be ``pyramid_path(peaks_dir, slug, key)``. Reports progress as
    ``waveform.build``.
    """
    slug = _slug_from_out(out, key)
    peaks_dir = out.parent
    with progress_task("waveform.build", f"Waveform {ref}", total=1) as prog:
        if not reuse_existing_pyramid(peaks_dir, key, out):
            sample_rate, channels, chunks = decode_media(audio)
            with contextlib.closing(chunks):
                total, levels = build_levels(chunks, sample_rate=sample_rate, channels=channels)
            write_pyramid(
                out,
                sample_rate=sample_rate,
                channels=channels,
                total_frames=total,
                levels=levels,
            )
        prune_ref_pyramids(peaks_dir, slug, key)
        prog.advance(1)
    with _JOBS_LOCK:
        _FAILED.pop(key, None)
    return out


def _slug_from_out(out: Path, key: str) -> str:
    suffix = f".{key}.wfpk"
    if not _KEY_RE.fullmatch(key) or not out.name.endswith(suffix):
        raise ValueError(f"pyramid path {out.name!r} does not match key {key!r}")
    return out.name[: -len(suffix)]


# --- Background job pool ----------------------------------------------------------

_POOL: ThreadPoolExecutor | None = None
_POOL_LOCK = Lock()
_JOBS: list[Future[None]] = []
_JOBS_LOCK = Lock()
# Pending (slug, key) jobs, and the keys whose build failed mapped to
# (time.monotonic() retry deadline, consecutive failures) (bounded LRU).
# A failure can be transient (ffmpeg missing until bootstrap, ENOSPC, a
# watchdog kill, media still being copied), so it is retried, but the window
# doubles per failure up to FAILED_RETRY_MAX_SEC so a file that never decodes
# stops costing a decode every few minutes. A changed file has a new key and
# is retried at once; a successful build forgets the key. Guarded by _JOBS_LOCK.
_PENDING: set[tuple[str, str]] = set()
_FAILED: OrderedDict[str, tuple[float, int]] = OrderedDict()
_FAILED_MAX = 4096
FAILED_RETRY_SEC = 300.0
FAILED_RETRY_MAX_SEC = 3600.0


def _pyramid_pool() -> ThreadPoolExecutor:
    global _POOL
    with _POOL_LOCK:
        if _POOL is None:
            _POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="waveform")
        return _POOL


def wait_pyramid_jobs() -> None:
    """Block until scheduled pyramid builds finish (tests and process exit)."""
    with _JOBS_LOCK:
        jobs = list(_JOBS)
        _JOBS.clear()
    for fut in jobs:
        fut.result()


def _forget_job(fut: Future[None]) -> None:
    with _JOBS_LOCK, contextlib.suppress(ValueError):
        _JOBS.remove(fut)


def _shutdown_pyramid_pool() -> None:
    wait_pyramid_jobs()
    global _POOL
    with _POOL_LOCK:
        pool = _POOL
        _POOL = None
    if pool is not None:
        pool.shutdown(wait=False)


atexit.register(_shutdown_pyramid_pool)


def _remember_failed(key: str) -> tuple[int, float]:
    """Record a failed build of *key*; returns ``(consecutive failures, retry window s)``.

    The window is ``FAILED_RETRY_SEC`` doubled per earlier failure, capped at
    ``FAILED_RETRY_MAX_SEC``.
    """
    with _JOBS_LOCK:
        failures = _FAILED.get(key, (0.0, 0))[1] + 1
        window = min(FAILED_RETRY_SEC * 2 ** min(failures - 1, 16), FAILED_RETRY_MAX_SEC)
        _FAILED[key] = (time.monotonic() + window, failures)
        _FAILED.move_to_end(key)
        while len(_FAILED) > _FAILED_MAX:
            _FAILED.popitem(last=False)
        return failures, window


def _failed_locked(key: str) -> bool:
    """True while *key* is inside its retry window. Hold ``_JOBS_LOCK``.

    An expired entry is kept, so its failure count sets the next (longer)
    window, until a build of *key* succeeds or the LRU evicts it.
    """
    entry = _FAILED.get(key)
    return entry is not None and time.monotonic() < entry[0]


def pyramid_build_pending(slug: str, key: str) -> bool:
    """True while a build for ``(slug, key)`` is queued or running."""
    with _JOBS_LOCK:
        return (slug, key) in _PENDING


def pyramid_build_failed(key: str) -> bool:
    """True when a build for *key* failed in this process and its retry window has not ended."""
    with _JOBS_LOCK:
        return _failed_locked(key)


def _run_pyramid_job(ref: str, slug: str, key: str, audio: Path, out: Path) -> None:
    try:
        build_pyramid(ref, key, audio, out)
    except Exception as exc:
        failures, window = _remember_failed(key)
        # Only a key's first failure is a WARNING; repeats back off quietly.
        log.log(
            logging.WARNING if failures == 1 else logging.DEBUG,
            "waveform pyramid build failed for %s (failure %d, retry after %.0f s): %s",
            ref,
            failures,
            window,
            exc,
        )
    finally:
        # Cleared only after os.replace, so "not pending" implies the file exists (#421).
        with _JOBS_LOCK:
            _PENDING.discard((slug, key))


def schedule_pyramid_build(ref: str, key: str, audio: Path, out: Path) -> bool:
    """Queue a background build of *audio* into *out* (2 workers).

    Returns ``True`` when a build is pending or was just queued, and ``False``
    while *key* is inside the retry window of a failed build (``FAILED_RETRY_SEC``,
    doubling per repeat failure up to ``FAILED_RETRY_MAX_SEC``).
    """
    slug = _slug_from_out(out, key)
    job = (slug, key)
    with _JOBS_LOCK:
        if job in _PENDING:
            return True
        if _failed_locked(key):
            return False
        _PENDING.add(job)
    try:
        fut = _pyramid_pool().submit(_run_pyramid_job, ref, slug, key, audio, out)
    except BaseException:
        with _JOBS_LOCK:
            _PENDING.discard(job)
        raise
    with _JOBS_LOCK:
        _JOBS.append(fut)
    fut.add_done_callback(_forget_job)
    return True

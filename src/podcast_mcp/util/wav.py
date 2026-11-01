"""Canonical 16-bit PCM WAV header (RIFF) and the one tolerant WAV reader shared project-wide.

``open_wav`` is where source code opens a WAV with stdlib ``wave``. Python 3.11's ``wave``
rejects WAVE_FORMAT_EXTENSIBLE (``unknown format: 65534``), the header ffmpeg and most
recorders write for more than two channels or more than 16 bits. Python 3.12 accepts it
only when the full 16-byte sub-format GUID is the PCM GUID. ``open_wav`` applies that same
rule on every supported Python: an EXTENSIBLE header whose sub-format GUID is PCM is read,
and any other EXTENSIBLE sub-format (float, Ambisonic, ...) raises ``wave.Error``, as 3.12
does.
"""

from __future__ import annotations

import struct
import wave
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO, cast

PCM_SAMPLE_WIDTH_BYTES = 2
WAV_HEADER_BYTES = 44
# RIFF sizes are unsigned 32-bit; the RIFF chunk size is ``36 + data_size``.
MAX_PCM_WAV_DATA_BYTES = 0xFFFFFFFF - (WAV_HEADER_BYTES - 8)


def pcm_wav_header(data_size: int, sample_rate: int = 48_000, channels: int = 1) -> bytes:
    """Return the 44-byte header for ``data_size`` bytes of 16-bit PCM."""
    if data_size < 0 or data_size > MAX_PCM_WAV_DATA_BYTES:
        raise ValueError(f"PCM payload of {data_size} bytes does not fit a RIFF WAV header")
    block_align = channels * PCM_SAMPLE_WIDTH_BYTES
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + data_size,
        b"WAVE",
        b"fmt ",
        16,
        1,
        channels,
        sample_rate,
        sample_rate * block_align,
        block_align,
        PCM_SAMPLE_WIDTH_BYTES * 8,
        b"data",
        data_size,
    )


_FORMAT_PCM = 1
_FORMAT_EXTENSIBLE = 0xFFFE
# KSDATAFORMAT_SUBTYPE_PCM: the WAVE_FORMAT_EXTENSIBLE sub-format GUID of integer PCM.
PCM_SUBFORMAT_GUID = bytes.fromhex("0100000000001000800000aa00389b71")
_FMT_EXTENSIBLE_BYTES = 40  # format tag .. sub-format GUID
_SUBFORMAT_OFFSET = 24  # the sub-format GUID within the ``fmt `` body


def _extensible_tag_offset(fh: BinaryIO) -> int | None:
    """Offset of the ``fmt `` format tag when it is an integer-PCM EXTENSIBLE header.

    None when the file is not EXTENSIBLE (or the header cannot be walked), which leaves
    every other case to stdlib ``wave``. Raises ``wave.Error`` for an EXTENSIBLE
    sub-format whose GUID is not the PCM GUID.
    """
    start = fh.tell()
    try:
        file_size = fh.seek(0, 2)
        fh.seek(0)
        head = fh.read(12)
        if len(head) < 12 or head[:4] != b"RIFF" or head[8:12] != b"WAVE":
            return None
        offset = 12
        # Every chunk advances the offset by at least its 8-byte header, so the walk ends
        # at EOF; it stops early at ``data`` (stdlib rejects a ``data`` before ``fmt ``).
        while offset + 8 <= file_size:
            fh.seek(offset)
            chunk_id, size = struct.unpack("<4sI", fh.read(8))
            if chunk_id == b"data":
                return None
            if chunk_id != b"fmt ":
                offset += 8 + size + (size & 1)
                continue
            body = fh.read(min(size, _FMT_EXTENSIBLE_BYTES))
            if len(body) < 2 or struct.unpack_from("<H", body)[0] != _FORMAT_EXTENSIBLE:
                return None
            if len(body) < _FMT_EXTENSIBLE_BYTES:
                raise wave.Error("truncated WAVE_FORMAT_EXTENSIBLE header")
            if body[_SUBFORMAT_OFFSET:_FMT_EXTENSIBLE_BYTES] != PCM_SUBFORMAT_GUID:
                raise wave.Error("unsupported WAVE_FORMAT_EXTENSIBLE sub-format")
            return offset + 8
        return None
    finally:
        fh.seek(start)


class _PcmTagPatch:
    """File proxy that reads an integer-PCM EXTENSIBLE format tag as plain PCM."""

    def __init__(self, fh: BinaryIO, tag_offset: int) -> None:
        self._fh = fh
        self._tag_offset = tag_offset

    def read(self, size: int = -1) -> bytes:
        position = self._fh.tell()
        data = bytearray(self._fh.read(size))
        for index, value in enumerate(struct.pack("<H", _FORMAT_PCM)):
            at = self._tag_offset + index - position
            if 0 <= at < len(data):
                data[at] = value
        return bytes(data)

    def tell(self) -> int:
        return self._fh.tell()

    def seek(self, offset: int, whence: int = 0) -> int:
        return self._fh.seek(offset, whence)

    def close(self) -> None:
        """The wrapped file belongs to the caller."""


@contextmanager
def open_wav(source: str | Path | BinaryIO) -> Iterator[wave.Wave_read]:
    """Open a WAV for reading, accepting an integer-PCM WAVE_FORMAT_EXTENSIBLE header.

    ``source`` is a path (opened and closed here) or an open binary file (left open for the
    caller). Raises ``wave.Error`` / ``EOFError`` / ``OSError`` like ``wave.open``.
    """
    if isinstance(source, str | Path):
        with open(source, "rb") as fh, open_wav(fh) as reader:
            yield reader
        return
    tag_offset = _extensible_tag_offset(source)
    stream = source if tag_offset is None else _PcmTagPatch(source, tag_offset)
    reader = wave.Wave_read(cast(BinaryIO, stream))
    try:
        yield reader
    finally:
        reader.close()


def rendered_wav_is_complete(path: Path) -> bool:
    """Whether an uncompressed RIFF/RF64 WAV has its complete, nonempty declared payload.

    Checks container structure and frame alignment without decoding or reading the
    audio payload. This does not detect changed samples or a consistently rewritten
    shorter WAV. Unsupported encodings are not admitted for render-cache reuse.
    """
    try:
        with path.open("rb") as stream:
            return _rendered_wav_is_complete(stream)
    except (OSError, ValueError, struct.error):
        return False


def _rendered_wav_alignment(fmt: bytes) -> int:
    tag, channels, rate, byte_rate, align, bits = struct.unpack_from("<HHIIHH", fmt)
    if tag == _FORMAT_EXTENSIBLE:
        if len(fmt) < 40 or not 22 <= struct.unpack_from("<H", fmt, 16)[0] <= len(fmt) - 18:
            return 0
        valid_bits = struct.unpack_from("<H", fmt, 18)[0]
        if valid_bits > bits or fmt[26:40] != PCM_SUBFORMAT_GUID[2:]:
            return 0
        tag = struct.unpack_from("<H", fmt, 24)[0]
    widths = (8, 16, 24, 32, 64) if tag == 1 else (32, 64) if tag == 3 else ()
    if (
        not channels
        or not rate
        or bits not in widths
        or align != channels * (bits // 8)
        or byte_rate != rate * align
    ):
        return 0
    return align


def _rendered_wav_is_complete(stream: BinaryIO) -> bool:
    physical_end = stream.seek(0, 2)
    stream.seek(0)
    header = stream.read(12)
    if len(header) != 12 or header[8:] != b"WAVE" or header[:4] not in (b"RIFF", b"RF64"):
        return False
    size = struct.unpack_from("<I", header, 4)[0]
    data_size: int | None = None
    table: dict[bytes, list[int]] = {}
    if header[:4] == b"RF64":
        chunk = stream.read(8)
        if size != 0xFFFFFFFF or len(chunk) != 8 or chunk[:4] != b"ds64":
            return False
        size = struct.unpack_from("<I", chunk, 4)[0]
        if not 28 <= size <= 28 + 12 * 64:
            return False
        ds64 = stream.read(size)
        riff_size, data_size, _, entries = struct.unpack_from("<QQQI", ds64)
        if len(ds64) != size or entries > 64 or size != 28 + 12 * entries:
            return False
        for offset in range(28, size, 12):
            name, length = struct.unpack_from("<4sQ", ds64, offset)
            table.setdefault(name, []).append(length)
        stream.seek(size & 1, 1)
        container_end = riff_size + 8
    else:
        container_end = size + 8
    if not stream.tell() <= container_end <= physical_end:
        return False
    align = 0
    found_data = False
    for _ in range(64):
        if stream.tell() == container_end:
            return found_data
        if stream.tell() + 8 > container_end:
            return False
        name, length = struct.unpack("<4sI", stream.read(8))
        if length == 0xFFFFFFFF:
            if name == b"data" and data_size is not None:
                length = data_size
            elif table.get(name):
                length = table[name].pop(0)
            else:
                return False
        end = stream.tell() + length + (length & 1)
        if end > container_end:
            return False
        if name == b"fmt ":
            if align or found_data or not 16 <= length <= 256:
                return False
            align = _rendered_wav_alignment(stream.read(length))
            if not align:
                return False
        elif name == b"data":
            if found_data or not align or not length or length % align:
                return False
            found_data = True
        elif name == b"ds64":
            return False
        stream.seek(end)
    return False

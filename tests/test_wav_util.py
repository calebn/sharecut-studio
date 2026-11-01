from __future__ import annotations

import io
import re
import struct
import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.util.wav import (
    MAX_PCM_WAV_DATA_BYTES,
    PCM_SUBFORMAT_GUID,
    WAV_HEADER_BYTES,
    open_wav,
    pcm_wav_header,
)
from podcast_mcp.util.wav_pcm import decode_integer_pcm


def test_pcm_wav_header_round_trips_through_wave():
    pcm = b"\x00\x00" * 480
    header = pcm_wav_header(len(pcm), 48_000, channels=1)
    assert len(header) == WAV_HEADER_BYTES
    with wave.open(io.BytesIO(header + pcm)) as audio:
        assert audio.getframerate() == 48_000
        assert audio.getnchannels() == 1
        assert audio.getsampwidth() == 2
        assert audio.getnframes() == 480


@pytest.mark.parametrize("size", [-1, MAX_PCM_WAV_DATA_BYTES + 1])
def test_pcm_wav_header_rejects_sizes_outside_riff_range(size):
    with pytest.raises(ValueError, match="RIFF"):
        pcm_wav_header(size)


def test_pcm_wav_header_accepts_largest_riff_payload():
    assert len(pcm_wav_header(MAX_PCM_WAV_DATA_BYTES)) == WAV_HEADER_BYTES


def extensible_wav(
    samples: np.ndarray,
    *,
    rate: int = 48_000,
    width: int = 2,
    subformat: int = 1,
    guid: bytes | None = None,
    mask: int = 0,
    extra_chunk: bytes = b"",
) -> bytes:
    """A WAVE_FORMAT_EXTENSIBLE file: int16/int24 PCM or any other sub-format tag."""
    channels = samples.shape[1]
    if width == 3:
        octets = samples.astype("<i4").tobytes()
        data = b"".join(octets[i : i + 3] for i in range(0, len(octets), 4))
    else:
        data = samples.astype("<i2").tobytes()
    guid = guid or struct.pack("<H", subformat) + PCM_SUBFORMAT_GUID[2:]
    fmt = struct.pack(
        "<HHIIHHHHI16s",
        0xFFFE,
        channels,
        rate,
        rate * channels * width,
        channels * width,
        width * 8,
        22,
        width * 8,
        mask,
        guid,
    )
    body = (
        b"WAVE"
        + extra_chunk
        + b"fmt "
        + struct.pack("<I", len(fmt))
        + fmt
        + b"data"
        + struct.pack("<I", len(data))
        + data
    )
    return b"RIFF" + struct.pack("<I", len(body)) + body


def test_open_wav_reads_extensible_integer_pcm_on_every_python(tmp_path):
    frames = np.arange(-240, 240, dtype=np.int32).reshape(-1, 3) * 1000
    path = tmp_path / "three.wav"
    path.write_bytes(extensible_wav(frames, width=3, mask=0x7))
    with open_wav(path) as audio:
        assert (audio.getnchannels(), audio.getsampwidth()) == (3, 3)
        assert (audio.getframerate(), audio.getnframes()) == (48_000, 160)
        decoded = decode_integer_pcm(audio.readframes(160), width=3, channels=3, dtype="float64")
    np.testing.assert_array_equal(decoded * 8_388_608, frames)


def test_open_wav_reads_extensible_past_a_leading_chunk_and_from_an_open_file(tmp_path):
    frames = np.arange(40, dtype=np.int16).reshape(-1, 4)
    junk = b"LIST" + struct.pack("<I", 3) + b"abc\x00"  # odd size pads to even
    path = tmp_path / "quad.wav"
    path.write_bytes(extensible_wav(frames, extra_chunk=junk))
    with path.open("rb") as fh:
        with open_wav(fh) as audio:
            assert audio.getnchannels() == 4
            audio.setpos(2)
            raw = audio.readframes(1)
        assert fh.tell() > 0 and not fh.closed
    assert np.frombuffer(raw, dtype="<i2").tolist() == [8, 9, 10, 11]


def test_open_wav_leaves_plain_pcm_to_the_stdlib(tmp_path):
    path = tmp_path / "plain.wav"
    path.write_bytes(pcm_wav_header(8, 16_000, 2) + b"\x01\x00\x02\x00\x03\x00\x04\x00")
    with open_wav(path) as audio:
        assert (audio.getframerate(), audio.getnchannels(), audio.getnframes()) == (16_000, 2, 2)


def test_open_wav_rejects_extensible_float(tmp_path):
    path = tmp_path / "float.wav"
    path.write_bytes(extensible_wav(np.zeros((4, 2)), subformat=3))
    with pytest.raises(wave.Error, match="sub-format"), open_wav(path):
        pass


# Same data1 as PCM, different data2: the Ambisonic B-format PCM sub-format.
AMBISONIC_PCM_GUID = struct.pack("<IHH", 1, 0x0721, 0x11D3) + bytes.fromhex("8644c8c1ca000000")
FLOAT_GUID = struct.pack("<IHH", 3, 0, 0x0010) + bytes.fromhex("800000aa00389b71")


def test_open_wav_accepts_exactly_the_standard_pcm_guid(tmp_path):
    path = tmp_path / "pcm.wav"
    path.write_bytes(extensible_wav(np.zeros((4, 2)), guid=PCM_SUBFORMAT_GUID))
    with open_wav(path) as audio:
        assert audio.getnframes() == 4


@pytest.mark.parametrize("guid", [AMBISONIC_PCM_GUID, FLOAT_GUID], ids=["ambisonic", "float"])
def test_open_wav_rejects_every_other_sub_format_guid_like_stdlib_312(tmp_path, guid):
    path = tmp_path / "other.wav"
    path.write_bytes(extensible_wav(np.zeros((4, 2)), guid=guid))
    with pytest.raises(wave.Error, match="sub-format"), open_wav(path):
        pass


def test_open_wav_walks_past_more_than_sixteen_chunks_before_fmt(tmp_path):
    frames = np.arange(8, dtype=np.int16).reshape(-1, 2)
    junk = b"".join(b"JUNK" + struct.pack("<I", 0) for _ in range(40))
    path = tmp_path / "many.wav"
    path.write_bytes(extensible_wav(frames, extra_chunk=junk))
    with open_wav(path) as audio:
        assert audio.getnchannels() == 2
        assert np.frombuffer(audio.readframes(4), dtype="<i2").tolist() == list(range(8))


def test_open_wav_reads_fmt_by_its_declared_size_not_a_fixed_forty_bytes(tmp_path):
    """An 18-byte EXTENSIBLE ``fmt `` is truncated even if the next chunk looks like a GUID."""
    short_fmt = struct.pack("<HHIIHHH", 0xFFFE, 2, 8_000, 32_000, 4, 16, 0)
    lookalike = bytes(6) + PCM_SUBFORMAT_GUID  # lands where a real GUID would start
    body = (
        b"WAVE"
        + b"fmt "
        + struct.pack("<I", len(short_fmt))
        + short_fmt
        + b"LIST"
        + struct.pack("<I", len(lookalike))
        + lookalike
        + b"data"
        + struct.pack("<I", 4)
        + bytes(4)
    )
    path = tmp_path / "short.wav"
    path.write_bytes(b"RIFF" + struct.pack("<I", len(body)) + body)
    with pytest.raises(wave.Error, match="truncated"), open_wav(path):
        pass


def test_open_wav_rejects_a_truncated_extensible_header(tmp_path):
    whole = extensible_wav(np.zeros((4, 2)))
    path = tmp_path / "cut.wav"
    path.write_bytes(whole[: whole.index(b"fmt ") + 8 + 30])
    with pytest.raises(wave.Error, match="truncated"), open_wav(path):
        pass


@pytest.mark.parametrize("payload", [b"", b"RIFF", b"RIFF\x00\x00\x00\x00WAVE", b"not a wav file"])
def test_open_wav_passes_malformed_files_to_the_stdlib_error(tmp_path, payload):
    path = tmp_path / "bad.wav"
    path.write_bytes(payload)
    with pytest.raises((wave.Error, EOFError)), open_wav(path):
        pass


def test_open_wav_gives_up_walking_a_header_without_a_fmt_chunk(tmp_path):
    chunks = b"".join(b"junk" + struct.pack("<I", 0) for _ in range(40))
    path = tmp_path / "nofmt.wav"
    path.write_bytes(b"RIFF" + struct.pack("<I", 4 + len(chunks)) + b"WAVE" + chunks)
    with pytest.raises((wave.Error, EOFError)), open_wav(path):
        pass


def test_source_opens_wavs_only_through_open_wav():
    """Stdlib `wave.open` on media breaks on Python 3.11 for EXTENSIBLE headers (#1183)."""
    root = Path(__file__).parents[1] / "src" / "podcast_mcp"
    offenders = [
        str(path.relative_to(root))
        for path in root.rglob("*.py")
        if path.name != "wav.py"
        and re.search(r"\bwave\.(open|Wave_read)\(", path.read_text("utf-8"))
    ]
    assert offenders == []


@pytest.mark.parametrize("damage", ["zero", "header", "body", "partial", "signature"])
def test_rendered_wav_admission_rejects_incomplete_payload(tmp_path: Path, damage: str) -> None:
    from podcast_mcp.util import wav

    complete = pcm_wav_header(16) + b"\0" * 16
    broken = {
        "zero": b"",
        "header": complete[:44],
        "body": complete[:48],
        "partial": complete[:-1],
        "signature": b"NOPE" + complete[4:],
    }[damage]
    path = tmp_path / "rendered.wav"
    path.write_bytes(broken)
    assert wav.rendered_wav_is_complete(path) is False


def test_rendered_wav_admission_accepts_silence_without_writing(tmp_path: Path) -> None:
    from podcast_mcp.util import wav

    path = tmp_path / "silence.wav"
    complete = pcm_wav_header(16) + b"\0" * 16
    path.write_bytes(complete)
    before = path.stat().st_mtime_ns
    assert wav.rendered_wav_is_complete(path) is True
    assert path.read_bytes() == complete
    assert path.stat().st_mtime_ns == before


def _rendered_container(
    fmt: bytes, data: bytes, *, rf64: bool = False, metadata: bytes = b""
) -> bytes:
    chunks = b"fmt " + struct.pack("<I", len(fmt)) + fmt + metadata
    chunks += b"data" + struct.pack("<I", 0xFFFFFFFF if rf64 else len(data)) + data
    chunks += b"\0" * (len(data) % 2)
    if rf64:
        ds64 = struct.pack("<QQQI", len(chunks) + 40, len(data), 0, 0)
        return b"RF64\xff\xff\xff\xffWAVEds64" + struct.pack("<I", 28) + ds64 + chunks
    return b"RIFF" + struct.pack("<I", len(chunks) + 4) + b"WAVE" + chunks


@pytest.mark.parametrize("tag,bits", [(1, 8), (1, 16), (1, 24), (1, 32), (3, 32), (3, 64)])
@pytest.mark.parametrize("rf64", [False, True])
@pytest.mark.parametrize("extensible", [False, True])
def test_rendered_wav_admission_accepts_render_formats(
    tmp_path: Path, tag: int, bits: int, rf64: bool, extensible: bool
) -> None:
    from podcast_mcp.util import wav

    align = 3 * bits // 8
    fmt = struct.pack(
        "<HHIIHH", 0xFFFE if extensible else tag, 3, 48_000, 48_000 * align, align, bits
    )
    if extensible:
        fmt += struct.pack("<HHI", 22, bits, 0) + struct.pack("<H", tag) + PCM_SUBFORMAT_GUID[2:]
    complete = _rendered_container(fmt, b"\0" * align * 4, rf64=rf64, metadata=b"JUNK\x01\0\0\0X\0")
    path = tmp_path / "render.wav"
    path.write_bytes(complete)
    assert wav.rendered_wav_is_complete(path) is True
    path.write_bytes(complete[:-align])
    assert wav.rendered_wav_is_complete(path) is False


@pytest.mark.parametrize(
    "defect",
    [
        "empty",
        "alignment",
        "rate",
        "tag",
        "short-fmt",
        "container",
        "chunk",
        "rf64-no-ds64",
        "rf64-short-ds64",
        "too-many-chunks",
    ],
)
def test_rendered_wav_admission_rejects_invalid_structure(tmp_path: Path, defect: str) -> None:
    from podcast_mcp.util import wav

    fmt = struct.pack("<HHIIHH", 1, 1, 48_000, 96_000, 2, 16)
    data = b"\0" * 8
    if defect == "empty":
        data = b""
    elif defect == "alignment":
        data += b"X"
    elif defect == "rate":
        fmt = struct.pack("<HHIIHH", 1, 1, 0, 96_000, 2, 16)
    elif defect == "tag":
        fmt = struct.pack("<HHIIHH", 6, 1, 48_000, 96_000, 2, 16)
    elif defect == "short-fmt":
        fmt = b"X"
    metadata = b"JUNK\0\0\0\0" * 65 if defect == "too-many-chunks" else b""
    complete = _rendered_container(fmt, data, metadata=metadata)
    if defect == "container":
        complete = complete[:4] + struct.pack("<I", len(complete) + 100) + complete[8:]
    elif defect == "chunk":
        complete = complete[:40] + struct.pack("<I", 1000) + complete[44:]
    elif defect == "rf64-no-ds64":
        complete = b"RF64\xff\xff\xff\xff" + complete[8:]
    elif defect == "rf64-short-ds64":
        complete = _rendered_container(fmt, data, rf64=True)[:35]
    path = tmp_path / "broken.wav"
    path.write_bytes(complete)
    assert wav.rendered_wav_is_complete(path) is False

"""The plain render reads a WAV's native format from its header, as the decoder would report it (#2082)."""

from __future__ import annotations

import struct
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines import render_clock
from podcast_mcp.engines.audio import At, MixAudio, SourceAudio
from podcast_mcp.engines.ffmpeg import FFmpegEngine

_PCM_GUID = bytes.fromhex("0100000000001000800000aa00389b71")
_FLOAT_GUID = bytes.fromhex("0300000000001000800000aa00389b71")
_RATES = [8000, 16000, 22050, 44100, 48000, 96000]
_FORMATS = {
    "u8": (1, 8, "u8"),
    "s16": (1, 16, "s16"),
    "s24": (1, 24, "s32"),
    "s32": (1, 32, "s32"),
    "f32": (3, 32, "flt"),
    "f64": (3, 64, "dbl"),
}
_LAYOUTS = {1: "mono", 2: "stereo"}
_FRAMES = 128


@dataclass(frozen=True)
class _Wav:
    tag: int = 1
    channels: int = 1
    rate: int = 48000
    bits: int = 16
    extensible: tuple[bytes, int, int] | None = None
    align: int | None = None


def _chunk(chunk_id: bytes, body: bytes, *, pad: bool = True) -> bytes:
    return (
        chunk_id + struct.pack("<I", len(body)) + body + (b"\0" if pad and len(body) % 2 else b"")
    )


def _fmt_chunk(spec: _Wav) -> bytes:
    align = spec.channels * spec.bits // 8 if spec.align is None else spec.align
    body = struct.pack(
        "<HHIIHH",
        0xFFFE if spec.extensible else spec.tag,
        spec.channels,
        spec.rate,
        spec.rate * align,
        align,
        spec.bits,
    )
    if spec.extensible:
        guid, valid_bits, mask = spec.extensible
        body += struct.pack("<HHI", 22, valid_bits, mask) + guid
    return _chunk(b"fmt ", body)


def _riff(*chunks: bytes, magic: bytes = b"RIFF") -> bytes:
    body = b"WAVE" + b"".join(chunks)
    return magic + struct.pack("<I", len(body)) + body


def _samples(name: str, channels: int, frames: int) -> bytes:
    wave = 0.25 * np.sin(np.arange(frames) * 0.2)
    block = np.stack([wave * (0.5**channel) for channel in range(channels)], axis=1)
    match name:
        case "u8":
            return (block * 127 + 128).astype("u1").tobytes()
        case "s16":
            return (block * 32767).astype("<i2").tobytes()
        case "s24":
            wide = (block * (2**23 - 1)).astype("<i4").view("u1").reshape(-1, 4)
            return wide[:, :3].tobytes()
        case "s32":
            return (block * (2**31 - 1)).astype("<i4").tobytes()
        case "f32":
            return block.astype("<f4").tobytes()
        case _:
            return block.astype("<f8").tobytes()


def _write_format(
    path: Path, name: str, channels: int, rate: int, *, frames: int = _FRAMES, extensible: int = 0
) -> Path:
    tag, bits, _ = _FORMATS[name]
    guid = _FLOAT_GUID if tag == 3 else _PCM_GUID
    spec = _Wav(tag, channels, rate, bits, (guid, bits, extensible) if extensible else None)
    path.write_bytes(_riff(_fmt_chunk(spec), _chunk(b"data", _samples(name, channels, frames))))
    return path


def _probed(path: Path) -> tuple[int, str, str]:
    audio = render_clock._native_format(FFmpegEngine().ffmpeg, path)
    return audio.sample_rate, audio.sample_fmt, audio.channel_layout


def _header(path: Path) -> tuple[int, str, str] | None:
    audio = render_clock._wav_format(path)
    return None if audio is None else (audio.sample_rate, audio.sample_fmt, audio.channel_layout)


def _encoded(tmp_path: Path, name: str, *codec: str) -> Path:
    path = tmp_path / name
    subprocess.run(
        [
            FFmpegEngine().ffmpeg,
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=0.2",
            *codec,
            str(path),
        ],
        check=True,
        capture_output=True,
    )
    return path


def _spdif_payload(tmp_path: Path) -> bytes:
    return _encoded(tmp_path, "ac3.spdif", "-ac", "2", "-c:a", "ac3", "-f", "spdif").read_bytes()


def _cases() -> list[tuple[str, int, int, int]]:
    return [
        (name, channels, rate, 0) for name in _FORMATS for channels in _LAYOUTS for rate in _RATES
    ]


@pytest.mark.parametrize(
    ("name", "channels", "rate", "extensible"),
    [
        *_cases(),
        ("s16", 1, 44100, 0x4),
        ("s16", 2, 44100, 0x3),
        ("s24", 2, 48000, 0x3),
        ("f32", 1, 22050, 0x4),
        ("f32", 2, 48000, 0x3),
        ("f64", 2, 96000, 0x3),
    ],
)
def test_wav_header_matches_decode_probe(
    tmp_path: Path, name: str, channels: int, rate: int, extensible: int
) -> None:
    path = _write_format(tmp_path / "a.wav", name, channels, rate, extensible=extensible)
    assert _header(path) == _probed(path) == (rate, _FORMATS[name][2], _LAYOUTS[channels])


def test_wav_header_matches_decode_probe_for_an_odd_padded_list_chunk(tmp_path: Path) -> None:
    path = tmp_path / "list.wav"
    path.write_bytes(
        _riff(
            _chunk(b"LIST", b"INFOx"),
            _fmt_chunk(_Wav(rate=22050)),
            _chunk(b"data", _samples("s16", 1, _FRAMES)),
        )
    )
    assert _header(path) == _probed(path) == (22050, "s16", "mono")


def test_wav_header_matches_decode_probe_for_truncated_data(tmp_path: Path) -> None:
    path = tmp_path / "truncated.wav"
    data = _samples("s16", 2, _FRAMES)
    path.write_bytes(
        _riff(_fmt_chunk(_Wav(channels=2, rate=16000)), b"data" + struct.pack("<I", len(data)))
        + data[: len(data) // 3]
    )
    assert _header(path) == _probed(path) == (16000, "s16", "stereo")


def test_wav_header_of_an_empty_data_chunk_is_the_header_format(tmp_path: Path) -> None:
    path = tmp_path / "empty.wav"
    path.write_bytes(_riff(_fmt_chunk(_Wav(rate=16000)), _chunk(b"data", b"")))
    assert _header(path) == (16000, "s16", "mono")


def _plain(spec: _Wav, payload: bytes) -> bytes:
    return _riff(_fmt_chunk(spec), _chunk(b"data", payload))


_PCM = _samples("s16", 1, _FRAMES)
_STEREO = _samples("s16", 2, _FRAMES)
_OTHER_GUID = bytes.fromhex("0600000000001000800000aa00389b71")
_DEFERRED: dict[str, Callable[[Path], bytes]] = {
    "three channels": lambda _: _plain(_Wav(channels=3), _samples("s16", 3, 8)),
    "six channels": lambda _: _plain(_Wav(channels=6), _samples("s16", 6, 8)),
    "rf64": lambda _: _riff(_fmt_chunk(_Wav()), _chunk(b"data", _PCM), magic=b"RF64"),
    "mp3 in wav": lambda tmp: _encoded(
        tmp, "mp3.wav", "-c:a", "libmp3lame", "-f", "wav"
    ).read_bytes(),
    "ac3 spdif": lambda tmp: _plain(_Wav(channels=2), _spdif_payload(tmp)),
    "ac3 spdif extensible": lambda tmp: _plain(
        _Wav(channels=2, extensible=(_PCM_GUID, 16, 0x3)), _spdif_payload(tmp)
    ),
    "unpadded odd chunk": lambda _: _riff(
        _chunk(b"LIST", b"INFOx", pad=False), _fmt_chunk(_Wav()), _chunk(b"data", _PCM)
    ),
    "data before fmt": lambda _: _riff(_chunk(b"data", _PCM), _fmt_chunk(_Wav())),
    "two fmt chunks": lambda _: _riff(
        _fmt_chunk(_Wav()), _fmt_chunk(_Wav()), _chunk(b"data", _PCM)
    ),
    "extensible bad mask": lambda _: _plain(_Wav(extensible=(_PCM_GUID, 16, 0x3)), _PCM),
    "extensible stereo bad mask": lambda _: _plain(
        _Wav(channels=2, extensible=(_PCM_GUID, 16, 0x4)), _STEREO
    ),
    "extensible valid bits": lambda _: _plain(_Wav(extensible=(_PCM_GUID, 12, 0x4)), _PCM),
    "extensible other subformat": lambda _: _plain(_Wav(extensible=(_OTHER_GUID, 16, 0x4)), _PCM),
    "a-law": lambda _: _plain(_Wav(tag=6, bits=8), _PCM),
    "adpcm": lambda _: _plain(_Wav(tag=2, bits=4, align=256), _PCM),
    "20 bit": lambda _: _plain(_Wav(bits=20, align=3), _PCM),
    "block align": lambda _: _plain(_Wav(align=4), _PCM),
    "zero rate": lambda _: _plain(_Wav(rate=0), _PCM),
    "float 16 bit": lambda _: _plain(_Wav(tag=3, bits=16), _PCM),
    "m4a named wav": lambda tmp: _encoded(tmp, "aac.wav", "-c:a", "aac", "-f", "ipod").read_bytes(),
    "id3 first": lambda _: b"ID3\x04\0\0\0\0\0\0" + _plain(_Wav(), _PCM),
    "no data": lambda _: _riff(_fmt_chunk(_Wav())),
    "short file": lambda _: b"RIFF",
}


@pytest.mark.parametrize("name", list(_DEFERRED))
def test_wav_header_defers_to_probe(tmp_path: Path, name: str) -> None:
    path = tmp_path / "input.wav"
    path.write_bytes(_DEFERRED[name](tmp_path))
    assert _header(path) is None


def test_wav_header_of_a_missing_file_defers_to_probe(tmp_path: Path) -> None:
    assert _header(tmp_path / "missing.wav") is None


_RENDER_PAIRS = [
    *((name, channels, 44100) for name in _FORMATS for channels in _LAYOUTS),
    ("s16", 1, 16000),
    ("f64", 2, 22050),
    ("u8", 1, 8000),
]


@pytest.mark.parametrize(("name", "channels", "rate"), _RENDER_PAIRS)
def test_header_route_render_bytes_equal_probe_route(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str, channels: int, rate: int
) -> None:
    head = _write_format(tmp_path / "head.wav", "s16", 1, 48000, frames=48000)
    child = _write_format(tmp_path / "child.wav", name, channels, rate, frames=rate // 2)
    audio = MixAudio(At(0.0, SourceAudio(head, 0.0, 1.0)), (At(0.5, SourceAudio(child, 0.0, 0.5)),))
    header_out = FFmpegEngine().render_timeline(tmp_path / "header.wav", audio, "anull")
    monkeypatch.setattr(render_clock, "_wav_format", lambda path: None, raising=False)
    probe_out = FFmpegEngine().render_timeline(tmp_path / "probe.wav", audio, "anull")
    assert header_out.read_bytes() == probe_out.read_bytes()

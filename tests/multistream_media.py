"""Media files with several streams, built with the configured ffmpeg at test time (#2104)."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

from podcast_mcp.engines.ffmpeg import FFmpegEngine

_SHOWINFO = re.compile(r"fmt:(\w+) channels:\d+ chlayout:(\S+) rate:(\d+) ")
_SECONDS = 2
_STEREO = "[1:a]pan=stereo|c0=c0|c1=c0[b]"
_FIVE_ONE = "[1:a]pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0[b]"
_NO_DEFAULT = ("-disposition:a:0", "0", "-disposition:a:1", "0")
_SECOND_DEFAULT = ("-disposition:a:0", "0", "-disposition:a:1", "default")

# name: (second stream graph, codec, dispositions); stream 0 is always mono 22050 Hz
_MONO_THEN_WIDER = {
    "kid.ogg": (_STEREO, "flac", ()),
    "none.mkv": (_STEREO, "pcm_s16le", _NO_DEFAULT),
    "two_b.mkv": (_FIVE_ONE, "pcm_s16le", _SECOND_DEFAULT),
}


def ffmpeg_run(*args: object) -> None:
    subprocess.run(
        [FFmpegEngine().ffmpeg, "-v", "error", "-y", *map(str, args)],
        check=True,
        capture_output=True,
    )


def _sine(rate: int, hz: int) -> list[str]:
    return ["-f", "lavfi", "-i", f"sine=f={hz}:r={rate}:d={_SECONDS}"]


def multistream(directory: Path, name: str) -> Path:
    """A two-audio-stream file whose default pick is not its first audio stream, except ``st.mkv``.

    ``st.mkv`` has two stereo streams, 22050 Hz first and 48000 Hz marked default.
    """
    path = directory / name
    if name == "st.mkv":
        ffmpeg_run(
            *_sine(22050, 431),
            *_sine(48000, 330),
            "-filter_complex",
            "[0:a]pan=stereo|c0=c0|c1=c0[a];[1:a]pan=stereo|c0=c0|c1=c0[b]",
            *("-map", "[a]", "-map", "[b]", "-c:a", "pcm_s16le"),
            *_SECOND_DEFAULT,
            path,
        )
        return path
    graph, codec, dispositions = _MONO_THEN_WIDER[name]
    ffmpeg_run(
        *_sine(22050, 431),
        *_sine(48000, 330),
        "-filter_complex",
        graph,
        *("-map", "0:a", "-map", "[b]", "-c:a", codec),
        *dispositions,
        path,
    )
    return path


def first_stream_only(source: Path, directory: Path) -> Path:
    path = directory / f"only{source.suffix}"
    ffmpeg_run("-i", source, "-map", "0:a:0", "-c", "copy", path)
    return path


def first_stream_format(path: Path) -> tuple[int, str, str]:
    """(rate, sample format, layout) of the stream ``[0:a]`` takes in a filter graph."""
    result = subprocess.run(
        [
            FFmpegEngine().ffmpeg,
            "-v",
            "info",
            "-i",
            str(path),
            "-filter_complex",
            "[0:a]ashowinfo@oracle",
            "-frames:a",
            "1",
            "-f",
            "null",
            "-",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    fmt, layout, rate = _SHOWINFO.findall(result.stderr)[-1]
    return int(rate), fmt, layout


def video_only(directory: Path) -> Path:
    path = directory / "video.mp4"
    ffmpeg_run(*("-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.2"), "-c:v", "mpeg4", path)
    return path


def cover_image(directory: Path) -> Path:
    path = directory / "cover.jpg"
    ffmpeg_run(*("-f", "lavfi", "-i", "color=c=black:s=16x16"), "-frames:v", "1", path)
    return path


def video_first_mkv(directory: Path) -> Path:
    path = directory / "video_first.mkv"
    ffmpeg_run(
        *("-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.5"),
        *_sine(22050, 431),
        *("-map", "0:v", "-map", "1:a", "-c:v", "ffv1", "-c:a", "pcm_s16le"),
        path,
    )
    return path


def cover_art_mp3(directory: Path) -> Path:
    path = directory / "cover.mp3"
    ffmpeg_run(
        *_sine(22050, 431),
        "-i",
        cover_image(directory),
        *("-map", "0:a", "-map", "1:v", "-c:a", "libmp3lame", "-c:v", "copy"),
        *("-disposition:v", "attached_pic"),
        path,
    )
    return path

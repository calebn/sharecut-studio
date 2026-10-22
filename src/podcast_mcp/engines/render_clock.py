from __future__ import annotations

import errno
import json
import re
import wave
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from subprocess import CalledProcessError, CompletedProcess
from typing import Any

from podcast_mcp.engines.audio import (
    Audio,
    BoundaryClock,
    CrossfadeAudio,
    MaskAudio,
    MixAudio,
    ObservedAudio,
    OffSpeakerAudio,
    RenderClock,
    SequenceAudio,
    SourceAudio,
    postorder,
)
from podcast_mcp.engines.media_seek import MediaSeek
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.process import run
from podcast_mcp.util.wav import open_wav

_EVENT = re.compile(
    r"\[ashowinfo@restore_(?P<name>\w+) @ [^]]+\] n:(?P<n>\d+) "
    r"pts:[^ ]+ pts_time:[^ ]+ fmt:(?P<fmt>\w+) channels:\d+ "
    r"chlayout:(?P<layout>[^ ]+) rate:(?P<rate>\d+) nb_samples:(?P<count>\d+)"
)
_FORMATS = frozenset(
    f"{base}{planar}" for base in ("u8", "s16", "s32", "s64", "flt", "dbl") for planar in ("", "p")
)


class _NoDecodedFrame(ValueError):
    def __init__(self, path: Path) -> None:
        super().__init__(f"No audio frame decoded from {path.name}")
        self.path = path


def clock_error() -> CodedValueError:
    return CodedValueError(
        "Cannot validate bleed Restore render clock", code="bleed_restore_clock_invalid"
    )


def spawn_or_too_long(
    spawn: Callable[..., CompletedProcess[Any]], cmd: list[str], **kwargs: Any
) -> CompletedProcess[Any]:
    """Run ``cmd`` through ``spawn``; an argument list the OS refuses is ``render_command_too_long``.

    Windows reports ``ERROR_FILENAME_EXCED_RANGE`` (206) as ``FileNotFoundError``, so the code
    is checked before anything reads that as a missing ffmpeg.
    """
    try:
        return spawn(cmd, **kwargs)
    except OSError as error:
        if getattr(error, "winerror", None) == 206 or error.errno == errno.E2BIG:
            raise CodedValueError(
                "This mix has too many inputs for one render command",
                code="render_command_too_long",
            ) from error
        raise


def validate_format(audio: ObservedAudio) -> None:
    if (
        not isinstance(audio.sample_rate, int)
        or isinstance(audio.sample_rate, bool)
        or not 0 < audio.sample_rate < 2**31
        or audio.sample_fmt not in _FORMATS
        or re.fullmatch(r"[A-Za-z0-9_.()+-]+", audio.channel_layout) is None
        or not isinstance(audio.frames, int)
        or isinstance(audio.frames, bool)
        or audio.frames < 0
    ):
        raise clock_error()


def format_filter(audio: ObservedAudio) -> str:
    validate_format(audio)
    return f"aformat=sample_rates={audio.sample_rate}:sample_fmts={audio.sample_fmt}:channel_layouts={audio.channel_layout}"


@dataclass(frozen=True)
class ClockBinding:
    name: str
    filter_index: int
    output_label: str
    consumer_name: str
    consumer_filter_index: int
    consumer_output_label: str


@dataclass(frozen=True)
class _Port:
    audio: ObservedAudio
    destination: str
    pad: str


def _ascii_ports(text: str) -> dict[tuple[str, str], _Port]:
    ports = {}
    for block in text.split("\n\n"):
        owners = re.findall(r"\|\s*([\w@]+)\s*\|", block)
        if not owners:
            continue
        owner = owners[0]
        for line in block.splitlines():
            if "|" not in line:
                continue
            for match in re.finditer(
                r"([\w:]+)--\[(\d+)Hz (\w+):([^]]+)\]--([^: ]+):([^ ]+)",
                line.rsplit("|", 1)[-1],
            ):
                key = owner, match[1]
                audio = ObservedAudio(int(match[2]), 0, match[3], match[4])
                validate_format(audio)
                if key in ports:
                    raise clock_error()
                ports[key] = _Port(audio, match[5], match[6])
    return ports


def native_format(ffmpeg: str, path: Path) -> ObservedAudio:
    """:func:`_native_format` for a Restore render, where a file with no decoded frame breaks the clock."""
    try:
        return _native_format(ffmpeg, path)
    except _NoDecodedFrame as error:
        raise clock_error() from error


def _native_format(ffmpeg: str, path: Path) -> ObservedAudio:
    result = run(
        [
            ffmpeg,
            "-v",
            "info",
            "-i",
            str(path),
            "-af",
            "ashowinfo@restore_descriptor",
            "-frames:a",
            "1",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    formats = {
        ObservedAudio(int(match["rate"]), 0, match["fmt"], match["layout"])
        for match in _EVENT.finditer(result.stderr)
        if match["name"] == "descriptor"
    }
    if len(formats) != 1:
        raise _NoDecodedFrame(path)
    audio = formats.pop()
    validate_format(audio)
    return audio


def _configured_ports(
    ffmpeg: str, ffprobe: str, filters: list[str], input_paths: tuple[Path, ...]
) -> dict[tuple[str, str], _Port]:
    native = {path: _native_format(ffmpeg, path) for path in dict.fromkeys(input_paths)}
    configured = list(filters)
    for i, operation in enumerate(configured):
        match = re.match(r"\[(\d+):a\]", operation)
        if match:
            configured[i] = f"[input_{match[1]}]" + operation[match.end() :]
    if not configured[-1].endswith("[out]"):
        raise clock_error()
    configured[-1] = configured[-1][:-5] + "[config_output]"
    # FFmpeg creates input buffers after the parsed graph; prepending them changes negotiation.
    for i, path in enumerate(input_paths):
        audio = native[path]
        configured.append(
            f"abuffer@input_{i}=sample_rate={audio.sample_rate}:sample_fmt={audio.sample_fmt}:"
            f"channel_layout={audio.channel_layout}:time_base=1/{audio.sample_rate}[descriptor_{i}];"
            f"[descriptor_{i}]atrim@input_trim_{i}[input_{i}]"
        )
    configured.append("[config_output]aformat=sample_fmts=s16[out]")
    result = spawn_or_too_long(
        run,
        [
            ffprobe,
            "-v",
            "error",
            "-f",
            "lavfi",
            "-dumpgraph",
            "1",
            "-show_streams",
            "-print_format",
            "json",
            "-nofind_stream_info",
            ";".join(configured),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return _ascii_ports(result.stderr)


def negotiated_rates(
    ffmpeg: str, ffprobe: str, filters: list[str], input_paths: tuple[Path, ...], names: list[str]
) -> dict[str, int]:
    """Sample rate FFmpeg negotiates on the output link of each filter instance in ``names``."""
    try:
        ports = _configured_ports(ffmpeg, ffprobe, filters, input_paths)
        return {name: ports[name, "default"].audio.sample_rate for name in names}
    except _NoDecodedFrame as error:
        raise CodedValueError(
            f"Cannot read the sample rate of {error.path.name}", code="render_rate_unresolved"
        ) from error
    except (CalledProcessError, KeyError) as error:
        raise CodedValueError(
            "Cannot read the sample rate the render graph negotiates",
            code="render_rate_unresolved",
        ) from error


def configure_observers(
    ffmpeg: str,
    ffprobe: str,
    filters: list[str],
    input_paths: tuple[Path, ...],
    bindings: dict[str, ClockBinding],
    names: list[str],
) -> tuple[dict[str, ObservedAudio], dict[str, str]]:
    try:
        ports = _configured_ports(ffmpeg, ffprobe, filters, input_paths)
    except _NoDecodedFrame as error:
        raise clock_error() from error
    formats = {}
    for name in names:
        try:
            formats[name] = ports[f"ashowinfo@restore_{name}", "default"].audio
        except KeyError as error:
            raise clock_error() from error
    consumers = {}
    for name, binding in bindings.items():
        try:
            before = ports[f"ashowinfo@restore_{binding.consumer_name}", "default"]
            after = before
            visited = set()
            while after.destination.startswith("auto_aresample_"):
                if after.destination in visited:
                    raise clock_error()
                visited.add(after.destination)
                after = ports[after.destination, "default"]
            if after.audio != before.audio:
                consumer = f"consumer_{name}"
                suffix = (
                    f",ashowinfo@restore_{binding.consumer_name}{binding.consumer_output_label}"
                )
                operation = filters[binding.consumer_filter_index]
                if not operation.endswith(suffix):
                    raise clock_error()
                filters[binding.consumer_filter_index] = operation[: -len(suffix)] + (
                    f",{format_filter(before.audio)},ashowinfo@restore_{binding.consumer_name},"
                    f"{format_filter(after.audio)},ashowinfo@restore_{consumer}{binding.consumer_output_label}"
                )
                names.append(consumer)
                formats[consumer] = after.audio
                consumers[name] = consumer
            else:
                consumers[name] = binding.consumer_name
        except KeyError as error:
            raise clock_error() from error
    return formats, consumers


def _pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in items:
        if key == "sample_rate":
            result.setdefault("audio_rates", []).append(value)
        else:
            result[key] = value
    return result


def observed_clock(
    graph_path: Path,
    stderr_path: Path,
    formats: dict[str, ObservedAudio],
    consumers: dict[str, str],
    seek_us: tuple[int, ...],
    source_nodes: tuple[int, ...],
    output_path: Path,
    audio: Audio,
    *,
    partial: bool,
) -> RenderClock:
    try:
        graphs = json.loads(graph_path.read_text(), object_pairs_hook=_pairs)["graphs"]
        if len(graphs) != 1:
            raise clock_error()
        ports = {}
        for fil in graphs[0]["filters"]:
            if fil["filter_name"] != "ashowinfo":
                continue
            if len(fil["filter_outputs"]) != 1:
                raise clock_error()
            port = fil["filter_outputs"][0]
            match = re.fullmatch(r"G\d+_ashowinfo_restore_(\w+)", port["filter_id"])
            if match:
                name = match[1]
                rates = [int(value) for value in port["audio_rates"] if str(value).isdigit()]
                if name in ports or len(rates) != 1:
                    raise clock_error()
                ports[name] = rates[0], port["channel_layout"], port["dest_filter_id"]
        if set(ports) != set(formats):
            raise clock_error()
        for name, expected in formats.items():
            if ports[name][:2] != (expected.sample_rate, expected.channel_layout):
                raise clock_error()
        totals: dict[str, tuple[int, int]] = {}
        with stderr_path.open(errors="replace") as stream:
            for line in stream:
                for match in _EVENT.finditer(line):
                    name = match["name"]
                    if name not in formats:
                        raise clock_error()
                    sequence, count = totals.get(name, (0, 0))
                    expected = formats[name]
                    if (
                        int(match["n"]) != sequence
                        or int(match["count"]) <= 0
                        or (int(match["rate"]), match["fmt"], match["layout"])
                        != (expected.sample_rate, expected.sample_fmt, expected.channel_layout)
                    ):
                        raise clock_error()
                    totals[name] = sequence + 1, count + int(match["count"])
        observed = {
            name: ObservedAudio(
                spec.sample_rate, totals.get(name, (0, 0))[1], spec.sample_fmt, spec.channel_layout
            )
            for name, spec in formats.items()
        }

        def boundary(name: str) -> BoundaryClock:
            return BoundaryClock(observed[name], observed[consumers[name]])

        node_names = sorted(
            (name for name in consumers if name.startswith("node_")), key=lambda name: int(name[5:])
        )
        trims = tuple(boundary(f"trim_{i}") for i in range(len(source_nodes)))
        nodes = tuple(boundary(name) for name in node_names)
        for trim, node_index in zip(trims, source_nodes, strict=True):
            body = nodes[node_index].producer
            if not trim.producer.frames and body.frames:
                raise clock_error()
            if (
                trim.producer.sample_rate == body.sample_rate
                and trim.producer.frames != body.frames
            ):
                raise clock_error()
        output = observed["output"]
        with open_wav(output_path) as wav:
            if (output.sample_rate, output.frames) != (wav.getframerate(), wav.getnframes()):
                raise clock_error()
        delays = tuple(
            (int(name.split("_")[1]), int(name.split("_")[2]), boundary(name))
            for name in consumers
            if name.startswith("delay_")
        )
        clock = RenderClock(trims, nodes, seek_us, output, delays)
        _validate_flow(audio, clock, partial=partial)
        return clock
    except (KeyError, TypeError, ValueError, OSError, wave.Error) as error:
        raise clock_error() from error


def _validate_flow(audio: Audio, clock: RenderClock, *, partial: bool) -> None:
    stack: list[BoundaryClock] = []
    delays = {(node, child): boundary for node, child, boundary in clock.delays}
    index = 0
    for node in postorder(audio):
        if isinstance(node, MaskAudio):
            continue
        boundary = clock.nodes[index]
        producer = boundary.producer
        children = []
        match node:
            case SourceAudio():
                pass
            case OffSpeakerAudio():
                children = [stack.pop()]
                if producer.frames != children[0].consumer.frames:
                    raise clock_error()
            case SequenceAudio():
                count = len(node.tail) + 1
                children = stack[-count:]
                del stack[-count:]
                available = sum(child.consumer.frames for child in children)
                if producer.frames > available or (not partial and producer.frames != available):
                    raise clock_error()
            case CrossfadeAudio():
                right, left = stack.pop(), stack.pop()
                children = [left, right]
                overlap = MediaSeek.at(0).first_sample(node.overlap_sec, producer.sample_rate)
                available = left.consumer.frames + right.consumer.frames
                if min(left.consumer.frames, right.consumer.frames) >= overlap:
                    available -= overlap
                if producer.frames > available or (
                    not partial
                    and min(left.consumer.frames, right.consumer.frames) >= overlap
                    and producer.frames != available
                ):
                    raise clock_error()
            case MixAudio():
                ats = (node.head, *node.tail)
                children = stack[-len(ats) :]
                del stack[-len(ats) :]
                children = [
                    delays[index, child] if at.start_sec > 0 else before
                    for child, (at, before) in enumerate(zip(ats, children, strict=True))
                ]
                available = max(child.consumer.frames for child in children)
                if producer.frames > available or (not partial and producer.frames != available):
                    raise clock_error()
        if any(child.consumer.sample_rate != producer.sample_rate for child in children):
            raise clock_error()
        stack.append(boundary)
        index += 1


def read_render_clock(path: Path) -> RenderClock:
    def observed(item: Any) -> ObservedAudio:
        value = ObservedAudio(**item)
        validate_format(value)
        return value

    def boundary(item: Any) -> BoundaryClock:
        return BoundaryClock(observed(item["producer"]), observed(item["consumer"]))

    try:
        payload = json.loads(path.read_text())
        return RenderClock(
            tuple(boundary(item) for item in payload["trims"]),
            tuple(boundary(item) for item in payload["nodes"]),
            tuple(payload["seek_us"]),
            observed(payload["output"]),
            tuple((node, child, boundary(item)) for node, child, item in payload["delays"]),
        )
    except (KeyError, TypeError, ValueError, OSError) as error:
        raise clock_error() from error

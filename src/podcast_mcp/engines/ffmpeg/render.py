from __future__ import annotations

import json
import math
import tempfile
from contextlib import ExitStack
from dataclasses import asdict
from itertools import pairwise
from pathlib import Path
from typing import TYPE_CHECKING

from podcast_mcp.engines.audio import (
    Audio,
    CrossfadeAudio,
    FrameTransform,
    MaskAudio,
    MixAudio,
    MuteEnvelope,
    OffSpeakerAudio,
    RequestedExtent,
    SequenceAudio,
    SilenceAudio,
    SourceAudio,
    SourceFrameMapping,
    fade_duration,
    postorder,
    sources,
)
from podcast_mcp.engines.effect_filters import graph_rate
from podcast_mcp.engines.ffmpeg import runtime
from podcast_mcp.engines.ffmpeg.mix import _anullsrc
from podcast_mcp.engines.ffmpeg.probe import AudioProbe
from podcast_mcp.engines.ffmpeg.render_filters import (
    ENVELOPE_FRAME_SAMPLES,
    _afade_curve_option,
    _delay_filter,
    _effect_filter,
    _mask_endpoint,
    automatic_gain_expression,
    mute_gain_expression,
)
from podcast_mcp.engines.media_seek import MediaSeek
from podcast_mcp.engines.render_clock import (
    ClockBinding,
    clock_error,
    configure_observers,
    format_filter,
    graph_file,
    negotiated_rates,
    observed_clock,
    spawn_or_too_long,
)
from podcast_mcp.models import (
    AutomationEnvelope,
    FadeCurve,
    ProcessingChain,
)
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.process import DEVNULL, CalledProcessError

if TYPE_CHECKING:
    from podcast_mcp.engines.ffmpeg.host import FFmpegSelf


class RenderMixin:
    def build_track_filter(
        self: FFmpegSelf,
        chain: ProcessingChain | None,
        envelope: AutomationEnvelope | None,
        *,
        timeline_origin_sec: float = 0.0,
    ) -> str:
        if not math.isfinite(timeline_origin_sec) or timeline_origin_sec < 0:
            raise CodedValueError(
                "timeline_origin_sec must be finite and nonnegative", code="invalid_arguments"
            )
        filters: list[str] = []
        if chain:
            for fx in chain.effects:
                if not fx.bypass:
                    rendered = _effect_filter(fx)
                    if rendered is not None:
                        filters.append(rendered)
        if envelope and envelope.points:
            expr = self._volume_expression(envelope, timeline_origin_sec=timeline_origin_sec)
            filters.append(f"asetnsamples=n={ENVELOPE_FRAME_SAMPLES}:p=0")
            filters.append(f"volume=volume='{expr}':eval=frame")
        if not filters:
            return "anull"
        return ",".join(filters)

    def _volume_expression(
        self: FFmpegSelf, envelope: AutomationEnvelope, *, timeline_origin_sec: float = 0.0
    ) -> str:
        pts = sorted(envelope.points, key=lambda p: p.time)
        if not pts:
            return "1"
        if len(pts) == 1:
            return str(pts[0].value)
        clock = "t" if timeline_origin_sec == 0 else f"(t+{timeline_origin_sec})"
        segments = []
        for left, right in pairwise(pts):
            if right.time == left.time:
                continue
            slope = (right.value - left.value) / (right.time - left.time)
            segments.append((right.time, f"{left.value}+({clock}-{left.time})*{slope}"))

        def tree(lo: int, hi: int) -> str:
            if hi - lo == 1:
                return segments[lo][1]
            mid = (lo + hi) // 2
            return f"if(lt({clock},{segments[mid - 1][0]}),{tree(lo, mid)},{tree(mid, hi)})"

        if not segments:
            return f"if(lt({clock},{pts[0].time}),{pts[0].value},{pts[-1].value})"
        return (
            f"if(lt({clock},{pts[0].time}),{pts[0].value},"
            f"if(lt({clock},{pts[-1].time}),{tree(0, len(segments))},{pts[-1].value}))"
        )

    def _fade_chain(
        self: FFmpegSelf,
        seg_duration: float,
        fade_in_sec: float,
        fade_out_sec: float,
        fade_in_curve: FadeCurve = FadeCurve.LINEAR,
        fade_out_curve: FadeCurve = FadeCurve.LINEAR,
    ) -> list[str]:
        parts: list[str] = []
        if fade_in_sec > 0:
            d = fade_duration(seg_duration, fade_in_sec)
            parts.append(f"afade=t=in:st=0:d={d}{_afade_curve_option(fade_in_curve)}")
        if fade_out_sec > 0:
            d = fade_duration(seg_duration, fade_out_sec)
            st = max(0.0, seg_duration - d)
            parts.append(f"afade=t=out:st={st}:d={d}{_afade_curve_option(fade_out_curve)}")
        return parts

    def _mute_chain(
        self: FFmpegSelf,
        seg_duration: float,
        mute_spans: tuple[MuteEnvelope, ...],
        *,
        sample_rate: int,
        source_start: float = 0.0,
        origin: int = 0,
    ) -> list[str]:
        """Gain that ramps to zero over each region's fade-out and back over its fade-in.

        ``mute_spans`` are seconds after ``source_start``; ``origin`` is the source
        sample the segment's first output sample holds (``MediaSeek.first_sample``).
        They never overlap (``mute_regions.mute_spans_for_source_window``). A region
        too short for both fades is muted outright.
        """
        from podcast_mcp.engines.mute_regions import sample_mute_envelopes

        envelopes = sample_mute_envelopes(
            mute_spans, seg_duration, sample_rate, source_start=source_start, origin=origin
        )
        if not envelopes:
            return []
        expr = mute_gain_expression(envelopes)
        return [f"aeval=exprs='val(ch)*({expr})':c=same"]

    def render_timeline(
        self: FFmpegSelf,
        output_path: Path,
        audio: Audio,
        af_chain: str,
        *,
        crossfade_curve: str = "tri",
        requested_extent: RequestedExtent | None = None,
        clock_path: Path | None = None,
    ) -> Path:
        """Compile prepared audio with grouped bounded inputs and continuous track FX."""
        if clock_path is None and any(
            isinstance(node, OffSpeakerAudio) for node in postorder(audio)
        ):
            output_path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(
                prefix=".off-speaker-clock-", dir=output_path.parent
            ) as directory:
                return self.render_timeline(
                    output_path,
                    audio,
                    af_chain,
                    crossfade_curve=crossfade_curve,
                    requested_extent=requested_extent,
                    clock_path=Path(directory) / "clock.json",
                )
        output_path.parent.mkdir(parents=True, exist_ok=True)
        leaves = sources(audio)
        n = len(leaves)
        source_paths = [leaf.path.resolve() for leaf in leaves]
        source_ranges: dict[Path, tuple[float, float]] = {}
        for path, seg in zip(source_paths, leaves, strict=True):
            start, end = source_ranges.get(path, (seg.src_start, seg.src_end))
            source_ranges[path] = (min(start, seg.src_start), max(end, seg.src_end))
        seeks = {
            path: MediaSeek.at(start, lead_sec=self.audio_start_sec(path))
            for path, (start, _end) in source_ranges.items()
        }
        filters: list[str] = []
        clock_names: list[str] = []
        bindings: dict[str, ClockBinding] = {}
        automatic_filters: list[tuple[int, OffSpeakerAudio, int]] = []
        root_indices: dict[str, int] = {}
        node_order = [node for node in postorder(audio) if not isinstance(node, MaskAudio)]
        source_node_indices = [
            i for i, node in enumerate(node_order) if isinstance(node, SourceAudio)
        ]

        def observer(name: str) -> str:
            if clock_path is None:
                return ""
            clock_names.append(name)
            return f",ashowinfo@restore_{name}"

        def bind(name: str, output_label: str) -> None:
            if clock_path is not None:
                bindings[name] = ClockBinding(
                    name, len(filters) - 1, output_label, name, len(filters) - 1, output_label
                )

        split_labels = [""] * n
        # A delay can stop FFmpeg from negotiating the forced rate back through atrim.
        # An explicit resample before trimming keeps each recording on the forced grid.
        forced = graph_rate(af_chain)
        resample = f"aresample={forced}" if forced else ""
        for input_index, path in enumerate(source_ranges):
            segment_indices = [i for i, p in enumerate(source_paths) if p == path]
            labels = [f"[src_in{input_index}_{i}]" for i in range(len(segment_indices))]
            if len(labels) > 1:
                head = f"{resample}," if resample else ""
                filters.append(f"[{input_index}:a]{head}asplit={len(labels)}{''.join(labels)}")
            else:
                filters.append(f"[{input_index}:a]{resample or 'anull'}{labels[0]}")
            for segment_index, label in zip(segment_indices, labels, strict=True):
                split_labels[segment_index] = label

        for i, seg in enumerate(leaves):
            seek = seeks[source_paths[i]]
            filters.append(
                f"{split_labels[i]}atrim=start={seek.offset(seg.src_start)}:"
                f"end={seek.offset(seg.src_end)},asetpts=PTS-STARTPTS{observer(f'trim_{i}')}[src{i}]"
            )
            bind(f"trim_{i}", f"[src{i}]")

        src_labels = [f"[src{i}]" for i in range(n)]
        fill_args = self._mix_fills(
            leaves,
            filters,
            src_labels,
            source_paths=source_paths,
            source_ranges=source_ranges,
        )

        seg_labels: list[str] = []
        source_rates: dict[Path, int] = {}
        for i, seg in enumerate(leaves):
            path = source_paths[i]
            seek = seeks[path]
            dur = seg.src_end - seg.src_start
            chain = self._fade_chain(
                dur, seg.fade_in_sec, seg.fade_out_sec, seg.fade_in_curve, seg.fade_out_curve
            )
            if seg.mute_spans:
                if path not in source_rates:
                    source_rates[path] = self.probe(path).sample_rate
                chain.extend(
                    self._mute_chain(
                        dur,
                        seg.mute_spans,
                        sample_rate=source_rates[path],
                        source_start=seg.src_start,
                        origin=seek.first_sample(seg.src_start, source_rates[path]),
                    )
                )
            if seg.gain_db:
                chain.append(f"volume={seg.gain_db}dB")
            body = ",".join(chain) if chain else "anull"
            filters.append(
                f"{src_labels[i]}{body}{observer(f'node_{source_node_indices[i]}')}[a{i}]"
            )
            bind(f"node_{source_node_indices[i]}", f"[a{i}]")
            root_indices[f"[a{i}]"] = source_node_indices[i]
            seg_labels.append(f"[a{i}]")

        leaf_labels = iter(seg_labels)
        node_labels: list[str] = []
        next_label = 0
        silence_probe: AudioProbe | None = None

        def emit(inputs: str, operation: str) -> str:
            nonlocal next_label
            label = f"[node{next_label}]"
            next_label += 1
            filters.append(f"{inputs}{operation}{label}")
            return label

        delays: list[tuple[int, str, float, str, str]] = []

        def compile_audio() -> str:
            nonlocal silence_probe
            node_index = 0
            for node in postorder(audio):
                match node:
                    case SourceAudio():
                        node_labels.append(next(leaf_labels))
                    case OffSpeakerAudio():
                        automatic_filters.append((len(filters), node, node_index))
                        node_labels.append(
                            emit(node_labels.pop(), "aeval=exprs='val(ch)*(1)':c=same")
                        )
                    case MaskAudio():
                        if (
                            node.clock is None
                            or node.first_source_frame is None
                            or node.source_rate is None
                        ):
                            raise clock_error()

                        selected = "+".join(
                            f"gte(n,{_mask_endpoint(start, node.source_rate, node.first_source_frame, node.source_transforms)})*lt(n,{_mask_endpoint(end, node.source_rate, node.first_source_frame, node.source_transforms)})"
                            for start, end in node.windows
                        )
                        context = format_filter(node.clock.producer)
                        consumer = format_filter(node.clock.consumer)
                        body_label = node_labels.pop()
                        body_index = root_indices[body_label]
                        mask_name = f"mask_{body_index}"
                        masked = emit(
                            body_label,
                            f"{context},aeval=exprs='val(ch)*(1-min(1,{selected}))':c=same,{context},{consumer}{observer(mask_name)}",
                        )
                        binding = bindings[f"node_{body_index}"]
                        bindings[binding.name] = ClockBinding(
                            binding.name,
                            binding.filter_index,
                            binding.output_label,
                            mask_name,
                            len(filters) - 1,
                            masked,
                        )
                        root_indices[masked] = body_index
                        node_labels.append(masked)
                    case SequenceAudio():
                        child_count = len(node.tail) + 1
                        labels = node_labels[-child_count:]
                        del node_labels[-child_count:]
                        node_labels.append(emit("".join(labels), f"concat=n={len(labels)}:v=0:a=1"))
                    case CrossfadeAudio():
                        right = node_labels.pop()
                        left = node_labels.pop()
                        node_labels.append(
                            emit(
                                left + right,
                                f"acrossfade=d={node.overlap_sec}:c1={crossfade_curve}:c2={crossfade_curve}",
                            )
                        )
                    case MixAudio():
                        ats = (node.head, *node.tail)
                        child_labels = node_labels[-len(ats) :]
                        del node_labels[-len(ats) :]
                        labels = []
                        for child_index, (at, label) in enumerate(
                            zip(ats, child_labels, strict=True)
                        ):
                            if at.start_sec > 0:
                                delay_name = f"delay_{node_index}_{child_index}"
                                inputs, observed = label, observer(delay_name)
                                label = emit(
                                    inputs,
                                    f"adelay@pin_{len(delays)}=1S:all=1,asetpts=N/SR/TB{observed}",
                                )
                                delays.append(
                                    (len(filters) - 1, inputs, at.start_sec, observed, label)
                                )
                                bind(delay_name, label)
                            labels.append(label)
                        if len(labels) == 1:
                            node_labels.append(labels[0])
                        else:
                            node_labels.append(
                                emit(
                                    "".join(labels),
                                    f"amix=inputs={len(labels)}:duration=longest:normalize=0,asetpts=N/SR/TB,"
                                    "asetnsamples=n=1024:p=0",
                                )
                            )
                    case SilenceAudio():
                        if silence_probe is None:
                            silence_probe = (
                                self.probe(source_paths[0])
                                if source_paths
                                else AudioProbe(
                                    0.0, 48000, 2, audio_start_sec=0.0, rebases_audio_reads=False
                                )
                            )
                        probe = silence_probe
                        layout = f"{probe.channels}c"
                        node_labels.append(
                            emit(
                                "",
                                f"{_anullsrc(probe.sample_rate, layout)},"
                                f"atrim=end_sample={int(node.duration_sec * probe.sample_rate)}",
                            )
                        )
                if not isinstance(node, MaskAudio):
                    if not isinstance(node, SourceAudio) and clock_path is not None:
                        label = f"[clock_{node_index}]"
                        filters.append(
                            f"{node_labels.pop()}anull{observer(f'node_{node_index}')}{label}"
                        )
                        bind(f"node_{node_index}", label)
                        root_indices[label] = node_index
                        node_labels.append(label)
                    node_index += 1
            return node_labels[0]

        combined = compile_audio()
        final_chain = af_chain or "anull"
        if requested_extent is not None:
            seconds = requested_extent.seconds
            final_chain += f",apad=whole_dur={seconds},atrim=duration={seconds}"
        filters.append(f"{combined}{final_chain}{observer('output')}[out]")

        input_args: list[str] = []
        for path, (_start, end) in source_ranges.items():
            input_args.extend([*seeks[path].input_args(end), "-i", str(path)])
        input_args.extend(fill_args)
        input_paths = tuple(
            Path(input_args[i + 1]) for i, option in enumerate(input_args) if option == "-i"
        )

        def render_command(scratch: ExitStack | Path) -> list[str]:
            graph = ";".join(filters)
            file = graph_file(graph, scratch)
            graph_args = (
                ["-filter_complex", graph] if file is None else ["-/filter_complex", str(file)]
            )
            return [self.ffmpeg, "-y", *input_args, *graph_args, "-map", "[out]", str(output_path)]

        if delays:
            pinned = negotiated_rates(
                self.ffmpeg,
                self.ffprobe,
                filters,
                input_paths,
                [f"adelay@pin_{k}" for k in range(len(delays))],
            )
            for k, (index, inputs, start_sec, observed, label) in enumerate(delays):
                filters[index] = (
                    f"{inputs}{_delay_filter(start_sec, pinned[f'adelay@pin_{k}'])}{observed}{label}"
                )
        if clock_path is None:
            with ExitStack() as stack:
                spawn_or_too_long(
                    runtime.run, render_command(stack), check=True, capture_output=True
                )
        else:
            clock_path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(
                prefix=".restore-clock-", dir=clock_path.parent
            ) as directory:
                raw_graph = Path(directory) / "graph.json"
                stderr_path = Path(directory) / "stderr.log"
                formats, consumers = configure_observers(
                    self.ffmpeg,
                    self.ffprobe,
                    filters,
                    input_paths,
                    bindings,
                    clock_names,
                )
                for filter_index, node, node_index in automatic_filters:
                    body_nodes = [
                        child for child in postorder(node.body) if not isinstance(child, MaskAudio)
                    ]
                    body_first = node_index - len(body_nodes)
                    primary_index = next(
                        body_first + i
                        for i, child in enumerate(body_nodes)
                        if child is node.primary
                    )
                    leaf_index = source_node_indices.index(primary_index)
                    if not (
                        node.body is node.primary
                        or (
                            isinstance(node.body, MixAudio)
                            and node.body.head.audio is node.primary
                            and node.body.head.start_sec == 0
                        )
                    ):
                        raise clock_error()
                    trim_rate = formats[f"trim_{leaf_index}"].sample_rate
                    origin = seeks[source_paths[leaf_index]].first_sample(
                        node.primary.src_start, trim_rate
                    )
                    path_names = [f"trim_{leaf_index}", f"node_{primary_index}"]
                    if node.body is not node.primary:
                        path_names.append(f"node_{node_index - 1}")
                    rates = [trim_rate]
                    for name in path_names:
                        rates.extend(
                            (formats[name].sample_rate, formats[consumers[name]].sample_rate)
                        )

                    mapping = SourceFrameMapping(
                        trim_rate,
                        origin,
                        tuple(FrameTransform(before, after) for before, after in pairwise(rates)),
                    )
                    gain = automatic_gain_expression(node.envelopes, mapping, node.bypass_windows)
                    filters[filter_index] = filters[filter_index].replace(
                        "val(ch)*(1)", f"val(ch)*({gain})"
                    )
                cmd = render_command(Path(directory))
                observed_cmd = [
                    cmd[0],
                    "-print_graphs_file",
                    str(raw_graph),
                    "-print_graphs_format",
                    "json",
                    *cmd[1:],
                ]
                with stderr_path.open("wb") as stderr:
                    result = spawn_or_too_long(
                        runtime.run, observed_cmd, stdout=DEVNULL, stderr=stderr
                    )
                if result.returncode:
                    with stderr_path.open("rb") as error_stream:
                        error_stream.seek(0, 2)
                        error_stream.seek(
                            max(0, error_stream.tell() - runtime.PCM_STDERR_TAIL_BYTES)
                        )
                        raise CalledProcessError(
                            result.returncode, observed_cmd, stderr=error_stream.read()
                        )
                clock = observed_clock(
                    raw_graph,
                    stderr_path,
                    formats,
                    consumers,
                    tuple(seeks[path].source_seek_us for path in source_paths),
                    tuple(source_node_indices),
                    output_path,
                    audio,
                    partial=requested_extent is not None,
                )
                clock_path.write_text(json.dumps(asdict(clock)))
        return output_path

    def _mix_fills(
        self: FFmpegSelf,
        leaves: list[SourceAudio],
        filters: list[str],
        src_labels: list[str],
        *,
        source_paths: list[Path],
        source_ranges: dict[Path, tuple[float, float]],
    ) -> list[str]:
        """Sum each segment's ``fill_path`` under it; returns the fill inputs' ffmpeg args.

        A fill input is a WAV on the audio-relative clock, so it is read through a lead-free
        ``MediaSeek`` over the same bounds and trimmed to the same range, and both land on
        the same samples. The sum is converted back to the media decoder's sample format, so
        where the fill is digital silence every later filter sees exactly the samples it would
        without the fill.
        """
        groups: dict[tuple[Path, Path], list[int]] = {}
        for i, seg in enumerate(leaves):
            if seg.fill_path is not None:
                groups.setdefault((seg.fill_path, source_paths[i]), []).append(i)
        first_input = len(source_ranges)
        args: list[str] = []
        formats: dict[Path, str | None] = {}
        for k, ((fill, media), indices) in enumerate(groups.items()):
            seek = MediaSeek.at(source_ranges[media][0], lead_sec=0.0)
            args.extend([*seek.input_args(source_ranges[media][1]), "-i", str(fill)])
            labels = [f"[fill_in{k}_{j}]" for j in range(len(indices))]
            splitter = f"asplit={len(labels)}" if len(labels) > 1 else "anull"
            filters.append(f"[{first_input + k}:a]{splitter}{''.join(labels)}")
            if media not in formats:
                formats[media] = self.probe(media).sample_fmt
            restore = f",aformat=sample_fmts={formats[media]}" if formats[media] else ""
            for i, label in zip(indices, labels, strict=True):
                seg = leaves[i]
                filters.append(
                    f"{label}atrim=start={seek.offset(seg.src_start)}:"
                    f"end={seek.offset(seg.src_end)},asetpts=PTS-STARTPTS[fill{i}]"
                )
                filters.append(
                    f"{src_labels[i]}[fill{i}]amix=inputs=2:normalize=0:duration=first"
                    f"{restore}[srcfill{i}]"
                )
                src_labels[i] = f"[srcfill{i}]"
        return args

    def filter_audio(
        self: FFmpegSelf,
        input_path: Path,
        output_path: Path,
        af: str,
        *,
        sample_rate: int | None = None,
        channels: int | None = None,
    ) -> Path:
        """Apply an FFmpeg audio filter graph, preserving rate/channels by default."""
        output_path.parent.mkdir(parents=True, exist_ok=True)
        probe = self.probe(input_path)
        out_rate = sample_rate if sample_rate is not None else probe.sample_rate
        out_ch = channels if channels is not None else probe.channels
        cmd = [
            self.ffmpeg,
            "-y",
            "-i",
            str(input_path),
            "-af",
            af,
            "-ar",
            str(out_rate),
            "-ac",
            str(out_ch),
            str(output_path),
        ]
        runtime.run(cmd, check=True, capture_output=True)
        return output_path

    def generate_tone(
        self: FFmpegSelf,
        dest: Path,
        *,
        duration_sec: float,
        freq_hz: float = 220.0,
        sample_rate: int = 48000,
        gain_db: float = 0.0,
    ) -> Path:
        dest.parent.mkdir(parents=True, exist_ok=True)
        cmd = [
            self.ffmpeg,
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={freq_hz}:duration={duration_sec}",
            "-ar",
            str(sample_rate),
            "-ac",
            "1",
        ]
        if gain_db != 0.0:
            cmd.extend(["-af", f"volume={gain_db}dB"])
        cmd.append(str(dest))
        runtime.run(cmd, check=True, capture_output=True)
        return dest

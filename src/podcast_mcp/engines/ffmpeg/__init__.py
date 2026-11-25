from __future__ import annotations

import json
import math
import re
import tempfile
import threading
from collections.abc import Callable, Iterable, Iterator
from contextlib import ExitStack, suppress
from dataclasses import asdict
from itertools import pairwise
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np

from podcast_mcp.engines.audio import (
    AFADE_CURVE_NAMES,
    Audio,
    CrossfadeAudio,
    FrameTransform,
    MaskAudio,
    MixAudio,
    MuteEnvelope,
    MuteSampleEnvelope,
    OffSpeakerAudio,
    RequestedExtent,
    SequenceAudio,
    SilenceAudio,
    SourceAudio,
    SourceFrameMapping,
    SourceMuteEnvelope,
    delay_frames,
    fade_duration,
    postorder,
    sources,
)
from podcast_mcp.engines.effect_filters import format_effect, graph_rate
from podcast_mcp.engines.ffmpeg import runtime
from podcast_mcp.engines.ffmpeg.decode import (
    PCM_STREAM_CHUNK_FRAMES as PCM_STREAM_CHUNK_FRAMES,
)
from podcast_mcp.engines.ffmpeg.decode import (
    PCM_STREAM_TIMEOUT_SEC as PCM_STREAM_TIMEOUT_SEC,
)
from podcast_mcp.engines.ffmpeg.decode import (
    PCM_WINDOW_TIMEOUT_SEC as PCM_WINDOW_TIMEOUT_SEC,
)
from podcast_mcp.engines.ffmpeg.decode import DecodeMixin
from podcast_mcp.engines.ffmpeg.diagnostics import DiagnosticsMixin
from podcast_mcp.engines.ffmpeg.encode import EncodeMixin
from podcast_mcp.engines.ffmpeg.filter_log import decoded_no_frames, filter_log_text
from podcast_mcp.engines.ffmpeg.loudness import LoudnessMixin
from podcast_mcp.engines.ffmpeg.mix import (
    MixMixin,
    _anullsrc,
)
from podcast_mcp.engines.ffmpeg.mix import (
    headroom_trim_db as headroom_trim_db,
)
from podcast_mcp.engines.ffmpeg.mix import (
    logged_headroom_trim_db as logged_headroom_trim_db,
)
from podcast_mcp.engines.ffmpeg.probe import (
    LATE_MPEG_AUDIO_MESSAGE as LATE_MPEG_AUDIO_MESSAGE,
)
from podcast_mcp.engines.ffmpeg.probe import (
    MAX_PROBED_AUDIO_EXTENT_SEC as MAX_PROBED_AUDIO_EXTENT_SEC,
)
from podcast_mcp.engines.ffmpeg.probe import (
    AudioProbe as AudioProbe,
)
from podcast_mcp.engines.ffmpeg.probe import (
    LateMpegAudioError as LateMpegAudioError,
)
from podcast_mcp.engines.ffmpeg.probe import ProbeMixin
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
    EpisodeProject,
    FadeCurve,
    ProcessingChain,
    ProcessingEffect,
    Track,
)
from podcast_mcp.util import process
from podcast_mcp.util.binaries import (
    IN_PROCESS_LABEL,
    FFmpegPair,
    FFmpegPairResolutionError,
    in_process_problem,
)
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.process import (
    DEVNULL,
    PIPE,
    CalledProcessError,
    TimeoutExpired,
)

ENVELOPE_FRAME_SAMPLES = 256


def mute_gain_expression(envelopes: tuple[MuteSampleEnvelope, ...]) -> str:
    gains: list[tuple[str, str]] = []
    for samples in envelopes:
        first, last = samples.first, samples.last
        fade_out, fade_in = samples.fade_out, samples.fade_in
        floor = samples.gain
        if fade_out + fade_in > last - first:
            gains.append((str(first), f"if(gte(n,{first})*lt(n,{last}),{floor:g},1)"))
            continue
        span = 1.0 - floor
        expr = "1"
        if fade_in > 0:
            expr = (
                f"if(between(n,{last - fade_in},{last}),"
                f"{floor:g}+{span:g}*(n-({last - fade_in}))/{fade_in},1)"
            )
        expr = f"if(between(n,{first + fade_out},{last - fade_in}),{floor:g},{expr})"
        if fade_out > 0:
            expr = (
                f"if(between(n,{first},{first + fade_out}),"
                f"1-{span:g}*(n-({first}))/{fade_out},{expr})"
            )
        gains.append((str(first), expr))
    if not gains:
        return "1"

    def interval_tree(items: list[tuple[str, str]]) -> str:
        if len(items) == 1:
            return items[0][1]
        middle = len(items) // 2
        return (
            f"if(lt(n,{items[middle][0]}),"
            f"{interval_tree(items[:middle])},{interval_tree(items[middle:])})"
        )

    return interval_tree(gains)


def automatic_gain_expression(
    envelopes: tuple[SourceMuteEnvelope, ...],
    mapping: SourceFrameMapping,
    bypass_windows: tuple[tuple[float, float], ...] = (),
) -> str:
    gains = []
    for envelope in envelopes:
        first, fall, rise, last = (
            mapping.endpoint(envelope.start),
            mapping.endpoint(envelope.start + envelope.fade_out_sec),
            mapping.endpoint(envelope.end - envelope.fade_in_sec),
            mapping.endpoint(envelope.end),
        )
        if fall > rise:
            fall, rise = first, last
        falling = f"({fall}-n)/{fall - first}" if fall > first else "0"
        rising = f"(n-{rise})/{last - rise}" if last > rise else "1"
        gains.append(
            f"if(lt(n,{first}),1,if(lt(n,{fall}),{falling},if(lt(n,{rise}),0,if(lt(n,{last}),{rising},1))))"
        )
    gain = gains[0] if gains else "1"
    for other in gains[1:]:
        gain = f"min({gain},{other})"
    if bypass_windows:
        selected = "+".join(
            f"gte(n,{mapping.endpoint(start, ceil=True)})*lt(n,{mapping.endpoint(end, ceil=True)})"
            for start, end in bypass_windows
        )
        gain = f"if({selected},1,{gain})"
    return gain


# 3: use the completed graph's true-peak summary for headroom trim (#855).
# 4: premixes cached with trim 0.0 from an unmeasured peak must re-mix (#2890).
MIX_SEMANTICS_REV = 4

MASTER_SEMANTICS_REV = 1


def _sample_frame_expression(offset: int, source_rate: int) -> str:
    sign = "-" if offset < 0 else ""
    return f"{sign}floor({abs(offset)}*s/{source_rate}+0.5)"


def _delay_filter(delay_sec: float, sample_rate: int) -> str:
    """Silence of ``delay_sec`` in front of the audio, with timestamps renumbered by sample.

    Placed on ``round(delay_sec * rate)`` samples, as the evaluation does (#2025, #2456).
    ``sample_rate`` is the rate the render graph negotiates at this delay: the leading
    ``aformat`` resamples the audio to it before ``adelay``, so the pin never moves the rate
    the mix runs at.
    The trailing ``aformat`` keeps ``adelay``'s out-link at that rate when a filter downstream
    of the mix forces another rate and the dry run disagrees with the real run (#2082).

    When ``atrim`` has cut the first frame on a seeked input, ``adelay`` emits its lead-in
    frames with no timestamp (``NOPTS``), and a later ``apad`` or ``atrim`` drops them: a
    1 s lead-in shrinks to 2048 samples. ``asetpts=N/SR/TB`` restamps every frame from
    its sample count, so the silence keeps its length.
    """
    pin = f"aformat=sample_rates={sample_rate}"
    frames = delay_frames(delay_sec, sample_rate)
    return f"{pin},adelay=delays={frames}S:all=1,asetpts=N/SR/TB,{pin}"


def _afade_curve_option(curve: FadeCurve) -> str:
    return "" if curve is FadeCurve.LINEAR else f":curve={AFADE_CURVE_NAMES[curve]}"


def _effect_filter(fx: ProcessingEffect) -> str | None:
    """Format one supported processing effect; preserve order in the caller."""
    return format_effect(fx.effect, fx.params)


def _mask_endpoint(
    seconds: float, rate: int, origin: int, transforms: tuple[FrameTransform, ...]
) -> str:
    if transforms:
        return str(SourceFrameMapping(rate, 0, transforms).endpoint(seconds, ceil=True))
    return _sample_frame_expression(math.ceil(seconds * rate) - origin, rate)


class FFmpegEngine(EncodeMixin, MixMixin, DiagnosticsMixin, LoudnessMixin, ProbeMixin, DecodeMixin):
    def __init__(
        self,
        ffmpeg: str | None = None,
        ffprobe: str | None = None,
        *,
        _admitted_pair: FFmpegPair | None = None,
    ) -> None:
        pair = _admitted_pair or runtime.resolve_ffmpeg_pair(ffmpeg, ffprobe)
        self.ffmpeg = pair.ffmpeg
        self.ffprobe = pair.ffprobe
        self.source = pair.source
        self._listed_names_cache: dict[str, set[str]] = {}

    @staticmethod
    def astats(path: Path, *, ffmpeg: str | None = None) -> dict[str, float | int | None]:
        """Objective per-file health stats via ffmpeg's astats filter.

        Call on the class. Instance binary overrides do not apply.

        Some fields (e.g. Crest factor, Dynamic range) are only printed once in the
        per-channel section for mono audio, not repeated under "Overall" - we take the
        last occurrence of each label across the filter's own lines rather than slicing
        to the "Overall" section, so both kinds of fields are captured correctly.
        """
        cmd = [
            ffmpeg or runtime.resolve_ffmpeg(),
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-af",
            "astats=metadata=1:reset=0",
            "-f",
            "null",
            "-",
        ]
        r = runtime.run(cmd, capture_output=True)
        ok = r.returncode == 0 and not decoded_no_frames(r.stderr)
        text = filter_log_text(r.stderr, "astats") if ok else ""

        def _grab(label: str) -> float | None:
            matches = re.findall(
                rf"^[ \t]*{re.escape(label)}:\s*(-?inf|-?[\d.]+)", text, re.MULTILINE
            )
            if not matches:
                return None
            val = matches[-1]
            if val in ("inf", "-inf"):
                return None
            return float(val)

        peak_count = _grab("Peak count")
        return {
            "dc_offset": _grab("DC offset"),
            "peak_level_db": _grab("Peak level dB"),
            "rms_level_db": _grab("RMS level dB"),
            "crest_factor": _grab("Crest factor"),
            "flat_factor": _grab("Flat factor"),
            "peak_count": round(peak_count) if peak_count is not None else None,
            "noise_floor_db": _grab("Noise floor dB"),
            "dynamic_range_db": _grab("Dynamic range"),
        }

    @staticmethod
    def resample_streams(
        chunks: Iterator[np.ndarray], from_rate: int, to_rates: Iterable[int]
    ) -> dict[int, np.ndarray]:
        """Convert mono chunks to each requested rate with state across chunk edges.

        Call on the class. Each converted target resolves its binary through
        ``resolve_ffmpeg_pair``. Instance binary overrides do not apply.
        A source-rate target retains the chunks. A failed conversion raises
        ``CalledProcessError``, as a failed decode does.
        """
        rates = tuple(dict.fromkeys(to_rates))
        converting = [rate for rate in rates if rate != from_rate]
        if not converting:
            return dict.fromkeys(rates, np.concatenate(list(chunks)))
        commands = {
            rate: [
                runtime.resolve_ffmpeg_pair().ffmpeg,
                "-v",
                "error",
                "-f",
                "f32le",
                "-ar",
                str(from_rate),
                "-ac",
                "1",
                "-i",
                "pipe:0",
                "-ar",
                str(rate),
                "-f",
                "f32le",
                "pipe:1",
            ]
            for rate in converting
        }
        processes = {
            rate: runtime.popen(command, stdin=PIPE, stdout=PIPE, stderr=PIPE)
            for rate, command in commands.items()
        }
        kept: list[np.ndarray] = []
        failure: list[BaseException] = []

        def feed() -> None:
            open_pipes = {rate: process.stdin for rate, process in processes.items()}
            try:
                for chunk in chunks:
                    data = np.ascontiguousarray(chunk, dtype="<f4")
                    if from_rate in rates:
                        kept.append(data)
                    payload = data.tobytes()
                    for rate, pipe in list(open_pipes.items()):
                        assert pipe is not None
                        try:
                            pipe.write(payload)
                        except BrokenPipeError:
                            del open_pipes[rate]
            except BaseException as exc:
                failure.append(exc)
            finally:
                for pipe in open_pipes.values():
                    with suppress(BrokenPipeError):
                        assert pipe is not None
                        pipe.close()

        converted: dict[int, tuple[bytes, bytes]] = {}

        def collect(rate: int) -> None:
            process = processes[rate]
            assert process.stdout is not None and process.stderr is not None
            converted[rate] = (process.stdout.read(), process.stderr.read())

        collectors = [
            threading.Thread(target=collect, args=(rate,), daemon=True) for rate in converting
        ]
        feeder = threading.Thread(target=feed, daemon=True)
        for thread in (*collectors, feeder):
            thread.start()
        for thread in (feeder, *collectors):
            thread.join()
        codes = {rate: process.wait() for rate, process in processes.items()}
        if failure:
            raise failure[0]
        for rate, code in codes.items():
            if code != 0:
                raise CalledProcessError(code, commands[rate], stderr=converted[rate][1])
        results = {rate: np.frombuffer(converted[rate][0], dtype="<f4") for rate in converting}
        if from_rate in rates:
            results[from_rate] = np.concatenate(kept)
        return {rate: results[rate] for rate in rates}

    def check_available(self) -> tuple[bool, str]:
        try:
            pair = runtime.resolve_ffmpeg_pair(self.ffmpeg, self.ffprobe, force_refresh=True)
        except FFmpegPairResolutionError as exc:
            return False, str(exc)
        if pair.is_in_process:
            problem = in_process_problem()
            return (True, IN_PROCESS_LABEL) if problem is None else (False, problem)
        return True, "FFmpeg/FFprobe " + ".".join(map(str, pair.version))

    def check_ffprobe_version(self) -> tuple[bool, str]:
        try:
            result = process.run(
                [self.ffprobe, "-version"], capture_output=True, text=True, timeout=10
            )
        except (OSError, TimeoutExpired):
            return False, "ffprobe not found"
        if result.returncode == 0:
            return True, result.stdout.splitlines()[0] if result.stdout else "ok"
        return False, result.stderr or "ffprobe failed"

    def build_track_filter(
        self,
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
        self, envelope: AutomationEnvelope, *, timeline_origin_sec: float = 0.0
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
        self,
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
        self,
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
        self,
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
        self,
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

    def _run_with_progress(
        self,
        argv: list[str],
        *,
        total_sec: float,
        on_progress: Callable[[float, float], None],
        check: bool = True,
    ) -> str:
        """Run ffmpeg with ``-progress pipe:1``, report (done_sec, total_sec), return stderr."""
        cmd = [argv[0], "-nostats", "-progress", "pipe:1", *argv[1:]]
        with tempfile.TemporaryFile() as err, runtime.popen(cmd, stdout=PIPE, stderr=err) as proc:
            try:
                if proc.stdout is None:
                    raise RuntimeError("ffmpeg progress pipe missing")
                for raw in proc.stdout:
                    done = runtime._progress_seconds(raw.decode("utf-8", "replace"))
                    if done is not None:
                        on_progress(min(done, total_sec), total_sec)
                rc = proc.wait()
            except BaseException:
                proc.kill()
                proc.wait()
                raise
            err.seek(0)
            text = err.read().decode("utf-8", "replace")
        if check and rc != 0:
            raise CalledProcessError(rc, cmd, stderr=text)
        return text

    def filter_audio(
        self,
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

    def render_dialogue_track(
        self,
        project: EpisodeProject,
        track: Track,
        output_path: Path,
        defaults: dict,
    ) -> Path:
        from podcast_mcp.engines.timeline_render import render_track_from_timeline

        return render_track_from_timeline(project, track, output_path, defaults, engine=self)

    def generate_tone(
        self,
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


if TYPE_CHECKING:
    from podcast_mcp.engines.ffmpeg.host import FFmpegSelf

    _host_conforms: FFmpegSelf = FFmpegEngine()

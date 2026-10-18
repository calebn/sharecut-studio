from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, replace
from fractions import Fraction
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Literal

from podcast_mcp.edits.bleed_restore import (
    RestoreSupport,
    active_restore_regions,
    restore_gains_for_frames,
    restored_pcm,
)
from podcast_mcp.edits.mute_regions import (
    IgnoredWordRegions,
    mute_spans_for_source_window,
    sample_mute_envelopes,
)
from podcast_mcp.engines.audio import (
    At,
    FrameTransform,
    MuteSampleEnvelope,
    ObservedAudio,
    SourceAudio,
    SourceFrameMapping,
    SourceMuteEnvelope,
    delay_milliseconds,
    rescale_frames,
)
from podcast_mcp.engines.bleed_gate import BleedGatePlan, bleed_gate_payload, build_bleed_gate_plan
from podcast_mcp.engines.ffmpeg import (
    FFmpegEngine,
    automatic_gain_expression,
    mute_gain_expression,
)
from podcast_mcp.engines.media_seek import MediaSeek
from podcast_mcp.engines.render_clock import (
    _EVENT,
    ClockBinding,
    _native_format,
    _pairs,
    clock_error,
    configure_observers,
    format_filter,
)
from podcast_mcp.engines.session_timeline import origin_track_id_for_clip
from podcast_mcp.engines.timeline_render import (
    _room_tone_under_mutes,
    gate_fill_paths,
    render_source_with_chain,
    resolve_clip_audio_path,
    source_fill_mix_filter,
)
from podcast_mcp.engines.transcript_gated_play import _pcm16_wave_info
from podcast_mcp.models import EpisodeProject, Track
from podcast_mcp.util.atomic_file import publish_completed_file
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.util.model_assets import resolve_rnnoise_model
from podcast_mcp.util.process import run
from podcast_mcp.util.project_state import (
    FileRevision,
    file_revision,
    project_state_lock,
    render_lock,
    snapshot_project,
)
from podcast_mcp.util.workspace_paths import resolve_under_workspace


@dataclass(frozen=True)
class ProxyObservation:
    audio: ObservedAudio
    first_timestamp: Fraction = Fraction(0)
    end_timestamp: Fraction = Fraction(0)
    timestamp_discontinuities: int = 0


@dataclass(frozen=True)
class SourceProxyClock:
    native: ProxyObservation
    producer: ObservedAudio
    consumer: ObservedAudio
    prepared: ProxyObservation
    output: ProxyObservation
    policy: Literal["packed-source-proxy-v1"] = "packed-source-proxy-v1"

    @property
    def mapping(self) -> SourceFrameMapping:
        return SourceFrameMapping(
            self.native.audio.sample_rate,
            0,
            (
                FrameTransform(self.native.audio.sample_rate, self.producer.sample_rate),
                FrameTransform(self.producer.sample_rate, self.consumer.sample_rate),
            ),
        )


@dataclass(frozen=True)
class SourceProxySpec:
    clip_id: str
    context_track_id: str
    source: Path
    fill: Path | None
    regions: tuple[tuple[float, float], ...]
    source_start: float
    source_end: float
    ordinary: tuple[MuteSampleEnvelope, ...]
    automatic: tuple[SourceMuteEnvelope, ...]
    room: tuple[At, ...]
    gate: BleedGatePlan
    policy: Literal["packed-source-proxy-v1"] = "packed-source-proxy-v1"


@dataclass(frozen=True)
class _SourceInput:
    path: Path
    seek: MediaSeek | None = None
    end: float | None = None

    def arguments(self) -> list[str]:
        return self.seek.input_args(self.end) if self.seek is not None else []


@dataclass(frozen=True)
class _Dependencies:
    project_json: str
    media: tuple[tuple[Path, FileRevision | None, str | None], ...]
    gate_context: tuple[str, str] | None
    bindings: tuple[tuple[Path, Path], ...]

    @classmethod
    def capture(
        cls,
        project: EpisodeProject,
        paths: tuple[Path, ...],
        context_track_id: str,
        bindings: tuple[tuple[Path, Path], ...],
    ) -> _Dependencies:
        track = project.track_by_id(context_track_id)
        gate_context = None
        if track is not None and track.transcript_gate:
            payload = bleed_gate_payload(project, context_track_id)
            paths += tuple(
                Path(media["path"]).resolve()
                for lane in payload["inputs"]
                for media in lane["media"]
            )
            gate_context = context_track_id, json.dumps(payload, sort_keys=True)
            for lane in payload["inputs"]:
                owner = project.track_by_id(lane["track_id"])
                if owner is None:
                    continue
                recordings = [
                    project.source_by_id(clip["source_id"])
                    if clip.get("source_id")
                    else owner.media
                    for clip in lane["clips"]
                ] or [owner.media]
                for recording in recordings:
                    if recording is not None:
                        logical = project.workspace_path() / Path(recording.path).expanduser()
                        sealed = resolve_under_workspace(project, recording.path)
                        bindings += ((logical, sealed),)
        media = []
        for path in sorted(set(paths)):
            try:
                revision, digest = file_revision(path), sha256_file(path)
            except FileNotFoundError:
                revision, digest = None, None
            media.append((path, revision, digest))
        return cls(
            project.model_dump_json(),
            tuple(media),
            gate_context,
            bindings,
        )

    def validate(self, project: EpisodeProject) -> None:
        with project_state_lock(project):
            if project.model_dump_json() != self.project_json:
                raise _inputs_changed()
            if any(logical.resolve() != sealed for logical, sealed in self.bindings):
                raise _inputs_changed()
            if self.gate_context is not None:
                track_id, payload = self.gate_context
                if json.dumps(bleed_gate_payload(project, track_id), sort_keys=True) != payload:
                    raise _inputs_changed()
            for path, revision, digest in self.media:
                try:
                    changed = file_revision(path) != revision or sha256_file(path) != digest
                except FileNotFoundError:
                    changed = revision is not None or digest is not None
                if changed:
                    raise _inputs_changed()


def _inputs_changed() -> CodedValueError:
    return CodedValueError(
        "Source proxy inputs changed while rendering", code="bleed_restore_inputs_changed"
    )


def _observations(
    graph_path: Path, stderr_path: Path, formats: dict[str, ObservedAudio]
) -> dict[str, ProxyObservation]:
    try:
        graphs = json.loads(graph_path.read_text(), object_pairs_hook=_pairs)["graphs"]
        if len(graphs) != 1:
            raise clock_error()
        clocks = {}
        for node in graphs[0]["filters"]:
            if node["filter_name"] != "ashowinfo":
                continue
            (port,) = node["filter_outputs"]
            match = re.fullmatch(r"G\d+_ashowinfo_restore_(\w+)", port["filter_id"])
            if match is None:
                continue
            name = match[1]
            values = port["audio_rates"]
            rates = [int(value) for value in values if str(value).isdigit()]
            bases = [Fraction(value) for value in values if "/" in str(value)]
            if name in clocks or len(rates) != 1 or len(bases) != 1 or bases[0] <= 0:
                raise clock_error()
            clocks[name] = rates[0], port["channel_layout"], bases[0]
        if set(clocks) != set(formats):
            raise clock_error()
        sequences = dict.fromkeys(formats, 0)
        first_pts: dict[str, Fraction] = {}
        ends: dict[str, Fraction] = {}
        gaps = dict.fromkeys(formats, 0)
        totals = dict.fromkeys(formats, 0)
        with stderr_path.open(errors="replace") as stream:
            for line in stream:
                for event in _EVENT.finditer(line):
                    name = event["name"]
                    expected = formats[name]
                    timestamp = re.search(r"\bpts:(-?\d+)\s+pts_time:", event[0])
                    if (
                        timestamp is None
                        or int(event["n"]) != sequences[name]
                        or int(event["count"]) <= 0
                        or (int(event["rate"]), event["fmt"], event["layout"])
                        != (expected.sample_rate, expected.sample_fmt, expected.channel_layout)
                        or clocks[name][:2] != (expected.sample_rate, expected.channel_layout)
                    ):
                        raise clock_error()
                    count = int(event["count"])
                    pts = int(timestamp[1]) * clocks[name][2]
                    first_pts.setdefault(name, pts)
                    if name in ends and pts != ends[name]:
                        gaps[name] += 1
                    ends[name] = pts + Fraction(count, expected.sample_rate)
                    sequences[name] += 1
                    totals[name] += count
        if any(not count for count in sequences.values()):
            raise clock_error()
        return {
            name: ProxyObservation(
                replace(audio, frames=totals[name]), first_pts[name], ends[name], gaps[name]
            )
            for name, audio in formats.items()
        }
    except (KeyError, TypeError, ValueError, OSError) as error:
        raise clock_error() from error


def _execute(
    engine: FFmpegEngine,
    command: list[str],
    directory: Path,
    name: str,
    formats: dict[str, ObservedAudio],
) -> dict[str, ProxyObservation]:
    graph, stderr = directory / f"{name}.json", directory / f"{name}.stderr"
    with stderr.open("wb") as errors:
        run(
            [
                engine.ffmpeg,
                "-print_graphs_file",
                str(graph),
                "-print_graphs_format",
                "json",
                *command,
            ],
            check=True,
            capture_output=False,
            stderr=errors,
        )
    return _observations(graph, stderr, formats)


def _decode_clock(engine: FFmpegEngine, source: Path, directory: Path) -> ProxyObservation:
    native = _native_format(engine.ffmpeg, source)
    return _execute(
        engine,
        ["-v", "info", "-i", str(source), "-af", "ashowinfo@restore_native", "-f", "null", "-"],
        directory,
        "native",
        {"native": native},
    )["native"]


def _selected_expression(regions: tuple[tuple[int, int], ...]) -> str:
    terms = [f"gte(n,{lo})*lt(n,{hi})" for lo, hi in regions if lo < hi]
    return f"min(1,{'+'.join(terms)})" if terms else "0"


def _gain_filter(expression: str) -> str:
    return f"aeval=exprs='val(ch)*({expression})':c=same"


def _room_filters(
    spec: SourceProxySpec,
    engine: FFmpegEngine,
    inputs: list[_SourceInput],
    filters: list[str],
    first: int,
    last: int,
    rate: int,
) -> str:
    groups: dict[Path, list[tuple[int, SourceAudio]]] = {}
    for index, tile in enumerate(spec.room):
        leaf = tile.audio
        if not isinstance(leaf, SourceAudio):
            raise clock_error()
        groups.setdefault(leaf.path, []).append((index, leaf))
    seeks = {}
    for path, leaves in groups.items():
        start = min(leaf.src_start for _, leaf in leaves)
        end = max(leaf.src_end for _, leaf in leaves)
        seek = MediaSeek.at(start)
        source_index = len(inputs)
        inputs.append(_SourceInput(path, seek, end))
        split_labels = "".join(f"[room_in{index}]" for index, _ in leaves)
        operation = f"asplit={len(leaves)}" if len(leaves) > 1 else "anull"
        filters.append(f"[{source_index}:a]{operation}{split_labels}")
        seeks[path] = seek
    labels = []
    for index, tile in enumerate(spec.room):
        leaf = tile.audio
        if not isinstance(leaf, SourceAudio):
            raise clock_error()
        seek = seeks[leaf.path]
        delay = first + rescale_frames(delay_milliseconds(tile.start_sec), 1000, rate)
        operations = [
            f"atrim=start={seek.offset(leaf.src_start)}:end={seek.offset(leaf.src_end)}",
            "asetpts=PTS-STARTPTS",
            *engine._fade_chain(leaf.src_end - leaf.src_start, leaf.fade_in_sec, leaf.fade_out_sec),
            f"aresample={rate}",
            f"adelay=delays={delay}S:all=1",
            f"atrim=end_sample={last}",
        ]
        label = f"[room{index}]"
        filters.append(f"[room_in{index}]{','.join(operations)}{label}")
        labels.append(label)
    filters.append(
        f"[ordinary]{''.join(labels)}amix=inputs={len(labels) + 1}:normalize=0:duration=first,"
        "ashowinfo@restore_room[room]"
    )
    return "[room]"


def _prepare_graph(
    engine: FFmpegEngine,
    spec: SourceProxySpec,
    native: ProxyObservation,
    af: str,
) -> tuple[list[_SourceInput], list[str], SourceProxyClock, tuple[tuple[int, int], ...]]:
    inputs = [_SourceInput(spec.source)] + (
        [_SourceInput(spec.fill)] if spec.fill is not None else []
    )
    filters = ["[0:a]anull[primary]"]
    if spec.fill is None:
        initial = "[primary]anull"
    else:
        filters.append("[1:a]anull[fill]")
        initial = source_fill_mix_filter(engine, spec.source, "[primary]", "[fill]")
    filters.append(f"{initial},ashowinfo@restore_pre[pre]")
    query = [*filters, f"[pre]{af},ashowinfo@restore_output[out]"]
    binding = ClockBinding("pre", len(filters) - 1, "[pre]", "pre", len(filters) - 1, "[pre]")
    formats, consumers = configure_observers(
        engine.ffmpeg,
        engine.ffprobe,
        query,
        tuple(source.path for source in inputs),
        {"pre": binding},
        ["pre", "output"],
    )
    producer, consumer = formats["pre"], formats[consumers["pre"]]
    filters[-1] = f"{initial},{format_filter(producer)},ashowinfo@restore_pre[pre]"
    native_rate, rate = native.audio.sample_rate, producer.sample_rate
    mapping = SourceFrameMapping(native_rate, 0, (FrameTransform(native_rate, rate),))
    first = rescale_frames(
        MediaSeek.at(0).first_sample(spec.source_start, native_rate), native_rate, rate
    )
    last = rescale_frames(
        min(MediaSeek.at(0).first_sample(spec.source_end, native_rate), native.audio.frames),
        native_rate,
        rate,
    )
    regions = tuple(
        (max(first, mapping.endpoint(lo, ceil=True)), min(last, mapping.endpoint(hi, ceil=True)))
        for lo, hi in spec.regions
    )
    active = f"gte(n,{first})*lt(n,{last})"
    ordinary = tuple(
        MuteSampleEnvelope(
            rescale_frames(e.first, native_rate, rate),
            rescale_frames(e.last, native_rate, rate),
            rescale_frames(e.fade_out, native_rate, rate),
            rescale_frames(e.fade_in, native_rate, rate),
            e.gain,
        )
        for e in spec.ordinary
    )
    pin = format_filter(producer)
    operations = (
        [pin, _gain_filter(f"if({active},{mute_gain_expression(ordinary)},1)"), pin]
        if ordinary
        else ["anull"]
    )
    filters.append(f"[pre]{','.join(operations)}[ordinary]")
    label = "[ordinary]"
    if spec.room:
        label = _room_filters(spec, engine, inputs, filters, first, last, rate)
        query = [*filters, f"{label}{format_filter(consumer)},{af},ashowinfo@restore_output[out]"]
        room_formats, _ = configure_observers(
            engine.ffmpeg,
            engine.ffprobe,
            query,
            tuple(source.path for source in inputs),
            {},
            ["room", "output"],
        )
        room_format = room_formats["room"]
        if room_format.sample_rate != rate:
            raise clock_error()
        pin = format_filter(room_format)
    selected = _selected_expression(regions)
    if spec.automatic:
        gain = automatic_gain_expression(spec.automatic, mapping)
        filters.append(
            f"{label}{pin},{_gain_filter(f'if(({active})*(1-({selected})),{gain},1)')},{pin}[automatic]"
        )
        label = "[automatic]"
    filters.append(f"{label}{pin},__MASK__,{pin},ashowinfo@restore_body[body]")
    filters.append(f"[body]{format_filter(consumer)},{af},ashowinfo@restore_output[out]")
    empty = ProxyObservation(producer)
    return inputs, filters, SourceProxyClock(native, producer, consumer, empty, empty), regions


def _render_pair(
    engine: FFmpegEngine,
    spec: SourceProxySpec,
    af: str,
    directory: Path,
    native: ProxyObservation,
    validate,
) -> tuple[Path, Path, SourceProxyClock]:
    inputs, graph, clock, regions = _prepare_graph(engine, spec, native, af)
    observations = []
    paths = []
    for name, selected in (("whole", "0"), ("without", _selected_expression(regions))):
        validate()
        filters = [line.replace("__MASK__", _gain_filter(f"1-({selected})")) for line in graph]
        names = ["pre", "body", "output"] + (["room"] if spec.room else [])
        formats, _ = configure_observers(
            engine.ffmpeg,
            engine.ffprobe,
            list(filters),
            tuple(source.path for source in inputs),
            {},
            names,
        )
        path = directory / f"{name}.wav"
        command = ["-y"]
        for source in inputs:
            command.extend([*source.arguments(), "-i", str(source.path)])
        command.extend(
            [
                "-filter_complex",
                ";".join(filters),
                "-map",
                "[out]",
                "-acodec",
                "pcm_s16le",
                str(path),
            ]
        )
        observations.append(_execute(engine, command, directory, name, formats))
        paths.append(path)
    if {name: value.audio for name, value in observations[0].items()} != {
        name: value.audio for name, value in observations[1].items()
    }:
        raise clock_error()
    observed = observations[0]
    if (
        observed["pre"].audio.sample_rate == observed["body"].audio.sample_rate
        and observed["pre"].audio.frames != observed["body"].audio.frames
    ):
        raise clock_error()
    if (
        native.audio.sample_rate == observed["pre"].audio.sample_rate
        and native.audio.frames != observed["pre"].audio.frames
    ):
        raise clock_error()
    return paths[0], paths[1], replace(clock, prepared=observed["body"], output=observed["output"])


def _combine(
    baseline: Path, whole: Path, without: Path, spec: SourceProxySpec, clock: SourceProxyClock
) -> None:
    with baseline.open("r+b") as b, whole.open("rb") as w, without.open("rb") as v:
        channels, rate, offset, size = _pcm16_wave_info(b)
        for stream in (w, v):
            c, r, other_offset, other_size = _pcm16_wave_info(stream)
            if (c, r, other_size) != (channels, rate, size):
                raise clock_error()
            if stream.seek(0, 2) < other_offset + other_size:
                raise clock_error()
            stream.seek(other_offset)
        frames = size // (channels * 2)
        if b.seek(0, 2) < offset + size or (
            clock.output.audio.sample_rate,
            clock.output.audio.frames,
        ) != (rate, frames):
            raise clock_error()
        native_rate = clock.native.audio.sample_rate
        first = MediaSeek.at(0).first_sample(spec.source_start, native_rate)
        last = min(
            MediaSeek.at(0).first_sample(spec.source_end, native_rate), clock.native.audio.frames
        )
        supports = tuple(
            RestoreSupport(
                math.ceil(lo * native_rate),
                math.ceil(hi * native_rate),
                max(first, math.ceil(lo * native_rate)),
                min(last, math.ceil(hi * native_rate)),
                0,
                native_rate,
                0,
                clock.consumer.sample_rate,
                transforms=clock.mapping.transforms,
            )
            for lo, hi in spec.regions
            if max(first, math.ceil(lo * native_rate)) < min(last, math.ceil(hi * native_rate))
        )
        b.seek(offset)
        for start in range(0, frames, rate):
            count = min(rate, frames - start)
            raw = b.read(count * channels * 2)
            a, z = w.read(len(raw)), v.read(len(raw))
            if len(a) != len(raw) or len(z) != len(raw):
                raise clock_error()
            result = restored_pcm(
                raw,
                a,
                z,
                channels=channels,
                gate_gains=spec.gate.gains_for_frames(start, count, rate),
                restore_gains=restore_gains_for_frames(
                    supports, start, count, rate, fade_sec=spec.gate.fade_sec
                ),
            )
            b.seek(-len(raw), 1)
            b.write(result)


def render_source_proxy_restore(
    project: EpisodeProject, clip_id: str, output_path: Path, *, engine: FFmpegEngine | None = None
) -> Path:
    """Render one occurrence's bounded source variant without publishing a proxy manifest."""
    eng = engine or FFmpegEngine()
    with render_lock(project):
        snapshot = snapshot_project(project)
        clip = next((clip for clip in snapshot.clips if clip.id == clip_id), None)
        if clip is None:
            raise ValueError(f"clip {clip_id!r} not found")
        destination = snapshot.track_by_id(clip.track_id)
        context = snapshot.track_by_id(origin_track_id_for_clip(snapshot, clip))
        if destination is None or context is None:
            raise ValueError("Source proxy track is missing")
        affected = clip.bleed_restore is not None and bool(clip.bleed_restore.regions)

        def recording_path(track: Track, source_id: str | None) -> Path:
            recording = snapshot.source_by_id(source_id) if source_id else track.media
            if recording is None:
                raise _inputs_changed()
            return snapshot.workspace_path() / Path(recording.path).expanduser()

        if affected:
            source = resolve_clip_audio_path(snapshot, destination, clip)
        elif context.media is not None:
            source = resolve_under_workspace(snapshot, context.media.path)
        else:
            raise ValueError("Source proxy context has no media")
        regions = active_restore_regions(clip, source) if affected else ()
        bindings: tuple[tuple[Path, Path], ...] = (
            (
                recording_path(
                    destination if affected else context, clip.source_id if affected else None
                ),
                source,
            ),
        )
        fill = gate_fill_paths(snapshot, context, [source])[0]
        room = (
            tuple(
                _room_tone_under_mutes(
                    snapshot, destination, clip, clip.source_start, clip.source_end
                )
            )
            if regions
            else ()
        )
        paths = (
            (source,)
            + ((fill,) if fill else ())
            + tuple(tile.audio.path for tile in room if isinstance(tile.audio, SourceAudio))
        )
        if context.media is not None:
            primary = resolve_under_workspace(snapshot, context.media.path)
            paths += (primary,)
            bindings += ((recording_path(context, None), primary),)
        bindings += tuple(
            (recording_path(destination, tile.audio.source_id), tile.audio.path)
            for tile in room
            if isinstance(tile.audio, SourceAudio)
        )
        if fill is not None and context.gate_fill is not None:
            bindings += (
                (snapshot.workspace_path() / Path(context.gate_fill.path).expanduser(), fill),
            )
        if not regions and context.media is not None:
            baseline_fill = gate_fill_paths(snapshot, context, [paths[-1]])[0]
            paths += (baseline_fill,) if baseline_fill is not None else ()
        chain = next((c for c in snapshot.processing_chains if c.track_id == context.id), None)
        recipe = eng.build_track_filter(chain, None)
        if chain is not None:
            for effect in chain.effects:
                if not effect.bypass and effect.effect == "arnndn":
                    logical = (
                        Path(str(effect.params["model"])).expanduser()
                        if effect.params.get("model")
                        else resolve_rnnoise_model()
                    )
                    paths += (logical.resolve(),)
                    bindings += ((logical, logical.resolve()),)
        dependencies = _Dependencies.capture(snapshot, paths, context.id, bindings)
        if output_path.resolve() in {path.resolve() for path, _, _ in dependencies.media}:
            raise ValueError("Source proxy output must not replace an input")
        if (
            regions
            and clip.bleed_restore is not None
            and sha256_file(source) != clip.bleed_restore.source_sha256
        ):
            raise _inputs_changed()

        def validate() -> None:
            dependencies.validate(project)
            try:
                current_recipe = eng.build_track_filter(chain, None)
                current_fill = gate_fill_paths(snapshot, context, [source])[0]
            except OSError as error:
                raise _inputs_changed() from error
            if current_recipe != recipe or current_fill != fill:
                raise _inputs_changed()

        output_path.parent.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(prefix=".source-proxy-", dir=output_path.parent) as temporary:
            directory = Path(temporary)
            baseline = directory / "baseline.wav"
            validate()
            render_source_with_chain(
                snapshot,
                context,
                baseline,
                engine=eng,
                **({"selected_source_path": source} if affected else {}),
            )
            validate()
            if regions:
                gate = (
                    build_bleed_gate_plan(snapshot, context.id, source_clock=True)
                    if context.transcript_gate
                    else BleedGatePlan()
                )
                if gate.attenuation_spans and gate.floor_gain < 1:
                    native = _decode_clock(eng, source, directory)
                    ordinary = mute_spans_for_source_window(
                        clip,
                        0,
                        native.audio.frames / native.audio.sample_rate,
                        extra=IgnoredWordRegions(snapshot).for_clip(clip),
                    )
                    spec = SourceProxySpec(
                        clip.id,
                        context.id,
                        source,
                        fill,
                        regions,
                        clip.source_start,
                        clip.source_end,
                        sample_mute_envelopes(
                            ordinary,
                            native.audio.frames / native.audio.sample_rate,
                            native.audio.sample_rate,
                        ),
                        tuple(
                            SourceMuteEnvelope(
                                e.start_s, e.end_s, e.fade_out_ms / 1000, e.fade_in_ms / 1000
                            )
                            for e in clip.off_speaker_mute_regions
                        ),
                        room,
                        gate,
                    )
                    af = recipe or "anull"
                    whole, without, clock = _render_pair(eng, spec, af, directory, native, validate)
                    if (
                        _native_format(eng.ffmpeg, baseline).channel_layout
                        != clock.output.audio.channel_layout
                    ):
                        raise clock_error()
                    _combine(baseline, whole, without, spec, clock)
            with project_state_lock(project):
                validate()
                publish_completed_file(baseline, output_path, before_replace=validate)
    return output_path

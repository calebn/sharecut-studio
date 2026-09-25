from __future__ import annotations

import json
import re
import shutil
import threading
from collections.abc import Generator
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any

import numpy as np

from podcast_mcp.models import (
    AutomationEnvelope,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    ProcessingChain,
    Track,
)
from podcast_mcp.util.binaries import resolve_ffmpeg, resolve_ffprobe
from podcast_mcp.util.model_assets import resolve_rnnoise_model
from podcast_mcp.util.process import DEVNULL, PIPE, CalledProcessError, TimeoutExpired, popen, run

# Raw float32 PCM decode (waveform pyramid builds and deep-zoom windows).
PCM_STREAM_CHUNK_FRAMES = 1_048_576
PCM_STREAM_TIMEOUT_SEC = 600.0
PCM_WINDOW_TIMEOUT_SEC = 30.0
# Guest-safe input protocols (same whitelist as ``probe(untrusted=True)``).
_UNTRUSTED_PROTOCOLS = "file,crypto,data"


def _escape_filter_value(value: str) -> str:
    """Escape a value (e.g. a filesystem path) for an ffmpeg filtergraph option.

    Needed for values that may contain `:` (filter-option separator, also a
    Windows drive-letter separator) or `'`/`\\`.
    """
    return value.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def _concat_list_entry(path: Path) -> str:
    """Format one ``file '...'`` line for the concat demuxer (quote-safe)."""
    resolved = str(path.resolve())
    if "\n" in resolved or "\r" in resolved:
        raise ValueError(f"media path must not contain newlines: {resolved!r}")
    # FFmpeg concat: escape embedded single quotes as '\''
    escaped = resolved.replace("'", r"'\''")
    return f"file '{escaped}'"


_FONT_CANDIDATES = (
    Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
    Path("/Library/Fonts/Arial.ttf"),
    Path("/System/Library/Fonts/Helvetica.ttc"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    Path("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"),
    Path("/usr/share/fonts/TTF/DejaVuSans.ttf"),
)

_MARK_COLORS = {
    "hypothesis": "red",
    "pending_edit": "orange",
    "comment": "yellow",
    "word": "white",
}

# Visual diagnostics run from the GUI and in parallel pytest-xdist workers.  FFmpeg's
# automatic decoder/filter thread counts can otherwise multiply host CPU and memory
# usage once per rendered track, so image-only diagnostics are deliberately bounded.
_VISUAL_DIAGNOSTIC_THREAD_ARGS = (
    "-threads",
    "1",
    "-filter_threads",
    "1",
    "-filter_complex_threads",
    "1",
)


def _drawtext_font() -> Path | None:
    for path in _FONT_CANDIDATES:
        if path.is_file():
            return path
    return None


def _escape_drawtext(text: str) -> str:
    cleaned = "".join(" " if ord(ch) < 32 else ch for ch in text)
    return cleaned.replace("\\", "\\\\").replace("'", r"\'").replace(":", r"\:").replace("%", r"\%")


def _annotate_vf(
    marks: list[dict[str, Any]],
    *,
    plot_width: int,
    window_start: float | None,
    window_end: float | None,
    font: Path | None,
    use_drawtext: bool,
) -> str:
    """Build a comma-joined vf for time-mark overlay. Empty if nothing to draw."""
    filters: list[str] = []
    for mark in marks:
        x_frac = max(0.0, min(1.0, float(mark.get("x", 0.0))))
        x_px = round(x_frac * plot_width)
        kind = str(mark.get("kind") or "word")
        color = _MARK_COLORS.get(kind, "white")
        filters.append(f"drawbox=x={x_px}:y=0:w=2:h=ih:color={color}@0.85:t=fill")
        label = mark.get("label")
        if use_drawtext and font is not None and label:
            text = _escape_drawtext(str(label)[:24])
            fontfile = _escape_filter_value(str(font))
            filters.append(
                f"drawtext=fontfile={fontfile}:text='{text}':"
                f"x={x_px}+4:y=8:fontsize=14:fontcolor=white:"
                "box=1:boxcolor=black@0.55"
            )
    if use_drawtext and font is not None and window_start is not None and window_end is not None:
        fontfile = _escape_filter_value(str(font))
        left = _escape_drawtext(f"{window_start:.1f}s")
        right = _escape_drawtext(f"{window_end:.1f}s")
        filters.append(
            f"drawtext=fontfile={fontfile}:text='{left}':x=8:y=h-22:"
            "fontsize=12:fontcolor=white:box=1:boxcolor=black@0.55"
        )
        filters.append(
            f"drawtext=fontfile={fontfile}:text='{right}':x=w-72:y=h-22:"
            "fontsize=12:fontcolor=white:box=1:boxcolor=black@0.55"
        )
    return ",".join(filters)


@dataclass
class RenderSegment:
    start: float
    end: float


@dataclass
class PlacedSegment:
    """One source range placed on the output timeline for single-pass rendering.

    `src_start`/`src_end` are seconds into the source file. The three inter-segment
    relationships are mutually exclusive:

    - `gap_before_sec` - silence to insert before this segment (hard timeline gap).
    - `crossfade_prev_sec` - equal-power `acrossfade` overlap into the previous
      audio (a soft clip join where both sides have fades).
    - `overlap_prev_sec` - this segment starts before the previous audio ends and
      is summed (mixed) over the overlapping region. Used for genuine timeline
      overlaps that are not soft joins.

    With all three at 0 the segment simply abuts the previous one (hard concat).
    """

    src_start: float
    src_end: float
    fade_in_sec: float = 0.0
    fade_out_sec: float = 0.0
    gap_before_sec: float = 0.0
    crossfade_prev_sec: float = 0.0
    overlap_prev_sec: float = 0.0
    # Clip-local mute holes (seconds from src_start) rendered as silence.
    mute_spans: tuple[tuple[float, float], ...] = ()


@dataclass
class AudioProbe:
    duration_sec: float
    sample_rate: int
    channels: int


def _read_exact(stream: IO[bytes], size: int) -> bytearray:
    """Read *size* bytes, looping on short pipe reads; shorter only at EOF."""
    buf = bytearray()
    while len(buf) < size:
        part = stream.read(size - len(buf))
        if not part:
            break
        buf += part
    return buf


class FFmpegEngine:
    def __init__(self, ffmpeg: str | None = None, ffprobe: str | None = None) -> None:
        self.ffmpeg = ffmpeg or resolve_ffmpeg()
        self.ffprobe = ffprobe or resolve_ffprobe()
        self._filter_names_cache: set[str] | None = None

    def check_available(self) -> tuple[bool, str]:
        try:
            r = run(
                [self.ffmpeg, "-version"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if r.returncode != 0:
                return False, r.stderr or "ffmpeg failed"
            line = (r.stdout or "").splitlines()[0]
            return True, line
        except FileNotFoundError:
            return False, "ffmpeg not found on PATH"
        except TimeoutExpired:
            return False, "ffmpeg timed out"

    def probe(self, path: Path, *, untrusted: bool = False) -> AudioProbe:
        cmd = [
            self.ffprobe,
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ]
        if untrusted:
            # Guest uploads: do not follow concat:/file: demuxer tricks.
            cmd.extend(["-protocol_whitelist", _UNTRUSTED_PROTOCOLS])
        cmd.append(str(path))
        r = run(cmd, capture_output=True, text=True, check=True)
        data = json.loads(r.stdout)
        stream: dict[str, Any] = next(
            (s for s in data.get("streams", []) if s.get("codec_type") == "audio"),
            {},
        )
        fmt = data.get("format", {})
        duration = float(fmt.get("duration") or stream.get("duration") or 0)
        return AudioProbe(
            duration_sec=duration,
            sample_rate=int(stream.get("sample_rate") or 48000),
            channels=int(stream.get("channels") or 1),
        )

    def stream_pcm_f32(
        self, path: Path, *, chunk_frames: int = PCM_STREAM_CHUNK_FRAMES
    ) -> tuple[int, int, Generator[np.ndarray, None, None]]:
        """Decode *path* to interleaved float32 PCM at its native rate and layout.

        Returns ``(sample_rate, channels, chunks)``; each chunk is a
        ``(frames, channels)`` float32 array of ``chunk_frames`` frames (the
        last may be shorter). ffmpeg starts on first ``next()`` and is killed
        when the generator closes or after ``PCM_STREAM_TIMEOUT_SEC``. A
        non-zero ffmpeg exit raises ``RuntimeError``.
        """
        if chunk_frames < 1:
            raise ValueError("chunk_frames must be >= 1")
        info = self.probe(path, untrusted=True)
        sample_rate, channels = info.sample_rate, max(1, info.channels)
        argv = self._pcm_f32_argv(path, sample_rate, channels)
        chunks = self._read_pcm_f32(
            argv, channels, chunk_frames=chunk_frames, timeout_sec=PCM_STREAM_TIMEOUT_SEC
        )
        return sample_rate, channels, chunks

    def decode_window_f32(
        self, path: Path, start_frame: int, frames: int, sample_rate: int, channels: int
    ) -> np.ndarray:
        """Decode ``frames`` frames from ``start_frame`` as ``(n, channels)`` float32.

        ``n < frames`` only at end of media. Bounded by ``PCM_WINDOW_TIMEOUT_SEC``.
        """
        if start_frame < 0 or frames < 0 or sample_rate < 1 or channels < 1:
            raise ValueError("invalid PCM window")
        if frames == 0:
            return np.zeros((0, channels), dtype=np.float32)
        # ``-frames:a`` counts decoder packets, not samples, so the read below
        # stops at exactly ``frames``; ``-t`` (with slack) only bounds the decode.
        argv = self._pcm_f32_argv(
            path,
            sample_rate,
            channels,
            start_sec=start_frame / sample_rate,
            duration_sec=(frames + 64) / sample_rate,
        )
        parts = list(
            self._read_pcm_f32(
                argv,
                channels,
                chunk_frames=frames,
                timeout_sec=PCM_WINDOW_TIMEOUT_SEC,
                max_frames=frames,
            )
        )
        if not parts:
            return np.zeros((0, channels), dtype=np.float32)
        return np.concatenate(parts)

    def _pcm_f32_argv(
        self,
        path: Path,
        sample_rate: int,
        channels: int,
        *,
        start_sec: float | None = None,
        duration_sec: float | None = None,
    ) -> list[str]:
        argv = [
            self.ffmpeg,
            "-nostdin",
            "-hide_banner",
            "-v",
            "error",
            "-protocol_whitelist",
            _UNTRUSTED_PROTOCOLS,
            "-threads",
            "1",
        ]
        if start_sec:
            argv += ["-ss", f"{start_sec:.9f}"]
        argv += ["-i", str(path)]
        if duration_sec is not None:
            argv += ["-t", f"{duration_sec:.9f}"]
        argv += ["-f", "f32le", "-ac", str(channels), "-ar", str(sample_rate), "pipe:1"]
        return argv

    @staticmethod
    def _read_pcm_f32(
        argv: list[str],
        channels: int,
        *,
        chunk_frames: int,
        timeout_sec: float,
        max_frames: int | None = None,
    ) -> Generator[np.ndarray, None, None]:
        proc = popen(argv, stdout=PIPE, stderr=DEVNULL)
        timer = threading.Timer(timeout_sec, proc.kill)
        timer.daemon = True
        timer.start()
        frame_bytes = 4 * channels
        remaining = max_frames
        try:
            stdout = proc.stdout
            if stdout is None:
                raise RuntimeError("ffmpeg stdout pipe missing")
            while remaining is None or remaining > 0:
                want = chunk_frames if remaining is None else min(chunk_frames, remaining)
                buf = _read_exact(stdout, want * frame_bytes)
                frames = len(buf) // frame_bytes
                if frames:
                    if remaining is not None:
                        remaining -= frames
                    yield np.frombuffer(buf, dtype="<f4", count=frames * channels).reshape(
                        frames, channels
                    )
                if len(buf) < want * frame_bytes:
                    code = proc.wait()
                    if code != 0:
                        raise RuntimeError(f"ffmpeg PCM decode failed (exit {code})")
                    return
        finally:
            timer.cancel()
            if proc.poll() is None:
                proc.kill()
            proc.wait()

    def segments_after_edits(
        self,
        duration: float,
        edits: list[EditDecision],
        track_id: str,
    ) -> list[RenderSegment]:
        removes = sorted(
            [
                e
                for e in edits
                if e.track_id == track_id and e.applied and e.type == EditDecisionType.REMOVE
            ],
            key=lambda e: e.start,
        )
        segments: list[RenderSegment] = []
        cursor = 0.0
        for edit in removes:
            if edit.start > cursor:
                segments.append(RenderSegment(cursor, edit.start))
            cursor = max(cursor, edit.end)
        if cursor < duration:
            segments.append(RenderSegment(cursor, duration))
        if not segments and duration > 0:
            segments.append(RenderSegment(0.0, duration))
        return segments

    def build_track_filter(
        self,
        chain: ProcessingChain | None,
        envelope: AutomationEnvelope | None,
    ) -> str:
        filters: list[str] = []
        if chain:
            for fx in chain.effects:
                if fx.bypass:
                    continue
                if fx.effect == "highpass":
                    f = int(fx.params.get("frequency", 80))
                    filters.append(f"highpass=f={f}")
                elif fx.effect == "acompressor":
                    t = fx.params.get("threshold_db", -18)
                    r = fx.params.get("ratio", 3)
                    attack = fx.params.get("attack_ms", 15)
                    release = fx.params.get("release_ms", 150)
                    makeup = fx.params.get("makeup_db", 0)
                    filt = (
                        f"acompressor=threshold={t}dB:ratio={r}:attack={attack}:release={release}"
                    )
                    if float(makeup) != 0.0:
                        filt = f"{filt}:makeup={float(makeup)}"
                    filters.append(filt)
                elif fx.effect == "loudnorm":
                    i = fx.params.get("integrated_lufs", -16)
                    tp = fx.params.get("true_peak_db", -1.5)
                    filters.append(f"loudnorm=I={i}:TP={tp}:LRA=11")
                elif fx.effect == "afftdn":
                    nr = fx.params.get("nr", 12)
                    nf = fx.params.get("nf", -25)
                    filters.append(f"afftdn=nr={nr}:nf={nf}")
                elif fx.effect == "arnndn":
                    model = fx.params.get("model") or str(resolve_rnnoise_model())
                    filters.append(f"arnndn=m={_escape_filter_value(model)}")
                elif fx.effect == "bandreject":
                    f = fx.params.get("f", 6500)
                    w = fx.params.get("w", 3000)
                    filters.append(f"bandreject=f={f}:width_type=h:w={w}")
                elif fx.effect == "deesser":
                    i = fx.params.get("intensity", 0.5)
                    freq = fx.params.get("frequency", 0.5)
                    filters.append(f"deesser=i={i}:f={freq}")
                elif fx.effect == "agate":
                    t = fx.params.get("threshold_db", -30)
                    r = fx.params.get("range_db", -20)
                    a = fx.params.get("attack_ms", 5)
                    rel = fx.params.get("release_ms", 50)
                    filters.append(f"agate=threshold={t}dB:range={r}dB:attack={a}:release={rel}")
                elif fx.effect == "equalizer":
                    f = fx.params.get("f", 1000)
                    t = fx.params.get("t", "q")
                    w = fx.params.get("w", 1.0)
                    g = fx.params.get("g", 0)
                    filters.append(f"equalizer=f={f}:t={t}:w={w}:g={g}")
        if envelope and envelope.points:
            expr = self._volume_expression(envelope)
            filters.append(f"volume=enable='between(t,0,1e6)':volume='{expr}'")
        if not filters:
            return "anull"
        return ",".join(filters)

    def _volume_expression(self, envelope: AutomationEnvelope) -> str:
        pts = sorted(envelope.points, key=lambda p: p.time)
        if not pts:
            return "1"
        parts: list[str] = []
        for i, pt in enumerate(pts):
            t0 = pt.time
            v0 = pt.value
            if i + 1 < len(pts):
                t1 = pts[i + 1].time
                v1 = pts[i + 1].value
                if t1 > t0:
                    slope = (v1 - v0) / (t1 - t0)
                    parts.append(f"if(between(t,{t0},{t1}),{v0}+(t-{t0})*{slope},{v0})")
                else:
                    parts.append(f"if(gte(t,{t0}),{v0},1)")
            else:
                parts.append(f"if(gte(t,{t0}),{v0},1)")
        return parts[-1] if len(parts) == 1 else "+".join(parts)

    def _fade_chain(
        self,
        seg_duration: float,
        fade_in_sec: float,
        fade_out_sec: float,
    ) -> list[str]:
        parts: list[str] = []
        if fade_in_sec > 0:
            d = min(fade_in_sec, max(seg_duration * 0.5, 0.001))
            parts.append(f"afade=t=in:st=0:d={d}")
        if fade_out_sec > 0:
            d = min(fade_out_sec, max(seg_duration * 0.5, 0.001))
            st = max(0.0, seg_duration - d)
            parts.append(f"afade=t=out:st={st}:d={d}")
        return parts

    def _mute_chain(
        self,
        seg_duration: float,
        mute_spans: tuple[tuple[float, float], ...],
        *,
        sample_rate: int | None = None,
    ) -> list[str]:
        from podcast_mcp.edits.mute_regions import MUTE_FADE_SEC

        gains: list[str] = []
        for start, end in mute_spans:
            a = max(0.0, float(start))
            b = min(seg_duration, float(end))
            if b <= a + 1e-6:
                continue
            span = b - a
            if span < 2 * MUTE_FADE_SEC:
                gains.append(f"if(between(t,{a:.6f},{b:.6f}),0,1)")
                continue
            fade = min(MUTE_FADE_SEC, max(0.001, span / 2.0))
            gains.append(
                f"if(between(t,{a:.6f},{a + fade:.6f}),1-(t-{a:.6f})/{fade:.6f},"
                f"if(between(t,{a + fade:.6f},{b - fade:.6f}),0,"
                f"if(between(t,{b - fade:.6f},{b:.6f}),(t-{b - fade:.6f})/{fade:.6f},1)))"
            )
        if not gains:
            return []
        rate = int(sample_rate) if sample_rate and sample_rate > 0 else 48000
        n = max(1, round(rate / 1000.0))
        expr = "*".join(f"({g})" for g in gains) if len(gains) > 1 else gains[0]
        return [f"asetnsamples=n={n}:p=0", f"volume=volume='{expr}':eval=frame"]

    def _append_fades(
        self,
        af_chain: str,
        seg_duration: float,
        fade_in_sec: float,
        fade_out_sec: float,
    ) -> str:
        parts = [af_chain] if af_chain and af_chain != "anull" else []
        parts.extend(self._fade_chain(seg_duration, fade_in_sec, fade_out_sec))
        return ",".join(parts) if parts else "anull"

    def render_track_to_file(
        self,
        input_path: Path,
        output_path: Path,
        segments: list[RenderSegment],
        crossfade_ms: int,
        af_chain: str,
        *,
        fade_in_sec: float = 0.0,
        fade_out_sec: float = 0.0,
    ) -> Path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if not segments:
            raise ValueError("no segments to render")

        if len(segments) == 1:
            seg = segments[0]
            dur = seg.end - seg.start
            chain = self._append_fades(af_chain, dur, fade_in_sec, fade_out_sec)
            cmd = [
                self.ffmpeg,
                "-y",
                "-ss",
                str(seg.start),
                "-to",
                str(seg.end),
                "-i",
                str(input_path),
                "-af",
                chain,
                str(output_path),
            ]
            run(cmd, check=True, capture_output=True)
            return output_path

        part_files: list[Path] = []
        tmp = output_path.parent / f".parts_{output_path.stem}"
        tmp.mkdir(parents=True, exist_ok=True)

        for i, seg in enumerate(segments):
            part = tmp / f"part_{i:04d}.wav"
            dur = seg.end - seg.start
            fin = fade_in_sec if i == 0 else 0.0
            fout = fade_out_sec if i == len(segments) - 1 else 0.0
            chain = self._append_fades(af_chain, dur, fin, fout)
            cmd = [
                self.ffmpeg,
                "-y",
                "-ss",
                str(seg.start),
                "-to",
                str(seg.end),
                "-i",
                str(input_path),
                "-af",
                chain,
                str(part),
            ]
            run(cmd, check=True, capture_output=True)
            part_files.append(part)

        list_file = tmp / "concat.txt"
        list_file.write_text(
            "\n".join(_concat_list_entry(p) for p in part_files),
            encoding="utf-8",
        )
        cmd = [
            self.ffmpeg,
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(list_file),
            "-c",
            "copy",
            str(output_path),
        ]
        run(cmd, check=True, capture_output=True)
        return output_path

    def render_timeline(
        self,
        input_path: Path,
        output_path: Path,
        placed: list[PlacedSegment],
        af_chain: str,
        *,
        crossfade_curve: str = "tri",
        lead_in_sec: float = 0.0,
    ) -> Path:
        """Assemble placed source segments into the output in a single ffmpeg pass.

        Builds one `-filter_complex` graph that trims each source range, applies
        per-segment fades, joins them handling every inter-segment relationship -
        hard concat, silence-padded concat for gaps, `acrossfade` for soft joins,
        and `adelay`+`amix` for genuine timeline overlaps - then runs the track FX
        chain once over the assembled audio so stateful filters keep continuous
        state across joins.
        """
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if not placed:
            raise ValueError("no segments to render")

        n = len(placed)
        filters: list[str] = []

        if n == 1:
            seg = placed[0]
            filters.append(
                f"[0:a]atrim=start={seg.src_start}:end={seg.src_end},asetpts=PTS-STARTPTS[src0]"
            )
        else:
            split_out = "".join(f"[s{i}]" for i in range(n))
            filters.append(f"[0:a]asplit={n}{split_out}")
            for i, seg in enumerate(placed):
                filters.append(
                    f"[s{i}]atrim=start={seg.src_start}:end={seg.src_end},"
                    f"asetpts=PTS-STARTPTS[src{i}]"
                )

        seg_labels: list[str] = []
        for i, seg in enumerate(placed):
            dur = seg.src_end - seg.src_start
            chain = self._fade_chain(dur, seg.fade_in_sec, seg.fade_out_sec)
            chain.extend(self._mute_chain(dur, seg.mute_spans))
            body = ",".join(chain) if chain else "anull"
            filters.append(f"[src{i}]{body}[a{i}]")
            seg_labels.append(f"[a{i}]")

        needs_pairwise = lead_in_sec > 0 or any(
            seg.gap_before_sec > 0 or seg.crossfade_prev_sec > 0 or seg.overlap_prev_sec > 0
            for seg in placed[1:]
        )

        if n == 1:
            combined = seg_labels[0]
            if lead_in_sec > 0:
                filters.append(f"{combined}adelay={int(lead_in_sec * 1000)}:all=1[asm]")
                combined = "[asm]"
        elif not needs_pairwise:
            cat_in = "".join(seg_labels)
            filters.append(f"{cat_in}concat=n={n}:v=0:a=1[asm]")
            combined = "[asm]"
        else:
            acc = seg_labels[0]
            running_end = lead_in_sec + (placed[0].src_end - placed[0].src_start)
            if lead_in_sec > 0:
                filters.append(f"{acc}adelay={int(lead_in_sec * 1000)}:all=1[acc0]")
                acc = "[acc0]"
            for i in range(1, n):
                seg = placed[i]
                cur = seg_labels[i]
                out_label = f"[acc{i}]"
                seg_dur = seg.src_end - seg.src_start
                if seg.crossfade_prev_sec > 0:
                    cf = max(0.001, min(seg.crossfade_prev_sec, seg_dur * 0.5))
                    filters.append(
                        f"{acc}{cur}acrossfade=d={cf}:c1={crossfade_curve}:"
                        f"c2={crossfade_curve}{out_label}"
                    )
                    running_end += seg_dur - cf
                elif seg.overlap_prev_sec > 0:
                    overlap = min(seg.overlap_prev_sec, running_end)
                    delay_sec = max(0.0, running_end - overlap)
                    delayed = f"[ov{i}]"
                    filters.append(f"{cur}adelay={int(delay_sec * 1000)}:all=1{delayed}")
                    filters.append(
                        f"{acc}{delayed}amix=inputs=2:duration=longest:normalize=0{out_label}"
                    )
                    running_end = max(running_end, delay_sec + seg_dur)
                elif seg.gap_before_sec > 0:
                    pad_label = f"[pad{i}]"
                    filters.append(f"{acc}apad=pad_dur={seg.gap_before_sec}{pad_label}")
                    filters.append(f"{pad_label}{cur}concat=n=2:v=0:a=1{out_label}")
                    running_end += seg.gap_before_sec + seg_dur
                else:
                    filters.append(f"{acc}{cur}concat=n=2:v=0:a=1{out_label}")
                    running_end += seg_dur
                acc = out_label
            combined = acc

        final = af_chain if af_chain else "anull"
        filters.append(f"{combined}{final}[out]")

        cmd = [
            self.ffmpeg,
            "-y",
            "-i",
            str(input_path),
            "-filter_complex",
            ";".join(filters),
            "-map",
            "[out]",
            str(output_path),
        ]
        run(cmd, check=True, capture_output=True)
        return output_path

    def join_audio_parts(
        self,
        part_paths: list[Path],
        output_path: Path,
        *,
        crossfade_ms_between: list[int] | None = None,
        crossfade_curve: str = "tri",
    ) -> Path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if not part_paths:
            raise ValueError("no parts to join")
        if len(part_paths) == 1:
            shutil.copy2(part_paths[0], output_path)
            return output_path

        use_crossfade = (
            crossfade_ms_between is not None
            and len(crossfade_ms_between) == len(part_paths) - 1
            and any(ms > 0 for ms in crossfade_ms_between)
        )

        inputs: list[str] = []
        for p in part_paths:
            inputs.extend(["-i", str(p)])

        if use_crossfade:
            assert crossfade_ms_between is not None
            filters: list[str] = []
            prev_label = "[0:a]"
            for i in range(1, len(part_paths)):
                cf_sec = max(0.001, crossfade_ms_between[i - 1] / 1000.0)
                out_label = "[out]" if i == len(part_paths) - 1 else f"[x{i}]"
                filters.append(
                    f"{prev_label}[{i}:a]acrossfade=d={cf_sec}:c1={crossfade_curve}:c2={crossfade_curve}{out_label}"
                )
                prev_label = out_label
            filter_complex = ";".join(filters)
            cmd = [
                self.ffmpeg,
                "-y",
                *inputs,
                "-filter_complex",
                filter_complex,
                "-map",
                "[out]",
                str(output_path),
            ]
            run(cmd, check=True, capture_output=True)
            return output_path

        list_file = output_path.parent / f".concat_{output_path.stem}.txt"
        try:
            list_file.write_text(
                "\n".join(_concat_list_entry(p) for p in part_paths),
                encoding="utf-8",
            )
            cmd = [
                self.ffmpeg,
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(list_file),
                "-c",
                "copy",
                str(output_path),
            ]
            run(cmd, check=True, capture_output=True)
            return output_path
        finally:
            list_file.unlink(missing_ok=True)

    def pad_end_silence(self, input_path: Path, output_path: Path, duration_sec: float) -> Path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        target = float(duration_sec)
        if target <= 0:
            raise ValueError("duration_sec must be positive")
        cmd = [
            self.ffmpeg,
            "-y",
            "-i",
            str(input_path),
            "-af",
            f"apad=whole_dur={target}",
            "-t",
            f"{target}",
            str(output_path),
        ]
        run(cmd, check=True, capture_output=True)
        return output_path

    def apply_gain(self, input_path: Path, output_path: Path, gain_db: float) -> Path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        cmd = [
            self.ffmpeg,
            "-y",
            "-i",
            str(input_path),
            "-af",
            f"volume={gain_db}dB",
            str(output_path),
        ]
        run(cmd, check=True, capture_output=True)
        return output_path

    def mix_tracks(
        self,
        track_wavs: list[tuple[Path, float]],
        output_path: Path,
    ) -> Path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if not track_wavs:
            raise ValueError("no tracks to mix")
        if len(track_wavs) == 1:
            wav, gain_db = track_wavs[0]
            if float(gain_db) == 0.0:
                shutil.copy2(wav, output_path)
                return output_path
            return self.apply_gain(wav, output_path, float(gain_db))

        inputs: list[str] = []
        filters: list[str] = []
        for i, (wav, gain_db) in enumerate(track_wavs):
            inputs.extend(["-i", str(wav)])
            filters.append(f"[{i}:a]volume={gain_db}dB[a{i}]")
        mix_inputs = "".join(f"[a{i}]" for i in range(len(track_wavs)))
        filters.append(f"{mix_inputs}amix=inputs={len(track_wavs)}:duration=longest[out]")
        fc = ";".join(filters)
        cmd = [self.ffmpeg, "-y", *inputs, "-filter_complex", fc, "-map", "[out]", str(output_path)]
        run(cmd, check=True, capture_output=True)
        return output_path

    def measure_loudnorm_stats(
        self,
        input_path: Path,
        integrated_lufs: float,
        true_peak_db: float,
        lra: float = 11.0,
    ) -> dict[str, float] | None:
        """Pass 1 of two-pass loudnorm: measure input stats as JSON."""
        af = f"loudnorm=I={integrated_lufs}:TP={true_peak_db}:LRA={lra}:print_format=json"
        cmd = [self.ffmpeg, "-i", str(input_path), "-af", af, "-f", "null", "-"]
        r = run(cmd, capture_output=True, text=True)
        text = r.stderr or ""
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            return None
        try:
            data = json.loads(m.group(0))
            return {
                "input_i": float(data["input_i"]),
                "input_tp": float(data["input_tp"]),
                "input_lra": float(data["input_lra"]),
                "input_thresh": float(data["input_thresh"]),
                "target_offset": float(data["target_offset"]),
            }
        except (json.JSONDecodeError, KeyError, ValueError):
            return None

    def measure_loudness_full(self, path: Path) -> dict[str, float | None] | None:
        """Integrated LUFS + true peak + LRA from ebur128 (for post-master QC)."""
        cmd = [
            self.ffmpeg,
            "-i",
            str(path),
            "-af",
            "ebur128=framelog=verbose:peak=true,astats=metadata=1",
            "-f",
            "null",
            "-",
        ]
        r = run(cmd, capture_output=True, text=True)
        text = (r.stderr or "") + (r.stdout or "")
        i_m = re.search(r"\bI:\s*(-?\d+\.?\d*)\s*LUFS", text)
        tp_m = re.search(r"Peak:\s*(-?\d+\.?\d*)\s*dBFS", text)
        lra_m = re.search(r"\bLRA:\s*(-?\d+\.?\d*)\s*LU", text)
        if i_m is None:
            return None
        return {
            "integrated_lufs": float(i_m.group(1)),
            "true_peak_db": float(tp_m.group(1)) if tp_m else None,
            "lra": float(lra_m.group(1)) if lra_m else None,
        }

    def master_loudnorm(
        self,
        input_path: Path,
        output_path: Path,
        integrated_lufs: float = -16.0,
        true_peak_db: float = -1.5,
        lra: float = 11.0,
        *,
        sample_rate: int | None = None,
        channels: int | None = None,
    ) -> Path:
        """Two-pass loudnorm, then restore delivery sample rate/channels.

        FFmpeg's loudnorm filter upsamples to 192 kHz for true-peak work; without
        an explicit ``-ar``/``-ac``, that rate leaks into mastered/export WAVs.

        If the premix loudness range exceeds ``lra``, loudnorm will under-shoot
        ``integrated_lufs`` to honor the LRA/TP ceilings - raise ``lra`` (or
        compress first) when QC shows a systematic LU miss.
        """
        output_path.parent.mkdir(parents=True, exist_ok=True)
        probe = self.probe(input_path)
        out_rate = sample_rate if sample_rate is not None else probe.sample_rate
        out_ch = channels if channels is not None else probe.channels
        stats = self.measure_loudnorm_stats(input_path, integrated_lufs, true_peak_db, lra)
        if stats is None:
            af = f"loudnorm=I={integrated_lufs}:TP={true_peak_db}:LRA={lra}"
        else:
            af = (
                f"loudnorm=I={integrated_lufs}:TP={true_peak_db}:LRA={lra}:"
                f"measured_I={stats['input_i']}:measured_TP={stats['input_tp']}:"
                f"measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}:"
                f"offset={stats['target_offset']}:linear=true"
            )
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
        run(cmd, check=True, capture_output=True)
        return output_path

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
        run(cmd, check=True, capture_output=True)
        return output_path

    def export_audio(
        self,
        wav_path: Path,
        output_path: Path,
        *,
        codec: str | None = None,
        format: str | None = None,
        bitrate_kbps: int | None = None,
        sample_rate: int | None = None,
        channels: int | None = None,
        metadata: dict[str, str] | None = None,
        extra_args: list[str] | None = None,
    ) -> Path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        cmd = [self.ffmpeg, "-y", "-i", str(wav_path)]
        if format:
            cmd.extend(["-f", format])
        if codec:
            cmd.extend(["-codec:a", codec])
        if bitrate_kbps is not None:
            cmd.extend(["-b:a", f"{bitrate_kbps}k"])
        if sample_rate is not None:
            cmd.extend(["-ar", str(sample_rate)])
        if channels is not None:
            cmd.extend(["-ac", str(channels)])
        for key, value in (metadata or {}).items():
            cmd.extend(["-metadata", f"{key}={value}"])
        if extra_args:
            cmd.extend(extra_args)
        cmd.append(str(output_path))
        run(cmd, check=True, capture_output=True)
        return output_path

    def export_mp3(
        self,
        wav_path: Path,
        mp3_path: Path,
        bitrate_kbps: int = 128,
        metadata: dict[str, str] | None = None,
    ) -> Path:
        return self.export_audio(
            wav_path,
            mp3_path,
            codec="libmp3lame",
            bitrate_kbps=bitrate_kbps,
            metadata=metadata,
        )

    def measure_loudness(self, path: Path) -> float | None:
        cmd = [
            self.ffmpeg,
            "-i",
            str(path),
            "-af",
            "ebur128=framelog=verbose",
            "-f",
            "null",
            "-",
        ]
        r = run(cmd, capture_output=True, text=True)
        text = (r.stderr or "") + (r.stdout or "")
        m = re.search(r"I:\s*(-?\d+\.?\d*)\s*LUFS", text)
        if m:
            return float(m.group(1))
        m = re.search(r"Integrated loudness:\s*(-?\d+\.?\d*)", text)
        if m:
            return float(m.group(1))
        return None

    def render_dialogue_track(
        self,
        project: EpisodeProject,
        track: Track,
        output_path: Path,
        defaults: dict,
    ) -> Path:
        from podcast_mcp.engines.timeline_render import render_track_from_timeline

        return render_track_from_timeline(project, track, output_path, defaults, engine=self)

    def extract_segment(
        self,
        src: Path,
        output_path: Path,
        start_sec: float,
        end_sec: float,
        *,
        mute_spans: tuple[tuple[float, float], ...] = (),
    ) -> Path:
        """Extract [start_sec, end_sec] from src into output_path (non-destructive).

        ``mute_spans`` are seconds from the start of the extracted window (same
        clock as ``mute_spans_for_source_window``).
        """
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if mute_spans:
            # Same atrim + asetpts + volume graph as render_timeline so `t` in
            # the mute expression matches output samples (plain -ss/-af does not).
            return self.render_timeline(
                src,
                output_path,
                [
                    PlacedSegment(
                        src_start=max(0.0, start_sec),
                        src_end=end_sec,
                        mute_spans=mute_spans,
                    )
                ],
                "anull",
            )
        duration = max(0.01, end_sec - start_sec)
        cmd = [
            self.ffmpeg,
            "-y",
            "-threads",
            "1",
            "-ss",
            str(max(0.0, start_sec)),
            "-i",
            str(src),
            "-threads",
            "1",
            "-t",
            str(duration),
            "-acodec",
            "pcm_s16le",
            str(output_path),
        ]
        run(cmd, check=True, capture_output=True)
        return output_path

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
        run(cmd, check=True, capture_output=True)
        return dest

    def render_spectrogram(
        self,
        input_path: Path,
        output_png: Path,
        *,
        start_sec: float | None = None,
        duration_sec: float | None = None,
        size: str = "1200x600",
        scale: str = "log",
        legend: bool = True,
    ) -> Path:
        """Render a spectrogram PNG (hum, sibilance, room resonance, clipping are visible here).

        ``legend=False`` keeps the x-axis linear across the full image (needed when
        grounding JSON events to pixel x).
        """
        output_png.parent.mkdir(parents=True, exist_ok=True)
        inp = input_path
        tmp: Path | None = None
        if start_sec is not None and duration_sec is not None:
            tmp = output_png.with_suffix(".segment.wav")
            self.extract_segment(inp, tmp, start_sec, start_sec + duration_sec)
            inp = tmp
        legend_flag = "1" if legend else "0"
        cmd = [
            self.ffmpeg,
            "-y",
            *_VISUAL_DIAGNOSTIC_THREAD_ARGS,
            "-i",
            str(inp),
            "-lavfi",
            f"showspectrumpic=s={size}:scale={scale}:legend={legend_flag}",
            str(output_png),
        ]
        run(cmd, check=True, capture_output=True)
        if tmp is not None:
            tmp.unlink(missing_ok=True)
        return output_png

    def render_showwavespic(
        self,
        input_path: Path,
        output_png: Path,
        *,
        start_sec: float | None = None,
        duration_sec: float | None = None,
        size: str = "1200x200",
        colors: str = "0x4a9eff",
    ) -> Path:
        """Render a waveform PNG for an audio file or segment."""
        output_png.parent.mkdir(parents=True, exist_ok=True)
        inp = input_path
        tmp: Path | None = None
        if start_sec is not None and duration_sec is not None:
            tmp = output_png.with_suffix(".segment.wav")
            self.extract_segment(inp, tmp, start_sec, start_sec + duration_sec)
            inp = tmp
        cmd = [
            self.ffmpeg,
            "-y",
            *_VISUAL_DIAGNOSTIC_THREAD_ARGS,
            "-i",
            str(inp),
            "-filter_complex",
            f"showwavespic=s={size}:colors={colors}",
            "-frames:v",
            "1",
            str(output_png),
        ]
        run(cmd, check=True, capture_output=True)
        if tmp is not None:
            tmp.unlink(missing_ok=True)
        return output_png

    def render_stacked_showwavespic(
        self,
        input_paths: list[Path],
        output_png: Path,
        *,
        size: str = "1200x180",
        colors: list[str] | None = None,
    ) -> Path:
        """Stack showwavespic renders vertically (one row per input)."""
        if not input_paths:
            raise ValueError("no inputs for stacked waveform")
        output_png.parent.mkdir(parents=True, exist_ok=True)
        palette = colors or ["0x4a9eff", "0xe67e22", "0x2ecc71", "0x9b59b6"]
        parts: list[str] = []
        for i, _path in enumerate(input_paths):
            color = palette[i % len(palette)]
            parts.append(f"[{i}:a]showwavespic=s={size}:colors={color}[w{i}]")
        labels = "".join(f"[w{i}]" for i in range(len(input_paths)))
        parts.append(f"{labels}vstack=inputs={len(input_paths)}[out]")
        fc = ";".join(parts)
        cmd = [self.ffmpeg, "-y", *_VISUAL_DIAGNOSTIC_THREAD_ARGS]
        for p in input_paths:
            cmd.extend(["-i", str(p)])
        cmd.extend(
            [
                "-filter_complex",
                fc,
                "-map",
                "[out]",
                "-frames:v",
                "1",
                str(output_png),
            ]
        )
        run(cmd, check=True, capture_output=True)
        return output_png

    def _filter_names(self) -> set[str]:
        if self._filter_names_cache is not None:
            return self._filter_names_cache
        names: set[str] = set()
        try:
            r = run(
                [self.ffmpeg, "-hide_banner", "-filters"],
                capture_output=True,
                text=True,
                timeout=10,
            )
        except (FileNotFoundError, TimeoutExpired, CalledProcessError):
            self._filter_names_cache = names
            return names
        for line in (r.stdout or "").splitlines():
            parts = line.split()
            if len(parts) >= 2:
                names.add(parts[1])
        self._filter_names_cache = names
        return names

    def _has_filter(self, name: str) -> bool:
        return name in self._filter_names()

    def annotate_time_marks(
        self,
        png_path: Path,
        marks: list[dict[str, Any]],
        out_path: Path,
        *,
        window_start: float | None = None,
        window_end: float | None = None,
        plot_width: int = 1200,
    ) -> Path:
        """Burn vertical time marks onto a spectrogram/waveform PNG.

        ``marks`` items: ``{x: 0-1, label: str, kind: str}``. x is relative to the
        plot width (legend=0 images). Uses drawbox always; drawtext labels only
        when this ffmpeg build includes the filter (Homebrew often omits
        libfreetype). No Pillow.
        """
        if not png_path.is_file():
            raise FileNotFoundError(f"png not found: {png_path}")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        font = _drawtext_font()
        use_drawtext = bool(font is not None and self._has_filter("drawtext"))
        vf = _annotate_vf(
            marks,
            plot_width=plot_width,
            window_start=window_start,
            window_end=window_end,
            font=font,
            use_drawtext=use_drawtext,
        )
        if not vf:
            if png_path.resolve() != out_path.resolve():
                shutil.copy2(png_path, out_path)
            return out_path
        if self._overlay_png(png_path, out_path, vf):
            return out_path
        if use_drawtext:
            boxes_only = _annotate_vf(
                marks,
                plot_width=plot_width,
                window_start=window_start,
                window_end=window_end,
                font=font,
                use_drawtext=False,
            )
            if boxes_only and self._overlay_png(png_path, out_path, boxes_only):
                return out_path
        if png_path.resolve() != out_path.resolve():
            shutil.copy2(png_path, out_path)
        return out_path

    def _overlay_png(self, png_path: Path, out_path: Path, vf: str) -> bool:
        tmp = out_path.with_name(f".{out_path.stem}.annot.png")
        cmd = [
            self.ffmpeg,
            "-y",
            "-i",
            str(png_path),
            "-vf",
            vf,
            str(tmp),
        ]
        try:
            run(cmd, check=True, capture_output=True)
            tmp.replace(out_path)
            return True
        except CalledProcessError:
            return False
        finally:
            tmp.unlink(missing_ok=True)

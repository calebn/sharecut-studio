from __future__ import annotations

import logging
import re
import shutil
from pathlib import Path
from typing import TYPE_CHECKING

from podcast_mcp.engines.ffmpeg import runtime
from podcast_mcp.engines.media_seek import MediaSeek
from podcast_mcp.engines.mix_spans import quiet_spans
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.parallel import run_parallel

if TYPE_CHECKING:
    from podcast_mcp.engines.ffmpeg.host import FFmpegSelf

log = logging.getLogger("podcast_mcp.engines.ffmpeg")


def logged_headroom_trim_db(true_peak_db: float | None, ceiling_db: float) -> float:
    """``headroom_trim_db``, logging when the mix is trimmed."""
    trim = headroom_trim_db(true_peak_db, ceiling_db)
    if trim < 0:
        log.info("mix peaks at %s dBTP; trimmed %s dB to %s dBTP", true_peak_db, trim, ceiling_db)
    return trim


def _anullsrc(rate: int, layout: str) -> str:
    return f"anullsrc=r={rate}:cl={layout}"


_SUMMARY_TRUE_PEAK_RE = re.compile(r"Peak:\s*(-inf|-?\d+(?:\.\d+)?)\s*dBFS")


def headroom_trim_db(true_peak_db: float | None, ceiling_db: float) -> float:
    """Gain (<= 0 dB) that brings a mix's true peak down to ``ceiling_db``; never boosts."""
    if true_peak_db is None:
        return 0.0
    return min(0.0, round(ceiling_db - true_peak_db, 2))


def _concat_list_entry(path: Path) -> str:
    """Format one ``file '...'`` line for the concat demuxer (quote-safe)."""
    resolved = str(path.resolve())
    if "\n" in resolved or "\r" in resolved:
        raise CodedValueError(
            f"media path must not contain newlines: {Path(resolved).name!r}. Rename the file so its path has no line break.",
            code="media_path_invalid",
        )
    # FFmpeg concat: escape embedded single quotes as '\''
    escaped = resolved.replace("'", r"'\''")
    return f"file '{escaped}'"


class MixMixin:
    def join_audio_parts(
        self: FFmpegSelf,
        part_paths: list[Path],
        output_path: Path,
        *,
        crossfade_ms_between: list[int] | None = None,
        crossfade_curve: str = "tri",
    ) -> Path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if not part_paths:
            raise CodedValueError(
                "no parts to join. Pass at least one part.", code="missing_argument"
            )
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
            runtime.run(cmd, check=True, capture_output=True)
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
            runtime.run(cmd, check=True, capture_output=True)
            return output_path
        finally:
            list_file.unlink(missing_ok=True)

    def concat_with_gap(
        self: FFmpegSelf,
        wav_a: Path,
        wav_b: Path,
        out: Path,
        *,
        gap_sec: float,
        rate: int,
        channels: int,
    ) -> Path:
        silence = out.with_name(f".{out.stem}_gap.wav")
        try:
            runtime.run(
                [
                    self.ffmpeg,
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    _anullsrc(rate, "mono" if channels <= 1 else "stereo"),
                    "-t",
                    f"{gap_sec:.6f}",
                    "-acodec",
                    "pcm_s16le",
                    str(silence),
                ],
                check=True,
                capture_output=True,
            )
            # Filter concat so mismatched layouts still join cleanly.
            cmd = [
                self.ffmpeg,
                "-y",
                "-i",
                str(wav_a),
                "-i",
                str(silence),
                "-i",
                str(wav_b),
                "-filter_complex",
                "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]",
                "-map",
                "[out]",
                "-acodec",
                "pcm_s16le",
                str(out),
            ]
            runtime.run(cmd, check=True, capture_output=True)
        finally:
            silence.unlink(missing_ok=True)
        return out

    def pad_end_silence(
        self: FFmpegSelf, input_path: Path, output_path: Path, duration_sec: float
    ) -> Path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        target = float(duration_sec)
        if target <= 0:
            raise CodedValueError(
                "duration_sec must be positive. Pass more than 0 seconds.", code="out_of_range"
            )
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
        runtime.run(cmd, check=True, capture_output=True)
        return output_path

    def apply_gain(self: FFmpegSelf, input_path: Path, output_path: Path, gain_db: float) -> Path:
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
        runtime.run(cmd, check=True, capture_output=True)
        return output_path

    @staticmethod
    def _sum_graph(
        track_wavs: list[tuple[Path, float]],
        tail: str | None,
        span: tuple[float, float | None] = (0.0, None),
    ) -> list[str]:
        """ffmpeg input + filtergraph args: each input at its gain, summed at unity (amix
        normalize=0, not 1/N), then ``tail`` (e.g. a trim or ebur128), ending at ``[out]``.

        ``span`` is the ``(start, end)`` seconds of every input to read; ``end`` None is EOF.
        """
        start, end = span
        seek = MediaSeek.at(start, lead_sec=0.0)
        trim = f"atrim=start={seek.offset(start)},asetpts=PTS-STARTPTS," if start else ""
        inputs: list[str] = []
        filters: list[str] = []
        n = len(track_wavs)
        suffix = f",{tail}" if tail else ""
        for i, (wav, gain_db) in enumerate(track_wavs):
            inputs.extend([*seek.input_args(end), "-i", str(wav)])
            label = f"{suffix}[out]" if n == 1 else f"[a{i}]"
            filters.append(f"[{i}:a]{trim}volume={gain_db}dB{label}")
        if n > 1:
            mix_inputs = "".join(f"[a{i}]" for i in range(n))
            filters.append(f"{mix_inputs}amix=inputs={n}:duration=longest:normalize=0{suffix}[out]")
        return [*inputs, "-filter_complex", ";".join(filters), "-map", "[out]"]

    def _sum_tracks(
        self: FFmpegSelf,
        track_wavs: list[tuple[Path, float]],
        output_path: Path,
        *,
        trim_db: float = 0.0,
    ) -> None:
        tail = f"volume={trim_db}dB" if trim_db else None
        cmd = [self.ffmpeg, "-y", *self._sum_graph(track_wavs, tail), str(output_path)]
        runtime.run(cmd, check=True, capture_output=True)

    def _sum_true_peak_db(
        self: FFmpegSelf, track_wavs: list[tuple[Path, float]], span: tuple[float, float | None]
    ) -> float | None:
        """True peak (dBTP) of the unity sum over ``span``, measured on the float graph."""
        cmd = [
            self.ffmpeg,
            "-hide_banner",
            "-nostats",
            *self._sum_graph(track_wavs, "ebur128=peak=true", span),
            "-f",
            "null",
            "-",
        ]
        r = runtime.run(cmd, check=True, capture_output=True, text=True)
        # FFmpeg may emit an empty summary while initializing the graph.
        peaks = _SUMMARY_TRUE_PEAK_RE.findall(r.stderr or "")
        return float(peaks[-1]) if peaks else None

    def silence(
        self: FFmpegSelf,
        output_path: Path,
        duration_sec: float,
        *,
        sample_rate: int = 48000,
        channels: int = 2,
    ) -> Path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        runtime.run(
            [
                self.ffmpeg,
                "-y",
                "-f",
                "lavfi",
                "-i",
                _anullsrc(sample_rate, f"{channels}c"),
                "-t",
                str(duration_sec),
                "-c:a",
                "pcm_s16le",
                str(output_path),
            ],
            check=True,
        )
        return output_path

    def mix_tracks(
        self: FFmpegSelf,
        track_wavs: list[tuple[Path, float]],
        output_path: Path,
        *,
        peak_ceiling_db: float | None = None,
        trim_db: float | None = None,
    ) -> Path:
        """Sum tracks at unity after each one's gain (never 1/N).

        With ``peak_ceiling_db``, trim the whole mix by ``peak_trim_db`` so it peaks at or
        below the ceiling (never up); no intermediate file. With ``trim_db``, sum at that
        trim instead: a window of a longer mix plays at the trim measured over all of it.
        """
        if peak_ceiling_db is not None and trim_db is not None:
            raise CodedValueError(
                "pass peak_ceiling_db or trim_db, not both", code="invalid_arguments"
            )
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if not track_wavs:
            raise CodedValueError(
                "no tracks to mix. Pass at least one track.", code="missing_argument"
            )
        if peak_ceiling_db is not None:
            trim_db = self.peak_trim_db(track_wavs, float(peak_ceiling_db))
        if trim_db is None:
            if len(track_wavs) == 1:
                wav, gain_db = track_wavs[0]
                if float(gain_db) == 0.0:
                    shutil.copy2(wav, output_path)
                    return output_path
                return self.apply_gain(wav, output_path, float(gain_db))
            self._sum_tracks(track_wavs, output_path)
            return output_path
        self._sum_tracks(track_wavs, output_path, trim_db=trim_db)
        return output_path

    def mix_peak_db(
        self: FFmpegSelf, track_wavs: list[tuple[Path, float]], ceiling_db: float
    ) -> float | None:
        """True peak (dBTP) of the unity sum, or None when ffmpeg did not report one.

        Measures on the float graph (ebur128 to a null output), one span per worker in
        parallel. The spans meet in quiet blocks (``mix_spans.quiet_spans``), so their
        loudest peak is the single-pass peak.
        """
        spans = quiet_spans(track_wavs, ceiling_db)
        peaks = run_parallel(spans, lambda span: self._sum_true_peak_db(track_wavs, span))
        peak = None if None in peaks else max(p for p in peaks if p is not None)
        if peak is None:
            log.warning(
                "mix true peak not measured; mixing untrimmed (ceiling %s dBTP)", ceiling_db
            )
        return peak

    def peak_trim_db(
        self: FFmpegSelf, track_wavs: list[tuple[Path, float]], ceiling_db: float
    ) -> float:
        """Gain (<= 0 dB) that brings the unity sum's true peak down to ``ceiling_db``."""
        return logged_headroom_trim_db(self.mix_peak_db(track_wavs, ceiling_db), ceiling_db)

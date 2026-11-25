from __future__ import annotations

import functools
import json
import logging
import re
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

from podcast_mcp.engines.ffmpeg import runtime
from podcast_mcp.engines.ffmpeg.filter_log import decoded_no_frames, filter_log_text
from podcast_mcp.engines.mastering import (
    LIMITER_MARGIN_DB,
    LIMITER_MAX_RENDERS,
    SCREEN_PEAK_SLACK_DB,
    TRUE_PEAK_PRINT_ROUNDING_DB,
    LimiterPlan,
    LimiterReport,
    LoudnormPlan,
    MasterResult,
    limiter_af,
    plan_master,
)
from podcast_mcp.util.process import CalledProcessError

if TYPE_CHECKING:
    from podcast_mcp.engines.ffmpeg.host import FFmpegSelf

log = logging.getLogger("podcast_mcp.engines.ffmpeg")


_LOUDNORM_HEADER_RE = re.compile(r"^\[Parsed_loudnorm_\d+ @ [^\]\n]*\]", re.MULTILINE)


def _json_object_in(text: str) -> dict[str, Any] | None:
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _loudnorm_json(text: str) -> dict[str, Any] | None:
    # The report follows loudnorm's own log header; braces in a forged tag dumped earlier don't count.
    for header in reversed(list(_LOUDNORM_HEADER_RE.finditer(text))):
        report = _json_object_in(text[header.end() :])
        if report is not None:
            return report
    return _json_object_in(text)


_EBUR128_BLOCK_RE = re.compile(r"\bt:\s*(\d+(?:\.\d+)?)\s+TARGET:.*?\bM:\s*(-?\d+(?:\.\d+)?)")

_EBUR128_SUMMARY_RE = re.compile(r"^\[Parsed_ebur128_\d+ @ [^\]\n]*\] Summary:", re.MULTILINE)


def ebur128_summary_text(stderr: str | bytes | None) -> str:
    text = runtime._stderr_text(stderr)
    starts = [m.end() for m in _EBUR128_SUMMARY_RE.finditer(text)]
    return text[starts[-1] :] if starts else ""


class LoudnessMixin:
    def loudnorm_input_stats(
        self: FFmpegSelf,
        input_path: Path,
        *,
        on_progress: Callable[[float, float], None] | None = None,
        total_sec: float | None = None,
    ) -> dict[str, float] | None:
        """loudnorm pass-1 values from one ebur128 pass.

        Much faster than a loudnorm measure pass, which resamples to 192 kHz.
        ``target_offset`` is 0: loudnorm only uses it in dynamic mode.
        """
        m = (
            self.measure_loudness_full(input_path, on_progress=on_progress, total_sec=total_sec)
            or {}
        )
        keys = {
            "input_i": "integrated_lufs",
            "input_tp": "true_peak_db",
            "input_lra": "lra",
            "input_thresh": "integrated_threshold_lufs",
        }
        stats: dict[str, float] = {}
        missing: list[str] = []
        for out_key, src_key in keys.items():
            value = m.get(src_key)
            if value is None:
                missing.append(src_key)
            else:
                stats[out_key] = value
        if missing:
            log.warning(
                "loudnorm pass-1 stats unavailable for %s (ebur128 summary has no %s); "
                "mastering runs single-pass loudnorm",
                input_path,
                ", ".join(missing),
            )
            return None
        stats["target_offset"] = 0.0
        return stats

    def measure_loudness_full(
        self: FFmpegSelf,
        path: Path,
        *,
        on_progress: Callable[[float, float], None] | None = None,
        total_sec: float | None = None,
    ) -> dict[str, float | None] | None:
        """Integrated LUFS + true peak + LRA from ebur128 (for post-master QC).

        ``total_sec`` overrides the probed duration for progress (callers that
        already probed).
        """
        cmd = [
            self.ffmpeg,
            "-i",
            str(path),
            "-vn",
            "-af",
            "ebur128=framelog=verbose:peak=true,astats=metadata=1",
            "-f",
            "null",
            "-",
        ]
        if on_progress is None:
            r = runtime.run(cmd, capture_output=True)
            if r.returncode != 0:
                return None
            text = r.stderr
        else:
            duration = total_sec if total_sec is not None else self.probe(path).duration_sec
            callback_failed = False

            def report(done: float, total: float) -> None:
                nonlocal callback_failed
                try:
                    on_progress(done, total)
                except CalledProcessError:
                    callback_failed = True
                    raise

            try:
                text = self._run_with_progress(
                    cmd, total_sec=duration, on_progress=report, check=True
                )
            except CalledProcessError:
                if callback_failed:
                    raise
                return None
        text = ebur128_summary_text(text)
        if decoded_no_frames(text):
            return None
        i_m = re.search(r"\bI:\s*(-?\d+\.?\d*)\s*LUFS", text)
        tp_m = re.search(r"Peak:\s*(-?\d+\.?\d*)\s*dBFS", text)
        lra_m = re.search(r"\bLRA:\s*(-?\d+\.?\d*)\s*LU", text)
        thr_m = re.search(r"\bI:\s*-?\d+\.?\d*\s*LUFS\s+Threshold:\s*(-?\d+\.?\d*)\s*LUFS", text)
        if i_m is None:
            return None
        return {
            "integrated_lufs": float(i_m.group(1)),
            "true_peak_db": float(tp_m.group(1)) if tp_m else None,
            "lra": float(lra_m.group(1)) if lra_m else None,
            "integrated_threshold_lufs": float(thr_m.group(1)) if thr_m else None,
        }

    def measure_loudness_screen(self: FFmpegSelf, path: Path) -> dict[str, float] | None:
        """Integrated LUFS and sample peak from ebur128, without its oversampled true peak.

        The integrated figure is the one ``measure_loudness_full`` reports; the sample
        peak does not exceed the true peak on any signal tried (the limiter loop adds
        ``SCREEN_PEAK_SLACK_DB`` of slack), so it bounds true-peak headroom from above.
        The one exception is a loudest sample in the last few samples of the file, which
        ffmpeg's true-peak pass omits.
        About a sixth of the cost of ``measure_loudness_full``.
        """
        r = runtime.run(
            [
                self.ffmpeg,
                "-i",
                str(path),
                "-vn",
                "-af",
                "ebur128=framelog=verbose:peak=sample",
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
        )
        if r.returncode != 0:
            return None
        text = ebur128_summary_text(r.stderr)
        if decoded_no_frames(text):
            return None
        i_m = re.search(r"\bI:\s*(-?\d+\.?\d*)\s*LUFS", text)
        peak_m = re.search(r"Peak:\s*(-?\d+\.?\d*)\s*dBFS", text)
        if i_m is None or peak_m is None:
            return None
        return {"integrated_lufs": float(i_m.group(1)), "sample_peak_db": float(peak_m.group(1))}

    def master_loudness(
        self: FFmpegSelf,
        input_path: Path,
        output_path: Path,
        integrated_lufs: float = -16.0,
        true_peak_db: float = -1.5,
        lra: float = 11.0,
        *,
        sample_rate: int | None = None,
        channels: int | None = None,
        on_progress: Callable[[float, float], None] | None = None,
        on_measure_progress: Callable[[float, float], None] | None = None,
    ) -> MasterResult:
        """Master to ``integrated_lufs`` under ``true_peak_db``, at the delivery rate.

        Pass 1 is ebur128 (I, TP, LRA, gate threshold), and ``plan_master`` picks
        the plan from it. The loudnorm plan is pass 2: loudnorm in linear mode with
        those values. loudnorm still falls back to dynamic mode when ``LRA > lra``
        (or the measured LRA is 0); ``normalization_type`` says which ran. The
        limiter plan, for a gain that would push peaks over the ceiling, runs
        ``_limit_to_target``. FFmpeg's loudnorm upsamples to 192 kHz for true-peak
        work; without an explicit ``-ar``/``-ac`` that rate would leak into
        mastered/export WAVs.

        ``on_measure_progress`` reports pass 1 (ebur128) and ``on_progress`` each
        render, as (done_sec, total_sec) of the input. Both use the one input
        probe, so they share a per-pass total.
        """
        output_path.parent.mkdir(parents=True, exist_ok=True)
        probe = self.probe(input_path)
        out_rate = sample_rate if sample_rate is not None else probe.sample_rate
        out_ch = channels if channels is not None else probe.channels
        delivery = ("-ar", str(out_rate), "-ac", str(out_ch))
        stats = self.loudnorm_input_stats(
            input_path, on_progress=on_measure_progress, total_sec=probe.duration_sec
        )
        plan = plan_master(
            stats,
            integrated_lufs=integrated_lufs,
            true_peak_db=true_peak_db,
            duration_sec=probe.duration_sec,
        )
        render = functools.partial(
            self._render_af, total_sec=probe.duration_sec, on_progress=on_progress
        )
        if isinstance(plan, LimiterPlan) and stats is not None:
            limiter = self._limit_to_target(
                input_path,
                output_path,
                plan,
                stats,
                integrated_lufs=integrated_lufs,
                true_peak_db=true_peak_db,
                sample_rate=out_rate,
                delivery=delivery,
                render=render,
            )
            return MasterResult(output_path, plan, stats, None, limiter)
        base = f"loudnorm=I={integrated_lufs}:TP={true_peak_db}:LRA={lra}"
        if stats is None or (isinstance(plan, LoudnormPlan) and not plan.two_pass):
            af = f"{base}:print_format=json"
        else:
            af = (
                f"{base}:measured_I={stats['input_i']}:measured_TP={stats['input_tp']}:"
                f"measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}:"
                f"offset={stats['target_offset']}:linear=true:print_format=json"
            )
        report = _loudnorm_json(render(input_path, output_path, af, *delivery)) or {}
        norm = report.get("normalization_type")
        return MasterResult(output_path, plan, stats, str(norm) if norm else None, None)

    def _limit_to_target(
        self: FFmpegSelf,
        input_path: Path,
        output_path: Path,
        plan: LimiterPlan,
        stats: dict[str, float],
        *,
        integrated_lufs: float,
        true_peak_db: float,
        sample_rate: int,
        delivery: tuple[str, ...],
        render: Callable[..., str],
    ) -> LimiterReport:
        """Gain into an oversampled limiter under the ceiling, then trim onto the target.

        Limiting lowers the integrated loudness. The trim after the limiter can make
        up at most the true-peak headroom left under ``true_peak_db``; a larger
        shortfall is added to the gain into the limiter, and the limiter runs again.
        """
        limit_db = round(true_peak_db - LIMITER_MARGIN_DB, 2)
        drive_db = plan.gain_db
        renders = 0
        with tempfile.TemporaryDirectory(dir=output_path.parent) as tmp:
            limited = Path(tmp) / "limited.wav"
            while True:
                renders += 1
                af = limiter_af(drive_db, limit_db, sample_rate)
                render(input_path, limited, af, "-c:a", "pcm_f32le")
                if renders < LIMITER_MAX_RENDERS:
                    screen = self.measure_loudness_screen(limited)
                    if screen is not None:
                        screen_shortfall = round(integrated_lufs - screen["integrated_lufs"], 2)
                        screen_headroom = round(
                            true_peak_db - screen["sample_peak_db"] - TRUE_PEAK_PRINT_ROUNDING_DB,
                            2,
                        )
                        if screen_shortfall > screen_headroom + SCREEN_PEAK_SLACK_DB:
                            drive_db = round(drive_db + screen_shortfall, 2)
                            continue
                level = self.measure_loudness_full(limited) or {}
                lufs, peak = level.get("integrated_lufs"), level.get("true_peak_db")
                if lufs is None or peak is None:
                    raise RuntimeError(f"ebur128 could not measure the limited master {limited}")
                shortfall = round(integrated_lufs - lufs, 2)
                headroom = round(true_peak_db - peak - TRUE_PEAK_PRINT_ROUNDING_DB, 2)
                converged = shortfall <= headroom
                if converged or renders == LIMITER_MAX_RENDERS:
                    break
                drive_db = round(drive_db + shortfall, 2)
            trim_db = min(shortfall, headroom)
            render(limited, output_path, f"volume={trim_db}dB", *delivery)
        return LimiterReport(
            gain_db=plan.gain_db,
            drive_db=drive_db,
            limit_db=limit_db,
            renders=renders,
            converged=converged,
            trim_db=trim_db,
            peak_reduction_db=round(stats["input_tp"] + drive_db - peak, 2),
            loudness_reduction_lu=round(stats["input_i"] + drive_db - lufs, 2),
        )

    def _render_af(
        self: FFmpegSelf,
        input_path: Path,
        output_path: Path,
        af: str,
        *out_args: str,
        total_sec: float,
        on_progress: Callable[[float, float], None] | None,
    ) -> str:
        """Run ``ffmpeg -i input -af af *out_args output`` and return its stderr."""
        cmd = [self.ffmpeg, "-y", "-i", str(input_path), "-af", af, *out_args, str(output_path)]
        if on_progress is None:
            return runtime.run(cmd, check=True, capture_output=True, text=True).stderr or ""
        return self._run_with_progress(cmd, total_sec=total_sec, on_progress=on_progress)

    def measure_loudness_blocks(
        self: FFmpegSelf, path: Path, af: str | None = None
    ) -> list[tuple[float, float]]:
        """(t, momentary LUFS) every 100 ms from ebur128, after the optional filter chain ``af``."""
        chain = (
            "ebur128=framelog=info" if not af or af == "anull" else f"{af},ebur128=framelog=info"
        )
        cmd = [
            self.ffmpeg,
            "-hide_banner",
            "-nostats",
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-af",
            chain,
            "-f",
            "null",
            "-",
        ]
        r = runtime.run(cmd, capture_output=True)
        stderr = runtime._stderr_text(r.stderr)
        if r.returncode != 0:
            log.warning(
                "ebur128 measure failed for %s (exit %s): %s",
                path,
                r.returncode,
                stderr[-runtime.PCM_STDERR_TAIL_BYTES :].strip(),
            )
            return []
        blocks = [
            (float(t), float(m))
            for t, m in _EBUR128_BLOCK_RE.findall(filter_log_text(stderr, "ebur128"))
        ]
        if not blocks:
            log.warning(
                "ebur128 printed no momentary blocks for %s; its log format may have changed", path
            )
        return blocks

    def measure_loudness(self: FFmpegSelf, path: Path) -> float | None:
        cmd = [
            self.ffmpeg,
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-af",
            "ebur128=framelog=verbose",
            "-f",
            "null",
            "-",
        ]
        r = runtime.run(cmd, capture_output=True)
        if r.returncode != 0:
            return None
        text = ebur128_summary_text(r.stderr)
        if decoded_no_frames(text):
            return None
        m = re.search(r"I:\s*(-?\d+\.?\d*)\s*LUFS", text)
        if m:
            return float(m.group(1))
        m = re.search(r"Integrated loudness:\s*(-?\d+\.?\d*)", text)
        if m:
            return float(m.group(1))
        return None

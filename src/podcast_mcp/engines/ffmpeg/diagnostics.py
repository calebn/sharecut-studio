from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

from podcast_mcp.engines.audition_plot import annotate_plot, png_dimensions
from podcast_mcp.engines.ffmpeg import runtime
from podcast_mcp.util.atomic_file import publish_completed_file
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.process import CalledProcessError, TimeoutExpired

if TYPE_CHECKING:
    from podcast_mcp.engines.ffmpeg.host import FFmpegSelf

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


def _escape_filter_value(value: str) -> str:
    """Escape a value (e.g. a filesystem path) for an ffmpeg filtergraph option.

    Needed for values that may contain `:` (filter-option separator, also a
    Windows drive-letter separator) or `'`/`\\`.
    """
    return value.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


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


class PlotAnnotationUnavailableError(RuntimeError):
    """This FFmpeg build cannot render the plot axis and key."""


class DiagnosticsMixin:
    def render_spectrogram(
        self: FFmpegSelf,
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
        runtime.run(cmd, check=True, capture_output=True)
        if tmp is not None:
            tmp.unlink(missing_ok=True)
        return output_png

    def render_showwavespic(
        self: FFmpegSelf,
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
        runtime.run(cmd, check=True, capture_output=True)
        if tmp is not None:
            tmp.unlink(missing_ok=True)
        return output_png

    def render_stacked_showwavespic(
        self: FFmpegSelf,
        input_paths: list[Path],
        output_png: Path,
        *,
        size: str = "1200x180",
        colors: list[str] | None = None,
    ) -> Path:
        """Stack showwavespic renders vertically (one row per input)."""
        if not input_paths:
            raise CodedValueError(
                "no inputs for stacked waveform. Pass at least one input.", code="missing_argument"
            )
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
        runtime.run(cmd, check=True, capture_output=True)
        return output_png

    def _listed_names(self: FFmpegSelf, flag: str) -> set[str] | None:
        """Names from ``ffmpeg -hide_banner <flag>`` (``-filters``, ``-encoders``, ``-muxers``).

        None when the listing could not be read; only a successful read is cached.
        """
        cached = self._listed_names_cache.get(flag)
        if cached is not None:
            return cached
        try:
            r = runtime.run(
                [self.ffmpeg, "-hide_banner", flag],
                capture_output=True,
                text=True,
                timeout=10,
            )
        except (OSError, TimeoutExpired):
            return None
        if r.returncode != 0:
            return None
        names: set[str] = set()
        for line in (r.stdout or "").splitlines():
            parts = line.split()
            if len(parts) >= 2:
                names.add(parts[1])
        self._listed_names_cache[flag] = names
        return names

    def supports_encode(self: FFmpegSelf, codec: str, muxer: str) -> bool | None:
        encoders = self._listed_names("-encoders")
        muxers = self._listed_names("-muxers")
        if encoders is None or muxers is None:
            return None
        return codec in encoders and muxer in muxers

    def _has_filter(self: FFmpegSelf, name: str) -> bool:
        names = self._listed_names("-filters")
        return names is not None and name in names

    def annotate_time_marks(
        self: FFmpegSelf,
        png_path: Path,
        marks: list[dict[str, Any]],
        out_path: Path,
        *,
        window_start: float | None = None,
        window_end: float | None = None,
        plot_width: int = 1200,
    ) -> Path:
        """Burn vertical time marks onto a spectrogram/waveform PNG.

        A timeline window adds a same-width time axis and marker key beneath
        the plot. Without a window, use the existing marker-only overlay.
        FFmpeg builds without XBIN can publish marker lines and report that
        the axis and key are unavailable.
        """
        if not png_path.is_file():
            raise FileNotFoundError(f"png not found: {png_path}")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        if window_start is not None and window_end is not None:
            return self._annotate_plot_png(png_path, marks, out_path, window_start, window_end)
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

    def _annotate_plot_png(
        self: FFmpegSelf,
        png_path: Path,
        marks: list[dict[str, Any]],
        out_path: Path,
        window_start: float,
        window_end: float,
    ) -> Path:
        width, height = png_dimensions(png_path)
        annotation = annotate_plot(width, marks, window_start, window_end)
        plot_filters = ",".join(("format=rgba", *annotation.grid_filters, *annotation.mark_filters))
        graph = (
            f"[0:v]{plot_filters}[plot];"
            f"[1:v]format=rgba,crop=w={width}:h=ih:x=0:y=0[footer];"
            "[plot][footer]vstack[out]"
        )
        with tempfile.TemporaryDirectory(
            prefix=f".{out_path.stem}.", dir=out_path.parent
        ) as temporary_dir:
            footer = Path(temporary_dir) / "footer.xbin"
            tmp = Path(temporary_dir) / "plot.png"
            footer.write_bytes(annotation.footer)
            cmd = [
                self.ffmpeg,
                "-y",
                *_VISUAL_DIAGNOSTIC_THREAD_ARGS,
                "-i",
                str(png_path),
                "-f",
                "xbin",
                "-linespeed",
                "1000000",
                "-i",
                str(footer),
                "-filter_complex",
                graph,
                "-map",
                "[out]",
                "-frames:v",
                "1",
                str(tmp),
            ]
            try:
                runtime.run(cmd, check=True, capture_output=True)
            except CalledProcessError as exc:
                stderr = exc.stderr or ""
                if isinstance(stderr, bytes):
                    stderr = stderr.decode(errors="replace")
                missing_xbin = {
                    "Unknown input format: 'xbin'",
                    "Decoding requested, but no decoder found for: bintext",
                }
                if not any(
                    line.rsplit("] ", 1)[-1] in missing_xbin for line in stderr.splitlines()
                ):
                    raise
                if annotation.mark_filters:
                    marker_filters = ",".join(("format=rgba", *annotation.mark_filters))
                    self._overlay_png(
                        png_path, out_path, marker_filters, dimensions=(width, height)
                    )
                raise PlotAnnotationUnavailableError("FFmpeg XBIN support is unavailable") from exc
            if png_dimensions(tmp) != (width, height + annotation.footer_height):
                raise CodedValueError("Incomplete plot annotation", code="invalid_plot_png")
            publish_completed_file(tmp, out_path)
        return out_path

    def _overlay_png(
        self: FFmpegSelf,
        png_path: Path,
        out_path: Path,
        vf: str,
        *,
        dimensions: tuple[int, int] | None = None,
    ) -> bool:
        with tempfile.TemporaryDirectory(
            prefix=f".{out_path.stem}.", dir=out_path.parent
        ) as temporary_dir:
            tmp = Path(temporary_dir) / f"{out_path.stem}.annot.png"
            cmd = [
                self.ffmpeg,
                "-y",
                *_VISUAL_DIAGNOSTIC_THREAD_ARGS,
                "-i",
                str(png_path),
                "-vf",
                vf,
                "-frames:v",
                "1",
                str(tmp),
            ]
            try:
                runtime.run(cmd, check=True, capture_output=True)
                if dimensions is not None and png_dimensions(tmp) != dimensions:
                    return False
                publish_completed_file(tmp, out_path)
                return True
            except CalledProcessError:
                return False

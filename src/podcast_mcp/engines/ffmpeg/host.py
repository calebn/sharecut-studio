from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from collections.abc import Generator

    import numpy as np

    from podcast_mcp.engines.audio import Audio, MuteEnvelope, RequestedExtent, SourceAudio
    from podcast_mcp.engines.ffmpeg import AudioProbe
    from podcast_mcp.engines.mastering import LimiterPlan, LimiterReport
    from podcast_mcp.models import AutomationEnvelope, FadeCurve


class FFmpegSelf(Protocol):
    ffmpeg: str
    ffprobe: str
    _listed_names_cache: dict[str, set[str]]

    def audio_start_sec(self, path: Path) -> float: ...

    def render_timeline(
        self,
        output_path: Path,
        audio: Audio,
        af_chain: str,
        *,
        crossfade_curve: str = "tri",
        requested_extent: RequestedExtent | None = None,
        clock_path: Path | None = None,
    ) -> Path: ...

    def _mix_fills(
        self,
        leaves: list[SourceAudio],
        filters: list[str],
        src_labels: list[str],
        *,
        source_paths: list[Path],
        source_ranges: dict[Path, tuple[float, float]],
    ) -> list[str]: ...

    def _fade_chain(
        self,
        seg_duration: float,
        fade_in_sec: float,
        fade_out_sec: float,
        fade_in_curve: FadeCurve = ...,
        fade_out_curve: FadeCurve = ...,
    ) -> list[str]: ...

    def _mute_chain(
        self,
        seg_duration: float,
        mute_spans: tuple[MuteEnvelope, ...],
        *,
        sample_rate: int,
        source_start: float = 0.0,
        origin: int = 0,
    ) -> list[str]: ...

    def _volume_expression(
        self, envelope: AutomationEnvelope, *, timeline_origin_sec: float = 0.0
    ) -> str: ...

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
        cancel_check: Callable[[], bool] | None = None,
    ) -> Path: ...

    @staticmethod
    def _sum_graph(
        track_wavs: list[tuple[Path, float]],
        tail: str | None,
        span: tuple[float, float | None] = (0.0, None),
    ) -> list[str]: ...

    def apply_gain(self, input_path: Path, output_path: Path, gain_db: float) -> Path: ...

    def _sum_tracks(
        self, track_wavs: list[tuple[Path, float]], output_path: Path, *, trim_db: float = 0.0
    ) -> None: ...

    def _sum_true_peak_db(
        self, track_wavs: list[tuple[Path, float]], span: tuple[float, float | None]
    ) -> float | None: ...

    def mix_peak_db(
        self, track_wavs: list[tuple[Path, float]], ceiling_db: float
    ) -> float | None: ...

    def peak_trim_db(self, track_wavs: list[tuple[Path, float]], ceiling_db: float) -> float: ...

    def extract_segment(
        self,
        src: Path,
        output_path: Path,
        start_sec: float,
        end_sec: float,
        *,
        mute_spans: tuple[MuteEnvelope, ...] = (),
        gain_db: float = 0.0,
    ) -> Path: ...

    def _listed_names(self, flag: str) -> set[str] | None: ...

    def _has_filter(self, name: str) -> bool: ...

    def _annotate_plot_png(
        self,
        png_path: Path,
        marks: list[dict[str, Any]],
        out_path: Path,
        window_start: float,
        window_end: float,
    ) -> Path: ...

    def _overlay_png(
        self,
        png_path: Path,
        out_path: Path,
        vf: str,
        *,
        dimensions: tuple[int, int] | None = None,
    ) -> bool: ...

    def probe(self, path: Path, *, untrusted: bool = False) -> AudioProbe: ...

    def _scan_audio_extent(self, path: Path, *, untrusted: bool) -> tuple[float, float] | None: ...

    def _first_decoded_pts(self, path: Path, *, untrusted: bool) -> float | None: ...

    def _pcm_f32_argv(
        self,
        path: Path,
        sample_rate: int,
        channels: int,
        *,
        start_sec: float | None = None,
        duration_sec: float | None = None,
    ) -> list[str]: ...

    @staticmethod
    def _read_pcm_f32(
        argv: list[str],
        channels: int,
        *,
        chunk_frames: int,
        timeout_sec: float,
        max_frames: int | None = None,
        expected_duration_sec: float | None = None,
    ) -> Generator[np.ndarray, None, None]: ...

    def _run_with_progress(
        self,
        argv: list[str],
        *,
        total_sec: float,
        on_progress: Callable[[float, float], None],
        check: bool = True,
    ) -> str: ...

    def loudnorm_input_stats(
        self,
        input_path: Path,
        *,
        on_progress: Callable[[float, float], None] | None = None,
        total_sec: float | None = None,
    ) -> dict[str, float] | None: ...

    def measure_loudness_full(
        self,
        path: Path,
        *,
        on_progress: Callable[[float, float], None] | None = None,
        total_sec: float | None = None,
    ) -> dict[str, float | None] | None: ...

    def measure_loudness_screen(self, path: Path) -> dict[str, float] | None: ...

    def _render_af(
        self,
        input_path: Path,
        output_path: Path,
        af: str,
        *out_args: str,
        total_sec: float,
        on_progress: Callable[[float, float], None] | None,
    ) -> str: ...

    def _limit_to_target(
        self,
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
    ) -> LimiterReport: ...

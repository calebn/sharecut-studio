from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from podcast_mcp.engines.audio import Audio, MuteEnvelope, RequestedExtent


class FFmpegSelf(Protocol):
    ffmpeg: str
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

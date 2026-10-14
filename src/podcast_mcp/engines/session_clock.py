from __future__ import annotations

from pathlib import Path

import numpy as np

from podcast_mcp.engines.align import AudioWindowUnavailableError, load_mono_window


def first_speech_onset_sec(
    path: Path,
    *,
    search_start_sec: float = 0.0,
    search_end_sec: float | None = None,
    chunk_sec: float = 2.0,
    rms_threshold: float = 0.02,
    sample_rate: int = 8000,
) -> float | None:
    """First time (file clock) with sustained speech above threshold."""
    if search_end_sec is None:
        search_end_sec = search_start_sec + 600.0
    t = max(0.0, search_start_sec)
    while t < search_end_sec:
        try:
            window = load_mono_window(
                path,
                start_sec=t,
                duration_sec=chunk_sec,
                sample_rate=sample_rate,
            )
        except AudioWindowUnavailableError:
            return None
        if window.size == 0:
            return None
        if float(np.sqrt(np.mean(window**2))) >= rms_threshold:
            return t
        t += chunk_sec
    return None


def estimate_session_start_in_file(
    reference: Path,
    source: Path,
    *,
    session_hint_sec: float = 0.0,
    search_pad_sec: float = 60.0,
    ref_rms_threshold: float = 0.02,
    source_rms_threshold: float = 0.008,
) -> float:
    """
    Seconds into ``source`` file that correspond to session time 0 on ``reference``.

    Positive means the source recorder started later (typical remote guest).
    """
    lo = max(0.0, session_hint_sec - search_pad_sec)
    hi = session_hint_sec + search_pad_sec
    ref_onset = first_speech_onset_sec(
        reference,
        search_start_sec=lo,
        search_end_sec=hi,
        rms_threshold=ref_rms_threshold,
    )
    src_onset = first_speech_onset_sec(
        source,
        search_start_sec=lo,
        search_end_sec=hi,
        rms_threshold=source_rms_threshold,
    )
    if ref_onset is None or src_onset is None:
        return 0.0
    return src_onset - ref_onset


def file_time_for_session(
    session_start_in_file_sec: float,
    session_time_sec: float,
    content_align_sec: float = 0.0,
) -> float:
    """
    Map session timeline to file trim point.

    ``content_align_sec`` shifts source content later on the session clock (same
    sign as legacy ``session_offset_sec`` subtracted from extract_start).
    """
    return session_start_in_file_sec + session_time_sec - content_align_sec

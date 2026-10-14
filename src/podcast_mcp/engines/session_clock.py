from __future__ import annotations


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

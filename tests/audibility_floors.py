"""Stand-in voice floors for tests that fake word levels instead of decoding audio (#1324)."""

from __future__ import annotations

from unittest.mock import patch

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.util.dsp import DIGITAL_SILENCE_DB


def floors_at(floor_db: float):
    """Give every dialogue track this audibility floor, with no audio to measure it from."""

    def _floors(track_ids, caches, offsets):
        return dict.fromkeys(track_ids, floor_db)

    def _speech_rms(project, track_id, t_start, t_end, **kwargs):
        from podcast_mcp.engines.audio_audit import _rms_for_track_at_timeline

        return _rms_for_track_at_timeline(
            project,
            track_id,
            t_start,
            t_end,
            caches=kwargs.get("caches"),
            floor_db=kwargs.get("floor_db", DIGITAL_SILENCE_DB),
            recorded_gain=kwargs.get("recorded_gain", True),
            defaults=load_defaults(),
        )

    return patch.multiple(
        "podcast_mcp.engines.audio_audit",
        _voice_floors=_floors,
        _inaudibility_floors=lambda track_ids, caches, speech_offsets: dict.fromkeys(
            track_ids, floor_db
        ),
        _speech_rms_for_track_at_timeline=_speech_rms,
    )

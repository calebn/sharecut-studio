"""Seed a cached prosody profile without running analyze_prosody/parselmouth."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from podcast_mcp.models import (
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)


def single_track_prosody_project(minimal_project: Path) -> EpisodeProject:
    """A one-track (``host``) project with a two-word transcript, for prosody tests."""
    proj = load_project(minimal_project)
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        ),
    ]
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.1, end=0.4, confidence=0.9),
                TranscriptWord(text="world", start=0.5, end=0.9, confidence=0.9),
            ],
        )
    ]
    save_project(proj, minimal_project)
    return load_project(minimal_project)


def seed_prosody_profile(proj, *, params: dict[str, Any] | None = None) -> Path:
    """Write a one-segment profile for track ``host``, computed with ``params`` (default: shipped defaults)."""
    from podcast_mcp.edits.prosody_profile import (
        ALGORITHM_VERSION,
        ProsodyProfile,
        profile_path,
        profile_words,
        words_fingerprint,
    )
    from podcast_mcp.engines.prosody import ProsodyParams, parselmouth_version
    from podcast_mcp.util.atomic_json import write_json_atomic
    from podcast_mcp.util.tracks import track_audio_path

    stat = track_audio_path(proj, "host").stat()
    segment = {
        "start": 0.0,
        "end": 2.0,
        "f0": {
            "mean_hz": 180.0,
            "median_hz": 175.0,
            "sd_st": 2.0,
            "range_st": 5.0,
            "voiced_fraction": 0.7,
        },
        "rate": {"syllable_count": 4, "speech_rate": 2.0, "articulation_rate": 2.5},
        "pauses": {"count": 0, "total_sec": 0.0},
        "energy": {
            "mean_db": 60.0,
            "sd_db": 5.0,
            "slope_db_per_sec": -1.0,
            "start_third_db": 62.0,
            "mid_third_db": 60.0,
            "end_third_db": 58.0,
            "drop_db": 4.0,
            "trend": "falling",
        },
        "voice_quality": {
            "jitter_local": 0.01,
            "shimmer_local": 0.02,
            "hnr_db": 15.0,
            "jitter_high": False,
            "shimmer_high": False,
            "hnr_low": False,
        },
        "prominent_words": [{"text": "hello", "start": 0.1, "end": 0.4, "score": 1.2}],
        "boundaries": [
            {
                "time": 2.0,
                "strength": 1.0,
                "pause_sec": 0.0,
                "lengthening": 0.0,
                "pitch_reset": 0.0,
                "kind": "segment_end",
            }
        ],
    }
    profile = ProsodyProfile(
        track_id="host",
        audio_sha256="deadbeef",
        audio_size=stat.st_size,
        audio_mtime_ns=stat.st_mtime_ns,
        words_fingerprint=words_fingerprint(profile_words(proj, "host")),
        algorithm_version=ALGORITHM_VERSION,
        params=params if params is not None else ProsodyParams.from_defaults({}).key(),
        engine={"backend": "parselmouth", "version": parselmouth_version() or "0.0.0"},
        segments=[segment],
        computed_at=0.0,
    )
    path = profile_path(proj, "host", "0" * 16, "1" * 16)
    write_json_atomic(path, profile.to_json())
    return path

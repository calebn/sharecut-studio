"""Pin the wire output of prosody windows in audition_context and of PlayService.prosody_overlay."""

from __future__ import annotations

import pytest

from play_compose_wire_cases import CASES, PROSODY_CASES
from play_compose_wire_helpers import dump, play_case, prosody_case, run_prosody_service
from podcast_mcp.engines import bleed_echo

pytestmark = pytest.mark.unscoped_ok


@pytest.fixture(autouse=True)
def _fresh_echo_cache():
    bleed_echo._cached_profiles.cache_clear()


_PROS_SHARED_7 = {
    "drop_db": 4.0,
    "end_third_db": 58.0,
    "mean_db": 60.0,
    "mid_third_db": 60.0,
    "sd_db": 5.0,
    "slope_db_per_sec": -1.0,
    "start_third_db": 62.0,
    "trend": "falling",
}
_PROS_SHARED_2 = {
    "boundaries": [
        {
            "kind": "segment_end",
            "lengthening": 0.0,
            "pause_sec": 0.0,
            "pitch_reset": 0.0,
            "strength": 1.0,
            "time": 2.0,
            "timeline_time": 2.0,
        }
    ],
    "energy": _PROS_SHARED_7,
    "f0": {
        "mean_hz": 180.0,
        "median_hz": 175.0,
        "range_st": 5.0,
        "sd_st": 2.0,
        "voiced_fraction": 0.7,
    },
    "line": "F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
    "pauses": {"count": 0, "total_sec": 0.0},
    "prominent_words": [
        {"end": 0.4, "score": 1.2, "start": 0.1, "text": "hello", "timeline_start": 0.1}
    ],
    "rate": {"articulation_rate": 2.5, "speech_rate": 2.0, "syllable_count": 4},
    "source_end": 2.0,
    "source_start": 0.0,
    "timeline_end": 2.0,
    "timeline_start": 0.0,
    "voice_quality": {
        "hnr_db": 15.0,
        "hnr_low": False,
        "jitter_high": False,
        "jitter_local": 0.01,
        "shimmer_high": False,
        "shimmer_local": 0.02,
    },
}
_PROS_PROSODY = {
    "segments": [
        _PROS_SHARED_2,
        {
            "boundaries": [
                {
                    "kind": "segment_end",
                    "lengthening": 0.0,
                    "pause_sec": 0.0,
                    "pitch_reset": 0.0,
                    "strength": 1.0,
                    "time": 4.0,
                    "timeline_time": 4.0,
                }
            ],
            "energy": _PROS_SHARED_7,
            "f0": {
                "mean_hz": 180.0,
                "median_hz": 175.0,
                "range_st": 5.0,
                "sd_st": 2.0,
                "voiced_fraction": 0.7,
            },
            "line": "F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
            "pauses": {"count": 0, "total_sec": 0.0},
            "prominent_words": [
                {"end": 2.4, "score": 1.2, "start": 2.1, "text": "world", "timeline_start": 2.1}
            ],
            "rate": {"articulation_rate": 2.5, "speech_rate": 2.0, "syllable_count": 4},
            "source_end": 4.0,
            "source_start": 2.0,
            "timeline_end": 4.0,
            "timeline_start": 2.0,
            "voice_quality": {
                "hnr_db": 15.0,
                "hnr_low": False,
                "jitter_high": False,
                "jitter_local": 0.01,
                "shimmer_high": False,
                "shimmer_local": 0.02,
            },
        },
    ],
    "status": "fresh",
    "truncated": False,
}
_PROS_SHARED = [
    {
        "code": "stale_render",
        "confidence": "measured",
        "evidence": {"needs_rerender": True, "premix_exists": False},
        "meaning": "Stems and/or premix are stale relative to the current timeline; play may not match these captions.",
        "next": {
            "fix": {"autonomy": "auto_ok", "skill": None},
            "listen": "sl-1",
            "tools": ["render_preview"],
        },
        "severity": "warn",
        "tracks": ["host", "guest"],
        "window": {"clock": "timeline", "end": 4.0, "start": 0.0, "unit": "sec"},
    },
    {
        "code": "stale_reconciliation",
        "confidence": "measured",
        "evidence": {"reconciliation_stale": True},
        "meaning": "Transcript reconciliation is stale versus current audio state.",
        "next": {
            "fix": {"autonomy": "auto_ok", "skill": "podcast-transcript-reconcile"},
            "listen": "sl-1",
            "tools": ["reconcile_transcript_tool"],
        },
        "severity": "warn",
        "tracks": ["host", "guest"],
        "window": {"clock": "timeline", "end": 4.0, "start": 0.0, "unit": "sec"},
    },
]
_PROS_SHARED_3 = [
    "stale_render: Stems and/or premix are stale relative to the current timeline; play may not match these captions.",
    "stale_reconciliation: Transcript reconciliation is stale versus current audio state.",
]
_PROS_SHARED_4 = {
    "needs_rerender": True,
    "premix_exists": False,
    "reconciliation_stale": True,
    "tracks": {
        "guest": {"stem_exists": False, "stem_is_fresh": False},
        "host": {"stem_exists": False, "stem_is_fresh": False},
    },
}
_PROS_SHARED_5 = {
    "any_skewed": False,
    "pairs": [
        {
            "skew_sec": 0.0,
            "skewed": False,
            "source_delta_sec": 0.0,
            "track_a": "host",
            "track_b": "guest",
        }
    ],
    "threshold_sec": 0.05,
    "warnings": [],
}
_PROS_SHARED_6 = [
    {
        "effects": [],
        "kind": "transcript_caption",
        "muted": False,
        "prosody": _PROS_PROSODY,
        "source_at_mid": 2.0,
        "source_spans": [{"clock": "source", "end": 4.0, "start": 0.0}],
        "suppressed_only": False,
        "text": "hello there world",
        "track_id": "host",
        "word_aligner": "forced",
        "word_count": 3,
    },
    {
        "effects": [],
        "kind": "transcript_caption",
        "muted": False,
        "prosody": _PROS_PROSODY,
        "source_at_mid": 2.0,
        "source_spans": [{"clock": "source", "end": 4.0, "start": 0.0}],
        "suppressed_only": False,
        "text": "totally different topic",
        "track_id": "guest",
        "word_aligner": "forced",
        "word_count": 3,
    },
]
_PROS_SHARED_8 = {
    "hint": "No prosody profile yet; run the pipeline's analyze_prosody step (podcast pipeline run --only analyze_prosody, after reconcile/precorrect) or enable prosody.enabled and re-run the pipeline.",
    "status": "missing",
}
_PROS_SHARED_9 = [
    "host: F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
    "host: F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
    "guest: F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
    "guest: F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
]

_EXPECTED = {
    "prosody-missing": {
        "auxiliary_tracks": [],
        "clip_skew": _PROS_SHARED_5,
        "comments": [],
        "detail": "summary",
        "edits": {"applied": [], "pending": []},
        "hypotheses": _PROS_SHARED,
        "limits": ["cannot_hear", "captions_are_transcript_not_audio", "needs_rerender"],
        "mid_sec": 2.0,
        "prosody_notes": [],
        "render_status": _PROS_SHARED_4,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 4.0,
                "id": "sl-1",
                "source": "premix",
                "start": 0.0,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: hello there world | guest: totally different topic  [2 warnings]",
        "timeline_end": 4.0,
        "timeline_start": 0.0,
        "tracks": [
            {
                "effects": [],
                "kind": "transcript_caption",
                "muted": False,
                "prosody": _PROS_SHARED_8,
                "source_at_mid": 2.0,
                "source_spans": [{"clock": "source", "end": 4.0, "start": 0.0}],
                "suppressed_only": False,
                "text": "hello there world",
                "track_id": "host",
                "word_aligner": "forced",
                "word_count": 3,
            },
            {
                "effects": [],
                "kind": "transcript_caption",
                "muted": False,
                "prosody": _PROS_SHARED_8,
                "source_at_mid": 2.0,
                "source_spans": [{"clock": "source", "end": 4.0, "start": 0.0}],
                "suppressed_only": False,
                "text": "totally different topic",
                "track_id": "guest",
                "word_aligner": "forced",
                "word_count": 3,
            },
        ],
        "warnings": _PROS_SHARED_3,
        "window": {"clock": "timeline", "end": 4.0, "start": 0.0, "unit": "sec"},
    },
    "prosody-both-fresh": {
        "auxiliary_tracks": [],
        "clip_skew": _PROS_SHARED_5,
        "comments": [],
        "detail": "summary",
        "edits": {"applied": [], "pending": []},
        "hypotheses": _PROS_SHARED,
        "limits": ["cannot_hear", "captions_are_transcript_not_audio", "needs_rerender"],
        "mid_sec": 2.0,
        "prosody_notes": _PROS_SHARED_9,
        "render_status": _PROS_SHARED_4,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 4.0,
                "id": "sl-1",
                "source": "premix",
                "start": 0.0,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: hello there world | guest: totally different topic  [2 warnings]",
        "timeline_end": 4.0,
        "timeline_start": 0.0,
        "tracks": _PROS_SHARED_6,
        "warnings": _PROS_SHARED_3,
        "window": {"clock": "timeline", "end": 4.0, "start": 0.0, "unit": "sec"},
    },
    "prosody-both-fresh-wire": {
        "auxiliary_tracks": [],
        "clip_skew": _PROS_SHARED_5,
        "comments": [],
        "detail": "summary",
        "edits": {"applied": [], "pending": []},
        "hypotheses": _PROS_SHARED,
        "limits": [
            "cannot_hear",
            "captions_are_transcript_not_audio",
            "needs_rerender",
            "echo_check_needs_fresh_stems",
        ],
        "mid_sec": 2.0,
        "prosody_notes": _PROS_SHARED_9,
        "render_status": _PROS_SHARED_4,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 4.0,
                "id": "sl-1",
                "source": "premix",
                "start": 0.0,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: hello there world | guest: totally different topic  [2 warnings]",
        "timeline_end": 4.0,
        "timeline_start": 0.0,
        "tracks": _PROS_SHARED_6,
        "warnings": _PROS_SHARED_3,
        "window": {"clock": "timeline", "end": 4.0, "start": 0.0, "unit": "sec"},
    },
    "prosody-both-fresh-full": {
        "auxiliary_tracks": [],
        "clip_skew": _PROS_SHARED_5,
        "comments": [],
        "detail": "full",
        "edits": {"applied": [], "pending": []},
        "hypotheses": _PROS_SHARED,
        "limits": [
            "cannot_hear",
            "captions_are_transcript_not_audio",
            "needs_rerender",
            "echo_check_needs_fresh_stems",
        ],
        "mid_sec": 2.0,
        "prosody_notes": _PROS_SHARED_9,
        "render_status": _PROS_SHARED_4,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 4.0,
                "id": "sl-1",
                "source": "premix",
                "start": 0.0,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: hello there world | guest: totally different topic  [2 warnings]",
        "timeline_end": 4.0,
        "timeline_start": 0.0,
        "tracks": _PROS_SHARED_6,
        "warnings": _PROS_SHARED_3,
        "window": {"clock": "timeline", "end": 4.0, "start": 0.0, "unit": "sec"},
    },
    "prosody-host-only": {
        "auxiliary_tracks": [],
        "clip_skew": _PROS_SHARED_5,
        "comments": [],
        "detail": "summary",
        "edits": {"applied": [], "pending": []},
        "hypotheses": _PROS_SHARED,
        "limits": ["cannot_hear", "captions_are_transcript_not_audio", "needs_rerender"],
        "mid_sec": 2.0,
        "prosody_notes": [
            "host: F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
            "host: F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
        ],
        "render_status": _PROS_SHARED_4,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 4.0,
                "id": "sl-1",
                "source": "premix",
                "start": 0.0,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: hello there world | guest: totally different topic  [2 warnings]",
        "timeline_end": 4.0,
        "timeline_start": 0.0,
        "tracks": [
            {
                "effects": [],
                "kind": "transcript_caption",
                "muted": False,
                "prosody": _PROS_PROSODY,
                "source_at_mid": 2.0,
                "source_spans": [{"clock": "source", "end": 4.0, "start": 0.0}],
                "suppressed_only": False,
                "text": "hello there world",
                "track_id": "host",
                "word_aligner": "forced",
                "word_count": 3,
            },
            {
                "effects": [],
                "kind": "transcript_caption",
                "muted": False,
                "prosody": _PROS_SHARED_8,
                "source_at_mid": 2.0,
                "source_spans": [{"clock": "source", "end": 4.0, "start": 0.0}],
                "suppressed_only": False,
                "text": "totally different topic",
                "track_id": "guest",
                "word_aligner": "forced",
                "word_count": 3,
            },
        ],
        "warnings": _PROS_SHARED_3,
        "window": {"clock": "timeline", "end": 4.0, "start": 0.0, "unit": "sec"},
    },
    "prosody-one-segment": {
        "auxiliary_tracks": [],
        "clip_skew": _PROS_SHARED_5,
        "comments": [],
        "detail": "summary",
        "edits": {"applied": [], "pending": []},
        "hypotheses": [
            {
                "code": "stale_render",
                "confidence": "measured",
                "evidence": {"needs_rerender": True, "premix_exists": False},
                "meaning": "Stems and/or premix are stale relative to the current timeline; play may not match these captions.",
                "next": {
                    "fix": {"autonomy": "auto_ok", "skill": None},
                    "listen": "sl-1",
                    "tools": ["render_preview"],
                },
                "severity": "warn",
                "tracks": ["host", "guest"],
                "window": {"clock": "timeline", "end": 1.5, "start": 0.0, "unit": "sec"},
            },
            {
                "code": "stale_reconciliation",
                "confidence": "measured",
                "evidence": {"reconciliation_stale": True},
                "meaning": "Transcript reconciliation is stale versus current audio state.",
                "next": {
                    "fix": {"autonomy": "auto_ok", "skill": "podcast-transcript-reconcile"},
                    "listen": "sl-1",
                    "tools": ["reconcile_transcript_tool"],
                },
                "severity": "warn",
                "tracks": ["host", "guest"],
                "window": {"clock": "timeline", "end": 1.5, "start": 0.0, "unit": "sec"},
            },
        ],
        "limits": ["cannot_hear", "captions_are_transcript_not_audio", "needs_rerender"],
        "mid_sec": 0.75,
        "prosody_notes": [
            "host: F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
            "guest: F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
        ],
        "render_status": _PROS_SHARED_4,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 1.5,
                "id": "sl-1",
                "source": "premix",
                "start": 0.0,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: hello there | guest: totally different  [2 warnings]",
        "timeline_end": 1.5,
        "timeline_start": 0.0,
        "tracks": [
            {
                "effects": [],
                "kind": "transcript_caption",
                "muted": False,
                "prosody": {"segments": [_PROS_SHARED_2], "status": "fresh", "truncated": False},
                "source_at_mid": 0.75,
                "source_spans": [{"clock": "source", "end": 1.5, "start": 0.0}],
                "suppressed_only": False,
                "text": "hello there",
                "track_id": "host",
                "word_aligner": "forced",
                "word_count": 2,
            },
            {
                "effects": [],
                "kind": "transcript_caption",
                "muted": False,
                "prosody": {"segments": [_PROS_SHARED_2], "status": "fresh", "truncated": False},
                "source_at_mid": 0.75,
                "source_spans": [{"clock": "source", "end": 1.5, "start": 0.0}],
                "suppressed_only": False,
                "text": "totally different",
                "track_id": "guest",
                "word_aligner": "forced",
                "word_count": 2,
            },
        ],
        "warnings": _PROS_SHARED_3,
        "window": {"clock": "timeline", "end": 1.5, "start": 0.0, "unit": "sec"},
    },
    "prosody-outside-segments": {
        "auxiliary_tracks": [],
        "clip_skew": _PROS_SHARED_5,
        "comments": [],
        "detail": "summary",
        "edits": {"applied": [], "pending": []},
        "hypotheses": [
            {
                "code": "stale_render",
                "confidence": "measured",
                "evidence": {"needs_rerender": True, "premix_exists": False},
                "meaning": "Stems and/or premix are stale relative to the current timeline; play may not match these captions.",
                "next": {
                    "fix": {"autonomy": "auto_ok", "skill": None},
                    "listen": "sl-1",
                    "tools": ["render_preview"],
                },
                "severity": "warn",
                "tracks": ["host", "guest"],
                "window": {"clock": "timeline", "end": 6.0, "start": 5.0, "unit": "sec"},
            },
            {
                "code": "stale_reconciliation",
                "confidence": "measured",
                "evidence": {"reconciliation_stale": True},
                "meaning": "Transcript reconciliation is stale versus current audio state.",
                "next": {
                    "fix": {"autonomy": "auto_ok", "skill": "podcast-transcript-reconcile"},
                    "listen": "sl-1",
                    "tools": ["reconcile_transcript_tool"],
                },
                "severity": "warn",
                "tracks": ["host", "guest"],
                "window": {"clock": "timeline", "end": 6.0, "start": 5.0, "unit": "sec"},
            },
        ],
        "limits": ["cannot_hear", "captions_are_transcript_not_audio", "needs_rerender"],
        "mid_sec": 5.5,
        "prosody_notes": [],
        "render_status": _PROS_SHARED_4,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 6.0,
                "id": "sl-1",
                "source": "premix",
                "start": 5.0,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: (silence / no words) | guest: (silence / no words)  [2 warnings]",
        "timeline_end": 6.0,
        "timeline_start": 5.0,
        "tracks": [
            {
                "effects": [],
                "kind": "transcript_caption",
                "muted": False,
                "prosody": {"segments": [], "status": "fresh", "truncated": False},
                "source_at_mid": 5.5,
                "source_spans": [{"clock": "source", "end": 6.0, "start": 5.0}],
                "suppressed_only": False,
                "text": "",
                "track_id": "host",
                "word_aligner": "forced",
                "word_count": 0,
            },
            {
                "effects": [],
                "kind": "transcript_caption",
                "muted": False,
                "prosody": {"segments": [], "status": "fresh", "truncated": False},
                "source_at_mid": 5.5,
                "source_spans": [{"clock": "source", "end": 6.0, "start": 5.0}],
                "suppressed_only": False,
                "text": "",
                "track_id": "guest",
                "word_aligner": "forced",
                "word_count": 0,
            },
        ],
        "warnings": _PROS_SHARED_3,
        "window": {"clock": "timeline", "end": 6.0, "start": 5.0, "unit": "sec"},
    },
    "prosody-stale-words": {
        "auxiliary_tracks": [],
        "clip_skew": _PROS_SHARED_5,
        "comments": [],
        "detail": "summary",
        "edits": {"applied": [], "pending": []},
        "hypotheses": _PROS_SHARED,
        "limits": ["cannot_hear", "captions_are_transcript_not_audio", "needs_rerender"],
        "mid_sec": 2.0,
        "prosody_notes": [
            "guest: F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
            "guest: F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
        ],
        "render_status": _PROS_SHARED_4,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 4.0,
                "id": "sl-1",
                "source": "premix",
                "start": 0.0,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: hello there world | guest: totally different topic  [2 warnings]",
        "timeline_end": 4.0,
        "timeline_start": 0.0,
        "tracks": [
            {
                "effects": [],
                "kind": "transcript_caption",
                "muted": False,
                "prosody": {
                    "hint": "Transcript changed since the profile was computed; re-run analyze_prosody.",
                    "status": "stale",
                },
                "source_at_mid": 2.0,
                "source_spans": [{"clock": "source", "end": 4.0, "start": 0.0}],
                "suppressed_only": False,
                "text": "hello there world",
                "track_id": "host",
                "word_aligner": "forced",
                "word_count": 3,
            },
            {
                "effects": [],
                "kind": "transcript_caption",
                "muted": False,
                "prosody": _PROS_PROSODY,
                "source_at_mid": 2.0,
                "source_spans": [{"clock": "source", "end": 4.0, "start": 0.0}],
                "suppressed_only": False,
                "text": "totally different topic",
                "track_id": "guest",
                "word_aligner": "forced",
                "word_count": 3,
            },
        ],
        "warnings": _PROS_SHARED_3,
        "window": {"clock": "timeline", "end": 4.0, "start": 0.0, "unit": "sec"},
    },
    "prosody-truncated": {
        "auxiliary_tracks": [],
        "clip_skew": _PROS_SHARED_5,
        "comments": [],
        "detail": "summary",
        "edits": {"applied": [], "pending": []},
        "hypotheses": [
            {
                "code": "stale_render",
                "confidence": "measured",
                "evidence": {"needs_rerender": True, "premix_exists": False},
                "meaning": "Stems and/or premix are stale relative to the current timeline; play may not match these captions.",
                "next": {
                    "fix": {"autonomy": "auto_ok", "skill": None},
                    "listen": "sl-1",
                    "tools": ["render_preview"],
                },
                "severity": "warn",
                "tracks": ["host", "guest"],
                "window": {"clock": "timeline", "end": 16.0, "start": 0.0, "unit": "sec"},
            },
            {
                "code": "stale_reconciliation",
                "confidence": "measured",
                "evidence": {"reconciliation_stale": True},
                "meaning": "Transcript reconciliation is stale versus current audio state.",
                "next": {
                    "fix": {"autonomy": "auto_ok", "skill": "podcast-transcript-reconcile"},
                    "listen": "sl-1",
                    "tools": ["reconcile_transcript_tool"],
                },
                "severity": "warn",
                "tracks": ["host", "guest"],
                "window": {"clock": "timeline", "end": 16.0, "start": 0.0, "unit": "sec"},
            },
        ],
        "limits": ["cannot_hear", "captions_are_transcript_not_audio", "needs_rerender"],
        "mid_sec": 8.0,
        "prosody_notes": [
            "host: F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
            "host: F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
            "host: F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
            "host: F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
            "host: F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
            "host: F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
        ],
        "render_status": _PROS_SHARED_4,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 16.0,
                "id": "sl-1",
                "source": "premix",
                "start": 0.0,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: hello there world | guest: totally different topic  [2 warnings]",
        "timeline_end": 16.0,
        "timeline_start": 0.0,
        "tracks": [
            {
                "effects": [],
                "kind": "transcript_caption",
                "muted": False,
                "prosody": {
                    "segments": [
                        _PROS_SHARED_2,
                        {
                            "boundaries": [
                                {
                                    "kind": "segment_end",
                                    "lengthening": 0.0,
                                    "pause_sec": 0.0,
                                    "pitch_reset": 0.0,
                                    "strength": 1.0,
                                    "time": 4.0,
                                    "timeline_time": 4.0,
                                }
                            ],
                            "energy": _PROS_SHARED_7,
                            "f0": {
                                "mean_hz": 180.0,
                                "median_hz": 175.0,
                                "range_st": 5.0,
                                "sd_st": 2.0,
                                "voiced_fraction": 0.7,
                            },
                            "line": "F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
                            "pauses": {"count": 0, "total_sec": 0.0},
                            "prominent_words": [
                                {
                                    "end": 2.4,
                                    "score": 1.2,
                                    "start": 2.1,
                                    "text": "hello",
                                    "timeline_start": 2.1,
                                }
                            ],
                            "rate": {
                                "articulation_rate": 2.5,
                                "speech_rate": 2.0,
                                "syllable_count": 4,
                            },
                            "source_end": 4.0,
                            "source_start": 2.0,
                            "timeline_end": 4.0,
                            "timeline_start": 2.0,
                            "voice_quality": {
                                "hnr_db": 15.0,
                                "hnr_low": False,
                                "jitter_high": False,
                                "jitter_local": 0.01,
                                "shimmer_high": False,
                                "shimmer_local": 0.02,
                            },
                        },
                        {
                            "boundaries": [
                                {
                                    "kind": "segment_end",
                                    "lengthening": 0.0,
                                    "pause_sec": 0.0,
                                    "pitch_reset": 0.0,
                                    "strength": 1.0,
                                    "time": 6.0,
                                    "timeline_time": 6.0,
                                }
                            ],
                            "energy": _PROS_SHARED_7,
                            "f0": {
                                "mean_hz": 180.0,
                                "median_hz": 175.0,
                                "range_st": 5.0,
                                "sd_st": 2.0,
                                "voiced_fraction": 0.7,
                            },
                            "line": "F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
                            "pauses": {"count": 0, "total_sec": 0.0},
                            "prominent_words": [
                                {
                                    "end": 4.4,
                                    "score": 1.2,
                                    "start": 4.1,
                                    "text": "hello",
                                    "timeline_start": 4.1,
                                }
                            ],
                            "rate": {
                                "articulation_rate": 2.5,
                                "speech_rate": 2.0,
                                "syllable_count": 4,
                            },
                            "source_end": 6.0,
                            "source_start": 4.0,
                            "timeline_end": 6.0,
                            "timeline_start": 4.0,
                            "voice_quality": {
                                "hnr_db": 15.0,
                                "hnr_low": False,
                                "jitter_high": False,
                                "jitter_local": 0.01,
                                "shimmer_high": False,
                                "shimmer_local": 0.02,
                            },
                        },
                        {
                            "boundaries": [
                                {
                                    "kind": "segment_end",
                                    "lengthening": 0.0,
                                    "pause_sec": 0.0,
                                    "pitch_reset": 0.0,
                                    "strength": 1.0,
                                    "time": 8.0,
                                    "timeline_time": 8.0,
                                }
                            ],
                            "energy": _PROS_SHARED_7,
                            "f0": {
                                "mean_hz": 180.0,
                                "median_hz": 175.0,
                                "range_st": 5.0,
                                "sd_st": 2.0,
                                "voiced_fraction": 0.7,
                            },
                            "line": "F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
                            "pauses": {"count": 0, "total_sec": 0.0},
                            "prominent_words": [
                                {
                                    "end": 6.4,
                                    "score": 1.2,
                                    "start": 6.1,
                                    "text": "hello",
                                    "timeline_start": 6.1,
                                }
                            ],
                            "rate": {
                                "articulation_rate": 2.5,
                                "speech_rate": 2.0,
                                "syllable_count": 4,
                            },
                            "source_end": 8.0,
                            "source_start": 6.0,
                            "timeline_end": 8.0,
                            "timeline_start": 6.0,
                            "voice_quality": {
                                "hnr_db": 15.0,
                                "hnr_low": False,
                                "jitter_high": False,
                                "jitter_local": 0.01,
                                "shimmer_high": False,
                                "shimmer_local": 0.02,
                            },
                        },
                        {
                            "boundaries": [
                                {
                                    "kind": "segment_end",
                                    "lengthening": 0.0,
                                    "pause_sec": 0.0,
                                    "pitch_reset": 0.0,
                                    "strength": 1.0,
                                    "time": 10.0,
                                    "timeline_time": 10.0,
                                }
                            ],
                            "energy": _PROS_SHARED_7,
                            "f0": {
                                "mean_hz": 180.0,
                                "median_hz": 175.0,
                                "range_st": 5.0,
                                "sd_st": 2.0,
                                "voiced_fraction": 0.7,
                            },
                            "line": "F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
                            "pauses": {"count": 0, "total_sec": 0.0},
                            "prominent_words": [
                                {
                                    "end": 8.4,
                                    "score": 1.2,
                                    "start": 8.1,
                                    "text": "hello",
                                    "timeline_start": 8.1,
                                }
                            ],
                            "rate": {
                                "articulation_rate": 2.5,
                                "speech_rate": 2.0,
                                "syllable_count": 4,
                            },
                            "source_end": 10.0,
                            "source_start": 8.0,
                            "timeline_end": 10.0,
                            "timeline_start": 8.0,
                            "voice_quality": {
                                "hnr_db": 15.0,
                                "hnr_low": False,
                                "jitter_high": False,
                                "jitter_local": 0.01,
                                "shimmer_high": False,
                                "shimmer_local": 0.02,
                            },
                        },
                        {
                            "boundaries": [
                                {
                                    "kind": "segment_end",
                                    "lengthening": 0.0,
                                    "pause_sec": 0.0,
                                    "pitch_reset": 0.0,
                                    "strength": 1.0,
                                    "time": 12.0,
                                    "timeline_time": 12.0,
                                }
                            ],
                            "energy": _PROS_SHARED_7,
                            "f0": {
                                "mean_hz": 180.0,
                                "median_hz": 175.0,
                                "range_st": 5.0,
                                "sd_st": 2.0,
                                "voiced_fraction": 0.7,
                            },
                            "line": "F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
                            "pauses": {"count": 0, "total_sec": 0.0},
                            "prominent_words": [
                                {
                                    "end": 10.4,
                                    "score": 1.2,
                                    "start": 10.1,
                                    "text": "hello",
                                    "timeline_start": 10.1,
                                }
                            ],
                            "rate": {
                                "articulation_rate": 2.5,
                                "speech_rate": 2.0,
                                "syllable_count": 4,
                            },
                            "source_end": 12.0,
                            "source_start": 10.0,
                            "timeline_end": 12.0,
                            "timeline_start": 10.0,
                            "voice_quality": {
                                "hnr_db": 15.0,
                                "hnr_low": False,
                                "jitter_high": False,
                                "jitter_local": 0.01,
                                "shimmer_high": False,
                                "shimmer_local": 0.02,
                            },
                        },
                    ],
                    "status": "fresh",
                    "truncated": True,
                },
                "source_at_mid": 8.0,
                "source_spans": [{"clock": "source", "end": 16.0, "start": 0.0}],
                "suppressed_only": False,
                "text": "hello there world",
                "track_id": "host",
                "word_aligner": "forced",
                "word_count": 3,
            },
            {
                "effects": [],
                "kind": "transcript_caption",
                "muted": False,
                "prosody": _PROS_SHARED_8,
                "source_at_mid": 8.0,
                "source_spans": [{"clock": "source", "end": 16.0, "start": 0.0}],
                "suppressed_only": False,
                "text": "totally different topic",
                "track_id": "guest",
                "word_aligner": "forced",
                "word_count": 3,
            },
        ],
        "warnings": _PROS_SHARED_3,
        "window": {"clock": "timeline", "end": 16.0, "start": 0.0, "unit": "sec"},
    },
}

_OV_SHARED = {
    "drop_db": 4.0,
    "energy_thirds": [
        {"db": 62.0, "spans": [{"end": 0.6667, "start": 0.0}]},
        {"db": 60.0, "spans": [{"end": 1.3333, "start": 0.6667}]},
        {"db": 58.0, "spans": [{"end": 2.0, "start": 1.3333}]},
    ],
    "line": "F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
    "source_end": 2.0,
    "source_start": 0.0,
    "spans": [{"end": 2.0, "start": 0.0}],
    "trend": "falling",
}
_OV_SHARED_2 = {
    "drop_db": 4.0,
    "energy_thirds": [
        {"db": 62.0, "spans": [{"end": 1.1667, "start": 0.5}]},
        {"db": 60.0, "spans": [{"end": 1.8333, "start": 1.1667}]},
        {"db": 58.0, "spans": [{"end": 2.5, "start": 1.8333}]},
    ],
    "line": "F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
    "source_end": 2.5,
    "source_start": 0.5,
    "spans": [{"end": 2.5, "start": 0.5}],
    "trend": "falling",
}
_OV_PROSODY = {
    "boundaries": [{"kind": "segment_end", "pause_sec": 0.0, "strength": 1.0, "timeline_sec": 2.0}],
    "energy_db": {"max": 62.0, "min": 58.0},
    "prominent_words": [{"score": 1.2, "text": "hello", "timeline_sec": 0.1, "word_index": None}],
    "segments": [_OV_SHARED],
    "status": "fresh",
    "track_id": "host",
}
_OV_PROSODY_2 = {
    "boundaries": [],
    "energy_db": None,
    "hint": "No prosody profile yet; run the pipeline's analyze_prosody step (podcast pipeline run --only analyze_prosody, after reconcile/precorrect) or enable prosody.enabled and re-run the pipeline.",
    "prominent_words": [],
    "segments": [],
    "status": "missing",
    "track_id": "host",
}

_OVERLAY_EXPECTED = {
    "empty-project": {"schema": "prosody_overlay.v1", "tracks": []},
    "music-only": {"schema": "prosody_overlay.v1", "tracks": []},
    "one-track-missing": {"schema": "prosody_overlay.v1", "tracks": [_OV_PROSODY_2]},
    "one-track-fresh": {"schema": "prosody_overlay.v1", "tracks": [_OV_PROSODY]},
    "one-track-three-segments": {
        "schema": "prosody_overlay.v1",
        "tracks": [
            {
                "boundaries": [
                    {"kind": "segment_end", "pause_sec": 0.0, "strength": 1.0, "timeline_sec": 2.0},
                    {"kind": "segment_end", "pause_sec": 0.0, "strength": 1.0, "timeline_sec": 3.0},
                    {"kind": "segment_end", "pause_sec": 0.0, "strength": 1.0, "timeline_sec": 5.0},
                ],
                "energy_db": {"max": 62.0, "min": 58.0},
                "prominent_words": [
                    {"score": 1.2, "text": "hello", "timeline_sec": 0.1, "word_index": None},
                    {"score": 1.2, "text": "world", "timeline_sec": 2.1, "word_index": None},
                    {"score": 1.2, "text": "again", "timeline_sec": 3.6, "word_index": None},
                ],
                "segments": [
                    _OV_SHARED,
                    {
                        "drop_db": 4.0,
                        "energy_thirds": [
                            {"db": 62.0, "spans": [{"end": 2.3333, "start": 2.0}]},
                            {"db": 60.0, "spans": [{"end": 2.6667, "start": 2.3333}]},
                            {"db": 58.0, "spans": [{"end": 3.0, "start": 2.6667}]},
                        ],
                        "line": "F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
                        "source_end": 3.0,
                        "source_start": 2.0,
                        "spans": [{"end": 3.0, "start": 2.0}],
                        "trend": "falling",
                    },
                    {
                        "drop_db": 4.0,
                        "energy_thirds": [
                            {"db": 62.0, "spans": [{"end": 4.0, "start": 3.5}]},
                            {"db": 60.0, "spans": [{"end": 4.5, "start": 4.0}]},
                            {"db": 58.0, "spans": [{"end": 5.0, "start": 4.5}]},
                        ],
                        "line": "F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
                        "source_end": 5.0,
                        "source_start": 3.5,
                        "spans": [{"end": 5.0, "start": 3.5}],
                        "trend": "falling",
                    },
                ],
                "status": "fresh",
                "track_id": "host",
            }
        ],
    },
    "two-tracks-fresh": {
        "schema": "prosody_overlay.v1",
        "tracks": [
            _OV_PROSODY,
            {
                "boundaries": [
                    {"kind": "segment_end", "pause_sec": 0.0, "strength": 1.0, "timeline_sec": 2.5},
                    {"kind": "segment_end", "pause_sec": 0.0, "strength": 1.0, "timeline_sec": 4.0},
                ],
                "energy_db": {"max": 62.0, "min": 58.0},
                "prominent_words": [
                    {"score": 1.2, "text": "hello", "timeline_sec": 0.6, "word_index": None},
                    {"score": 1.2, "text": "world", "timeline_sec": 3.1, "word_index": None},
                ],
                "segments": [
                    _OV_SHARED_2,
                    {
                        "drop_db": 4.0,
                        "energy_thirds": [
                            {"db": 62.0, "spans": [{"end": 3.3333, "start": 3.0}]},
                            {"db": 60.0, "spans": [{"end": 3.6667, "start": 3.3333}]},
                            {"db": 58.0, "spans": [{"end": 4.0, "start": 3.6667}]},
                        ],
                        "line": "F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
                        "source_end": 4.0,
                        "source_start": 3.0,
                        "spans": [{"end": 4.0, "start": 3.0}],
                        "trend": "falling",
                    },
                ],
                "status": "fresh",
                "track_id": "guest",
            },
        ],
    },
    "two-tracks-one-missing": {
        "schema": "prosody_overlay.v1",
        "tracks": [
            _OV_PROSODY_2,
            {
                "boundaries": [
                    {"kind": "segment_end", "pause_sec": 0.0, "strength": 1.0, "timeline_sec": 2.5}
                ],
                "energy_db": {"max": 62.0, "min": 58.0},
                "prominent_words": [
                    {"score": 1.2, "text": "hello", "timeline_sec": 0.6, "word_index": None}
                ],
                "segments": [_OV_SHARED_2],
                "status": "fresh",
                "track_id": "guest",
            },
        ],
    },
    "two-tracks-missing": {
        "schema": "prosody_overlay.v1",
        "tracks": [
            _OV_PROSODY_2,
            {
                "boundaries": [],
                "energy_db": None,
                "hint": "No prosody profile yet; run the pipeline's analyze_prosody step (podcast pipeline run --only analyze_prosody, after reconcile/precorrect) or enable prosody.enabled and re-run the pipeline.",
                "prominent_words": [],
                "segments": [],
                "status": "missing",
                "track_id": "guest",
            },
        ],
    },
    "three-tracks-mixed-statuses": {
        "schema": "prosody_overlay.v1",
        "tracks": [
            _OV_PROSODY,
            {
                "boundaries": [
                    {"kind": "segment_end", "pause_sec": 0.0, "strength": 1.0, "timeline_sec": 2.5}
                ],
                "energy_db": {"max": 62.0, "min": 58.0},
                "hint": "Transcript changed since the profile was computed; re-run analyze_prosody.",
                "prominent_words": [
                    {"score": 1.2, "text": "hello", "timeline_sec": 0.6, "word_index": None}
                ],
                "segments": [_OV_SHARED_2],
                "status": "stale",
                "track_id": "guest",
            },
            {
                "boundaries": [],
                "energy_db": None,
                "hint": "The cached prosody profile could not be read; re-run analyze_prosody.",
                "prominent_words": [],
                "segments": [],
                "status": "unavailable",
                "track_id": "third",
            },
        ],
    },
    "engine-changed": {
        "schema": "prosody_overlay.v1",
        "tracks": [
            {
                "boundaries": [
                    {"kind": "segment_end", "pause_sec": 0.0, "strength": 1.0, "timeline_sec": 2.0}
                ],
                "energy_db": {"max": 62.0, "min": 58.0},
                "hint": "Prosody algorithm or engine changed since the profile was computed; re-run analyze_prosody.",
                "prominent_words": [
                    {"score": 1.2, "text": "hello", "timeline_sec": 0.1, "word_index": None}
                ],
                "segments": [_OV_SHARED],
                "status": "stale",
                "track_id": "host",
            }
        ],
    },
    "staged-params-differ": {
        "schema": "prosody_overlay.v1",
        "tracks": [
            {
                "boundaries": [
                    {"kind": "segment_end", "pause_sec": 0.0, "strength": 1.0, "timeline_sec": 2.0}
                ],
                "energy_db": {"max": 62.0, "min": 58.0},
                "hint": "The staged prosody.* settings differ from the ones the profile was computed with; re-run analyze_prosody.",
                "prominent_words": [
                    {"score": 1.2, "text": "hello", "timeline_sec": 0.1, "word_index": None}
                ],
                "segments": [_OV_SHARED],
                "status": "stale",
                "track_id": "host",
            },
            {
                "boundaries": [
                    {"kind": "segment_end", "pause_sec": 0.0, "strength": 1.0, "timeline_sec": 2.5},
                    {"kind": "segment_end", "pause_sec": 0.0, "strength": 1.0, "timeline_sec": 4.0},
                ],
                "energy_db": {"max": 62.0, "min": 58.0},
                "hint": "The staged prosody.* settings differ from the ones the profile was computed with; re-run analyze_prosody.",
                "prominent_words": [
                    {"score": 1.2, "text": "hello", "timeline_sec": 0.6, "word_index": None},
                    {"score": 1.2, "text": "world", "timeline_sec": 3.1, "word_index": None},
                ],
                "segments": [
                    _OV_SHARED_2,
                    {
                        "drop_db": 4.0,
                        "energy_thirds": [
                            {"db": 62.0, "spans": [{"end": 3.3333, "start": 3.0}]},
                            {"db": 60.0, "spans": [{"end": 3.6667, "start": 3.3333}]},
                            {"db": 58.0, "spans": [{"end": 4.0, "start": 3.6667}]},
                        ],
                        "line": "F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
                        "source_end": 4.0,
                        "source_start": 3.0,
                        "spans": [{"end": 4.0, "start": 3.0}],
                        "trend": "falling",
                    },
                ],
                "status": "stale",
                "track_id": "guest",
            },
        ],
    },
    "cut-clips": {
        "schema": "prosody_overlay.v1",
        "tracks": [
            {
                "boundaries": [
                    {"kind": "segment_end", "pause_sec": 0.0, "strength": 1.0, "timeline_sec": 1.5},
                    {"kind": "segment_end", "pause_sec": 0.0, "strength": 1.0, "timeline_sec": 3.5},
                ],
                "energy_db": {"max": 62.0, "min": 58.0},
                "prominent_words": [
                    {"score": 1.2, "text": "hello", "timeline_sec": 0.1, "word_index": None},
                    {"score": 1.2, "text": "world", "timeline_sec": 1.6, "word_index": None},
                ],
                "segments": [
                    {
                        "drop_db": 4.0,
                        "energy_thirds": [
                            {"db": 62.0, "spans": [{"end": 0.6667, "start": 0.0}]},
                            {"db": 60.0, "spans": [{"end": 1.0, "start": 0.6667}]},
                            {"db": 58.0, "spans": [{"end": 1.5, "start": 1.0}]},
                        ],
                        "line": "F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
                        "source_end": 2.0,
                        "source_start": 0.0,
                        "spans": [{"end": 1.5, "start": 0.0}],
                        "trend": "falling",
                    },
                    {
                        "drop_db": 4.0,
                        "energy_thirds": [
                            {"db": 62.0, "spans": [{"end": 2.1667, "start": 1.5}]},
                            {"db": 60.0, "spans": [{"end": 2.8333, "start": 2.1667}]},
                            {"db": 58.0, "spans": [{"end": 3.5, "start": 2.8333}]},
                        ],
                        "line": "F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
                        "source_end": 4.0,
                        "source_start": 2.0,
                        "spans": [{"end": 3.5, "start": 1.5}],
                        "trend": "falling",
                    },
                ],
                "status": "fresh",
                "track_id": "host",
            }
        ],
    },
    "segment-cut-away": {
        "schema": "prosody_overlay.v1",
        "tracks": [
            {
                "boundaries": [],
                "energy_db": {"max": 62.0, "min": 58.0},
                "prominent_words": [
                    {"score": 1.2, "text": "hello", "timeline_sec": 0.1, "word_index": None},
                    {"score": 1.2, "text": "world", "timeline_sec": None, "word_index": None},
                ],
                "segments": [
                    {
                        "drop_db": 4.0,
                        "energy_thirds": [
                            {"db": 62.0, "spans": [{"end": 0.6667, "start": 0.0}]},
                            {"db": 60.0, "spans": [{"end": 1.0, "start": 0.6667}]},
                            {"db": 58.0, "spans": []},
                        ],
                        "line": "F0 180Hz (±2.0st), rate 2.0 syll/s, energy falling (4.0dB), HNR 15dB",
                        "source_end": 2.0,
                        "source_start": 0.0,
                        "spans": [{"end": 1.0, "start": 0.0}],
                        "trend": "falling",
                    }
                ],
                "status": "fresh",
                "track_id": "host",
            }
        ],
    },
    "sparse-segment": {
        "schema": "prosody_overlay.v1",
        "tracks": [
            {
                "boundaries": [
                    {"kind": "word_gap", "pause_sec": 0.0, "strength": 0.0, "timeline_sec": 1.0}
                ],
                "energy_db": None,
                "prominent_words": [],
                "segments": [
                    {
                        "drop_db": 0.0,
                        "energy_thirds": [
                            {"db": 0.0, "spans": [{"end": 0.6667, "start": 0.0}]},
                            {"db": 0.0, "spans": [{"end": 1.3333, "start": 0.6667}]},
                            {"db": 0.0, "spans": [{"end": 2.0, "start": 1.3333}]},
                        ],
                        "line": "F0 180Hz (±2.0st), rate 2.0 syll/s, energy flat (0.0dB), HNR 15dB",
                        "source_end": 2.0,
                        "source_start": 0.0,
                        "spans": [{"end": 2.0, "start": 0.0}],
                        "trend": "flat",
                    }
                ],
                "status": "fresh",
                "track_id": "host",
            }
        ],
    },
    "unmatched-words": {
        "schema": "prosody_overlay.v1",
        "tracks": [
            {
                "boundaries": [
                    {"kind": "segment_end", "pause_sec": 0.0, "strength": 1.0, "timeline_sec": 2.0}
                ],
                "energy_db": {"max": 62.0, "min": 58.0},
                "prominent_words": [
                    {"score": 1.2, "text": "nothing", "timeline_sec": 0.1, "word_index": None},
                    {"score": 0.5, "text": "world", "timeline_sec": 2.52, "word_index": 2},
                    {"score": 0.2, "text": "gone", "timeline_sec": None, "word_index": None},
                ],
                "segments": [_OV_SHARED],
                "status": "fresh",
                "track_id": "host",
            }
        ],
    },
    "track-without-media": {
        "schema": "prosody_overlay.v1",
        "tracks": [
            {
                "boundaries": [
                    {"kind": "segment_end", "pause_sec": 0.0, "strength": 1.0, "timeline_sec": 2.0}
                ],
                "energy_db": {"max": 62.0, "min": 58.0},
                "hint": "Track has no media; re-run analyze_prosody.",
                "prominent_words": [
                    {"score": 1.2, "text": "hello", "timeline_sec": 0.1, "word_index": None}
                ],
                "segments": [_OV_SHARED],
                "status": "stale",
                "track_id": "host",
            }
        ],
    },
    "wordless-track": {"schema": "prosody_overlay.v1", "tracks": [_OV_PROSODY]},
}


_PINS = [(name, surface) for name in _EXPECTED for surface in CASES[name].surfaces]


@pytest.mark.parametrize(
    ("name", "surface"), _PINS, ids=[f"{name}-{surface}" for name, surface in _PINS]
)
def test_audition_context_wire(tmp_path, monkeypatch, name, surface):
    result = play_case(CASES[name], tmp_path, monkeypatch, surface)
    assert dump(result) == dump(_EXPECTED[name])


_OVERLAY_PINS = [(name, s) for name in _OVERLAY_EXPECTED for s in ("service", "web")]


@pytest.mark.parametrize(
    ("name", "surface"), _OVERLAY_PINS, ids=[f"{name}-{s}" for name, s in _OVERLAY_PINS]
)
def test_prosody_overlay_wire(tmp_path, monkeypatch, name, surface):
    result = prosody_case(PROSODY_CASES[name], tmp_path, monkeypatch, surface)
    assert dump(result) == dump(_OVERLAY_EXPECTED[name])


def test_the_overlay_is_a_plain_dict_with_ordered_keys(tmp_path, monkeypatch):
    ws = PROSODY_CASES["two-tracks-fresh"].build(tmp_path)
    result = run_prosody_service(ws)
    assert type(result) is dict
    assert list(result) == ["schema", "tracks"]
    assert [list(row) for row in result["tracks"]] == [_TRACK_KEYS, _TRACK_KEYS]
    assert list(result["tracks"][0]["segments"][0]) == _SEGMENT_KEYS
    assert list(result["tracks"][0]["segments"][0]["energy_thirds"][0]) == ["db", "spans"]
    assert list(result["tracks"][0]["boundaries"][0]) == [
        "timeline_sec",
        "strength",
        "kind",
        "pause_sec",
    ]
    assert list(result["tracks"][0]["prominent_words"][0]) == [
        "text",
        "score",
        "word_index",
        "timeline_sec",
    ]


def test_a_track_without_a_profile_keeps_its_keys_in_order(tmp_path):
    ws = PROSODY_CASES["one-track-missing"].build(tmp_path)
    (row,) = run_prosody_service(ws)["tracks"]
    assert list(row) == [*_TRACK_KEYS, "hint"]


_TRACK_KEYS = [
    "track_id",
    "status",
    "segments",
    "boundaries",
    "prominent_words",
    "energy_db",
]
_SEGMENT_KEYS = [
    "source_start",
    "source_end",
    "spans",
    "energy_thirds",
    "trend",
    "drop_db",
    "line",
]


def test_the_route_returns_the_service_overlay_as_json(tmp_path, monkeypatch):
    from play_compose_wire_helpers import run_prosody_web

    ws = PROSODY_CASES["two-tracks-fresh"].build(tmp_path)
    assert run_prosody_web(ws) == run_prosody_service(ws)


def test_the_route_needs_a_path(tmp_path):
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    with TestClient(create_app()) as client:
        reply = client.get("/api/project/prosody")
    assert reply.status_code == 422
    assert reply.json() == {
        "message": "Invalid request. Please refresh and try again.",
        "detail": [
            {
                "loc": ["query", "path"],
                "msg": "Invalid request. Please refresh and try again.",
                "type": "invalid_request",
            }
        ],
    }


def test_the_route_reports_a_missing_project(tmp_path):
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    missing = tmp_path / "nope.sharecut"
    with TestClient(create_app()) as client:
        reply = client.get("/api/project/prosody", params={"path": str(missing)})
    assert reply.status_code == 404
    assert reply.json() == {"detail": f"Project not found: {missing}"}


def test_staged_prosody_settings_decide_fresh_or_stale(tmp_path):
    from podcast_mcp.services.document import PlayService
    from podcast_mcp.services.pipeline.config import config_store

    ws = PROSODY_CASES["one-track-fresh"].build(tmp_path)
    store = config_store()
    try:
        assert PlayService(ws).prosody_overlay()["tracks"][0]["status"] == "fresh"
        store.put(ws.path, config={"prosody": {"pitch_floor_hz": 90.0}})
        row = PlayService(ws).prosody_overlay()["tracks"][0]
        assert row["status"] == "stale"
        assert row["hint"] == (
            "The staged prosody.* settings differ from the ones the profile was computed "
            "with; re-run analyze_prosody."
        )
        assert len(row["segments"]) == 1
        store.put(ws.path, reset=True)
        assert PlayService(ws).prosody_overlay()["tracks"][0]["status"] == "fresh"
    finally:
        store._by_path.pop(store._key(ws.path), None)

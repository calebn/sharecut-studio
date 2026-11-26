"""Pin audition_context wire output for pending edits, audio checks and applied edits."""

from __future__ import annotations

import pytest

from play_compose_wire_cases import CASES
from play_compose_wire_helpers import dump, play_case, run_service
from podcast_mcp.engines import bleed_echo

pytestmark = pytest.mark.unscoped_ok


@pytest.fixture(autouse=True)
def _fresh_echo_cache():
    bleed_echo._cached_profiles.cache_clear()


_EDIT_SHARED = {
    "hint": "No prosody profile yet; run the pipeline's analyze_prosody step (podcast pipeline run --only analyze_prosody, after reconcile/precorrect) or enable prosody.enabled and re-run the pipeline.",
    "status": "missing",
}
_EDIT_SHARED_2 = {
    "needs_rerender": True,
    "premix_exists": False,
    "reconciliation_stale": True,
    "tracks": {
        "guest": {"stem_exists": False, "stem_is_fresh": False},
        "host": {"stem_exists": False, "stem_is_fresh": False},
    },
}
_EDIT_SHARED_3 = [
    {
        "effects": [],
        "kind": "transcript_caption",
        "muted": False,
        "prosody": _EDIT_SHARED,
        "source_at_mid": 2.97,
        "source_spans": [
            {"clock": "source", "end": 1.4, "start": 0.0},
            {"clock": "source", "end": 5.92, "start": 1.42},
        ],
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
        "prosody": _EDIT_SHARED,
        "source_at_mid": 2.95,
        "source_spans": [{"clock": "source", "end": 5.9, "start": 0.0}],
        "suppressed_only": False,
        "text": "totally different topic",
        "track_id": "guest",
        "word_aligner": "forced",
        "word_count": 3,
    },
]
_EDIT_EDITS_IN_WINDOW = {
    "code": "edits_in_window",
    "confidence": "measured",
    "evidence": {"applied": 0, "pending": 2},
    "meaning": "edits_in_window: 2 pending, 0 applied overlapping this span",
    "next": {
        "fix": {"autonomy": "needs_approval", "skill": "podcast-edit-natural-language"},
        "listen": "sl-1",
        "tools": ["play_pending_preview_tool"],
    },
    "severity": "info",
    "tracks": ["host"],
    "window": {"clock": "timeline", "end": 5.9, "start": 0.0, "unit": "sec"},
}
_EDIT_STALE_RECONCILIATION = {
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
    "window": {"clock": "timeline", "end": 5.9, "start": 0.0, "unit": "sec"},
}
_EDIT_STALE_RENDER = {
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
    "window": {"clock": "timeline", "end": 5.9, "start": 0.0, "unit": "sec"},
}
_EDIT_SHARED_4 = [_EDIT_STALE_RENDER, _EDIT_STALE_RECONCILIATION, _EDIT_EDITS_IN_WINDOW]
_EDIT_SHARED_5 = {
    "any_skewed": False,
    "pairs": [
        {
            "skew_sec": 0.02,
            "skewed": False,
            "source_delta_sec": 0.02,
            "track_a": "host",
            "track_b": "guest",
        }
    ],
    "threshold_sec": 0.05,
    "warnings": [],
}
_EDIT_SHARED_6 = [
    {
        "effects": [],
        "kind": "transcript_caption",
        "muted": False,
        "prosody": _EDIT_SHARED,
        "source_at_mid": 2.77,
        "source_spans": [
            {"clock": "source", "end": 1.4, "start": 0.5},
            {"clock": "source", "end": 5.02, "start": 1.42},
        ],
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
        "prosody": _EDIT_SHARED,
        "source_at_mid": 2.75,
        "source_spans": [{"clock": "source", "end": 5.0, "start": 0.5}],
        "suppressed_only": False,
        "text": "totally different topic",
        "track_id": "guest",
        "word_aligner": "forced",
        "word_count": 3,
    },
]
_EDIT_DSP_UNAVAILABLE = {
    "code": "dsp_unavailable",
    "confidence": "measured",
    "evidence": {
        "reason": "timeline window is not a single source span (join or gap); DSP skipped"
    },
    "meaning": "Windowed astats/hum could not run for this span; do not treat the window as clean.",
    "next": {
        "fix": {"autonomy": "present_only", "skill": None},
        "listen": "sl-1",
        "tools": ["audio_diagnostics_tool"],
    },
    "severity": "info",
    "tracks": ["host"],
    "window": {"clock": "timeline", "end": 5.9, "start": 0.0, "unit": "sec"},
}
_EDIT_STALE_RENDER_2 = {
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
    "window": {"clock": "timeline", "end": 5.0, "start": 0.5, "unit": "sec"},
}
_EDIT_STALE_RECONCILIATION_2 = {
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
    "window": {"clock": "timeline", "end": 5.0, "start": 0.5, "unit": "sec"},
}
_EDIT_EDITS_IN_WINDOW_2 = {
    "code": "edits_in_window",
    "confidence": "measured",
    "evidence": {"applied": 1, "pending": 1},
    "meaning": "edits_in_window: 1 pending, 1 applied overlapping this span",
    "next": {
        "fix": {"autonomy": "needs_approval", "skill": "podcast-edit-natural-language"},
        "listen": "sl-1",
        "tools": ["play_pending_preview_tool"],
    },
    "severity": "info",
    "tracks": ["host"],
    "window": {"clock": "timeline", "end": 5.0, "start": 0.5, "unit": "sec"},
}
_EDIT_SHARED_7 = {
    "audio_check": {"status": "clean"},
    "cut_confidence": None,
    "id": "ok",
    "reason": "nl:range",
    "review_required": True,
    "timeline_end": 4.38,
    "timeline_start": 3.98,
    "track_id": "host",
}
_EDIT_SHARED_8 = {
    "audio_check": {"status": "clean"},
    "boundary_mode": "vocal_transcript_guided",
    "cut_confidence": None,
    "id": "ok",
    "reason": "nl:range",
    "review_required": True,
    "source_end": 4.4,
    "source_start": 4.0,
    "timeline_end": 4.38,
    "timeline_start": 3.98,
    "track_id": "host",
}
_EDIT_SHARED_9 = [
    "stale_render: Stems and/or premix are stale relative to the current timeline; play may not match these captions.",
    "stale_reconciliation: Transcript reconciliation is stale versus current audio state.",
    "edits_in_window: 2 pending, 0 applied overlapping this span",
]
_EDIT_SHARED_10 = [
    "stale_render: Stems and/or premix are stale relative to the current timeline; play may not match these captions.",
    "stale_reconciliation: Transcript reconciliation is stale versus current audio state.",
    "edits_in_window: 1 pending, 0 applied overlapping this span",
]
_EDIT_SHARED_11 = {
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

_EXPECTED = {
    "pending-held-and-clean": {
        "auxiliary_tracks": [],
        "clip_skew": _EDIT_SHARED_5,
        "comments": [],
        "detail": "summary",
        "edits": {
            "applied": [],
            "pending": [
                {
                    "audio_check": {
                        "reason": "the selected audio no longer has one complete, continuous placement",
                        "status": "held",
                    },
                    "cut_confidence": None,
                    "id": "held",
                    "reason": "nl:range",
                    "review_required": True,
                    "timeline_end": 1.58,
                    "timeline_start": 1.2,
                    "track_id": "host",
                },
                _EDIT_SHARED_7,
            ],
        },
        "hypotheses": _EDIT_SHARED_4,
        "limits": ["cannot_hear", "captions_are_transcript_not_audio", "needs_rerender"],
        "mid_sec": 2.95,
        "prosody_notes": [],
        "render_status": _EDIT_SHARED_2,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 5.9,
                "id": "sl-1",
                "source": "premix",
                "start": 0.0,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: hello there world | guest: totally different topic  [3 warnings]",
        "timeline_end": 5.9,
        "timeline_start": 0.0,
        "tracks": _EDIT_SHARED_3,
        "warnings": _EDIT_SHARED_9,
        "window": {"clock": "timeline", "end": 5.9, "start": 0.0, "unit": "sec"},
    },
    "pending-held-and-clean-full": {
        "auxiliary_tracks": [],
        "clip_skew": _EDIT_SHARED_5,
        "comments": [],
        "detail": "full",
        "edits": {
            "applied": [],
            "pending": [
                {
                    "audio_check": {
                        "reason": "the selected audio no longer has one complete, continuous placement",
                        "status": "held",
                    },
                    "boundary_mode": "vocal_transcript_guided",
                    "cut_confidence": None,
                    "id": "held",
                    "reason": "nl:range",
                    "review_required": True,
                    "source_end": 1.6,
                    "source_start": 1.2,
                    "timeline_end": 1.58,
                    "timeline_start": 1.2,
                    "track_id": "host",
                },
                _EDIT_SHARED_8,
            ],
        },
        "hypotheses": _EDIT_SHARED_4,
        "limits": ["cannot_hear", "captions_are_transcript_not_audio", "needs_rerender"],
        "mid_sec": 2.95,
        "prosody_notes": [],
        "render_status": _EDIT_SHARED_2,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 5.9,
                "id": "sl-1",
                "source": "premix",
                "start": 0.0,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: hello there world | guest: totally different topic  [3 warnings]",
        "timeline_end": 5.9,
        "timeline_start": 0.0,
        "tracks": _EDIT_SHARED_3,
        "warnings": _EDIT_SHARED_9,
        "window": {"clock": "timeline", "end": 5.9, "start": 0.0, "unit": "sec"},
    },
    "pending-held-and-clean-wire": {
        "auxiliary_tracks": [],
        "clip_skew": _EDIT_SHARED_5,
        "comments": [],
        "detail": "summary",
        "edits": {
            "applied": [],
            "pending": [
                {
                    "audio_check": {
                        "reason": "the selected audio no longer has one complete, continuous placement",
                        "status": "held",
                    },
                    "cut_confidence": None,
                    "id": "held",
                    "reason": "nl:range",
                    "review_required": True,
                    "timeline_end": 1.58,
                    "timeline_start": 1.2,
                    "track_id": "host",
                },
                _EDIT_SHARED_7,
            ],
        },
        "hypotheses": [
            _EDIT_STALE_RENDER,
            _EDIT_STALE_RECONCILIATION,
            _EDIT_EDITS_IN_WINDOW,
            _EDIT_DSP_UNAVAILABLE,
        ],
        "limits": [
            "cannot_hear",
            "captions_are_transcript_not_audio",
            "needs_rerender",
            "echo_check_needs_fresh_stems",
        ],
        "mid_sec": 2.95,
        "prosody_notes": [],
        "render_status": _EDIT_SHARED_2,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 5.9,
                "id": "sl-1",
                "source": "premix",
                "start": 0.0,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: hello there world | guest: totally different topic  [4 warnings]",
        "timeline_end": 5.9,
        "timeline_start": 0.0,
        "tracks": _EDIT_SHARED_3,
        "warnings": [
            "stale_render: Stems and/or premix are stale relative to the current timeline; play may not match these captions.",
            "stale_reconciliation: Transcript reconciliation is stale versus current audio state.",
            "edits_in_window: 2 pending, 0 applied overlapping this span",
            "dsp_unavailable: Windowed astats/hum could not run for this span; do not treat the window as clean.",
        ],
        "window": {"clock": "timeline", "end": 5.9, "start": 0.0, "unit": "sec"},
    },
    "pending-held-and-clean-full-wire": {
        "auxiliary_tracks": [],
        "clip_skew": _EDIT_SHARED_5,
        "comments": [],
        "detail": "full",
        "edits": {
            "applied": [],
            "pending": [
                {
                    "audio_check": {
                        "reason": "the selected audio no longer has one complete, continuous placement",
                        "status": "held",
                    },
                    "boundary_mode": "vocal_transcript_guided",
                    "cut_confidence": None,
                    "id": "held",
                    "reason": "nl:range",
                    "review_required": True,
                    "source_end": 1.6,
                    "source_start": 1.2,
                    "timeline_end": 1.58,
                    "timeline_start": 1.2,
                    "track_id": "host",
                },
                _EDIT_SHARED_8,
            ],
        },
        "hypotheses": [
            _EDIT_STALE_RENDER,
            _EDIT_STALE_RECONCILIATION,
            _EDIT_EDITS_IN_WINDOW,
            _EDIT_DSP_UNAVAILABLE,
        ],
        "limits": [
            "cannot_hear",
            "captions_are_transcript_not_audio",
            "needs_rerender",
            "echo_check_needs_fresh_stems",
        ],
        "mid_sec": 2.95,
        "prosody_notes": [],
        "render_status": _EDIT_SHARED_2,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 5.9,
                "id": "sl-1",
                "source": "premix",
                "start": 0.0,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: hello there world | guest: totally different topic  [4 warnings]",
        "timeline_end": 5.9,
        "timeline_start": 0.0,
        "tracks": _EDIT_SHARED_3,
        "warnings": [
            "stale_render: Stems and/or premix are stale relative to the current timeline; play may not match these captions.",
            "stale_reconciliation: Transcript reconciliation is stale versus current audio state.",
            "edits_in_window: 2 pending, 0 applied overlapping this span",
            "dsp_unavailable: Windowed astats/hum could not run for this span; do not treat the window as clean.",
        ],
        "window": {"clock": "timeline", "end": 5.9, "start": 0.0, "unit": "sec"},
    },
    "pending-window-excludes-held": {
        "auxiliary_tracks": [],
        "clip_skew": _EDIT_SHARED_5,
        "comments": [],
        "detail": "summary",
        "edits": {"applied": [], "pending": [_EDIT_SHARED_7]},
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
                "window": {"clock": "timeline", "end": 5.0, "start": 3.5, "unit": "sec"},
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
                "window": {"clock": "timeline", "end": 5.0, "start": 3.5, "unit": "sec"},
            },
            {
                "code": "edits_in_window",
                "confidence": "measured",
                "evidence": {"applied": 0, "pending": 1},
                "meaning": "edits_in_window: 1 pending, 0 applied overlapping this span",
                "next": {
                    "fix": {"autonomy": "needs_approval", "skill": "podcast-edit-natural-language"},
                    "listen": "sl-1",
                    "tools": ["play_pending_preview_tool"],
                },
                "severity": "info",
                "tracks": ["host"],
                "window": {"clock": "timeline", "end": 5.0, "start": 3.5, "unit": "sec"},
            },
        ],
        "limits": ["cannot_hear", "captions_are_transcript_not_audio", "needs_rerender"],
        "mid_sec": 4.25,
        "prosody_notes": [],
        "render_status": _EDIT_SHARED_2,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 5.0,
                "id": "sl-1",
                "source": "premix",
                "start": 3.5,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: (silence / no words) | guest: topic  [3 warnings]",
        "timeline_end": 5.0,
        "timeline_start": 3.5,
        "tracks": [
            {
                "effects": [],
                "kind": "transcript_caption",
                "muted": False,
                "prosody": _EDIT_SHARED,
                "source_at_mid": 4.27,
                "source_spans": [{"clock": "source", "end": 5.02, "start": 3.52}],
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
                "prosody": _EDIT_SHARED,
                "source_at_mid": 4.25,
                "source_spans": [{"clock": "source", "end": 5.0, "start": 3.5}],
                "suppressed_only": False,
                "text": "topic",
                "track_id": "guest",
                "word_aligner": "forced",
                "word_count": 1,
            },
        ],
        "warnings": _EDIT_SHARED_10,
        "window": {"clock": "timeline", "end": 5.0, "start": 3.5, "unit": "sec"},
    },
    "pending-neighbour-of-held": {
        "auxiliary_tracks": [],
        "clip_skew": _EDIT_SHARED_5,
        "comments": [],
        "detail": "summary",
        "edits": {
            "applied": [],
            "pending": [
                {
                    "audio_check": {
                        "reason": 'This also cuts Guest\'s speech at 0:01.3 ("different"). Review this cut in Studio, or leave a gap to keep it.',
                        "status": "held",
                    },
                    "cut_confidence": None,
                    "id": "near",
                    "reason": "nl:range",
                    "review_required": True,
                    "timeline_end": 1.98,
                    "timeline_start": 1.78,
                    "track_id": "host",
                }
            ],
        },
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
                "window": {"clock": "timeline", "end": 2.1, "start": 1.7, "unit": "sec"},
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
                "window": {"clock": "timeline", "end": 2.1, "start": 1.7, "unit": "sec"},
            },
            {
                "code": "edits_in_window",
                "confidence": "measured",
                "evidence": {"applied": 0, "pending": 1},
                "meaning": "edits_in_window: 1 pending, 0 applied overlapping this span",
                "next": {
                    "fix": {"autonomy": "needs_approval", "skill": "podcast-edit-natural-language"},
                    "listen": "sl-1",
                    "tools": ["play_pending_preview_tool"],
                },
                "severity": "info",
                "tracks": ["host"],
                "window": {"clock": "timeline", "end": 2.1, "start": 1.7, "unit": "sec"},
            },
        ],
        "limits": ["cannot_hear", "captions_are_transcript_not_audio", "needs_rerender"],
        "mid_sec": 1.9,
        "prosody_notes": [],
        "render_status": _EDIT_SHARED_2,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 2.1,
                "id": "sl-1",
                "source": "premix",
                "start": 1.7,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: (silence / no words) | guest: different  [3 warnings]",
        "timeline_end": 2.1,
        "timeline_start": 1.7,
        "tracks": [
            {
                "effects": [],
                "kind": "transcript_caption",
                "muted": False,
                "prosody": _EDIT_SHARED,
                "source_at_mid": 1.92,
                "source_spans": [{"clock": "source", "end": 2.12, "start": 1.72}],
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
                "prosody": _EDIT_SHARED,
                "source_at_mid": 1.9,
                "source_spans": [{"clock": "source", "end": 2.1, "start": 1.7}],
                "suppressed_only": False,
                "text": "different",
                "track_id": "guest",
                "word_aligner": "forced",
                "word_count": 1,
            },
        ],
        "warnings": _EDIT_SHARED_10,
        "window": {"clock": "timeline", "end": 2.1, "start": 1.7, "unit": "sec"},
    },
    "pending-no-review-flag": {
        "auxiliary_tracks": [],
        "clip_skew": _EDIT_SHARED_5,
        "comments": [],
        "detail": "summary",
        "edits": {
            "applied": [],
            "pending": [
                {
                    "audio_check": {"status": "clean"},
                    "cut_confidence": None,
                    "id": "auto",
                    "reason": "nl:range",
                    "review_required": False,
                    "timeline_end": 4.38,
                    "timeline_start": 3.98,
                    "track_id": "host",
                }
            ],
        },
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
                "window": {"clock": "timeline", "end": 5.0, "start": 3.0, "unit": "sec"},
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
                "window": {"clock": "timeline", "end": 5.0, "start": 3.0, "unit": "sec"},
            },
            {
                "code": "edits_in_window",
                "confidence": "measured",
                "evidence": {"applied": 0, "pending": 1},
                "meaning": "edits_in_window: 1 pending, 0 applied overlapping this span",
                "next": {
                    "fix": {"autonomy": "needs_approval", "skill": "podcast-edit-natural-language"},
                    "listen": "sl-1",
                    "tools": ["play_pending_preview_tool"],
                },
                "severity": "info",
                "tracks": ["host"],
                "window": {"clock": "timeline", "end": 5.0, "start": 3.0, "unit": "sec"},
            },
        ],
        "limits": ["cannot_hear", "captions_are_transcript_not_audio", "needs_rerender"],
        "mid_sec": 4.0,
        "prosody_notes": [],
        "render_status": _EDIT_SHARED_2,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 5.0,
                "id": "sl-1",
                "source": "premix",
                "start": 3.0,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: (silence / no words) | guest: topic  [3 warnings]",
        "timeline_end": 5.0,
        "timeline_start": 3.0,
        "tracks": [
            {
                "effects": [],
                "kind": "transcript_caption",
                "muted": False,
                "prosody": _EDIT_SHARED,
                "source_at_mid": 4.02,
                "source_spans": [{"clock": "source", "end": 5.02, "start": 3.02}],
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
                "prosody": _EDIT_SHARED,
                "source_at_mid": 4.0,
                "source_spans": [{"clock": "source", "end": 5.0, "start": 3.0}],
                "suppressed_only": False,
                "text": "topic",
                "track_id": "guest",
                "word_aligner": "forced",
                "word_count": 1,
            },
        ],
        "warnings": _EDIT_SHARED_10,
        "window": {"clock": "timeline", "end": 5.0, "start": 3.0, "unit": "sec"},
    },
    "pending-outside-window": {
        "auxiliary_tracks": [],
        "clip_skew": _EDIT_SHARED_11,
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
                "window": {"clock": "timeline", "end": 1.0, "start": 0.0, "unit": "sec"},
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
                "window": {"clock": "timeline", "end": 1.0, "start": 0.0, "unit": "sec"},
            },
        ],
        "limits": ["cannot_hear", "captions_are_transcript_not_audio", "needs_rerender"],
        "mid_sec": 0.5,
        "prosody_notes": [],
        "render_status": _EDIT_SHARED_2,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 1.0,
                "id": "sl-1",
                "source": "premix",
                "start": 0.0,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: hello | guest: totally  [2 warnings]",
        "timeline_end": 1.0,
        "timeline_start": 0.0,
        "tracks": [
            {
                "effects": [],
                "kind": "transcript_caption",
                "muted": False,
                "prosody": _EDIT_SHARED,
                "source_at_mid": 0.5,
                "source_spans": [{"clock": "source", "end": 1.0, "start": 0.0}],
                "suppressed_only": False,
                "text": "hello",
                "track_id": "host",
                "word_aligner": "forced",
                "word_count": 1,
            },
            {
                "effects": [],
                "kind": "transcript_caption",
                "muted": False,
                "prosody": _EDIT_SHARED,
                "source_at_mid": 0.5,
                "source_spans": [{"clock": "source", "end": 1.0, "start": 0.0}],
                "suppressed_only": False,
                "text": "totally",
                "track_id": "guest",
                "word_aligner": "forced",
                "word_count": 1,
            },
        ],
        "warnings": [
            "stale_render: Stems and/or premix are stale relative to the current timeline; play may not match these captions.",
            "stale_reconciliation: Transcript reconciliation is stale versus current audio state.",
        ],
        "window": {"clock": "timeline", "end": 1.0, "start": 0.0, "unit": "sec"},
    },
    "pending-unreadable-check": {
        "auxiliary_tracks": [],
        "clip_skew": _EDIT_SHARED_5,
        "comments": [],
        "detail": "summary",
        "edits": {
            "applied": [],
            "pending": [
                {
                    "cut_confidence": None,
                    "id": "held",
                    "reason": "nl:range",
                    "review_required": True,
                    "timeline_end": 1.58,
                    "timeline_start": 1.2,
                    "track_id": "host",
                },
                {
                    "cut_confidence": None,
                    "id": "ok",
                    "reason": "nl:range",
                    "review_required": True,
                    "timeline_end": 4.38,
                    "timeline_start": 3.98,
                    "track_id": "host",
                },
            ],
        },
        "hypotheses": _EDIT_SHARED_4,
        "limits": ["cannot_hear", "captions_are_transcript_not_audio", "needs_rerender"],
        "mid_sec": 2.95,
        "prosody_notes": [],
        "render_status": _EDIT_SHARED_2,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 5.9,
                "id": "sl-1",
                "source": "premix",
                "start": 0.0,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: hello there world | guest: totally different topic  [3 warnings]",
        "timeline_end": 5.9,
        "timeline_start": 0.0,
        "tracks": _EDIT_SHARED_3,
        "warnings": _EDIT_SHARED_9,
        "window": {"clock": "timeline", "end": 5.9, "start": 0.0, "unit": "sec"},
    },
    "pending-unreadable-check-wire": {
        "auxiliary_tracks": [],
        "clip_skew": _EDIT_SHARED_5,
        "comments": [],
        "detail": "summary",
        "edits": {
            "applied": [],
            "pending": [
                {
                    "cut_confidence": None,
                    "id": "held",
                    "reason": "nl:range",
                    "review_required": True,
                    "timeline_end": 1.58,
                    "timeline_start": 1.2,
                    "track_id": "host",
                }
            ],
        },
        "hypotheses": [
            _EDIT_STALE_RENDER,
            _EDIT_STALE_RECONCILIATION,
            {
                "code": "edits_in_window",
                "confidence": "measured",
                "evidence": {"applied": 0, "pending": 1},
                "meaning": "edits_in_window: 1 pending, 0 applied overlapping this span",
                "next": {
                    "fix": {"autonomy": "needs_approval", "skill": "podcast-edit-natural-language"},
                    "listen": "sl-1",
                    "tools": ["play_pending_preview_tool"],
                },
                "severity": "info",
                "tracks": ["host"],
                "window": {"clock": "timeline", "end": 5.9, "start": 0.0, "unit": "sec"},
            },
            _EDIT_DSP_UNAVAILABLE,
        ],
        "limits": [
            "cannot_hear",
            "captions_are_transcript_not_audio",
            "needs_rerender",
            "echo_check_needs_fresh_stems",
        ],
        "mid_sec": 2.95,
        "prosody_notes": [],
        "render_status": _EDIT_SHARED_2,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 5.9,
                "id": "sl-1",
                "source": "premix",
                "start": 0.0,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: hello there world | guest: totally different topic  [4 warnings]",
        "timeline_end": 5.9,
        "timeline_start": 0.0,
        "tracks": _EDIT_SHARED_3,
        "warnings": [
            "stale_render: Stems and/or premix are stale relative to the current timeline; play may not match these captions.",
            "stale_reconciliation: Transcript reconciliation is stale versus current audio state.",
            "edits_in_window: 1 pending, 0 applied overlapping this span",
            "dsp_unavailable: Windowed astats/hum could not run for this span; do not treat the window as clean.",
        ],
        "window": {"clock": "timeline", "end": 5.9, "start": 0.0, "unit": "sec"},
    },
    "pending-acoustic-filler": {
        "auxiliary_tracks": [],
        "clip_skew": _EDIT_SHARED_5,
        "comments": [],
        "detail": "summary",
        "edits": {
            "applied": [],
            "pending": [
                {
                    "audio_check": {"status": "clean"},
                    "cut_confidence": None,
                    "id": "gap",
                    "reason": "filler:acoustic",
                    "review_required": True,
                    "timeline_end": 5.38,
                    "timeline_start": 4.98,
                    "track_id": "host",
                }
            ],
        },
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
                "window": {"clock": "timeline", "end": 6.0, "start": 4.0, "unit": "sec"},
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
                "window": {"clock": "timeline", "end": 6.0, "start": 4.0, "unit": "sec"},
            },
            {
                "code": "edits_in_window",
                "confidence": "measured",
                "evidence": {"applied": 0, "pending": 1},
                "meaning": "edits_in_window: 1 pending, 0 applied overlapping this span",
                "next": {
                    "fix": {"autonomy": "needs_approval", "skill": "podcast-edit-natural-language"},
                    "listen": "sl-1",
                    "tools": ["play_pending_preview_tool"],
                },
                "severity": "info",
                "tracks": ["host"],
                "window": {"clock": "timeline", "end": 6.0, "start": 4.0, "unit": "sec"},
            },
            {
                "code": "acoustic_gap_filler",
                "confidence": "heuristic",
                "evidence": {
                    "edit_id": "gap",
                    "reason": "filler:acoustic",
                    "timeline_end": 5.38,
                    "timeline_start": 4.98,
                },
                "meaning": "A local DSP candidate found voiced audio inside an ASR gap; review before cutting.",
                "next": {
                    "fix": {"autonomy": "needs_approval", "skill": "podcast-tighten-dialogue"},
                    "listen": "sl-1",
                    "tools": ["play_pending_preview_tool"],
                },
                "severity": "info",
                "tracks": ["host"],
                "window": {"clock": "timeline", "end": 6.0, "start": 4.0, "unit": "sec"},
            },
        ],
        "limits": ["cannot_hear", "captions_are_transcript_not_audio", "needs_rerender"],
        "mid_sec": 5.0,
        "prosody_notes": [],
        "render_status": _EDIT_SHARED_2,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 6.0,
                "id": "sl-1",
                "source": "premix",
                "start": 4.0,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: (silence / no words) | guest: (silence / no words)  [4 warnings]",
        "timeline_end": 6.0,
        "timeline_start": 4.0,
        "tracks": [
            {
                "effects": [],
                "kind": "transcript_caption",
                "muted": False,
                "prosody": _EDIT_SHARED,
                "source_at_mid": 5.02,
                "source_spans": [{"clock": "source", "end": 6.02, "start": 4.02}],
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
                "prosody": _EDIT_SHARED,
                "source_at_mid": 5.0,
                "source_spans": [{"clock": "source", "end": 6.0, "start": 4.0}],
                "suppressed_only": False,
                "text": "",
                "track_id": "guest",
                "word_aligner": "forced",
                "word_count": 0,
            },
        ],
        "warnings": [
            "stale_render: Stems and/or premix are stale relative to the current timeline; play may not match these captions.",
            "stale_reconciliation: Transcript reconciliation is stale versus current audio state.",
            "edits_in_window: 1 pending, 0 applied overlapping this span",
            "acoustic_gap_filler: A local DSP candidate found voiced audio inside an ASR gap; review before cutting.",
        ],
        "window": {"clock": "timeline", "end": 6.0, "start": 4.0, "unit": "sec"},
    },
    "pending-acoustic-filler-risky-full": {
        "auxiliary_tracks": [],
        "clip_skew": _EDIT_SHARED_5,
        "comments": [],
        "detail": "full",
        "edits": {
            "applied": [],
            "pending": [
                {
                    "audio_check": {"status": "clean"},
                    "boundary_mode": "vocal_transcript_guided",
                    "cut_confidence": 0.4,
                    "id": "gap",
                    "reason": "filler:acoustic:risky",
                    "review_required": True,
                    "source_end": 5.4,
                    "source_start": 5.0,
                    "timeline_end": 5.38,
                    "timeline_start": 4.98,
                    "track_id": "host",
                }
            ],
        },
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
                "window": {"clock": "timeline", "end": 6.0, "start": 4.0, "unit": "sec"},
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
                "window": {"clock": "timeline", "end": 6.0, "start": 4.0, "unit": "sec"},
            },
            {
                "code": "edits_in_window",
                "confidence": "measured",
                "evidence": {"applied": 0, "pending": 1},
                "meaning": "edits_in_window: 1 pending, 0 applied overlapping this span",
                "next": {
                    "fix": {"autonomy": "needs_approval", "skill": "podcast-edit-natural-language"},
                    "listen": "sl-1",
                    "tools": ["play_pending_preview_tool"],
                },
                "severity": "info",
                "tracks": ["host"],
                "window": {"clock": "timeline", "end": 6.0, "start": 4.0, "unit": "sec"},
            },
            {
                "code": "acoustic_gap_filler",
                "confidence": "heuristic",
                "evidence": {
                    "edit_id": "gap",
                    "reason": "filler:acoustic:risky",
                    "source_end": 5.4,
                    "source_start": 5.0,
                    "timeline_end": 5.38,
                    "timeline_start": 4.98,
                },
                "meaning": "A local DSP candidate found voiced audio inside an ASR gap; review before cutting.",
                "next": {
                    "fix": {"autonomy": "needs_approval", "skill": "podcast-tighten-dialogue"},
                    "listen": "sl-1",
                    "tools": ["play_pending_preview_tool"],
                },
                "severity": "info",
                "tracks": ["host"],
                "window": {"clock": "timeline", "end": 6.0, "start": 4.0, "unit": "sec"},
            },
        ],
        "limits": ["cannot_hear", "captions_are_transcript_not_audio", "needs_rerender"],
        "mid_sec": 5.0,
        "prosody_notes": [],
        "render_status": _EDIT_SHARED_2,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 6.0,
                "id": "sl-1",
                "source": "premix",
                "start": 4.0,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: (silence / no words) | guest: (silence / no words)  [4 warnings]",
        "timeline_end": 6.0,
        "timeline_start": 4.0,
        "tracks": [
            {
                "effects": [],
                "kind": "transcript_caption",
                "muted": False,
                "prosody": _EDIT_SHARED,
                "source_at_mid": 5.02,
                "source_spans": [{"clock": "source", "end": 6.02, "start": 4.02}],
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
                "prosody": _EDIT_SHARED,
                "source_at_mid": 5.0,
                "source_spans": [{"clock": "source", "end": 6.0, "start": 4.0}],
                "suppressed_only": False,
                "text": "",
                "track_id": "guest",
                "word_aligner": "forced",
                "word_count": 0,
            },
        ],
        "warnings": [
            "stale_render: Stems and/or premix are stale relative to the current timeline; play may not match these captions.",
            "stale_reconciliation: Transcript reconciliation is stale versus current audio state.",
            "edits_in_window: 1 pending, 0 applied overlapping this span",
            "acoustic_gap_filler: A local DSP candidate found voiced audio inside an ASR gap; review before cutting.",
        ],
        "window": {"clock": "timeline", "end": 6.0, "start": 4.0, "unit": "sec"},
    },
    "applied-and-pending": {
        "auxiliary_tracks": [],
        "clip_skew": _EDIT_SHARED_5,
        "comments": [],
        "detail": "summary",
        "edits": {
            "applied": [
                {
                    "cut_confidence": None,
                    "id": "<alog:0>",
                    "operation": "remove_range",
                    "reason": "filler:um",
                    "timeline_end": 1.5,
                    "timeline_start": 1.0,
                }
            ],
            "pending": [_EDIT_SHARED_7],
        },
        "hypotheses": [_EDIT_STALE_RENDER_2, _EDIT_STALE_RECONCILIATION_2, _EDIT_EDITS_IN_WINDOW_2],
        "limits": ["cannot_hear", "captions_are_transcript_not_audio", "needs_rerender"],
        "mid_sec": 2.75,
        "prosody_notes": [],
        "render_status": _EDIT_SHARED_2,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 5.0,
                "id": "sl-1",
                "source": "premix",
                "start": 0.5,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: hello there world | guest: totally different topic  [3 warnings]",
        "timeline_end": 5.0,
        "timeline_start": 0.5,
        "tracks": _EDIT_SHARED_6,
        "warnings": [
            "stale_render: Stems and/or premix are stale relative to the current timeline; play may not match these captions.",
            "stale_reconciliation: Transcript reconciliation is stale versus current audio state.",
            "edits_in_window: 1 pending, 1 applied overlapping this span",
        ],
        "window": {"clock": "timeline", "end": 5.0, "start": 0.5, "unit": "sec"},
    },
    "applied-and-pending-full": {
        "auxiliary_tracks": [],
        "clip_skew": _EDIT_SHARED_5,
        "comments": [],
        "detail": "full",
        "edits": {
            "applied": [
                {
                    "boundary_mode": None,
                    "cut_confidence": None,
                    "id": "<alog:0>",
                    "operation": "remove_range",
                    "reason": "filler:um",
                    "source_end": 1.5,
                    "source_start": 1.0,
                    "timeline_end": 1.5,
                    "timeline_start": 1.0,
                    "track_ids": ["host"],
                }
            ],
            "pending": [_EDIT_SHARED_8],
        },
        "hypotheses": [_EDIT_STALE_RENDER_2, _EDIT_STALE_RECONCILIATION_2, _EDIT_EDITS_IN_WINDOW_2],
        "limits": ["cannot_hear", "captions_are_transcript_not_audio", "needs_rerender"],
        "mid_sec": 2.75,
        "prosody_notes": [],
        "render_status": _EDIT_SHARED_2,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 5.0,
                "id": "sl-1",
                "source": "premix",
                "start": 0.5,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: hello there world | guest: totally different topic  [3 warnings]",
        "timeline_end": 5.0,
        "timeline_start": 0.5,
        "tracks": _EDIT_SHARED_6,
        "warnings": [
            "stale_render: Stems and/or premix are stale relative to the current timeline; play may not match these captions.",
            "stale_reconciliation: Transcript reconciliation is stale versus current audio state.",
            "edits_in_window: 1 pending, 1 applied overlapping this span",
        ],
        "window": {"clock": "timeline", "end": 5.0, "start": 0.5, "unit": "sec"},
    },
    "applied-only": {
        "auxiliary_tracks": [],
        "clip_skew": _EDIT_SHARED_11,
        "comments": [],
        "detail": "summary",
        "edits": {
            "applied": [
                {
                    "cut_confidence": None,
                    "id": "<alog:0>",
                    "operation": "remove_range",
                    "reason": "filler:um",
                    "timeline_end": 1.5,
                    "timeline_start": 1.0,
                }
            ],
            "pending": [],
        },
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
                "window": {"clock": "timeline", "end": 2.0, "start": 0.5, "unit": "sec"},
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
                "window": {"clock": "timeline", "end": 2.0, "start": 0.5, "unit": "sec"},
            },
            {
                "code": "edits_in_window",
                "confidence": "measured",
                "evidence": {"applied": 1, "pending": 0},
                "meaning": "edits_in_window: 0 pending, 1 applied overlapping this span",
                "next": {
                    "fix": {"autonomy": "needs_approval", "skill": "podcast-edit-natural-language"},
                    "listen": "sl-1",
                    "tools": ["play_pending_preview_tool"],
                },
                "severity": "info",
                "tracks": ["host", "guest"],
                "window": {"clock": "timeline", "end": 2.0, "start": 0.5, "unit": "sec"},
            },
        ],
        "limits": ["cannot_hear", "captions_are_transcript_not_audio", "needs_rerender"],
        "mid_sec": 1.25,
        "prosody_notes": [],
        "render_status": _EDIT_SHARED_2,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 2.0,
                "id": "sl-1",
                "source": "premix",
                "start": 0.5,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: hello there | guest: totally different  [3 warnings]",
        "timeline_end": 2.0,
        "timeline_start": 0.5,
        "tracks": [
            {
                "effects": [],
                "kind": "transcript_caption",
                "muted": False,
                "prosody": _EDIT_SHARED,
                "source_at_mid": 1.25,
                "source_spans": [
                    {"clock": "source", "end": 1.4, "start": 0.5},
                    {"clock": "source", "end": 2.02, "start": 1.42},
                ],
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
                "prosody": _EDIT_SHARED,
                "source_at_mid": 1.25,
                "source_spans": [{"clock": "source", "end": 2.0, "start": 0.5}],
                "suppressed_only": False,
                "text": "totally different",
                "track_id": "guest",
                "word_aligner": "forced",
                "word_count": 2,
            },
        ],
        "warnings": [
            "stale_render: Stems and/or premix are stale relative to the current timeline; play may not match these captions.",
            "stale_reconciliation: Transcript reconciliation is stale versus current audio state.",
            "edits_in_window: 0 pending, 1 applied overlapping this span",
        ],
        "window": {"clock": "timeline", "end": 2.0, "start": 0.5, "unit": "sec"},
    },
    "applied-only-full": {
        "auxiliary_tracks": [],
        "clip_skew": _EDIT_SHARED_11,
        "comments": [],
        "detail": "full",
        "edits": {
            "applied": [
                {
                    "boundary_mode": None,
                    "cut_confidence": None,
                    "id": "<alog:0>",
                    "operation": "remove_range",
                    "reason": "filler:um",
                    "source_end": 1.5,
                    "source_start": 1.0,
                    "timeline_end": 1.5,
                    "timeline_start": 1.0,
                    "track_ids": ["host"],
                }
            ],
            "pending": [],
        },
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
                "window": {"clock": "timeline", "end": 2.0, "start": 0.5, "unit": "sec"},
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
                "window": {"clock": "timeline", "end": 2.0, "start": 0.5, "unit": "sec"},
            },
            {
                "code": "edits_in_window",
                "confidence": "measured",
                "evidence": {"applied": 1, "pending": 0},
                "meaning": "edits_in_window: 0 pending, 1 applied overlapping this span",
                "next": {
                    "fix": {"autonomy": "needs_approval", "skill": "podcast-edit-natural-language"},
                    "listen": "sl-1",
                    "tools": ["play_pending_preview_tool"],
                },
                "severity": "info",
                "tracks": ["host"],
                "window": {"clock": "timeline", "end": 2.0, "start": 0.5, "unit": "sec"},
            },
        ],
        "limits": ["cannot_hear", "captions_are_transcript_not_audio", "needs_rerender"],
        "mid_sec": 1.25,
        "prosody_notes": [],
        "render_status": _EDIT_SHARED_2,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 2.0,
                "id": "sl-1",
                "source": "premix",
                "start": 0.5,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: hello there | guest: totally different  [3 warnings]",
        "timeline_end": 2.0,
        "timeline_start": 0.5,
        "tracks": [
            {
                "effects": [],
                "kind": "transcript_caption",
                "muted": False,
                "prosody": _EDIT_SHARED,
                "source_at_mid": 1.25,
                "source_spans": [
                    {"clock": "source", "end": 1.4, "start": 0.5},
                    {"clock": "source", "end": 2.02, "start": 1.42},
                ],
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
                "prosody": _EDIT_SHARED,
                "source_at_mid": 1.25,
                "source_spans": [{"clock": "source", "end": 2.0, "start": 0.5}],
                "suppressed_only": False,
                "text": "totally different",
                "track_id": "guest",
                "word_aligner": "forced",
                "word_count": 2,
            },
        ],
        "warnings": [
            "stale_render: Stems and/or premix are stale relative to the current timeline; play may not match these captions.",
            "stale_reconciliation: Transcript reconciliation is stale versus current audio state.",
            "edits_in_window: 0 pending, 1 applied overlapping this span",
        ],
        "window": {"clock": "timeline", "end": 2.0, "start": 0.5, "unit": "sec"},
    },
    "applied-and-pending-wire": {
        "auxiliary_tracks": [],
        "clip_skew": _EDIT_SHARED_5,
        "comments": [],
        "detail": "summary",
        "edits": {
            "applied": [
                {
                    "cut_confidence": None,
                    "id": "<alog:0>",
                    "operation": "remove_range",
                    "reason": "filler:um",
                    "timeline_end": 1.5,
                    "timeline_start": 1.0,
                }
            ],
            "pending": [_EDIT_SHARED_7],
        },
        "hypotheses": [
            _EDIT_STALE_RENDER_2,
            _EDIT_STALE_RECONCILIATION_2,
            _EDIT_EDITS_IN_WINDOW_2,
            {
                "code": "dsp_unavailable",
                "confidence": "measured",
                "evidence": {
                    "reason": "timeline window is not a single source span (join or gap); DSP skipped"
                },
                "meaning": "Windowed astats/hum could not run for this span; do not treat the window as clean.",
                "next": {
                    "fix": {"autonomy": "present_only", "skill": None},
                    "listen": "sl-1",
                    "tools": ["audio_diagnostics_tool"],
                },
                "severity": "info",
                "tracks": ["host"],
                "window": {"clock": "timeline", "end": 5.0, "start": 0.5, "unit": "sec"},
            },
        ],
        "limits": [
            "cannot_hear",
            "captions_are_transcript_not_audio",
            "needs_rerender",
            "echo_check_needs_fresh_stems",
        ],
        "mid_sec": 2.75,
        "prosody_notes": [],
        "render_status": _EDIT_SHARED_2,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 5.0,
                "id": "sl-1",
                "source": "premix",
                "start": 0.5,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: hello there world | guest: totally different topic  [4 warnings]",
        "timeline_end": 5.0,
        "timeline_start": 0.5,
        "tracks": _EDIT_SHARED_6,
        "warnings": [
            "stale_render: Stems and/or premix are stale relative to the current timeline; play may not match these captions.",
            "stale_reconciliation: Transcript reconciliation is stale versus current audio state.",
            "edits_in_window: 1 pending, 1 applied overlapping this span",
            "dsp_unavailable: Windowed astats/hum could not run for this span; do not treat the window as clean.",
        ],
        "window": {"clock": "timeline", "end": 5.0, "start": 0.5, "unit": "sec"},
    },
    "applied-outside-window": {
        "auxiliary_tracks": [],
        "clip_skew": _EDIT_SHARED_5,
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
                "window": {"clock": "timeline", "end": 4.0, "start": 3.0, "unit": "sec"},
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
                "window": {"clock": "timeline", "end": 4.0, "start": 3.0, "unit": "sec"},
            },
        ],
        "limits": ["cannot_hear", "captions_are_transcript_not_audio", "needs_rerender"],
        "mid_sec": 3.5,
        "prosody_notes": [],
        "render_status": _EDIT_SHARED_2,
        "schema": "audition_context.v2",
        "suggested_listen": [
            {
                "clock": "timeline",
                "end": 4.0,
                "id": "sl-1",
                "source": "premix",
                "start": 3.0,
                "why": "Hear what the listener hears in this window",
            }
        ],
        "summary": "host: (silence / no words) | guest: topic  [2 warnings]",
        "timeline_end": 4.0,
        "timeline_start": 3.0,
        "tracks": [
            {
                "effects": [],
                "kind": "transcript_caption",
                "muted": False,
                "prosody": _EDIT_SHARED,
                "source_at_mid": 3.52,
                "source_spans": [{"clock": "source", "end": 4.02, "start": 3.02}],
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
                "prosody": _EDIT_SHARED,
                "source_at_mid": 3.5,
                "source_spans": [{"clock": "source", "end": 4.0, "start": 3.0}],
                "suppressed_only": False,
                "text": "topic",
                "track_id": "guest",
                "word_aligner": "forced",
                "word_count": 1,
            },
        ],
        "warnings": [
            "stale_render: Stems and/or premix are stale relative to the current timeline; play may not match these captions.",
            "stale_reconciliation: Transcript reconciliation is stale versus current audio state.",
        ],
        "window": {"clock": "timeline", "end": 4.0, "start": 3.0, "unit": "sec"},
    },
}


_PINS = [(name, surface) for name in _EXPECTED for surface in CASES[name].surfaces]


@pytest.mark.parametrize(
    ("name", "surface"), _PINS, ids=[f"{name}-{surface}" for name, surface in _PINS]
)
def test_audition_context_wire(tmp_path, monkeypatch, name, surface):
    result = play_case(CASES[name], tmp_path, monkeypatch, surface)
    assert dump(result) == dump(_EXPECTED[name])


def test_a_window_with_no_pending_edit_runs_no_check(tmp_path, monkeypatch):
    from podcast_mcp.services.document import EditService

    case = CASES["pending-outside-window"]
    ws = case.build(tmp_path)
    monkeypatch.setattr(
        EditService, "check_proposed", lambda *_a, **_k: pytest.fail("no pending edit to check")
    )
    assert run_service(ws, case.start, case.end, **case.kwargs)["edits"]["pending"] == []


def test_the_check_covers_the_window_edits_first_then_what_approve_all_runs_on(
    tmp_path, monkeypatch
):
    from podcast_mcp.services.document import EditService

    case = CASES["pending-window-excludes-held"]
    ws = case.build(tmp_path)
    asked: list[list[str]] = []
    real = EditService.check_proposed

    def spy(self, ids):
        asked.append(list(ids))
        return real(self, ids)

    monkeypatch.setattr(EditService, "check_proposed", spy)
    run_service(ws, case.start, case.end, **case.kwargs)
    assert asked == [["ok", "held"]]


def test_the_check_does_not_change_the_project_file(tmp_path):
    case = CASES["pending-held-and-clean"]
    ws = case.build(tmp_path)
    before = ws.path.read_bytes()
    run_service(ws, case.start, case.end, **case.kwargs)
    assert ws.path.read_bytes() == before

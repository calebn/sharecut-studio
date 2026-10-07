"""Registry of process-wide ``lru_cache`` functions under ``src/`` and how tests treat each.

A cache whose key omits the state a test patches (Silero availability, which
manifest file to read, a mocked probe result) leaks that state to every later
test in the same pytest-xdist worker. ``ISOLATED`` caches are cleared around
every test by the autouse fixture in ``conftest.py``. ``SHARED`` caches key on
every input they read, so a stale entry cannot answer a different question and
clearing would only cost recompute time. ``tests/test_process_caches.py`` fails
when a cache is added to ``src/`` without being listed in one of the two.
"""

from __future__ import annotations

from collections.abc import Callable
from importlib import import_module
from typing import Any

ISOLATED: dict[str, str] = {
    "podcast_mcp.engines.vad_silero:_cached_vad": (
        "Key is empty; the value depends on is_available(), which tests patch."
    ),
    "podcast_mcp.util.asset_sources:_read_manifest": (
        "Key is empty; the value depends on manifest_path(), which tests patch."
    ),
    "podcast_mcp.engines.media_probe:_cached_media_probe": (
        "Tests mock the probe result for a path another test may probe for real."
    ),
}

SHARED: dict[str, str] = {
    "podcast_relay.offline:_static_text": "Keyed by file name; static package asset.",
    "podcast_mcp.util.model_manifest:_sha256_for": "Keyed by path, size and mtime.",
    "podcast_mcp.util.timeline_zoom:load_timeline_zoom": "Static contract file in the repo.",
    "podcast_mcp.engines.bleed_gate:_cached_bleed_gate_plan": "Keyed by every plan input.",
    "podcast_mcp.engines.bleed_echo:_cached_profiles": "Keyed by every profile input.",
    "podcast_mcp.engines.asr_silence:_cached_silent_fraction": "Keyed by every input.",
    "podcast_mcp.engines.session_timeline:_build_index": "Keyed by the full clip tuple.",
    "podcast_mcp.edits.join_cost_spectral:_mel_filterbank": "Pure function of (sr, n_fft).",
    "podcast_mcp.services.collaboration.share:_review_version_ids_at_revision": (
        "Keyed by project path and file revision."
    ),
    "podcast_mcp.services.document.play:_stem_mix_trim_db": "Keyed by stems and ceiling.",
    "podcast_mcp.edits.room_tone:_track_floor": (
        "Keyed by path and file revision; reads only the decoded audio, never VAD."
    ),
    "podcast_mcp.edits.gate_fill:_detect": (
        "Keyed by path and file revision; reads only the decoded audio."
    ),
    "podcast_mcp.services.remote_mcp.tools:_arguments_model": (
        "Keyed by the handler function itself; a patched handler is a new key."
    ),
}


def _resolve(ref: str) -> Any:
    module, name = ref.split(":")
    return getattr(import_module(module), name)


def reset_isolated_caches() -> None:
    for ref in ISOLATED:
        cached: Callable[..., Any] = _resolve(ref)
        cached.cache_clear()  # type: ignore[attr-defined]

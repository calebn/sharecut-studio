"""Registry of process-wide caches under ``src/`` and how tests treat each.

A cache is an ``lru_cache`` function or a module-level ``util.bounded_cache.BoundedCache``.

A cache whose key omits the state a test patches (Silero availability, which
manifest file to read, a mocked probe result) leaks that state to every later
test in the same pytest-xdist worker. ``ISOLATED`` caches are cleared around
every test by the autouse fixture in ``conftest.py``. ``SHARED`` caches key on
every input they read, so a stale entry cannot answer a different question and
clearing would only cost recompute time. ``tests/test_process_caches.py`` fails
when a cache is added to ``src/`` without being listed in one of the two.
"""

from __future__ import annotations

from importlib import import_module
from typing import Any

from podcast_mcp.util.bounded_cache import BoundedCache

ISOLATED: dict[str, str] = {
    "podcast_mcp.engines.ffmpeg:_cached_audio_extent": (
        "Tests replace packet subprocess output and deadlines without changing file revisions."
    ),
    "podcast_mcp.services.media.object_store_cors:_cache": (
        "Keyed by store host and origin with a TTL; tests stub the probe and expect a fresh answer."
    ),
    "podcast_mcp.services.record.service:_SID_CACHE": (
        "Keyed by workspace path with a half-second TTL; a test that reuses a path must not see "
        "the previous test's session id."
    ),
    "podcast_mcp.engines.vad_silero:_cached_vad": (
        "Key is empty; the value depends on is_available(), which tests patch."
    ),
    "podcast_mcp.util.asset_sources:_read_manifest": (
        "Key is empty; the value depends on contracts_dir(), which tests patch."
    ),
    "podcast_mcp.util.hardware:_probed": (
        "Key is empty; the value depends on the providers, nvidia-smi and cgroup files tests patch."
    ),
    "podcast_mcp.engines.media_probe:_cached_media_probe": (
        "Tests mock the probe result for a path another test may probe for real."
    ),
    "podcast_mcp.engines.level_profile:_FILE_PROFILES": (
        "Keyed by path and a stat revision (inode, size, mtime); a different file written at the "
        "same path inside one clock tick would read the earlier profile, so each test starts "
        "empty (#2269)."
    ),
    "podcast_mcp.edits.verdict_cache:_STORE": (
        "Entries are keyed by the project's clips, words, media revisions and settings; a test "
        "that edits any of them behind the key's back must not see another test's verdict (#1958)."
    ),
    "podcast_mcp.engines.render_clock:_NATIVE_FORMATS": (
        "Tests count the probe spawns of a render and expect the first one to probe."
    ),
}

SHARED: dict[str, str] = {
    "podcast_mcp.util.binaries:_PAIR_CACHE": (
        "Keyed by the selectors, PATH, working directory and the stat identity of every candidate."
    ),
    "podcast_mcp.project.store:_VOCABULARY_CACHE": "Keyed by the project and history file signatures.",
    "podcast_mcp.config.defaults:_PARSED_DEFAULTS": "Keyed by path; a hit also compares the file's bytes.",
    "podcast_mcp.services.media.waveform:_INDEX": "Keyed by project path and file revision.",
    "podcast_mcp.services.media.waveform:_META": "Keyed by pyramid path and content key.",
    "podcast_mcp.services.media.waveform:_PCM": "Keyed by media path, content key and block.",
    "podcast_relay.offline:_static_text": "Keyed by file name; static package asset.",
    "podcast_mcp.util.model_manifest:_sha256_for": "Keyed by path, size and mtime.",
    "podcast_mcp.util.timeline_zoom:load_timeline_zoom": "Static contract file in the repo.",
    "podcast_mcp.engines.bleed_gate:_cached_bleed_gate_plan": "Keyed by every plan input.",
    "podcast_mcp.engines.bleed_echo:_cached_profiles": "Keyed by every profile input.",
    "podcast_mcp.engines.asr_silence:_cached_silent_fraction": "Keyed by every input.",
    "podcast_mcp.engines.session_timeline:_build_index": "Keyed by the full clip tuple.",
    "podcast_mcp.edits.join_cost_spectral:_mel_filterbank": "Pure function of (sr, n_fft).",
    "podcast_mcp.engines.copy_timbre:_smoothing_matrix": "Pure function of the band width.",
    "podcast_mcp.services.collaboration.share:_review_version_ids_at_revision": (
        "Keyed by project path and file revision."
    ),
    "podcast_mcp.services.document.play_headroom:_stem_mix_trim_db": "Keyed by stems and ceiling.",
    "podcast_mcp.engines.room_tone:_track_floor": (
        "Keyed by path and file revision; reads only the decoded audio, never VAD."
    ),
    "podcast_mcp.engines.gate_fill:_detect": (
        "Keyed by path and file revision; reads only the decoded audio."
    ),
    "podcast_mcp.engines.bleed_fill:_loop": (
        "Keyed by the fill's spectrum, the sample rate and the seed key; a pure function of all three."
    ),
    "podcast_mcp.services.remote_mcp.tools:_arguments_model": (
        "Keyed by the handler function itself; a patched handler is a new key."
    ),
    "podcast_mcp.gui.routes.handoff:_click_root": (
        "Keyed by the Typer app object; the click command tree it builds is static."
    ),
}


def _resolve(ref: str) -> Any:
    module, name = ref.split(":")
    return getattr(import_module(module), name)


def reset_isolated_caches() -> None:
    for ref in ISOLATED:
        cached: Any = _resolve(ref)
        if isinstance(cached, BoundedCache):
            cached.clear()
        else:
            cached.cache_clear()

"""One word-audibility map per audio revision inside a pipeline run (#2890).

Reconcile, precorrect and the post-FX reconcile each measure every word against the same
decoded dialogue audio. The measurement reads a word's source-clock span, the placement of
its recording and the audio itself; its text and ``suppressed`` flag only pass through to the
row. So a run keeps the measured rows under the audio revision, the analysis policy and the
words' placement and time spans, and re-stamps the two pass-through fields from the words in
hand. Every reader gets its own copy of the rows.
"""

from __future__ import annotations

import copy
import threading
from collections.abc import Callable, Hashable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import TYPE_CHECKING, Any

from podcast_mcp.util.fingerprint import file_stamp
from podcast_mcp.util.tracks import dialogue_track_ids

if TYPE_CHECKING:
    from podcast_mcp.config.defaults import EffectiveConfig
    from podcast_mcp.engines.audio_audit import AnalysisPolicy
    from podcast_mcp.engines.lane_words import LaneTranscript
    from podcast_mcp.models import EpisodeProject


class _RunRows:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.rows: dict[Hashable, list[dict[str, Any]]] = {}
        self.defaults: EffectiveConfig | None = None


_run: ContextVar[_RunRows | None] = ContextVar("audibility_run_rows", default=None)


@contextmanager
def audibility_run_scope() -> Iterator[None]:
    """Share measured audibility rows between the steps of one run; freed when it ends.

    A nested scope shares the outer one.
    """
    if _run.get() is not None:
        yield
        return
    token = _run.set(_RunRows())
    try:
        yield
    finally:
        _run.reset(token)


def scope_active() -> bool:
    return _run.get() is not None


def audio_identity(
    project: EpisodeProject, *, unprocessed: bool, defaults: EffectiveConfig
) -> Hashable | None:
    """What the decoded dialogue audio of a cache set was read from, or ``None`` if unshareable.

    ``None`` outside a run scope and for a project with a transcript-gated dialogue track,
    whose evidence is rendered from the suppressed words and not named by the audio state.
    ``unprocessed`` only changes the audio of a track with an active effects chain, so
    without one the two build modes share an identity.
    """
    if not scope_active():
        return None
    from podcast_mcp.engines.audio_audit import _fresh_stem_path, has_active_chain
    from podcast_mcp.engines.reconciliation_state import audio_state_fingerprint

    track_ids = sorted(dialogue_track_ids(project))
    if any(
        (track := project.track_by_id(tid)) is not None and track.transcript_gate
        for tid in track_ids
    ):
        return None
    stems = []
    for tid in track_ids:
        stem = _fresh_stem_path(project, tid, defaults=defaults)
        stems.append((tid, file_stamp(stem).revision if stem is not None else None))
    chained = unprocessed and any(has_active_chain(project, tid) for tid in track_ids)
    return (chained, audio_state_fingerprint(project, defaults=defaults), tuple(stems))


def _words_signature(lanes: list[LaneTranscript]) -> Hashable:
    return tuple(
        (
            lane.transcript.key,
            lane.placement_source_ids,
            lane.placements,
            tuple((w.start, w.end) for w in lane.transcript.words),
        )
        for lane in lanes
    )


def shared_rows(
    project: EpisodeProject,
    lanes: list[LaneTranscript],
    *,
    identity: Hashable | None,
    policy: AnalysisPolicy,
    defaults: EffectiveConfig,
    build: Callable[[], list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    """``build()``, or this run's earlier rows for the same audio, policy and word spans.

    The returned rows belong to the caller; the run keeps its own. The run is bound to the
    first ``defaults`` it serves: the audio identity names only part of that config, so a
    reader with different defaults builds its own rows.
    """
    run = _run.get()
    if run is None or identity is None:
        return build()
    with run.lock:
        if run.defaults is None:
            run.defaults = defaults
        elif run.defaults != defaults:
            return build()
    key = (identity, policy, _words_signature(lanes))
    with run.lock:
        kept = run.rows.get(key)
    if kept is None:
        built = build()
        kept = copy.deepcopy(built)
        with run.lock:
            run.rows.setdefault(key, kept)
        return built
    rows = copy.deepcopy(kept)
    words = {tr.key: tr.words for tr in project.transcripts}
    try:
        stamped = [
            (row, words[(row["track_id"], row["source_id"])][row["word_index"]]) for row in rows
        ]
    except (KeyError, IndexError):
        return build()
    for row, word in stamped:
        row["text"] = word.text
        row["suppressed"] = word.suppressed
    return rows

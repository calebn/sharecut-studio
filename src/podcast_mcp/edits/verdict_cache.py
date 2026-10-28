"""Reuse of an apply-time cut verdict (#1958).

Checking a source remove for approval observes the neighbourhood of the cut (peer speech,
acoustic edges, pauses) and then checks the written result. That is nearly all the cost of an
approval, and it depends only on the audio, words, configuration and clips near the cut. An
entry keeps the observation and the outcome under a key that hashes exactly those inputs.

A hit never skips what depends on the live timeline: the placement and the cut itself are
written again, and the written result and room-tone pads must equal what the entry recorded,
or the full check runs. A key that cannot be built, or an outcome reached through an
unreadable file, is never stored. ``PODCAST_VERDICT_VERIFY=1`` rechecks every hit in full
and fails if it differs.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import math
import threading
from bisect import bisect_left, bisect_right
from collections.abc import Callable, Iterator, Sequence
from contextvars import ContextVar
from dataclasses import dataclass
from itertools import accumulate
from typing import TYPE_CHECKING, Any, cast

from podcast_mcp import settings
from podcast_mcp.edits import cut_policy
from podcast_mcp.edits.cut_placement import (
    CutRejected,
    HeldPauseSpan,
    held_pause_observation_span,
    is_pad_record,
    pause_neighbours,
    pause_words,
)
from podcast_mcp.edits.cut_quality import fade_reach_sec
from podcast_mcp.edits.cut_speech import SourceExtent, _chosen_on_timeline
from podcast_mcp.models import ClipJoinMode
from podcast_mcp.util.bounded_cache import BoundedCache
from podcast_mcp.util.coded_error import CodedError
from podcast_mcp.util.fingerprint import file_stamp

if TYPE_CHECKING:
    from podcast_mcp.edits.cut_placement import CutScopeHold
    from podcast_mcp.edits.cut_safety import SourceCutObservations
    from podcast_mcp.edits.cut_speech import CutSpeechConfirmation
    from podcast_mcp.models import EditDecision, EpisodeProject

ENABLE_ENV = "PODCAST_VERDICT_CACHE"
VERIFY_ENV = "PODCAST_VERDICT_VERIFY"
READ_SEC = 6.0
PAUSE_REACH_FLOOR_SEC = 13.0
LONG_FADE_NO_CACHE_SEC = 1.0
_ENTRIES = 512


@dataclass(frozen=True)
class CachedVerdict:
    observation: SourceCutObservations
    outcome: CutSpeechConfirmation | CutScopeHold | None
    written: str
    pads: str


_STORE: BoundedCache[str, CachedVerdict] = BoundedCache(_ENTRIES)
_unstable: ContextVar[list[bool] | None] = ContextVar("verdict_unstable", default=None)


_approving = 0
_approving_lock = threading.Lock()


@contextlib.contextmanager
def approving() -> Iterator[None]:
    """Marks an approval as running, so a background warm stops and leaves the rest to it."""
    global _approving
    with _approving_lock:
        _approving += 1
    try:
        yield
    finally:
        with _approving_lock:
            _approving -= 1


def approval_running() -> bool:
    return _approving > 0


def enabled() -> bool:
    return settings.flag(ENABLE_ENV, default=True) or settings.flag(VERIFY_ENV)


def verifying() -> bool:
    return settings.flag(VERIFY_ENV)


@contextlib.contextmanager
def recording() -> Iterator[list[bool]]:
    """Collects whether a check read an unreadable file; such an outcome is not stored."""
    marks: list[bool] = []
    token = _unstable.set(marks)
    try:
        yield marks
    finally:
        _unstable.reset(token)


def mark_unstable() -> None:
    marks = _unstable.get()
    if marks is not None:
        marks.append(True)


def lookup(key: str | None) -> CachedVerdict | None:
    return _STORE.get(key) if key is not None else None


def store(key: str | None, entry: CachedVerdict, marks: Sequence[bool]) -> None:
    if key is not None and not marks:
        _STORE.put(key, entry)


def written_digest(written: Any) -> str:
    return _digest(written)


def pads_digest(pads: Sequence[Any]) -> str:
    return _digest(
        [
            (
                pad.edit_id,
                _pad_plan(pad.plan),
            )
            for pad in pads
        ]
    )


def _pad_plan(plan: Any) -> Any:
    return (plan.at_time, plan.seconds, plan.lanes)


def _digest(payload: Any) -> str:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=repr)
    return hashlib.sha256(raw.encode()).hexdigest()


def _is_pause(edit: EditDecision) -> bool:
    return (edit.reason or "").startswith("pause:")


def _held_pause_span(
    project: EpisodeProject, edit: EditDecision, span: tuple[float, float], defaults: dict
) -> HeldPauseSpan | None:
    """The span a held pause is observed over; ``None`` for any other edit or a rejected pause."""
    if not _is_pause(edit):
        return None
    words = pause_words(project, edit.track_id, edit.start, edit.end)
    if isinstance(words, CutRejected):
        return None
    return held_pause_observation_span(project, edit, span, words, defaults)


def _reach_sec(
    project: EpisodeProject,
    edit: EditDecision,
    span: tuple[float, float],
    defaults: dict,
    seen: HeldPauseSpan | None,
) -> float:
    reach = READ_SEC + fade_reach_sec(project, edit, defaults)
    if not _is_pause(edit):
        return reach
    reach = max(PAUSE_REACH_FLOOR_SEC, reach)
    if seen is None:
        return reach
    return max(reach, float(span[0]) - seen.lo + READ_SEC, seen.hi - float(span[1]) + READ_SEC)


def check_reach_sec(
    project: EpisodeProject,
    edit: EditDecision,
    span: tuple[float, float],
    defaults: dict,
) -> float:
    """How far from its cut a check reads."""
    return _reach_sec(
        project, edit, span, defaults, _held_pause_span(project, edit, span, defaults)
    )


def verdict_key(
    project: EpisodeProject,
    edit: EditDecision,
    *,
    defaults: dict,
    manual: bool,
    batch: Sequence[SourceExtent],
    span: tuple[float, float],
) -> str | None:
    """Hash of everything near ``edit`` that its check reads; ``None`` when any input is unreadable."""
    if _has_long_fade(project):
        return None
    try:
        return _key(project, edit, defaults, manual, batch, span)
    except (OSError, ValueError, KeyError):
        return None


def _has_long_fade(project: EpisodeProject) -> bool:
    return any(
        max(c.fade_in_ms, c.fade_out_ms) > LONG_FADE_NO_CACHE_SEC * 1000 for c in project.clips
    )


def key_parts(
    project: EpisodeProject,
    edit: EditDecision,
    *,
    defaults: dict,
    manual: bool,
    batch: Sequence[SourceExtent],
    span: tuple[float, float],
) -> dict[str, str] | None:
    """A digest per input of the key, to see which input made a check miss (lab); ``None`` as ``verdict_key``."""
    if _has_long_fade(project):
        return None
    try:
        payload = _payload(project, edit, defaults, manual, batch, span)
    except (OSError, ValueError, KeyError):
        return None
    return {name: _digest(value) for name, value in payload.items()}


def _key(
    project: EpisodeProject,
    edit: EditDecision,
    defaults: dict,
    manual: bool,
    batch: Sequence[SourceExtent],
    span: tuple[float, float],
) -> str:
    return _digest(_payload(project, edit, defaults, manual, batch, span))


def _payload(
    project: EpisodeProject,
    edit: EditDecision,
    defaults: dict,
    manual: bool,
    batch: Sequence[SourceExtent],
    span: tuple[float, float],
) -> dict[str, Any]:
    from podcast_mcp.util.tracks import recording_audio_path

    seen = _held_pause_span(project, edit, span, defaults)
    reach = _reach_sec(project, edit, span, defaults, seen)
    lo = float(span[0]) - reach
    hi = float(span[1]) + reach
    s_lo, s_hi = edit.start - reach, edit.end + reach
    heard = []
    elsewhere = []
    downstream = []
    near = _words_near(project)
    for c in project.clips:
        in_window = c.timeline_start < hi and c.timeline_end > lo
        if in_window:
            heard.append(_heard(c, lo, hi))
        if in_window or c.timeline_end >= lo:
            # The check assesses every ramp, so one outside the window (the far end of a clip
            # straddling its edge, or a whole clip past it) still moves the verdict.
            ramps = _outside_ramps(
                c,
                near,
                c.timeline_start < lo or not in_window,
                c.timeline_end > hi or not in_window,
            )
            if ramps:
                downstream.append(ramps)
        if in_window:
            continue
        if (
            c.source_end > s_lo
            and c.source_start < s_hi
            and (c.track_id == edit.track_id or (edit.source_id and c.source_id == edit.source_id))
        ):
            elsewhere.append(
                [c.track_id, c.source_id, max(c.source_start, s_lo), min(c.source_end, s_hi)]
            )
    heard.sort(key=repr)
    elsewhere.sort(key=repr)
    downstream.sort(key=repr)
    track_ids = [t.id for t in project.tracks]
    pairs: set[tuple[str, str | None]] = {(str(h[0]), h[1]) for h in heard}
    pairs |= {(str(e[0]), cast("str | None", e[1])) for e in elsewhere}
    media = {
        f"{t}|{sid}": [
            str(path := recording_audio_path(project, t, sid)),
            repr(file_stamp(path).revision),
        ]
        for t, sid in sorted(pairs, key=repr)
    }
    words = []
    for h in heard:
        first, last = h[3] - 1.0, h[4] + 1.0
        if (found := near(h[0], h[1], first, last)) is not None:
            words.append([h[0], h[1], first, last, found])
    chosen = {
        tid: _chosen_on_timeline(project, tid, batch, lo, hi)
        for tid in track_ids
        if any(e.track_id == tid for e in batch)
    }
    payload = {
        "edit": edit.model_dump(mode="json"),
        "manual": manual,
        "defaults": defaults,
        "span": [float(span[0]), float(span[1])],
        "heard": heard,
        "elsewhere": elsewhere,
        "downstream": downstream,
        "tracks": [t.model_dump(mode="json") for t in project.tracks],
        "sources": [s.model_dump(mode="json") for s in project.sources],
        "chains": [c.model_dump(mode="json") for c in project.processing_chains],
        "envelopes": [
            env.model_dump(mode="json")
            for tid in track_ids
            if (env := project.volume_envelope_for(tid)) is not None
        ],
        "media": media,
        "words": words,
        "pause": _pause_words_seen(project, edit, near),
        # A held pause records its observation span (``peer_observation_span``), which fade_reach_sec
        # widens: by the cut crossfade, the pad fade config and the longest fade of any clip, also
        # one ending before the window that nothing else here hashes. The words' places clamp the
        # span. The two ends are hashed (not their inputs), so a fade that moves neither still
        # hits. The gap between the words needs no entry: each word is hashed in ``pause`` and
        # placed by the clips in the window, or else by its end of the span.
        "pause_span": None if seen is None else [seen.lo, seen.hi],
        "pads": _pad_records_seen(project, edit, reach),
        "batch": chosen,
        "disk": _disk_stamps(project),
        "policy": [
            repr(sorted(cut_policy.CUT_ACTION_TABLE.items())),
            repr(cut_policy.CUT_EDGE_CHECKS),
        ],
    }
    return payload


def _pause_words_seen(
    project: EpisodeProject, edit: EditDecision, near: Callable[..., Any]
) -> list[Any] | None:
    """What a pause reads from the transcript with no source id, which ``words`` may not hold.

    ``pause_words`` reads that transcript (not the clips' own), and settles on the nearest kept
    word on each side of the cut. Everything between and including those two decides it; a side
    with none is open ended, as a word added anywhere on it would end the rejection.
    """
    if not _is_pause(edit):
        return None
    before, after = pause_neighbours(project, edit.track_id, edit.start, edit.end)
    lo = before.start if before is not None else -math.inf
    hi = after.end if after is not None else math.inf
    return [
        before.model_dump(mode="json") if before is not None else None,
        after.model_dump(mode="json") if after is not None else None,
        near(edit.track_id, None, lo, hi),
    ]


def _pad_records_seen(
    project: EpisodeProject, edit: EditDecision, reach: float
) -> list[Any] | None:
    """What a pause reads from the edit log: its pad records (#2439).

    ``original_pause_support`` treats a pad-purpose record with no ``pad_samples`` or a
    malformed one as a rejection, and takes each well-formed sample's source range as a pad
    whose tiles are not original quiet. Only those records are hashed: a record that is not a
    pad and carries no samples is skipped by the check, and a sample whose range lies past
    ``reach`` of the pause cannot hold a clip heard near it.
    """
    from podcast_mcp.util.tracks import recording_audio_path

    if not _is_pause(edit):
        return None
    lo, hi = edit.start - reach, edit.end + reach
    seen: list[Any] = []
    for record in project.editorial.edit_log:
        pad = is_pad_record(record)
        if "pad_samples" not in record.params:
            if pad:
                seen.append([record.id, "no_samples"])
            continue
        samples = record.params["pad_samples"]
        if not isinstance(samples, (list, tuple)):
            seen.append([record.id, "malformed"])
            continue
        kept: list[Any] = []
        for sample in samples:
            if not isinstance(sample, dict):
                kept.append("malformed")
                continue
            start, end = sample.get("source_start"), sample.get("source_end")
            numeric = all(
                isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                for v in (start, end)
            )
            if numeric and (cast("float", end) < lo or cast("float", start) > hi):
                # Far away, but a recording the check cannot resolve rejects wherever it lies.
                try:
                    recording_audio_path(project, sample["track_id"], sample["source_id"]).resolve(
                        strict=True
                    )
                except (CodedError, OSError, ValueError, KeyError, TypeError):
                    kept.append([sample, "unresolved"])
                continue
            kept.append(sample)
        if kept:
            seen.append([record.id, kept])
    return seen


def _heard(clip: Any, lo: float, hi: float) -> list[Any]:
    """What a clip plays inside the window: where from, over which span, with which edges.

    A clip's id and the ends that lie outside the window are left out, so a cut applied far
    away (which splits or trims the clip there) does not change what is heard near this one.
    """
    start, end = max(clip.timeline_start, lo), min(clip.timeline_end, hi)
    offset = clip.timeline_start - clip.source_start
    opens, closes = clip.timeline_start >= lo, clip.timeline_end <= hi
    return [
        clip.track_id,
        clip.source_id,
        offset,
        start - offset,
        end - offset,
        start,
        end,
        clip.fade_in_ms if opens else None,
        clip.fade_out_ms if closes else None,
        clip.join_in_mode.value if opens else None,
        [r.model_dump(mode="json") for r in clip.mute_regions],
        [r.model_dump(mode="json") for r in clip.off_speaker_mute_regions],
        clip.bleed_restore.model_dump(mode="json") if clip.bleed_restore else None,
    ]


def _words_near(project: EpisodeProject) -> Callable[[str, str | None, float, float], Any]:
    """A lookup of a source's words overlapping [first, last], bisected on the sorted words."""
    index: dict[tuple[str, str | None], Any] = {}

    def near(track_id: str, source_id: str | None, first: float, last: float) -> list[Any] | None:
        if (track_id, source_id) not in index:
            transcript = project.transcript_for_source(track_id, source_id)
            ordered = sorted(transcript.words, key=lambda w: w.start) if transcript else []
            index[track_id, source_id] = (
                (
                    ordered,
                    [w.start for w in ordered],
                    list(accumulate((w.end for w in ordered), max)),
                )
                if transcript
                else None
            )
        found = index[track_id, source_id]
        if found is None:
            return None
        ordered, starts, ends = found
        return [
            w.model_dump(mode="json")
            for w in ordered[bisect_left(ends, first) : bisect_right(starts, last)]
            if w.end >= first
        ]

    return near


def _outside_ramps(
    clip: Any, near: Callable[..., Any], opens: bool, closes: bool
) -> list[Any] | None:
    """The fade ends of a clip lying outside the window, on the source clock, with their words."""

    def edge(at: float, fade_ms: int) -> list[Any]:
        return [
            at,
            fade_ms,
            near(clip.track_id, clip.source_id, at - fade_ms / 1000 - 1, at + fade_ms / 1000 + 1),
        ]

    # A non-fade join is hashed with the in-edge: it is a ramp the check assesses too.
    ramp_in = opens and (clip.fade_in_ms or clip.join_in_mode != ClipJoinMode.FADE)
    ramp_out = closes and clip.fade_out_ms
    if not (ramp_in or ramp_out):
        return None
    return [
        clip.track_id,
        clip.source_id,
        [*edge(clip.source_start, clip.fade_in_ms), clip.join_in_mode.value] if ramp_in else None,
        edge(clip.source_end, clip.fade_out_ms) if ramp_out else None,
    ]


def _disk_stamps(project: EpisodeProject) -> list[list[str]]:
    """Files the speaker-bleed check reads besides the audio: profiles and transcript context."""
    workspace = project.workspace_path()
    files = sorted((project.artifacts_dir() / "speaker_profiles").glob("*.json"))
    files += [workspace / "show_glossary.yaml", workspace / "transcript_context.yaml"]
    return [[str(f), repr(file_stamp(f).revision) if f.is_file() else ""] for f in files]

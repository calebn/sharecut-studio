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
import threading
from collections.abc import Iterator, Sequence
from contextvars import ContextVar
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, cast

from podcast_mcp import settings
from podcast_mcp.edits import cut_policy
from podcast_mcp.edits.cut_quality import fade_reach_sec
from podcast_mcp.edits.cut_speech import SourceExtent, _chosen_on_timeline
from podcast_mcp.util.bounded_cache import BoundedCache
from podcast_mcp.util.fingerprint import file_stamp

if TYPE_CHECKING:
    from podcast_mcp.edits.cut_placement import CutScopeHold
    from podcast_mcp.edits.cut_safety import SourceCutObservations
    from podcast_mcp.edits.cut_speech import CutSpeechConfirmation
    from podcast_mcp.models import EditDecision, EpisodeProject

ENABLE_ENV = "PODCAST_VERDICT_CACHE"
VERIFY_ENV = "PODCAST_VERDICT_VERIFY"
# The farthest a check reads from its cut apart from fades: breath level context 5 s, voiced-run
# reach 0.64 s, pad and join reach under 0.2 s, plus margin. A fade reaches further by
# ``cut_quality.fade_reach_sec``.
READ_SEC = 6.0
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
    try:
        return _key(project, edit, defaults, manual, batch, span)
    except (OSError, ValueError, KeyError):
        return None


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

    reach = READ_SEC + fade_reach_sec(project, edit, defaults)
    lo = float(span[0]) - reach
    hi = float(span[1]) + reach
    s_lo, s_hi = edit.start - reach, edit.end + reach
    heard = []
    elsewhere = []
    for c in project.clips:
        if c.timeline_start < hi and c.timeline_end > lo:
            heard.append(_heard(c, lo, hi))
        elif (
            c.source_end > s_lo
            and c.source_start < s_hi
            and (c.track_id == edit.track_id or (edit.source_id and c.source_id == edit.source_id))
        ):
            elsewhere.append(
                [c.track_id, c.source_id, max(c.source_start, s_lo), min(c.source_end, s_hi)]
            )
    heard.sort(key=repr)
    elsewhere.sort(key=repr)
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
        transcript = project.transcript_for_source(h[0], h[1])
        if transcript is None:
            continue
        first, last = h[3] - 1.0, h[4] + 1.0
        words.append(
            [
                h[0],
                h[1],
                first,
                last,
                [
                    w.model_dump(mode="json")
                    for w in transcript.words
                    if w.end >= first and w.start <= last
                ],
            ]
        )
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
        "batch": chosen,
        "disk": _disk_stamps(project),
        "policy": [
            repr(sorted(cut_policy.CUT_ACTION_TABLE.items())),
            repr(cut_policy.CUT_EDGE_CHECKS),
        ],
    }
    return payload


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


def _disk_stamps(project: EpisodeProject) -> list[list[str]]:
    """Files the speaker-bleed check reads besides the audio: profiles and transcript context."""
    workspace = project.workspace_path()
    files = sorted((project.artifacts_dir() / "speaker_profiles").glob("*.json"))
    files += [workspace / "show_glossary.yaml", workspace / "transcript_context.yaml"]
    return [[str(f), repr(file_stamp(f).revision) if f.is_file() else ""] for f in files]

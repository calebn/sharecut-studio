"""Inter-word pacing after filler / hesitation cuts.

Dialogue editors remove the filler vocalization but leave a beat of air (or
replace the hesitation with a paced pad - silence by default, optional room
tone). These helpers enforce that policy for tighten proposals and NL removes.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from podcast_mcp.config import load_defaults
from podcast_mcp.models import EpisodeProject, TranscriptWord

FillerPadMode = Literal["silence", "room_tone"]


@dataclass(frozen=True)
class FillerPacingResult:
    """Adjusted cut range plus optional paced pad to apply after ripple."""

    start: float
    end: float
    replace_gap_sec: float | None = None
    # When False, optimized trailing-energy must not extend past ``end`` (protect
    # the next word's onset after a silence/room-tone pad). When True, filler
    # voice may overlap the next ASR token (um→you) and trailing energy may
    # chew slightly past ``end``.
    allow_trailing_past_end: bool = False


def _tighten(defaults: dict[str, Any] | None) -> dict[str, Any]:
    cfg = defaults if defaults is not None else load_defaults()
    return dict(cfg.get("tighten", {}) or {})


def filler_pad_mode(defaults: dict[str, Any] | None = None) -> FillerPadMode:
    """How to fill ``replace_gap_sec`` after ripple: silence (default) or room tone."""
    raw = str(_tighten(defaults).get("filler_pad_mode", "silence")).strip().lower()
    if raw == "room_tone":
        return "room_tone"
    return "silence"


def flanking_retained_words(
    project: EpisodeProject,
    track_id: str,
    cut_start: float,
    cut_end: float,
) -> tuple[TranscriptWord | None, TranscriptWord | None]:
    """Nearest words fully outside ``[cut_start, cut_end]`` (timing anchors).

    Includes suppressed words: bleed/suppressed tokens still mark local speech
    timing. Skipping them made room-tone expand jump to distant non-suppressed
    words and wipe huge ranges.
    """
    tr = project.transcript_for_track(track_id)
    if not tr:
        return None, None
    prev: TranscriptWord | None = None
    nxt: TranscriptWord | None = None
    for w in tr.words:
        if w.end <= w.start:
            continue
        if w.end <= cut_start + 1e-9:
            prev = w
        elif w.start >= cut_end - 1e-9:
            nxt = w
            break
    return prev, nxt


def shrink_cut_for_min_gap(
    cut_start: float,
    cut_end: float,
    prev_end: float,
    next_start: float,
    min_gap_sec: float,
    *,
    min_cut_sec: float = 0.02,
) -> tuple[float, float] | None:
    """Shrink ``[cut_start, cut_end]`` so flanking words keep ``min_gap_sec``.

    Returns ``None`` when the cut would vanish (leave the filler in).
    """
    if cut_end <= cut_start:
        return None
    original_gap = next_start - prev_end
    if original_gap <= 0:
        return None
    max_remove = original_gap - min_gap_sec
    if max_remove < min_cut_sec:
        return None
    duration = cut_end - cut_start
    if duration <= max_remove + 1e-9:
        return cut_start, cut_end
    excess = duration - max_remove
    new_start = cut_start + excess / 2.0
    new_end = cut_end - excess / 2.0
    # Keep the shrunk window inside the original inter-word gap.
    new_start = max(new_start, prev_end)
    new_end = min(new_end, next_start)
    if new_end - new_start < min_cut_sec:
        return None
    return new_start, new_end


def expand_cut_for_room_tone_replace(
    prev_end: float,
    next_start: float,
    *,
    start_margin_sec: float = 0.005,
    end_margin_sec: float = 0.005,
    min_cut_sec: float = 0.02,
) -> tuple[float, float] | None:
    """Cut the inter-word hesitation, leaving margins on retained neighbors.

    ``end_margin_sec`` should be large enough to keep the next word's onset
    (e.g. the L of “like”) attached to the following clip after a silence pad.
    """
    start = prev_end + start_margin_sec
    end = next_start - end_margin_sec
    if end - start < min_cut_sec:
        return None
    return start, end


def replace_gap_for_hesitation(
    *,
    inter_word_gap_sec: float,
    cut_dur_sec: float,
    defaults: dict[str, Any] | None = None,
) -> float:
    """Pad length after a filler/NL remove so flanking words are not slammed.

    Short um/uh cuts need ~0.3-0.5s of breathing room. Longer hesitations
    (“you know”, thinking pauses) should keep most of the original inter-word
    air - collapsing them to a fixed 0.5s makes “mean,” / “like” butt together.

    ``pad = clamp(min_gap, basis * retain_fraction, max_pad)``
    """
    cfg = _tighten(defaults)
    min_gap = float(cfg.get("min_gap_after_filler_sec", 0.35))
    retain = float(cfg.get("filler_gap_retain_fraction", 0.85))
    max_pad = float(cfg.get("filler_replace_gap_max_sec", 1.0))
    if min_gap <= 0:
        return 0.0
    if retain <= 0 or max_pad <= 0:
        return min_gap
    # Prefer the flanking-word gap when we expanded into it; otherwise the
    # requested cut duration is the hesitation we removed.
    basis = inter_word_gap_sec if inter_word_gap_sec > cut_dur_sec + 1e-6 else cut_dur_sec
    return max(min_gap, min(basis * retain, max_pad))


def apply_filler_pacing(
    project: EpisodeProject,
    track_id: str,
    cut_start: float,
    cut_end: float,
    *,
    defaults: dict[str, Any] | None = None,
    cut_kind: str = "filler",
) -> FillerPacingResult | None:
    """Enforce post-filler pacing; return adjusted cut or ``None`` to skip.

    * ``filler`` / ``nl`` - apply ``min_gap_after_filler_sec``. When
      ``filler_room_tone_replace`` is on, expand to the inter-word gap and set
      ``replace_gap_sec`` so apply inserts a paced pad after ripple
      (``filler_pad_mode``: silence by default, or room_tone). Pad keeps a
      fraction of the original gap (floor/cap) so long hesitations stay airy.
    * ``pause`` - no-op (pause candidates already use ``min_retained_pause_sec``).
    """
    if cut_kind in {"pause", "repeat", "restart"}:
        return FillerPacingResult(start=cut_start, end=cut_end)

    if cut_end <= cut_start:
        return None

    cfg = _tighten(defaults)
    min_gap = float(cfg.get("min_gap_after_filler_sec", 0.35))
    if min_gap <= 0:
        return FillerPacingResult(start=cut_start, end=cut_end)

    prev, nxt = flanking_retained_words(project, track_id, cut_start, cut_end)
    if prev is None or nxt is None:
        return FillerPacingResult(start=cut_start, end=cut_end)

    replace = bool(cfg.get("filler_room_tone_replace", True))
    margin_ms = float(
        (defaults or load_defaults()).get("inaudible_cuts", {}).get("min_word_margin_ms", 5)
    )
    word_margin = max(0.0, margin_ms / 1000.0)
    lead_in = float(cfg.get("filler_next_word_lead_in_ms", 80)) / 1000.0
    # Safety: never expand a short filler cut across a huge hesitation by mistake.
    max_expand_sec = float(cfg.get("filler_room_tone_max_expand_sec", 2.0))
    inter_word = max(0.0, nxt.start - prev.end)
    cut_dur = cut_end - cut_start
    # Air between the requested filler end and the next retained word. When the
    # next token overlaps the filler (um→you), this is ~0 and we must allow
    # trailing-energy past the expand end; when there is real air (know→like),
    # keep lead-in on the next onset so it doesn't start cold after the pad.
    air_before_next = max(0.0, nxt.start - cut_end)
    air_after_prev = max(0.0, cut_start - prev.end)
    overlap_next = air_before_next < 0.04
    overlap_prev = air_after_prev < 0.04
    end_margin = word_margin if overlap_next else max(word_margin, lead_in)
    # Keep previous-word release (e.g. N in "mean") - ASR ends often early on
    # nasals. Adaptive based on audio energy.
    if overlap_prev:
        start_margin = word_margin
    else:
        from podcast_mcp.edits.cut_quality import recommend_prev_word_lead_out_ms

        lead_out = (
            recommend_prev_word_lead_out_ms(
                project,
                track_id,
                prev.end,
                defaults=defaults,
                # Don't chew past the next retained word's lead-in budget.
                max_available_sec=max(0.0, inter_word - end_margin - 0.02),
            )
            / 1000.0
        )
        start_margin = max(word_margin, lead_out)

    if replace:
        expanded = expand_cut_for_room_tone_replace(
            prev.end,
            nxt.start,
            start_margin_sec=start_margin,
            end_margin_sec=end_margin,
        )
        if expanded is None:
            return None
        expand_dur = expanded[1] - expanded[0]
        orig_dur = cut_end - cut_start
        pad = replace_gap_for_hesitation(
            inter_word_gap_sec=inter_word,
            cut_dur_sec=cut_dur,
            defaults=defaults,
        )
        if expand_dur <= max(orig_dur + 1e-9, max_expand_sec):
            return FillerPacingResult(
                start=expanded[0],
                end=expanded[1],
                replace_gap_sec=pad,
                allow_trailing_past_end=overlap_next,
            )
        # Gap between anchors is huge vs the requested cut - keep local cut and
        # still leave a paced beat after ripple.
        return FillerPacingResult(
            start=cut_start,
            end=cut_end,
            replace_gap_sec=replace_gap_for_hesitation(
                inter_word_gap_sec=cut_dur,
                cut_dur_sec=cut_dur,
                defaults=defaults,
            ),
            allow_trailing_past_end=overlap_next,
        )

    shrunk = shrink_cut_for_min_gap(cut_start, cut_end, prev.end, nxt.start, min_gap)
    if shrunk is None:
        return None
    return FillerPacingResult(start=shrunk[0], end=shrunk[1])

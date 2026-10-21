"""Check a suggested trim against the audio checks that ``trim_clip_edge_tool`` will run (#1746).

``join_speech`` measures where clipped voice starts and suggests an edge 60 ms clear of it.
The trim itself is then proven by the cut-safety checks on every lane the trim touches, which
read the audio by their own rules. A suggestion that skips that proof can send an agent to an
edge the trim refuses. This runs the same proof on the suggestion without changing the project,
tries a little more air when the first edge is held, and says which edge is still unclean and
why when none passes.
"""

from __future__ import annotations

import logging
import subprocess
from dataclasses import dataclass, field
from typing import Any

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.cut_speech import UnconfirmedCutSpeech
from podcast_mcp.edits.ripple import plan_trim
from podcast_mcp.models import CutIntent, EditMode, EpisodeProject
from podcast_mcp.util.batch_scope import batch_scope

log = logging.getLogger(__name__)

#: Extra air tried beyond the suggested edge, in order, before the suggestion is called held.
NUDGES_SEC = (0.0, 0.01, 0.02, 0.04, 0.06, 0.09, 0.12, 0.16)


@dataclass(frozen=True)
class CheckedTrim:
    """The edge to suggest and what the trim's own audio check says about it."""

    source_sec: float
    status: str  # "passes" | "held" | "unchecked"
    nudged_ms: float = 0.0
    held: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"status": self.status}
        if self.nudged_ms:
            out["nudged_ms"] = round(self.nudged_ms, 1)
        if self.held:
            out["held"] = self.held
        return out


def _reasons(holds: list[Any]) -> list[str]:
    from podcast_mcp.edits.source_removals import ScopeChangedAtApproval

    error = ScopeChangedAtApproval(holds, {})
    return list(dict.fromkeys(error.reason_for(hold) for hold in holds))


def check_suggested_trim(
    project: EpisodeProject,
    *,
    clip_id: str,
    edge: str,
    source_sec: float,
    mode: EditMode,
    defaults: EffectiveConfig,
) -> CheckedTrim:
    """The suggestion if the trim accepts it, else the nearest edge with a little more air that
    it accepts, else the suggestion with the reasons it is held."""
    # Imported here: cut_application pulls in the cut-safety stack, which imports this tree.
    from podcast_mcp.edits.cut_application import trim_holds

    # Extending an in-point moves it earlier and an out-point later; more air goes that way.
    direction = -1.0 if edge == "in" else 1.0
    first_reasons: list[str] = []
    tried: set[float] = set()
    try:
        with batch_scope():
            for nudge in NUDGES_SEC:
                target = source_sec + direction * nudge
                plan = plan_trim(project, clip_id, edge, target, mode)  # type: ignore[arg-type]
                landed = round(float(plan.moves[0].source_sec), 4)
                if plan.unchanged or landed in tried:
                    continue
                tried.add(landed)
                try:
                    holds = trim_holds(
                        project,
                        plan,
                        application_intent=CutIntent.PROGRAMMATIC,
                        defaults=defaults,
                    )
                    reasons = _reasons(holds) if holds else []
                except UnconfirmedCutSpeech:
                    reasons = ["another speaker is talking where the trim would restore audio"]
                if not reasons:
                    return CheckedTrim(landed, "passes", abs(landed - source_sec) * 1000)
                if not first_reasons:
                    first_reasons = reasons
    except (OSError, ValueError, subprocess.SubprocessError):
        log.warning("could not check the suggested trim of %s", clip_id, exc_info=True)
        return CheckedTrim(source_sec, "unchecked")
    if not tried:
        return CheckedTrim(source_sec, "unchecked")
    return CheckedTrim(source_sec, "held", held=first_reasons)

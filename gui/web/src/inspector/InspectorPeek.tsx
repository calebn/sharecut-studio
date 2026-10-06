/**
 * The compact inspector's peek strip (#1051 round 3): what is selected, its
 * key value, and for a clip's fade or trim four nudges at the keyboard's
 * steps. Each nudge saves at once, as an arrow key on the focused handle
 * does. Expanding the sheet shows the full inspector with its fields.
 */
import { useState } from "react";
import { nudgeClipEdge, saveClipEdge } from "../edit/clipEdgeSave";
import { canApplyPass12 } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { errorMessage } from "../utils/apiError";
import type { PeekNudge, PeekTarget } from "./peekTarget";

function stepText(delta: number): string {
  return `${delta < 0 ? "−" : "+"}${Math.abs(delta)}`;
}

function stepLabel(title: string, nudge: PeekNudge, delta: number): string {
  const amount = `${Math.abs(delta)} ${nudge.unit}`;
  const way =
    nudge.kind === "fade"
      ? delta < 0
        ? "shorter"
        : "longer"
      : delta < 0
        ? "earlier"
        : "later";
  return `${title} ${amount} ${way}`;
}

export function InspectorPeek({ peek }: { peek: PeekTarget }) {
  const editable = useDaw(
    (s) =>
      canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities) &&
      !s.joinMutationInFlight,
  );
  const [busy, setBusy] = useState(false);
  const { nudge } = peek;

  const step = async (delta: number) => {
    const s = useDawStore.getState();
    if (!nudge || !s.project || busy) return;
    const change = nudgeClipEdge(
      s.project,
      nudge.clip,
      nudge.kind,
      nudge.edge,
      delta,
    );
    if (!change) {
      s.announceStatus(`${peek.title} is at its limit`);
      return;
    }
    setBusy(true);
    try {
      if (!(await saveClipEdge(s.projectPath, nudge.clip, change))) return;
      useDawStore
        .getState()
        .announceStatus(nudge.kind === "fade" ? "Fade saved" : "Trim saved");
    } catch (error) {
      useDawStore
        .getState()
        .announceStatus(`Clip edit failed: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="inspector-peek">
      <p className="inspector-peek-reading">
        {peek.owner ? (
          <span className="inspector-peek-owner">{peek.owner}</span>
        ) : null}
        <output className="inspector-peek-value">{peek.value}</output>
      </p>
      {nudge && editable ? (
        <div
          className="inspector-peek-nudges"
          role="group"
          aria-label={`Nudge ${peek.title.toLowerCase()}`}
        >
          {[
            -nudge.steps[1],
            -nudge.steps[0],
            nudge.steps[0],
            nudge.steps[1],
          ].map((delta) => (
            <button
              key={delta}
              type="button"
              className="ui-control inspector-peek-nudge"
              aria-label={stepLabel(peek.title, nudge, delta)}
              disabled={busy}
              onClick={() => void step(delta)}
            >
              {stepText(delta)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

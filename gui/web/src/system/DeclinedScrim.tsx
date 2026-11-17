import { useEffect, useId, useRef } from "react";
import { Button } from "../ui";
import {
  DECLINED_TEXT,
  type DeclinedSeat,
  declinedPeek,
} from "./joinSheetModel";
import type { RoomPhase } from "./roomPhase";
import { SystemIcon } from "./SystemIcon";

export type DeclinedScrimProps = {
  phase: RoomPhase;
  seat: DeclinedSeat;
  /** Opens the Join sheet at the consent step. */
  onJoin: () => void;
  /** The looking-in line, shown directly on top of the bar. */
  lookingIn?: string | null;
};

/**
 * The Declined phase over the room: a dim layer and a bottom peek bar. The
 * room stays visible behind it, and the bar says the viewer is not being
 * recorded. A guest's Join recording waits for the room to be waiting again; a
 * producer's Join to listen never waits. When the scrim appears it takes
 * focus, because the room behind it goes inert: the Join button when it works,
 * the bar itself while it is held.
 */
export function DeclinedScrim({
  phase,
  seat,
  onJoin,
  lookingIn,
}: DeclinedScrimProps) {
  const text = DECLINED_TEXT[seat];
  const { disabledReason } = declinedPeek(phase, seat);
  const lineId = useId();
  const reasonId = useId();
  const barRef = useRef<HTMLElement>(null);
  // Only on entry: a phase change while declined must not pull focus back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount only.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    (bar.querySelector<HTMLElement>("button:not(:disabled)") ?? bar).focus();
  }, []);
  return (
    <div className="sys-declined">
      <div className="sys-declined-scrim" aria-hidden="true" />
      {lookingIn ? (
        <p className="sys-declined-looking-in">
          <SystemIcon name="eye" size={16} />
          {lookingIn}
        </p>
      ) : null}
      <section
        ref={barRef}
        tabIndex={-1}
        className="sys-declined-bar"
        aria-label={text.label}
      >
        <SystemIcon name={text.glyph} size={20} />
        <div className="sys-declined-text">
          <p id={lineId} className="sys-declined-line">
            {text.line}
          </p>
          {disabledReason ? (
            <p id={reasonId} className="sys-declined-reason">
              {disabledReason}
            </p>
          ) : null}
        </div>
        <Button
          variant="primary"
          disabledReason={disabledReason ?? undefined}
          aria-describedby={disabledReason ? `${lineId} ${reasonId}` : lineId}
          onClick={onJoin}
        >
          {text.join}
        </Button>
      </section>
    </div>
  );
}

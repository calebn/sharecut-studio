import { useEffect, useId, useRef } from "react";
import { Button } from "../ui";
import { DECLINED_TEXT, declinedPeek } from "./joinSheetModel";
import type { RoomPhase } from "./roomPhase";
import { SystemIcon } from "./SystemIcon";

export type DeclinedScrimProps = {
  phase: RoomPhase;
  /** Opens the Join sheet at the consent step. */
  onJoin: () => void;
};

/**
 * The Declined phase over the room: a dim layer and a bottom peek bar. The
 * room stays visible behind it, and the bar says the viewer is not being
 * recorded. Join recording waits for the room to be waiting again. When the
 * scrim appears it takes focus, because the room behind it goes inert: the
 * Join button when it works, the bar itself while it is held.
 */
export function DeclinedScrim({ phase, onJoin }: DeclinedScrimProps) {
  const { disabledReason } = declinedPeek(phase);
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
      <section
        ref={barRef}
        tabIndex={-1}
        className="sys-declined-bar"
        aria-label="Not being recorded"
      >
        <SystemIcon name="mic-off" size={20} />
        <div className="sys-declined-text">
          <p className="sys-declined-line">{DECLINED_TEXT.line}</p>
          {disabledReason ? (
            <p id={reasonId} className="sys-declined-reason">
              {disabledReason}
            </p>
          ) : null}
        </div>
        <Button
          variant="primary"
          disabledReason={disabledReason ?? undefined}
          aria-describedby={disabledReason ? reasonId : undefined}
          onClick={onJoin}
        >
          {DECLINED_TEXT.join}
        </Button>
      </section>
    </div>
  );
}

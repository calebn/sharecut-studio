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
 * recorded. Join recording waits for the take to end.
 */
export function DeclinedScrim({ phase, onJoin }: DeclinedScrimProps) {
  const { disabledReason } = declinedPeek(phase);
  return (
    <div className="sys-declined">
      <div className="sys-declined-scrim" aria-hidden="true" />
      <section className="sys-declined-bar" aria-label="Not being recorded">
        <SystemIcon name="mic-off" size={20} />
        <div className="sys-declined-text">
          <p className="sys-declined-line">{DECLINED_TEXT.line}</p>
          {disabledReason ? (
            <p className="sys-declined-reason">{disabledReason}</p>
          ) : null}
        </div>
        <Button
          variant="primary"
          disabledReason={disabledReason ?? undefined}
          onClick={onJoin}
        >
          {DECLINED_TEXT.join}
        </Button>
      </section>
    </div>
  );
}

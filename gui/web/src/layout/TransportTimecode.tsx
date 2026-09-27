import { memo } from "react";
import { useDawStore } from "../state/dawStore";
import { Timecode } from "../ui";
import { transportTimecode } from "../utils/time";

type Props = {
  /** Episode duration, for the digit layout and the `total` readout. */
  durationSec: number;
  /** False in collapsed transport chrome: playhead only, no `/ total`. */
  showTotal?: boolean;
};

/**
 * Transport/listen playhead readout leaf. Selects `playheadSec` itself, so a
 * playhead tick re-renders only this span, not the transport bar or listen
 * card around it.
 */
function TransportTimecodeInner({ durationSec, showTotal = true }: Props) {
  const playheadSec = useDawStore((s) => s.playheadSec);
  const timecode = transportTimecode(playheadSec, durationSec);
  return (
    <Timecode
      current={timecode.current}
      total={showTotal ? timecode.total : undefined}
      title={timecode.title}
    />
  );
}

export const TransportTimecode = memo(TransportTimecodeInner);

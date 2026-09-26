import { Button, LevelMeter, type LevelMeterSize } from "../ui";
import { HEADROOM_HINT_COPY, METER_CLIPPED_COPY } from "./types";
import { useInputPeakDb } from "./useInputPeakDb";

type Props = {
  stream: MediaStream | null;
  label: string;
  size?: LevelMeterSize;
};

/** Your own mic level with a latching clip LED and headroom guidance. */
export function MicMeter({ stream, label, size = "md" }: Props) {
  const meter = useInputPeakDb(stream);
  if (!stream) {
    return null;
  }
  return (
    <div className="stack">
      <LevelMeter
        levelDb={meter.levelDb}
        peakHoldDb={meter.peakHoldDb}
        clipped={meter.clipped}
        label={label}
        size={size}
        showNumeric
      />
      {meter.suspended ? (
        <Button type="button" onClick={meter.resume}>
          Start level meter
        </Button>
      ) : null}
      {meter.clipped ? (
        <>
          <p className="record-hint">{METER_CLIPPED_COPY}</p>
          <Button type="button" onClick={meter.clearClip}>
            Clear clip light
          </Button>
        </>
      ) : (
        <p className="record-hint">{HEADROOM_HINT_COPY}</p>
      )}
    </div>
  );
}

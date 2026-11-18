import type { PlayerProps } from "./Player";

/**
 * What the stylesheet needs to know about the bar's contents to decide what
 * to give up: how many pills it holds (the Playback rate counts, and so does the
 * Audio error pill, whose status text hides and is not counted), and whether
 * the left column is longer than the usual `m:ss.mmm` (an hours clock, or a
 * Playback rate beside it).
 */
export type BarSignals = {
  pills: number;
  longClock: boolean;
};

type SignalProps = Pick<
  PlayerProps,
  "time" | "rate" | "state" | "status" | "solo" | "following" | "guest"
>;

export function barSignals(props: SignalProps): BarSignals {
  const { state, guest } = props;
  const error = state === "error";
  const pills = [
    props.following?.detail,
    props.solo && !guest,
    state === "mix-updating",
    props.rate !== undefined,
    props.status && !error,
    error,
  ].filter(Boolean).length;
  return {
    pills,
    longClock: props.time.split(":").length > 2 || props.rate !== undefined,
  };
}

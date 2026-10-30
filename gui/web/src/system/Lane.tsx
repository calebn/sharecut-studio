import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useContext,
  useId,
  useMemo,
} from "react";
import { presenceColorVar } from "../presence/colors";
import type { MuteState } from "../utils/audio";
import {
  clampLaneHeight,
  itemBox,
  itemVisible,
  laneMuteLook,
} from "./laneMath";
import type { MarkerAttrs } from "./Marker";

export type LaneProps = {
  /** The track's name; the lane is a group named `Track ${name}`. */
  name: string;
  /** Index into the eight presence colours; the track's. Tints the lane and draws its 3 px edge. */
  colorIndex: number;
  /** In px, held to 72 through 240. The host passes 104 on touch. */
  height?: number;
  /** Seconds at the lane's left edge. The ruler and the marker lane take the same `start`, `pxPerSecond` and `width`. */
  start: number;
  pxPerSecond: number;
  /** In px. */
  width: number;
  /** A silent lane is drawn on the muted track colour, and says why to assistive tech. */
  mute?: MuteState;
  /** Peaks are still on their way: a flat line runs through the middle. */
  loading?: boolean;
  /** Attributes for the lane's root, such as a presence anchor. */
  anchorProps?: MarkerAttrs;
  /** `LaneItem`s. */
  children?: ReactNode;
};

const px = (value: number) => `${value}px`;

type LaneWindow = { start: number; pxPerSecond: number; width: number };

const LaneWindowContext = createContext<LaneWindow | null>(null);

/**
 * One track's stripe of the timeline (design-system element 15a). It owns the
 * height, the colour, the time-to-x window and the loading line, and none of
 * what a clip does: its children are `Clip`s in `LaneItem`s.
 */
export function Lane({
  name,
  colorIndex,
  height,
  start,
  pxPerSecond,
  width,
  mute = "off",
  loading = false,
  anchorProps,
  children,
}: LaneProps) {
  const statusId = useId();
  const { description } = laneMuteLook(mute);
  const laneWindow = useMemo(
    () => ({ start, pxPerSecond, width }),
    [start, pxPerSecond, width],
  );
  return (
    <div
      {...anchorProps}
      role="group"
      aria-label={`Track ${name}`}
      aria-busy={loading || undefined}
      aria-describedby={description ? statusId : undefined}
      data-mute={mute}
      className="sys-lane"
      style={
        {
          "--sys-lane-color": presenceColorVar(colorIndex),
          "--sys-lane-height": px(clampLaneHeight(height)),
          "--sys-lane-width": px(width),
        } as CSSProperties
      }
    >
      {loading ? <span className="sys-lane-flat" aria-hidden="true" /> : null}
      {description ? (
        <span id={statusId} className="sr-only">
          {description}
        </span>
      ) : null}
      <LaneWindowContext value={laneWindow}>{children}</LaneWindowContext>
    </div>
  );
}

export type LaneItemProps = {
  /** Where the clip begins, in seconds. */
  at: number;
  /** Seconds the clip covers. */
  duration: number;
  children: ReactNode;
};

/**
 * Positions a `Clip` in its `Lane` from the clip's time, with the lane's
 * window. Draws nothing for a clip wholly outside the window.
 */
export function LaneItem({ at, duration, children }: LaneItemProps) {
  const lane = useContext(LaneWindowContext);
  if (lane === null) throw new Error("LaneItem belongs inside a Lane");
  const box = itemBox(at, duration, lane.start, lane.pxPerSecond);
  if (!itemVisible(box, lane.width)) return null;
  return (
    <div
      className="sys-lane-item"
      style={
        {
          "--sys-lane-x": px(box.left),
          "--sys-lane-w": px(box.width),
        } as CSSProperties
      }
    >
      {children}
    </div>
  );
}

import { type CSSProperties, memo } from "react";
import { initials, presenceColorVar } from "../presence/colors";
import type { PresencePerson } from "../presence/presencePeople";
import type { LaneRowBox } from "./laneMath";
import {
  flagSide,
  playheadVisible,
  presenceX,
  selectionBox,
  visiblePeople,
} from "./presenceMath";

export type { PresencePerson };

export type PresenceSelection = {
  id: string;
  /** The person whose selection it is. */
  personId: string;
  /** The lane it lies in: the `id` of one of the `rows`. */
  laneId: string;
  /** Seconds. */
  start: number;
  end: number;
  colorIndex: number;
};

export type PresenceProps = {
  /** Keep the array stable: a new one redraws the overlay. */
  people: readonly PresencePerson[];
  selections?: readonly PresenceSelection[];
  /** Each lane's top and height in px from the top of the ruler: `laneRows`. */
  rows: readonly LaneRowBox[];
  /** The person you follow draws nothing: you already see what they see. */
  followed?: string | null;
  /** Seconds at the left edge of the time column: the ruler's `start`. */
  start: number;
  pxPerSecond: number;
  /** In px: the ruler's `width`. */
  width: number;
};

const px = (value: number) => `${value}px`;

/**
 * Other people's playheads and selections over the whole timeline stack
 * (OVL-PRESENCE): a 1 px line in their colour from the ruler down through the
 * lanes with a 16 px flag on the ruler, and a 1 px outline with no fill around
 * what they have selected. It is one sibling of the ruler, the marker lane and
 * the lanes in their time column, not a child of the ruler, which clips its
 * children. It takes no pointer and is hidden from assistive tech: who is here
 * is for the people list to say.
 */
export const Presence = memo(function Presence({
  people,
  selections = [],
  rows,
  followed = null,
  start,
  pxPerSecond,
  width,
}: PresenceProps) {
  return (
    <div className="sys-presence" aria-hidden="true">
      {selections.map((selection) => {
        const row = rows.find((item) => item.id === selection.laneId);
        if (row === undefined || selection.personId === followed) return null;
        const box = selectionBox(
          selection.start,
          selection.end,
          start,
          pxPerSecond,
          width,
        );
        if (box === null) return null;
        return (
          <div
            key={selection.id}
            className="sys-presence-sel"
            data-person={selection.personId}
            data-clip-start={box.startVisible ? undefined : ""}
            data-clip-end={box.endVisible ? undefined : ""}
            style={
              {
                "--sys-presence-color": presenceColorVar(selection.colorIndex),
                "--sys-presence-top": px(row.top),
                "--sys-presence-height": px(row.height),
                "--sys-presence-left": px(box.left),
                "--sys-presence-right": px(box.right),
              } as CSSProperties
            }
          />
        );
      })}
      {visiblePeople(people, followed).map((person) => {
        if (person.playhead === undefined) return null;
        const x = presenceX(person.playhead, start, pxPerSecond);
        if (!playheadVisible(x, width)) return null;
        return (
          <div
            key={person.id}
            className="sys-presence-person"
            data-person={person.id}
            style={
              {
                "--sys-presence-color": presenceColorVar(person.colorIndex),
                "--sys-presence-x": px(x),
              } as CSSProperties
            }
          >
            <span className="sys-presence-line" />
            <span
              className={`sys-presence-flag sys-presence-flag--${flagSide(x, width)}`}
            >
              {initials(person.name).slice(0, 1)}
            </span>
          </div>
        );
      })}
    </div>
  );
});

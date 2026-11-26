import { type CSSProperties, memo } from "react";
import { presenceColorVar } from "../presence/colors";
import type { PresencePerson } from "../presence/presencePeople";
import type { LaneRowBox } from "./laneMath";
import {
  FLAG_PX,
  type PresenceFlag,
  pressSpan,
  selectionBox,
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
  /** From `presenceFlags`. Keep the array stable: a new one redraws the overlay. */
  flags: readonly PresenceFlag[];
  selections?: readonly PresenceSelection[];
  /** Each lane's top and height in px from the top of the ruler: `laneRows`. */
  rows: readonly LaneRowBox[];
  /** The person you follow draws no selection: you already see what they see. */
  followed?: string | null;
  /** Seconds at the left edge of the time column: the ruler's `start`. */
  start: number;
  pxPerSecond: number;
  /** In px: the ruler's `width`. */
  width: number;
  /** The press area's side in px: the `hit` the flags were made with. */
  hit: number;
  /** The people a press can jump to. A flag with none of them is a plain mark, not a button. */
  jumpable?: ReadonlySet<string>;
  /** A press on a single flag. Keep it stable. */
  onGoTo?: (id: string) => void;
  /** A press on a group flag, with the pill's box. Keep it stable. */
  onGroup?: (key: string, anchor: DOMRect) => void;
};

const px = (value: number) => `${value}px`;

const NONE: ReadonlySet<string> = new Set();

const groupTitle = (flag: PresenceFlag) => {
  const names = flag.people.map((person) => person.name);
  return names.length <= 3
    ? names.join(", ")
    : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
};

/**
 * Other people's playheads and selections over the whole timeline stack
 * (OVL-PRESENCE): a 1 px line in their colour from the ruler down through the
 * lanes with a 16 px flag on the ruler, and a 1 px outline with no fill around
 * what they have selected. People whose press areas would overlap share one
 * neutral `+N` flag. It is one sibling of the ruler, the marker lane and the
 * lanes in their time column, not a child of the ruler, which clips its
 * children. The overlay is hidden from assistive tech and takes no pointer
 * except on a flag that can jump: that one is a button with its own box, at
 * least `hit` square, and not in the tab order. The people list is the keyboard
 * and screen-reader way to go to someone.
 */
export const Presence = memo(function Presence({
  flags,
  selections = [],
  rows,
  followed = null,
  start,
  pxPerSecond,
  width,
  hit,
  jumpable = NONE,
  onGoTo,
  onGroup,
}: PresenceProps) {
  const last = rows.at(-1);
  return (
    <div
      className="sys-presence"
      aria-hidden="true"
      style={
        {
          "--sys-presence-flag": px(FLAG_PX),
          "--sys-presence-hit": px(hit),
          ...(last === undefined
            ? {}
            : { "--sys-presence-end": px(last.top + last.height) }),
        } as CSSProperties
      }
    >
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
      {flags.flatMap((flag) =>
        flag.people.map((person) => (
          <div
            key={person.id}
            className="sys-presence-person"
            data-person={person.id}
            style={
              {
                "--sys-presence-color": presenceColorVar(person.colorIndex),
                "--sys-presence-x": px(person.x),
              } as CSSProperties
            }
          >
            <span className="sys-presence-line" />
          </div>
        )),
      )}
      {flags.map((flag) => {
        const single = flag.people.length === 1;
        const first = flag.people[0];
        if (first === undefined) return null;
        const members = flag.people.filter((person) => jumpable.has(person.id));
        const span = pressSpan(flag, hit);
        const props = {
          className: "sys-presence-hit",
          "data-flag": flag.key,
          "data-side": flag.side,
          title: groupTitle(flag),
          style: {
            "--sys-presence-color": presenceColorVar(first.colorIndex),
            "--sys-presence-hit-left": px(span.left),
            "--sys-presence-hit-w": px(span.right - span.left),
            "--sys-presence-w": px(flag.width),
          } as CSSProperties,
        };
        const pill = (
          <span
            className={`sys-presence-flag${single ? "" : " sys-presence-flag--group"}`}
            data-person={single ? first.id : undefined}
          >
            {flag.text}
          </span>
        );
        if (members.length === 0) {
          return (
            <span key={flag.key} {...props}>
              {pill}
            </span>
          );
        }
        return (
          <button
            key={flag.key}
            type="button"
            tabIndex={-1}
            {...props}
            onClick={(event) => {
              if (single) onGoTo?.(first.id);
              else onGroup?.(flag.key, pillBox(event.currentTarget));
            }}
          >
            {pill}
          </button>
        );
      })}
    </div>
  );
});

const pillBox = (button: HTMLElement) =>
  (button.firstElementChild ?? button).getBoundingClientRect();

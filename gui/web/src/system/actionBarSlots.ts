import type { ReactNode } from "react";
import type { BarId } from "./editActionSets";
import type { SystemIconName } from "./icons";

export type BarOption = {
  readonly value: string;
  readonly label: string;
  readonly icon: SystemIconName;
  readonly pressed: boolean;
};

export type BarSplit = {
  /** Names the chevron, the dock's options row and the content's dialog. */
  readonly label: string;
  readonly content: ReactNode;
};

export type BarItem = {
  readonly id: BarId;
  /** The word on the button when it differs from the verb label: "Looks right". */
  readonly label?: string;
  /** Hear while it plays, Mute while it is on. */
  readonly pressed?: boolean;
  /** `link` is the quiet inline button, such as Review's Later. */
  readonly tone?: "link";
  readonly arg?: string;
  readonly disabledReason?: string;
  readonly describedBy?: string;
  readonly options?: readonly BarOption[];
  readonly split?: BarSplit;
};

export const SPLIT_OPTIONS_ARG = "options";

export function isOptionsRow(item: BarItem): boolean {
  return item.split !== undefined && item.arg === SPLIT_OPTIONS_ARG;
}

function optionsRow(item: BarItem & { split: BarSplit }): BarItem {
  return {
    id: item.id,
    arg: SPLIT_OPTIONS_ARG,
    label: item.split.label,
    split: item.split,
    disabledReason: item.disabledReason,
  };
}

/** Verb slots in the phone dock before its start slot is measured, the primary's included. Design-system element 7 and spec-edit. */
const DOCK_VERB_SLOTS = 5;

/** Items as slots: a Hear before and Hear after pair is one A/B slot. */
export function slotsOf(items: readonly BarItem[]): BarItem[][] {
  const slots: BarItem[][] = [];
  for (let at = 0; at < items.length; at++) {
    const item = items[at] as BarItem;
    if (item.id === "hearBefore" && items[at + 1]?.id === "hearAfter") {
      slots.push([item, items[at + 1] as BarItem]);
      at++;
    } else {
      slots.push([item]);
    }
  }
  return slots;
}

/**
 * The dock keeps `DOCK_VERB_SLOTS` verbs less the `reserved` slots the primary
 * and the end and leading controls take, and moves the rest, in bar order, to
 * the head of More. With a measured `capacity` (the 48 px buttons the start
 * slot holds, More's included) it keeps the leading slots that fit instead: an
 * A/B pair costs two buttons and never splits. Inspect is the dock's grip and
 * More is drawn by the dock, so neither takes a slot.
 */
export function foldDock(
  items: readonly BarItem[],
  more: readonly BarItem[],
  reserved: number,
  capacity?: number,
): { items: BarItem[]; more: BarItem[] } {
  const slots = slotsOf(
    items.filter((item) => item.id !== "more" && item.id !== "inspect"),
  );
  let room = Math.max(0, DOCK_VERB_SLOTS - reserved);
  if (capacity !== undefined) {
    const hasSplit = (count: number) =>
      slots.slice(0, count).some((slot) => slot.some((item) => item.split));
    const fits = (count: number) => {
      const buttons = slots
        .slice(0, count)
        .reduce((total, slot) => total + slot.length, 0);
      const drawsMore =
        count < slots.length || more.length > 0 || hasSplit(count);
      return buttons + (drawsMore ? 1 : 0) <= capacity;
    };
    room = slots.length;
    while (room > 0 && !fits(room)) room--;
  }
  const kept = slots.slice(0, room).flat();
  const moved = slots.slice(room).flat();
  const splitRows = (rows: readonly BarItem[]) =>
    rows.flatMap((item) =>
      item.split ? [optionsRow({ ...item, split: item.split })] : [],
    );
  return {
    items: kept,
    more: [
      ...moved.flatMap((item) =>
        item.split
          ? [item, optionsRow({ ...item, split: item.split })]
          : [item],
      ),
      ...splitRows(kept),
      ...more,
    ],
  };
}

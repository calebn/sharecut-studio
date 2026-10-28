import type {
  RecordSnapshot,
  SegmentAckRow,
  StartBlockerItem,
  TakeInput as TrayInput,
} from "../../record";
import type { ShellBreakpoint } from "../../state/types";
import { clockText } from "../../system/roomPhase";
import type { ViewerWidth } from "../../system/roomViewModel";
import type { TakeInput, TakeLineInput } from "../../system/takesTrayModel";

export function viewerWidthOf(shell: ShellBreakpoint): ViewerWidth {
  return shell === "phone" ? "phone" : "desktop";
}

export function startDisabledReason(
  blocked: boolean,
  blockers: readonly StartBlockerItem[],
): string | undefined {
  if (!blocked || blockers.length === 0) {
    return undefined;
  }
  return blockers.map((item) => item.text).join(" ");
}

function progressOf(rows: readonly SegmentAckRow[]): {
  done: number;
  total: number;
} {
  let done = 0;
  let total = 0;
  for (const row of rows) {
    const parts = row.expected_parts ?? 0;
    total += parts;
    done += row.file_ack ? parts : row.acked_parts.length;
  }
  return total > 0 ? { done, total } : { done: 0, total: 1 };
}

function lineOf(
  status: TrayInput["people"][number]["status"],
  open: boolean,
  rows: readonly SegmentAckRow[],
): TakeLineInput {
  switch (status) {
    case "saved":
      return { kind: "saved" };
    case "failed":
      return { kind: "land-failed" };
    case "saving":
      return { kind: "saving", ...progressOf(rows) };
    case "waiting":
      return open ? { kind: "saving", done: 0, total: 1 } : { kind: "offline" };
  }
}

export function trayTakes(
  inputs: readonly TrayInput[],
  snapshot: RecordSnapshot | null,
  segments: readonly SegmentAckRow[],
): TakeInput[] {
  if (!snapshot) {
    return [];
  }
  const colors = new Map(
    snapshot.participants.map((person, index) => [
      person.participant_id,
      index,
    ]),
  );
  return inputs.map((take) => ({
    id: `take-${take.takeIndex}`,
    number: take.take,
    lengthSec: take.lengthSec,
    live: take.open,
    people: take.people.map((person) => {
      const rows = segments.filter(
        (row) =>
          row.take_index === take.takeIndex && row.participant_id === person.id,
      );
      return {
        person: {
          name: person.name,
          colorIndex: colors.get(person.id) ?? 0,
        },
        line: lineOf(person.status, take.open, rows),
        clipTimes: person.clipping?.regions.map((region) =>
          clockText(region.startMs / 1000),
        ),
        clipTruncated: person.clipping?.truncated,
      };
    }),
  }));
}

type ClipRegion = NonNullable<
  TrayInput["people"][number]["clipping"]
>["regions"][number];

export function firstClipped(
  inputs: readonly TrayInput[],
  takeIndex: number,
): { participantId: string; region: ClipRegion } | null {
  let first: { participantId: string; region: ClipRegion } | null = null;
  const take = inputs.find((input) => input.takeIndex === takeIndex);
  for (const person of take?.people ?? []) {
    const region = person.clipping?.regions[0];
    if (region && (!first || region.startMs < first.region.startMs)) {
      first = { participantId: person.id, region };
    }
  }
  return first;
}

export function takeIndexOf(id: string): number {
  return Number(id.replace("take-", ""));
}

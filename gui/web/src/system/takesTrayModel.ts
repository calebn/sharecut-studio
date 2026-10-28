import type { PersonData } from "./Person";
import { clockText } from "./roomPhase";
import { savingFraction, savingPercentText } from "./roomTileModel";
import type { StatusRowState } from "./StatusRow";

export type TakeLineInput =
  | { kind: "saved" }
  | { kind: "saving"; done: number; total: number }
  | { kind: "offline" }
  | { kind: "land-failed" };

export type TakePersonInput = {
  person: PersonData;
  line: TakeLineInput;
  clipTimes?: string[];
};

export type TakeInput = {
  id: string;
  number: number;
  lengthSec: number;
  live?: boolean;
  people: TakePersonInput[];
};

export type TakeLine = {
  key: string;
  name: string;
  state: StatusRowState;
  detail: string;
  progress?: number;
  retry: boolean;
};

export type TakeRow = {
  id: string;
  title: string;
  detail: string;
  state: StatusRowState;
  progress?: number;
  hear: boolean;
  lines: TakeLine[];
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function clipText(times: string[] | undefined): string | null {
  if (!times || times.length === 0) return null;
  return `Clipped ${plural(times.length, "time", "times")} · ${times.join(", ")}`;
}

export function takeLine(entry: TakePersonInput): TakeLine {
  const { line } = entry;
  const clips = clipText(entry.clipTimes);
  const base = { key: entry.person.name, name: entry.person.name };
  switch (line.kind) {
    case "saved":
      return {
        ...base,
        state: "done",
        detail: ["Saved", clips].filter(Boolean).join(" · "),
        retry: false,
      };
    case "saving": {
      const fraction = savingFraction(line.done, line.total);
      return {
        ...base,
        state: "running",
        detail: savingPercentText(line.done, line.total),
        progress: fraction,
        retry: false,
      };
    }
    case "offline":
      return {
        ...base,
        state: "queued",
        detail: `Waiting for ${entry.person.name} to come back online`,
        retry: false,
      };
    case "land-failed":
      return {
        ...base,
        state: "failed",
        detail: "Couldn't add to the timeline",
        retry: true,
      };
  }
}

function aggregate(
  lines: TakeLine[],
  live: boolean,
): Pick<TakeRow, "state" | "progress"> {
  if (live) return { state: "running" };
  if (lines.some((line) => line.state === "failed")) return { state: "failed" };
  const running = lines.filter((line) => line.state === "running");
  if (running.length > 0) {
    const total = lines.reduce(
      (sum, line) => sum + (line.state === "done" ? 1 : (line.progress ?? 0)),
      0,
    );
    return { state: "running", progress: savingFraction(total, lines.length) };
  }
  if (lines.some((line) => line.state === "queued")) return { state: "queued" };
  return { state: "done" };
}

export function takeRow(take: TakeInput): TakeRow {
  const lines = take.people.map(takeLine);
  const live = take.live === true;
  const { state, progress } = aggregate(lines, live);
  const length = clockText(take.lengthSec);
  const people = plural(take.people.length, "person", "people");
  return {
    id: take.id,
    title: `Take ${take.number}`,
    detail: live
      ? `Recording · ${length} · ${people}`
      : `${length} · ${people}`,
    state,
    progress,
    hear: state === "done",
    lines,
  };
}

export function takesTrayModel(takes: readonly TakeInput[]): TakeRow[] {
  return [...takes].sort((a, b) => a.number - b.number).map(takeRow);
}

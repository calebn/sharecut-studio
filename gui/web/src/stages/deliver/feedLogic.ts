import type { StatusState } from "../../system/statusText";
import { plural, thingsLeft } from "./deliverLogic";
import type {
  Fact,
  FeedCommand,
  FeedView,
  FieldKey,
  FieldValue,
  Finding,
  Fix,
  Known,
  Resolved,
  Severity,
  WriteRequest,
} from "./feedView";

export { plural };

/** The stages that own the facts the listing reads but never edits. */
export type SourceOwner = "chapters" | "clips" | "speakers" | "transcript";

export const KEY = {
  title: "item.title",
  intro: "item.intro",
  notes: "item.notes",
  published: "item.pubDate",
  duration: "item.duration",
  guid: "item.guid",
  hosting: "item.enclosure.url",
  showTitle: "channel.title",
} as const;

export function isKnown<T>(fact: Fact<T>): fact is Known<T> {
  return fact.source.kind !== "pending";
}

type Record_ = FeedView["item"];

function missing(key: FieldKey): Fact<never> {
  return {
    value: null,
    source: { kind: "pending", why: `${key} is not in the view.`, fix: null },
  };
}

/** A string fact by key. A value of another type reads as missing, so a wrong shape never reaches the screen. */
export function textFact(record: Record_, key: FieldKey): Fact<string> {
  const fact = record[key] ?? missing(key);
  if (!isKnown(fact)) return fact;
  return typeof fact.value === "string"
    ? { value: fact.value, source: fact.source }
    : missing(key);
}

export function numberFact(record: Record_, key: FieldKey): Fact<number> {
  const fact = record[key] ?? missing(key);
  if (!isKnown(fact)) return fact;
  return typeof fact.value === "number"
    ? { value: fact.value, source: fact.source }
    : missing(key);
}

type PinField = {
  /** Names the field for assistive technology and the reset button. */
  label: string;
  /** The button that supplies a missing value. */
  add: string;
  multiline: boolean;
  /** `Use auto` where the value falls back to a derived one, `Clear` where nothing stands in. */
  reset: "Use auto" | "Clear";
};

/** The rows a click can edit. A key not listed here is shown, never edited. */
export const PIN_FIELDS: Readonly<Record<FieldKey, PinField>> = {
  [KEY.title]: {
    label: "episode title",
    add: "Add a title",
    multiline: false,
    reset: "Use auto",
  },
  [KEY.intro]: {
    label: "episode intro",
    add: "Add a line about this episode",
    multiline: true,
    reset: "Clear",
  },
  [KEY.notes]: {
    label: "notes",
    add: "Add notes",
    multiline: true,
    reset: "Use auto",
  },
  [KEY.hosting]: {
    label: "hosting address",
    add: "Add address",
    multiline: false,
    reset: "Clear",
  },
};

const COMMAND_LABEL: Record<FeedCommand, string> = {
  export_episode: "Export episode",
  create_show: "Set up your show",
  link_show: "Choose a show",
  choose_art: "Choose artwork",
  write_feed: "Write",
};

/** The words on a fix's button. They live here so the wire carries none. */
export function fixLabel(fix: Fix): string {
  if (fix.kind === "command") return COMMAND_LABEL[fix.command];
  if (fix.kind === "input") return PIN_FIELDS[fix.key]?.add ?? "Add";
  return PIN_FIELDS[fix.edit.key]?.add ?? "Add";
}

/** The key a fix still needs a value for, so a click opens its editor instead of sending. */
export function needsInput(fix: Fix): FieldKey | null {
  return fix.kind === "input" ? fix.key : null;
}

export const AGENT_MARK = "Agent";

type Mark = (source: Resolved) => string | null;
const MARKS: { [K in Resolved["kind"]]: Mark } = {
  derived: () => "Auto",
  inherited: () => "From your show",
  measured: () => null,
  minted: () => null,
  pinned: (source) =>
    source.kind === "pinned" && source.by === "agent" ? AGENT_MARK : "Edited",
};

/** What a value says about itself. A measured or minted value is a fact, so it carries no mark. */
export function markOf(source: Resolved): string | null {
  return MARKS[source.kind](source);
}

export function isDrifted(fact: Fact<FieldValue> | undefined): boolean {
  return (
    fact !== undefined && fact.source.kind === "pinned" && fact.source.drifted
  );
}

export const DRIFT_COPY = "This changed since you edited it";

const SEVERITY_RANK: Record<Severity, number> = {
  blocker: 0,
  warn: 1,
  info: 2,
};

export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
}

export type Readiness =
  | { kind: "ready" }
  | { kind: "open"; left: number; first: Finding; blockers: number }
  | { kind: "check"; first: Finding };

/**
 * Info does not count toward what is left. An info finding on a pin whose
 * auto value changed still holds the strip back from "Ready to publish".
 */
export function readiness(view: FeedView): Readiness {
  const sorted = sortFindings(view.findings);
  const open = sorted.filter((f) => f.severity !== "info");
  if (open.length > 0)
    return {
      kind: "open",
      left: open.length,
      first: open[0],
      blockers: open.filter((f) => f.severity === "blocker").length,
    };
  const drift = sorted.find((f) => f.key && isDrifted(view.item[f.key]));
  return drift ? { kind: "check", first: drift } : { kind: "ready" };
}

/** What the Checks summary counts: findings to fix, else pins whose auto value changed. */
export function checksSummary(view: FeedView): string {
  const open = view.findings.filter((f) => f.severity !== "info").length;
  if (open > 0) return `${open} to fix`;
  const drift = view.findings.filter(
    (f) => f.key && isDrifted(view.item[f.key]),
  ).length;
  return drift > 0 ? `${drift} to check` : "All clear";
}

/** The strip's tone: only a blocker stops the feed, so warnings and drift read as a check, not a failure. */
export function readinessTone(state: Readiness): "blocker" | "warn" | "ok" {
  if (state.kind === "ready") return "ok";
  return state.kind === "open" && state.blockers > 0 ? "blocker" : "warn";
}

export function readinessTitle(state: Readiness): string {
  if (state.kind === "ready") return "Ready to publish";
  if (state.kind === "check") {
    const field = state.first.key ? PIN_FIELDS[state.first.key] : undefined;
    return `Check the ${field?.label ?? "listing"}`;
  }
  return thingsLeft(state.left);
}

export type WriteLine = {
  status: string;
  action: string | null;
  writing: boolean;
  /** Why Write and Copy feed item wait; undefined when they can run. */
  blockedReason: string | undefined;
};

export type FileLine = FeedView["file"] | WriteRequest;

const FILE_LINE: Record<FileLine, { status: string; action: string | null }> = {
  none: { status: "No feed file yet.", action: "Write feed file" },
  writing: { status: "Writing the feed file.", action: null },
  stale: { status: "Feed file is out of date.", action: "Write" },
  current: { status: "Feed file is up to date.", action: null },
  failed: { status: "Could not write the feed file.", action: "Try again" },
};

export const FILE_LINE_STATE: Record<FileLine, StatusState> = {
  none: "not-yet",
  writing: "running",
  stale: "needs-you",
  current: "done",
  failed: "failed",
};

export function writeLine(view: FeedView, request?: WriteRequest): WriteLine {
  const line = request ?? view.file;
  const state = readiness(view);
  const blockers = state.kind === "open" ? state.blockers : 0;
  return {
    ...FILE_LINE[line],
    writing: line === "writing",
    blockedReason:
      blockers === 0
        ? undefined
        : `Fix ${blockers === 1 ? "the blocker" : `the ${blockers} blockers`} first.`,
  };
}

const DATE = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
});

export function formatDate(iso: string): string {
  return DATE.format(new Date(iso));
}

const AUDIO_LABEL: Record<string, string> = {
  "audio/mpeg": "MP3",
  "audio/mp4": "M4A",
  "audio/x-m4a": "M4A",
};

export function audioLabel(mime: string): string {
  return AUDIO_LABEL[mime] ?? mime;
}

export function creditRoleLabel(role: string): string {
  return role === "host" ? "Host" : role === "guest" ? "Guest" : role;
}

/** The avatar hue is a rendering choice, so it comes from the name and never from the wire. */
export function colorIndexOf(name: string): number {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) % 8;
  return hash;
}

export type XmlLine = {
  id: number;
  segments: { id: number; text: string; tag: boolean }[];
};

/** The XML split into lines of markup and content. Text inside CDATA is content, so it is never tinted as markup. */
export function xmlLines(xml: string): XmlLine[] {
  let cdata = false;
  return xml.split("\n").map((line, id) => {
    const segments: XmlLine["segments"] = [];
    const push = (text: string, tag: boolean) => {
      if (text !== "") segments.push({ id: segments.length, text, tag });
    };
    for (const part of line.split(/(<!\[CDATA\[|\]\]>)/)) {
      if (part === "<![CDATA[" || part === "]]>") {
        cdata = part === "<![CDATA[";
        push(part, true);
      } else if (cdata) push(part, false);
      else
        for (const piece of part.split(/(<[^>]*>)/))
          push(piece, piece.startsWith("<"));
    }
    return { id, segments };
  });
}

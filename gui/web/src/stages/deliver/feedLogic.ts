import type {
  Credit,
  DriftSource,
  Fact,
  FeedView,
  Finding,
  Known,
  PinKey,
  Resolved,
  Severity,
} from "./feedView";

export function isKnown<T>(fact: Fact<T>): fact is Known<T> {
  return fact.source.kind !== "pending";
}

type PinField = {
  /** Names the field for assistive technology and the reset button. */
  label: string;
  multiline: boolean;
  /** `Use auto` where the value falls back to a derived one, `Clear` where nothing stands in. */
  reset: "Use auto" | "Clear";
};

export const PIN_FIELDS: Record<PinKey, PinField> = {
  "item.title": { label: "episode title", multiline: false, reset: "Use auto" },
  "item.intro": { label: "episode intro", multiline: true, reset: "Clear" },
  "item.notes": { label: "show notes", multiline: true, reset: "Use auto" },
  "item.enclosure.url": {
    label: "hosting address",
    multiline: false,
    reset: "Clear",
  },
};

/** Auto values say so where a click would pin them. A person's own pin carries no mark. */
export function markOf(source: Resolved): "Auto" | "Agent" | null {
  if (source.kind !== "pinned") return "Auto";
  return source.by === "agent" ? "Agent" : null;
}

const DRIFT_LABEL: Record<DriftSource, string> = {
  chapters: "Chapters",
  speakers: "Speakers",
  soundbites: "Soundbites",
  transcript: "Transcripts",
};

export function driftCopy(source: DriftSource): string {
  return `${DRIFT_LABEL[source]} changed since you edited this`;
}

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
  | { kind: "open"; left: number; first: Finding; blockers: number };

/** Info never counts: it names optional tags that are absent. */
export function readiness(findings: readonly Finding[]): Readiness {
  const open = sortFindings(findings).filter((f) => f.severity !== "info");
  if (open.length === 0) return { kind: "ready" };
  return {
    kind: "open",
    left: open.length,
    first: open[0],
    blockers: open.filter((f) => f.severity === "blocker").length,
  };
}

export function readinessTitle(state: Readiness): string {
  if (state.kind === "ready") return "Ready to publish";
  return `${state.left} ${state.left === 1 ? "thing" : "things"} left`;
}

export type WriteLine = {
  status: string;
  action: string | null;
  /** Why Write and Copy item wait; undefined when they can run. */
  blockedReason: string | undefined;
};

export function writeLine(view: FeedView): WriteLine {
  const state = readiness(view.findings);
  const blockers = state.kind === "open" ? state.blockers : 0;
  return {
    status: {
      none: "No feed file yet.",
      stale: "Feed file is out of date.",
      current: "Feed file is up to date.",
    }[view.file],
    action: { none: "Write feed file", stale: "Write", current: null }[
      view.file
    ],
    blockedReason:
      blockers === 0
        ? undefined
        : `Fix ${blockers === 1 ? "the blocker" : `the ${blockers} blockers`} first.`,
  };
}

const MINUTE = 60;
const HOUR = 3600;

export function formatDuration(seconds: number): string {
  if (seconds < HOUR) return `${Math.max(1, Math.round(seconds / MINUTE))} min`;
  const hours = Math.floor(seconds / HOUR);
  const minutes = Math.round((seconds % HOUR) / MINUTE);
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
}

/** The stamp a podcast app prints beside a chapter: 5:12, or 1:05:09 past the hour. */
export function formatStamp(seconds: number): string {
  const whole = Math.floor(Math.max(0, seconds));
  const h = Math.floor(whole / HOUR);
  const m = Math.floor((whole % HOUR) / MINUTE);
  const s = String(whole % MINUTE).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
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

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function roleLabel(role: Credit["role"]): string {
  return role === "host" ? "Host" : "Guest";
}

export type XmlLine = {
  id: number;
  segments: { id: number; text: string; tag: boolean }[];
};

/** The XML split into lines of markup and content, so the view can tint them apart. */
export function xmlLines(xml: string): XmlLine[] {
  return xml.split("\n").map((line, id) => ({
    id,
    segments: line
      .split(/(<[^>]*>)/)
      .filter((text) => text !== "")
      .map((text, at) => ({ id: at, text, tag: text.startsWith("<") })),
  }));
}

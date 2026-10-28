import type { CSSProperties } from "react";
import type { LaneMarker } from "./MarkerLane";

export const EPISODE_SECONDS = 3130;

export const stage: CSSProperties = {
  boxSizing: "border-box",
  inlineSize: "100%",
  padding: "var(--space-5) var(--space-5) var(--space-6)",
};

export const ALL_KINDS: readonly LaneMarker[] = [
  { kind: "chapter", id: "ch-open", start: 1, title: "Cold open" },
  { kind: "comment", id: "cm-maya", start: 9, author: "Maya" },
  { kind: "comment", id: "cm-anneke", start: 14, end: 19.5, author: "Anneke" },
  { kind: "chapter", id: "ch-interview", start: 24, title: "Interview" },
  { kind: "clip", id: "sc-joke", start: 30, end: 42, title: "Best joke" },
  {
    kind: "clip",
    id: "sc-intro",
    start: 46,
    end: 55,
    title: "Tight intro",
    proposed: true,
  },
];

export const DENSE: readonly LaneMarker[] = [
  { kind: "chapter", id: "d-ch1", start: 2, title: "Intro" },
  { kind: "comment", id: "d-c1", start: 20, author: "Maya" },
  { kind: "comment", id: "d-c2", start: 20.6, author: "Anneke" },
  { kind: "comment", id: "d-c3", start: 21.1, author: "Ravi" },
  { kind: "comment", id: "d-c4", start: 21.5, author: "Maya" },
  { kind: "chapter", id: "d-ch2", start: 22, title: "The long middle" },
  { kind: "clip", id: "d-s1", start: 22.5, end: 26, title: "Quote" },
  { kind: "comment", id: "d-c5", start: 24, end: 27, author: "Ravi" },
  { kind: "comment", id: "d-c6", start: 30, author: "Anneke" },
  { kind: "comment", id: "d-c7", start: 31, author: "Maya" },
  { kind: "chapter", id: "d-ch3", start: 40, title: "Outro" },
  {
    kind: "clip",
    id: "d-s2",
    start: 46,
    end: 58,
    title: "Teaser",
    proposed: true,
  },
];

/** A lane wider than 1024 px at 6 px/s: a chapter inside a clip, and a pin, past x = 1024. */
export const WIDE: readonly LaneMarker[] = [
  { kind: "clip", id: "w-clip", start: 120, end: 270, title: "Wide clip" },
  { kind: "chapter", id: "w-ch1", start: 180, title: "Third minute" },
  { kind: "comment", id: "w-c1", start: 210, author: "Maya" },
  { kind: "chapter", id: "w-ch2", start: 240, title: "Fourth minute" },
];

/** Markers inside a clip and inside a range comment, which stand on their span at any zoom. */
export const NESTED: readonly LaneMarker[] = [
  { kind: "clip", id: "n-clip", start: 30, end: 200, title: "Long clip" },
  { kind: "chapter", id: "n-ch", start: 100, title: "Inside chapter" },
  { kind: "comment", id: "n-c", start: 150, author: "Maya" },
  { kind: "comment", id: "n-r", start: 210, end: 260, author: "Anneke" },
  { kind: "chapter", id: "n-ch2", start: 230, title: "Inside range" },
];

/** A clip with a pin on its start glyph, so a "+1" chip sits on the clip's start. */
export const STACKED_START: readonly LaneMarker[] = [
  { kind: "clip", id: "s-clip", start: 30, end: 200, title: "Long clip" },
  { kind: "comment", id: "s-c", start: 33, author: "Maya" },
];

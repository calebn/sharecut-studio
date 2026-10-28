import type { CSSProperties } from "react";
import type { LaneMarker } from "./MarkerLane";

/** 52:10, the episode every ruler and lane story edits. */
export const EPISODE_SECONDS = 3130;

export const stage: CSSProperties = {
  boxSizing: "border-box",
  inlineSize: "100%",
  padding: "var(--space-5) var(--space-5) var(--space-6)",
};

/** The marker lane's fixture: every kind, spaced so each reads in a minute-wide window. */
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

/** Fourteen markers inside twenty seconds: at a minute-wide window most fold into "+N" chips. */
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

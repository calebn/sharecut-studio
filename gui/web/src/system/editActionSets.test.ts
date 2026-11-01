import { describe, expect, it } from "vitest";
import type { EditFacts } from "../edit/editSelection";
import {
  ACTION_SETS,
  type BarId,
  barDisplay,
  EDIT_ORDER,
  type ResolvedBar,
  resolveBar,
} from "./editActionSets";
import { iconOf, verbOf } from "./verbDisplay";
import { VERBS, type VerbId } from "./verbs";

const facts = (over: Partial<EditFacts>): EditFacts => ({
  kind: "playhead",
  count: 1,
  span: null,
  holdsCut: false,
  hasGap: false,
  suggestedAction: null,
  commentResolved: false,
  clipboardHasAudio: false,
  role: "host",
  ...over,
});

const matrix: [string, Partial<EditFacts>, ResolvedBar][] = [
  [
    "words over a cut",
    { kind: "words", count: 2, holdsCut: true },
    {
      leading: "scope",
      bar: [
        "hear",
        "keep",
        "split",
        "comment",
        "fixText",
        "record",
        "more",
        "inspect",
      ],
      more: ["mute", "moveToSpeaker", "copy"],
      primary: "cut",
    },
  ],
  [
    "live words",
    { kind: "words" },
    {
      leading: "scope",
      bar: ["hear", "split", "comment", "fixText", "record", "more", "inspect"],
      more: ["mute", "moveToSpeaker", "copy"],
      primary: "cut",
    },
  ],
  [
    "words, editor guest",
    { kind: "words", role: "editor" },
    {
      leading: "scope",
      bar: ["hear", "split", "comment", "fixText", "more", "inspect"],
      more: ["mute", "moveToSpeaker", "copy"],
      primary: "cut",
    },
  ],
  [
    "range",
    { kind: "range" },
    {
      leading: "scope",
      bar: ["hear", "split", "comment", "record", "export", "more", "inspect"],
      more: ["mute", "moveToSpeaker", "copy"],
      primary: "cut",
    },
  ],
  [
    "range over a gap",
    { kind: "range", hasGap: true },
    {
      leading: "scope",
      bar: ["hear", "split", "comment", "record", "export", "more", "inspect"],
      more: ["mute", "fillRoomTone", "moveToSpeaker", "copy"],
      primary: "cut",
    },
  ],
  [
    "clip",
    { kind: "clip" },
    {
      leading: null,
      bar: ["hear", "split", "comment", "cut", "more", "inspect"],
      more: ["mute", "gain", "fade", "moveToTrack"],
      primary: null,
    },
  ],
  [
    "three clips",
    { kind: "clip", count: 3 },
    {
      leading: "count",
      bar: ["hear", "split", "comment", "cut", "more", "inspect"],
      more: ["mute", "gain", "fade", "moveToTrack"],
      primary: null,
    },
  ],
  [
    "cut seam",
    { kind: "seam", holdsCut: true },
    {
      leading: null,
      bar: ["hear", "keep", "comment", "more", "inspect"],
      more: ["joinType"],
      primary: null,
    },
  ],
  [
    "cut suggestion",
    { kind: "suggestion", suggestedAction: "cut" },
    {
      leading: null,
      bar: ["hearBefore", "hearAfter", "keep", "comment", "more", "inspect"],
      more: ["adjustBounds"],
      primary: "cut",
    },
  ],
  [
    "sound suggestion",
    { kind: "suggestion", suggestedAction: "lower" },
    {
      leading: null,
      bar: ["hearBefore", "hearAfter", "keep", "comment", "more", "inspect"],
      more: ["adjustBounds"],
      primary: "lower",
    },
  ],
  [
    "suggestion to leave alone",
    { kind: "suggestion", suggestedAction: "leave" },
    {
      leading: null,
      bar: ["hearBefore", "hearAfter", "keep", "comment", "more", "inspect"],
      more: ["adjustBounds"],
      primary: null,
    },
  ],
  [
    "pause suggestion",
    { kind: "suggestion", suggestedAction: "shorten" },
    {
      leading: null,
      bar: ["hearBefore", "hearAfter", "keep", "comment", "more", "inspect"],
      more: ["adjustBounds"],
      primary: "shorten",
    },
  ],
  [
    "suggestion with no default",
    { kind: "suggestion" },
    {
      leading: null,
      bar: ["hearBefore", "hearAfter", "keep", "comment", "more", "inspect"],
      more: ["adjustBounds"],
      primary: null,
    },
  ],
  [
    "open comment",
    { kind: "comment" },
    {
      leading: null,
      bar: ["comment", "remove", "inspect"],
      more: [],
      primary: "resolve",
    },
  ],
  [
    "resolved comment",
    { kind: "comment", commentResolved: true },
    {
      leading: null,
      bar: ["comment", "remove", "inspect"],
      more: [],
      primary: null,
    },
  ],
  [
    "chapter",
    { kind: "chapter" },
    {
      leading: null,
      bar: ["hear", "fixText", "remove", "inspect"],
      more: [],
      primary: null,
    },
  ],
  [
    "social clip",
    { kind: "social" },
    {
      leading: null,
      bar: ["hear", "comment", "fixText", "remove", "inspect"],
      more: [],
      primary: "approve",
    },
  ],
  [
    "track",
    { kind: "track" },
    {
      leading: null,
      bar: ["hear", "remove", "more", "inspect"],
      more: ["mute"],
      primary: null,
    },
  ],
  [
    "two tracks",
    { kind: "track", count: 2 },
    {
      leading: "count",
      bar: ["hear", "remove", "more", "inspect"],
      more: ["mute"],
      primary: null,
    },
  ],
  [
    "envelope line",
    { kind: "envelope" },
    { leading: null, bar: ["inspect"], more: [], primary: null },
  ],
  [
    "applied mute or trim",
    { kind: "appliedEdge" },
    {
      leading: null,
      bar: ["hear", "comment", "inspect"],
      more: [],
      primary: null,
    },
  ],
  [
    "envelope point",
    { kind: "envelopePoint" },
    {
      leading: null,
      bar: ["hear", "remove", "inspect"],
      more: [],
      primary: null,
    },
  ],
  [
    "bleed region",
    { kind: "bleed" },
    {
      leading: null,
      bar: ["hearBefore", "hearAfter", "keep", "inspect"],
      more: [],
      primary: null,
    },
  ],
  [
    "playhead",
    { kind: "playhead", count: 0 },
    {
      leading: null,
      bar: ["split", "addChapter", "record"],
      more: [],
      primary: null,
    },
  ],
  [
    "playhead with audio on the clipboard",
    { kind: "playhead", count: 0, clipboardHasAudio: true },
    {
      leading: null,
      bar: ["split", "addChapter", "record", "paste"],
      more: [],
      primary: null,
    },
  ],
  [
    "playhead, editor guest",
    { kind: "playhead", count: 0, role: "editor", clipboardHasAudio: true },
    {
      leading: null,
      bar: ["split", "addChapter", "paste"],
      more: [],
      primary: null,
    },
  ],
  [
    "words, read-only guest",
    { kind: "words", role: "readOnly", holdsCut: true },
    { leading: null, bar: ["hear", "comment"], more: [], primary: null },
  ],
  [
    "open comment, read-only guest",
    { kind: "comment", role: "readOnly" },
    { leading: null, bar: ["hear", "comment"], more: [], primary: null },
  ],
];

describe("resolveBar", () => {
  it.each(matrix)("%s", (_name, over, expected) => {
    expect(resolveBar(facts(over))).toEqual(expected);
  });
});

describe("EDIT_ORDER", () => {
  it("is the element 7 sequence, literally", () => {
    expect([...EDIT_ORDER]).toEqual([
      "hear",
      "hearBefore",
      "hearAfter",
      "keep",
      "split",
      "addChapter",
      "comment",
      "fixText",
      "record",
      "paste",
      "export",
      "cut",
      "remove",
      "more",
      "inspect",
    ]);
  });

  it("holds the element 7 verb sequence in order", () => {
    const spec = [
      "hear",
      "keep",
      "split",
      "comment",
      "fixText",
      "record",
      "export",
      "remove",
      "more",
      "inspect",
    ];
    expect(EDIT_ORDER.filter((id) => spec.includes(id))).toEqual(spec);
  });
});

describe("ACTION_SETS", () => {
  const ids = Object.values(ACTION_SETS)
    .flatMap((set) => [...set.bar, ...set.more])
    .map((rule) => rule.id);
  const verbIds = new Set<string>(VERBS.map((verb) => verb.id));

  it("places every bar id in the element 7 order", () => {
    const inBar = Object.values(ACTION_SETS).flatMap((set) =>
      set.bar.map((rule) => rule.id),
    );
    expect(inBar.filter((id) => !EDIT_ORDER.includes(id))).toEqual([]);
  });

  it("keeps Remove off an audio clip and Solo out of every set", () => {
    expect(ACTION_SETS.clip.bar.map((rule) => rule.id)).not.toContain("remove");
    expect(ids).not.toContain("solo");
  });

  it("names only ids the bar can draw", () => {
    for (const id of ids) {
      expect(barDisplay(id as BarId).label).not.toBe("");
    }
  });

  it("gives every verb but the A/B pair an icon", () => {
    const bare = ids.filter(
      (id) => verbIds.has(id) && verbOf(id as VerbId).icon === null,
    );
    expect([...new Set(bare)].sort()).toEqual(["hearAfter", "hearBefore"]);
    expect(iconOf("cut")).toBe("scissors");
  });
});

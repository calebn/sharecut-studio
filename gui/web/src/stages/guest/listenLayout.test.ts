import { describe, expect, it } from "vitest";
import {
  type ListenInput,
  type ListenLayout,
  listenLayoutOf,
  listenScriptOf,
  nearestBefore,
} from "./listenLayout";

const BASE: ListenInput = {
  mayComment: true,
  script: "ready",
  counts: { comments: 15, suggestions: 0 },
  hasChapters: true,
  needsAttention: false,
  draft: null,
};
const DRAFT = { startSec: 86, endSec: null };

const CASES: [name: string, input: ListenInput, layout: ListenLayout][] = [
  [
    "a Commenter with comments reads the transcript and a count row",
    BASE,
    {
      middle: { kind: "script" },
      bottom: {
        kind: "row",
        label: "15 comments",
        comments: 15,
        afterCount: "comments",
      },
    },
  ],
  [
    "a draft takes the bottom for the composer",
    { ...BASE, draft: DRAFT },
    { middle: { kind: "script" }, bottom: { kind: "composer" } },
  ],
  [
    "no comments leaves the bottom empty",
    { ...BASE, counts: { comments: 0, suggestions: 0 } },
    { middle: { kind: "script" }, bottom: { kind: "none" } },
  ],
  [
    "one comment is singular",
    { ...BASE, counts: { comments: 1, suggestions: 0 } },
    {
      middle: { kind: "script" },
      bottom: {
        kind: "row",
        label: "1 comment",
        comments: 1,
        afterCount: "comment",
      },
    },
  ],
  [
    "suggestions join the label",
    { ...BASE, counts: { comments: 15, suggestions: 2 } },
    {
      middle: { kind: "script" },
      bottom: {
        kind: "row",
        label: "15 comments · 2 suggestions",
        comments: 15,
        afterCount: "comments · 2 suggestions",
      },
    },
  ],
  [
    "a Viewer with a Script: the Script in the middle, no composer",
    { ...BASE, mayComment: false, draft: DRAFT },
    {
      middle: { kind: "script" },
      bottom: {
        kind: "row",
        label: "15 comments",
        comments: 15,
        afterCount: "comments",
      },
    },
  ],
  [
    "a refused edit and nothing else",
    {
      ...BASE,
      counts: { comments: 0, suggestions: 0 },
      needsAttention: true,
    },
    {
      middle: { kind: "script" },
      bottom: {
        kind: "row",
        label: "Needs attention",
        comments: 0,
        afterCount: "comments · Needs attention",
      },
    },
  ],
  [
    "comments and a refused edit",
    { ...BASE, counts: { comments: 2, suggestions: 0 }, needsAttention: true },
    {
      middle: { kind: "script" },
      bottom: {
        kind: "row",
        label: "2 comments · Needs attention",
        comments: 2,
        afterCount: "comments · Needs attention",
      },
    },
  ],
  [
    "only suggestions",
    { ...BASE, counts: { comments: 0, suggestions: 1 } },
    {
      middle: { kind: "script" },
      bottom: {
        kind: "row",
        label: "1 suggestion",
        comments: 0,
        afterCount: "comments · 1 suggestion",
      },
    },
  ],
  [
    "a pending transcript still holds the middle",
    { ...BASE, script: "pending" },
    {
      middle: { kind: "script" },
      bottom: {
        kind: "row",
        label: "15 comments",
        comments: 15,
        afterCount: "comments",
      },
    },
  ],
  [
    "a Viewer with chapters reads the chapter list",
    { ...BASE, mayComment: false, script: "none" },
    {
      middle: { kind: "chapters" },
      bottom: {
        kind: "row",
        label: "15 comments",
        comments: 15,
        afterCount: "comments",
      },
    },
  ],
  [
    "a Viewer with neither chapters nor comments gets the Cover",
    {
      ...BASE,
      mayComment: false,
      script: "none",
      hasChapters: false,
      counts: { comments: 0, suggestions: 0 },
    },
    { middle: { kind: "empty" }, bottom: { kind: "none" } },
  ],
  [
    "a link that may not comment never gets the composer",
    { ...BASE, mayComment: false, script: "none", draft: DRAFT },
    {
      middle: { kind: "chapters" },
      bottom: {
        kind: "row",
        label: "15 comments",
        comments: 15,
        afterCount: "comments",
      },
    },
  ],
  [
    "a Viewer whose link carries the transcript reads it, and never gets the composer",
    { ...BASE, mayComment: false, script: "ready", draft: DRAFT },
    {
      middle: { kind: "script" },
      bottom: {
        kind: "row",
        label: "15 comments",
        comments: 15,
        afterCount: "comments",
      },
    },
  ],
  [
    "a Commenter link without the comment capability never gets the composer",
    { ...BASE, mayComment: false, draft: DRAFT },
    {
      middle: { kind: "script" },
      bottom: {
        kind: "row",
        label: "15 comments",
        comments: 15,
        afterCount: "comments",
      },
    },
  ],
  [
    "a Commenter whose link has no transcript falls back to chapters",
    { ...BASE, script: "none" },
    {
      middle: { kind: "chapters" },
      bottom: {
        kind: "row",
        label: "15 comments",
        comments: 15,
        afterCount: "comments",
      },
    },
  ],
];

describe("listenLayoutOf", () => {
  it.each(CASES)("%s", (_name, input, layout) => {
    expect(listenLayoutOf(input)).toEqual(layout);
  });
});

describe("nearestBefore", () => {
  const items = [{ at: 3 }, { at: 10 }, { at: 12 }, { at: 40 }];

  it.each([
    [13, 15, { at: 12 }],
    [5, 15, { at: 3 }],
    [12, 15, { at: 12 }],
    [30, 15, null],
    [2, 15, null],
    [20, 5, null],
  ])("at %s with a %s s window gives %j", (playhead, window, expected) => {
    expect(nearestBefore(items, playhead, window)).toEqual(expected);
  });

  it("gives null for no items", () => {
    expect(nearestBefore([], 10, 15)).toBeNull();
  });
});

describe("listenScriptOf", () => {
  it.each([
    [false, "ready", true, "ready"],
    [false, "ready", false, "none"],
    [false, "hidden", true, "none"],
    [false, "pending", false, "pending"],
    [false, "failed", true, "failed"],
    [true, "ready", true, "failed"],
    [true, "hidden", false, "failed"],
  ] as const)(
    "load failure %s, detail %s, transcript %s gives %s",
    (loadFailed, detail, hasTranscript, expected) => {
      expect(listenScriptOf({ loadFailed, detail, hasTranscript })).toBe(
        expected,
      );
    },
  );
});

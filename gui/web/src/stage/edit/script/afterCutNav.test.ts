import { beforeEach, describe, expect, it } from "vitest";
import { afterCutPick } from "../../../commands/afterCutHost";
import type { AfterCut } from "../../../state/afterCutSlice";
import { minimalProject, sampleTrack } from "../../../test/fixtures";
import { scriptUtterance, scriptWord } from "../../../test/scriptHostKit";
import type { ProjectView } from "../../../types/project";
import { registerAfterCutNav } from "./afterCutNav";

const project = (): ProjectView =>
  minimalProject({
    tracks: [
      sampleTrack({ id: "host", speaker: "Maya" }),
      sampleTrack({ id: "guest", speaker: "Anneke" }),
    ],
    transcript: {
      utterances: [
        scriptUtterance("host", "Maya", [
          scriptWord("you", 0, 10),
          scriptWord("know", 1, 10.5),
          scriptWord("so", 2, 11),
          scriptWord("you", 3, 12),
          scriptWord("know", 4, 12.5),
          scriptWord("you", 5, 13, {
            mappable: false,
            timeline_start: null,
            timeline_end: null,
          }),
          scriptWord("know", 6, 13.5, {
            mappable: false,
            timeline_start: null,
            timeline_end: null,
          }),
        ]),
        scriptUtterance("guest", "Anneke", [
          scriptWord("you", 0, 20),
          scriptWord("know", 1, 20.5),
        ]),
      ],
    },
  });

const cut = (extra: Partial<AfterCut> = {}): AfterCut => ({
  words: "you know",
  cutKeys: ["host::0", "host::1"],
  from: { trackId: "host", sourceId: null, wordIndex: 0 },
  head: null,
  baseHead: null,
  epoch: 1,
  focused: true,
  selected: null,
  at: null,
  startedAt: null,
  direction: null,
  ...extra,
});

const at = (trackId: string, wordIndex: number) => ({
  trackId,
  sourceId: null,
  wordIndex,
});

beforeEach(registerAfterCutNav);

describe("after-cut navigation", () => {
  it("picks the next hit in script order, skipping cut words and words already cut away", () => {
    const pick = afterCutPick(project(), cut(), "next");
    expect(pick?.at).toEqual(at("host", 3));
    expect(pick?.selection).toMatchObject({
      trackId: "host",
      startWordIndex: 3,
      endWordIndex: 4,
    });
    expect([pick?.ordinal, pick?.total]).toEqual([1, 2]);
  });

  it("goes on from the visited hit and wraps at the end", () => {
    const next = afterCutPick(
      project(),
      cut({ at: at("host", 3), startedAt: at("host", 3), direction: "next" }),
      "next",
    );
    expect(next?.at).toEqual(at("guest", 0));
    expect(
      afterCutPick(
        project(),
        cut({ at: at("guest", 0), direction: "next" }),
        "next",
      )?.at,
    ).toEqual(at("host", 3));
  });

  it("goes backward and wraps before the first", () => {
    expect(afterCutPick(project(), cut(), "prev")?.at).toEqual(at("guest", 0));
    expect(
      afterCutPick(
        project(),
        cut({ at: at("host", 3), direction: "prev" }),
        "prev",
      )?.at,
    ).toEqual(at("guest", 0));
  });

  it("stops when the walk would return to where it started", () => {
    expect(
      afterCutPick(
        project(),
        cut({
          at: at("guest", 0),
          startedAt: at("host", 3),
          direction: "next",
        }),
        "next",
      ),
    ).toBeNull();
  });

  it("allows turning back toward the start", () => {
    expect(
      afterCutPick(
        project(),
        cut({
          at: at("guest", 0),
          startedAt: at("host", 3),
          direction: "next",
        }),
        "prev",
      )?.at,
    ).toEqual(at("host", 3));
  });

  it("finds nothing when no other occurrence is left", () => {
    expect(
      afterCutPick(
        project(),
        cut({ words: "so", cutKeys: ["host::2"] }),
        "next",
      ),
    ).toBeNull();
  });

  it("leaves out a hit that has a word without an index and never joins words of two sources", () => {
    const spanning = minimalProject({
      tracks: [
        sampleTrack({ id: "host", speaker: "Maya" }),
        sampleTrack({ id: "guest", speaker: "Anneke" }),
      ],
      transcript: {
        utterances: [
          scriptUtterance("host", "Maya", [
            scriptWord("so", 0, 10),
            scriptWord("you", 1, 10.5),
          ]),
          scriptUtterance(
            "host",
            "Maya",
            [scriptWord("know", 2, 11), scriptWord("you", 3, 12)],
            { source_id: "other" },
          ),
          scriptUtterance("host", "Maya", [
            scriptWord("know", undefined as never, 12.5),
          ]),
          scriptUtterance("guest", "Anneke", [
            scriptWord("you", 0, 20),
            scriptWord("know", 1, 20.5),
          ]),
        ],
      },
    });
    const pick = afterCutPick(spanning, cut({ cutKeys: ["host::9"] }), "next");
    expect(pick?.at).toEqual(at("guest", 0));
    expect([pick?.ordinal, pick?.total]).toEqual([1, 1]);
  });
});

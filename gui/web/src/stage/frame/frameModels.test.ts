import { describe, expect, it } from "vitest";
import { pipelineJobSnapshot } from "../../test/fixtures";
import {
  auditionOf,
  chapterIndexAt,
  cutsLabel,
  hearModeOf,
  playerChapters,
  playerTicks,
  sortChapters,
} from "./playerModel";
import { saveIndicatorOf } from "./useSaveIndicator";
import { stageBadges } from "./useStageBadges";

const idle = {
  pipelineJob: null,
  activityJob: null,
  pendingReviewCount: 0,
  openCommentCount: 0,
};

describe("stageBadges", () => {
  it("says nothing when nothing waits", () => {
    expect(stageBadges(idle)).toEqual({});
  });

  it("marks Prepare while a job runs and when the last one failed", () => {
    expect(
      stageBadges({
        ...idle,
        pipelineJob: pipelineJobSnapshot({ status: "running" }),
      }),
    ).toEqual({ prepare: { kind: "running" } });
    expect(
      stageBadges({
        ...idle,
        pipelineJob: pipelineJobSnapshot({ status: "error" }),
      }),
    ).toEqual({ prepare: { kind: "failed" } });
  });

  it("counts pending edits and open comments on Review", () => {
    expect(
      stageBadges({ ...idle, pendingReviewCount: 2, openCommentCount: 3 }),
    ).toEqual({ review: { kind: "needs-you", count: 5 } });
  });
});

describe("saveIndicatorOf", () => {
  const button = { kind: "button", activate: () => undefined } as const;

  it("maps each save state to the header indicator", () => {
    expect(saveIndicatorOf({ kind: "saving" }, button)).toEqual({
      state: "saving",
    });
    expect(saveIndicatorOf({ kind: "saved" }, button, true)).toEqual({
      state: "saved",
      justSaved: true,
    });
    expect(saveIndicatorOf({ kind: "waiting", count: 2 }, button)).toEqual({
      state: "offline",
      waiting: 2,
    });
  });

  it("sends Retry to the Needs attention banner, and offers none when it is passive", () => {
    const failed = saveIndicatorOf(
      { kind: "failed", cause: "unreadable" },
      button,
    );
    expect(failed).toMatchObject({ state: "failed", onRetry: button.activate });
    expect(
      saveIndicatorOf(
        { kind: "failed", cause: "unreadable" },
        { kind: "passive" },
      ),
    ).toMatchObject({ state: "failed", onRetry: undefined });
  });
});

describe("player model", () => {
  it("maps the audition modes to the hear menu's words and back", () => {
    expect(["mix", "fx", "raw"].map((m) => hearModeOf(m as "mix"))).toEqual([
      "mix",
      "edited",
      "original",
    ]);
    expect((["mix", "edited", "original"] as const).map(auditionOf)).toEqual([
      "mix",
      "fx",
      "raw",
    ]);
  });

  it("shows the cuts delta only once something was cut", () => {
    expect(cutsLabel(0)).toBeUndefined();
    expect(cutsLabel(250)).toBe("−4:10");
  });

  it("orders chapters, finds the one the playhead is in, and ticks them", () => {
    const markers = [
      { time: 30, title: "Second" },
      { time: 0, title: "First" },
    ];
    const chapters = playerChapters(sortChapters(markers), 60);
    expect(chapters.map((c) => [c.title, c.time, c.at])).toEqual([
      ["First", "0:00", 0],
      ["Second", "0:30", 0.5],
    ]);
    expect(chapterIndexAt(sortChapters(markers), 10)).toBe(0);
    expect(chapterIndexAt(sortChapters(markers), 45)).toBe(1);
    expect(chapterIndexAt([{ time: 5, title: "Late" }], 1)).toBeUndefined();
    expect(playerTicks(chapters, [15], 60)).toEqual([
      { at: 0, kind: "chapter" },
      { at: 0.5, kind: "chapter" },
      { at: 0.25, kind: "comment" },
    ]);
  });
});

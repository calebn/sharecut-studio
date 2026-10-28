import { describe, expect, it } from "vitest";
import {
  type TakeInput,
  takeLine,
  takeRow,
  takesTrayModel,
} from "./takesTrayModel";

const JON = { name: "Jon", colorIndex: 3 };
const MAYA = { name: "Maya Okafor", colorIndex: 0 };

const take = (rest: Partial<TakeInput> = {}): TakeInput => ({
  id: "t1",
  number: 1,
  lengthSec: 872,
  people: [
    { person: MAYA, line: { kind: "saved" } },
    { person: JON, line: { kind: "saved" } },
  ],
  ...rest,
});

describe("takeLine", () => {
  it("says Saved, with the clips when there are some", () => {
    expect(takeLine({ person: JON, line: { kind: "saved" } }).detail).toBe(
      "Saved",
    );
    expect(
      takeLine({
        person: JON,
        line: { kind: "saved" },
        clipTimes: ["02:14", "05:40", "09:02"],
      }).detail,
    ).toBe("Saved · Clipped 3 times · 02:14, 05:40, 09:02");
    expect(
      takeLine({
        person: JON,
        line: { kind: "saved" },
        clipTimes: ["02:14"],
      }).detail,
    ).toBe("Saved · Clipped 1 time · 02:14");
  });

  it("says when later clipping went unrecorded", () => {
    expect(
      takeLine({
        person: JON,
        line: { kind: "saved" },
        clipTimes: ["02:14"],
        clipTruncated: true,
      }).detail,
    ).toBe("Saved · Clipped 1 time · 02:14 · later clipping not recorded");
  });

  it("shows saving as a percent with a progress value", () => {
    expect(
      takeLine({ person: JON, line: { kind: "saving", done: 2, total: 5 } }),
    ).toMatchObject({ state: "running", detail: "Saving 40%", progress: 0.4 });
  });

  it("holds an empty or overfull saving total to 0..100%", () => {
    expect(
      takeLine({ person: JON, line: { kind: "saving", done: 1, total: 0 } })
        .detail,
    ).toBe("Saving 0%");
    expect(
      takeLine({ person: JON, line: { kind: "saving", done: 9, total: 3 } })
        .detail,
    ).toBe("Saving 100%");
  });

  it("names who an offline person is waiting for", () => {
    expect(takeLine({ person: JON, line: { kind: "offline" } })).toMatchObject({
      state: "queued",
      detail: "Waiting for Jon to come back online",
      retry: false,
    });
  });

  it("offers Retry only when the landing failed", () => {
    expect(
      takeLine({ person: JON, line: { kind: "land-failed" } }),
    ).toMatchObject({
      state: "failed",
      detail: "Couldn't add to the timeline",
      retry: true,
    });
  });
});

describe("takeRow", () => {
  it("is done and can be heard when everyone saved", () => {
    expect(takeRow(take())).toMatchObject({
      title: "Take 1",
      detail: "14:32 · 2 people",
      state: "done",
      hear: true,
    });
  });

  it("names each person who clipped on the row, and says nothing for a clean take", () => {
    expect(
      takeRow(
        take({
          people: [
            { person: MAYA, line: { kind: "saved" }, clipTimes: ["00:05"] },
            {
              person: JON,
              line: { kind: "saved" },
              clipTimes: ["02:14", "05:40", "09:02"],
            },
          ],
        }),
      ).detail,
    ).toBe(
      "14:32 · 2 people · Maya Okafor clipped 1 time, Jon clipped 3 times",
    );
    expect(takeRow(take()).detail).toBe("14:32 · 2 people");
  });

  it("keeps the live take's row free of the clipping summary", () => {
    expect(
      takeRow(
        take({
          live: true,
          people: [
            { person: JON, line: { kind: "saved" }, clipTimes: ["00:05"] },
          ],
        }),
      ).detail,
    ).toBe("Recording · 14:32 · 1 person");
  });

  it("is running with the mean progress while anyone is saving", () => {
    const row = takeRow(
      take({
        people: [
          { person: MAYA, line: { kind: "saved" } },
          { person: JON, line: { kind: "saving", done: 1, total: 4 } },
        ],
      }),
    );
    expect(row.state).toBe("running");
    expect(row.progress).toBeCloseTo(0.625);
    expect(row.hear).toBe(false);
  });

  it("waits on an offline person once no one is saving", () => {
    const row = takeRow(
      take({
        people: [
          { person: MAYA, line: { kind: "saved" } },
          { person: JON, line: { kind: "offline" } },
        ],
      }),
    );
    expect(row.state).toBe("queued");
    expect(row.hear).toBe(false);
  });

  it("fails when any landing failed, even with others still saving", () => {
    const row = takeRow(
      take({
        people: [
          { person: MAYA, line: { kind: "land-failed" } },
          { person: JON, line: { kind: "saving", done: 1, total: 2 } },
        ],
      }),
    );
    expect(row.state).toBe("failed");
    expect(row.hear).toBe(false);
  });

  it("describes the live take as recording and cannot be heard yet", () => {
    const row = takeRow(take({ live: true, lengthSec: 61 }));
    expect(row).toMatchObject({
      state: "running",
      detail: "Recording · 1:01 · 2 people",
      hear: false,
    });
    expect(row.progress).toBeUndefined();
  });

  it("counts one person in the singular", () => {
    expect(
      takeRow(take({ people: [{ person: MAYA, line: { kind: "saved" } }] }))
        .detail,
    ).toBe("14:32 · 1 person");
  });
});

describe("takesTrayModel", () => {
  it("orders takes by number, the live one last", () => {
    const rows = takesTrayModel([
      take({ id: "c", number: 3, live: true }),
      take({ id: "a", number: 1 }),
      take({ id: "b", number: 2 }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("does not reorder the caller's list", () => {
    const takes = [take({ id: "b", number: 2 }), take({ id: "a", number: 1 })];
    takesTrayModel(takes);
    expect(takes.map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  it("is empty for no takes", () => {
    expect(takesTrayModel([])).toEqual([]);
  });
});

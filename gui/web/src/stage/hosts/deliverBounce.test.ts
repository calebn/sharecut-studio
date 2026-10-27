import { describe, expect, it, vi } from "vitest";
import { BOUNCE_DEFAULTS } from "../../stages/deliver/bounceLogic";
import type { PipelineJobSnapshot } from "../../types/pipeline";
import type { ExactRangeTarget } from "../../types/project";
import type { BounceFlow, BounceRun } from "./bounceFlowContext";
import {
  BOUNCE_CANCELLED_NOTHING,
  BOUNCE_CANCELLING_DETAIL,
  BOUNCE_CANCELLING_REASON,
  BOUNCE_STARTING_REASON,
  bounceOptionsOf,
  bounceStateOf,
} from "./deliverBounce";

const JOB = {
  id: "b1",
  message: "Mixing",
  current: 1,
  total: 4,
  elapsed_sec: 65,
  last_progress_at: null,
} as unknown as PipelineJobSnapshot;

function flow(run: BounceRun, job: PipelineJobSnapshot | null = null) {
  return {
    run,
    job,
    choices: BOUNCE_DEFAULTS,
    setChoices: vi.fn(),
    gate: {} as BounceFlow["gate"],
    start: vi.fn(),
    cancel: vi.fn(),
    again: vi.fn(),
  } satisfies BounceFlow;
}

const running = (over: Partial<Extract<BounceRun, { kind: "running" }>> = {}) =>
  ({
    kind: "running",
    jobId: "b1",
    cancelling: false,
    cancelError: null,
    ...over,
  }) as const;

describe("bounceStateOf", () => {
  it("is idle until a bounce starts", () => {
    expect(bounceStateOf(flow({ kind: "idle" }), 0)).toEqual({
      phase: "idle",
    });
  });

  it("says it is starting, with no bar, until the job is known", () => {
    expect(bounceStateOf(flow(running({ jobId: null })), 0)).toEqual({
      phase: "running",
      progress: null,
      detail: "Starting bounce… · Elapsed 0:00",
      cancelReason: BOUNCE_STARTING_REASON,
      cancelError: undefined,
    });
  });

  it("reports the job's message, units, elapsed time and fraction", () => {
    expect(bounceStateOf(flow(running(), JOB), 0)).toEqual({
      phase: "running",
      progress: 0.25,
      detail: "Mixing · 1/4 steps · Elapsed 1:05",
      cancelReason: undefined,
      cancelError: undefined,
    });
  });

  it("explains a cancel in flight and one that failed", () => {
    expect(
      bounceStateOf(flow(running({ cancelling: true }), JOB), 0),
    ).toMatchObject({
      detail: `${BOUNCE_CANCELLING_DETAIL} · 1/4 steps · Elapsed 1:05`,
      cancelReason: BOUNCE_CANCELLING_REASON,
    });
    expect(
      bounceStateOf(flow(running({ cancelError: "gone" }), JOB), 0),
    ).toMatchObject({ cancelError: "gone" });
  });

  it("names the files a finished bounce wrote", () => {
    expect(
      bounceStateOf(
        flow({
          kind: "done",
          paths: [
            "/p/export/bounces/mix.wav",
            "C:\\p\\export\\bounces\\mix.mp3",
          ],
        }),
        0,
      ),
    ).toEqual({
      phase: "done",
      files: ["mix.wav", "mix.mp3"],
      summary: "Bounced 2 file(s) to export/bounces/",
    });
  });

  it("carries a failure's reason", () => {
    expect(
      bounceStateOf(flow({ kind: "failed", reason: "disk full" }), 0),
    ).toEqual({ phase: "failed", cause: "disk full" });
  });

  it("says a cancel wrote nothing, or came too late", () => {
    expect(bounceStateOf(flow({ kind: "cancelled", paths: [] }), 0)).toEqual({
      phase: "cancelled",
      files: [],
      detail: BOUNCE_CANCELLED_NOTHING,
    });
    expect(
      bounceStateOf(flow({ kind: "cancelled", paths: ["/p/mix.wav"] }), 0),
    ).toEqual({
      phase: "cancelled",
      files: ["mix.wav"],
      detail: "Cancel came too late. Bounced 1 file(s) to export/bounces/",
    });
  });
});

describe("bounceOptionsOf", () => {
  const RANGE = {
    kind: "exact_range",
    intervals: [{ start: 1, end: 2 }],
    track_ids: ["a"],
    clips: [],
  } as unknown as ExactRangeTarget;
  const project = (range: ExactRangeTarget | null) => ({
    selectedCount: 2,
    soloCount: 1,
    hasRegion: true,
    range,
    clearRange: vi.fn(),
    focusRequested: true,
    onFocused: vi.fn(),
  });

  it("passes the project's counts and the flow's choices and actions", () => {
    const f = flow({ kind: "idle" });
    const p = project(null);
    const o = bounceOptionsOf(f, 0, p);
    expect(o).toMatchObject({
      choices: BOUNCE_DEFAULTS,
      selectedCount: 2,
      soloCount: 1,
      hasRegion: true,
      fixedRange: undefined,
      onClearRange: undefined,
      onAgain: undefined,
      focusRequested: true,
    });
    expect(o.onBounce).toBe(f.start);
    expect(o.onCancel).toBe(f.cancel);
    expect(o.onChoices).toBe(f.setChoices);
    expect(o.onFocused).toBe(p.onFocused);
  });

  it("fixes the range and offers to let it go", () => {
    const p = project(RANGE);
    const o = bounceOptionsOf(flow({ kind: "idle" }), 0, p);
    expect(o.fixedRange).toBe("1.00–2.00 s on a");
    expect(o.onClearRange).toBe(p.clearRange);
  });

  it("offers Try again only after a failure or a cancel", () => {
    const failed = flow({ kind: "failed", reason: "x" });
    expect(bounceOptionsOf(failed, 0, project(null)).onAgain).toBe(
      failed.again,
    );
    const cancelled = flow({ kind: "cancelled", paths: [] });
    expect(bounceOptionsOf(cancelled, 0, project(null)).onAgain).toBe(
      cancelled.again,
    );
    expect(
      bounceOptionsOf(flow({ kind: "done", paths: [] }), 0, project(null))
        .onAgain,
    ).toBeUndefined();
  });
});

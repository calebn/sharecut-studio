import { describe, expect, it } from "vitest";
import type { PipelineJobSnapshot } from "../types/pipeline";
import {
  isPipelineKindJob,
  isPipelineSlotBusy,
  isPipelineSlotJob,
  jobResultPaths,
  pipelineChipOpensPanel,
} from "./pipeline";
import {
  hasDeterminateProgress,
  pipelineChromeLabel,
  pipelineKindLabel,
  pipelineProgressPercent,
  pipelineStatusLabel,
  pipelineUnitsLabel,
  STALE_AFTER_S,
  showIndeterminatePulse,
  staleUpdateLabel,
  truncateHeadline,
} from "./pipelineProgress";

function job(
  overrides: Partial<PipelineJobSnapshot> = {},
): PipelineJobSnapshot {
  return {
    id: "j1",
    project_path: "/tmp/p.json",
    from_step: null,
    only_step: null,
    status: "running",
    current: null,
    total: null,
    message: null,
    error: null,
    elapsed_sec: 0,
    steps: [],
    ...overrides,
  };
}

describe("pipelineProgress", () => {
  it("treats missing total as indeterminate (no bar, no units)", () => {
    const indeterminate = job({ current: 1, total: null, message: "Aligning" });
    expect(hasDeterminateProgress(indeterminate)).toBe(false);
    expect(pipelineProgressPercent(indeterminate)).toBeNull();
    expect(pipelineUnitsLabel(indeterminate)).toBeNull();
    expect(showIndeterminatePulse(indeterminate)).toBe(true);
  });

  it("exposes percent and units only when total is real", () => {
    const determinate = job({ current: 1, total: 4 });
    expect(hasDeterminateProgress(determinate)).toBe(true);
    expect(pipelineProgressPercent(determinate)).toBe(25);
    expect(pipelineUnitsLabel(determinate)).toBe("1/4 steps");
    expect(showIndeterminatePulse(determinate)).toBe(true);
  });

  it("truncates headlines and distinguishes fail vs cancel", () => {
    expect(truncateHeadline("short")).toBe("short");
    expect(truncateHeadline("x".repeat(50))?.endsWith("…")).toBe(true);
    expect(pipelineStatusLabel("error")).toBe("failed");
    expect(pipelineStatusLabel("cancelled")).toBe("cancelled");
  });

  it("builds chrome labels with headline and optional units", () => {
    expect(
      pipelineChromeLabel(
        job({
          status: "running",
          message: "Aligning conversation",
          current: 1,
          total: 2,
        }),
      ),
    ).toBe("Pipeline: running · Aligning conversation · 1/2 steps");
    expect(
      pipelineChromeLabel(
        job({
          status: "running",
          message: "Whisper encode",
          current: null,
          total: null,
        }),
      ),
    ).toBe("Pipeline: running · Whisper encode");
  });

  it("labels bounce/export/render_preview as Activity, not Pipeline tab jobs", () => {
    expect(pipelineKindLabel("bounce")).toBe("Activity");
    expect(pipelineKindLabel("export")).toBe("Activity");
    expect(pipelineKindLabel("render_preview")).toBe("Activity");
    expect(pipelineKindLabel("pipeline")).toBe("Pipeline");
    expect(isPipelineKindJob(job({ kind: "bounce" }))).toBe(false);
    expect(isPipelineKindJob(job({ kind: "export" }))).toBe(false);
    expect(isPipelineKindJob(job({ kind: "render_preview" }))).toBe(false);
    expect(isPipelineSlotJob(job({ kind: "bounce" }))).toBe(true);
    expect(isPipelineSlotJob(job({ kind: "export" }))).toBe(true);
    expect(isPipelineSlotJob(job({ kind: "render_preview" }))).toBe(true);
    expect(isPipelineSlotBusy(job({ kind: "bounce", status: "running" }))).toBe(
      true,
    );
    expect(pipelineChipOpensPanel(job({ kind: "bounce" }))).toBe(true);
    expect(pipelineChipOpensPanel(job({ kind: "agent" }))).toBe(false);
    expect(
      pipelineChromeLabel(
        job({
          kind: "bounce",
          label: "Bounce",
          status: "running",
          message: "Mixing bounce…",
        }),
      ),
    ).toBe("Activity: running · Mixing bounce…");
  });

  it("labels agent jobs as Activity with the tool headline", () => {
    expect(pipelineKindLabel("agent")).toBe("Activity");
    expect(pipelineKindLabel("pipeline")).toBe("Pipeline");
    expect(isPipelineKindJob(job({ kind: "agent" }))).toBe(false);
    expect(isPipelineKindJob(job({ kind: "pipeline" }))).toBe(true);
    expect(isPipelineSlotJob(job({ kind: "agent" }))).toBe(false);
    expect(isPipelineSlotJob(job({ kind: "pipeline" }))).toBe(true);
    expect(pipelineChipOpensPanel(job({ kind: "pipeline" }))).toBe(true);
    expect(
      pipelineChromeLabel(
        job({
          kind: "agent",
          label: "align_tracks",
          tool_id: "align_tracks",
          status: "running",
          message: "Scoring bleed windows",
        }),
      ),
    ).toBe("Activity: running · Scoring bleed windows");
  });

  it("reads artifact paths from a terminal job result", () => {
    expect(
      jobResultPaths(job({ result: { paths: ["/a.wav", "/b.mp3"] } })),
    ).toEqual(["/a.wav", "/b.mp3"]);
    expect(
      jobResultPaths({
        result: { paths: ["/a.wav", 1, "/b.mp3"] },
      } as never),
    ).toEqual(["/a.wav", "/b.mp3"]);
    expect(jobResultPaths(job({ result: null }))).toEqual([]);
  });

  it("omits stale copy until last_progress_at is older than STALE_AFTER_S", () => {
    expect(STALE_AFTER_S).toBe(15);
    expect(staleUpdateLabel(null, 100)).toBeNull();
    expect(staleUpdateLabel(undefined, 100)).toBeNull();
    expect(staleUpdateLabel(100, 115)).toBeNull();
    expect(staleUpdateLabel(100, 115.4)).toBe("last update 15s ago");
    expect(staleUpdateLabel(100, 122)).toBe("last update 22s ago");
  });
});

import { describe, expect, it } from "vitest";
import {
  isAnalyzeJob,
  isPipelineKindJob,
  isPipelineSlotJob,
  isTerminalJobStatus,
} from "./pipeline";

describe("isTerminalJobStatus", () => {
  it("is true for ok, error and cancelled", () => {
    for (const s of ["ok", "error", "cancelled"]) {
      expect(isTerminalJobStatus(s)).toBe(true);
    }
  });
  it("is false for live or unknown statuses", () => {
    for (const s of ["queued", "running", "", "bogus"]) {
      expect(isTerminalJobStatus(s)).toBe(false);
    }
  });
});

describe("isAnalyzeJob", () => {
  it("is true only for kind analyze", () => {
    expect(isAnalyzeJob({ kind: "analyze" })).toBe(true);
  });
  it("is false for other kinds, undefined and null", () => {
    expect(isAnalyzeJob({ kind: "pipeline" })).toBe(false);
    expect(isAnalyzeJob({ kind: "bounce" })).toBe(false);
    expect(isAnalyzeJob(undefined)).toBe(false);
    expect(isAnalyzeJob(null)).toBe(false);
  });
});

describe("analyze job slot classification", () => {
  it("is a pipeline slot job but not a pipeline-kind job", () => {
    expect(isPipelineSlotJob({ kind: "analyze" })).toBe(true);
    expect(isPipelineKindJob({ kind: "analyze" })).toBe(false);
  });
});

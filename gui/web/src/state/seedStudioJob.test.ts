import { beforeEach, describe, expect, it } from "vitest";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { useDawStore } from "./dawStore";
import { seedStudioJob } from "./seedStudioJob";

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

describe("seedStudioJob", () => {
  beforeEach(() => {
    useDawStore.setState({ pipelineJob: null, activityJob: null });
  });

  it("stores pipeline-kind jobs on both chrome slots", () => {
    const pipe = job({ id: "p1", kind: "pipeline" });
    seedStudioJob(pipe);
    expect(useDawStore.getState().activityJob).toBe(pipe);
    expect(useDawStore.getState().pipelineJob).toBe(pipe);
  });

  it("clears pipelineJob when seeding bounce/export/render_preview", () => {
    useDawStore.getState().setPipelineJob(job({ id: "old", kind: "pipeline" }));
    const bounce = job({ id: "b1", kind: "bounce", label: "Bounce" });
    seedStudioJob(bounce);
    expect(useDawStore.getState().activityJob).toBe(bounce);
    expect(useDawStore.getState().pipelineJob).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { useDawStore } from "./dawStore";
import { runAnnouncedJob } from "./runAnnouncedJob";

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  followJobToOk: vi.fn(),
}));
vi.mock("./seedStudioJob", () => ({ seedStudioJob: vi.fn() }));

import { followJobToOk, JobCancelledError } from "../api";
import { seedStudioJob } from "./seedStudioJob";

const followMock = vi.mocked(followJobToOk);

const okJob = {
  id: "j1",
  kind: "export",
  status: "ok",
  result: { paths: ["a.wav"] },
} as PipelineJobSnapshot;
const seedMock = vi.mocked(seedStudioJob);

const snap = {
  id: "j1",
  kind: "export",
  status: "queued",
} as PipelineJobSnapshot;

describe("runAnnouncedJob", () => {
  beforeEach(() => {
    useDawStore.setState({ pendingJobResults: {} });
    followMock.mockReset();
    seedMock.mockReset();
  });

  it("registers the job before seeding the chip", async () => {
    let registeredBeforeSeed = false;
    seedMock.mockImplementation(() => {
      registeredBeforeSeed = "j1" in useDawStore.getState().pendingJobResults;
    });
    followMock.mockResolvedValue(okJob);
    await runAnnouncedJob(async () => snap, {
      failLabel: "F",
      resultCopy: (p) => `${p.length} done`,
    });
    expect(registeredBeforeSeed).toBe(true);
  });

  it("hands the result copy over on success", async () => {
    followMock.mockResolvedValue(okJob);
    const result = await runAnnouncedJob(async () => snap, {
      failLabel: "F",
      resultCopy: (p) => `${p.length} done`,
    });
    expect(result).toBe(okJob);
    expect(useDawStore.getState().pendingJobResults).toEqual({
      j1: "1 done",
    });
  });

  it("hands the started job to onStart before following it", async () => {
    followMock.mockResolvedValue(okJob);
    const onStart = vi.fn();
    await runAnnouncedJob(async () => snap, {
      failLabel: "F",
      resultCopy: (p) => `${p.length} done`,
      onStart,
    });
    expect(onStart).toHaveBeenCalledWith(snap);
  });

  it("settles and rethrows when the job fails", async () => {
    followMock.mockRejectedValue(new Error("boom"));
    await expect(
      runAnnouncedJob(async () => snap, {
        failLabel: "F",
        resultCopy: (p) => `${p.length} done`,
      }),
    ).rejects.toThrow("boom");
    expect(useDawStore.getState().pendingJobResults).toEqual({});
  });

  it("settles a cancel that wrote nothing without announcing", async () => {
    followMock.mockRejectedValue(
      new JobCancelledError({ ...snap, status: "cancelled" }, "Cancelled"),
    );
    await expect(
      runAnnouncedJob(async () => snap, {
        failLabel: "F",
        resultCopy: (p) => `${p.length} done`,
      }),
    ).rejects.toBeInstanceOf(JobCancelledError);
    expect(useDawStore.getState().pendingJobResults).toEqual({});
  });

  it("announces the files a cancel arrived too late to stop", async () => {
    followMock.mockRejectedValue(
      new JobCancelledError(
        { ...snap, status: "cancelled", result: { paths: ["a.wav", "a.mp3"] } },
        "Cancelled",
      ),
    );
    await expect(
      runAnnouncedJob(async () => snap, {
        failLabel: "F",
        resultCopy: (p) => `${p.length} done`,
      }),
    ).rejects.toBeInstanceOf(JobCancelledError);
    expect(useDawStore.getState().pendingJobResults).toEqual({
      j1: "Cancel came too late. 2 done",
    });
  });

  it("passes the abort signal through", async () => {
    followMock.mockResolvedValue(okJob);
    const ac = new AbortController();
    await runAnnouncedJob(async () => snap, {
      failLabel: "F",
      resultCopy: (p) => `${p.length} done`,
      signal: ac.signal,
    });
    expect(followMock).toHaveBeenCalledWith("j1", "F", { signal: ac.signal });
  });

  it("registers and seeds nothing when the signal aborted while start() ran", async () => {
    const ac = new AbortController();
    await expect(
      runAnnouncedJob(
        async () => {
          ac.abort();
          return snap;
        },
        {
          failLabel: "F",
          resultCopy: (p) => `${p.length} done`,
          signal: ac.signal,
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(seedMock).not.toHaveBeenCalled();
    expect(followMock).not.toHaveBeenCalled();
    expect(useDawStore.getState().pendingJobResults).toEqual({});
  });
});

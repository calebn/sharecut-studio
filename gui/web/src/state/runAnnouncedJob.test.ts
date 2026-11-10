import { beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../test/deferred";
import { minimalProject } from "../test/fixtures";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { ApiError } from "../utils/apiError";
import { jobResultPaths } from "../utils/pipeline";
import { useDawStore } from "./dawStore";
import { runAnnouncedJob } from "./runAnnouncedJob";
import { uiProjectInitial } from "./uiSlice";

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

function summarizeResult(job: PipelineJobSnapshot) {
  const paths = jobResultPaths(job);
  return job.status === "cancelled" && paths.length === 0
    ? null
    : { copy: `${paths.length} done` };
}

describe("runAnnouncedJob", () => {
  beforeEach(() => {
    useDawStore.setState({ ...uiProjectInitial(), statusAnnouncement: "" });
    followMock.mockReset();
    seedMock.mockReset();
  });

  it("registers the job before seeding the chip", async () => {
    let registeredBeforeSeed = false;
    seedMock.mockImplementation(() => {
      registeredBeforeSeed =
        useDawStore.getState().jobFeedback.get("j1")?.kind === "following";
    });
    followMock.mockResolvedValue(okJob);
    await runAnnouncedJob(async () => snap, {
      kind: "export",
      failLabel: "F",
      summarizeResult,
    });
    expect(registeredBeforeSeed).toBe(true);
  });

  it("hands the result copy over on success", async () => {
    followMock.mockResolvedValue(okJob);
    const result = await runAnnouncedJob(async () => snap, {
      kind: "export",
      failLabel: "F",
      summarizeResult,
    });
    expect(result).toBe(okJob);
    expect(useDawStore.getState().jobFeedback).toEqual(
      new Map([
        [
          "j1",
          { kind: "ready", outcome: { kind: "verified", copy: "1 done" } },
        ],
      ]),
    );
  });

  it("hands the started job to onStart before following it", async () => {
    const onStart = vi.fn<(job: PipelineJobSnapshot) => void>();
    const followed = deferred<PipelineJobSnapshot>();
    followMock.mockImplementationOnce(() => {
      expect(onStart).toHaveBeenCalledWith(snap);
      return followed.promise;
    });
    const run = runAnnouncedJob(async () => snap, {
      kind: "export",
      failLabel: "F",
      summarizeResult,
      onStart,
    });
    followed.resolve(okJob);
    await expect(run).resolves.toBe(okJob);
    expect(onStart).toHaveBeenCalledWith(snap);
  });

  it("settles and rethrows when the job fails", async () => {
    followMock.mockRejectedValue(new Error("boom"));
    await expect(
      runAnnouncedJob(async () => snap, {
        kind: "export",
        failLabel: "F",
        summarizeResult,
      }),
    ).rejects.toThrow("boom");
    expect(useDawStore.getState().jobFeedback).toEqual(
      new Map([["j1", { kind: "unverified" }]]),
    );
  });

  it("rethrows the model error unchanged so a gate can ask", async () => {
    const needed = new ApiError("needs RNNoise", "model_needed", 409, {
      id: "rnnoise",
      variant: null,
      label: "RNNoise",
      purpose: "",
      size: "~2 MB",
      sizeBytes: null,
      state: "missing",
    });
    followMock.mockRejectedValue(needed);
    await expect(
      runAnnouncedJob(async () => snap, {
        kind: "export",
        failLabel: "F",
        summarizeResult,
      }),
    ).rejects.toBe(needed);
    expect(useDawStore.getState().jobFeedback).toEqual(
      new Map([["j1", { kind: "unverified" }]]),
    );
  });

  it("settles a cancel that wrote nothing without announcing", async () => {
    followMock.mockRejectedValue(
      new JobCancelledError({ ...snap, status: "cancelled" }, "Cancelled"),
    );
    await expect(
      runAnnouncedJob(async () => snap, {
        kind: "export",
        failLabel: "F",
        summarizeResult,
      }),
    ).rejects.toBeInstanceOf(JobCancelledError);
    expect(useDawStore.getState().jobFeedback).toEqual(new Map([]));
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
        kind: "export",
        failLabel: "F",
        summarizeResult,
      }),
    ).rejects.toBeInstanceOf(JobCancelledError);
    expect(useDawStore.getState().jobFeedback).toEqual(
      new Map([
        [
          "j1",
          {
            kind: "ready",
            outcome: { kind: "verified", copy: "Cancel came too late. 2 done" },
          },
        ],
      ]),
    );
  });

  it("passes the abort signal through", async () => {
    followMock.mockResolvedValue(okJob);
    const ac = new AbortController();
    await runAnnouncedJob(async () => snap, {
      kind: "export",
      failLabel: "F",
      summarizeResult,
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
          kind: "export",
          failLabel: "F",
          summarizeResult,
          signal: ac.signal,
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(seedMock).not.toHaveBeenCalled();
    expect(followMock).not.toHaveBeenCalled();
    expect(useDawStore.getState().jobFeedback).toEqual(new Map([]));
  });
  it("rejects a successful reply after its caller stopped following", async () => {
    const ac = new AbortController();
    followMock.mockImplementationOnce(async () => {
      ac.abort();
      return okJob;
    });
    await expect(
      runAnnouncedJob(async () => snap, {
        kind: "export",
        failLabel: "F",
        summarizeResult,
        signal: ac.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(useDawStore.getState().jobFeedback).toEqual(
      new Map([["j1", { kind: "unverified" }]]),
    );
  });

  it("settles a late cancellation without announcing after its caller left", async () => {
    const ac = new AbortController();
    const cancelled = new JobCancelledError(
      { ...snap, status: "cancelled", result: { paths: ["a.wav"] } },
      "Cancelled",
    );
    followMock.mockImplementationOnce(async () => {
      ac.abort();
      throw cancelled;
    });
    await expect(
      runAnnouncedJob(async () => snap, {
        kind: "export",
        failLabel: "F",
        summarizeResult,
        signal: ac.signal,
      }),
    ).rejects.toBe(cancelled);
    expect(useDawStore.getState().jobFeedback).toEqual(
      new Map([["j1", { kind: "unverified" }]]),
    );
  });
});

it("sends no start request when already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const start = vi.fn(async () => snap);
  await expect(
    runAnnouncedJob(start, {
      kind: "export",
      failLabel: "F",
      summarizeResult,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(start).not.toHaveBeenCalled();
});

it.each(["reject", "abort"] as const)(
  "releases an unknown-ID success on %s before a held POST settles",
  async (outcome) => {
    useDawStore.setState({ ...uiProjectInitial(), statusAnnouncement: "" });
    const post = deferred<PipelineJobSnapshot>();
    const controller = new AbortController();
    const run = runAnnouncedJob(() => post.promise, {
      kind: "export",
      failLabel: "F",
      summarizeResult,
      signal: controller.signal,
    });
    const rejected = expect(run).rejects.toThrow(
      outcome === "reject" ? "refused" : "Aborted",
    );
    const s = useDawStore.getState();
    s.reconcileJobAnnouncements(
      {
        id: "remote",
        kind: "export",
        status: "ok",
        copy: "Remote export finished",
      },
      undefined,
      false,
    );
    expect(useDawStore.getState().statusAnnouncement).toBe("");
    if (outcome === "abort") controller.abort();
    else {
      post.reject(new Error("refused"));
      await rejected;
    }
    s.reconcileJobAnnouncements(null, undefined, false);
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Remote export finished",
    );
    expect(useDawStore.getState().jobResultStarts.size).toBe(0);
    if (outcome === "abort") {
      post.resolve(snap);
      await rejected;
    }
  },
);

it("settles an unpublished bound result immediately on abort, preserving other staged copy", async () => {
  useDawStore.setState({ ...uiProjectInitial() });
  const followed = deferred<PipelineJobSnapshot>();
  followMock.mockReturnValueOnce(followed.promise);
  const controller = new AbortController();
  const run = runAnnouncedJob(async () => snap, {
    kind: "export",
    failLabel: "F",
    summarizeResult,
    signal: controller.signal,
  });
  const rejected = expect(run).rejects.toMatchObject({ name: "AbortError" });
  await Promise.resolve();
  const s = useDawStore.getState();
  const other = { start: s.beginJobResultStart("export"), jobId: "other" };
  s.bindJobResultStart(other);
  s.finishJobResult(other, { kind: "verified", copy: "Other verified files" });
  controller.abort();
  expect(useDawStore.getState().jobFeedback).toEqual(
    new Map([
      ["j1", { kind: "unverified" }],
      [
        "other",
        {
          kind: "ready",
          outcome: { kind: "verified", copy: "Other verified files" },
        },
      ],
    ]),
  );
  followed.resolve(okJob);
  await rejected;
});

it("preserves a follower cancellation rejected just before the abort microtask", async () => {
  useDawStore.setState({ ...uiProjectInitial(), statusAnnouncement: "" });
  followMock.mockReset();
  seedMock.mockReset();
  const followed = deferred<PipelineJobSnapshot>();
  followMock.mockReturnValueOnce(followed.promise);
  const controller = new AbortController();
  const cancelled = new JobCancelledError(
    { ...snap, status: "cancelled" },
    "Cancelled",
  );
  const summarize = vi.fn(summarizeResult);
  const run = runAnnouncedJob(async () => snap, {
    kind: "export",
    failLabel: "F",
    summarizeResult: summarize,
    signal: controller.signal,
  });
  const rejected = expect(run).rejects.toBe(cancelled);

  await vi.waitFor(() =>
    expect(followMock).toHaveBeenCalledWith("j1", "F", {
      signal: controller.signal,
    }),
  );
  followed.reject(cancelled);
  queueMicrotask(() => controller.abort());

  await rejected;
  expect(summarize).not.toHaveBeenCalled();
  expect(useDawStore.getState().jobFeedback).toEqual(
    new Map([["j1", { kind: "unverified" }]]),
  );
  expect(useDawStore.getState().jobResultStarts.size).toBe(0);
  expect(useDawStore.getState().statusAnnouncement).toBe("");
});

it.each(["start", "follow"] as const)(
  "isolates an old %s completion and finally after reset and a new run",
  async (phase) => {
    const s = useDawStore.getState();
    s.hydrate("/tmp/old.sharecut", minimalProject());
    const old = deferred<PipelineJobSnapshot>();
    if (phase === "follow") followMock.mockReturnValueOnce(old.promise);
    const onStart = vi.fn();
    const run = runAnnouncedJob(
      () => (phase === "start" ? old.promise : Promise.resolve(snap)),
      {
        kind: "export",
        failLabel: "F",
        summarizeResult,
        onStart,
      },
    );
    const rejected = expect(run).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    s.hydrate("/tmp/new.sharecut", minimalProject());
    const next = deferred<PipelineJobSnapshot>();
    followMock.mockReturnValueOnce(next.promise);
    const current = runAnnouncedJob(async () => snap, {
      kind: "export",
      failLabel: "F",
      summarizeResult,
    });
    await Promise.resolve();
    const starts = onStart.mock.calls.length;
    old.resolve(okJob);
    await rejected;
    expect(onStart).toHaveBeenCalledTimes(starts);
    expect(useDawStore.getState().jobFeedback.get("j1")).toMatchObject({
      kind: "following",
    });
    next.resolve(okJob);
    await current;
    expect(useDawStore.getState().jobFeedback).toEqual(
      new Map([
        [
          "j1",
          { kind: "ready", outcome: { kind: "verified", copy: "1 done" } },
        ],
      ]),
    );
  },
);

it("retains a bound abort against later discovery without decoding the stale reply", async () => {
  useDawStore.setState({ ...uiProjectInitial(), statusAnnouncement: "" });
  seedMock.mockReset();
  followMock.mockReset();
  const followed = deferred<PipelineJobSnapshot>();
  followMock.mockReturnValueOnce(followed.promise);
  const controller = new AbortController();
  const summarize = vi.fn(summarizeResult);
  const run = runAnnouncedJob(async () => snap, {
    kind: "export",
    failLabel: "Export failed",
    summarizeResult: summarize,
    signal: controller.signal,
  });
  const rejected = expect(run).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(followMock).toHaveBeenCalledTimes(1));
  controller.abort();
  const s = useDawStore.getState();
  s.reconcileJobAnnouncements(
    { id: "j1", kind: "export", status: "ok", copy: "Unverified success" },
    "j1",
    true,
  );
  expect(useDawStore.getState().statusAnnouncement).toBe("");
  followed.resolve(okJob);
  await rejected;
  expect(summarize).not.toHaveBeenCalled();
  s.reconcileJobAnnouncements(
    {
      id: "j1",
      kind: "export",
      status: "ok",
      copy: "Unverified success again",
    },
    "j1",
    true,
  );
  expect(useDawStore.getState().statusAnnouncement).toBe("");
  s.reconcileJobAnnouncements(
    { id: "other", kind: "export", status: "ok", copy: "External success" },
    "other",
    true,
  );
  expect(useDawStore.getState().statusAnnouncement).toBe("External success");
});

it.each(["bind", "seed", "onStart"] as const)(
  "stops a synchronous abort at %s before following",
  async (at) => {
    useDawStore.setState({ ...uiProjectInitial() });
    seedMock.mockReset();
    followMock.mockReset();
    const controller = new AbortController();
    const unsubscribe = useDawStore.subscribe((state) => {
      if (at === "bind" && state.jobFeedback.get("j1")?.kind === "following")
        controller.abort();
    });
    if (at === "seed") seedMock.mockImplementation(() => controller.abort());
    const onStart = vi.fn(() => {
      if (at === "onStart") controller.abort();
    });
    try {
      await expect(
        runAnnouncedJob(async () => snap, {
          kind: "export",
          failLabel: "F",
          summarizeResult,
          signal: controller.signal,
          onStart,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(followMock).not.toHaveBeenCalled();
      expect(seedMock).toHaveBeenCalledTimes(at === "bind" ? 0 : 1);
      expect(onStart).toHaveBeenCalledTimes(at === "onStart" ? 1 : 0);
      expect(useDawStore.getState().jobFeedback.get("j1")).toEqual({
        kind: "unverified",
      });
    } finally {
      unsubscribe();
    }
  },
);

it("stages a sanitized receipt failure and rethrows the original decoder error", async () => {
  useDawStore.setState({ ...uiProjectInitial(), statusAnnouncement: "" });
  seedMock.mockReset();
  followMock.mockReset().mockResolvedValue(okJob);
  const error = new Error("Set PRIVATE_TOOL_PATH to its executable.");
  await expect(
    runAnnouncedJob(async () => snap, {
      kind: "export",
      failLabel: "Export failed",
      summarizeResult: () => {
        throw error;
      },
    }),
  ).rejects.toBe(error);
  const s = useDawStore.getState();
  s.reconcileJobAnnouncements(null, "j1", false);
  expect(useDawStore.getState().statusAnnouncement).toBe(
    "Export failed. Try again, or report a problem from the command palette.",
  );
  expect(useDawStore.getState().feedbackToast).toBeNull();
});

it("preserves captured cancellation through a reset without decoding or reviving it", async () => {
  useDawStore.setState({ ...uiProjectInitial(), statusAnnouncement: "" });
  seedMock.mockReset();
  followMock.mockReset();
  const followed = deferred<PipelineJobSnapshot>();
  followMock.mockReturnValueOnce(followed.promise);
  const cancelled = new JobCancelledError(
    { ...okJob, status: "cancelled" },
    "Cancelled",
  );
  const summarize = vi.fn(summarizeResult);
  const run = runAnnouncedJob(async () => snap, {
    kind: "export",
    failLabel: "F",
    summarizeResult: summarize,
  });
  const rejected = expect(run).rejects.toBe(cancelled);
  await vi.waitFor(() => expect(followMock).toHaveBeenCalledTimes(1));
  followed.reject(cancelled);
  queueMicrotask(() =>
    useDawStore
      .getState()
      .hydrate("/tmp/reset-cancel.sharecut", minimalProject()),
  );
  await rejected;
  expect(summarize).not.toHaveBeenCalled();
  expect(useDawStore.getState().jobFeedback.size).toBe(0);
  expect(useDawStore.getState().statusAnnouncement).toBe("");
});

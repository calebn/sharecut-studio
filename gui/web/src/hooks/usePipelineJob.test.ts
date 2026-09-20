import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PipelineJobSnapshot,
  PipelineStatusResponse,
} from "../types/pipeline";
import {
  applyPipelineJobStatus,
  applyStatus,
  attachTargetId,
  usePipelineJob,
} from "./usePipelineJob";

const loadPipelineStatus = vi.fn();
const pipelineEventsUrl = vi.fn((id?: string | null) =>
  id ? `/api/pipeline/events?job_id=${id}` : "/api/pipeline/events",
);

vi.mock("../api", () => ({
  loadPipelineStatus: (...args: unknown[]) => loadPipelineStatus(...args),
  pipelineEventsUrl: (...args: unknown[]) =>
    pipelineEventsUrl(...(args as [string | null | undefined])),
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn(() => {
    this.closed = true;
  });
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

function job(
  overrides: Partial<PipelineJobSnapshot> = {},
): PipelineJobSnapshot {
  return {
    id: "pipe-1",
    project_path: "/tmp/p.json",
    from_step: null,
    only_step: null,
    kind: "pipeline",
    status: "running",
    current: 1,
    total: 4,
    message: "Aligning",
    error: null,
    elapsed_sec: 1,
    steps: [],
    ...overrides,
  };
}

function agent(
  overrides: Partial<PipelineJobSnapshot> = {},
): PipelineJobSnapshot {
  return job({
    id: "agent-1",
    kind: "agent",
    label: "align_tracks",
    tool_id: "align_tracks",
    message: "Scoring bleed windows",
    current: null,
    total: null,
    ...overrides,
  });
}

describe("usePipelineJob", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    loadPipelineStatus.mockReset();
    pipelineEventsUrl.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not fetch status when disabled", async () => {
    renderHook(() => usePipelineJob(null, vi.fn(), { enabled: false }));
    await waitFor(() => {
      expect(loadPipelineStatus).not.toHaveBeenCalled();
    });
  });

  it("bootstraps status when enabled", async () => {
    loadPipelineStatus.mockResolvedValue({
      running: false,
      job: null,
    } satisfies PipelineStatusResponse);
    renderHook(() => usePipelineJob(null, vi.fn(), { enabled: true }));
    await waitFor(() => {
      expect(loadPipelineStatus).toHaveBeenCalled();
    });
  });

  it("splits jobs into pipeline vs activity store fields", () => {
    const setPipelineJob = vi.fn();
    const setActivityJob = vi.fn();
    const setCount = vi.fn();
    const pipe = job();
    const wrap = agent();
    applyStatus(
      {
        running: true,
        job: wrap,
        jobs: [pipe, wrap],
        running_count: 2,
      },
      setPipelineJob,
      setActivityJob,
      setCount,
    );
    expect(setCount).toHaveBeenCalledWith(2);
    expect(setActivityJob).toHaveBeenCalledWith(wrap);
    expect(setPipelineJob).toHaveBeenCalledWith(pipe);
  });

  it("prefers a live pipeline job for SSE attach while an agent is primary", () => {
    const pipe = job();
    const wrap = agent();
    expect(
      attachTargetId({
        running: true,
        job: wrap,
        jobs: [pipe, wrap],
        running_count: 2,
      }),
    ).toBe(pipe.id);
  });

  it("attaches SSE to the pipeline job when both pipeline and agent are live", async () => {
    const pipe = job();
    const wrap = agent();
    loadPipelineStatus.mockResolvedValue({
      running: true,
      job: wrap,
      jobs: [pipe, wrap],
      running_count: 2,
    } satisfies PipelineStatusResponse);
    const setPipelineJob = vi.fn();
    renderHook(() =>
      usePipelineJob(pipe, setPipelineJob, {
        enabled: true,
        activityJob: wrap,
        setActivityJob: vi.fn(),
        setActivityRunningCount: vi.fn(),
      }),
    );
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBeGreaterThan(0);
    });
    expect(FakeEventSource.instances.at(-1)?.url).toContain("pipe-1");
  });

  it("keeps polling after agent done while another job is live", async () => {
    const pipe = job();
    const wrap = agent({ status: "ok" });
    loadPipelineStatus
      .mockResolvedValueOnce({
        running: true,
        job: pipe,
        jobs: [pipe, wrap],
        running_count: 1,
      } satisfies PipelineStatusResponse)
      .mockResolvedValue({
        running: true,
        job: pipe,
        jobs: [pipe],
        running_count: 1,
      } satisfies PipelineStatusResponse);
    const setActivityJob = vi.fn();
    const setCount = vi.fn();
    renderHook(() =>
      usePipelineJob(pipe, vi.fn(), {
        enabled: true,
        activityJob: agent(),
        setActivityJob,
        setActivityRunningCount: setCount,
      }),
    );
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBeGreaterThan(0);
    });
    const es = FakeEventSource.instances.at(-1)!;
    act(() => {
      es.emit({ type: "done", job: wrap });
    });
    await waitFor(() => {
      expect(setCount).toHaveBeenCalledWith(1);
    });
    expect(setActivityJob).toHaveBeenCalledWith(pipe);
  });

  it("aborts in-flight status fetches and skips reconnect after unmount", async () => {
    let abortCount = 0;
    loadPipelineStatus.mockImplementation((init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          abortCount += 1;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    });
    const { unmount } = renderHook(() =>
      usePipelineJob(null, vi.fn(), { enabled: true }),
    );
    await waitFor(() => {
      expect(loadPipelineStatus).toHaveBeenCalled();
    });
    unmount();
    expect(abortCount).toBeGreaterThan(0);
    const before = FakeEventSource.instances.length;
    await act(async () => {
      await Promise.resolve();
    });
    expect(FakeEventSource.instances.length).toBe(before);
  });
});

describe("applyPipelineJobStatus", () => {
  it("clears pipelineJob when no pipeline-kind row is present", () => {
    const setPipelineJob = vi.fn();
    const setActivityJob = vi.fn();
    const setCount = vi.fn();
    applyPipelineJobStatus(
      {
        running: true,
        running_count: 1,
        job: job({ id: "b1", kind: "bounce" }),
        jobs: [job({ id: "b1", kind: "bounce" })],
      },
      setPipelineJob,
      setActivityJob,
      setCount,
    );
    expect(setPipelineJob).toHaveBeenCalledWith(null);
    expect(setActivityJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: "b1", kind: "bounce" }),
    );
    expect(setCount).toHaveBeenCalledWith(1);
  });

  it("keeps a live pipeline job even when an agent job is primary", () => {
    const setPipelineJob = vi.fn();
    const pipe = job({ id: "p1", kind: "pipeline" });
    const wrap = job({ id: "a1", kind: "agent" });
    applyPipelineJobStatus(
      {
        running: true,
        running_count: 2,
        job: wrap,
        jobs: [pipe, wrap],
      },
      setPipelineJob,
    );
    expect(setPipelineJob).toHaveBeenCalledWith(pipe);
  });
});

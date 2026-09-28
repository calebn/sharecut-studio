import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzePipeline, startPipelineAnalyze } from "./api";
import { SHARE_PREFIX } from "./shareMode";
import type { PipelineJobSnapshot } from "./types/pipeline";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CLOSED = 2;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readyState = 0;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(job: PipelineJobSnapshot) {
    this.onmessage?.({ data: JSON.stringify({ job }) } as MessageEvent);
  }
}

function analyzeJob(
  overrides: Partial<PipelineJobSnapshot> = {},
): PipelineJobSnapshot {
  return {
    id: "an-1",
    project_path: "/tmp/p.json",
    from_step: null,
    only_step: null,
    kind: "analyze",
    label: "Analyze",
    status: "queued",
    current: null,
    total: null,
    message: null,
    error: null,
    elapsed_sec: 0,
    steps: [],
    result: null,
    ...overrides,
  };
}

describe("analyze job helpers", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves the Analyze result and seeds the caller with the queued job", async () => {
    let postBody: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.includes("/api/pipeline/analyze") && init?.method === "POST") {
          postBody = JSON.parse(init?.body as string);
          return new Response(JSON.stringify({ job: analyzeJob() }), {
            status: 200,
          });
        }
        if (url.includes("/api/pipeline/status")) {
          return new Response(
            JSON.stringify({
              running: false,
              job: analyzeJob({
                status: "ok",
                result: {
                  reasons: [{ code: "hum", message: "m" }],
                  patches: {},
                  applied: true,
                },
              }),
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const onJob = vi.fn();
    const result = await analyzePipeline("/tmp/p.json", {
      apply: true,
      onJob,
    });
    expect(result?.reasons[0]?.code).toBe("hum");
    expect(onJob).toHaveBeenCalledTimes(1);
    expect(onJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: "an-1", status: "queued" }),
    );
    expect(postBody).toEqual({ path: "/tmp/p.json", apply: true });
  });

  it("resolves null when the job is cancelled with no result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.includes("/api/pipeline/analyze") && init?.method === "POST") {
          return new Response(JSON.stringify({ job: analyzeJob() }), {
            status: 200,
          });
        }
        if (url.includes("/api/pipeline/status")) {
          return new Response(
            JSON.stringify({
              running: false,
              job: analyzeJob({
                status: "cancelled",
                message: "Analyze cancelled",
                result: null,
              }),
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    await expect(analyzePipeline("/tmp/p.json")).resolves.toBeNull();
  });

  it("throws the job error when Analyze fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.includes("/api/pipeline/analyze") && init?.method === "POST") {
          return new Response(JSON.stringify({ job: analyzeJob() }), {
            status: 200,
          });
        }
        if (url.includes("/api/pipeline/status")) {
          return new Response(
            JSON.stringify({
              running: false,
              job: analyzeJob({
                status: "error",
                error: "decode failed",
                result: null,
              }),
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    await expect(analyzePipeline("/tmp/p.json")).rejects.toThrow(
      /decode failed/,
    );
  });

  it("rejects for a shared guest project key without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(startPipelineAnalyze(`${SHARE_PREFIX}abc123`)).rejects.toThrow(
      /shared guests/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

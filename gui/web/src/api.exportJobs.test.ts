import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bounceAudio,
  exportDeliverables,
  followExportJob,
  waitForPipelineJob,
} from "./api";
import { JOB_STREAM_RECHECK_MS } from "./api/pipeline";
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

  emitError() {
    this.onerror?.();
  }
}

function okJob(
  id: string,
  kind: PipelineJobSnapshot["kind"],
  paths: string[],
): PipelineJobSnapshot {
  return {
    id,
    project_path: "/tmp/p.json",
    from_step: null,
    only_step: null,
    kind,
    status: "ok",
    current: null,
    total: null,
    message: "done",
    error: null,
    elapsed_sec: 1,
    steps: [],
    result: { paths },
  };
}

async function waitForEventSource(): Promise<FakeEventSource> {
  await vi.waitFor(() => {
    if (FakeEventSource.instances.length === 0) {
      throw new Error("no EventSource yet");
    }
  });
  return FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
}

describe("export job helpers", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("followExportJob returns snapshot paths when the job is ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            running: false,
            job: okJob("j1", "bounce", ["/tmp/b.wav"]),
          }),
          { status: 200 },
        );
      }),
    );
    await expect(followExportJob("j1", "Bounce failed")).resolves.toEqual([
      "/tmp/b.wav",
    ]);
  });

  it("followExportJob throws when the snapshot is cancelled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            running: false,
            job: {
              ...okJob("j3", "bounce", ["/tmp/b.wav"]),
              status: "cancelled",
              message: "Bounce cancelled",
            },
          }),
          { status: 200 },
        );
      }),
    );
    await expect(followExportJob("j3", "Bounce failed")).rejects.toThrow(
      /Bounce cancelled/,
    );
  });

  it("followExportJob matches jobs[] when job is a different id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            running: true,
            job: okJob("other", "pipeline", []),
            jobs: [
              okJob("other", "pipeline", []),
              okJob("wanted", "export", ["/tmp/ep.wav"]),
            ],
          }),
          { status: 200 },
        );
      }),
    );
    await expect(followExportJob("wanted", "Export failed")).resolves.toEqual([
      "/tmp/ep.wav",
    ]);
  });

  it("followExportJob returns empty paths when result.paths is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            running: false,
            job: { ...okJob("j4", "bounce", []), result: null },
          }),
          { status: 200 },
        );
      }),
    );
    await expect(followExportJob("j4", "Bounce failed")).resolves.toEqual([]);
  });

  it("resolves from the early status check without opening EventSource", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            running: false,
            job: okJob("j1", "bounce", ["/tmp/b.wav"]),
          }),
          { status: 200 },
        );
      }),
    );
    await followExportJob("j1", "Bounce failed");
    expect(FakeEventSource.instances).toEqual([]);
  });

  it("followExportJob throws the job error when the snapshot is failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            running: false,
            job: {
              ...okJob("j2", "export", []),
              status: "error",
              error: "no bounceable tracks",
              result: null,
            },
          }),
          { status: 200 },
        );
      }),
    );
    await expect(followExportJob("j2", "Export failed")).rejects.toThrow(
      /no bounceable tracks/,
    );
  });

  it("waitForPipelineJob rejects when the signal aborts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ running: true, job: null, jobs: [] }),
          { status: 200 },
        );
      }),
    );
    const ac = new AbortController();
    const pending = waitForPipelineJob("live", {
      timeoutMs: 5_000,
      signal: ac.signal,
    });
    const es = await waitForEventSource();
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(es.closed).toBe(true);
  });

  it("follows the job's SSE stream to done", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ running: true, job: null, jobs: [] }),
          { status: 200 },
        );
      }),
    );
    const pending = waitForPipelineJob("live", { timeoutMs: 5_000 });
    const es = await waitForEventSource();
    es.emit(okJob("live", "pipeline", ["/tmp/out.wav"]));
    await expect(pending).resolves.toMatchObject({
      id: "live",
      status: "ok",
    });
    expect(es.closed).toBe(true);
  });

  it("does not poll status while the stream is open", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ running: true, job: null, jobs: [] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const pending = waitForPipelineJob("live", { timeoutMs: 60_000 });
    const es = await waitForEventSource();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    es.emit(okJob("live", "pipeline", []));
    await pending;
  });

  it("resolves from the slow status re-check when the open stream goes silent", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        const done = calls > 1;
        return new Response(
          JSON.stringify({
            running: !done,
            job: done ? okJob("live", "pipeline", []) : null,
            jobs: [],
          }),
          { status: 200 },
        );
      }),
    );
    const pending = waitForPipelineJob("live", { timeoutMs: 600_000 });
    await vi.advanceTimersByTimeAsync(0);
    const es = FakeEventSource.instances[0]!;
    await vi.advanceTimersByTimeAsync(JOB_STREAM_RECHECK_MS);
    await expect(pending).resolves.toMatchObject({ id: "live", status: "ok" });
    expect(es.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects when the stream closes with no terminal job", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ running: true, job: null, jobs: [] }),
          { status: 200 },
        );
      }),
    );
    const pending = waitForPipelineJob("live", { timeoutMs: 5_000 });
    const es = await waitForEventSource();
    es.close();
    es.emitError();
    await expect(pending).rejects.toThrow(/Lost connection/);
  });

  it("resolves from a status re-check on SSE error", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        const done = calls > 1;
        return new Response(
          JSON.stringify({
            running: !done,
            job: done ? okJob("live", "pipeline", ["/tmp/out.wav"]) : null,
            jobs: [],
          }),
          { status: 200 },
        );
      }),
    );
    const pending = waitForPipelineJob("live", { timeoutMs: 5_000 });
    const es = await waitForEventSource();
    es.emitError();
    await expect(pending).resolves.toMatchObject({
      id: "live",
      status: "ok",
    });
  });

  it("bounceAudio and exportDeliverables POST then follow job_id", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.includes("/api/export/bounce") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              job_id: "b1",
              job: {
                ...okJob("b1", "bounce", []),
                status: "queued",
                result: null,
              },
            }),
            { status: 200 },
          );
        }
        if (
          url.includes("/api/export/deliverables") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({
              job_id: "e1",
              job: {
                ...okJob("e1", "export", []),
                status: "queued",
                result: null,
              },
            }),
            { status: 200 },
          );
        }
        if (url.includes("/api/pipeline/status")) {
          return new Response(
            JSON.stringify({
              running: false,
              jobs: [
                okJob("b1", "bounce", ["/tmp/b.wav"]),
                okJob("e1", "export", ["/tmp/ep.wav"]),
              ],
              job: okJob("e1", "export", ["/tmp/ep.wav"]),
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      bounceAudio("/tmp/p.json", { formats: ["wav"] }),
    ).resolves.toEqual(["/tmp/b.wav"]);
    await expect(exportDeliverables("/tmp/p.json")).resolves.toEqual([
      "/tmp/ep.wav",
    ]);
  });
});

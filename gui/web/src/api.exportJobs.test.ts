import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bounceAudio,
  exportDeliverables,
  followExportJob,
  waitForPipelineJob,
} from "./api";
import type { PipelineJobSnapshot } from "./types/pipeline";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
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

describe("export job helpers", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
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

  it("followExportJob does not open EventSource (poll-only)", async () => {
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
      pollOnly: true,
      timeoutMs: 5_000,
      pollMs: 20,
      signal: ac.signal,
    });
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeEventSource.instances).toEqual([]);
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

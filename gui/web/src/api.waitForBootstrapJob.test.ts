import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type BootstrapJobSnapshot, waitForBootstrapJob } from "./api";

type Handler = ((ev: MessageEvent) => void) | null;
type ErrHandler = (() => void) | null;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: Handler = null;
  onerror: ErrHandler = null;
  closed = false;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  emitError() {
    this.onerror?.();
  }
}

function okJob(id: string): BootstrapJobSnapshot {
  return {
    id,
    kind: "bootstrap",
    components: ["whisper"],
    whisper_model: "small.en",
    status: "ok",
  };
}

describe("waitForBootstrapJob", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves when SSE reports status ok", async () => {
    const p = waitForBootstrapJob("job-1");
    const es = FakeEventSource.instances[0]!;
    es.emit({ type: "status", job: okJob("job-1") });
    await expect(p).resolves.toMatchObject({ id: "job-1", status: "ok" });
    expect(es.closed).toBe(true);
  });

  it("rejects on terminal SSE error status", async () => {
    const p = waitForBootstrapJob("job-err");
    const es = FakeEventSource.instances[0]!;
    es.emit({
      type: "status",
      job: {
        id: "job-err",
        kind: "bootstrap",
        components: ["whisper"],
        whisper_model: "small.en",
        status: "error",
        error: "network down",
      },
    });
    await expect(p).rejects.toThrow(/network down/);
  });

  it("polls status-job on EventSource error and still resolves", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      expect(url).toContain("/api/bootstrap/status-job");
      return new Response(JSON.stringify({ job: okJob("job-poll") }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const p = waitForBootstrapJob("job-poll", { pollMs: 20 });
    const es = FakeEventSource.instances[0]!;
    es.emitError();
    await expect(p).resolves.toMatchObject({ id: "job-poll", status: "ok" });
    expect(fetchMock).toHaveBeenCalled();
  });
});

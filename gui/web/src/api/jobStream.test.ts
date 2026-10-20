import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JOB_STREAM_RECHECK_MS, openJobStream } from "./jobStream";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

describe("openJobStream", () => {
  afterEach(() => {
    FakeEventSource.instances = [];
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("parses frames, drops malformed ones and forwards errors", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const onFrame = vi.fn();
    const onError = vi.fn();
    openJobStream<{ n: number }>({ url: "/x", onFrame, onError });
    const es = FakeEventSource.instances[0];
    es.onmessage?.({ data: "{nope" });
    es.onmessage?.({ data: '{"n":1}' });
    es.onerror?.();
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0][0]).toEqual({ n: 1 });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("runs the recheck while open and stops it on close", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const check = vi.fn().mockResolvedValue(7);
    const onResult = vi.fn();
    const stream = openJobStream<unknown, number>({
      url: "/x",
      onFrame: vi.fn(),
      recheck: { check, onResult },
    });
    await vi.advanceTimersByTimeAsync(JOB_STREAM_RECHECK_MS);
    expect(onResult).toHaveBeenCalledWith(7);
    stream.close();
    expect(FakeEventSource.instances[0].closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("realtime governance", () => {
  it("opens EventSource streams only in api/jobStream.ts", () => {
    const root = join(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          if (readFileSync(path, "utf8").includes("new EventSource(")) {
            offenders.push(path.slice(root.length + 1));
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual(["api/jobStream.ts"]);
  });
});

import { EventEmitter } from "node:events";
import type { Page } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NATIVE_PROGRESS_LIMITS } from "./nativeProgressCore";
import {
  armNativeProgress,
  retainNativeProgress,
} from "./nativeProgressObserver";

function harness(failArm = false, failDetach = false) {
  const cdp = Object.assign(new EventEmitter(), {
    send: vi.fn(async () => {
      if (failArm) throw new Error("CDP unavailable");
    }),
    detach: vi.fn(async () => {
      if (failDetach) throw new Error("detach failed");
    }),
  });
  const page = Object.assign(new EventEmitter(), {
    context: () => ({ newCDPSession: async () => cdp }),
    evaluate: vi.fn(async (fn: (arg: unknown) => unknown, arg: unknown) =>
      fn(arg),
    ),
  });
  document.body.innerHTML = '<div class="pipeline-panel"></div>';
  return { cdp, page, asPage: page as unknown as Page };
}
const job = {
  id: "native-one",
  status: "running",
  current: 0,
  total: 2,
  steps: [],
};
afterEach(() => {
  window.__nativeProgressObserver?.finish();
  delete window.__nativeProgressObserver;
  document.body.innerHTML = "";
});
describe("native observer lifecycle and failure retention", () => {
  it("keeps actual stream epochs and does not mistake an unrelated EventSource for native input", async () => {
    const { cdp, asPage } = harness();
    const observation = await armNativeProgress(asPage);
    expect(observation.available).toBe(true);
    cdp.emit("Network.requestWillBeSent", {
      requestId: "other",
      type: "EventSource",
      request: { url: "/api/bootstrap/events" },
    });
    cdp.emit("Network.eventSourceMessageReceived", {
      requestId: "other",
      timestamp: 1,
      data: "irrelevant",
    });
    for (const requestId of ["first", "reconnected"]) {
      cdp.emit("Network.requestWillBeSent", {
        requestId,
        request: { url: "/api/pipeline/events?job_id=native-one" },
      });
      cdp.emit("Network.loadingFinished", { requestId, timestamp: 1.5 });
      cdp.emit("Network.eventSourceMessageReceived", {
        requestId,
        timestamp: 2,
        data: JSON.stringify({ type: "status", job }),
      });
    }
    observation.core.bind(job, 100);
    const first = await observation.finish();
    const second = await observation.finish();
    expect(first).toBe(second);
    expect(
      first.inputs
        .filter((input) => input.source === "sse-network")
        .map((input) => input.streamEpoch),
    ).toEqual([2, 3]);
    expect(first.channelAvailability.nativeReceipt).toBe("observed");
    expect(first.channelAvailability.dom).toBe("unavailable");
    expect(first.binding.valid).toBe(false);
    expect(first.cleanupFailures).toEqual([]);
    expect(cdp.detach).toHaveBeenCalledTimes(1);
    expect(cdp.eventNames()).toEqual([]);
    const count = first.inputs.length;
    cdp.emit("Network.eventSourceMessageReceived", {
      requestId: "first",
      timestamp: 3,
      data: JSON.stringify({ job }),
    });
    expect(first.inputs).toHaveLength(count);
  });
  it("retains arm failure and releases partially installed CDP resources", async () => {
    const { cdp, asPage } = harness(true);
    const observation = await armNativeProgress(asPage);
    expect(observation.available).toBe(false);
    const evidence = await observation.finish();
    expect(evidence.issues).toContain("observer: CDP unavailable");
    expect(cdp.detach).toHaveBeenCalledTimes(1);
  });
  it("bounds foreign request identities and drains passive consumer status separately", async () => {
    const { cdp, page, asPage } = harness();
    const observation = await armNativeProgress(asPage);
    observation.core.bind(job, 0);
    page.emit("response", {
      url: () => "/api/pipeline/status",
      headers: () => ({}),
      text: async () => JSON.stringify({ job: { ...job, current: 1 } }),
    });
    for (let i = 0; i <= NATIVE_PROGRESS_LIMITS.requests; i++)
      cdp.emit("Network.requestWillBeSent", {
        requestId: String(i),
        type: "EventSource",
        request: { url: "/foreign/events" },
      });
    const evidence = await observation.finish();
    expect(
      evidence.inputs.find((input) => input.source === "consumer-status")?.job
        .percent,
    ).toBe(50);
    expect(evidence.issues).toContain("request identity map capped");
    expect(page.eventNames()).toEqual([]);
  });
  it("retains sole cleanup failure and preserves primary action failure through finish or attachment failure", async () => {
    const { cdp, asPage } = harness(false, true);
    const observation = await armNativeProgress(asPage);
    observation.core.bind(job, 0);
    const evidence = await observation.finish();
    expect(evidence.cleanupFailures[0]).toContain("detach failed");
    expect(cdp.eventNames()).toEqual([]);
    const secondary = vi.fn();
    const primary = new Error("native action failed");
    await expect(
      retainNativeProgress(
        primary,
        async () => {
          throw new Error("finish failed");
        },
        async () => {},
        secondary,
      ),
    ).resolves.toBeUndefined();
    await expect(
      retainNativeProgress(
        primary,
        async () => evidence,
        async () => {
          throw new Error("attachment failed");
        },
        secondary,
      ),
    ).resolves.toBeUndefined();
    expect(secondary).toHaveBeenCalledTimes(2);
    await expect(
      retainNativeProgress(
        undefined,
        async () => evidence,
        async () => {
          throw new Error("sole retention failure");
        },
        secondary,
      ),
    ).rejects.toThrow("sole retention failure");
  });
  it("marks a mapped stream with no receipt incomplete and control channels intentionally disabled", async () => {
    const fixture = harness();
    const passive = await armNativeProgress(fixture.asPage);
    passive.core.bind(job, 0);
    passive.core.recordTerminal({ ...job, current: 2, status: "ok" });
    fixture.cdp.emit("Network.requestWillBeSent", {
      requestId: "silent",
      request: { url: "/api/pipeline/events?job_id=native-one" },
    });
    const missing = await passive.finish();
    expect(missing.naturalProcessing).toBe("succeeded");
    expect(missing.channelAvailability.nativeReceipt).toBe("unavailable");
    expect(missing.observationIntegrity).toBe("incomplete");
    delete window.__nativeProgressObserver;
    const control = await armNativeProgress(fixture.asPage, true);
    control.core.bind(job, 0);
    control.core.recordTerminal({ ...job, current: 2, status: "ok" });
    const disabled = await control.finish();
    expect(disabled.channelAvailability).toEqual({
      nativeReceipt: "disabled-control",
      dom: "disabled-control",
      geometry: "disabled-control",
    });
    expect(disabled.observationIntegrity).toBe("disabled-control");
    expect(disabled.binding.valid).toBe(false);
    expect(disabled.naturalProcessing).toBe("succeeded");
  });
});

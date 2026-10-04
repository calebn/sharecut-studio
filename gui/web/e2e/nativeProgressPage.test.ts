import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NATIVE_PROGRESS_LIMITS,
  reconstructMutations,
} from "./nativeProgressCore";
import { installNativeProgressPage } from "./nativeProgressPage";

let frames: Map<number, FrameRequestCallback>;
let sequence: number;
beforeEach(() => {
  document.body.innerHTML = '<div><div class="pipeline-panel"></div></div>';
  frames = new Map();
  sequence = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++sequence;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => {
  window.__nativeProgressObserver?.finish();
  delete window.__nativeProgressObserver;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
function bar() {
  const element = document.createElement("div");
  element.className = "pipeline-bar";
  element.setAttribute("role", "progressbar");
  element.setAttribute("aria-valuenow", "0");
  element.innerHTML = '<div class="pipeline-bar-fill"></div>';
  document.querySelector(".pipeline-panel")!.append(element);
  return element;
}
function tick() {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(performance.now());
}
describe("native DOM/layout observer conformance", () => {
  it("drains a fast zero/fifty/hundred mutation batch without inventing a zero frame", () => {
    installNativeProgressPage(NATIVE_PROGRESS_LIMITS);
    const element = bar();
    element.setAttribute("aria-valuenow", "50");
    element.setAttribute("aria-valuenow", "100");
    const evidence = window.__nativeProgressObserver!.finish();
    const mutations = reconstructMutations(evidence.dom).filter(
      (record) => record.kind === "attribute",
    );
    expect(mutations.map((record) => record.oldValue)).toEqual(["0", "50"]);
    expect(mutations.map((record) => record.reconstructedValue)).toEqual([
      "50",
      "100",
    ]);
    expect(evidence.geometry).toEqual([]);
    expect(evidence.unsampledOnFinish).toBe(true);
    expect(frames.size).toBe(0);
    expect(window.__nativeProgressObserver!.finish()).toBe(evidence);
  });
  it("records indeterminate presence separately from absent bar and a later determinate value", async () => {
    installNativeProgressPage(NATIVE_PROGRESS_LIMITS);
    const pulse = document.createElement("span");
    pulse.dataset.testid = "pipeline-pulse";
    document.querySelector(".pipeline-panel")!.append(pulse);
    await Promise.resolve();
    pulse.remove();
    const element = bar();
    element.setAttribute("aria-valuenow", "50");
    await Promise.resolve();
    const evidence = window.__nativeProgressObserver!.finish();
    expect(
      evidence.dom
        .filter((record) => record.kind === "indeterminate")
        .map((record) => record.valueAtDelivery),
    ).toEqual(["false", "true", "false"]);
    expect(evidence.geometry).toEqual([]);
  });
  it("retains offscreen geometry and coalesces scroll sampling without a continuous RAF loop", async () => {
    installNativeProgressPage(NATIVE_PROGRESS_LIMITS);
    const element = bar();
    element.getBoundingClientRect = () =>
      ({
        width: 100,
        height: 8,
        top: -1,
        bottom: 7,
        left: 10,
        right: 110,
      }) as DOMRect;
    element.querySelector(".pipeline-bar-fill")!.getBoundingClientRect = () =>
      ({ width: 0, height: 8 }) as DOMRect;
    await Promise.resolve();
    tick();
    expect(frames.size).toBe(0);
    document.dispatchEvent(new Event("scroll"));
    document.dispatchEvent(new Event("scroll"));
    expect(frames.size).toBe(1);
    tick();
    const evidence = window.__nativeProgressObserver!.finish();
    expect(evidence.geometry).toHaveLength(2);
    expect(
      evidence.geometry.every((record) =>
        record.excluded.includes("offscreen"),
      ),
    ).toBe(true);
    expect(evidence.geometryReadCount).toBe(4);
    document.dispatchEvent(new Event("scroll"));
    expect(frames.size).toBe(0);
  });
  it("keeps bar generations separate and flags root destruction", async () => {
    installNativeProgressPage(NATIVE_PROGRESS_LIMITS);
    const first = bar();
    await Promise.resolve();
    first.remove();
    bar();
    await Promise.resolve();
    document.querySelector(".pipeline-panel")!.remove();
    const evidence = window.__nativeProgressObserver!.finish();
    const added = evidence.dom.filter((record) => record.kind === "added");
    expect(new Set(added.map((record) => record.node)).size).toBe(2);
    expect(evidence.issues).toContain(
      "bar generation changed; cross-generation attribution ambiguous",
    );
    expect(evidence.issues).toContain("Pipeline root detached before finish");
  });
  it("rejects horizontal overflow, CSS hidden bars, and clipping inside a scroll ancestor", async () => {
    for (const scenario of ["horizontal", "hidden", "ancestor"]) {
      installNativeProgressPage(NATIVE_PROGRESS_LIMITS);
      const element = bar();
      const panel = document.querySelector(".pipeline-panel") as HTMLElement;
      const rect = {
        width: 100,
        height: 8,
        top: 20,
        bottom: 28,
        left: 10,
        right: 110,
      };
      element.getBoundingClientRect = () =>
        ({
          ...rect,
          ...(scenario === "horizontal" ? { left: -20, right: 80 } : {}),
        }) as DOMRect;
      element.querySelector(".pipeline-bar-fill")!.getBoundingClientRect = () =>
        ({ width: 50, height: 8 }) as DOMRect;
      if (scenario === "hidden") element.style.visibility = "hidden";
      if (scenario === "ancestor") {
        panel.style.overflowX = "hidden";
        panel.style.overflowY = "hidden";
        panel.getBoundingClientRect = () =>
          ({
            left: 0,
            right: 120,
            top: 0,
            bottom: 24,
            width: 120,
            height: 24,
          }) as DOMRect;
        Object.defineProperties(panel, {
          clientWidth: { value: 120 },
          clientHeight: { value: 24 },
        });
      }
      await Promise.resolve();
      tick();
      const evidence = window.__nativeProgressObserver!.finish();
      expect(evidence.geometry).toHaveLength(1);
      expect(evidence.geometry[0]!.qualification, scenario).toBe("excluded");
      expect(evidence.geometry[0]!.excluded).toContain(
        scenario === "horizontal"
          ? "offscreen"
          : scenario === "hidden"
            ? "CSS-hidden"
            : "rectangularly-clipped",
      );
      expect(evidence.geometry[0]!.styleReadCount).toBeGreaterThan(1);
      delete window.__nativeProgressObserver;
      document.body.innerHTML = '<div><div class="pipeline-panel"></div></div>';
    }
  });
  it("marks nonrectangular clip and capped ancestor chains unknown rather than qualified", async () => {
    for (const scenario of ["clip", "depth"]) {
      if (scenario === "depth") {
        document.body.innerHTML =
          "<div>".repeat(NATIVE_PROGRESS_LIMITS.ancestors + 1) +
          '<div class="pipeline-panel"></div>' +
          "</div>".repeat(NATIVE_PROGRESS_LIMITS.ancestors + 1);
      }
      installNativeProgressPage(NATIVE_PROGRESS_LIMITS);
      const element = bar();
      element.getBoundingClientRect = () =>
        ({
          width: 100,
          height: 8,
          top: 20,
          bottom: 28,
          left: 10,
          right: 110,
        }) as DOMRect;
      element.querySelector(".pipeline-bar-fill")!.getBoundingClientRect = () =>
        ({ width: 50, height: 8 }) as DOMRect;
      if (scenario === "clip") element.style.clipPath = "circle(2px)";
      await Promise.resolve();
      tick();
      const evidence = window.__nativeProgressObserver!.finish();
      expect(evidence.geometry[0]!.qualification).toBe("unknown");
      expect(evidence.geometry[0]!.excluded).toContain(
        scenario === "clip"
          ? "nonrectangular-clip-or-mask"
          : "ancestor-chain-capped",
      );
      expect(evidence.geometry[0]!.ancestorsChecked).toBeLessThanOrEqual(
        NATIVE_PROGRESS_LIMITS.ancestors,
      );
      delete window.__nativeProgressObserver;
      document.body.innerHTML = '<div><div class="pipeline-panel"></div></div>';
    }
  });
});

import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useRecordHostStore } from "../record/hostStore";
import { recordSnapshot } from "../test/fixtures";
import { stubRaf } from "../test/raf";
import { RecordingOverlay } from "./RecordingOverlay";

afterEach(() => {
  useRecordHostStore.getState().setSnapshot(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("grows an aggregate band, freezes paused geometry, corrects and clears with stale queued callbacks harmless", () => {
  const raf = stubRaf();
  const requests = vi.spyOn(globalThis, "requestAnimationFrame");
  vi.spyOn(performance, "now").mockReturnValue(100);
  const store = useRecordHostStore.getState();
  store.setSnapshot(
    recordSnapshot({
      timeline_start_sec: 7,
      recording_ms: 1000,
      server_time_ns: 1,
    }),
  );
  const view = render(
    <RecordingOverlay zoomPxPerSec={10} trailingPadPx={400} />,
  );
  const band = () =>
    view.container.querySelector<HTMLElement>(".recording-overlay-band")!;
  const extent = () =>
    view.container.querySelector<HTMLElement>(".recording-overlay")!;
  const staleCallback = requests.mock.calls[0]![0];
  expect(band().style.left).toBe("70px");
  expect(band().style.width).toBe("10px");
  act(() => raf.fire(60100));
  expect(band().style.width).toBe("610px");
  expect(extent().style.width).toBe("1080px");
  act(() =>
    store.setSnapshot(
      recordSnapshot({
        state: "paused",
        timeline_start_sec: 7,
        recording_ms: 2000,
        server_time_ns: 2,
      }),
    ),
  );
  expect(screen.getByRole("img").getAttribute("aria-label")).toContain(
    "paused",
  );
  expect(band().style.width).toBe("20px");
  expect(raf.pendingCount()).toBe(0);
  act(() => raf.fire(100000));
  expect(band().style.width).toBe("20px");
  act(() =>
    store.setSnapshot(
      recordSnapshot({
        timeline_start_sec: 7,
        recording_ms: 2000,
        server_time_ns: 3,
      }),
    ),
  );
  expect(raf.pendingCount()).toBe(1);
  act(() =>
    store.setSnapshot(recordSnapshot({ state: "stopped", server_time_ns: 4 })),
  );
  expect(screen.queryByRole("img")).toBeNull();
  expect(raf.pendingCount()).toBe(0);
  act(() => {
    raf.fire(200000);
    staleCallback(200000);
  });
  expect(view.container.children).toHaveLength(0);
  act(() =>
    store.setSnapshot(
      recordSnapshot({
        timeline_start_sec: 0,
        recording_ms: 0,
        server_time_ns: 5,
      }),
    ),
  );
  view.unmount();
  expect(raf.pendingCount()).toBe(0);
});

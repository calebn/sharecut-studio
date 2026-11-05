import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import {
  StrictMode,
  Suspense,
  startTransition,
  useLayoutEffect,
  useState,
} from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { guestRoomPhase } from "../record/guestRoomModel";
import { deferred } from "../test/deferred";
import { recordSnapshot } from "../test/fixtures";
import { createReceiptElapsedSample } from "./sampledClocks";
import { useElapsedFromReceipt } from "./useElapsedSince";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type Props = { snapshot: object | null; active: boolean };
function setup(snapshot: object | null, active = true) {
  return renderHook(
    (props: Props) => useElapsedFromReceipt(props.snapshot, props.active),
    { initialProps: { snapshot, active } },
  );
}
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

it("retains same-object history and refreshes an equal new object without replacing its timer", () => {
  const scheduled = vi.spyOn(window, "setInterval");
  const a = { state: "recording" };
  const { result, rerender } = setup(a);
  advance(1000);
  expect(result.current).toBe(1000);
  advance(200);
  rerender({ snapshot: a, active: true });
  expect(result.current).toBe(1000);
  rerender({ snapshot: { ...a }, active: true });
  expect(result.current).toBe(0);
  advance(800);
  expect(result.current).toBe(800);
  expect(scheduled).toHaveBeenCalledOnce();
});

it("retains the origin through null and reacquires it when the same object returns", () => {
  const a = { state: "recording" };
  const { result, rerender } = setup(a);
  advance(1000);
  rerender({ snapshot: null, active: false });
  expect(result.current).toBe(1000);
  advance(5000);
  expect(result.current).toBe(1000);
  rerender({ snapshot: a, active: false });
  expect(result.current).toBe(0);
  advance(1000);
  rerender({ snapshot: a, active: true });
  expect(result.current).toBe(0);
  advance(999);
  expect(result.current).toBe(0);
  advance(1);
  expect(result.current).toBe(2000);
});

it("receives just before an armed deadline without restarting the single interval", () => {
  const scheduled = vi.spyOn(window, "setInterval");
  const { result, rerender } = setup(null);
  advance(999);
  expect(result.current).toBe(0);
  rerender({ snapshot: {}, active: true });
  expect(result.current).toBe(0);
  advance(1);
  expect(result.current).toBe(1);
  expect(scheduled).toHaveBeenCalledOnce();
});

it("keeps receipt and later committed-origin sampling as two observations", () => {
  const read = vi.spyOn(performance, "now").mockReturnValue(0);
  const layout = vi
    .fn()
    .mockImplementationOnce(() => read.mockReturnValue(100))
    .mockImplementationOnce(() => read.mockReturnValue(175));
  const snapshot = {};
  const { result } = renderHook(() => {
    const elapsed = useElapsedFromReceipt(snapshot, false);
    useLayoutEffect(() => {
      layout();
    });
    return elapsed;
  });
  expect(result.current).toBe(75);
  expect(vi.getTimerCount()).toBe(0);
});

it("freezes inactive samples and resamples a new inactive snapshot", () => {
  const snapshot = {};
  const { result, rerender } = setup(snapshot);
  advance(1000);
  rerender({ snapshot, active: false });
  advance(5000);
  expect(result.current).toBe(1000);
  rerender({ snapshot: {}, active: false });
  expect(result.current).toBe(0);
  advance(1000);
  expect(result.current).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps one live interval through replay and removes it on unmount", () => {
  const scheduled = vi.spyOn(window, "setInterval");
  const snapshot = {};
  const { result, unmount } = renderHook(
    () => useElapsedFromReceipt(snapshot, true),
    { wrapper: StrictMode },
  );
  expect(vi.getTimerCount()).toBe(1);
  expect(scheduled).toHaveBeenCalledTimes(2);
  advance(1000);
  expect(result.current).toBe(1000);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not receive an attempted suspended snapshot", async () => {
  const a = {};
  const b = {};
  const pending = deferred();
  const consumed = vi.spyOn(pending.promise, "then");
  function Probe({ snapshot }: { snapshot: object }) {
    const elapsed = useElapsedFromReceipt(snapshot, true);
    if (snapshot === b) throw pending.promise;
    return <output aria-label="Elapsed">{elapsed}</output>;
  }
  function Host() {
    const [snapshot, setSnapshot] = useState(a);
    return (
      <>
        <button
          type="button"
          onClick={() => startTransition(() => setSnapshot(b))}
        >
          Attempt snapshot
        </button>
        <button type="button" onClick={() => setSnapshot(a)}>
          Keep snapshot
        </button>
        <Suspense fallback={<p>Loading clock</p>}>
          <Probe snapshot={snapshot} />
        </Suspense>
      </>
    );
  }
  render(<Host />);
  advance(1500);
  expect(screen.getByLabelText("Elapsed")).toHaveTextContent("1000");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Attempt snapshot" }));
  });
  expect(consumed).toHaveBeenCalled();
  expect(screen.queryByText("Loading clock")).not.toBeInTheDocument();
  advance(500);
  expect(screen.getByLabelText("Elapsed")).toHaveTextContent("2000");
  fireEvent.click(screen.getByRole("button", { name: "Keep snapshot" }));
  expect(screen.getByLabelText("Elapsed")).toHaveTextContent("2000");
});

it("uses the committed snapshot when identity updates are co-batched", () => {
  const a = {};
  const b = {};
  const c = {};
  function Host() {
    const [snapshot, setSnapshot] = useState(a);
    const elapsed = useElapsedFromReceipt(snapshot, true);
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setSnapshot(b);
            setSnapshot(c);
          }}
        >
          Receive pair
        </button>
        <output aria-label="Elapsed">{elapsed}</output>
        <p>{snapshot === c ? "Committed C" : "Committed A"}</p>
      </>
    );
  }
  render(<Host />);
  advance(500);
  fireEvent.click(screen.getByRole("button", { name: "Receive pair" }));
  expect(screen.getByText("Committed C")).toBeInTheDocument();
  expect(screen.getByLabelText("Elapsed")).toHaveTextContent("0");
  advance(500);
  expect(screen.getByLabelText("Elapsed")).toHaveTextContent("500");
});

it("advances lobby countdown and recording phase with the existing guest adapter", () => {
  const lobby = recordSnapshot({
    state: "lobby",
    countdown_left_ms: 5000,
    room_tone: {
      round: 1,
      requested_wall_ms: 0,
      duration_ms: 5000,
      participant_ids: [],
    },
  });
  const { result, rerender } = setup(lobby);
  advance(2000);
  expect(
    guestRoomPhase(lobby, { elapsedSinceSnapshotMs: result.current }),
  ).toEqual({ kind: "countdown", secondsLeft: 3 });
  const recording = recordSnapshot({ state: "recording", recording_ms: 4000 });
  rerender({ snapshot: recording, active: true });
  advance(1000);
  expect(
    guestRoomPhase(recording, { elapsedSinceSnapshotMs: result.current }),
  ).toMatchObject({ kind: "live", clockSec: 5 });
});

it("caches clock snapshots and preserves a newer receipt during older committed sampling", () => {
  const read = vi.spyOn(performance, "now").mockReturnValue(100);
  const clock = createReceiptElapsedSample();
  const get = clock.getSnapshot;
  const subscribe = clock.subscribe;
  const initial = get();
  expect(read).toHaveBeenCalledOnce();
  expect(get()).toBe(initial);
  expect(vi.getTimerCount()).toBe(0);
  const listener = vi.fn();
  const unsubscribe = subscribe(listener);
  clock.receive();
  clock.sampleOrigin(100);
  const received = get();
  expect(received).toEqual({ origin: 100, now: 100 });
  listener.mockClear();
  clock.receive();
  expect(get()).toBe(received);
  expect(listener).not.toHaveBeenCalled();
  read.mockReturnValue(700);
  clock.receive();
  expect(get()).toEqual({ origin: 700, now: 100 });
  clock.sampleOrigin(100);
  expect(get()).toEqual({ origin: 700, now: 700 });
  expect(clock.getSnapshot).toBe(get);
  expect(clock.subscribe).toBe(subscribe);
  const reads = read.mock.calls.length;
  get();
  get();
  expect(read).toHaveBeenCalledTimes(reads);
  unsubscribe();
});

it("keeps interval eligibility at the last committed origin and retires its callback", () => {
  const callbacks: (() => void)[] = [];
  vi.stubGlobal(
    "setInterval",
    vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length;
    }),
  );
  const clear = vi.spyOn(window, "clearInterval");
  const read = vi.spyOn(performance, "now").mockReturnValue(0);
  const clock = createReceiptElapsedSample();
  const release = clock.connect(true);
  read.mockReturnValue(100);
  clock.receive();
  clock.sampleOrigin(null);
  const waiting = clock.getSnapshot();
  read.mockReturnValue(500);
  callbacks[0]();
  expect(clock.getSnapshot()).toBe(waiting);
  clock.sampleOrigin(100);
  expect(clock.getSnapshot()).toEqual({ origin: 100, now: 500 });
  release();
  release();
  read.mockReturnValue(900);
  callbacks[0]();
  expect(clock.getSnapshot()).toEqual({ origin: 100, now: 500 });
  expect(clear).toHaveBeenCalledOnce();
});

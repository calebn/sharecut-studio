import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { Suspense, startTransition, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { deferred } from "../../test/deferred";
import { MemorySink } from "../keeper/store";
import { memoryUploadTransport } from "./transport";
import { useRecordUpload } from "./useRecordUpload";

afterEach(() => vi.useRealTimers());

it("reads committed capture expectation at the next existing poll without restarting it", async () => {
  vi.useFakeTimers();
  const transport = memoryUploadTransport();
  const read = vi.spyOn(transport, "status");
  const sink = new MemorySink();
  const { result, rerender } = renderHook(
    ({ expected }) =>
      useRecordUpload({
        enabled: true,
        roomState: "stopped",
        captureSettled: true,
        sessionId: "room",
        takeIndex: 0,
        participantId: "me",
        transport,
        sink,
        captureExpected: expected,
      }),
    { initialProps: { expected: false } },
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(read).toHaveBeenCalledTimes(1);
  expect(result.current.pending).toBe(false);
  expect(result.current.error).toBeNull();
  rerender({ expected: true });
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1999);
  });
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect(result.current.error).toContain(
    "No full-quality recording was captured",
  );
  rerender({ expected: false });
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(result.current.error).toBeNull();
  expect(read).toHaveBeenCalledTimes(3);
});

it("does not publish capture expectation from an uncommitted suspended render", async () => {
  vi.useFakeTimers();
  const transport = memoryUploadTransport();
  const read = vi.spyOn(transport, "status");
  const sink = new MemorySink();
  const pending = deferred();
  const consumedGate = vi.spyOn(pending.promise, "then");
  function Probe({ tentative }: { tentative: boolean }) {
    const progress = useRecordUpload({
      enabled: true,
      roomState: "stopped",
      captureSettled: true,
      sessionId: "room",
      takeIndex: 0,
      participantId: "me",
      transport,
      sink,
      captureExpected: tentative,
    });
    if (tentative) throw pending.promise;
    return <p>{progress.error ?? "No upload error"}</p>;
  }
  function Host() {
    const [tentative, setTentative] = useState(false);
    return (
      <>
        <button
          type="button"
          onClick={() => startTransition(() => setTentative(true))}
        >
          Attempt expectation
        </button>
        <Suspense fallback={<p>Loading upload</p>}>
          <Probe tentative={tentative} />
        </Suspense>
      </>
    );
  }
  render(<Host />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(read).toHaveBeenCalledTimes(1);
  expect(screen.getByText("No upload error")).toBeInTheDocument();
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Attempt expectation" }),
    );
  });
  expect(consumedGate).toHaveBeenCalled();
  expect(screen.queryByText("Loading upload")).not.toBeInTheDocument();
  expect(screen.getByText("No upload error")).toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect(screen.getByText("No upload error")).toBeInTheDocument();
  expect(
    screen.queryByText(/No full-quality recording was captured/),
  ).not.toBeInTheDocument();
});

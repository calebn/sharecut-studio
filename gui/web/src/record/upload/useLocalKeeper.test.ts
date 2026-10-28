import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { seedPendingKeeper } from "../../test/keepers";
import { MemorySink } from "../keeper/store";
import { useLocalKeeper } from "./useLocalKeeper";

const ids = { sessionId: "room1", takeIndex: 0, participantId: "p_g" };

function renderKeeper(sink: MemorySink | null, recheck = 0) {
  return renderHook(
    ({ recheck: key, sink: current }) =>
      useLocalKeeper({ sink: current, ...ids, recheck: key }),
    { initialProps: { sink, recheck } },
  );
}

describe("useLocalKeeper", () => {
  it("claims nothing while pending or without a sink", async () => {
    const sink = new MemorySink();
    await seedPendingKeeper(sink, ids);
    expect(renderKeeper(sink).result.current).toBe(false);
    expect(renderKeeper(null).result.current).toBe(false);
  });

  it("finds a WAV that is still on the device, as after a reload", async () => {
    const sink = new MemorySink();
    await seedPendingKeeper(sink, ids);
    const { result } = renderKeeper(sink);
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("is false when nothing was kept", async () => {
    const { result } = renderKeeper(new MemorySink());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current).toBe(false);
  });

  it("drops to false once the keeper is reclaimed and rechecked", async () => {
    const sink = new MemorySink();
    const wavPath = await seedPendingKeeper(sink, ids);
    const { result, rerender } = renderKeeper(sink);
    await waitFor(() => expect(result.current).toBe(true));
    await sink.remove(wavPath);
    rerender({ sink, recheck: 1 });
    await waitFor(() => expect(result.current).toBe(false));
  });
});

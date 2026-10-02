import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetSingleFlightsForTests,
  createSingleFlight,
} from "./singleFlight";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("single-flight slots", () => {
  beforeEach(() => {
    _resetSingleFlightsForTests();
  });

  it("returns work results and releases after success or failure", async () => {
    const flight = createSingleFlight();
    await expect(flight.run(async () => "done")).resolves.toEqual({
      ran: true,
      value: "done",
    });
    await expect(
      flight.run(async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    await expect(flight.run(async () => "again")).resolves.toEqual({
      ran: true,
      value: "again",
    });
  });

  it("blocks reentrant work on one guard while separate guards proceed", async () => {
    const firstFlight = createSingleFlight();
    const secondFlight = createSingleFlight();
    const pending = deferred<string>();
    const first = firstFlight.run(() => pending.promise);
    const duplicate = vi.fn(async () => "duplicate");

    await expect(firstFlight.run(duplicate)).resolves.toEqual({
      ran: false,
    });
    expect(duplicate).not.toHaveBeenCalled();
    await expect(secondFlight.run(async () => "separate")).resolves.toEqual({
      ran: true,
      value: "separate",
    });
    pending.resolve("first");
    await expect(first).resolves.toEqual({ ran: true, value: "first" });
  });

  it("replaces its keyed slot and conditionally releases the current key", async () => {
    const flight = createSingleFlight();
    const projectA = deferred<string>();
    const secondProjectA = deferred<string>();
    const projectB = deferred<string>();
    const firstA = flight.run(() => projectA.promise, "A");
    const runB = flight.run(() => projectB.promise, "B");

    const secondA = flight.run(() => secondProjectA.promise, "A");
    await expect(flight.run(async () => "blocked A", "A")).resolves.toEqual({
      ran: false,
    });
    projectB.resolve("B");
    await expect(runB).resolves.toEqual({ ran: true, value: "B" });
    projectA.resolve("A");
    await expect(firstA).resolves.toEqual({ ran: true, value: "A" });
    await expect(flight.run(async () => "available", "A")).resolves.toEqual({
      ran: true,
      value: "available",
    });
    secondProjectA.resolve("second A");
    await expect(secondA).resolves.toEqual({
      ran: true,
      value: "second A",
    });
  });

  it("keeps a new same-key run after resetting an older pending run", async () => {
    const flight = createSingleFlight();
    const oldWork = deferred<string>();
    const newWork = deferred<string>();
    const stale = flight.run(() => oldWork.promise, "project");
    _resetSingleFlightsForTests();
    const current = flight.run(() => newWork.promise, "project");

    oldWork.resolve("stale");
    await expect(stale).resolves.toEqual({ ran: true, value: "stale" });
    await expect(
      flight.run(async () => "duplicate", "project"),
    ).resolves.toEqual({
      ran: false,
    });
    newWork.resolve("current");
    await expect(current).resolves.toEqual({ ran: true, value: "current" });
  });
});

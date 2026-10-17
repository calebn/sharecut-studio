import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryEntryId } from "../types/project";
import {
  _resetQueuedMovesForTests,
  queuedMoveOf,
  queueMove,
  readyAfterSaveCopy,
  runsAfterSaveCopy,
  subscribeQueuedMove,
  useWaitingMove,
} from "./undoWait";

const entry = "toast-entry" as HistoryEntryId;

beforeEach(() => _resetQueuedMovesForTests());

describe("queued move", () => {
  it("starts waiting on the step it meant", () => {
    queueMove("/tmp/ep", "undo", entry);
    expect(queuedMoveOf("/tmp/ep")).toEqual({
      action: "undo",
      target: entry,
      state: { kind: "waiting" },
    });
    expect(queuedMoveOf("/tmp/other")).toBeNull();
  });

  it("fires once, and a later drop cannot rewrite it", () => {
    const move = queueMove("/tmp/ep", "redo", null);
    move.fire();
    move.drop("late");
    expect(queuedMoveOf("/tmp/ep")?.state).toEqual({ kind: "fired" });
  });

  it("keeps the reason a drop was announced with", () => {
    const move = queueMove("/tmp/ep", "undo", entry);
    move.drop("Can't undo: the project changed since. Nothing was undone.");
    move.fire();
    expect(queuedMoveOf("/tmp/ep")?.state).toEqual({
      kind: "dropped",
      reason: "Can't undo: the project changed since. Nothing was undone.",
    });
  });

  it("lets a newer press replace the record, so an older one cannot settle it", () => {
    const older = queueMove("/tmp/ep", "undo", entry);
    queueMove("/tmp/ep", "undo", null);
    older.fire();
    expect(queuedMoveOf("/tmp/ep")).toMatchObject({
      target: null,
      state: { kind: "waiting" },
    });
  });

  it("notifies subscribers on each change", () => {
    const listener = vi.fn();
    const stop = subscribeQueuedMove(listener);
    const move = queueMove("/tmp/ep", "undo", entry);
    move.fire();
    stop();
    queueMove("/tmp/ep", "undo", entry);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("is read as waiting only until it settles", () => {
    const { result } = renderHook(() => useWaitingMove("/tmp/ep"));
    expect(result.current).toBeNull();
    let move!: ReturnType<typeof queueMove>;
    act(() => {
      move = queueMove("/tmp/ep", "undo", entry);
    });
    expect(result.current?.target).toBe(entry);
    act(() => move.fire());
    expect(result.current).toBeNull();
  });

  it("words the wait in plain terms for both moves", () => {
    expect(readyAfterSaveCopy("undo")).toBe("Undo ready after save");
    expect(runsAfterSaveCopy("redo")).toBe("Redo runs after save");
  });
});

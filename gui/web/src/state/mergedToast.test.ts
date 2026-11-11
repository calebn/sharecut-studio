import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectView } from "../types/project";
import { useDawStore } from "./dawStore";

const headAt = (head: string) =>
  useDawStore.setState({
    project: { history: { head_id: head } } as unknown as ProjectView,
  });
const say = (message: string, options = {}) =>
  useDawStore.getState().announceStatus(message, options);
const toast = () => useDawStore.getState().feedbackToast;

describe("merged edit toasts", () => {
  beforeEach(() => {
    useDawStore.setState({ feedbackToast: null, project: null });
  });

  it("leaves a lone edit unmerged", () => {
    headAt("h0");
    say("Cut to clipboard", { undo: "h1", kind: "cut" });
    expect(toast()?.merged).toBeNull();
    expect(toast()?.message).toBe("Cut to clipboard");
  });

  it("folds a second edit of the same kind into one toast, newest first", () => {
    headAt("h0");
    say("Cut to clipboard", { undo: "h1", kind: "cut" });
    headAt("h1");
    say("Cut to clipboard", { undo: "h2", kind: "cut" });
    expect(toast()?.message).toBe("2 cuts");
    expect(toast()?.undo).toBe("h2");
    expect(toast()?.merged).toEqual({ entries: ["h2", "h1"] });
  });

  it("keeps the newest entry as Undo and grows the count", () => {
    headAt("h0");
    say("Deleted clip", { undo: "h1", kind: "delete" });
    headAt("h1");
    say("Deleted clip", { undo: "h2", kind: "delete" });
    headAt("h2");
    say("Deleted clip", { undo: "h3", kind: "delete" });
    expect(toast()?.message).toBe("3 deletes");
    expect(toast()?.merged?.entries).toEqual(["h3", "h2", "h1"]);
  });

  it("does not merge across kinds", () => {
    headAt("h0");
    say("Cut to clipboard", { undo: "h1", kind: "cut" });
    headAt("h1");
    say("Split at 0:04", { undo: "h2", kind: "split" });
    expect(toast()?.merged).toBeNull();
    expect(toast()?.message).toBe("Split at 0:04");
  });

  it("does not merge when something else moved the head in between", () => {
    headAt("h0");
    say("Cut to clipboard", { undo: "h1", kind: "cut" });
    headAt("hx");
    say("Cut to clipboard", { undo: "h3", kind: "cut" });
    expect(toast()?.merged).toBeNull();
  });

  it("does not merge a toast that carries an action or no kind", () => {
    headAt("h0");
    say("Cut", {
      undo: "h1",
      kind: "cut",
      action: { label: "Cut all", run: () => {} },
    });
    headAt("h1");
    say("Cut", { undo: "h2", kind: "cut" });
    expect(toast()?.merged).toBeNull();
    headAt("h2");
    say("Moved clips", { undo: "h3" });
    headAt("h3");
    say("Moved clips", { undo: "h4" });
    expect(toast()?.merged).toBeNull();
  });

  it("merges when the reply beats the snapshot (head already at the standing baseHead)", () => {
    headAt("h0");
    say("Cut", { undo: "h1", kind: "cut" });
    headAt("h0");
    say("Cut", { undo: "h2", kind: "cut" });
    expect(toast()?.merged?.entries).toEqual(["h2", "h1"]);
  });

  it("merges when the snapshot already shows the new entry", () => {
    headAt("h0");
    say("Cut", { undo: "h1", kind: "cut" });
    headAt("h2");
    say("Cut", { undo: "h2", kind: "cut" });
    expect(toast()?.merged?.entries).toEqual(["h2", "h1"]);
  });

  it("never folds the same entry twice", () => {
    headAt("h0");
    say("Cut", { undo: "h1", kind: "cut" });
    headAt("h1");
    say("Cut", { undo: "h1", kind: "cut" });
    expect(toast()?.merged).toBeNull();
  });

  it("does not merge an error, a gesture or a reverse", () => {
    headAt("h0");
    say("Cut", { undo: "h1", kind: "cut" });
    headAt("h1");
    say("Cut failed", { undo: "h2", kind: "cut", tone: "error" });
    expect(toast()?.merged).toBeNull();
    headAt("h2");
    say("Cut", { undo: "h3", kind: "cut", gesture: true });
    expect(toast()?.merged).toBeNull();
  });

  it("gives a merged toast a fresh id so its lifetime restarts", () => {
    headAt("h0");
    say("Cut", { undo: "h1", kind: "cut" });
    const first = toast()?.id;
    headAt("h1");
    say("Cut", { undo: "h2", kind: "cut" });
    expect(toast()?.id).not.toBe(first);
  });

  it("starts again at one after the toast is dismissed", () => {
    headAt("h0");
    say("Cut", { undo: "h1", kind: "cut" });
    useDawStore.getState().dismissFeedbackToast(toast()!.id);
    headAt("h1");
    say("Cut", { undo: "h2", kind: "cut" });
    expect(toast()?.merged).toBeNull();
  });

  it("merges when the head moves first and the Undo of the standing toast has already lapsed", () => {
    headAt("h0");
    say("Cut", { undo: "h1", kind: "cut" });
    headAt("h1");
    say("Cut", { undo: "h2", kind: "cut" });
    headAt("h3");
    useDawStore.getState().dropFeedbackUndo(toast()!.id);
    expect(toast()?.undo).toBeNull();
    say("Cut", { undo: "h3", kind: "cut" });
    expect(toast()?.merged?.entries).toEqual(["h3", "h2", "h1"]);
    expect(toast()?.message).toBe("3 cuts");
  });

  it("does not merge into a lapsed toast once the moment has passed", () => {
    vi.useFakeTimers();
    try {
      headAt("h0");
      say("Cut", { undo: "h1", kind: "cut" });
      headAt("h1");
      useDawStore.getState().dropFeedbackUndo(toast()!.id);
      vi.advanceTimersByTime(2000);
      headAt("h2");
      say("Cut", { undo: "h2", kind: "cut" });
      expect(toast()?.merged).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not merge into a lapsed toast of another kind", () => {
    headAt("h0");
    say("Cut", { undo: "h1", kind: "cut" });
    headAt("h1");
    useDawStore.getState().dropFeedbackUndo(toast()!.id);
    headAt("h2");
    say("Split", { undo: "h2", kind: "split" });
    expect(toast()?.merged).toBeNull();
  });

  it("does not fold an edit that has no Undo, an incoming action or a reverse", () => {
    headAt("h0");
    say("Cut", { undo: "h1", kind: "cut" });
    headAt("h1");
    say("Cut", { kind: "cut" });
    expect(toast()?.merged).toBeNull();
    say("Cut", { undo: "h1", kind: "cut" });
    headAt("h1");
    say("Cut", {
      undo: "h2",
      kind: "cut",
      action: { label: "Cut all", run: () => {} },
    });
    expect(toast()?.merged).toBeNull();
    headAt("h2");
    say("Cut", { undo: "h3", kind: "cut" });
    headAt("h3");
    say("Cut", {
      undo: "h4",
      kind: "cut",
      reverse: { run: async () => true, done: "Done" },
    });
    expect(toast()?.merged).toBeNull();
  });

  it("folds splits and names them", () => {
    headAt("h0");
    say("Split at 0:04", { undo: "h1", kind: "split" });
    headAt("h1");
    say("Split at 0:09", { undo: "h2", kind: "split" });
    expect(toast()?.message).toBe("2 splits");
  });

  it("stops folding at 25 edits and starts a new toast", () => {
    headAt("h0");
    say("Cut", { undo: "e1", kind: "cut" });
    for (let i = 2; i <= 25; i++) {
      headAt(`e${i - 1}`);
      say("Cut", { undo: `e${i}`, kind: "cut" });
    }
    expect(toast()?.merged?.entries).toHaveLength(25);
    headAt("e25");
    say("Cut", { undo: "e26", kind: "cut" });
    expect(toast()?.merged).toBeNull();
    expect(toast()?.message).toBe("Cut");
  });
});

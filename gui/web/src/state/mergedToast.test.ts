import { beforeEach, describe, expect, it } from "vitest";
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

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { batchDawWrites, useDawStore } from "./dawStore";
import {
  createSelectionSlice,
  localSelectionWriteSignal,
  selectionPatch,
} from "./selectionSlice";
import type { DawStore } from "./types";

beforeEach(() => useDawStore.getState().setSelection(null));

describe("local selection write ownership", () => {
  it("retains one write signal until an explicit empty clear", () => {
    const signal = localSelectionWriteSignal(useDawStore.getState);
    expect(localSelectionWriteSignal(useDawStore.getState)).toBe(signal);
    useDawStore.getState().setSelection(null);
    expect(signal.aborted).toBe(true);
    const next = localSelectionWriteSignal(useDawStore.getState);
    expect(next).not.toBe(signal);
    expect(next.aborted).toBe(false);
  });

  it("invalidates inside a batched no-op clear even when no store notification occurs", () => {
    const signal = localSelectionWriteSignal(useDawStore.getState);
    const changed = vi.fn();
    const unsubscribe = useDawStore.subscribe(changed);
    try {
      batchDawWrites(() => useDawStore.getState().setSelection(null));
      expect(changed).not.toHaveBeenCalled();
      expect(signal.aborted).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it("does not invalidate local intent when a wire selection patch is only computed", () => {
    const signal = localSelectionWriteSignal(useDawStore.getState);
    expect(selectionPatch(null, null, null).selection).toBeNull();
    expect(signal.aborted).toBe(false);
  });

  it("keeps independent stores' explicit writes separate", () => {
    const other = createStore<DawStore>()((...args) => ({
      ...useDawStore.getState(),
      ...createSelectionSlice(...args),
    }));
    const local = localSelectionWriteSignal(useDawStore.getState);
    const remoteStore = localSelectionWriteSignal(other.getState);
    other.getState().setSelection(null);
    expect(remoteStore.aborted).toBe(true);
    expect(local.aborted).toBe(false);
  });
});

describe("followChapter", () => {
  const opening = { kind: "chapter", id: "Opening", time: 10 } as const;
  const interview = { kind: "chapter", id: "Interview", time: 10 } as const;

  it("moves the selection and an open Inspector to the renamed chapter", () => {
    useDawStore.setState({
      selection: opening,
      inspectorKey: "chapter:Opening",
    });
    useDawStore.getState().followChapter(opening, interview);
    expect(useDawStore.getState().selection).toEqual(interview);
    expect(useDawStore.getState().inspectorKey).toBe("chapter:Interview");
  });

  it("leaves a closed Inspector closed", () => {
    useDawStore.setState({ selection: opening, inspectorKey: null });
    useDawStore.getState().followChapter(opening, interview);
    expect(useDawStore.getState().selection).toEqual(interview);
    expect(useDawStore.getState().inspectorKey).toBeNull();
  });

  it("does nothing once another kind is selected", () => {
    useDawStore.setState({
      selection: { kind: "social", id: "social-1" },
      inspectorKey: null,
    });
    useDawStore.getState().followChapter(opening, interview);
    expect(useDawStore.getState().selection).toEqual({
      kind: "social",
      id: "social-1",
    });
  });

  it("does nothing once another chapter is selected", () => {
    const later = { kind: "chapter", id: "Opening", time: 12 } as const;
    useDawStore.setState({ selection: later, inspectorKey: null });
    useDawStore.getState().followChapter(opening, interview);
    expect(useDawStore.getState().selection).toEqual(later);
  });
});

describe("a chapter selection follows the project", () => {
  const chapter = (title: string, time: number) => ({ title, time });
  const withChapters = (...chapters: { title: string; time: number }[]) =>
    ({ chapters }) as never;
  const select = (id: string, time: number, key: string | null) =>
    useDawStore.setState({
      project: withChapters(chapter("Opening", 10), chapter("Outro", 90)),
      selection: { kind: "chapter", id, time },
      inspectorKey: key,
    });

  it("follows a rename or a Time move that undo, redo or a collaborator made", () => {
    select("Opening", 10, "chapter:Opening");
    useDawStore
      .getState()
      .setProject(withChapters(chapter("Cold open", 10), chapter("Outro", 90)));
    expect(useDawStore.getState().selection).toEqual({
      kind: "chapter",
      id: "Cold open",
      time: 10,
    });
    expect(useDawStore.getState().inspectorKey).toBe("chapter:Cold open");
    useDawStore
      .getState()
      .setProject(withChapters(chapter("Cold open", 20), chapter("Outro", 90)));
    expect(useDawStore.getState().selection).toEqual({
      kind: "chapter",
      id: "Cold open",
      time: 20,
    });
  });

  it("keeps a closed Inspector closed while following", () => {
    select("Opening", 10, null);
    useDawStore
      .getState()
      .setProject(withChapters(chapter("Cold open", 10), chapter("Outro", 90)));
    expect(useDawStore.getState().inspectorKey).toBeNull();
  });

  it("closes the selection and the Inspector once the chapter is gone", () => {
    select("Opening", 10, "chapter:Opening");
    useDawStore.getState().setProject(withChapters(chapter("Outro", 90)));
    expect(useDawStore.getState().selection).toBeNull();
    expect(useDawStore.getState().inspectorKey).toBeNull();
  });

  it("closes the selection when more than one chapter changed at once", () => {
    select("Opening", 10, "chapter:Opening");
    useDawStore
      .getState()
      .setProject(withChapters(chapter("Intro", 12), chapter("Wrap", 95)));
    expect(useDawStore.getState().selection).toBeNull();
  });

  it("leaves the selection alone while its chapter still exists", () => {
    select("Opening", 10, "chapter:Opening");
    useDawStore
      .getState()
      .setProject(withChapters(chapter("Opening", 10), chapter("Outro", 91)));
    expect(useDawStore.getState().selection).toEqual({
      kind: "chapter",
      id: "Opening",
      time: 10,
    });
    expect(useDawStore.getState().inspectorKey).toBe("chapter:Opening");
  });

  it("does not touch another kind of selection", () => {
    useDawStore.setState({
      project: withChapters(chapter("Opening", 10)),
      selection: { kind: "social", id: "social-1" },
      inspectorKey: null,
    });
    useDawStore.getState().setProject(withChapters());
    expect(useDawStore.getState().selection).toEqual({
      kind: "social",
      id: "social-1",
    });
  });
});

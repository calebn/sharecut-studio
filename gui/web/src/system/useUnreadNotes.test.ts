import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";
import type { NoteItem } from "./notesRailModel";
import {
  UnreadStore,
  unreadBadgeText,
  unseenOthers,
  useUnreadNotes,
} from "./useUnreadNotes";

const note = (id: string, over: Partial<NoteItem> = {}): NoteItem => ({
  id,
  kind: "note",
  author: { name: "Ava" },
  text: `text ${id}`,
  time: "0:01",
  visibility: "everyone",
  ...over,
});
const marker = (id: string, name = "Ava"): NoteItem => ({
  id,
  kind: "marker",
  author: { name },
  time: "0:01",
});
const fresh = (): UnreadStore => new UnreadStore();

type Args = Parameters<typeof useUnreadNotes>[0];
const base = (over: Partial<Args> = {}): Args => ({
  notes: [],
  selfName: "Maya",
  enabled: true,
  loading: false,
  sheetOpen: false,
  commentsShowing: false,
  store: fresh(),
  ...over,
});

/** Renders the hook and lets a test change one input at a time. */
function harness(first: Partial<Args> = {}, options?: { strict?: boolean }) {
  let current = base(first);
  const hook = renderHook((props: Args) => useUnreadNotes(props), {
    initialProps: current,
    wrapper: options?.strict ? StrictMode : undefined,
  });
  return {
    get count() {
      return hook.result.current.count;
    },
    get pulseKey() {
      return hook.result.current.pulseKey;
    },
    store: current.store,
    update(over: Partial<Args>) {
      current = { ...current, ...over };
      hook.rerender(current);
    },
    unmount: hook.unmount,
  };
}

const storeSeen = (ids: string[]) => {
  const store = new UnreadStore();
  store.markSeen(ids.map((id) => note(id)));
  return store;
};

describe("unseenOthers", () => {
  const seen = new UnreadStore();
  it("counts notes by others only", () => {
    const notes = [note("1"), note("2", { mine: true }), marker("3")];
    expect(unseenOthers(notes, seen, "Maya")).toBe(1);
  });

  it("uses mine when set and the name only when it is not", () => {
    expect(
      unseenOthers([note("1", { author: { name: "Maya" } })], seen, "Maya"),
    ).toBe(0);
    expect(
      unseenOthers(
        [note("1", { mine: false, author: { name: "Maya" } })],
        seen,
        "Maya",
      ),
    ).toBe(1);
    expect(
      unseenOthers([note("1", { mine: true })], seen, "Someone else"),
    ).toBe(0);
  });

  it("never counts a marker, anyone's", () => {
    expect(unseenOthers([marker("1"), marker("2", "Maya")], seen, "Maya")).toBe(
      0,
    );
  });

  it("works with a selfName of Host and with an empty one", () => {
    const named = [note("1", { author: { name: "Host" } })];
    expect(unseenOthers(named, seen, "Host")).toBe(0);
    expect(unseenOthers(named, seen, "")).toBe(1);
    expect(unseenOthers([note("1", { author: { name: "" } })], seen, "")).toBe(
      0,
    );
  });

  it("skips ids already seen", () => {
    expect(unseenOthers([note("1"), note("2")], storeSeen(["1"]), "Maya")).toBe(
      1,
    );
  });
});

describe("unread text", () => {
  it("caps the badge at 99+", () => {
    expect(unreadBadgeText(1)).toBe("1");
    expect(unreadBadgeText(99)).toBe("99");
    expect(unreadBadgeText(100)).toBe("99+");
  });
});

describe("useUnreadNotes", () => {
  it("does not count what was there when the room first showed", () => {
    const view = harness({ notes: [note("1"), note("2")] });
    expect(view.count).toBe(0);
    expect(view.pulseKey).toBe(0);
  });

  it("counts a later comment by someone else and pulses once", () => {
    const view = harness({ notes: [note("1")] });
    view.update({ notes: [note("1"), note("2")] });
    expect(view.count).toBe(1);
    expect(view.pulseKey).toBe(1);
    view.update({ notes: [note("1"), note("2"), note("3")] });
    expect(view.count).toBe(2);
    expect(view.pulseKey).toBe(2);
  });

  it("does not pulse again for a rerender that adds nothing", () => {
    const view = harness({ notes: [] });
    view.update({ notes: [note("1")] });
    view.update({ selfName: "Maya" });
    expect(view.pulseKey).toBe(1);
  });

  it("ignores the host's own comments, by mine and by name", () => {
    const view = harness({});
    view.update({ notes: [note("1", { mine: true })] });
    view.update({
      notes: [
        note("1", { mine: true }),
        note("2", { author: { name: "Maya" } }),
      ],
    });
    expect(view.count).toBe(0);
    expect(view.pulseKey).toBe(0);
  });

  it("ignores markers, anyone's", () => {
    const view = harness({});
    view.update({ notes: [marker("1"), marker("2", "Maya")] });
    expect(view.count).toBe(0);
    expect(view.pulseKey).toBe(0);
  });

  it("counts nothing while disabled", () => {
    const view = harness({ enabled: false });
    view.update({ notes: [note("1")] });
    expect(view.count).toBe(0);
    expect(view.pulseKey).toBe(0);
  });

  it("seeds after loading ends, not at mount", () => {
    const view = harness({ loading: true, notes: [] });
    view.update({
      loading: false,
      notes: [1, 2, 3, 4, 5].map((n) => note(`${n}`)),
    });
    expect(view.count).toBe(0);
    expect(view.pulseKey).toBe(0);
    view.update({
      notes: [1, 2, 3, 4, 5, 6].map((n) => note(`${n}`)),
    });
    expect(view.count).toBe(1);
  });

  it("shows no count while the sheet is open and marks Comments reading as seen", () => {
    const view = harness({ notes: [note("1")] });
    view.update({ sheetOpen: true, commentsShowing: true });
    view.update({ notes: [note("1"), note("2")] });
    expect(view.count).toBe(0);
    expect(view.pulseKey).toBe(0);
    view.update({ sheetOpen: false, commentsShowing: false });
    expect(view.count).toBe(0);
    expect(view.pulseKey).toBe(0);
    view.update({ notes: [note("1"), note("2"), note("3")] });
    expect(view.count).toBe(1);
  });

  it("keeps unseen comments while the Takes tab is showing and badges them without a pulse on close", () => {
    const view = harness({ notes: [] });
    view.update({ sheetOpen: true, commentsShowing: false });
    view.update({ notes: [note("1")] });
    expect(view.count).toBe(0);
    expect(view.pulseKey).toBe(0);
    view.update({ sheetOpen: false });
    expect(view.count).toBe(1);
    expect(view.pulseKey).toBe(0);
    view.update({ sheetOpen: true, commentsShowing: false });
    view.update({ commentsShowing: true });
    view.update({ sheetOpen: false, commentsShowing: false });
    expect(view.count).toBe(0);
    expect(view.pulseKey).toBe(0);
  });

  it("pulses for a rise while closed even with earlier unseen ones", () => {
    const view = harness({ notes: [] });
    view.update({ notes: [note("1")] });
    expect(view.pulseKey).toBe(1);
    view.update({ notes: [note("1"), note("2")] });
    expect(view.pulseKey).toBe(2);
  });

  it("a kept store keeps old comments uncounted across a remount (reconnect)", () => {
    const store = fresh();
    const notes = [1, 2, 3, 4, 5].map((n) => note(`${n}`));
    const first = harness({ notes, store });
    expect(first.count).toBe(0);
    first.unmount();
    const second = harness({ notes, store });
    expect(second.count).toBe(0);
    expect(second.pulseKey).toBe(0);
    second.update({ notes: [...notes, note("6")] });
    expect(second.count).toBe(1);
  });

  it("bumps the pulse once under StrictMode", () => {
    const view = harness({ notes: [] }, { strict: true });
    act(() => view.update({ notes: [note("1")] }));
    expect(view.count).toBe(1);
    expect(view.pulseKey).toBe(1);
  });

  it("does not pulse on mount with comments under StrictMode", () => {
    const view = harness({ notes: [note("1")] }, { strict: true });
    expect(view.count).toBe(0);
    expect(view.pulseKey).toBe(0);
  });
});

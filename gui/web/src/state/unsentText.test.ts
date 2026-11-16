import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composerPatch, initialSession } from "./composerSession";
import { useDawStore } from "./dawStore";
import { collectUnsent, useUnsentText } from "./unsentText";

const anchor = { time: 1 } as never;

function composeWith(parts: { draft?: string; post?: string }) {
  useDawStore.setState(
    composerPatch({
      ...initialSession,
      draft:
        parts.draft === undefined
          ? null
          : { text: parts.draft, anchor, resume: false, typed: true },
      post: parts.post === undefined ? null : { id: 1, sentText: parts.post },
    }),
  );
}

beforeEach(() => useDawStore.setState(composerPatch(initialSession)));
afterEach(() => useDawStore.setState(composerPatch(initialSession)));

describe("collectUnsent", () => {
  it("is empty when nothing was typed", () => {
    expect(collectUnsent()).toEqual([]);
  });

  it("hands back the composer draft exactly as typed", () => {
    composeWith({ draft: "  two  spaces\nand a line  " });
    expect(collectUnsent()).toEqual([
      { label: "Your comment", text: "  two  spaces\nand a line  " },
    ]);
  });

  it("drops a draft that is only blank", () => {
    composeWith({ draft: " \n\t " });
    expect(collectUnsent()).toEqual([]);
  });

  it("takes the text of a Post still in flight when the draft is gone", () => {
    composeWith({ post: "on its way" });
    expect(collectUnsent()).toEqual([
      { label: "Your comment", text: "on its way" },
    ]);
  });

  it("lists the same words once when the draft and the Post in flight agree", () => {
    composeWith({ draft: "same", post: "same" });
    expect(collectUnsent()).toEqual([{ label: "Your comment", text: "same" }]);
  });

  it("lists the composer first, then registered drafts in registration order", () => {
    composeWith({ draft: "comment" });
    const reply = renderHook(() => useUnsentText("Your reply", "reply"));
    const note = renderHook(() => useUnsentText("Your note", "note"));
    expect(collectUnsent().map((one) => one.label)).toEqual([
      "Your comment",
      "Your reply",
      "Your note",
    ]);
    reply.unmount();
    note.unmount();
  });

  it("gives one entry per non-blank text of a draft that holds several", () => {
    const { unmount } = renderHook(() =>
      useUnsentText("Your reply", ["first", "", "  ", "third"]),
    );
    expect(collectUnsent()).toEqual([
      { label: "Your reply", text: "first" },
      { label: "Your reply", text: "third" },
    ]);
    unmount();
  });

  it("reads the latest text of a draft, not the first", () => {
    const { rerender, unmount } = renderHook(
      ({ text }) => useUnsentText("Your reply", text),
      { initialProps: { text: "a" } },
    );
    rerender({ text: "abc" });
    expect(collectUnsent()).toEqual([{ label: "Your reply", text: "abc" }]);
    unmount();
  });

  it("forgets a draft whose component unmounted", () => {
    const { unmount } = renderHook(() => useUnsentText("Your reply", "x"));
    unmount();
    expect(collectUnsent()).toEqual([]);
  });
});

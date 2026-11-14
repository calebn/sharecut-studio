import { cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CommentsRow } from "./CommentsRow";
import { listenLayoutOf } from "./listenLayout";

const heard = { author: "Claude", time: "0:03", text: "Note number 1" };

function row(props: Partial<Parameters<typeof CommentsRow>[0]> = {}) {
  render(
    <CommentsRow
      label="3 comments"
      comments={3}
      afterCount="comments"
      onOpen={() => undefined}
      {...props}
    />,
  );
  return screen.getByRole("button", { name: /^Show\b/ });
}

/** What the eye reads: the row's text without the words only a screen reader gets. */
function seen(button: HTMLElement): string[] {
  return [...button.querySelectorAll(".gl-row-count, .gl-row-text")].map(
    (el) => el.textContent ?? "",
  );
}

describe("CommentsRow accessible name", () => {
  it("names the count once, and starts with what the button does", () => {
    expect(row()).toHaveAccessibleName("Show 3 comments");
  });

  it("says comment in the singular for one", () => {
    expect(
      row({ label: "1 comment", comments: 1, afterCount: "comment" }),
    ).toHaveAccessibleName("Show 1 comment");
  });

  it("contains the comment being heard: its author, time and text", () => {
    const button = row({ preview: heard });
    expect(button).toHaveAccessibleName(
      "Show 3 comments Claude · 0:03 Note number 1",
    );
  });

  it("contains the Comment added flash", () => {
    expect(row({ flash: "Comment added at 1:26" })).toHaveAccessibleName(
      "Show 3 comments Comment added at 1:26",
    );
  });

  it("keeps the flash over the comment being heard", () => {
    expect(
      row({ flash: "Comment added at 1:26", preview: heard }),
    ).toHaveAccessibleName("Show 3 comments Comment added at 1:26");
  });

  it("contains Needs attention and the suggestion count", () => {
    expect(
      row({
        label: "3 comments · 2 suggestions · Needs attention",
        afterCount: "comments · 2 suggestions · Needs attention",
      }),
    ).toHaveAccessibleName("Show 3 comments · 2 suggestions · Needs attention");
  });

  it("keeps Needs attention beside the count while a comment is heard", () => {
    expect(
      row({
        label: "3 comments · Needs attention",
        afterCount: "comments · Needs attention",
        preview: heard,
      }),
    ).toHaveAccessibleName(
      "Show 3 comments · Needs attention Claude · 0:03 Note number 1",
    );
  });

  it("draws the same visible row in every state: icon, count, text, chevron", () => {
    const parts = (button: HTMLElement) =>
      [...button.children]
        .filter((el) => !el.classList.contains("sr-only"))
        .map((el) => (el.tagName === "svg" ? "svg" : el.className));
    expect(parts(row())).toEqual(["svg", "gl-row-text", "svg"]);
    cleanup();
    expect(parts(row({ preview: heard }))).toEqual([
      "svg",
      "gl-row-count",
      "gl-row-text",
      "svg",
    ]);
    cleanup();
    expect(parts(row({ flash: "Comment added at 1:26" }))).toEqual([
      "svg",
      "gl-row-count",
      "gl-row-text",
      "svg",
    ]);
  });

  it("contains every piece of visible text in each state", () => {
    for (const props of [
      {},
      { preview: heard },
      { flash: "Comment added at 1:26" },
      { label: "3 comments · Needs attention" },
    ]) {
      const { unmount } = render(
        <CommentsRow
          label="3 comments"
          comments={3}
          afterCount="comments"
          onOpen={() => undefined}
          {...props}
        />,
      );
      const button = screen.getByRole("button", { name: /^Show\b/ });
      for (const text of seen(button))
        expect(button).toHaveAccessibleName(
          expect.stringContaining(text.trim()),
        );
      unmount();
    }
  });
});

/** The row exactly as the layout hands it over, for a link with no comments. */
function layoutRow(
  suggestions: number,
  needsAttention: boolean,
  props: Partial<Parameters<typeof CommentsRow>[0]> = {},
) {
  const { bottom } = listenLayoutOf({
    mayComment: true,
    script: "ready",
    counts: { comments: 0, suggestions },
    hasChapters: false,
    needsAttention,
    draft: null,
  });
  if (bottom.kind !== "row") throw new Error("expected a row");
  const { kind: _kind, ...row } = bottom;
  render(<CommentsRow {...row} onOpen={() => undefined} {...props} />);
  return screen.getByRole("button", { name: /^Show\b/ });
}

describe("CommentsRow name when the link holds no comments", () => {
  it.each([
    [
      "2 suggestions",
      2,
      false,
      "Show 2 suggestions",
      "0 comments · 2 suggestions",
    ],
    [
      "2 suggestions and Needs attention",
      2,
      true,
      "Show 2 suggestions · Needs attention",
      "0 comments · 2 suggestions · Needs attention",
    ],
    [
      "Needs attention only",
      0,
      true,
      "Show Needs attention",
      "0 comments · Needs attention",
    ],
  ])(
    "%s: the count-only name is the visible label",
    (_, suggestions, attention, name) => {
      const button = layoutRow(suggestions, attention);
      expect(button).toHaveAccessibleName(name);
      for (const text of seen(button))
        expect(button).toHaveAccessibleName(
          expect.stringContaining(text.trim()),
        );
    },
  );

  it.each([
    ["2 suggestions", 2, false, "0 comments · 2 suggestions"],
    [
      "2 suggestions and Needs attention",
      2,
      true,
      "0 comments · 2 suggestions · Needs attention",
    ],
    ["Needs attention only", 0, true, "0 comments · Needs attention"],
  ])(
    "%s: a heard item or the flash follows the true words after the visible count",
    (_, suggestions, attention, words) => {
      const heardRow = layoutRow(suggestions, attention, { preview: heard });
      expect(heardRow).toHaveAccessibleName(
        `Show ${words} Claude · 0:03 Note number 1`,
      );
      for (const text of seen(heardRow))
        expect(heardRow).toHaveAccessibleName(
          expect.stringContaining(text.trim()),
        );
      cleanup();
      const flashRow = layoutRow(suggestions, attention, {
        flash: "Comment added at 1:26",
      });
      expect(flashRow).toHaveAccessibleName(
        `Show ${words} Comment added at 1:26`,
      );
      expect(flashRow).not.toHaveAccessibleName(/eeds|0 suggestion/);
    },
  );
});

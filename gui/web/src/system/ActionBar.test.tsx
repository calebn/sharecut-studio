import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { barScene, EDIT_SELECTIONS, itemsOf } from "../test/actionBarFixtures";
import { ActionBar, SelectionCount } from "./ActionBar";
import { foldDock } from "./actionBarSlots";

const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);

describe("foldDock", () => {
  const words = itemsOf([
    "hear",
    "keep",
    "comment",
    "fixText",
    "record",
    "more",
    "inspect",
  ]);
  const rows = itemsOf(["mute", "moveToSpeaker", "copy"]);

  it("gives the primary the fifth slot and moves Record to the head of More", () => {
    const folded = foldDock(words, rows, true);
    expect(ids(folded.items)).toEqual(["hear", "keep", "comment", "fixText"]);
    expect(ids(folded.more)).toEqual([
      "record",
      "mute",
      "moveToSpeaker",
      "copy",
    ]);
  });

  it("keeps five verbs when there is no primary", () => {
    const folded = foldDock(words, rows, false);
    expect(ids(folded.items)).toEqual([
      "hear",
      "keep",
      "comment",
      "fixText",
      "record",
    ]);
    expect(ids(folded.more)).toEqual(["mute", "moveToSpeaker", "copy"]);
  });

  it("folds in bar order, not by a priority list", () => {
    const folded = foldDock(
      itemsOf([
        "hear",
        "keep",
        "split",
        "comment",
        "fixText",
        "record",
        "export",
        "remove",
      ]),
      [],
      true,
    );
    expect(ids(folded.items)).toEqual(["hear", "keep", "split", "comment"]);
    expect(ids(folded.more)).toEqual(["fixText", "record", "export", "remove"]);
  });

  it("counts A/B as one slot", () => {
    const folded = foldDock(
      itemsOf([
        "hearBefore",
        "hearAfter",
        "keep",
        "comment",
        "fixText",
        "remove",
        "more",
      ]),
      itemsOf(["adjustBounds"]),
      true,
    );
    expect(ids(folded.items)).toEqual([
      "hearBefore",
      "hearAfter",
      "keep",
      "comment",
      "fixText",
    ]);
    expect(ids(folded.more)).toEqual(["remove", "adjustBounds"]);
  });
});

describe("ActionBar dock", () => {
  function dock(onVerb = vi.fn()) {
    const scene = barScene(EDIT_SELECTIONS.cutWords);
    render(
      <ActionBar
        placement={{ form: "dock" }}
        items={scene.items}
        more={scene.more}
        primary={scene.primary}
        onVerb={onVerb}
      />,
    );
    return { onVerb, bar: screen.getByRole("group", { name: "Actions" }) };
  }

  it("draws the grip, the verbs, More and the primary last, none disabled", () => {
    const { bar } = dock();
    const buttons = within(bar).getAllByRole("button");
    expect(buttons.map((button) => button.textContent || "Inspect")).toEqual([
      "Inspect",
      "Hear",
      "Keep",
      "Comment",
      "Fix text",
      "More",
      "Cut",
    ]);
    expect(buttons.some((button) => button.hasAttribute("disabled"))).toBe(
      false,
    );
    expect(bar.querySelectorAll(".primary")).toHaveLength(1);
    expect(buttons.at(-1)).toHaveClass("primary");
  });

  it("calls onVerb with the literal id of the button pressed", async () => {
    const { onVerb } = dock();
    await userEvent.click(screen.getByRole("button", { name: "Hear" }));
    await userEvent.click(screen.getByRole("button", { name: "Cut" }));
    await userEvent.click(screen.getByRole("button", { name: "Inspect" }));
    expect(onVerb.mock.calls).toEqual([["hear"], ["cut"], ["inspect"]]);
  });

  it("lists the folded verbs ahead of the More commands", async () => {
    const { onVerb } = dock();
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    const menu = screen.getByRole("menu", { name: "More actions" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Record", "Mute", "Move to speaker", "Copy"]);
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "Record" }),
    );
    expect(onVerb).toHaveBeenLastCalledWith("record", undefined);
  });

  it("draws the playhead verbs with no grip and no More", () => {
    const scene = barScene(EDIT_SELECTIONS.playhead, {
      clipboardHasAudio: true,
    });
    render(
      <ActionBar
        placement={{ form: "dock" }}
        items={scene.items}
        onVerb={vi.fn()}
      />,
    );
    expect(
      screen.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["Split", "Add chapter", "Record", "Paste"]);
  });

  it("pairs A/B in one slot", () => {
    const scene = barScene(EDIT_SELECTIONS.suggestion);
    render(
      <ActionBar
        placement={{ form: "dock" }}
        items={scene.items}
        more={scene.more}
        primary={scene.primary}
        onVerb={vi.fn()}
      />,
    );
    const pair = screen.getByRole("group", { name: "Hear before and after" });
    expect(
      within(pair)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Hear before", "Hear after"]);
  });

  it("shows only Hear and Comment to a read-only guest", () => {
    const scene = barScene(EDIT_SELECTIONS.cutWords, { role: "readOnly" });
    render(
      <ActionBar
        placement={{ form: "dock" }}
        items={scene.items}
        onVerb={vi.fn()}
      />,
    );
    expect(
      screen.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["Hear", "Comment"]);
  });
});

describe("ActionBar inline", () => {
  it("keeps the given order and ends with the primary", async () => {
    const onVerb = vi.fn();
    render(
      <ActionBar
        placement={{ form: "inline" }}
        items={[{ id: "comment", tone: "link" }, { id: "keep" }]}
        primary={{ id: "cut", label: "Cut it" }}
        onVerb={onVerb}
      />,
    );
    const names = screen
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(names).toEqual(["Comment", "Keep", "Cut it"]);
    await userEvent.click(screen.getByRole("button", { name: "Cut it" }));
    expect(onVerb).toHaveBeenCalledWith("cut");
  });

  it("disables the primary only for a real gate, with the reason", () => {
    render(
      <ActionBar
        placement={{ form: "inline" }}
        items={[]}
        primary={{ id: "cut", disabledReason: "Check the word first." }}
        onVerb={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Cut" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cut" })).toHaveAttribute(
      "title",
      "Check the word first.",
    );
  });
});

describe("ActionBar floating", () => {
  const sizes = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get");
  const widths = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get");
  afterEach(() => {
    sizes.mockReset();
    widths.mockReset();
  });

  function floatAt(top: number, bottom: number) {
    sizes.mockReturnValue(40);
    widths.mockReturnValue(200);
    const anchor = document.createElement("div");
    anchor.getBoundingClientRect = () =>
      ({ left: 100, right: 300, top, bottom }) as DOMRect;
    render(
      <ActionBar
        placement={{ form: "floating", anchorRef: { current: anchor } }}
        items={itemsOf(["hear", "comment"])}
        primary={{ id: "cut" }}
        onVerb={vi.fn()}
      />,
    );
    return screen.getByRole("group", { name: "Actions" });
  }

  it("sits 8 px above the selection", () => {
    const bar = floatAt(300, 330);
    expect(bar.style.top).toBe("252px");
    expect(bar.style.left).toBe("100px");
  });

  it("flips below the selection when there is no room above", () => {
    expect(floatAt(2, 30).style.top).toBe("38px");
  });

  it("is icon only and names each button", () => {
    const bar = floatAt(300, 330);
    expect(
      within(bar)
        .getAllByRole("button")
        .map((button) => [
          button.getAttribute("aria-label"),
          button.textContent,
        ]),
    ).toEqual([
      ["Hear", ""],
      ["Comment", ""],
      ["Cut", ""],
    ]);
  });
});

describe("SelectionCount", () => {
  it("says how many are selected", () => {
    render(<SelectionCount count={3} />);
    expect(screen.getByText("3 selected")).toBeInTheDocument();
  });
});

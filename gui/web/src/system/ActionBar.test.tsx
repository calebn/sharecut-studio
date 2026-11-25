import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { barScene, EDIT_SELECTIONS, itemsOf } from "../test/actionBarFixtures";
import { ActionBar, SelectionCount } from "./ActionBar";
import { type BarItem, foldDock } from "./actionBarSlots";

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
    const folded = foldDock(words, rows, 1);
    expect(ids(folded.items)).toEqual(["hear", "keep", "comment", "fixText"]);
    expect(ids(folded.more)).toEqual([
      "record",
      "mute",
      "moveToSpeaker",
      "copy",
    ]);
  });

  it("keeps five verbs when there is no primary", () => {
    const folded = foldDock(words, rows, 0);
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
      1,
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
      1,
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

describe("foldDock reserving end slots", () => {
  const verbs = itemsOf([
    "hear",
    "keep",
    "split",
    "comment",
    "fixText",
    "record",
    "more",
  ]);

  it("counts a primary and an end control as two slots", () => {
    const folded = foldDock(verbs, [], 2);
    expect(ids(folded.items)).toEqual(["hear", "keep", "split"]);
    expect(ids(folded.more)).toEqual(["comment", "fixText", "record"]);
  });

  it("counts an end control alone as one slot", () => {
    const folded = foldDock(verbs, [], 1);
    expect(ids(folded.items)).toEqual(["hear", "keep", "split", "comment"]);
  });
});

describe("ActionBar dock with a wide leading chip and an end control", () => {
  it("gives the chip a slot too, so the verbs and the end control fit", () => {
    render(
      <ActionBar
        placement={{ form: "dock" }}
        items={itemsOf(["hear", "split", "comment", "record"])}
        primary={{ id: "cut" }}
        trailing={<button type="button">Clear selection</button>}
        leadingSlots={1}
        onVerb={vi.fn()}
      />,
    );
    const bar = screen.getByRole("group", { name: "Actions" });
    expect(
      within(bar)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Hear", "Split", "More", "Cut", "Clear selection"]);
  });
});

describe("foldDock with a measured capacity", () => {
  const edit = itemsOf(["hearBefore", "hearAfter", "keep", "comment", "more"]);
  const word = itemsOf(["hear", "split", "comment", "fixText"]);

  it("counts an A/B pair as two buttons and More as one", () => {
    const folded = foldDock(edit, [], 1, 3);
    expect(ids(folded.items)).toEqual(["hearBefore", "hearAfter"]);
    expect(ids(folded.more)).toEqual(["keep", "comment"]);
  });

  it("keeps Keep when four buttons fit, and folds only Comment", () => {
    const folded = foldDock(edit, [], 1, 4);
    expect(ids(folded.items)).toEqual(["hearBefore", "hearAfter", "keep"]);
    expect(ids(folded.more)).toEqual(["comment"]);
  });

  it("counts More for a plain more list even when nothing folds", () => {
    const folded = foldDock(
      itemsOf(["hear", "split"]),
      itemsOf(["copy"]),
      1,
      2,
    );
    expect(ids(folded.items)).toEqual(["hear"]);
    expect(ids(folded.more)).toEqual(["split", "copy"]);
  });

  it("folds only Fix text when a word's four verbs and More fit in four", () => {
    const folded = foldDock(word, [], 1, 4);
    expect(ids(folded.items)).toEqual(["hear", "split", "comment"]);
    expect(ids(folded.more)).toEqual(["fixText"]);
  });

  it("folds nothing when the verbs and More fit", () => {
    const folded = foldDock(word, [], 1, 5);
    expect(ids(folded.items)).toEqual(["hear", "split", "comment", "fixText"]);
    expect(folded.more).toEqual([]);
  });

  it("never splits an A/B pair", () => {
    const folded = foldDock(edit, [], 1, 2);
    expect(ids(folded.items)).toEqual([]);
    expect(ids(folded.more)).toEqual([
      "hearBefore",
      "hearAfter",
      "keep",
      "comment",
    ]);
  });
});

describe("ActionBar dock with a leading chip and no end control", () => {
  it("reserves the chip's slot, so one fewer verb is drawn", () => {
    render(
      <ActionBar
        placement={{ form: "dock" }}
        items={itemsOf(["hear", "split", "comment", "fixText"])}
        primary={{ id: "cut" }}
        leading={<span>chip</span>}
        leadingSlots={1}
        onVerb={vi.fn()}
      />,
    );
    const bar = screen.getByRole("group", { name: "Actions" });
    expect(
      within(bar)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Hear", "Split", "Comment", "More", "Cut"]);
  });
});

describe("ActionBar dock measuring its start slot", () => {
  const CHIP = 50;
  let slotWidth = 0;
  let overflow: (() => number) | undefined;

  const PROPS = ["clientWidth", "scrollWidth", "offsetWidth"] as const;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const stub = (
    name: (typeof PROPS)[number],
    read: (el: HTMLElement) => number,
  ) => {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement) {
        return read(this);
      },
    });
  };
  const onStart = (el: HTMLElement) =>
    el.classList.contains("sys-dock-slot--start");

  beforeEach(() => {
    slotWidth = 0;
    overflow = undefined;
    for (const name of PROPS)
      saved.set(
        name,
        Object.getOwnPropertyDescriptor(HTMLElement.prototype, name),
      );
    stub("clientWidth", (el) => (onStart(el) ? slotWidth : 0));
    stub("scrollWidth", (el) =>
      onStart(el) ? (overflow ? overflow() : slotWidth) : 0,
    );
    stub("offsetWidth", (el) => (el.dataset.chip ? CHIP : 0));
  });

  afterEach(() => {
    for (const name of PROPS) {
      const original = saved.get(name);
      if (original)
        Object.defineProperty(HTMLElement.prototype, name, original);
      else
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
          name
        ];
    }
  });

  const names = () =>
    within(screen.getByRole("group", { name: "Actions" }))
      .getAllByRole("button")
      .map((b) => b.textContent);

  function edit() {
    render(
      <ActionBar
        placement={{ form: "dock" }}
        items={itemsOf(["hearBefore", "hearAfter", "keep", "comment"])}
        primary={{ id: "cut" }}
        trailing={<button type="button">Clear selection</button>}
        trailingSlots={1}
        onVerb={vi.fn()}
      />,
    );
  }

  function word() {
    render(
      <ActionBar
        placement={{ form: "dock" }}
        items={itemsOf(["hear", "split", "comment", "fixText"])}
        more={itemsOf(["copy"])}
        primary={{ id: "cut" }}
        leading={<span data-chip="1">chip</span>}
        leadingSlots={1}
        onVerb={vi.fn()}
      />,
    );
  }

  it("folds Keep and Comment for a pending edit in a 164 px slot", () => {
    slotWidth = 164;
    edit();
    expect(names()).toEqual(["A", "B", "More", "Cut", "Clear selection"]);
  });

  it("keeps Keep for a pending edit in a 218 px slot", () => {
    slotWidth = 218;
    edit();
    expect(names()).toEqual([
      "A",
      "B",
      "Keep",
      "More",
      "Cut",
      "Clear selection",
    ]);
  });

  it("folds only Fix text for a word in a 260 px slot with its chip", () => {
    slotWidth = 260;
    word();
    expect(names()).toEqual(["Hear", "Split", "Comment", "More", "Cut"]);
  });

  it("folds nothing for a word in a 314 px slot", () => {
    slotWidth = 314;
    word();
    expect(names()).toEqual([
      "Hear",
      "Split",
      "Comment",
      "Fix text",
      "More",
      "Cut",
    ]);
  });

  it("folds one more verb when the slot still overflows, then settles", () => {
    slotWidth = 260;
    const reads = vi.fn();
    overflow = () => {
      reads();
      return reads.mock.calls.length === 1 ? slotWidth + 5 : slotWidth;
    };
    word();
    expect(names()).toEqual(["Hear", "Split", "More", "Cut"]);
    expect(reads.mock.calls.length).toBeLessThan(10);
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
      "Split",
      "Comment",
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
    ).toEqual(["Fix text", "Record", "Mute", "Move to speaker", "Copy"]);
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
    ).toEqual(["Split", "Add chapter", "Record", "Paste", "Export"]);
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

  it("shows a gated verb's reason as visible text its button is described by", () => {
    render(
      <ActionBar
        placement={{ form: "dock" }}
        items={[
          { id: "hear" },
          { id: "keep", disabledReason: "Restore the later cut first." },
        ]}
        onVerb={vi.fn()}
      />,
    );
    const keep = screen.getByRole("button", { name: /Keep/ });
    expect(keep).toBeDisabled();
    expect(keep).toHaveAccessibleDescription("Restore the later cut first.");
    expect(screen.getByText("Restore the later cut first.")).toBeVisible();
    expect(screen.getByRole("button", { name: /Hear/ })).not.toHaveAttribute(
      "aria-describedby",
    );
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

  it("shows a gated verb's reason as visible text inside the bar its button is described by", () => {
    sizes.mockReturnValue(40);
    widths.mockReturnValue(200);
    const anchor = document.createElement("div");
    anchor.getBoundingClientRect = () =>
      ({ left: 100, right: 300, top: 300, bottom: 330 }) as DOMRect;
    render(
      <ActionBar
        placement={{ form: "floating", anchorRef: { current: anchor } }}
        items={[
          { id: "hear" },
          { id: "keep", disabledReason: "Restore the later cut first." },
        ]}
        onVerb={vi.fn()}
      />,
    );
    const bar = screen.getByRole("group", { name: "Actions" });
    const reason = within(bar).getByText("Restore the later cut first.");
    expect(reason).toBeVisible();
    const keep = within(bar).getByRole("button", { name: "Keep" });
    expect(keep).toBeDisabled();
    expect(keep).toHaveAccessibleDescription("Restore the later cut first.");
    expect(
      within(bar).getByRole("button", { name: "Hear" }),
    ).not.toHaveAttribute("aria-describedby");
  });

  it("draws a trailing control last in the row, after the primary", () => {
    sizes.mockReturnValue(40);
    widths.mockReturnValue(200);
    const anchor = document.createElement("div");
    anchor.getBoundingClientRect = () =>
      ({ left: 100, right: 300, top: 300, bottom: 330 }) as DOMRect;
    render(
      <ActionBar
        placement={{ form: "floating", anchorRef: { current: anchor } }}
        items={itemsOf(["hear", "comment"])}
        primary={{ id: "cut" }}
        trailing={<button type="button">Clear selection</button>}
        onVerb={vi.fn()}
      />,
    );
    const bar = screen.getByRole("group", { name: "Actions" });
    const names = within(bar)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(names.at(-1)).toBe("Clear selection");
    expect(names.indexOf("Cut")).toBeLessThan(names.length - 1);
    expect(
      within(bar).getByRole("button", { name: "Clear selection" })
        .parentElement,
    ).toHaveClass("sys-actions-trailing");
  });

  it("sits 8 px above the selection", () => {
    const bar = floatAt(300, 330);
    expect(bar.style.top).toBe("252px");
    expect(bar.style.left).toBe("100px");
  });

  it("flips below the selection when there is no room above", () => {
    expect(floatAt(2, 30).style.top).toBe("38px");
  });

  it("keeps the whole bar above a word while clearing its Script header", () => {
    sizes.mockReturnValue(40);
    widths.mockReturnValue(200);
    const anchor = document.createElement("div");
    anchor.getBoundingClientRect = () =>
      ({ left: 700, right: 740, top: 112, bottom: 136 }) as DOMRect;
    const header = document.createElement("div");
    header.getBoundingClientRect = () =>
      ({ left: 600, right: 1024, top: 48, bottom: 104 }) as DOMRect;
    const content = document.createElement("div");
    content.getBoundingClientRect = () =>
      ({ left: 0, right: 1024, top: 48, bottom: 700 }) as DOMRect;
    render(
      <ActionBar
        placement={{
          form: "floating",
          anchorRef: { current: anchor },
          exclusion: {
            elements: () => [header],
            withinRef: { current: content },
          },
        }}
        items={itemsOf(["hear", "comment"])}
        primary={{ id: "cut" }}
        onVerb={vi.fn()}
      />,
    );
    const bar = screen.getByRole("group", { name: "Actions" });
    expect(bar.style.top).toBe("64px");
    expect(bar.style.left).toBe("392px");
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

const exportSplit: BarItem = {
  id: "export",
  split: {
    label: "Export options",
    content: <button type="button">Also MP3</button>,
  },
};

describe("foldDock with a split item", () => {
  const key = (item: BarItem) =>
    item.arg ? `${item.id}:${item.arg}` : item.id;

  it("keeps a split verb in the dock and heads More with its options row", () => {
    const folded = foldDock(
      [{ id: "hear" }, exportSplit, { id: "more" }],
      itemsOf(["copy"]),
      0,
    );
    expect(folded.items.map(key)).toEqual(["hear", "export"]);
    expect(folded.more.map(key)).toEqual(["export:options", "copy"]);
    expect(folded.more[0]?.label).toBe("Export options");
  });

  it("gives More both rows when the fold took the split verb", () => {
    const folded = foldDock(
      [
        ...itemsOf(["hear", "keep", "split", "comment"]),
        exportSplit,
        { id: "remove" },
      ],
      [],
      1,
    );
    expect(folded.items.map(key)).toEqual(["hear", "keep", "split", "comment"]);
    expect(folded.more.map(key)).toEqual([
      "export",
      "export:options",
      "remove",
    ]);
  });
});

describe("ActionBar split item", () => {
  function inline(item: BarItem = exportSplit, onVerb = vi.fn()) {
    render(
      <div>
        <ActionBar
          placement={{ form: "inline" }}
          items={[{ id: "hear" }, item]}
          onVerb={onVerb}
        />
        <button type="button">Elsewhere</button>
      </div>,
    );
    return onVerb;
  }

  it("draws the verb and a chevron named by the split label", () => {
    inline();
    const chevron = screen.getByRole("button", { name: "Export options" });
    expect(chevron).toHaveAttribute("aria-haspopup", "dialog");
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: /^Export$/ })).toBeVisible();
  });

  it("runs the verb without opening the popover", async () => {
    const onVerb = inline();
    await userEvent.click(screen.getByRole("button", { name: /^Export$/ }));
    expect(onVerb.mock.calls).toEqual([["export"]]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the content in a dialog beside the chevron and passes axe", async () => {
    const onVerb = inline();
    const chevron = screen.getByRole("button", { name: "Export options" });
    await userEvent.click(chevron);
    const dialog = screen.getByRole("dialog", { name: "Export options" });
    expect(chevron).toHaveAttribute("aria-expanded", "true");
    expect(
      within(dialog).getByRole("button", { name: "Also MP3" }),
    ).toHaveFocus();
    expect(onVerb).not.toHaveBeenCalled();
    await expectNoA11yViolations(dialog);
    await expectNoA11yViolations(
      screen.getByRole("group", { name: "Actions" }),
    );
  });

  it("closes on Escape and returns focus to the chevron", async () => {
    inline();
    const chevron = screen.getByRole("button", { name: "Export options" });
    await userEvent.click(chevron);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(chevron).toHaveFocus();
    expect(chevron).toHaveAttribute("aria-expanded", "false");
  });

  it("closes on a press outside and leaves focus where the press put it", async () => {
    inline();
    await userEvent.click(
      screen.getByRole("button", { name: "Export options" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
  });

  it("toggles closed when the chevron is pressed again", async () => {
    inline();
    const chevron = screen.getByRole("button", { name: "Export options" });
    await userEvent.click(chevron);
    await userEvent.click(chevron);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("gates the verb and its chevron with the same reason", () => {
    inline({ ...exportSplit, disabledReason: "Select a range first." });
    expect(screen.getByRole("button", { name: /^Export$/ })).toBeDisabled();
    const chevron = screen.getByRole("button", { name: "Export options" });
    expect(chevron).toBeDisabled();
    expect(chevron).toHaveAttribute("title", "Select a range first.");
  });

  it("splits the floating icon verb the same way", async () => {
    const anchor = document.createElement("div");
    document.body.append(anchor);
    render(
      <ActionBar
        placement={{ form: "floating", anchorRef: { current: anchor } }}
        items={[exportSplit]}
        onVerb={vi.fn()}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Export options" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Export options" }),
    ).toBeVisible();
  });
});

describe("ActionBar dock with a split item", () => {
  it("draws the plain verb and lists the options in More", async () => {
    const onVerb = vi.fn();
    render(
      <ActionBar
        placement={{ form: "dock" }}
        items={[{ id: "hear" }, exportSplit, { id: "more" }]}
        more={itemsOf(["copy"])}
        onVerb={onVerb}
      />,
    );
    expect(screen.queryByRole("button", { name: "Export options" })).toBeNull();
    expect(
      screen.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["Hear", "Export", "More"]);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    const menu = screen.getByRole("menu", { name: "More actions" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Export options", "Copy"]);
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "Export options" }),
    );
    expect(onVerb.mock.calls).toEqual([["export", "options"]]);
    const sheet = await screen.findByRole("dialog", { name: "Export options" });
    expect(
      within(sheet).getByRole("button", { name: "Also MP3" }),
    ).toBeVisible();
    await userEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the open options sheet in step with the bar", async () => {
    const splitWith = (label: string): BarItem => ({
      id: "export",
      split: {
        label: "Export options",
        content: <button type="button">{label}</button>,
      },
    });
    const bar = (label: string) => (
      <ActionBar
        placement={{ form: "dock" }}
        items={[{ id: "hear" }, splitWith(label), { id: "more" }]}
        more={itemsOf(["copy"])}
        onVerb={vi.fn()}
      />
    );
    const { rerender } = render(bar("Also MP3 off"));
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Export options" }),
    );
    const sheet = await screen.findByRole("dialog", { name: "Export options" });
    expect(
      within(sheet).getByRole("button", { name: "Also MP3 off" }),
    ).toBeVisible();
    rerender(bar("Also MP3 on"));
    expect(
      within(screen.getByRole("dialog", { name: "Export options" })).getByRole(
        "button",
        { name: "Also MP3 on" },
      ),
    ).toBeVisible();
  });

  it("lists both rows when the fold took the verb into More", async () => {
    render(
      <ActionBar
        placement={{ form: "dock" }}
        items={[
          ...itemsOf(["hear", "keep", "split", "comment"]),
          exportSplit,
          { id: "more" },
        ]}
        primary={{ id: "cut" }}
        onVerb={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    const menu = screen.getByRole("menu", { name: "More actions" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Export", "Export options"]);
  });
});

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import {
  Presence,
  type PresencePerson,
  type PresenceProps,
  type PresenceSelection,
} from "./Presence";
import { presenceFlags } from "./presenceMath";

const drawn = vi.hoisted(() => ({ count: 0 }));

vi.mock("./presenceMath", async (importActual) => {
  const actual = await importActual<typeof import("./presenceMath")>();
  return {
    ...actual,
    pressSpan: (...args: Parameters<typeof actual.pressSpan>) => {
      drawn.count += 1;
      return actual.pressSpan(...args);
    },
  };
});

const people: readonly PresencePerson[] = [
  { id: "maya", name: "Maya Okafor", colorIndex: 0, playhead: 12.5 },
  { id: "anneke", name: "Anneke de Vries", colorIndex: 1, playhead: 14.5 },
];

const rows = [
  { id: "lane-1", top: 48, height: 72 },
  { id: "lane-2", top: 120, height: 104 },
];

const flagsOf = (
  who: readonly PresencePerson[],
  over: { hit?: number; width?: number } = {},
) =>
  presenceFlags(who, {
    start: 0,
    pxPerSecond: 24,
    width: over.width ?? 360,
    hit: over.hit ?? 24,
  });

const base: PresenceProps = {
  flags: flagsOf(people),
  rows,
  start: 0,
  pxPerSecond: 24,
  width: 360,
  hit: 24,
};

const everyone = new Set(["maya", "anneke", "a", "b", "c"]);

const setup = (over: Partial<PresenceProps> = {}) =>
  render(<Presence {...base} {...over} />);

const cluster: readonly PresencePerson[] = [
  { id: "a", name: "Ada Lovelace", colorIndex: 0, playhead: 5 },
  { id: "b", name: "Bo Chen", colorIndex: 1, playhead: 5.3 },
  { id: "c", name: "Cy Young", colorIndex: 2, playhead: 5.6 },
];

const person = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(
    `.sys-presence-person[data-person="${id}"]`,
  );
const flagOf = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(
    `.sys-presence-flag[data-person="${id}"]`,
  );

describe("Presence", () => {
  it("draws a line for each person at the playhead's whole pixel and a flag with their initial", () => {
    const { container } = setup();
    expect(
      person(container, "maya")?.style.getPropertyValue("--sys-presence-x"),
    ).toBe("300px");
    expect(
      person(container, "maya")?.querySelector(".sys-presence-line"),
    ).not.toBeNull();
    expect(flagOf(container, "maya")?.textContent).toBe("M");
    expect(
      person(container, "anneke")?.style.getPropertyValue("--sys-presence-x"),
    ).toBe("348px");
  });

  it("stops the line at the bottom of the last lane", () => {
    const { container } = setup();
    expect(
      container
        .querySelector<HTMLElement>(".sys-presence")
        ?.style.getPropertyValue("--sys-presence-end"),
    ).toBe("224px");
  });

  it("lets the line run the full height when there are no lanes", () => {
    const { container } = setup({ rows: [] });
    expect(
      container
        .querySelector<HTMLElement>(".sys-presence")
        ?.style.getPropertyValue("--sys-presence-end"),
    ).toBe("");
  });

  it("shows a whole astral initial on the flag", () => {
    const { container } = setup({
      flags: flagsOf([{ id: "x", name: "𠮷野", colorIndex: 0, playhead: 2 }]),
    });
    expect(container.querySelector(".sys-presence-flag")?.textContent).toBe(
      "𠮷",
    );
  });

  it("colours each line and its flag from its person", () => {
    const { container } = setup();
    expect(
      person(container, "anneke")?.style.getPropertyValue(
        "--sys-presence-color",
      ),
    ).toBe("var(--color-presence-1)");
    expect(
      flagOf(container, "anneke")
        ?.closest<HTMLElement>(".sys-presence-hit")
        ?.style.getPropertyValue("--sys-presence-color"),
    ).toBe("var(--color-presence-1)");
  });

  it("puts the flag left of its line when it would pass the right edge", () => {
    const { container } = setup();
    const side = (id: string) =>
      flagOf(container, id)
        ?.closest<HTMLElement>(".sys-presence-hit")
        ?.getAttribute("data-side");
    expect(side("maya")).toBe("right");
    expect(side("anneke")).toBe("left");
  });

  it("draws nothing for a person with no playhead or one off the window", () => {
    const { container } = setup({
      flags: flagsOf([
        { id: "a", name: "A", colorIndex: 0 },
        { id: "b", name: "B", colorIndex: 1, playhead: 100 },
        { id: "c", name: "C", colorIndex: 2, playhead: 15.2 },
      ]),
    });
    expect(person(container, "a")).toBeNull();
    expect(person(container, "b")).toBeNull();
    expect(person(container, "c")).not.toBeNull();
  });

  it("has no axe violations, plain or with buttons", async () => {
    const plain = setup();
    await expectNoA11yViolations(plain.container);
    plain.unmount();
    const live = setup({
      jumpable: everyone,
      flags: flagsOf([
        ...people,
        ...cluster.map((p) => ({ ...p, playhead: 2 + (p.playhead ?? 0) / 10 })),
      ]),
    });
    expect(live.container.querySelectorAll("button").length).toBeGreaterThan(1);
    await expectNoA11yViolations(live.container);
  });
});

describe("Presence flags as buttons", () => {
  it("is aria-hidden, and its buttons are real, typed, out of the tab order and hold the touch-action", () => {
    const { container } = setup({ jumpable: everyone });
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button).toHaveAttribute("type", "button");
      expect(button).toHaveAttribute("tabindex", "-1");
      expect(button).toHaveClass("sys-presence-hit");
    }
  });

  it("sizes the button's own box to the press area and centres it on the pill", () => {
    const { container } = setup({ jumpable: everyone, hit: 44 });
    const button = container.querySelector<HTMLElement>("button");
    expect(
      container
        .querySelector<HTMLElement>(".sys-presence")
        ?.style.getPropertyValue("--sys-presence-hit"),
    ).toBe("44px");
    expect(button?.style.getPropertyValue("--sys-presence-hit-w")).toBe("44px");
    expect(button?.style.getPropertyValue("--sys-presence-hit-left")).toBe(
      `${300 + 1 + 8 - 22}px`,
    );
    expect(button?.style.getPropertyValue("--sys-presence-w")).toBe("16px");
  });

  it("jumps to a single person on click", () => {
    const onGoTo = vi.fn();
    const onGroup = vi.fn();
    const { container } = setup({ jumpable: everyone, onGoTo, onGroup });
    fireEvent.click(flagOf(container, "maya")!.closest("button")!);
    expect(onGoTo).toHaveBeenCalledExactlyOnceWith("maya");
    expect(onGroup).not.toHaveBeenCalled();
  });

  it("is a plain mark, not a button, when the person cannot be jumped to", () => {
    const onGoTo = vi.fn();
    const { container } = setup({
      jumpable: new Set(["maya"]),
      onGoTo,
    });
    expect(container.querySelectorAll("button")).toHaveLength(1);
    const plain = flagOf(container, "anneke")?.closest(".sys-presence-hit");
    expect(plain?.tagName).toBe("SPAN");
    fireEvent.click(plain!);
    expect(onGoTo).not.toHaveBeenCalled();
  });

  it("is plain everywhere with no jumpable people", () => {
    const { container } = setup();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelectorAll(".sys-presence-flag")).toHaveLength(2);
  });
});

describe("Presence group flags", () => {
  const groupSetup = (over: Partial<PresenceProps> = {}) =>
    setup({ flags: flagsOf(cluster), jumpable: everyone, ...over });

  it("draws one neutral +N flag with every line in its own colour", () => {
    const { container } = groupSetup();
    expect(container.querySelectorAll(".sys-presence-line")).toHaveLength(3);
    const flags = container.querySelectorAll(".sys-presence-flag");
    expect(flags).toHaveLength(1);
    expect(flags[0]).toHaveTextContent("+3");
    expect(flags[0]).toHaveClass("sys-presence-flag--group");
    expect(
      person(container, "c")?.style.getPropertyValue("--sys-presence-color"),
    ).toBe("var(--color-presence-2)");
  });

  it("names its members in the tooltip, three and then a count", () => {
    const { container } = groupSetup();
    expect(container.querySelector("button")).toHaveAttribute(
      "title",
      "Ada Lovelace, Bo Chen, Cy Young",
    );
    const four = flagsOf([
      ...cluster,
      { id: "d", name: "Di Park", colorIndex: 3, playhead: 5.1 },
    ]);
    const { container: other } = setup({ flags: four, jumpable: everyone });
    expect(other.querySelector("button")).toHaveAttribute(
      "title",
      "Ada Lovelace, Di Park, Bo Chen and 1 more",
    );
  });

  it("reports the group and the pill's box on click, not a jump", () => {
    const onGoTo = vi.fn();
    const onGroup = vi.fn();
    const { container } = groupSetup({ onGoTo, onGroup });
    fireEvent.click(container.querySelector("button")!);
    expect(onGoTo).not.toHaveBeenCalled();
    expect(onGroup).toHaveBeenCalledTimes(1);
    expect(onGroup.mock.calls[0]![0]).toBe("a,b,c");
    expect(onGroup.mock.calls[0]![1]).toHaveProperty("width");
  });

  it("is a plain mark when none of its members can be jumped to", () => {
    const { container } = groupSetup({ jumpable: new Set() });
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector(".sys-presence-flag")).toHaveTextContent(
      "+3",
    );
  });

  it("flips a group at the right edge left of its leftmost line", () => {
    const { container } = setup({
      flags: flagsOf([
        { id: "a", name: "A", colorIndex: 0, playhead: 14.3 },
        { id: "b", name: "B", colorIndex: 1, playhead: 14.6 },
      ]),
      jumpable: everyone,
    });
    expect(container.querySelector("button")).toHaveAttribute(
      "data-side",
      "left",
    );
  });
});

describe("Presence selections", () => {
  const selection: PresenceSelection = {
    id: "s1",
    personId: "maya",
    laneId: "lane-1",
    start: 2,
    end: 10,
    colorIndex: 0,
  };

  it("outlines a span in its lane's row", () => {
    const { container } = setup({ selections: [selection] });
    const box = container.querySelector<HTMLElement>(".sys-presence-sel");
    expect(box?.style.getPropertyValue("--sys-presence-top")).toBe("48px");
    expect(box?.style.getPropertyValue("--sys-presence-height")).toBe("72px");
    expect(box?.style.getPropertyValue("--sys-presence-left")).toBe("48px");
    expect(box?.style.getPropertyValue("--sys-presence-right")).toBe("240px");
    expect(box).not.toHaveAttribute("data-clip-start");
    expect(box).not.toHaveAttribute("data-clip-end");
  });

  it("uses the second lane's row for a span in the second lane", () => {
    const { container } = setup({
      selections: [{ ...selection, laneId: "lane-2" }],
    });
    const box = container.querySelector<HTMLElement>(".sys-presence-sel");
    expect(box?.style.getPropertyValue("--sys-presence-top")).toBe("120px");
    expect(box?.style.getPropertyValue("--sys-presence-height")).toBe("104px");
  });

  it("leaves off the edge a span runs past", () => {
    const { container } = setup({
      selections: [{ ...selection, start: -5, end: 20 }],
    });
    const box = container.querySelector<HTMLElement>(".sys-presence-sel");
    expect(box).toHaveAttribute("data-clip-start");
    expect(box).toHaveAttribute("data-clip-end");
    expect(box?.style.getPropertyValue("--sys-presence-left")).toBe("0px");
    expect(box?.style.getPropertyValue("--sys-presence-right")).toBe("360px");
  });

  it("draws nothing for an unknown lane, an empty or off-window span, or the followed person", () => {
    const { container, rerender } = setup({
      selections: [
        { ...selection, id: "x1", laneId: "nope" },
        { ...selection, id: "x2", end: 2 },
        { ...selection, id: "x3", start: 100, end: 110 },
      ],
    });
    expect(container.querySelector(".sys-presence-sel")).toBeNull();
    rerender(<Presence {...base} selections={[selection]} followed="maya" />);
    expect(container.querySelector(".sys-presence-sel")).toBeNull();
  });
});

describe("Presence drawing", () => {
  it("does not draw again for the same props", () => {
    const { rerender } = render(<Presence {...base} />);
    expect(drawn.count).toBeGreaterThan(0);
    const before = drawn.count;
    rerender(<Presence {...base} />);
    expect(drawn.count).toBe(before);
    rerender(
      <Presence {...base} flags={flagsOf(people, { hit: 44 })} hit={44} />,
    );
    expect(drawn.count).toBeGreaterThan(before);
  });
});

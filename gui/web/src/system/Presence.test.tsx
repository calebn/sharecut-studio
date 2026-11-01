import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import {
  Presence,
  type PresencePerson,
  type PresenceProps,
  type PresenceSelection,
} from "./Presence";

const drawn = vi.hoisted(() => ({ count: 0 }));

vi.mock("./presenceMath", async (importActual) => {
  const actual = await importActual<typeof import("./presenceMath")>();
  return {
    ...actual,
    presenceX: (...args: Parameters<typeof actual.presenceX>) => {
      drawn.count += 1;
      return actual.presenceX(...args);
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

const base: PresenceProps = {
  people,
  rows,
  start: 0,
  pxPerSecond: 24,
  width: 360,
};

const setup = (over: Partial<PresenceProps> = {}) =>
  render(<Presence {...base} {...over} />);

const person = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-person="${id}"]`);

describe("Presence", () => {
  it("draws a line and a flag for each person at the playhead's whole pixel", () => {
    const { container } = setup();
    const maya = person(container, "maya");
    expect(maya?.style.getPropertyValue("--sys-presence-x")).toBe("300px");
    expect(maya?.querySelector(".sys-presence-line")).not.toBeNull();
    expect(maya?.querySelector(".sys-presence-flag")?.textContent).toBe("M");
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
      people: [{ id: "x", name: "𠮷野", colorIndex: 0, playhead: 2 }],
    });
    expect(container.querySelector(".sys-presence-flag")?.textContent).toBe(
      "𠮷",
    );
  });

  it("colours each from its person", () => {
    const { container } = setup();
    expect(
      person(container, "anneke")?.style.getPropertyValue(
        "--sys-presence-color",
      ),
    ).toBe("var(--color-presence-1)");
  });

  it("is hidden from assistive tech and has nothing to focus", () => {
    const { container } = setup();
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("button, a, [tabindex]")).toBeNull();
  });

  it("puts the flag left of its line when it would pass the right edge", () => {
    const { container } = setup();
    expect(
      person(container, "maya")?.querySelector(".sys-presence-flag"),
    ).toHaveClass("sys-presence-flag--right");
    expect(
      person(container, "anneke")?.querySelector(".sys-presence-flag"),
    ).toHaveClass("sys-presence-flag--left");
  });

  it("draws nothing for a person with no playhead or one off the window", () => {
    const { container } = setup({
      people: [
        { id: "a", name: "A", colorIndex: 0 },
        { id: "b", name: "B", colorIndex: 1, playhead: 100 },
        { id: "c", name: "C", colorIndex: 2, playhead: 15.2 },
      ],
    });
    expect(person(container, "a")).toBeNull();
    expect(person(container, "b")).toBeNull();
    expect(person(container, "c")).not.toBeNull();
  });

  it("draws nothing for the person you follow", () => {
    const { container } = setup({ followed: "maya" });
    expect(person(container, "maya")).toBeNull();
    expect(person(container, "anneke")).not.toBeNull();
  });

  it("has no axe violations", async () => {
    const { container } = setup();
    await expectNoA11yViolations(container);
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
    rerender(<Presence {...base} start={1} />);
    expect(drawn.count).toBeGreaterThan(before);
  });
});

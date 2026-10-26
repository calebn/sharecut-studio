import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AbAudition } from "./AbAudition";
import { auditionSegments } from "./auditionWindow";

const change = { start: 1114, end: 1115 };

describe("auditionSegments", () => {
  it("plays the original across the change, 3 s either side", () => {
    expect(auditionSegments("A", change)).toEqual([{ start: 1111, end: 1118 }]);
  });

  it("plays the edit as the lead-in then the lead-out", () => {
    expect(auditionSegments("B", change)).toEqual([
      { start: 1111, end: 1114 },
      { start: 1115, end: 1118 },
    ]);
  });

  it("does not start before the episode", () => {
    expect(auditionSegments("A", { start: 1, end: 2 })[0]?.start).toBe(0);
  });

  it("leaves out an empty lead-in at the very start", () => {
    expect(auditionSegments("B", { start: 0, end: 1 })).toEqual([
      { start: 1, end: 4 },
    ]);
  });
});

describe("AbAudition", () => {
  it("marks the chosen side and reports what each side plays", async () => {
    const onSelect = vi.fn();
    render(<AbAudition side="B" change={change} onSelect={onSelect} />);
    expect(screen.getByRole("button", { name: "B" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(screen.getByRole("button", { name: "A" }));
    expect(onSelect).toHaveBeenCalledWith("A", [{ start: 1111, end: 1118 }]);
  });

  it("names the A and B keys", () => {
    render(<AbAudition side="A" change={change} onSelect={() => undefined} />);
    expect(screen.getByRole("button", { name: "A" })).toHaveAttribute(
      "aria-keyshortcuts",
      "A",
    );
    expect(screen.getByRole("button", { name: "B" })).toHaveAttribute(
      "aria-keyshortcuts",
      "B",
    );
  });
});

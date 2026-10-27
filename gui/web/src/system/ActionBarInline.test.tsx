import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ActionBarInline, type ActionBarInlineProps } from "./ActionBarInline";

const handlers = () => ({
  onKeep: vi.fn(),
  onVerb: vi.fn(),
  onLater: vi.fn(),
  onOpenInEdit: vi.fn(),
  onComment: vi.fn(),
});

const buttons = () =>
  within(screen.getByRole("group", { name: "Actions" }))
    .getAllByRole("button")
    .map((button) => button.textContent);

const show = (props: Partial<ActionBarInlineProps>) =>
  render(<ActionBarInline verb="cut" {...handlers()} {...props} />);

describe("ActionBarInline", () => {
  it("reads Open in Edit, Keep, Later, then the verb", () => {
    show({});
    expect(buttons()).toEqual(["Open in Edit", "Keep", "Later", "Cut"]);
  });

  it("sends each button to its own handler", async () => {
    const calls = handlers();
    show(calls);
    for (const name of ["Keep", "Later", "Cut", "Open in Edit"])
      await userEvent.click(screen.getByRole("button", { name }));
    expect(
      [calls.onKeep, calls.onLater, calls.onVerb, calls.onOpenInEdit].map(
        (fn) => fn.mock.calls.length,
      ),
    ).toEqual([1, 1, 1, 1]);
  });

  it("leaves out the verb while a prompt is open", () => {
    show({ promptOpen: true });
    expect(buttons()).toEqual(["Open in Edit", "Keep", "Later"]);
  });

  it("leaves out the verb for an object with none", () => {
    show({ verb: undefined });
    expect(buttons()).toEqual(["Open in Edit", "Keep", "Later"]);
  });

  it("gives the phone dock Keep and the verb, with A/B between", () => {
    show({ form: "dock", center: <span>A/B</span> });
    expect(buttons()).toEqual(["Keep", "Cut"]);
    expect(screen.getByText("A/B")).toBeInTheDocument();
  });

  it("shows a read-only guest Comment and nothing that decides", () => {
    show({ readOnly: true });
    expect(buttons()).toEqual(["Comment"]);
  });

  it("adds Open in Edit for a read-only guest who can edit", () => {
    show({ readOnly: true, canEdit: true });
    expect(buttons()).toEqual(["Comment", "Open in Edit"]);
  });

  it("keeps Comment in a read-only phone dock", () => {
    show({ readOnly: true, form: "dock" });
    expect(buttons()).toEqual(["Comment"]);
  });
});

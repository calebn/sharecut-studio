import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import {
  ActionBarInline,
  type ActionBarInlineProps,
  ActionPrompt,
} from "./ActionBarInline";

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

  it("associates an unavailable Open in Edit action with its visible reason", async () => {
    const calls = handlers();
    const reason = "The transcript is loading.";
    const unavailable = {
      ...calls,
      openInEditDisabledReason: reason,
      openInEditNoteId: "word-loading",
    };
    const { container, rerender } = render(
      <>
        <p id="word-loading">{reason}</p>
        <ActionBarInline verb="cut" {...unavailable} />
      </>,
    );
    const open = screen.getByRole("button", { name: "Open in Edit" });
    expect(open).toBeDisabled();
    expect(open).toHaveAccessibleDescription(reason);
    await userEvent.click(open);
    expect(calls.onOpenInEdit).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
    rerender(<ActionBarInline verb="cut" {...calls} />);
    await userEvent.click(screen.getByRole("button", { name: "Open in Edit" }));
    expect(calls.onOpenInEdit).toHaveBeenCalledOnce();
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

describe("ActionPrompt note", () => {
  const open = async () => {
    const onConfirm = vi.fn();
    render(<ActionPrompt verb="cut" onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole("button", { name: "Add a note" }));
    return {
      onConfirm,
      note: screen.getByRole("textbox", { name: "Your reason" }),
    };
  };

  it("confirms once on Enter and ignores a held Enter", async () => {
    const { onConfirm, note } = await open();
    expect(fireEvent.keyDown(note, { key: "Enter", repeat: true })).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.keyDown(note, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("does not confirm during an IME composition", async () => {
    const { onConfirm, note } = await open();
    fireEvent.keyDown(note, { key: "Enter", isComposing: true });
    fireEvent.keyDown(note, { key: "Enter", keyCode: 229 });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("guards click, form submit and Enter while confirmation is unavailable", async () => {
    const onConfirm = vi.fn();
    const onCheck = vi.fn();
    const props = { onConfirm, onCheck, checkLabel: "Check words" };
    const blocked = {
      confirmDisabledReason: "The suggestion cannot be cut right now.",
    };
    const user = userEvent.setup();
    const view = render(<ActionPrompt verb="cut" {...props} />);
    await user.click(screen.getByRole("button", { name: "Add a note" }));
    const note = screen.getByRole("textbox", { name: "Your reason" });
    await user.type(note, "  Reviewed the audio  ");
    view.rerender(<ActionPrompt verb="cut" {...props} {...blocked} />);

    const cut = screen.getByRole("button", { name: "Cut anyway" });
    expect(cut).toBeDisabled();
    expect(cut).toHaveAccessibleDescription(blocked.confirmDisabledReason);
    expect(screen.getByText(blocked.confirmDisabledReason)).toBeVisible();
    expect(note).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.click(cut);
    fireEvent.submit(screen.getByRole("form", { name: "Cut anyway" }));
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Check words" }));
    expect(onCheck).toHaveBeenCalledOnce();
    await expectNoA11yViolations(view.container);

    view.rerender(<ActionPrompt verb="cut" {...props} />);
    expect(cut).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Your reason" })).toBe(note);
    await user.click(cut);
    expect(onConfirm.mock.calls).toEqual([["Reviewed the audio"]]);
  });
});

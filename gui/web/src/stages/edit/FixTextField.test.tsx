import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { FixTextField } from "./FixTextField";

function setup(value = "small room") {
  const onDone = vi.fn();
  const view = render(
    <>
      <FixTextField value={value} label="Fix text, 2 words" onDone={onDone} />
      <button type="button">Elsewhere</button>
    </>,
  );
  return { onDone, ...view, field: screen.getByRole("textbox") };
}

describe("FixTextField", () => {
  it("takes focus with its words selected, named for the host's label", async () => {
    const { field, container } = setup();
    expect(field).toHaveAccessibleName("Fix text, 2 words");
    expect(field).toHaveFocus();
    expect(
      (field as HTMLInputElement).value.slice(
        (field as HTMLInputElement).selectionStart ?? 0,
        (field as HTMLInputElement).selectionEnd ?? 0,
      ),
    ).toBe("small room");
    await expectNoA11yViolations(container);
  });

  it("commits the new words on Enter, once", async () => {
    const user = userEvent.setup();
    const { onDone } = setup();
    await user.keyboard("tiny space{Enter}");
    screen.getByRole("button", { name: "Elsewhere" }).focus();
    expect(onDone.mock.calls).toEqual([["tiny space", "enter"]]);
  });

  it("squeezes spaces and trims the ends", async () => {
    const user = userEvent.setup();
    const { onDone } = setup();
    await user.keyboard("  big   quiet room {Enter}");
    expect(onDone.mock.calls).toEqual([["big quiet room", "enter"]]);
  });

  it("reverts on Esc and does not commit when focus then leaves", async () => {
    const user = userEvent.setup();
    const { onDone } = setup();
    await user.keyboard("other{Escape}");
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(onDone.mock.calls).toEqual([[null, "escape"]]);
  });

  it("keeps Esc from reaching the pane or a sheet around the field", () => {
    const { field } = setup();
    expect(fireEvent.keyDown(field, { key: "Escape" })).toBe(false);
  });

  it("commits on a click outside", async () => {
    const user = userEvent.setup();
    const { onDone } = setup();
    await user.keyboard("tiny space");
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(onDone.mock.calls).toEqual([["tiny space", "blur"]]);
  });

  it("commits on Tab and says so, so the host can step to the next unsure word", async () => {
    const user = userEvent.setup();
    const { onDone } = setup();
    await user.keyboard("tiny space{Tab}");
    expect(onDone.mock.calls).toEqual([["tiny space", "tab"]]);
    expect(screen.getByRole("textbox")).toHaveFocus();
  });

  it("changes nothing for the same words or an empty field", async () => {
    const user = userEvent.setup();
    const same = setup();
    await user.keyboard("{Enter}");
    expect(same.onDone.mock.calls).toEqual([[null, "enter"]]);
    same.unmount();
    const empty = setup();
    await user.keyboard("{Backspace}{Enter}");
    expect(empty.onDone.mock.calls).toEqual([[null, "enter"]]);
  });

  it("waits while an input method is composing", () => {
    const { field, onDone } = setup();
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    expect(onDone).not.toHaveBeenCalled();
  });

  it("sizes itself to what is typed", async () => {
    const user = userEvent.setup();
    const { field } = setup("a");
    expect(field.style.getPropertyValue("--sys-fix-chars")).toBe("1");
    await user.keyboard("bcdef");
    expect(field.style.getPropertyValue("--sys-fix-chars")).toBe("5");
  });
});

import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { FixTextField } from "./FixTextField";

function setup(value = "small room", over = {}) {
  const onDone = vi.fn();
  const view = render(
    <>
      <FixTextField
        value={value}
        label="Fix text, 2 words"
        onDone={onDone}
        {...over}
      />
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
    expect(onDone.mock.calls).toEqual([["tiny space", "enter", "small room"]]);
  });

  it("squeezes spaces and trims the ends", async () => {
    const user = userEvent.setup();
    const { onDone } = setup();
    await user.keyboard("  big   quiet room {Enter}");
    expect(onDone.mock.calls).toEqual([
      ["big quiet room", "enter", "small room"],
    ]);
  });

  it("reverts on Esc and does not commit when focus then leaves", async () => {
    const user = userEvent.setup();
    const { onDone } = setup();
    await user.keyboard("other{Escape}");
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(onDone.mock.calls).toEqual([[null, "escape", "small room"]]);
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
    expect(onDone.mock.calls).toEqual([["tiny space", "blur", "small room"]]);
  });

  it("commits on Tab and says so, so the host can step to the next unsure word", async () => {
    const user = userEvent.setup();
    const { onDone } = setup();
    await user.keyboard("tiny space{Tab}");
    expect(onDone.mock.calls).toEqual([["tiny space", "tab", "small room"]]);
    expect(screen.getByRole("textbox")).toHaveFocus();
  });

  it("changes nothing for the same words or an empty field", async () => {
    const user = userEvent.setup();
    const same = setup();
    await user.keyboard("{Enter}");
    expect(same.onDone.mock.calls).toEqual([[null, "enter", "small room"]]);
    same.unmount();
    const empty = setup();
    await user.keyboard("{Backspace}{Enter}");
    expect(empty.onDone.mock.calls).toEqual([[null, "enter", "small room"]]);
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

  it("hands the host the words it opened with, even after the value prop moves on", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    const { rerender } = render(
      <FixTextField value="small room" label="Fix" onDone={onDone} />,
    );
    rerender(<FixTextField value="tiny space" label="Fix" onDone={onDone} />);
    await user.keyboard("big hall{Enter}");
    expect(onDone.mock.calls).toEqual([["big hall", "enter", "small room"]]);
  });

  it("stays open with the typing and the reason when the host answers with a message", async () => {
    const user = userEvent.setup();
    const onDone = vi
      .fn()
      .mockResolvedValueOnce("The transcript changed. Try again.")
      .mockResolvedValueOnce(undefined);
    render(<FixTextField value="small room" label="Fix" onDone={onDone} />);
    await user.keyboard("tiny space{Enter}");
    const field = screen.getByRole("textbox");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The transcript changed. Try again.",
    );
    expect(field).toHaveValue("tiny space");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onDone).toHaveBeenCalledTimes(2);
    expect(onDone.mock.calls[1]).toEqual(["tiny space", "enter", "small room"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stays open when the host's promise rejects, and is read only while it works", async () => {
    const user = userEvent.setup();
    let fail: (reason: Error) => void = () => undefined;
    const onDone = vi.fn(
      () => new Promise<void>((_, reject) => (fail = reject)),
    );
    render(<FixTextField value="small room" label="Fix" onDone={onDone} />);
    await user.keyboard("tiny space{Enter}{Enter}");
    const field = screen.getByRole("textbox");
    expect(field).toHaveAttribute("readonly");
    expect(onDone).toHaveBeenCalledTimes(1);
    await act(async () => fail(new Error("Offline.")));
    expect(screen.getByRole("alert")).toHaveTextContent("Offline.");
    expect(field).not.toHaveAttribute("readonly");
    expect(field).toHaveValue("tiny space");
  });

  it("closes for good when the host takes the words", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn().mockResolvedValue(undefined);
    render(<FixTextField value="small room" label="Fix" onDone={onDone} />);
    await user.keyboard("tiny space{Enter}{Enter}");
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("holds a commit the host's validation refuses and says why", async () => {
    const user = userEvent.setup();
    const validate = vi.fn((text: string) =>
      text === "" ? "Enter a name." : undefined,
    );
    const { onDone } = setup("small room", { validate });
    await user.keyboard("{Backspace}{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a name.");
    expect(onDone).not.toHaveBeenCalled();
    await user.keyboard("tiny{Enter}");
    expect(onDone.mock.calls).toEqual([["tiny", "enter", "small room"]]);
  });

  it("cancels instead of committing when leaving is off", async () => {
    const user = userEvent.setup();
    const { onDone } = setup("small room", { commitOnBlur: false });
    await user.keyboard("tiny space");
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(onDone.mock.calls).toEqual([[null, "blur", "small room"]]);
  });

  it("saves no draft when the field is removed rather than left", async () => {
    const user = userEvent.setup();
    const { onDone, field } = setup();
    await user.keyboard("tiny space");
    const parent = field.parentElement as HTMLElement;
    field.remove();
    field.dispatchEvent(new FocusEvent("blur"));
    parent.append(field);
    expect(onDone).not.toHaveBeenCalled();
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InlineEdit } from "./InlineEdit";

function setup(props: Partial<React.ComponentProps<typeof InlineEdit>> = {}) {
  const onCommit = vi.fn();
  const onEnd = vi.fn();
  const user = userEvent.setup();
  const utils = render(
    <>
      <InlineEdit
        label="Name"
        value="Ana"
        onCommit={onCommit}
        onEnd={onEnd}
        {...props}
      />
      <button type="button">Elsewhere</button>
    </>,
  );
  return { ...utils, user, onCommit, onEnd };
}

const field = () => screen.getByRole("textbox", { name: "Name" });

describe("InlineEdit", () => {
  it("commits a changed text on Enter and reports the end", async () => {
    const { user, onCommit, onEnd } = setup();
    await user.click(field());
    await user.keyboard("{End}!{Enter}");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("Ana!");
    expect(onEnd).toHaveBeenCalledExactlyOnceWith("enter");
  });

  it("commits on blur", async () => {
    const { user, onCommit, onEnd } = setup();
    await user.click(field());
    await user.keyboard("{End}!");
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("Ana!");
    expect(onEnd).toHaveBeenCalledExactlyOnceWith("blur");
  });

  it("sends nothing when the text did not change", async () => {
    const { user, onCommit, onEnd } = setup();
    await user.click(field());
    await user.keyboard("{Enter}");
    expect(onCommit).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledExactlyOnceWith("enter");
  });

  it("Escape puts the value back and a blur after it is ignored", async () => {
    const { user, onCommit, onEnd } = setup();
    await user.click(field());
    await user.keyboard("zzz{Escape}");
    expect(field()).toHaveValue("Ana");
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(onCommit).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledExactlyOnceWith("escape");
  });

  it("takes an Escape that had text to put back and lets an unchanged one through", async () => {
    const { user, onEnd } = setup();
    await user.click(field());
    await user.keyboard("zzz");
    expect(fireEvent.keyDown(field(), { key: "Escape" })).toBe(false);
    expect(field()).toHaveValue("Ana");
    expect(fireEvent.keyDown(field(), { key: "Escape" })).toBe(true);
    expect(onEnd).toHaveBeenNthCalledWith(1, "escape");
    expect(onEnd).toHaveBeenNthCalledWith(2, "escape");
  });

  it("sends the same text again when the parent ignored the first commit", async () => {
    const { user, onCommit } = setup();
    await user.click(field());
    await user.keyboard("{End}!{Enter}");
    await user.click(field());
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenLastCalledWith("Ana!");
  });

  it("takes a new value from the parent", () => {
    const { rerender } = setup();
    rerender(<InlineEdit label="Name" value="Mira" onCommit={vi.fn()} />);
    expect(field()).toHaveValue("Mira");
  });

  it("breaks the line on Shift+Enter in a multiline field and commits on Enter", async () => {
    const { user, onCommit } = setup({ multiline: true });
    await user.click(field());
    await user.keyboard("{End}{Shift>}{Enter}{/Shift}b{Enter}");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("Ana\nb");
  });

  it("sends typed text on unmount only when asked, and not after Escape", async () => {
    const first = setup({ commitOnUnmount: true });
    await first.user.click(field());
    await first.user.keyboard("{End}!");
    first.unmount();
    expect(first.onCommit).toHaveBeenCalledExactlyOnceWith("Ana!");

    const escaped = setup({ commitOnUnmount: true });
    await escaped.user.click(field());
    await escaped.user.keyboard("zzz{Escape}");
    escaped.unmount();
    expect(escaped.onCommit).not.toHaveBeenCalled();

    const plain = setup();
    await plain.user.click(field());
    await plain.user.keyboard("{End}!");
    plain.unmount();
    expect(plain.onCommit).not.toHaveBeenCalled();
  });

  it("ignores Enter and Escape while read-only, and a blur puts the stored text back", async () => {
    const { user, onCommit, onEnd, rerender } = setup();
    await user.click(field());
    await user.keyboard("{End}!");
    rerender(
      <InlineEdit
        label="Name"
        value="Ana"
        onCommit={onCommit}
        onEnd={onEnd}
        readOnly
      />,
    );
    fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.keyDown(field(), { key: "Escape" });
    fireEvent.blur(field());
    expect(onCommit).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
    expect(field()).toHaveValue("Ana");
  });

  it("commits a draft held while read-only once the field is writable again", async () => {
    const { user, onCommit, rerender } = setup();
    await user.click(field());
    await user.keyboard("{End}!");
    rerender(
      <InlineEdit label="Name" value="Ana" onCommit={onCommit} readOnly />,
    );
    fireEvent.keyDown(field(), { key: "Enter" });
    rerender(<InlineEdit label="Name" value="Ana" onCommit={onCommit} />);
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("Ana!");
  });

  it("keeps the text a blur already sent while its save runs", async () => {
    const { user, onCommit, rerender } = setup();
    await user.click(field());
    await user.keyboard("{End}!");
    fireEvent.blur(field());
    rerender(
      <InlineEdit label="Name" value="Ana" onCommit={onCommit} readOnly />,
    );
    fireEvent.focus(field());
    fireEvent.blur(field());
    expect(field()).toHaveValue("Ana!");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("Ana!");
  });

  it("shows the trimmed text after a commit that changes nothing", async () => {
    const { user, onCommit } = setup({ trim: true });
    await user.click(field());
    await user.keyboard("{End}  {Enter}");
    expect(field()).toHaveValue("Ana");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits the trimmed text", async () => {
    const { user, onCommit } = setup({ trim: true });
    await user.click(field());
    await user.keyboard("{End}! {Enter}");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("Ana!");
    expect(field()).toHaveValue("Ana!");
  });

  it("shows the stored text again when the parent refuses the commit", async () => {
    const { user, onCommit } = setup({ trim: true });
    onCommit.mockReturnValue(false);
    await user.click(field());
    await user.keyboard("{Control>}a{/Control}{Backspace}{Enter}");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("");
    expect(field()).toHaveValue("Ana");
  });

  it("sends nothing for a focus and blur over a stored text with a trailing space", async () => {
    const { user, onCommit } = setup({ trim: true, value: "Ana " });
    await user.click(field());
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(onCommit).not.toHaveBeenCalled();
    expect(field()).toHaveValue("Ana ");
  });

  it("forgets what it sent once the stored text changes", () => {
    const { onCommit, rerender } = setup({ trim: true });
    const edit = (value: string, readOnly: boolean) => (
      <InlineEdit
        label="Name"
        value={value}
        onCommit={onCommit}
        readOnly={readOnly}
        trim
      />
    );
    onCommit.mockReturnValue(false);
    fireEvent.change(field(), { target: { value: "Bob" } });
    fireEvent.blur(field());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("Bob");
    rerender(edit("Cy", false));
    fireEvent.change(field(), { target: { value: "Bob" } });
    rerender(edit("Cy", true));
    fireEvent.blur(field());
    expect(field()).toHaveValue("Cy");
  });
});

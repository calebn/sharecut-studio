import { render, screen } from "@testing-library/react";
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
});

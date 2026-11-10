import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { homeKeyAction, useHomeKeys } from "./useHomeKeys";

const key = (
  name: string,
  mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {},
) => ({ key: name, metaKey: false, ctrlKey: false, altKey: false, ...mods });

describe("homeKeyAction", () => {
  it.each([
    ["Mod+I imports", key("i", { ctrlKey: true }), "onImport"],
    ["Cmd+I imports", key("i", { metaKey: true }), "onImport"],
    ["Mod+O opens other", key("o", { ctrlKey: true }), "onOpenOther"],
    ["R records", key("r"), "onRecord"],
    ["? helps", key("?"), "onPalette"],
  ])("%s", (_name, event, action) => {
    expect(homeKeyAction(event)).toBe(action);
  });

  it.each([
    ["Mod+R is the browser's reload", key("r", { ctrlKey: true })],
    ["Mod+N is the browser's new window", key("n", { ctrlKey: true })],
    ["Alt+R", key("r", { altKey: true })],
    ["a letter that is no key here", key("x")],
  ])("leaves %s alone", (_name, event) => {
    expect(homeKeyAction(event)).toBeNull();
  });
});

function Host(props: Parameters<typeof useHomeKeys>[0]) {
  useHomeKeys(props);
  return (
    <>
      <input aria-label="Path" />
      <button type="button">Card</button>
    </>
  );
}

function setup() {
  const actions = {
    onImport: vi.fn(),
    onRecord: vi.fn(),
    onOpenOther: vi.fn(),
    onPalette: vi.fn(),
  };
  const view = render(<Host {...actions} />);
  return { actions, view, user: userEvent.setup() };
}

describe("useHomeKeys", () => {
  it("runs the latest callbacks without re-adding its listener", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const { actions, view, user } = setup();
    const added = add.mock.calls.filter(([type]) => type === "keydown").length;
    const onRecord = vi.fn();
    view.rerender(<Host {...actions} onRecord={onRecord} />);
    await user.keyboard("r");
    expect(onRecord).toHaveBeenCalledOnce();
    expect(actions.onRecord).not.toHaveBeenCalled();
    expect(add.mock.calls.filter(([type]) => type === "keydown").length).toBe(
      added,
    );
    add.mockRestore();
  });

  it("runs each action on its key", async () => {
    const { actions, user } = setup();
    await user.keyboard("{Control>}i{/Control}r?{Control>}o{/Control}");
    expect(actions.onImport).toHaveBeenCalledOnce();
    expect(actions.onRecord).toHaveBeenCalledOnce();
    expect(actions.onPalette).toHaveBeenCalledOnce();
    expect(actions.onOpenOther).toHaveBeenCalledOnce();
  });

  it("holds back while a field has focus", async () => {
    const { actions, user, view } = setup();
    await user.click(view.getByLabelText("Path"));
    await user.keyboard("r?{Control>}i{/Control}");
    expect(actions.onRecord).not.toHaveBeenCalled();
    expect(actions.onPalette).not.toHaveBeenCalled();
    expect(actions.onImport).not.toHaveBeenCalled();
  });

  it("does not repeat while a key is held", () => {
    const { actions } = setup();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "r", repeat: true, bubbles: true }),
    );
    expect(actions.onRecord).not.toHaveBeenCalled();
  });

  it("stops listening once Home is gone", async () => {
    const { actions, user, view } = setup();
    view.unmount();
    await user.keyboard("r");
    expect(actions.onRecord).not.toHaveBeenCalled();
  });
});

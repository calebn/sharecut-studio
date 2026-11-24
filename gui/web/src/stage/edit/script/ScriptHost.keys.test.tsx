import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerPrimaryEditingCommands } from "../../../commands/editing";
import { useDawStore } from "../../../state/dawStore";
import { seedScript, TWO_LANE_CLIPS } from "../../../test/scriptHostKit";
import { ScriptHost } from "./ScriptHost";

vi.mock("../../../commands/seek", () => ({ seekTransport: vi.fn() }));
vi.mock("../../../transcript/wordCorrection", () => ({
  submitWordCorrection: vi.fn(),
}));

const keymap = vi.fn();

beforeEach(() => {
  seedScript();
  keymap.mockReset();
});

describe("ScriptHost Escape order", () => {
  it("closes the field first, then clears the words, then the Find bar closes from its own field", async () => {
    window.addEventListener("keydown", keymap);
    render(<ScriptHost />);
    await userEvent.click(
      screen.getByRole("button", { name: "Find in transcript" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "friends" }));
    await userEvent.keyboard("{F2}");
    expect(
      screen.getByRole("textbox", { name: "Fix text" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Clear selection" }),
    ).toBeNull();

    keymap.mockClear();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Fix text" })).toBeNull();
    expect(screen.getByRole("search")).toBeInTheDocument();
    expect(useDawStore.getState().selection).not.toBeNull();
    expect(keymap).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    expect(useDawStore.getState().selection).toBeNull();
    expect(screen.getByRole("search")).toBeInTheDocument();
    expect(keymap).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("searchbox", { name: "Find" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("search")).toBeNull();
    window.removeEventListener("keydown", keymap);
  });

  it("clears the selected word through the visible command and returns keyboard focus", async () => {
    registerPrimaryEditingCommands();
    const user = userEvent.setup();
    render(<ScriptHost />);
    const clear = () =>
      screen.queryByRole("button", { name: "Clear selection" });
    expect(clear()).toBeNull();

    await user.click(screen.getByRole("button", { name: "friends" }));
    expect(useDawStore.getState().selection).toMatchObject({
      kind: "transcriptRange",
    });
    const action = clear();
    expect(action).toBeInTheDocument();
    action?.focus();
    await user.keyboard("{Enter}");

    expect(useDawStore.getState().selection).toBeNull();
    expect(screen.getByRole("button", { name: "friends" })).toHaveFocus();
    expect(clear()).toBeNull();
  });

  it("shows Clear selection for words drawn across two tracks", async () => {
    registerPrimaryEditingCommands();
    seedScript({ project: { clips: TWO_LANE_CLIPS } });
    const user = userEvent.setup();
    render(<ScriptHost />);
    await user.click(screen.getByRole("button", { name: "friends" }));
    await user.keyboard(
      "{Shift>}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}",
    );
    expect(useDawStore.getState().selection?.kind).toBe("range");
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(useDawStore.getState().selection).toBeNull();
  });
});

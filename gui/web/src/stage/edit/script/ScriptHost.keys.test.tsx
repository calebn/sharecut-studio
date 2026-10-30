import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../../state/dawStore";
import { seedScript } from "../../../test/scriptHostKit";
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
});

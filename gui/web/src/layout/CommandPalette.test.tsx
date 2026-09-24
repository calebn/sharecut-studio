import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { registerDawCommands } from "../commands/register";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { minimalProject } from "../test/fixtures";
import { CommandPalette } from "./CommandPalette";

describe("CommandPalette", () => {
  beforeEach(() => {
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.getState().setCommandPaletteOpen(true);
  });

  it("shows category tabs and shortcut rows", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <CommandPalette />
      </DawProvider>,
    );
    expect(
      screen.getByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeTruthy();
    expect(screen.getByRole("tab", { name: "All keys" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "tools" })).toBeTruthy();
    expect(screen.getByText("Select tool")).toBeTruthy();
    expect(screen.getByText("V")).toBeTruthy();
  });

  it("filters to one category tab", async () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <CommandPalette />
      </DawProvider>,
    );
    await userEvent.click(screen.getByRole("tab", { name: "tools" }));
    expect(screen.getByText("Select tool")).toBeTruthy();
    expect(screen.getByText("Blade tool")).toBeTruthy();
    expect(screen.queryByText("Play / pause")).toBeNull();
  });

  it("omits commands that need caller-provided arguments from runnable actions", async () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <CommandPalette />
      </DawProvider>,
    );
    await userEvent.click(screen.getByRole("tab", { name: "Actions" }));
    for (const label of [
      "Seek playhead",
      "Audition Mix / FX / Raw",
      "Follow",
      "Resolve comment",
      "Reorder track",
      "Move clips",
      "Switch editor tab",
      "Switch phone mode",
    ]) {
      expect(screen.queryByText(label)).toBeNull();
    }
    expect(screen.getByText("Annotate transcript")).toBeInTheDocument();
    expect(screen.getByText("Commands without keys")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <CommandPalette />
      </DawProvider>,
    );
    await userEvent.keyboard("{Escape}");
    expect(useDawStore.getState().commandPaletteOpen).toBe(false);
  });

  it("keeps Tab focus inside the panel", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <div data-daw-app-chrome>
          <button type="button">Chrome target</button>
        </div>
        <DawProvider
          projectPath="/tmp/p.json"
          initialProject={minimalProject()}
        >
          <CommandPalette />
        </DawProvider>
      </div>,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    });
    await user.tab();
    expect(
      document.activeElement?.closest(".command-palette-panel"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Chrome target" }),
    ).not.toHaveFocus();
  });
});

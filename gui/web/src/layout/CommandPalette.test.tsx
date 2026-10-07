import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "../commands/catalog";
import { registerDawCommands } from "../commands/register";
import { getKeymapOverride } from "../keymap/remaps";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { waitForDialogFocus } from "../test/dialogFocus";
import { minimalProject } from "../test/fixtures";
import { CommandPalette } from "./CommandPalette";

function renderPalette() {
  return render(
    <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
      <CommandPalette />
    </DawProvider>,
  );
}

describe("CommandPalette", () => {
  beforeEach(() => {
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.getState().setCommandPaletteOpen(true);
    useDawStore.setState({ exportDialogOpen: false, statusAnnouncement: "" });
  });

  it("lists keyed and keyless catalog commands together", () => {
    renderPalette();
    expect(
      screen.getByRole("dialog", { name: "Commands and shortcuts" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Select tool/ })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Annotate transcript" }),
    ).toBeTruthy();
  });

  it("omits argument-only and context-only commands", () => {
    renderPalette();
    for (const label of [
      "Seek playhead",
      COMMANDS["transport.audition"].label,
      "Follow",
      "Resolve comment",
      "Reorder track",
      "Move clips",
      "Switch editor tab",
      "Switch phone mode",
      "Correct transcript",
      "Select transcript range",
      "Trim clip edge",
      "Roll clip join",
      "Set clip fade",
      "Focus edit boundary",
      "Focus cut-away word",
    ]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });

  it("finds a command by search, closes, and runs it", async () => {
    const user = userEvent.setup();
    renderPalette();
    await waitForDialogFocus();
    await user.keyboard("annotate{Enter}");
    expect(useDawStore.getState().commandPaletteOpen).toBe(false);
    await waitFor(() =>
      expect(useDawStore.getState().transcriptAnnotate).toBe(true),
    );
  });

  it("opens Export deliverables in place of the palette, never stacked", async () => {
    const user = userEvent.setup();
    renderPalette();
    await waitForDialogFocus();
    await user.keyboard("export deliv");
    await user.click(
      screen.getByRole("button", { name: /^Export deliverables…/ }),
    );
    expect(useDawStore.getState().commandPaletteOpen).toBe(false);
    await waitFor(() =>
      expect(useDawStore.getState().exportDialogOpen).toBe(true),
    );
  });

  it("stores a remap on blur and clears it when emptied", async () => {
    const user = userEvent.setup();
    renderPalette();
    await waitForDialogFocus();
    await user.click(screen.getByLabelText("Show remaps"));
    const input = screen.getByLabelText("Remap Select tool");
    await user.type(input, "X");
    await user.tab();
    expect(getKeymapOverride("tool.select")).toEqual(["X"]);
    await user.clear(input);
    await user.tab();
    expect(getKeymapOverride("tool.select")).toBeUndefined();
  });

  it("closes on Escape", async () => {
    renderPalette();
    await waitForDialogFocus();
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
    await waitForDialogFocus();
    await user.tab();
    expect(
      document.activeElement?.closest(".command-palette-panel"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Chrome target" }),
    ).not.toHaveFocus();
  });
});

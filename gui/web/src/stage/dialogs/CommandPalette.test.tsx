import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "../../commands/catalog";
import { registerCommand } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { getKeymapOverride } from "../../keymap/remaps";
import { useDawStore } from "../../state/dawStore";
import { DawProvider } from "../../state/store";
import { setChrome } from "../../test/chrome";
import { waitForDialogFocus } from "../../test/dialogFocus";
import { minimalProject } from "../../test/fixtures";
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
    setChrome({ exportDialogOpen: false });
    useDawStore.setState({ statusAnnouncement: "" });
  });

  it("lists keyed and keyless catalog commands together", () => {
    renderPalette();
    expect(
      screen.getByRole("dialog", { name: "Commands and shortcuts" }),
    ).toBeTruthy();
    expect(screen.getByRole("option", { name: "Select tool" })).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "Annotate transcript" }),
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
      expect(screen.queryByRole("option", { name: label })).toBeNull();
    }
  });

  it("finds a command by search, closes, and runs it", async () => {
    const user = userEvent.setup();
    renderPalette();
    await waitForDialogFocus();
    await user.keyboard("annotate{Enter}");
    expect(useDawStore.getState().chrome.commandPaletteOpen).toBe(false);
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
      screen.getByRole("option", { name: /^Export deliverables…/ }),
    );
    expect(useDawStore.getState().chrome.commandPaletteOpen).toBe(false);
    await waitFor(() =>
      expect(useDawStore.getState().chrome.exportDialogOpen).toBe(true),
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
    expect(useDawStore.getState().chrome.commandPaletteOpen).toBe(false);
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

  it("does not repeat a refusal the command already announced", async () => {
    const raw = "Reorder failed: set PODCAST_MCP_FFMPEG to its bin executable.";
    registerCommand("tool.select", async () => {
      useDawStore.getState().announceStatus(raw, { tone: "error" });
      return { status: "disabled", reason: raw };
    });
    const before = useDawStore.getState().statusAnnouncementSeq;
    renderPalette();
    await userEvent
      .setup()
      .click(screen.getByRole("option", { name: "Select tool" }));
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncementSeq).toBe(before + 1),
    );
    await new Promise((r) => setTimeout(r, 20));
    const state = useDawStore.getState();
    expect(state.statusAnnouncementSeq).toBe(before + 1);
    expect(state.feedbackToast).toMatchObject({
      tone: "error",
      message:
        "Reorder failed. Export diagnostics from the command palette and try again.",
    });
  });

  async function runSelectTool(
    handler: Parameters<typeof registerCommand>[1],
  ): Promise<void> {
    registerCommand("tool.select", handler);
    renderPalette();
    await userEvent
      .setup()
      .click(screen.getByRole("option", { name: "Select tool" }));
    await new Promise((r) => setTimeout(r, 20));
  }

  it("shows the refusal a command returns even when it announced something else", async () => {
    await runSelectTool(async () => {
      useDawStore.getState().announceStatus("first");
      return { status: "disabled", reason: "SECOND never spoken" };
    });
    expect(useDawStore.getState().feedbackToast?.message).toBe(
      "SECOND never spoken",
    );
  });

  it("shows the refusal of a silent command when an unrelated announcement lands meanwhile", async () => {
    await runSelectTool(async () => {
      await Promise.resolve();
      useDawStore
        .getState()
        .announceStatus("Export: running", { toast: false });
      return { status: "disabled", reason: "Nothing selected" };
    });
    expect(useDawStore.getState().feedbackToast?.message).toBe(
      "Nothing selected",
    );
  });

  it("keeps a standing Undo toast when a refusal was already spoken without a toast", async () => {
    useDawStore
      .getState()
      .announceStatus("Moved clips", { undo: "h-1" as never });
    const standing = useDawStore.getState().feedbackToast;
    const before = useDawStore.getState().statusAnnouncementSeq;
    await runSelectTool(async () => {
      useDawStore.getState().announceStatus("Can't undo: it changed.", {
        toast: false,
        tone: "error",
      });
      return { status: "disabled", reason: "Can't undo: it changed." };
    });
    expect(useDawStore.getState().statusAnnouncementSeq).toBe(before + 1);
    expect(useDawStore.getState().feedbackToast).toBe(standing);
  });
});

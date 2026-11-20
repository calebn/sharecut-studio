import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { seedScript, setTranscriptLoading } from "../../test/scriptHostKit";
import { stubViewportShell } from "../../test/viewportShell";
import { closeOverlay, openOverlay } from "../../ui/modalGate";
import { EditWorkspace } from "./EditWorkspace";

beforeEach(() => {
  stubViewportShell("desktop");
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.setState({
    stage: "edit",
    guestMode: null,
    scriptCollapsed: false,
    scriptFocus: false,
    editSurface: "lanes",
    openSheet: null,
  });
});

describe("Script focus return to Find", () => {
  const openScriptFocus = async (loading: boolean) => {
    seedScript();
    setTranscriptLoading(loading);
    const user = userEvent.setup();
    render(
      <>
        <EditWorkspace />
        <button type="button">Elsewhere</button>
      </>,
    );
    await user.click(screen.getByRole("button", { name: "View options" }));
    act(() => {
      useDawStore.setState({ scriptFocus: true });
    });
  };

  const findButton = () =>
    screen.getByRole("button", { name: "Find in transcript" });
  const scriptPane = () => document.querySelector<HTMLElement>(".edit-script");

  it("returns focus directly to Find when the transcript is ready", async () => {
    await openScriptFocus(false);
    expect(findButton()).toHaveFocus();
  });

  it("moves focus from the Script pane to Find once the same transcript loads", async () => {
    await openScriptFocus(true);
    expect(
      screen.queryByRole("button", { name: "Find in transcript" }),
    ).toBeNull();
    expect(scriptPane()).toHaveFocus();
    act(() => setTranscriptLoading(false));
    await waitFor(() => expect(findButton()).toHaveFocus());
  });

  it("leaves focus on the Script pane when loading ends without a transcript", async () => {
    await openScriptFocus(true);
    act(() => seedScript({ utterances: [] }));
    expect(screen.getByText("No transcript yet")).toBeVisible();
    expect(scriptPane()).toHaveFocus();
  });

  it.each(["focus", "key", "pointer", "modal", "project"] as const)(
    "does not move focus after an intervening %s change",
    async (interruption) => {
      await openScriptFocus(true);
      const pane = scriptPane();
      expect(pane).toHaveFocus();
      act(() => {
        if (interruption === "focus") {
          screen.getByRole("button", { name: "Elsewhere" }).focus();
          pane?.focus();
        } else if (interruption === "key") {
          pane?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
        } else if (interruption === "pointer") {
          pane?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        } else if (interruption === "modal") {
          closeOverlay(openOverlay(true));
        } else {
          seedScript({ projectPath: "/tmp/another-episode" });
        }
        setTranscriptLoading(false);
      });
      await act(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      });
      expect(findButton()).not.toHaveFocus();
    },
  );
});

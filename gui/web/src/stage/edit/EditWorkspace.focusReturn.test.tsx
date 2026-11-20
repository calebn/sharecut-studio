import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { seedScript } from "../../test/scriptHostKit";
import { stubViewportShell } from "../../test/viewportShell";
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
  it("moves focus from the Script pane to Find once the transcript loads", async () => {
    useDawStore
      .getState()
      .hydrate("/tmp/x/e.sharecut", minimalProject({ tracks: [] }));
    const user = userEvent.setup();
    render(<EditWorkspace />);
    await user.click(screen.getByRole("button", { name: "View options" }));
    await act(async () => {
      useDawStore.setState({ scriptFocus: true });
    });
    expect(
      screen.queryByRole("button", { name: "Find in transcript" }),
    ).toBeNull();
    expect(document.querySelector(".edit-script")).toHaveFocus();
    await act(async () => {
      seedScript();
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Find in transcript" }),
      ).toHaveFocus(),
    );
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRegisteredCommands,
  registerCommand,
} from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { PlusMenu } from "./PlusMenu";

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore
    .getState()
    .hydrate("/tmp/plus/p.json", minimalProject({ tracks: [sampleTrack()] }));
  useDawStore.setState({ guestMode: null, shareCapabilities: null });
});

describe("PlusMenu", () => {
  it("lists Import audio, a new track, a chapter and a Record take for the host", async () => {
    const user = userEvent.setup();
    render(<PlusMenu />);
    await user.click(screen.getByRole("button", { name: "+" }));
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
    expect(items).toEqual([
      expect.stringContaining("Import audio"),
      expect.stringContaining("New track"),
      expect.stringContaining("Add chapter at playhead"),
      expect.stringContaining("Go to Record"),
    ]);
  });

  it.each([
    ["track.add", /New track/],
    ["media.import", /Import audio/],
    ["edit.addChapter", /Add chapter at playhead/],
    ["stage.record", /Go to Record/],
  ])("%s runs from its row and closes the menu", async (id, name) => {
    const handler = vi.fn(() => ({ status: "ok" as const }));
    registerCommand(id, handler);
    const user = userEvent.setup();
    render(<PlusMenu />);
    await user.click(screen.getByRole("button", { name: "+" }));
    await user.click(screen.getByRole("menuitem", { name }));
    expect(handler).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("is absent for a link that cannot add audio", () => {
    useDawStore.setState({ guestMode: "comment", projectPath: "share:abc" });
    render(<PlusMenu />);
    expect(screen.queryByRole("button", { name: "+" })).toBeNull();
  });

  it("labels a file drop as new tracks", () => {
    render(<PlusMenu dropOver fileCount={2} />);
    expect(screen.getByRole("button", { name: /2/ })).toBeInTheDocument();
  });
});

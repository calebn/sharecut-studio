import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRegisteredCommands,
  registerCommand,
} from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { editFixtureProject } from "../../test/actionBarFixtures";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { PlusMenu } from "./PlusMenu";

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore
    .getState()
    .hydrate("/tmp/plus/p.json", minimalProject({ tracks: [sampleTrack()] }));
  useDawStore.setState({
    guestMode: null,
    shareCapabilities: null,
    pendingRecordTarget: null,
  });
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
      expect.stringContaining("Record here"),
    ]);
  });

  it.each([
    ["track.add", /New track/],
    ["media.import", /Import audio/],
    ["edit.addChapter", /Add chapter at playhead/],
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

  it("Record here opens Record with an Insert target at the playhead", async () => {
    registerCommand("stage.record", () => ({ status: "ok" as const }));
    useDawStore.setState({ project: editFixtureProject(), playheadSec: 12 });
    const user = userEvent.setup();
    render(<PlusMenu />);
    await user.click(screen.getByRole("button", { name: "+" }));
    await user.click(screen.getByRole("menuitem", { name: "Record here" }));
    await waitFor(() =>
      expect(useDawStore.getState().pendingRecordTarget).toEqual({
        kind: "insert",
        at_sec: 12,
      }),
    );
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Record here opens Record with no target over an empty timeline", async () => {
    const open = vi.fn(() => ({ status: "ok" as const }));
    registerCommand("stage.record", open);
    useDawStore.setState({ playheadSec: 12 });
    const user = userEvent.setup();
    render(<PlusMenu />);
    await user.click(screen.getByRole("button", { name: "+" }));
    await user.click(screen.getByRole("menuitem", { name: "Record here" }));
    await waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(useDawStore.getState().pendingRecordTarget).toBeNull();
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

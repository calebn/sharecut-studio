import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { buildCommandContext } from "../commands/context";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { RelatedCommands } from "./RelatedCommands";
import {
  moreCommandsFor,
  relatedCommandsFor,
} from "./relatedCommandDescriptors";

describe("relatedCommandsFor", () => {
  it("returns commands for clip selection", () => {
    const cmds = relatedCommandsFor({ kind: "clip", id: "c1", trackId: "t1" });
    expect(cmds).toEqual([
      { commandId: "edit.copy", args: {}, respectWhen: true },
    ]);
  });

  it("returns empty for null selection", () => {
    expect(relatedCommandsFor(null)).toEqual([]);
  });

  it("returns empty for unknown kind", () => {
    expect(relatedCommandsFor({ kind: "chapter", id: "ch1", time: 0 })).toEqual(
      [],
    );
  });

  it("omits inspector-owned and unsupported selection actions", () => {
    expect(relatedCommandsFor({ kind: "track", trackId: "t1" })).toEqual([]);
    expect(relatedCommandsFor({ kind: "comment", id: "note" })).toEqual([]);
    expect(
      relatedCommandsFor({ kind: "pending", id: "e1", trackId: "t1" }),
    ).toEqual([]);
    expect(
      relatedCommandsFor({
        kind: "transcriptRange",
        trackId: "t1",
        startWordIndex: 0,
        endWordIndex: 1,
      }),
    ).toEqual([]);
  });
});

describe("RelatedCommands", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.getState().hydrate(
      "/tmp/p.json",
      minimalProject({
        tracks: [sampleTrack({ id: "t1" }), sampleTrack({ id: "t2" })],
        clips: {
          tracks: {
            t1: [
              {
                id: "c1",
                track_id: "t1",
                source_start: 0,
                source_end: 3,
                timeline_start: 0,
                timeline_end: 3,
                fade_in_ms: 0,
                fade_out_ms: 0,
                join_in_mode: "fade",
                source_id: null,
              },
            ],
          },
          clip_count: 1,
        },
      }),
    );
    useDawStore.getState().setSelection({
      kind: "clip",
      id: "c1",
      trackId: "t1",
    });
  });

  it("renders related command buttons", () => {
    render(
      <RelatedCommands selection={{ kind: "clip", id: "c1", trackId: "t1" }} />,
    );
    expect(screen.getByText("You might also want…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
    expect(screen.getByText("More")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cut" })).toBeInTheDocument();
  });

  it("runs the contextual command through the shared bus", async () => {
    const user = userEvent.setup();
    render(
      <RelatedCommands selection={{ kind: "clip", id: "c1", trackId: "t1" }} />,
    );
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(useDawStore.getState().statusAnnouncement).toBe("Copied 3.00s");
  });

  it("renders nothing for null selection", () => {
    const { container } = render(<RelatedCommands selection={null} />);
    expect(container.textContent).toBe("");
  });

  it("keeps a truthful More zone for selections without a related command", () => {
    const selection = { kind: "comment" as const, id: "note" };
    useDawStore.getState().setSelection(selection);
    render(<RelatedCommands selection={selection} />);
    expect(screen.queryByText("You might also want…")).toBeNull();
    expect(screen.getByText("More")).toBeInTheDocument();
    expect(
      screen.getByText("No additional actions for this selection."),
    ).toBeInTheDocument();
  });

  it("offers only available track directions and updates after selection changes", () => {
    const first = { kind: "track" as const, trackId: "t1" };
    useDawStore.getState().setSelection(first);
    const { rerender } = render(<RelatedCommands selection={first} />);
    expect(screen.queryByRole("button", { name: "Move track up" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Move track down" }),
    ).toBeEnabled();

    const last = { kind: "track" as const, trackId: "t2" };
    useDawStore.getState().setSelection(last);
    rerender(<RelatedCommands selection={last} />);
    expect(screen.getByRole("button", { name: "Move track up" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Move track down" }),
    ).toBeNull();
  });

  it("hides edits from view guests, then shows them when edit is granted", () => {
    useDawStore.setState({
      projectPath: "share:token",
      guestMode: "view",
      shareCapabilities: ["view"],
    });
    const selection = { kind: "clip" as const, id: "c1", trackId: "t1" };
    const { rerender } = render(<RelatedCommands selection={selection} />);
    expect(screen.queryByRole("button", { name: "Cut" })).toBeNull();

    useDawStore.setState({ shareCapabilities: ["view", "edit"] });
    rerender(<RelatedCommands selection={selection} />);
    expect(screen.getByRole("button", { name: "Cut" })).toBeEnabled();
  });

  it("does not offer track reordering to a view guest", () => {
    useDawStore.setState({
      projectPath: "share:token",
      guestMode: "view",
      shareCapabilities: ["view"],
    });
    const selection = { kind: "track" as const, trackId: "t1" };
    useDawStore.getState().setSelection(selection);
    render(<RelatedCommands selection={selection} />);
    expect(screen.queryByRole("button", { name: /move track/i })).toBeNull();
    expect(
      screen.getByText("No additional actions for this selection."),
    ).toBeInTheDocument();
  });

  it("rejects stale or missing selections in overflow", () => {
    const selection = { kind: "clip" as const, id: "c1", trackId: "t1" };
    const project = useDawStore.getState().project;
    expect(
      moreCommandsFor(
        selection,
        { kind: "clip", id: "other", trackId: "t1" },
        project,
        buildCommandContext(),
      ),
    ).toEqual([]);
    expect(
      moreCommandsFor(
        { kind: "clip", id: "missing", trackId: "t1" },
        { kind: "clip", id: "missing", trackId: "t1" },
        project,
        buildCommandContext(),
      ),
    ).toEqual([]);
  });

  it("is axe-clean", async () => {
    const { container } = render(
      <RelatedCommands selection={{ kind: "clip", id: "c1", trackId: "t1" }} />,
    );
    await expectNoA11yViolations(container);
  });
});

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import {
  minimalProject,
  pendingEditView,
  sampleComment,
  sampleTrack,
} from "../test/fixtures";
import type { SessionState } from "../types/session";
import { MobileShell } from "./MobileShell";

const createComment = vi.hoisted(() => vi.fn());

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  createComment: (...args: unknown[]) => createComment(...args),
}));

vi.mock("../services/offlineQueue/offlineStore", () => ({
  loadConflicts: vi.fn().mockResolvedValue([]),
  loadCommandQueue: vi.fn().mockResolvedValue([]),
  loadHostCommandCount: vi.fn().mockResolvedValue(0),
  loadHostConflicts: vi.fn().mockResolvedValue([]),
  loadHostAttention: vi.fn().mockResolvedValue({ pending: 0, conflicts: [] }),
  loadGuestAttention: vi.fn().mockResolvedValue({ pending: 0, conflicts: [] }),
}));

vi.mock("../waveform/statusStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../waveform/statusStore")>()),
  useWaveformStatus: () => null,
  useLaneWaveformStatus: () => "idle",
}));

const project = minimalProject({
  tracks: [sampleTrack({ id: "host" })],
  pending_edits: [pendingEditView({ id: "cut_live", track_id: "host" })],
});

function openShare(capabilities: string[], guestMode: string) {
  return render(
    <DawProvider
      projectPath="share:tok"
      initialProject={project}
      guestMode={guestMode}
      shareCapabilities={capabilities}
    >
      <MobileShell guestShare />
    </DawProvider>,
  );
}

function storedSession(selection: SessionState["selection"]): SessionState {
  return {
    version: 1,
    server_seq: 3,
    origin: "viewer",
    last_role: "viewer",
    updated_at_ns: 0,
    last_command_id: "c3",
    playhead_sec: 0,
    is_playing: false,
    audition_mode: "mix",
    region: null,
    source: null,
    track_id: null,
    query: null,
    match_index: null,
    selection,
    viewer_mute: {},
    solo_tracks: {},
    tier: null,
    dry_run: false,
  };
}

describe("phone share link, first load", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("podcast-mcp-guest-comment-name", "");
    clearRegisteredCommands();
    registerDawCommands();
    createComment.mockReset();
    useDawStore.getState().hydrate("/tmp/reset.json", minimalProject());
    useDawStore.getState().setShellBreakpoint("phone");
    useDawStore.getState().setMobileMode("listen");
  });

  afterEach(() => clearRegisteredCommands());

  it("a Commenter types and posts at the playhead with no ruler and no instructions", async () => {
    const user = userEvent.setup();
    createComment.mockResolvedValue(
      sampleComment({ id: "c9", body: "Love this", timeline_start: 0 }),
    );
    const { container } = openShare(["view", "comment"], "comment");

    const dock = screen.getByRole("region", { name: "Add a comment" });
    const post = within(dock).getByRole("button", { name: "Post comment" });
    expect(post).toBeDisabled();
    expect(
      within(dock).getByRole("button", {
        name: "Comment at 0:00. Change time",
      }),
    ).toBeVisible();
    expect(screen.queryByText(/ruler/i)).toBeNull();
    await expectNoA11yViolations(container);

    await user.type(
      within(dock).getByRole("textbox", { name: "Comment" }),
      "Love this",
    );
    expect(post).toBeEnabled();
    await user.click(post);

    expect(createComment).toHaveBeenCalledWith(
      "share:tok",
      expect.objectContaining({
        body: "Love this",
        author: "Guest",
        timelineStart: 0,
        timelineEnd: null,
        trackIds: [],
      }),
    );
    expect(within(dock).getByRole("textbox", { name: "Comment" })).toHaveValue(
      "",
    );
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Comment posted at 0:00",
    );
  });

  it("follows the playhead: a comment posted after listening lands where the guest is", async () => {
    const user = userEvent.setup();
    createComment.mockResolvedValue(sampleComment({ timeline_start: 12.4 }));
    openShare(["view", "comment"], "comment");
    act(() => useDawStore.getState().setPlayheadSec(12.4));

    const dock = screen.getByRole("region", { name: "Add a comment" });
    expect(
      within(dock).getByRole("button", {
        name: "Comment at 0:12. Change time",
      }),
    ).toBeVisible();
    await user.type(
      within(dock).getByRole("textbox", { name: "Comment" }),
      "Here",
    );
    await user.click(
      within(dock).getByRole("button", { name: "Post comment" }),
    );
    expect(createComment).toHaveBeenCalledWith(
      "share:tok",
      expect.objectContaining({ timelineStart: 12.4, timelineEnd: null }),
    );
  });

  it("closes the keyboard after Post: the field is empty and unfocused, the toast shows, no Inspector", async () => {
    const user = userEvent.setup();
    createComment.mockResolvedValue(sampleComment({ timeline_start: 12.4 }));
    openShare(["view", "comment"], "comment");
    act(() => useDawStore.getState().setPlayheadSec(12.4));

    const dock = screen.getByRole("region", { name: "Add a comment" });
    const field = within(dock).getByRole("textbox", { name: "Comment" });
    await user.type(field, "Here");
    expect(field).toHaveFocus();
    await user.click(
      within(dock).getByRole("button", { name: "Post comment" }),
    );

    expect(createComment).toHaveBeenCalledWith(
      "share:tok",
      expect.objectContaining({ body: "Here", timelineStart: 12.4 }),
    );
    expect(field).toHaveValue("");
    expect(field).not.toHaveFocus();
    expect(dock).not.toContainElement(document.activeElement as HTMLElement);
    expect(document.body).toHaveFocus();
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Comment posted at 0:12",
    );
    expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
  });

  it("a listen-only link shows no comment field", () => {
    openShare(["view"], "view");
    expect(screen.queryByRole("region", { name: "Add a comment" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();
  });

  it("opens with no Inspector when the stored session names an edit that is gone", () => {
    openShare(["view", "comment"], "comment");
    act(() =>
      useDawStore
        .getState()
        .applyAgentSession(
          storedSession({ kind: "pending", id: "cut_gone", track_id: "host" }),
        ),
    );
    expect(useDawStore.getState().selection).toBeNull();
    expect(screen.queryByText("Edit not found")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
  });

  it("keeps the Inspector closed when the host has a live edit selected", () => {
    openShare(["view", "comment"], "comment");
    act(() =>
      useDawStore
        .getState()
        .applyAgentSession(
          storedSession({ kind: "pending", id: "cut_live", track_id: "host" }),
        ),
    );
    expect(useDawStore.getState().selection).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
  });
});

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { submitDocumentCommand } from "../../api/documentEdits";
import { useDawStore } from "../../state/dawStore";
import {
  COMMENTER_CAPABILITIES,
  clipRow,
  EDITOR_CAPABILITIES,
  VIEWER_CAPABILITIES,
} from "../../test/fixtures";
import { StoredGuestScriptHost } from "../../test/StoredGuestScriptHost";
import { seedScript } from "../../test/scriptHostKit";
import { stubViewportShell } from "../../test/viewportShell";

vi.mock("../../api/documentEdits", async (orig) => ({
  ...(await orig<typeof import("../../api/documentEdits")>()),
  submitDocumentCommand: vi.fn(),
}));
vi.mock("../../commands/seek", () => ({ seekTransport: vi.fn() }));

const CLIPS = {
  tracks: {
    host: [
      clipRow({
        id: "ch",
        track_id: "host",
        timeline_start: 0,
        timeline_end: 30,
        source_start: 0,
        source_end: 30,
      }),
    ],
  },
  clip_count: 1,
};

const as = (
  guestMode: "view" | "comment" | "edit",
  shareCapabilities: string[],
) =>
  seedScript({
    projectPath: "share:abc",
    guestMode,
    shareCapabilities,
    project: { clips: CLIPS },
  });

const select = () =>
  act(() =>
    useDawStore.getState().setSelection({
      kind: "transcriptRange",
      trackId: "host",
      sourceId: null,
      startWordIndex: 0,
      endWordIndex: 1,
    }),
  );

const bar = () => screen.queryByRole("group", { name: "Selection actions" });

beforeEach(() => {
  vi.mocked(submitDocumentCommand).mockReset();
  stubViewportShell("desktop");
  act(() => useDawStore.getState().setSelection(null));
});

afterEach(() => {
  act(() => useDawStore.getState().setSelection(null));
});

describe("the guest selection bar", () => {
  it("offers a commenter Comment and Suggest a cut over a word selection", async () => {
    as("comment", COMMENTER_CAPABILITIES);
    render(<StoredGuestScriptHost />);
    expect(bar()).toBeNull();
    select();
    expect(bar()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Comment" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Suggest a cut" })).toBeEnabled();
    expect(bar()?.querySelectorAll("button")).toHaveLength(2);
  });

  it("sends the cut as a suggestion for review and says so", async () => {
    as("comment", COMMENTER_CAPABILITIES);
    vi.mocked(submitDocumentCommand).mockResolvedValue({} as never);
    render(<StoredGuestScriptHost />);
    select();
    await userEvent.click(
      screen.getByRole("button", { name: "Suggest a cut" }),
    );
    expect(submitDocumentCommand).toHaveBeenCalledWith(
      "share:abc",
      "EditSelectedRange",
      expect.objectContaining({ action: "cut" }),
    );
  });

  it("gives a viewer no bar and no Comment control", () => {
    as("view", VIEWER_CAPABILITIES);
    render(<StoredGuestScriptHost />);
    select();
    expect(bar()).toBeNull();
  });

  it("names an editor's cut Cut, since it applies", () => {
    as("edit", EDITOR_CAPABILITIES);
    render(<StoredGuestScriptHost />);
    select();
    expect(screen.getByRole("button", { name: "Cut" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Suggest a cut" })).toBeNull();
  });
});

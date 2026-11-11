import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/offlineQueue/offlineStore", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../services/offlineQueue/offlineStore")
  >()),
  loadHostCommandQueue: async () => [],
  loadHostAttention: async () => ({ pending: 0, conflicts: [] }),
}));

const loadTunnelStatus = vi.fn();
vi.mock("../../api/tunnelStatus", () => ({
  loadTunnelStatus: (...args: unknown[]) => loadTunnelStatus(...args),
}));

const refreshMix = vi.fn();
vi.mock("../../commands/execute", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../commands/execute")>();
  return {
    ...actual,
    execute: (...args: Parameters<typeof actual.execute>) =>
      args[0] === "render.refreshMix"
        ? refreshMix(...args)
        : actual.execute(...args),
  };
});

import {
  clearRegisteredCommands,
  registerCommand,
} from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { FeaturesContext } from "../../extensions/FeaturesContext";
import {
  FEATURE_SHARE_UI_MENU,
  FEATURE_TUNNEL_STATUS,
} from "../../extensions/features";
import { FeedbackToast } from "../../feedback/FeedbackToast";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { fakeExportServer } from "../../test/fakeExportServer";
import { hostShareRow, minimalProject, sampleTrack } from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import { SheetHost } from "../frame/SheetHost";
import { DeliverStage } from "./DeliverStage";
import { ExportFlowProvider } from "./exportFlow";
import { StageHost } from "./StageHost";
import { ShareFlowProvider } from "./shareFlow";

const PATH = "/tmp/ep/episode.sharecut";
const OTHER = "/tmp/other/episode.sharecut";

let server: ReturnType<typeof fakeExportServer>;

function Stages() {
  const stage = useDawStore((s) => s.stage);
  return stage === "deliver" ? <DeliverStage /> : <p>another stage</p>;
}

function Host({
  features = [FEATURE_SHARE_UI_MENU],
  ready = true,
  children = (
    <>
      <Stages />
      <SheetHost />
    </>
  ),
}: {
  features?: string[];
  ready?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <FeaturesContext.Provider
      value={{ ready, manifest: { api_version: 1, features } }}
    >
      <ExportFlowProvider>
        <ShareFlowProvider>{children}</ShareFlowProvider>
      </ExportFlowProvider>
    </FeaturesContext.Provider>
  );
}

/** The Host with the toast region the app mounts beside it: Undo lives there. */
function ToastedHost() {
  return (
    <Host>
      <Stages />
      <SheetHost />
      <FeedbackToast />
    </Host>
  );
}

/** The toast watches its own visibility; jsdom has no observer, so the card reads as fully shown. */
function stubVisibleToast() {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      callback: (
        entries: { isIntersecting: boolean; intersectionRatio: number }[],
      ) => void;
      constructor(
        callback: (
          entries: { isIntersecting: boolean; intersectionRatio: number }[],
        ) => void,
      ) {
        this.callback = callback;
      }
      observe() {
        this.callback([{ isIntersecting: true, intersectionRatio: 1 }]);
      }
      disconnect() {}
    },
  );
}

const sheet = () => within(screen.getByRole("dialog", { name: "Invite" }));
const openInvite = (at?: "record") =>
  act(() => {
    useDawStore.getState().openInvite(at);
  });
const group = (name: string) =>
  within(
    screen.getByRole("heading", { name }).closest("section") as HTMLElement,
  );
const listen = () =>
  within(screen.getByRole("region", { name: "Listen link" }));

function asHost(path = PATH) {
  useDawStore
    .getState()
    .hydrate(path, minimalProject({ tracks: [sampleTrack()] }));
  useDawStore.setState({ stage: "deliver", guestMode: null });
}

function installClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

beforeEach(() => {
  server = fakeExportServer();
  stubViewportShell("desktop");
  clearRegisteredCommands();
  registerDawCommands();
  loadTunnelStatus.mockReset();
  refreshMix.mockReset().mockResolvedValue({ status: "ok" });
  useDawStore.setState({ statusAnnouncement: "" });
  asHost();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Listen link on the Deliver stage", () => {
  it("shows a ready row with no Share section, no Create button and nothing else about sharing", async () => {
    const { container } = render(<Host />);
    expect(screen.getByRole("heading", { name: "Listen link" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Share" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Create review link" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Share a listen link" }),
    ).toBeNull();
    expect(screen.getByText("Made when you copy it")).toBeVisible();
    await waitFor(() => expect(server.shareListRequests).toBe(1));
    await expectNoA11yViolations(container);
  });

  it("makes a Viewer link frozen on the version current when first copied on first Copy, and copies it", async () => {
    const writeText = installClipboard();
    render(<Host />);
    const copy = listen().getByRole("button", { name: "Copy listen link" });
    await waitFor(() => expect(copy).toBeEnabled());
    await userEvent.click(copy);
    await waitFor(() => expect(server.shareRequests).toHaveLength(1));
    expect(server.shareRequests[0]).toEqual({
      path: PATH,
      role: "viewer",
      with_mcp: false,
      freeze: true,
    });
    expect(writeText).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/r/made-link-1",
    );
    expect(
      await listen().findByRole("button", { name: "Copied listen link" }),
    ).toBeVisible();
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Listen link created and copied",
    );
  });

  it("copies the link that exists instead of making another", async () => {
    server.shares = [
      hostShareRow({
        token: "listen-1",
        url: "http://127.0.0.1:8765/r/listen-1",
        docs_role: "viewer",
        follow_latest: false,
        review_version_label: "Rough cut",
      }),
    ];
    const writeText = installClipboard();
    render(<Host />);
    await listen().findByTitle("http://127.0.0.1:8765/r/listen-1");
    await userEvent.click(
      listen().getByRole("button", { name: "Copy listen link" }),
    );
    expect(writeText).toHaveBeenCalledWith("http://127.0.0.1:8765/r/listen-1");
    expect(server.shareRequests).toEqual([]);
    expect(
      listen().getByRole("button", { name: "Pin to this version" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("waits for the list before it can make a link, so it never makes a second", async () => {
    render(<Host />);
    const copy = listen().getByRole("button", { name: "Copy listen link" });
    expect(copy).toBeDisabled();
    await waitFor(() => expect(copy).toBeEnabled());
  });

  it("stops the listen link at once and offers Undo, with no confirm first", async () => {
    stubVisibleToast();
    server.shares = [
      hostShareRow({
        token: "listen-1",
        docs_role: "viewer",
        follow_latest: false,
      }),
    ];
    render(<ToastedHost />);
    await userEvent.click(
      await listen().findByRole("button", { name: "More for listen link" }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Stop sharing" }),
    );
    await waitFor(() => expect(server.revokeRequests).toEqual(["listen-1"]));
    expect(server.revokeBodies).toEqual([{ path: PATH, restorable: true }]);
    expect(
      screen.queryByRole("group", { name: /Stop sharing this/ }),
    ).toBeNull();
    expect(await screen.findByText("Made when you copy it")).toBeVisible();
    expect(await screen.findByText("Link stopped.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(server.restoreRequests).toEqual(["listen-1"]));
    expect(
      await listen().findByRole("button", { name: "More for listen link" }),
    ).toBeVisible();
  });

  it("offers Refresh mix as the row itself when the mix is stale, then makes the link once it is back", async () => {
    server.shareAnswer = { status: 409, code: "stale_mix", body: "stale" };
    render(<Host />);
    const copy = listen().getByRole("button", { name: "Copy listen link" });
    await waitFor(() => expect(copy).toBeEnabled());
    await userEvent.click(copy);
    expect(await listen().findByText("Make a mix to share")).toBeVisible();
    server.shareAnswer = null;
    await userEvent.click(
      listen().getByRole("button", { name: "Refresh mix" }),
    );
    expect(refreshMix).toHaveBeenCalledWith("render.refreshMix");
    await waitFor(() => expect(server.shareRequests).toHaveLength(2));
    expect(server.shareRequests[1]).toMatchObject({
      role: "viewer",
      freeze: true,
    });
  });

  it("is absent when the share feature is off, and lists nothing", async () => {
    render(<Host features={[]} />);
    expect(screen.queryByRole("heading", { name: "Listen link" })).toBeNull();
    await act(async () => {});
    expect(server.shareListRequests).toBe(0);
  });

  it("is absent for a guest", () => {
    useDawStore.getState().hydrate("share:abc", minimalProject());
    useDawStore.setState({ stage: "deliver", guestMode: "view" });
    render(
      <Host>
        <StageHost guestShare />
      </Host>,
    );
    expect(screen.queryByRole("heading", { name: "Listen link" })).toBeNull();
    expect(server.shareListRequests).toBe(0);
  });

  it("lists again each time Deliver is shown, and for a reopened project", async () => {
    render(<Host />);
    await waitFor(() => expect(server.shareListRequests).toBe(1));
    act(() => useDawStore.setState({ stage: "edit" }));
    server.shares = [
      hostShareRow({
        token: "added-meanwhile",
        url: "http://127.0.0.1:8765/r/added-meanwhile",
        docs_role: "viewer",
        follow_latest: false,
      }),
    ];
    act(() => useDawStore.setState({ stage: "deliver" }));
    expect(
      await screen.findByTitle("http://127.0.0.1:8765/r/added-meanwhile"),
    ).toBeVisible();
    expect(server.shareListRequests).toBe(2);
    server.shares = [
      hostShareRow({
        token: "other-project-link",
        url: "http://127.0.0.1:8765/r/other-project-link",
        docs_role: "viewer",
        follow_latest: false,
      }),
    ];
    act(() => asHost(OTHER));
    expect(
      await screen.findByTitle("http://127.0.0.1:8765/r/other-project-link"),
    ).toBeVisible();
    expect(
      screen.queryByTitle("http://127.0.0.1:8765/r/added-meanwhile"),
    ).toBeNull();
  });
});

describe("the Invite sheet over any stage", () => {
  beforeEach(() => {
    useDawStore.setState({ stage: "edit" });
  });

  it("opens from the store with the three groups in order, listing what exists", async () => {
    server.shares = [
      hostShareRow({ created_at: "2026-09-01T10:00:00Z" }),
      hostShareRow({ token: "gone", usable: false, revoked: true }),
      hostShareRow({
        token: "g1",
        kind: "record",
        docs_role: null,
        record_role: "guest",
        session_id: "room-1",
      }),
    ];
    render(<Host />);
    openInvite();
    expect(await screen.findByRole("dialog", { name: "Invite" })).toBeVisible();
    expect(
      screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent),
    ).toEqual(["Review links", "Record links", "Listen link"]);
    expect(
      await sheet().findByTitle("http://127.0.0.1:8765/r/sample-review-link"),
    ).toBeVisible();
    expect(screen.queryByTitle(/\/r\/gone$/)).toBeNull();
    expect(screen.getByText("Record room")).toBeVisible();
    expect(server.shareListRequests).toBe(1);
    await expectNoA11yViolations(
      screen.getByRole("dialog", { name: "Invite" }),
    );
  });

  it("makes the Commenter link, following the latest, from a ready row on its first Copy", async () => {
    const writeText = installClipboard();
    render(<Host />);
    openInvite();
    const copy = await screen.findByRole("button", {
      name: "Copy new Commenter link",
    });
    await waitFor(() => expect(copy).toBeEnabled());
    expect(
      screen.queryByRole("button", { name: /Create review link/ }),
    ).toBeNull();
    await userEvent.click(copy);
    await waitFor(() => expect(server.shareRequests).toHaveLength(1));
    expect(server.shareRequests[0]).toEqual({
      path: PATH,
      role: "commenter",
      with_mcp: false,
    });
    expect(writeText).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/r/made-link-1",
    );
    expect(
      await screen.findByRole("button", { name: "Copied Commenter link" }),
    ).toBeVisible();
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Review link created and copied",
    );
  });

  it("makes the link the role, pin and AI choices say", async () => {
    render(<Host />);
    openInvite();
    await userEvent.click(
      await screen.findByRole("button", { name: "Editor: can edit" }),
    );
    await userEvent.click(
      group("Review links").getByRole("button", {
        name: "Pin to this version",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "More for new Editor link" }),
    );
    await userEvent.click(
      screen.getByRole("menuitemradio", { name: "Allow AI assistants" }),
    );
    const copy = screen.getByRole("button", { name: "Copy new Editor link" });
    await waitFor(() => expect(copy).toBeEnabled());
    await userEvent.click(copy);
    await waitFor(() => expect(server.shareRequests).toHaveLength(1));
    expect(server.shareRequests[0]).toEqual({
      path: PATH,
      role: "editor",
      with_mcp: true,
      freeze: true,
    });
    expect(
      await screen.findByText(/Frozen on Share mix · AI assistants allowed/),
    ).toBeVisible();
  });

  describe("Stop sharing and its Undo", () => {
    beforeEach(stubVisibleToast);
    const stopCommenter = async () => {
      await userEvent.click(
        await screen.findByRole("button", { name: "More for Commenter link" }),
      );
      await userEvent.click(
        screen.getByRole("menuitem", { name: "Stop sharing" }),
      );
    };

    it("stops the link at once with no confirm, and a toast offers Undo for the server's window", async () => {
      server.shares = [hostShareRow()];
      render(<ToastedHost />);
      openInvite();
      await stopCommenter();
      await waitFor(() =>
        expect(server.revokeRequests).toEqual(["sample-review-link"]),
      );
      expect(server.revokeBodies).toEqual([{ path: PATH, restorable: true }]);
      expect(screen.queryByRole("button", { name: "Keep link" })).toBeNull();
      expect(await screen.findByText("Link stopped.")).toBeVisible();
      expect(screen.getByRole("button", { name: "Undo" })).toBeVisible();
      expect(useDawStore.getState().feedbackToast?.dwellMs).toBe(9500);
      expect(
        screen.queryByRole("button", { name: "More for Commenter link" }),
      ).toBeNull();
      await waitFor(() =>
        expect(
          screen.getByRole("heading", { name: "Review links" }),
        ).toHaveFocus(),
      );
    });

    it("sizes the toast to the window the server gave, not a fixed ten seconds", async () => {
      server.restoreMs = 4000;
      server.shares = [hostShareRow()];
      render(<ToastedHost />);
      openInvite();
      await stopCommenter();
      await screen.findByText("Link stopped.");
      expect(useDawStore.getState().feedbackToast?.dwellMs).toBe(3500);
    });

    it("brings the link back on Undo: the same row is live again", async () => {
      server.shares = [hostShareRow()];
      render(<ToastedHost />);
      openInvite();
      await stopCommenter();
      await userEvent.click(
        await screen.findByRole("button", { name: "Undo" }),
      );
      await waitFor(() =>
        expect(server.restoreRequests).toEqual(["sample-review-link"]),
      );
      expect(
        await screen.findByRole("button", { name: "More for Commenter link" }),
      ).toBeVisible();
      expect(await screen.findByText("Link restored.")).toBeVisible();
    });

    it.each([
      ["restore_window_closed", 410, "Too late to undo."],
      [
        "share_expired",
        410,
        "This link had already expired, so it stays stopped.",
      ],
      [
        "share_not_found",
        404,
        "That link is already gone, so there is nothing to undo.",
      ],
    ])("says why on a refused Undo (%s)", async (code, status, message) => {
      server.shares = [hostShareRow()];
      render(<ToastedHost />);
      openInvite();
      await stopCommenter();
      server.restoreAnswer = { status, code, body: { detail: message } };
      await userEvent.click(
        await screen.findByRole("button", { name: "Undo" }),
      );
      expect(await screen.findByText(message)).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "More for Commenter link" }),
      ).toBeNull();
    });

    it("ignores a second Stop sharing while the first Undo is open", async () => {
      server.shares = [
        hostShareRow(),
        hostShareRow({
          token: "second-link",
          url: "http://127.0.0.1:8765/r/second-link",
          docs_role: "editor",
        }),
      ];
      render(<ToastedHost />);
      openInvite();
      await stopCommenter();
      await screen.findByText("Link stopped.");
      await userEvent.click(
        await screen.findByRole("button", { name: "More for Editor link" }),
      );
      await userEvent.click(
        screen.getByRole("menuitem", { name: "Stop sharing" }),
      );
      expect(server.revokeRequests).toEqual(["sample-review-link"]);
      expect(screen.getAllByText("Link stopped.")).toHaveLength(1);
      expect(screen.getByText("Undo is still available.")).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: "Undo" }));
      await waitFor(() =>
        expect(server.restoreRequests).toEqual(["sample-review-link"]),
      );
      await waitFor(() =>
        expect(
          screen.getByRole("heading", { name: "Review links" }),
        ).toHaveFocus(),
      );
      expect(
        await screen.findByRole("button", { name: "More for Commenter link" }),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: "More for Editor link" }),
      ).toBeVisible();
    });
  });

  it("offers Refresh mix on the row after a stale mix, then makes the link once the mix is back", async () => {
    server.shareAnswer = {
      status: 409,
      code: "stale_mix",
      body: "premix.wav is stale",
    };
    render(<Host />);
    openInvite();
    const copy = await screen.findByRole("button", {
      name: "Copy new Commenter link",
    });
    await waitFor(() => expect(copy).toBeEnabled());
    await userEvent.click(copy);
    expect(
      await screen.findByText(
        "The mix preview is out of date. Refresh it before creating a review link.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/premix\.wav/)).toBeNull();
    server.shareAnswer = null;
    await userEvent.click(sheet().getByRole("button", { name: "Refresh mix" }));
    expect(refreshMix).toHaveBeenCalledWith("render.refreshMix");
    expect(await screen.findByText(/made-link-2/)).toBeVisible();
    expect(server.shareRequests).toHaveLength(2);
  });

  it("keeps Refresh mix when the refresh fails, and says why", async () => {
    server.shareAnswer = { status: 409, code: "no_mix", body: "no mix yet" };
    refreshMix.mockResolvedValue({
      status: "disabled",
      reason: "Render failed",
    });
    render(<Host />);
    openInvite();
    const copy = await screen.findByRole("button", {
      name: "Copy new Commenter link",
    });
    await waitFor(() => expect(copy).toBeEnabled());
    await userEvent.click(copy);
    await userEvent.click(
      await sheet().findByRole("button", { name: "Refresh mix" }),
    );
    expect(
      await screen.findByText("Refresh failed: Render failed"),
    ).toBeVisible();
    expect(sheet().getByRole("button", { name: "Refresh mix" })).toBeEnabled();
    expect(server.shareRequests).toHaveLength(1);
  });

  it("says a stale master needs an export, without Refresh mix", async () => {
    server.shareAnswer = { status: 409, code: "stale_master", body: "stale" };
    render(<Host />);
    openInvite();
    const copy = await screen.findByRole("button", {
      name: "Copy new Commenter link",
    });
    await waitFor(() => expect(copy).toBeEnabled());
    await userEvent.click(copy);
    expect(
      await screen.findByText(
        "The mastered mix is out of date. Export a new master before creating a review link.",
      ),
    ).toBeVisible();
    expect(sheet().queryByRole("button", { name: "Refresh mix" })).toBeNull();
  });

  it("forgets the choices when the sheet and Deliver are both left", async () => {
    render(<Host />);
    openInvite();
    await userEvent.click(
      await screen.findByRole("button", { name: "Editor: can edit" }),
    );
    expect(
      screen.getByRole("button", { name: "Editor: can edit" }),
    ).toHaveAttribute("aria-pressed", "true");
    act(() => useDawStore.getState().setOpenSheet(null));
    openInvite();
    expect(
      await screen.findByRole("button", { name: "Commenter: can comment" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("opens at the Record links and focuses them, from the empty Person tile", async () => {
    render(<Host />);
    openInvite("record");
    const heading = await screen.findByRole("heading", {
      name: "Record links",
    });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  describe("End room and its Undo", () => {
    beforeEach(stubVisibleToast);
    const room = () =>
      (server.shares = [
        hostShareRow({
          token: "g1",
          kind: "record",
          docs_role: null,
          record_role: "guest",
          session_id: "room-1",
        }),
      ]);

    it("offers Create record links beside the room", async () => {
      room();
      render(<ToastedHost />);
      openInvite("record");
      expect(await screen.findByText("Record room")).toBeVisible();
      expect(
        within(
          screen
            .getByRole("heading", { name: "Record links" })
            .closest("section") as HTMLElement,
        ).getByRole("button", { name: "Create record links" }),
      ).toBeEnabled();
    });

    it("ends the room at once with no confirm and offers Undo", async () => {
      room();
      render(<ToastedHost />);
      openInvite("record");
      await userEvent.click(
        await screen.findByRole("button", { name: "End room" }),
      );
      await waitFor(() => expect(server.revokeRequests).toEqual(["room-1"]));
      expect(server.revokeBodies).toEqual([{ path: PATH, restorable: true }]);
      expect(screen.queryByRole("button", { name: "Keep room" })).toBeNull();
      expect(await screen.findByText("Room ended.")).toBeVisible();
      expect(useDawStore.getState().feedbackToast?.dwellMs).toBe(9500);
      await waitFor(() => expect(screen.queryByText("Record room")).toBeNull());
      await waitFor(() =>
        expect(
          screen.getByRole("heading", { name: "Record links" }),
        ).toHaveFocus(),
      );
    });

    it("brings the room back on Undo", async () => {
      room();
      render(<ToastedHost />);
      openInvite("record");
      await userEvent.click(
        await screen.findByRole("button", { name: "End room" }),
      );
      await userEvent.click(
        await screen.findByRole("button", { name: "Undo" }),
      );
      await waitFor(() => expect(server.restoreRequests).toEqual(["room-1"]));
      expect(await screen.findByText("Room restored.")).toBeVisible();
      expect(await screen.findByText("Record room")).toBeVisible();
    });

    it("says another room is live when the restore conflicts", async () => {
      room();
      render(<ToastedHost />);
      openInvite("record");
      await userEvent.click(
        await screen.findByRole("button", { name: "End room" }),
      );
      server.restoreAnswer = {
        status: 409,
        code: "record_room_conflict",
        body: { detail: "another room is live" },
      };
      await userEvent.click(
        await screen.findByRole("button", { name: "Undo" }),
      );
      expect(
        await screen.findByText(
          "Another room is live, so this one stays ended.",
        ),
      ).toBeVisible();
      expect(screen.queryByText("Record room")).toBeNull();
    });
  });

  describe("Open Record stage", () => {
    const record = () =>
      (server.shares = [
        hostShareRow({
          token: "g1",
          kind: "record",
          docs_role: null,
          record_role: "guest",
          session_id: "room-1",
        }),
      ]);

    it("is offered over Deliver and dispatches stage.record once", async () => {
      const open = vi.fn(() => ({ status: "ok" as const }));
      registerCommand("stage.record", open);
      record();
      render(<Host />);
      openInvite();
      await screen.findByText("Record room");
      await userEvent.click(
        screen.getByRole("button", { name: "Open Record stage" }),
      );
      expect(open).toHaveBeenCalledTimes(1);
    });

    it("switches to Record and closes the sheet", async () => {
      record();
      render(<Host />);
      openInvite("record");
      await screen.findByText("Record room");
      await userEvent.click(
        screen.getByRole("button", { name: "Open Record stage" }),
      );
      await waitFor(() => expect(useDawStore.getState().stage).toBe("record"));
      expect(useDawStore.getState().openSheet).toBeNull();
      expect(useDawStore.getState().inviteAt).toBeNull();
      expect(screen.queryByRole("dialog", { name: "Invite" })).toBeNull();
    });

    it("appears once with two rooms", async () => {
      server.shares = ["room-1", "room-2"].map((session_id) =>
        hostShareRow({
          token: session_id,
          kind: "record",
          docs_role: null,
          record_role: "guest",
          session_id,
        }),
      );
      render(<Host />);
      openInvite();
      await waitFor(() =>
        expect(screen.getAllByText("Record room")).toHaveLength(2),
      );
      expect(
        screen.getAllByRole("button", { name: "Open Record stage" }),
      ).toHaveLength(1);
    });

    it("is not offered with no record rooms", async () => {
      server.shares = [];
      render(<Host />);
      openInvite("record");
      await screen.findByText("No record rooms yet.");
      expect(
        screen.queryByRole("button", { name: "Open Record stage" }),
      ).toBeNull();
    });

    it("is not offered when the stage is already Record", async () => {
      useDawStore.setState({ stage: "record" });
      record();
      render(<Host />);
      openInvite();
      await screen.findByText("Record room");
      expect(
        screen.queryByRole("button", { name: "Open Record stage" }),
      ).toBeNull();
    });
  });

  it("lists nothing and shows no sheet for a guest link", () => {
    useDawStore.getState().hydrate("share:abc", minimalProject());
    useDawStore.setState({ stage: "review", guestMode: "view" });
    render(
      <Host>
        <StageHost guestShare />
      </Host>,
    );
    expect(server.shareListRequests).toBe(0);
  });
});

describe("online sharing", () => {
  const status = (state: string) => ({
    state,
    reason: null,
    reason_kind: null,
    relay_host: "relay.example.test",
    public_base_url: "https://share.example.test",
    share_count: 1,
    retry_at: null,
  });
  const both = [FEATURE_SHARE_UI_MENU, FEATURE_TUNNEL_STATUS];

  it("shows the state in the Invite sheet only when the tunnel.status feature is present", async () => {
    loadTunnelStatus.mockResolvedValue(status("online"));
    useDawStore.setState({ stage: "edit" });
    const { unmount } = render(<Host />);
    openInvite();
    await screen.findByRole("dialog", { name: "Invite" });
    expect(loadTunnelStatus).not.toHaveBeenCalled();
    unmount();
    render(<Host features={both} />);
    openInvite();
    expect(await screen.findByText("Guests can open your links")).toBeVisible();
  });

  it.each([
    ["reconnecting", /^Reconnecting…/],
    ["offline", /^Not reachable online/],
    ["off", "Online sharing is off"],
  ] as const)("shows %s", async (state, headline) => {
    loadTunnelStatus.mockResolvedValue(status(state));
    useDawStore.setState({ stage: "edit" });
    render(<Host features={both} />);
    openInvite();
    expect(await screen.findByText(headline)).toBeVisible();
  });

  it("marks a link only this network reaches with a slashed globe and a popover, and a public one with a filled globe", async () => {
    server.shares = [
      hostShareRow({
        token: "listen-1",
        docs_role: "viewer",
        follow_latest: false,
      }),
    ];
    loadTunnelStatus.mockResolvedValue(status("off"));
    const { unmount } = render(<Host features={both} />);
    const glyph = await listen().findByRole("button", {
      name: "Only on this network",
    });
    expect(glyph).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(glyph);
    expect(glyph).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText(/Only people on this network can open it/),
    ).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(glyph).toHaveAttribute("aria-expanded", "false");
    unmount();
    loadTunnelStatus.mockResolvedValue(status("online"));
    render(<Host features={both} />);
    expect(
      await listen().findByRole("button", { name: "Reachable from anywhere" }),
    ).toBeVisible();
  });

  it("stops polling when the sheet and Deliver are left", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      loadTunnelStatus.mockResolvedValue(status("online"));
      useDawStore.setState({ stage: "edit" });
      render(<Host features={both} />);
      openInvite();
      await screen.findByText("Guests can open your links");
      const polled = loadTunnelStatus.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });
      expect(loadTunnelStatus.mock.calls.length).toBeGreaterThan(polled);
      act(() => useDawStore.getState().setOpenSheet(null));
      const left = loadTunnelStatus.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000);
      });
      expect(loadTunnelStatus.mock.calls.length).toBe(left);
    } finally {
      vi.useRealTimers();
    }
  });
});

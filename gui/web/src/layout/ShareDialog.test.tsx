import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeaturesContext } from "../extensions/FeaturesContext";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import type { HostShareRow } from "../types/shares";
import { ApiError } from "../utils/apiError";
import { ShareDialog } from "./ShareDialog";

const listHostShares = vi.fn();
const createHostShare = vi.fn();
const revokeHostShare = vi.fn();
const createHostRecordRoom = vi.fn();
const revokeHostRoom = vi.fn();
const execute = vi.fn();
const loadTunnelStatus = vi.fn();

vi.mock("../api/tunnelStatus", () => ({
  loadTunnelStatus: (...args: unknown[]) => loadTunnelStatus(...args),
}));

vi.mock("../commands/execute", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/execute")>();
  return {
    ...actual,
    execute: (...args: Parameters<typeof actual.execute>) =>
      args[0] === "render.refreshMix"
        ? execute(...args)
        : actual.execute(...args),
  };
});
const replaceHostRecordInvite = vi.fn();

vi.mock("../api", () => ({
  listHostShares: (...args: unknown[]) => listHostShares(...args),
  createHostShare: (...args: unknown[]) => createHostShare(...args),
  revokeHostShare: (...args: unknown[]) => revokeHostShare(...args),
  createHostRecordRoom: (...args: unknown[]) => createHostRecordRoom(...args),
  revokeHostRoom: (...args: unknown[]) => revokeHostRoom(...args),
  replaceHostRecordInvite: (...args: unknown[]) =>
    replaceHostRecordInvite(...args),
}));

const projectStub = {
  name: "ep",
  timeline_duration_sec: 60,
  tracks: [],
  clips: { tracks: {} },
} as never;

const liveRow: HostShareRow = {
  token: "fantastic-acoustic-whale",
  url: "http://127.0.0.1:8765/r/fantastic-acoustic-whale",
  docs_role: "commenter",
  mcp_url: null,
  usable: true,
  invite_closed: null,
  review_version_label: "Share mix",
  last_used_at: "2026-09-05T12:00:00Z",
};

const mcpRow: HostShareRow = {
  ...liveRow,
  token: "editor-mcp-narwhal",
  url: "http://127.0.0.1:8765/r/editor-mcp-narwhal",
  docs_role: "editor",
  mcp_url: "http://127.0.0.1:8765/mcp/editor-mcp-narwhal/mcp",
};

function listed(shares: HostShareRow[] = []) {
  return {
    shares,
    public_origin: "http://127.0.0.1:8765",
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("ShareDialog", () => {
  beforeEach(() => {
    loadTunnelStatus.mockReset();
    listHostShares.mockReset();
    createHostShare.mockReset();
    revokeHostShare.mockReset();
    createHostRecordRoom.mockReset();
    revokeHostRoom.mockReset();
    execute.mockReset().mockResolvedValue({ status: "ok" });
    replaceHostRecordInvite.mockReset();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    listHostShares.mockResolvedValue(listed());
    useDawStore.setState({
      shareDialogOpen: false,
      projectEpoch: 1,
      projectPath: "/tmp/ep.project.json",
      project: projectStub,
      statusAnnouncement: "",
    });
  });

  it("shows empty live list and is axe-clean", async () => {
    useDawStore.setState({ shareDialogOpen: true });
    const { baseElement: container } = render(<ShareDialog />);
    const dialog = await screen.findByRole("dialog", { name: "Share" });
    expect(dialog.querySelector(".command-palette-body")).toBeTruthy();
    expect(dialog.querySelector(".share-dialog-body")).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "Record rooms" }),
    ).toBeTruthy();
    expect(await screen.findByText("No live review links.")).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("shows the tunnel state only when the tunnel.status feature is present", async () => {
    loadTunnelStatus.mockResolvedValue({
      state: "online",
      reason: null,
      reason_kind: null,
      relay_host: "relay.example.test",
      public_base_url: "https://share.example.test",
      share_count: 1,
      attempt: 0,
      retry_in_sec: null,
    });
    useDawStore.setState({ shareDialogOpen: true });
    const { unmount } = render(<ShareDialog />);
    await screen.findByText("No live review links.");
    expect(loadTunnelStatus).not.toHaveBeenCalled();
    unmount();

    render(
      <FeaturesContext.Provider
        value={{
          ready: true,
          manifest: { api_version: 1, features: ["tunnel.status"] },
        }}
      >
        <ShareDialog />
      </FeaturesContext.Provider>,
    );
    expect(await screen.findByText("Guests can open your links.")).toBeTruthy();
  });

  it("loads the current scope after StrictMode effect replay", async () => {
    listHostShares.mockResolvedValue(listed([liveRow]));
    useDawStore.setState({ shareDialogOpen: true });
    render(
      <StrictMode>
        <ShareDialog />
      </StrictMode>,
    );

    expect(await screen.findByText("fantastic-acoustic-whale")).toBeTruthy();
    expect(listHostShares).toHaveBeenCalledTimes(2);
  });

  it("shows a current list error", async () => {
    listHostShares.mockRejectedValue(new Error("List failed"));
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);

    expect(await screen.findByText("List failed")).toBeTruthy();
  });

  it("suppresses a list error from an obsolete project generation", async () => {
    const oldLoad = deferred<ReturnType<typeof listed>>();
    listHostShares.mockReturnValueOnce(oldLoad.promise);
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);

    await waitFor(() => expect(listHostShares).toHaveBeenCalledTimes(1));
    act(() => useDawStore.setState({ projectEpoch: 2 }));
    expect(await screen.findByText("No live review links.")).toBeTruthy();
    await act(async () => {
      oldLoad.reject(new Error("Obsolete list failed"));
      await oldLoad.promise.catch(() => undefined);
    });

    expect(screen.queryByText("Obsolete list failed")).toBeNull();
    expect(screen.getByText("No live review links.")).toBeTruthy();
  });

  it("creates a link, copies it, and lists the live row", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    createHostShare.mockResolvedValue(liveRow);
    listHostShares
      .mockResolvedValueOnce(listed())
      .mockResolvedValue(listed([liveRow]));
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);
    await screen.findByText("No live review links.");
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await waitFor(() => {
      expect(createHostShare).toHaveBeenCalledWith("/tmp/ep.project.json", {
        role: "commenter",
        with_mcp: false,
      });
    });
    expect(await screen.findByText("fantastic-acoustic-whale")).toBeTruthy();
    expect(screen.getByText(/Commenter · Share mix/)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(liveRow.url);
    expect(useDawStore.getState().statusAnnouncement).toMatch(
      /Share link created/,
    );
  });

  it("ignores a create completion after the dialog unmounts", async () => {
    const user = userEvent.setup();
    const create = deferred<HostShareRow>();
    createHostShare.mockReturnValue(create.promise);
    useDawStore.setState({ shareDialogOpen: true });
    const view = render(<ShareDialog />);
    await screen.findByText("No live review links.");
    await user.click(screen.getByRole("button", { name: "Create link" }));
    view.unmount();

    await act(async () => {
      create.resolve(liveRow);
      await create.promise;
    });

    expect(useDawStore.getState().statusAnnouncement).toBe("");
    expect(listHostShares).toHaveBeenCalledTimes(1);
  });

  it("waits for Refresh to succeed, then retries the captured create once", async () => {
    const user = userEvent.setup();
    let finishRefresh!: (result: { status: "ok" }) => void;
    execute.mockReturnValue(
      new Promise((resolve) => {
        finishRefresh = resolve;
      }),
    );
    createHostShare
      .mockRejectedValueOnce(
        new ApiError(
          "premix.wav is stale; render-preview provenance mismatch",
          "stale_mix",
          409,
        ),
      )
      .mockResolvedValueOnce(liveRow);
    listHostShares.mockResolvedValue(listed([liveRow]));
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);

    await user.click(
      await screen.findByRole("button", { name: "Create link" }),
    );
    expect(
      await screen.findByText(
        "The mix preview is out of date. Refresh it before creating a review link.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(/premix\.wav|render-preview provenance/),
    ).toBeNull();
    await user.selectOptions(
      screen.getByLabelText("Anyone with the link"),
      "editor",
    );
    await user.click(screen.getByLabelText("Allow agent (MCP)"));
    await user.click(
      await screen.findByRole("button", { name: "Refresh mix" }),
    );
    expect(execute).toHaveBeenCalledWith("render.refreshMix");
    expect(createHostShare).toHaveBeenCalledTimes(1);

    finishRefresh({ status: "ok" });
    await waitFor(() => expect(createHostShare).toHaveBeenCalledTimes(2));
    expect(createHostShare).toHaveBeenNthCalledWith(2, "/tmp/ep.project.json", {
      role: "commenter",
      with_mcp: false,
    });
    expect(await screen.findByText("fantastic-acoustic-whale")).toBeTruthy();
  });

  it("keeps a reopened create busy when the earlier create resolves", async () => {
    const user = userEvent.setup();
    let finishOld!: (row: HostShareRow) => void;
    let finishNew!: (row: HostShareRow) => void;
    createHostShare
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishOld = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishNew = resolve;
        }),
      );
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);

    await user.click(
      await screen.findByRole("button", { name: "Create link" }),
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
    act(() => useDawStore.setState({ shareDialogOpen: true }));
    await user.click(
      await screen.findByRole("button", { name: "Create link" }),
    );

    await act(async () => {
      finishOld(liveRow);
    });
    expect(screen.getByRole("button", { name: "Create link" })).toBeDisabled();
    await act(async () => {
      finishNew(liveRow);
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create link" })).toBeEnabled(),
    );
  });

  it("keeps a reopened refresh busy when the earlier refresh resolves", async () => {
    const user = userEvent.setup();
    let finishOld!: (result: { status: "ok" }) => void;
    let finishNew!: (result: { status: "disabled"; reason: string }) => void;
    execute
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishOld = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishNew = resolve;
        }),
      );
    const stale = () =>
      new ApiError("premix is stale; refresh it", "stale_mix", 409);
    createHostShare.mockRejectedValue(stale());
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);

    await user.click(
      await screen.findByRole("button", { name: "Create link" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Refresh mix" }),
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
    act(() => useDawStore.setState({ shareDialogOpen: true }));
    await user.click(
      await screen.findByRole("button", { name: "Create link" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Refresh mix" }),
    );

    await act(async () => {
      finishOld({ status: "ok" });
    });
    expect(screen.getByRole("button", { name: "Create link" })).toBeDisabled();
    await act(async () => {
      finishNew({ status: "disabled", reason: "Render failed" });
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh mix" })).toBeEnabled(),
    );
  });

  it("keeps Refresh available and does not create when refresh fails", async () => {
    const user = userEvent.setup();
    createHostShare.mockRejectedValue(
      new ApiError(
        "premix.wav is stale; render-preview provenance mismatch",
        "stale_mix",
        409,
      ),
    );
    execute.mockResolvedValue({ status: "disabled", reason: "Render failed" });
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);

    await user.click(
      await screen.findByRole("button", { name: "Create link" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Refresh mix" }),
    );
    expect(
      await screen.findByText("Refresh failed: Render failed"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh mix" })).toBeEnabled();
    expect(createHostShare).toHaveBeenCalledTimes(1);
  });

  it("does not offer preview Refresh for a stale-master error", async () => {
    const user = userEvent.setup();
    createHostShare.mockRejectedValue(
      new ApiError(
        "master_loudness provenance mismatch for premix.wav",
        "stale_master",
        409,
      ),
    );
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);

    await user.click(
      await screen.findByRole("button", { name: "Create link" }),
    );
    expect(
      await screen.findByText(
        "The mastered mix is out of date. Export a new master before creating a review link.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/master_loudness|premix\.wav/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh mix" })).toBeNull();
  });

  it("returns a repeated stale response to explicit recovery without looping", async () => {
    const user = userEvent.setup();
    const stale = () =>
      new ApiError("premix is stale; refresh it", "stale_mix", 409);
    createHostShare
      .mockRejectedValueOnce(stale())
      .mockRejectedValueOnce(stale());
    execute.mockResolvedValue({ status: "ok" });
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);

    await user.click(
      await screen.findByRole("button", { name: "Create link" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Refresh mix" }),
    );
    expect(
      await screen.findByRole("button", { name: "Refresh mix" }),
    ).toBeEnabled();
    expect(createHostShare).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not retry if the project changes while Refresh is running", async () => {
    const user = userEvent.setup();
    let finishRefresh!: (result: { status: "ok" }) => void;
    execute.mockReturnValue(
      new Promise((resolve) => {
        finishRefresh = resolve;
      }),
    );
    createHostShare.mockRejectedValue(
      new ApiError("premix is stale; refresh it", "stale_mix", 409),
    );
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);

    await user.click(
      await screen.findByRole("button", { name: "Create link" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Refresh mix" }),
    );
    useDawStore.setState({
      projectPath: "/tmp/other.project.json",
      projectEpoch: 2,
    });
    await user.click(screen.getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(createHostShare).toHaveBeenCalledTimes(2));
    expect(createHostShare).toHaveBeenNthCalledWith(
      2,
      "/tmp/other.project.json",
      { role: "commenter", with_mcp: false },
    );
    finishRefresh({ status: "ok" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(createHostShare).toHaveBeenCalledTimes(2);
  });

  it("does not retry after the dialog closes during Refresh", async () => {
    const user = userEvent.setup();
    let finishRefresh!: (result: { status: "ok" }) => void;
    execute.mockReturnValue(
      new Promise((resolve) => {
        finishRefresh = resolve;
      }),
    );
    createHostShare.mockRejectedValue(
      new ApiError("premix is stale; refresh it", "stale_mix", 409),
    );
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);

    await user.click(
      await screen.findByRole("button", { name: "Create link" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Refresh mix" }),
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
    finishRefresh({ status: "ok" });
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(createHostShare).toHaveBeenCalledTimes(1);
  });

  it("invalidates recovery when a project is reopened at the same path", async () => {
    const user = userEvent.setup();
    let finishRefresh!: (result: { status: "ok" }) => void;
    execute.mockReturnValue(
      new Promise((resolve) => {
        finishRefresh = resolve;
      }),
    );
    createHostShare.mockRejectedValue(
      new ApiError("premix is stale; refresh it", "stale_mix", 409),
    );
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);

    await user.click(
      await screen.findByRole("button", { name: "Create link" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Refresh mix" }),
    );
    useDawStore.setState({ projectEpoch: 3 });
    expect(screen.queryByRole("button", { name: "Refresh mix" })).toBeNull();
    finishRefresh({ status: "ok" });
    expect(createHostShare).toHaveBeenCalledTimes(1);
  });

  it("keeps Create link label and reports clipboard errors after mint", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi
          .fn()
          .mockRejectedValue(new Error("Clipboard unavailable")),
      },
    });
    createHostShare.mockResolvedValue(liveRow);
    listHostShares
      .mockResolvedValueOnce(listed())
      .mockResolvedValue(listed([liveRow]));
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);
    await screen.findByText("No live review links.");
    expect(screen.getByRole("button", { name: "Create link" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    expect(await screen.findByText("Clipboard unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create link" })).toBeTruthy();
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Share link created",
    );
  });

  it("flashes Copied on the copy button after Copy link", async () => {
    const user = userEvent.setup();
    listHostShares.mockResolvedValue(listed([liveRow]));
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);
    await user.click(await screen.findByRole("button", { name: "Copy link" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(useDawStore.getState().statusAnnouncement).toBe("Link copied");
  });

  it("copies the agent URL for MCP shares", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    listHostShares.mockResolvedValue(listed([mcpRow]));
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy agent URL" }),
    );
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(mcpRow.mcp_url);
    });
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(useDawStore.getState().statusAnnouncement).toBe("Agent URL copied");
  });

  it("lists live rows and is axe-clean", async () => {
    listHostShares.mockResolvedValue(listed([liveRow, mcpRow]));
    useDawStore.setState({ shareDialogOpen: true });
    const { baseElement: container } = render(<ShareDialog />);
    expect(await screen.findByText("fantastic-acoustic-whale")).toBeTruthy();
    expect(await screen.findByText("editor-mcp-narwhal")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy agent URL" })).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("revokes a live share after confirm", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    listHostShares.mockResolvedValue(listed([liveRow]));
    revokeHostShare.mockResolvedValue(undefined);
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);
    expect(await screen.findByText("fantastic-acoustic-whale")).toBeTruthy();
    listHostShares.mockResolvedValue(
      listed([{ ...liveRow, usable: false, revoked: true }]),
    );
    await user.click(screen.getByRole("button", { name: "Stop sharing" }));
    await waitFor(() => {
      expect(revokeHostShare).toHaveBeenCalledWith(
        "/tmp/ep.project.json",
        "fantastic-acoustic-whale",
      );
    });
    expect(await screen.findByText("No live review links.")).toBeTruthy();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button" data-testid="opener">
          Open share
        </button>
        <div data-daw-app-chrome />
        <ShareDialog />
      </div>,
    );
    screen.getByTestId("opener").focus();
    useDawStore.setState({ shareDialogOpen: true });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    });
    await user.keyboard("{Escape}");
    expect(useDawStore.getState().shareDialogOpen).toBe(false);
  });

  it("creates record links and can end the room", async () => {
    const guestRow: HostShareRow = {
      token: "guest-room-tok",
      url: "http://127.0.0.1:8765/rec/guest-room-tok",
      kind: "record",
      docs_role: null,
      record_role: "guest",
      session_id: "sess1",
      mcp_url: null,
      usable: true,
      invite_closed: false,
    };
    const producerRow: HostShareRow = {
      ...guestRow,
      token: "prod-room-tok",
      url: "http://127.0.0.1:8765/rec/prod-room-tok",
      record_role: "producer",
    };
    let shares: HostShareRow[] = [];
    listHostShares.mockImplementation(async () => listed(shares));
    createHostRecordRoom.mockImplementation(async () => {
      shares = [guestRow, producerRow];
      return {
        session_id: "sess1",
        guest: guestRow,
        producer: producerRow,
      };
    });
    revokeHostRoom.mockImplementation(async () => {
      shares = [];
      return {
        session_id: "sess1",
        revoked: [guestRow.token, producerRow.token],
      };
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    useDawStore.setState({ shareDialogOpen: true });
    const { baseElement: container } = render(<ShareDialog />);
    await screen.findByRole("heading", { name: "Record session" });
    fireEvent.click(
      screen.getByRole("button", { name: "Create record links" }),
    );
    await waitFor(() => {
      expect(createHostRecordRoom).toHaveBeenCalledWith("/tmp/ep.project.json");
    });
    expect(await screen.findByText("Guest link")).toBeTruthy();
    expect(screen.getByText("Producer link")).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: "Copied guest link" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy producer link" }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "End room" }),
      ).not.toBeDisabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "End room" }));
    await waitFor(() => {
      expect(revokeHostRoom).toHaveBeenCalledWith(
        "/tmp/ep.project.json",
        "sess1",
      );
    });
    expect(await screen.findByText("No live record rooms.")).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("releases a stale record operation after a same-path project reopen", async () => {
    const user = userEvent.setup();
    const guestRow: HostShareRow = {
      token: "guest-room-tok",
      url: "http://127.0.0.1:8765/rec/guest-room-tok",
      kind: "record",
      docs_role: null,
      record_role: "guest",
      session_id: "sess1",
      mcp_url: null,
      usable: true,
      invite_closed: false,
    };
    const producerRow: HostShareRow = {
      ...guestRow,
      token: "producer-room-tok",
      url: "http://127.0.0.1:8765/rec/producer-room-tok",
      record_role: "producer",
    };
    const room = {
      session_id: "sess1",
      guest: guestRow,
      producer: producerRow,
    };
    let finishFirst!: (result: typeof room) => void;
    createHostRecordRoom
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(room);
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);
    await screen.findByRole("heading", { name: "Record session" });
    await user.click(
      screen.getByRole("button", { name: "Create record links" }),
    );
    await waitFor(() => expect(createHostRecordRoom).toHaveBeenCalledTimes(1));

    act(() => useDawStore.setState({ projectEpoch: 2 }));
    await waitFor(() => expect(listHostShares).toHaveBeenCalledTimes(2));
    await act(async () => finishFirst(room));

    await user.click(
      screen.getByRole("button", { name: "Create record links" }),
    );
    await waitFor(() => expect(createHostRecordRoom).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText("Record links created and guest link copied"),
    ).toBeTruthy();
  });

  it("opens the record panel from a live room", async () => {
    const { registerDawCommands } = await import("../commands/register");
    registerDawCommands();
    const guestRow: HostShareRow = {
      token: "guest-room-tok",
      url: "http://127.0.0.1:8765/rec/guest-room-tok",
      kind: "record",
      docs_role: null,
      record_role: "guest",
      session_id: "sess1",
      mcp_url: null,
      usable: true,
      invite_closed: false,
    };
    const producerRow: HostShareRow = {
      ...guestRow,
      token: "prod-room-tok",
      url: "http://127.0.0.1:8765/rec/prod-room-tok",
      record_role: "producer",
    };
    listHostShares.mockResolvedValue(listed([guestRow, producerRow]));
    useDawStore.setState({ shareDialogOpen: true, recordPanelOpen: false });
    render(<ShareDialog />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Open room panel" }),
    );
    expect(useDawStore.getState().shareDialogOpen).toBe(false);
    expect(useDawStore.getState().recordPanelOpen).toBe(true);
  });

  it("replaces a closed guest invite, copies the new link, and refreshes rows", async () => {
    const closedGuest: HostShareRow = {
      token: "closed-guest-token",
      url: "http://127.0.0.1:8765/rec/closed-guest-token",
      kind: "record",
      docs_role: null,
      record_role: "guest",
      session_id: "sess1",
      mcp_url: null,
      usable: true,
      invite_closed: true,
    };
    const replacement: HostShareRow = {
      ...closedGuest,
      token: "replacement-guest-token",
      url: "http://127.0.0.1:8765/rec/replacement-guest-token",
      invite_closed: false,
    };
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    listHostShares
      .mockResolvedValueOnce(listed([closedGuest]))
      .mockResolvedValue(listed([closedGuest, replacement]));
    replaceHostRecordInvite.mockResolvedValue(replacement);
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Replace guest invite" }),
    );

    await waitFor(() => {
      expect(replaceHostRecordInvite).toHaveBeenCalledWith(
        "/tmp/ep.project.json",
        "closed-guest-token",
      );
      expect(writeText).toHaveBeenCalledWith(replacement.url);
    });
    expect(await screen.findByText("replacement-guest-token")).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: "Copied guest link" }),
    ).toBeTruthy();
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Guest link replaced and copied",
    );
  });

  it("ignores a replacement clipboard completion after project epoch change", async () => {
    const closedGuest: HostShareRow = {
      token: "closed-guest-token",
      url: "http://127.0.0.1:8765/rec/closed-guest-token",
      kind: "record",
      docs_role: null,
      record_role: "guest",
      session_id: "sess1",
      mcp_url: null,
      usable: true,
      invite_closed: true,
    };
    const replacement = {
      ...closedGuest,
      token: "replacement-guest-token",
      url: "http://127.0.0.1:8765/rec/replacement-guest-token",
      invite_closed: false,
    };
    const otherProject = { ...liveRow, token: "other-project-share" };
    const clipboard = deferred<void>();
    const writeText = vi.fn(() => clipboard.promise);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    listHostShares
      .mockResolvedValueOnce(listed([closedGuest]))
      .mockResolvedValueOnce(listed([otherProject]));
    replaceHostRecordInvite.mockResolvedValue(replacement);
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Replace guest invite" }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(replacement.url),
    );

    act(() => {
      useDawStore.setState((state) => ({
        projectEpoch: state.projectEpoch + 1,
      }));
    });
    expect(await screen.findByText("other-project-share")).toBeTruthy();
    await act(async () => {
      clipboard.resolve();
      await clipboard.promise;
    });

    expect(screen.queryByText("replacement-guest-token")).toBeNull();
    expect(listHostShares).toHaveBeenCalledTimes(2);
    expect(useDawStore.getState().statusAnnouncement).not.toContain(
      "replaced and copied",
    );
  });

  it("ignores a replacement clipboard completion after close and reopen", async () => {
    const closedGuest: HostShareRow = {
      token: "closed-guest-token",
      url: "http://127.0.0.1:8765/rec/closed-guest-token",
      kind: "record",
      docs_role: null,
      record_role: "guest",
      session_id: "sess1",
      mcp_url: null,
      usable: true,
      invite_closed: true,
    };
    const replacement = {
      ...closedGuest,
      token: "replacement-guest-token",
      url: "http://127.0.0.1:8765/rec/replacement-guest-token",
      invite_closed: false,
    };
    const reopenedRow = { ...liveRow, token: "reopened-project-share" };
    const clipboard = deferred<void>();
    const writeText = vi.fn(() => clipboard.promise);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    listHostShares
      .mockResolvedValueOnce(listed([closedGuest]))
      .mockResolvedValueOnce(listed([reopenedRow]));
    replaceHostRecordInvite.mockResolvedValue(replacement);
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Replace guest invite" }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(replacement.url),
    );

    act(() => useDawStore.getState().setShareDialogOpen(false));
    act(() => useDawStore.getState().setShareDialogOpen(true));
    expect(await screen.findByText("reopened-project-share")).toBeTruthy();
    await act(async () => {
      clipboard.resolve();
      await clipboard.promise;
    });

    expect(screen.queryByText("replacement-guest-token")).toBeNull();
    expect(listHostShares).toHaveBeenCalledTimes(2);
    expect(useDawStore.getState().statusAnnouncement).not.toContain(
      "replaced and copied",
    );
  });
});

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeaturesContext } from "../../extensions/FeaturesContext";
import { ShareSection } from "../../stages/deliver/ShareSection";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { setChrome } from "../../test/chrome";
import type { HostShareRow } from "../../types/shares";
import { ApiError } from "../../utils/apiError";
import { shareOptionsOf } from "./deliverShare";
import { useShareFlow } from "./shareFlow";

const listHostShares = vi.fn();
const createHostShare = vi.fn();
const revokeHostShare = vi.fn();
const createHostRecordRoom = vi.fn();
const revokeHostRoom = vi.fn();
const execute = vi.fn();
const loadTunnelStatus = vi.fn();

vi.mock("../../api/tunnelStatus", () => ({
  loadTunnelStatus: (...args: unknown[]) => loadTunnelStatus(...args),
}));

vi.mock("../../commands/execute", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../commands/execute")>();
  return {
    ...actual,
    execute: (...args: Parameters<typeof actual.execute>) =>
      args[0] === "render.refreshMix"
        ? execute(...args)
        : actual.execute(...args),
  };
});
const replaceHostRecordInvite = vi.fn();

vi.mock("../../api", () => ({
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

function ShareFlowHarness() {
  const [active, setActive] = useState(true);
  const flow = useShareFlow(active);
  return (
    <>
      <button type="button" onClick={() => setActive((on) => !on)}>
        {active ? "Leave Deliver" : "Back to Deliver"}
      </button>
      {active ? (
        <ShareSection
          options={shareOptionsOf(flow, {
            focusRequested: false,
            onFocused: () => {},
          })}
        />
      ) : null}
    </>
  );
}

describe("the share flow", () => {
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
      projectEpoch: 1,
      projectPath: "/tmp/ep.project.json",
      project: projectStub,
      statusAnnouncement: "",
    });
  });

  it("shows empty live list and is axe-clean", async () => {
    const { baseElement: container } = render(<ShareFlowHarness />);
    expect(
      await screen.findByRole("region", { name: "Share" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Record rooms" }),
    ).toBeTruthy();
    expect(await screen.findByText("No review links yet.")).toBeTruthy();
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
      retry_at: null,
    });
    const { unmount } = render(<ShareFlowHarness />);
    await screen.findByText("No review links yet.");
    expect(loadTunnelStatus).not.toHaveBeenCalled();
    unmount();

    render(
      <FeaturesContext.Provider
        value={{
          ready: true,
          manifest: { api_version: 1, features: ["tunnel.status"] },
        }}
      >
        <ShareFlowHarness />
      </FeaturesContext.Provider>,
    );
    expect(await screen.findByText("Guests can open your links")).toBeTruthy();
  });

  it("loads the current scope after StrictMode effect replay", async () => {
    listHostShares.mockResolvedValue(listed([liveRow]));
    render(
      <StrictMode>
        <ShareFlowHarness />
      </StrictMode>,
    );

    expect(await screen.findByText("fantastic-acoustic-whale")).toBeTruthy();
    expect(listHostShares).toHaveBeenCalledTimes(2);
  });

  it("shows a current list error", async () => {
    listHostShares.mockRejectedValue(new Error("List failed"));
    render(<ShareFlowHarness />);

    expect(await screen.findByText("List failed")).toBeTruthy();
  });

  it("suppresses a list error from an obsolete project generation", async () => {
    const oldLoad = deferred<ReturnType<typeof listed>>();
    listHostShares.mockReturnValueOnce(oldLoad.promise);
    render(<ShareFlowHarness />);

    await waitFor(() => expect(listHostShares).toHaveBeenCalledTimes(1));
    act(() => useDawStore.setState({ projectEpoch: 2 }));
    expect(await screen.findByText("No review links yet.")).toBeTruthy();
    await act(async () => {
      oldLoad.reject(new Error("Obsolete list failed"));
      await oldLoad.promise.catch(() => undefined);
    });

    expect(screen.queryByText("Obsolete list failed")).toBeNull();
    expect(screen.getByText("No review links yet.")).toBeTruthy();
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
    render(<ShareFlowHarness />);
    await screen.findByText("No review links yet.");
    fireEvent.click(screen.getByRole("button", { name: "Create review link" }));
    await waitFor(() => {
      expect(createHostShare).toHaveBeenCalledWith("/tmp/ep.project.json", {
        role: "commenter",
        with_mcp: false,
      });
    });
    expect(await screen.findByText("fantastic-acoustic-whale")).toBeTruthy();
    expect(screen.getByText("Commenter link")).toBeTruthy();
    expect(
      await screen.findAllByRole("button", { name: /^Copied/ }),
    ).toHaveLength(2);
    expect(writeText).toHaveBeenCalledWith(liveRow.url);
    expect(useDawStore.getState().statusAnnouncement).toMatch(
      /Review link created/,
    );
  });

  it("sends freeze when the host freezes the new link on the current version", async () => {
    createHostShare.mockResolvedValue(liveRow);
    listHostShares.mockResolvedValue(listed());
    render(<ShareFlowHarness />);
    await screen.findByText("No review links yet.");
    fireEvent.click(screen.getByLabelText("Freeze on the current version"));
    fireEvent.click(screen.getByRole("button", { name: "Create review link" }));
    await waitFor(() => {
      expect(createHostShare).toHaveBeenCalledWith("/tmp/ep.project.json", {
        role: "commenter",
        with_mcp: false,
        freeze: true,
      });
    });
  });

  it("tells the host when the bucket has no CORS rule for the share origin", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    createHostShare.mockResolvedValue({
      ...liveRow,
      warnings: [
        {
          code: "object_store_cors",
          message: "Guests will hear nothing",
          origin: "https://sharecut.studio",
        },
      ],
    });
    listHostShares
      .mockResolvedValueOnce(listed())
      .mockResolvedValue(listed([liveRow]));
    render(<ShareFlowHarness />);
    await screen.findByText("No review links yet.");
    fireEvent.click(screen.getByRole("button", { name: "Create review link" }));
    expect(
      await screen.findByText(/no CORS rule for https:\/\/sharecut\.studio/),
    ).toBeTruthy();
    expect(await screen.findByText("fantastic-acoustic-whale")).toBeTruthy();
  });

  it("ignores a create completion after the stage unmounts", async () => {
    const user = userEvent.setup();
    const create = deferred<HostShareRow>();
    createHostShare.mockReturnValue(create.promise);
    const view = render(<ShareFlowHarness />);
    await screen.findByText("No review links yet.");
    await user.click(
      screen.getByRole("button", { name: "Create review link" }),
    );
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
    render(<ShareFlowHarness />);

    await user.click(
      await screen.findByRole("button", { name: "Create review link" }),
    );
    expect(
      await screen.findByText(
        "The mix preview is out of date. Refresh it before creating a review link.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(/premix\.wav|render-preview provenance/),
    ).toBeNull();
    await user.click(screen.getByRole("radio", { name: "Editor" }));
    await user.click(screen.getByLabelText("Allow AI assistants (MCP)"));
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

  it("pairs a project with no mix with Refresh mix, then creates the link; axe-clean", async () => {
    const user = userEvent.setup();
    createHostShare
      .mockRejectedValueOnce(
        new ApiError(
          "this project has no mix yet (no premix.wav or mastered.wav); Refresh (render-preview) to render one",
          "no_mix",
          409,
        ),
      )
      .mockResolvedValueOnce(liveRow);
    execute.mockResolvedValue({ status: "ok" });
    listHostShares.mockResolvedValue(listed([liveRow]));
    const { baseElement } = render(<ShareFlowHarness />);

    await user.click(
      await screen.findByRole("button", { name: "Create review link" }),
    );
    expect(
      await screen.findByText(
        "This project has no mix yet. Refresh the mix to create the link.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/render-preview|pipeline|premix/)).toBeNull();
    await expectNoA11yViolations(baseElement);

    await user.click(screen.getByRole("button", { name: "Refresh mix" }));
    expect(execute).toHaveBeenCalledWith("render.refreshMix");
    await waitFor(() => expect(createHostShare).toHaveBeenCalledTimes(2));
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
    render(<ShareFlowHarness />);

    await user.click(
      await screen.findByRole("button", { name: "Create review link" }),
    );
    await user.click(screen.getByRole("button", { name: "Leave Deliver" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to Deliver" }));
    await user.click(
      await screen.findByRole("button", { name: "Create review link" }),
    );

    await act(async () => {
      finishOld(liveRow);
    });
    expect(
      screen.getByRole("button", { name: "Create review link" }),
    ).toBeDisabled();
    await act(async () => {
      finishNew(liveRow);
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Create review link" }),
      ).toBeEnabled(),
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
    render(<ShareFlowHarness />);

    await user.click(
      await screen.findByRole("button", { name: "Create review link" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Refresh mix" }),
    );
    await user.click(screen.getByRole("button", { name: "Leave Deliver" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to Deliver" }));
    await user.click(
      await screen.findByRole("button", { name: "Create review link" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Refresh mix" }),
    );

    await act(async () => {
      finishOld({ status: "ok" });
    });
    expect(
      screen.getByRole("button", { name: "Create review link" }),
    ).toBeDisabled();
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
    render(<ShareFlowHarness />);

    await user.click(
      await screen.findByRole("button", { name: "Create review link" }),
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
    render(<ShareFlowHarness />);

    await user.click(
      await screen.findByRole("button", { name: "Create review link" }),
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
    render(<ShareFlowHarness />);

    await user.click(
      await screen.findByRole("button", { name: "Create review link" }),
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
    render(<ShareFlowHarness />);

    await user.click(
      await screen.findByRole("button", { name: "Create review link" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Refresh mix" }),
    );
    useDawStore.setState({
      projectPath: "/tmp/other.project.json",
      projectEpoch: 2,
    });
    await user.click(
      screen.getByRole("button", { name: "Create review link" }),
    );
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

  it("does not retry after the stage is left during Refresh", async () => {
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
    render(<ShareFlowHarness />);

    await user.click(
      await screen.findByRole("button", { name: "Create review link" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Refresh mix" }),
    );
    await user.click(screen.getByRole("button", { name: "Leave Deliver" }));
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
    render(<ShareFlowHarness />);

    await user.click(
      await screen.findByRole("button", { name: "Create review link" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Refresh mix" }),
    );
    useDawStore.setState({ projectEpoch: 3 });
    expect(screen.queryByRole("button", { name: "Refresh mix" })).toBeNull();
    finishRefresh({ status: "ok" });
    expect(createHostShare).toHaveBeenCalledTimes(1);
  });

  it("keeps the Create review link label and reports clipboard errors after mint", async () => {
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
    render(<ShareFlowHarness />);
    await screen.findByText("No review links yet.");
    expect(
      screen.getByRole("button", { name: "Create review link" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create review link" }));
    expect(await screen.findByText("Clipboard unavailable")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Create review link" }),
    ).toBeTruthy();
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Review link created",
    );
  });

  it("flashes Copied on the copy button after Copy link", async () => {
    const user = userEvent.setup();
    listHostShares.mockResolvedValue(listed([liveRow]));
    render(<ShareFlowHarness />);
    await user.click(await screen.findByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(useDawStore.getState().statusAnnouncement).toBe("Link copied");
  });

  it("copies the MCP URL for MCP shares", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    listHostShares.mockResolvedValue(listed([mcpRow]));
    render(<ShareFlowHarness />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy MCP URL" }),
    );
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(mcpRow.mcp_url);
    });
    expect(
      await screen.findByRole("button", { name: "Copied MCP URL" }),
    ).toBeTruthy();
    expect(useDawStore.getState().statusAnnouncement).toBe("MCP URL copied");
  });

  it("lists live rows and is axe-clean", async () => {
    listHostShares.mockResolvedValue(listed([liveRow, mcpRow]));
    const { baseElement: container } = render(<ShareFlowHarness />);
    expect(await screen.findByText("fantastic-acoustic-whale")).toBeTruthy();
    expect(await screen.findByText("editor-mcp-narwhal")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy MCP URL" })).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("revokes a live share after the in-place confirm, never a native one", async () => {
    const user = userEvent.setup();
    const nativeConfirm = vi.spyOn(window, "confirm");
    listHostShares.mockResolvedValue(listed([liveRow]));
    revokeHostShare.mockResolvedValue(undefined);
    render(<ShareFlowHarness />);
    expect(await screen.findByText("fantastic-acoustic-whale")).toBeTruthy();
    listHostShares.mockResolvedValue(
      listed([{ ...liveRow, usable: false, revoked: true }]),
    );
    await user.click(screen.getByRole("button", { name: "Stop sharing" }));
    expect(revokeHostShare).not.toHaveBeenCalled();
    await user.click(
      within(
        screen.getByRole("group", {
          name: "Stop sharing this Commenter link? Anyone using it loses access.",
        }),
      ).getByRole("button", { name: "Stop sharing" }),
    );
    await waitFor(() => {
      expect(revokeHostShare).toHaveBeenCalledWith(
        "/tmp/ep.project.json",
        "fantastic-acoustic-whale",
      );
    });
    expect(await screen.findByText("No review links yet.")).toBeTruthy();
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Stopped sharing the Commenter link",
    );
    expect(nativeConfirm).not.toHaveBeenCalled();
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
    const { baseElement: container } = render(<ShareFlowHarness />);
    await screen.findByRole("heading", { name: "Record rooms" });
    fireEvent.click(
      screen.getByRole("button", { name: "Create record links" }),
    );
    await waitFor(() => {
      expect(createHostRecordRoom).toHaveBeenCalledWith("/tmp/ep.project.json");
    });
    expect(await screen.findByText("Guest link")).toBeTruthy();
    expect(screen.getByText("Producer link")).toBeTruthy();
    expect(
      await screen.findAllByRole("button", { name: "Copied guest link" }),
    ).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Copy producer link" }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "End room" }),
      ).not.toBeDisabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "End room" }));
    expect(revokeHostRoom).not.toHaveBeenCalled();
    fireEvent.click(
      within(
        screen.getByRole("group", {
          name: "End this record room? Both guest and producer links will stop working.",
        }),
      ).getByRole("button", { name: "End room" }),
    );
    await waitFor(() => {
      expect(revokeHostRoom).toHaveBeenCalledWith(
        "/tmp/ep.project.json",
        "sess1",
      );
    });
    expect(await screen.findByText("No record rooms yet.")).toBeTruthy();
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
    render(<ShareFlowHarness />);
    await screen.findByRole("heading", { name: "Record rooms" });
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
    const { registerDawCommands } = await import("../../commands/register");
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
    setChrome({ recordPanelOpen: false });
    render(<ShareFlowHarness />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Open room panel" }),
    );
    expect(useDawStore.getState().chrome.recordPanelOpen).toBe(true);
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
    render(<ShareFlowHarness />);

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
    render(<ShareFlowHarness />);
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
    render(<ShareFlowHarness />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Replace guest invite" }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(replacement.url),
    );

    fireEvent.click(screen.getByRole("button", { name: "Leave Deliver" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to Deliver" }));
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

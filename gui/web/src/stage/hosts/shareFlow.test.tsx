import { act, render, waitFor } from "@testing-library/react";
import { StrictMode, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LISTEN_CHOICES,
  SHARE_DEFAULTS,
} from "../../stages/deliver/shareLogic";
import { useDawStore } from "../../state/dawStore";
import type { HostShareRow } from "../../types/shares";
import { ApiError } from "../../utils/apiError";
import { ShareFlowProvider } from "./shareFlow";
import { type ShareFlow, useShareFlow } from "./shareFlowContext";

const listHostShares = vi.fn();
const createHostShare = vi.fn();
const revokeHostShare = vi.fn();
const createHostRecordRoom = vi.fn();
const revokeHostRoom = vi.fn();
const restoreHostShare = vi.fn();
const restoreHostRoom = vi.fn();
const replaceHostRecordInvite = vi.fn();
const execute = vi.fn();

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

vi.mock("../../api", async () => ({
  restoreRefusal: (
    await vi.importActual<typeof import("../../api/sharesRecord")>(
      "../../api/sharesRecord",
    )
  ).restoreRefusal,
  restoreHostShare: (...args: unknown[]) => restoreHostShare(...args),
  restoreHostRoom: (...args: unknown[]) => restoreHostRoom(...args),
  listHostShares: (...args: unknown[]) => listHostShares(...args),
  createHostShare: (...args: unknown[]) => createHostShare(...args),
  revokeHostShare: (...args: unknown[]) => revokeHostShare(...args),
  createHostRecordRoom: (...args: unknown[]) => createHostRecordRoom(...args),
  revokeHostRoom: (...args: unknown[]) => revokeHostRoom(...args),
  replaceHostRecordInvite: (...args: unknown[]) =>
    replaceHostRecordInvite(...args),
}));

const PATH = "/tmp/ep.project.json";
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
};
const mcpRow: HostShareRow = {
  ...liveRow,
  token: "editor-mcp-narwhal",
  url: "http://127.0.0.1:8765/r/editor-mcp-narwhal",
  docs_role: "editor",
  mcp_url: "http://127.0.0.1:8765/mcp/editor-mcp-narwhal/mcp",
};
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

const listed = (shares: HostShareRow[] = []) => ({
  shares,
  public_origin: "http://127.0.0.1:8765",
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value,
  });
}

let flow: ShareFlow;
function Probe() {
  const value = useShareFlow();
  useLayoutEffect(() => {
    flow = value;
  });
  return null;
}

function mount(strict = false) {
  const tree = (
    <ShareFlowProvider>
      <Probe />
    </ShareFlowProvider>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

const announcement = () => useDawStore.getState().statusAnnouncement;
const toast = () => useDawStore.getState().feedbackToast;
const WINDOW = { restorableUntil: "2026-11-11T10:00:10Z", restoreMs: 10_000 };
const FINAL = { restorableUntil: null, restoreMs: null };
const refusal = (status: number, code: string) =>
  new ApiError(code, code, status);
const leaveDeliver = () => act(() => useDawStore.setState({ stage: "edit" }));
const enterDeliver = () =>
  act(() => useDawStore.setState({ stage: "deliver" }));

beforeEach(() => {
  listHostShares.mockReset().mockResolvedValue(listed());
  createHostShare.mockReset();
  revokeHostShare.mockReset();
  createHostRecordRoom.mockReset();
  revokeHostRoom.mockReset();
  restoreHostShare.mockReset().mockResolvedValue(undefined);
  restoreHostRoom.mockReset().mockResolvedValue(undefined);
  replaceHostRecordInvite.mockReset();
  execute.mockReset().mockResolvedValue({ status: "ok" });
  setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
  useDawStore.setState({
    projectEpoch: 1,
    projectPath: PATH,
    project: projectStub,
    stage: "deliver",
    statusAnnouncement: "",
    feedbackToast: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("listing", () => {
  it("starts empty and not loaded, then lists the project's links", async () => {
    listHostShares.mockResolvedValue(listed([liveRow]));
    mount();
    expect(flow.rows).toEqual([]);
    expect(flow.loaded).toBe(false);
    act(() => flow.reload());
    await waitFor(() => expect(flow.rows).toEqual([liveRow]));
    expect(flow.loaded).toBe(true);
    expect(listHostShares).toHaveBeenCalledWith(PATH);
  });

  it("lists once per reload, also under StrictMode replay", async () => {
    listHostShares.mockResolvedValue(listed([liveRow]));
    mount(true);
    act(() => flow.reload());
    await waitFor(() => expect(flow.rows).toHaveLength(1));
    expect(listHostShares).toHaveBeenCalledTimes(1);
  });

  it("shows a list error", async () => {
    listHostShares.mockRejectedValue(new Error("List failed"));
    mount();
    act(() => flow.reload());
    await waitFor(() => expect(flow.error).toBe("List failed"));
    expect(flow.loaded).toBe(false);
    expect(flow.listFailed).toBe(true);
  });

  it("clears a list error when a later list answers", async () => {
    listHostShares.mockRejectedValueOnce(new Error("List failed"));
    mount();
    act(() => flow.reload());
    await waitFor(() => expect(flow.error).toBe("List failed"));
    act(() => flow.reload());
    await waitFor(() => expect(flow.loaded).toBe(true));
    expect(flow.error).toBeNull();
    expect(flow.listFailed).toBe(false);
  });

  it("drops a list error and a list from an obsolete project generation", async () => {
    const old = deferred<ReturnType<typeof listed>>();
    listHostShares.mockReturnValueOnce(old.promise);
    mount();
    act(() => flow.reload());
    await waitFor(() => expect(listHostShares).toHaveBeenCalledTimes(1));
    act(() => useDawStore.setState({ projectEpoch: 2 }));
    await act(async () => {
      old.reject(new Error("Obsolete list failed"));
      await old.promise.catch(() => undefined);
    });
    expect(flow.error).toBeNull();
    expect(flow.loaded).toBe(false);
  });

  it("does not list a project that is not open on Deliver", async () => {
    mount();
    leaveDeliver();
    act(() => flow.reload());
    expect(listHostShares).not.toHaveBeenCalled();
  });

  it("keeps the last listed links when Deliver is left, and forgets them for another project", async () => {
    listHostShares.mockResolvedValue(listed([liveRow]));
    mount();
    act(() => flow.reload());
    await waitFor(() => expect(flow.rows).toHaveLength(1));
    leaveDeliver();
    enterDeliver();
    expect(flow.rows).toHaveLength(1);
    expect(flow.loaded).toBe(true);
    act(() =>
      useDawStore.setState({
        projectPath: "/tmp/other.project.json",
        projectEpoch: 2,
      }),
    );
    expect(flow.rows).toEqual([]);
    expect(flow.loaded).toBe(false);
  });
});

describe("creating a link", () => {
  it("sends the choices, copies the link, lists it and announces both", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    createHostShare.mockResolvedValue(liveRow);
    listHostShares.mockResolvedValue(listed([liveRow]));
    mount();
    act(() => flow.create());
    await waitFor(() => expect(flow.copiedKey).toBe(`link:${liveRow.token}`));
    expect(createHostShare).toHaveBeenCalledWith(PATH, {
      role: "commenter",
      with_mcp: false,
    });
    expect(writeText).toHaveBeenCalledWith(liveRow.url);
    expect(announcement()).toBe("Review link created and copied");
    await waitFor(() => expect(flow.rows).toEqual([liveRow]));
    await waitFor(() => expect(flow.busy).toBe(false));
  });

  it("makes the listen link from the override, not from the choices, and names it", async () => {
    createHostShare.mockResolvedValue(liveRow);
    mount();
    act(() =>
      flow.setChoices({ role: "editor", withMcp: true, freeze: false }),
    );
    act(() => flow.create(LISTEN_CHOICES));
    await waitFor(() => expect(flow.copiedKey).toBe(`link:${liveRow.token}`));
    expect(createHostShare).toHaveBeenCalledWith(PATH, {
      role: "viewer",
      with_mcp: false,
      freeze: true,
    });
    expect(announcement()).toBe("Listen link created and copied");
  });

  it("remembers which create needs Refresh mix, and retries a listen link as itself", async () => {
    const stale = () => new ApiError("stale", "stale_mix", 409);
    createHostShare.mockRejectedValueOnce(stale()).mockResolvedValue(liveRow);
    mount();
    act(() =>
      flow.setChoices({ role: "editor", withMcp: false, freeze: false }),
    );
    act(() => flow.create(LISTEN_CHOICES));
    await waitFor(() => expect(flow.recovery.kind).toBe("needs_refresh"));
    expect(flow.refreshFor).toEqual({ choices: LISTEN_CHOICES, listen: true });
    act(() => flow.refreshMix());
    await waitFor(() => expect(createHostShare).toHaveBeenCalledTimes(2));
    expect(createHostShare).toHaveBeenLastCalledWith(PATH, {
      role: "viewer",
      with_mcp: false,
      freeze: true,
    });
  });

  it("sends the role, MCP and freeze the person chose", async () => {
    createHostShare.mockResolvedValue(liveRow);
    mount();
    act(() => flow.setChoices({ role: "editor", withMcp: true, freeze: true }));
    act(() => flow.create());
    await waitFor(() => expect(createHostShare).toHaveBeenCalled());
    expect(createHostShare).toHaveBeenCalledWith(PATH, {
      role: "editor",
      with_mcp: true,
      freeze: true,
    });
  });

  it("starts the copy inside the click, before the link exists", async () => {
    class FakeItem {
      readonly items: Record<string, Promise<Blob>>;
      constructor(items: Record<string, Promise<Blob>>) {
        this.items = items;
      }
    }
    vi.stubGlobal("ClipboardItem", FakeItem);
    const write = vi.fn().mockResolvedValue(undefined);
    setClipboard({ write, writeText: vi.fn() });
    const minted = deferred<HostShareRow>();
    createHostShare.mockReturnValue(minted.promise);
    mount();
    act(() => flow.create());
    // Both are called synchronously by the click, with no link yet.
    expect(createHostShare).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    await act(async () => minted.resolve(liveRow));
    const item = write.mock.calls[0][0][0] as FakeItem;
    expect(await (await item.items["text/plain"]).text()).toBe(liveRow.url);
    await waitFor(() =>
      expect(announcement()).toBe("Review link created and copied"),
    );
  });

  it("writes nothing to the clipboard when Deliver is left before the link arrives", async () => {
    class FakeItem {
      readonly items: Record<string, Promise<Blob>>;
      constructor(items: Record<string, Promise<Blob>>) {
        this.items = items;
      }
    }
    vi.stubGlobal("ClipboardItem", FakeItem);
    const write = vi.fn().mockResolvedValue(undefined);
    setClipboard({ write, writeText: vi.fn() });
    const minted = deferred<HostShareRow>();
    createHostShare.mockReturnValue(minted.promise);
    mount();
    act(() => flow.create());
    const item = write.mock.calls[0][0][0] as FakeItem;
    const refused = expect(item.items["text/plain"]).rejects.toThrow();
    leaveDeliver();
    await act(async () => minted.resolve(liveRow));
    await refused;
  });

  it("keeps the link and asks for a copy by hand when the browser refuses, without a raw error", async () => {
    setClipboard({
      writeText: vi.fn().mockRejectedValue(new Error("Clipboard unavailable")),
    });
    createHostShare.mockResolvedValue(liveRow);
    listHostShares.mockResolvedValue(listed([liveRow]));
    mount();
    act(() => flow.create());
    await waitFor(() => expect(flow.blockedKey).toBe(`link:${liveRow.token}`));
    expect(flow.copiedKey).toBeNull();
    expect(flow.error).toBeNull();
    expect(announcement()).toMatch(
      /^Review link created\. Your browser would not copy it/,
    );
    await waitFor(() => expect(flow.rows).toEqual([liveRow]));
  });

  it("says only that it was created when the link has no address", async () => {
    createHostShare.mockResolvedValue({ ...liveRow, url: null });
    mount();
    act(() => flow.create());
    await waitFor(() => expect(announcement()).toBe("Review link created"));
    expect(flow.copiedKey).toBeNull();
    expect(flow.blockedKey).toBeNull();
  });

  it("clears Copied after 2 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    createHostShare.mockResolvedValue(liveRow);
    mount();
    act(() => flow.create());
    await waitFor(() => expect(flow.copiedKey).not.toBeNull());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(flow.copiedKey).toBeNull();
  });

  it("tells the host when the bucket has no CORS rule for the share origin", async () => {
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
    listHostShares.mockResolvedValue(listed([liveRow]));
    mount();
    act(() => flow.create());
    await waitFor(() =>
      expect(flow.error).toMatch(/no CORS rule for https:\/\/sharecut\.studio/),
    );
    expect(flow.rows).toEqual([liveRow]);
  });

  it("shows a plain error for any other refusal", async () => {
    createHostShare.mockRejectedValue(new ApiError("Nope", "other", 500));
    mount();
    act(() => flow.create());
    await waitFor(() => expect(flow.error).toBe("Nope"));
    expect(flow.recovery).toEqual({ kind: "idle" });
    expect(flow.busy).toBe(false);
  });

  it("does one thing at a time", async () => {
    const first = deferred<HostShareRow>();
    createHostShare.mockReturnValueOnce(first.promise);
    mount();
    act(() => flow.create());
    expect(flow.busy).toBe(true);
    act(() => flow.create());
    act(() => flow.createRecord());
    act(() => flow.stop("x"));
    expect(createHostShare).toHaveBeenCalledOnce();
    expect(createHostRecordRoom).not.toHaveBeenCalled();
    expect(revokeHostShare).not.toHaveBeenCalled();
    await act(async () => first.resolve(liveRow));
    await waitFor(() => expect(flow.busy).toBe(false));
  });

  it("ignores a create completion after the project is left", async () => {
    const minted = deferred<HostShareRow>();
    createHostShare.mockReturnValue(minted.promise);
    const view = mount();
    act(() => flow.create());
    view.unmount();
    await act(async () => {
      minted.resolve(liveRow);
      await minted.promise;
    });
    expect(announcement()).toBe("");
    expect(listHostShares).not.toHaveBeenCalled();
  });

  it("lists the new link when Deliver was left and re-entered before it arrived", async () => {
    const minted = deferred<HostShareRow>();
    createHostShare.mockReturnValue(minted.promise);
    mount();
    act(() => flow.create());
    leaveDeliver();
    enterDeliver();
    listHostShares.mockResolvedValue(listed([liveRow]));
    await act(async () => minted.resolve(liveRow));
    await waitFor(() => expect(flow.rows).toEqual([liveRow]));
  });

  it("ignores a create completion after Deliver is left", async () => {
    const minted = deferred<HostShareRow>();
    createHostShare.mockReturnValue(minted.promise);
    mount();
    act(() => flow.create());
    leaveDeliver();
    await act(async () => {
      minted.resolve(liveRow);
      await minted.promise;
    });
    expect(announcement()).toBe("");
    expect(listHostShares).not.toHaveBeenCalled();
    expect(flow.busy).toBe(false);
  });

  it("keeps a reopened create busy when the earlier create resolves", async () => {
    const old = deferred<HostShareRow>();
    const next = deferred<HostShareRow>();
    createHostShare
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(next.promise);
    mount();
    act(() => flow.create());
    leaveDeliver();
    enterDeliver();
    act(() => flow.create());
    expect(createHostShare).toHaveBeenCalledTimes(2);
    await act(async () => old.resolve(liveRow));
    expect(flow.busy).toBe(true);
    await act(async () => next.resolve(liveRow));
    await waitFor(() => expect(flow.busy).toBe(false));
  });

  it("does not create when Deliver is not showing", async () => {
    mount();
    leaveDeliver();
    act(() => flow.create());
    expect(createHostShare).not.toHaveBeenCalled();
  });
});

describe("create recovery", () => {
  const stale = () =>
    new ApiError(
      "premix.wav is stale; render-preview provenance mismatch",
      "stale_mix",
      409,
    );

  it("waits for Refresh to succeed, then retries once with the choices now shown", async () => {
    const refresh = deferred<{ status: "ok" }>();
    execute.mockReturnValue(refresh.promise);
    createHostShare
      .mockRejectedValueOnce(stale())
      .mockResolvedValueOnce(liveRow);
    listHostShares.mockResolvedValue(listed([liveRow]));
    mount();
    act(() =>
      flow.setChoices({ role: "viewer", withMcp: false, freeze: true }),
    );
    act(() => flow.create());
    await waitFor(() => expect(flow.recovery.kind).toBe("needs_refresh"));
    expect(flow.recovery).toEqual({
      kind: "needs_refresh",
      message:
        "The mix preview is out of date. Refresh it before creating a review link.",
      refreshError: null,
    });
    expect(flow.error).toBeNull();
    act(() =>
      flow.setChoices({ role: "editor", withMcp: true, freeze: false }),
    );
    act(() => flow.refreshMix());
    expect(execute).toHaveBeenCalledWith("render.refreshMix");
    expect(flow.recovery).toEqual({ kind: "refreshing" });
    expect(createHostShare).toHaveBeenCalledTimes(1);
    refresh.resolve({ status: "ok" });
    await waitFor(() => expect(createHostShare).toHaveBeenCalledTimes(2));
    expect(createHostShare).toHaveBeenNthCalledWith(2, PATH, {
      role: "editor",
      with_mcp: true,
    });
    await waitFor(() => expect(flow.rows).toEqual([liveRow]));
    expect(flow.recovery).toEqual({ kind: "idle" });
  });

  it("pairs a project with no mix with Refresh mix", async () => {
    createHostShare
      .mockRejectedValueOnce(new ApiError("no mix", "no_mix", 409))
      .mockResolvedValueOnce(liveRow);
    mount();
    act(() => flow.create());
    await waitFor(() =>
      expect(flow.recovery).toMatchObject({
        kind: "needs_refresh",
        message:
          "This project has no mix yet. Refresh the mix to create the link.",
      }),
    );
    act(() => flow.refreshMix());
    await waitFor(() => expect(createHostShare).toHaveBeenCalledTimes(2));
  });

  it("keeps Refresh available and does not create when Refresh is refused", async () => {
    createHostShare.mockRejectedValue(stale());
    execute.mockResolvedValue({ status: "disabled", reason: "Render failed" });
    mount();
    act(() => flow.create());
    await waitFor(() => expect(flow.recovery.kind).toBe("needs_refresh"));
    act(() => flow.refreshMix());
    await waitFor(() =>
      expect(flow.recovery).toMatchObject({
        kind: "needs_refresh",
        refreshError: "Render failed",
      }),
    );
    expect(createHostShare).toHaveBeenCalledTimes(1);
    expect(flow.busy).toBe(false);
  });

  it("shows a Refresh that throws", async () => {
    createHostShare.mockRejectedValue(stale());
    execute.mockRejectedValue(new Error("Boom"));
    mount();
    act(() => flow.create());
    await waitFor(() => expect(flow.recovery.kind).toBe("needs_refresh"));
    act(() => flow.refreshMix());
    await waitFor(() =>
      expect(flow.recovery).toMatchObject({ refreshError: "Boom" }),
    );
  });

  it("names a Refresh that is not available at all", async () => {
    createHostShare.mockRejectedValue(stale());
    execute.mockResolvedValue({ status: "unknown" });
    mount();
    act(() => flow.create());
    await waitFor(() => expect(flow.recovery.kind).toBe("needs_refresh"));
    act(() => flow.refreshMix());
    await waitFor(() =>
      expect(flow.recovery).toMatchObject({
        refreshError: "Refresh mix is unavailable",
      }),
    );
  });

  it("does not offer Refresh for a stale master", async () => {
    createHostShare.mockRejectedValue(
      new ApiError("master_loudness mismatch", "stale_master", 409),
    );
    mount();
    act(() => flow.create());
    await waitFor(() =>
      expect(flow.error).toBe(
        "The mastered mix is out of date. Export a new master before creating a review link.",
      ),
    );
    expect(flow.recovery).toEqual({ kind: "idle" });
    act(() => flow.refreshMix());
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns a repeated stale response to explicit recovery without looping", async () => {
    createHostShare
      .mockRejectedValueOnce(stale())
      .mockRejectedValueOnce(stale());
    mount();
    act(() => flow.create());
    await waitFor(() => expect(flow.recovery.kind).toBe("needs_refresh"));
    act(() => flow.refreshMix());
    await waitFor(() => expect(createHostShare).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(flow.recovery.kind).toBe("needs_refresh"));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(flow.busy).toBe(false);
  });

  it("holds a second Refresh while one runs", async () => {
    execute.mockReturnValue(new Promise(() => undefined));
    createHostShare.mockRejectedValue(stale());
    mount();
    act(() => flow.create());
    await waitFor(() => expect(flow.recovery.kind).toBe("needs_refresh"));
    act(() => flow.refreshMix());
    act(() => flow.refreshMix());
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not retry if the project changes while Refresh is running", async () => {
    const refresh = deferred<{ status: "ok" }>();
    execute.mockReturnValue(refresh.promise);
    createHostShare.mockRejectedValue(stale());
    mount();
    act(() => flow.create());
    await waitFor(() => expect(flow.recovery.kind).toBe("needs_refresh"));
    act(() => flow.refreshMix());
    act(() =>
      useDawStore.setState({
        projectPath: "/tmp/other.project.json",
        projectEpoch: 2,
      }),
    );
    expect(flow.recovery).toEqual({ kind: "idle" });
    refresh.resolve({ status: "ok" });
    await act(async () => {
      await refresh.promise;
    });
    expect(createHostShare).toHaveBeenCalledTimes(1);
    expect(flow.busy).toBe(false);
  });

  it("does not retry after Deliver is left during Refresh", async () => {
    const refresh = deferred<{ status: "ok" }>();
    execute.mockReturnValue(refresh.promise);
    createHostShare.mockRejectedValue(stale());
    mount();
    act(() => flow.create());
    await waitFor(() => expect(flow.recovery.kind).toBe("needs_refresh"));
    act(() => flow.refreshMix());
    leaveDeliver();
    refresh.resolve({ status: "ok" });
    await act(async () => {
      await refresh.promise;
    });
    expect(createHostShare).toHaveBeenCalledTimes(1);
    expect(flow.recovery).toEqual({ kind: "idle" });
  });

  it("invalidates recovery when the project is reopened at the same path", async () => {
    const refresh = deferred<{ status: "ok" }>();
    execute.mockReturnValue(refresh.promise);
    createHostShare.mockRejectedValue(stale());
    mount();
    act(() => flow.create());
    await waitFor(() => expect(flow.recovery.kind).toBe("needs_refresh"));
    act(() => flow.refreshMix());
    act(() => useDawStore.setState({ projectEpoch: 3 }));
    expect(flow.recovery).toEqual({ kind: "idle" });
    refresh.resolve({ status: "ok" });
    await act(async () => {
      await refresh.promise;
    });
    expect(createHostShare).toHaveBeenCalledTimes(1);
  });

  it("keeps a reopened refresh busy when the earlier refresh resolves", async () => {
    const old = deferred<{ status: "ok" }>();
    const next = deferred<{ status: "disabled"; reason: string }>();
    execute.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    createHostShare.mockRejectedValue(stale());
    mount();
    act(() => flow.create());
    await waitFor(() => expect(flow.recovery.kind).toBe("needs_refresh"));
    act(() => flow.refreshMix());
    leaveDeliver();
    enterDeliver();
    act(() => flow.create());
    await waitFor(() => expect(flow.recovery.kind).toBe("needs_refresh"));
    act(() => flow.refreshMix());
    await act(async () => old.resolve({ status: "ok" }));
    expect(flow.busy).toBe(true);
    await act(async () => next.resolve({ status: "disabled", reason: "Nope" }));
    await waitFor(() => expect(flow.busy).toBe(false));
  });

  it("resets the choices and the recovery when Deliver is left", async () => {
    createHostShare.mockRejectedValue(stale());
    mount();
    act(() => flow.setChoices({ role: "editor", withMcp: true, freeze: true }));
    act(() => flow.create());
    await waitFor(() => expect(flow.recovery.kind).toBe("needs_refresh"));
    leaveDeliver();
    enterDeliver();
    expect(flow.recovery).toEqual({ kind: "idle" });
    expect(flow.choices).toEqual(SHARE_DEFAULTS);
    expect(flow.error).toBeNull();
    expect(flow.status).toBeNull();
  });
});

describe("where the links are on show", () => {
  it("keeps working over any stage while the Invite sheet is open, and starts over when both are left", async () => {
    createHostShare.mockResolvedValue(liveRow);
    mount();
    leaveDeliver();
    act(() => useDawStore.getState().openInvite());
    act(() => flow.create());
    await waitFor(() => expect(flow.copiedKey).toBe(`link:${liveRow.token}`));
    act(() =>
      flow.setChoices({ role: "editor", withMcp: false, freeze: false }),
    );
    act(() => useDawStore.getState().setOpenSheet(null));
    expect(flow.choices).toEqual(SHARE_DEFAULTS);
    expect(flow.copiedKey).toBeNull();
  });

  it("drops a result that arrives after the sheet closed on another stage", async () => {
    const minted = deferred<HostShareRow>();
    createHostShare.mockReturnValue(minted.promise);
    mount();
    leaveDeliver();
    act(() => useDawStore.getState().openInvite());
    act(() => flow.create());
    act(() => useDawStore.getState().setOpenSheet(null));
    await act(async () => minted.resolve(liveRow));
    expect(flow.copiedKey).toBeNull();
    expect(announcement()).toBe("");
  });
});

describe("copying a listed link", () => {
  it("copies the link, reads Copied and announces it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    mount();
    act(() => flow.copy("link", liveRow.token, "Link", liveRow.url));
    await waitFor(() => expect(flow.copiedKey).toBe(`link:${liveRow.token}`));
    expect(writeText).toHaveBeenCalledWith(liveRow.url);
    expect(announcement()).toBe("Link copied");
  });

  it("copies the MCP URL", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    mount();
    act(() => flow.copy("mcp", mcpRow.token, "MCP URL", mcpRow.mcp_url));
    await waitFor(() => expect(flow.copiedKey).toBe(`mcp:${mcpRow.token}`));
    expect(writeText).toHaveBeenCalledWith(mcpRow.mcp_url);
    expect(announcement()).toBe("MCP URL copied");
  });

  it("does nothing for a link with no address", async () => {
    const writeText = vi.fn();
    setClipboard({ writeText });
    mount();
    act(() => flow.copy("link", "t", "Link", null));
    expect(writeText).not.toHaveBeenCalled();
  });

  it("selects a listed review link for the keyboard when the browser refuses", async () => {
    listHostShares.mockResolvedValue(listed([liveRow]));
    setClipboard({
      writeText: vi.fn().mockRejectedValue(new Error("NotAllowedError")),
    });
    mount();
    act(() => flow.reload());
    await waitFor(() => expect(flow.rows).toHaveLength(1));
    act(() => flow.copy("link", liveRow.token, "Link", liveRow.url));
    await waitFor(() => expect(flow.blockedKey).toBe(`link:${liveRow.token}`));
    expect(flow.error).toBeNull();
    expect(flow.copiedKey).toBeNull();
  });

  it("shows the MCP URL in plain words when the browser refuses it", async () => {
    setClipboard({
      writeText: vi.fn().mockRejectedValue(new Error("NotAllowedError")),
    });
    mount();
    act(() => flow.copy("mcp", mcpRow.token, "MCP URL", mcpRow.mcp_url));
    await waitFor(() =>
      expect(flow.error).toBe(
        `Your browser would not copy the mcp url. Copy it by hand: ${mcpRow.mcp_url}`,
      ),
    );
    expect(flow.error).not.toMatch(/NotAllowedError/);
  });

  it("ignores a copy that finishes after the project changed", async () => {
    const clipboard = deferred<void>();
    const writeText = vi.fn(() => clipboard.promise);
    setClipboard({ writeText });
    mount();
    act(() => flow.copy("link", liveRow.token, "Link", liveRow.url));
    act(() => useDawStore.setState({ projectEpoch: 2 }));
    await act(async () => {
      clipboard.resolve();
      await clipboard.promise;
    });
    expect(flow.copiedKey).toBeNull();
    expect(announcement()).toBe("");
  });
});

describe("stopping a link", () => {
  it("stops the link at once, asks the server for a window, and offers Undo for it", async () => {
    listHostShares
      .mockResolvedValueOnce(listed([liveRow]))
      .mockResolvedValue(
        listed([{ ...liveRow, usable: false, revoked: true }]),
      );
    revokeHostShare.mockResolvedValue(WINDOW);
    mount();
    act(() => flow.reload());
    await waitFor(() => expect(flow.rows).toHaveLength(1));
    act(() => flow.stop(liveRow.token));
    await waitFor(() =>
      expect(revokeHostShare).toHaveBeenCalledWith(PATH, liveRow.token, {
        restorable: true,
      }),
    );
    await waitFor(() => expect(announcement()).toBe("Link stopped."));
    expect(toast()?.reverse).not.toBeNull();
    expect(toast()?.dwellMs).toBe(9500);
    await waitFor(() => expect(flow.rows[0].usable).toBe(false));
  });

  it("restores the link on Undo and lists again", async () => {
    revokeHostShare.mockResolvedValue(WINDOW);
    mount();
    act(() => flow.stop(liveRow.token));
    await waitFor(() => expect(toast()?.reverse).not.toBeNull());
    listHostShares.mockClear();
    await expect(toast()?.reverse?.run()).resolves.toBe(true);
    expect(restoreHostShare).toHaveBeenCalledWith(PATH, liveRow.token);
    expect(toast()?.reverse?.done).toBe("Link restored.");
    expect(listHostShares).toHaveBeenCalledOnce();
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
  ])(
    "answers a refused Undo (%s) in plain words",
    async (code, status, message) => {
      revokeHostShare.mockResolvedValue(WINDOW);
      restoreHostShare.mockRejectedValue(refusal(status, code));
      mount();
      act(() => flow.stop(liveRow.token));
      await waitFor(() => expect(toast()?.reverse).not.toBeNull());
      await expect(toast()?.reverse?.run()).resolves.toBe(message);
    },
  );

  it("lets a failure that is not a refusal surface as an Undo failure", async () => {
    revokeHostShare.mockResolvedValue(WINDOW);
    restoreHostShare.mockRejectedValue(new Error("offline"));
    mount();
    act(() => flow.stop(liveRow.token));
    await waitFor(() => expect(toast()?.reverse).not.toBeNull());
    await expect(toast()?.reverse?.run()).rejects.toThrow("offline");
  });

  it("offers no Undo when the server gave no window", async () => {
    revokeHostShare.mockResolvedValue(FINAL);
    mount();
    act(() => flow.stop(liveRow.token));
    await waitFor(() => expect(announcement()).toBe("Link stopped."));
    expect(toast()?.reverse).toBeNull();
  });

  it("offers no Undo when the window is already inside the safety margin", async () => {
    revokeHostShare.mockResolvedValue({ ...WINDOW, restoreMs: 400 });
    mount();
    act(() => flow.stop(liveRow.token));
    await waitFor(() => expect(announcement()).toBe("Link stopped."));
    expect(toast()?.reverse).toBeNull();
  });

  it("replaces the earlier toast: only the latest stop stays undoable", async () => {
    revokeHostShare.mockResolvedValue(WINDOW);
    mount();
    act(() => flow.stop("first"));
    await waitFor(() => expect(toast()?.reverse).not.toBeNull());
    const first = toast()?.id;
    await waitFor(() => expect(flow.busy).toBe(false));
    act(() => flow.stop("second"));
    await waitFor(() => expect(toast()?.id).not.toBe(first));
    await toast()?.reverse?.run();
    expect(restoreHostShare).toHaveBeenCalledExactlyOnceWith(PATH, "second");
  });

  it("shows a refusal and stays usable", async () => {
    revokeHostShare.mockRejectedValue(new Error("Could not stop"));
    mount();
    act(() => flow.stop("x"));
    await waitFor(() => expect(flow.error).toBe("Could not stop"));
    expect(flow.busy).toBe(false);
    expect(toast()).toBeNull();
  });
});

describe("record rooms", () => {
  const room = {
    session_id: "sess1",
    guest: guestRow,
    producer: producerRow,
    linksStale: false,
  };

  it("creates the room, copies the guest link and lists it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    createHostRecordRoom.mockResolvedValue(room);
    listHostShares.mockResolvedValue(listed([guestRow, producerRow]));
    mount();
    act(() => flow.createRecord());
    await waitFor(() => expect(flow.copiedKey).toBe(`link:${guestRow.token}`));
    expect(createHostRecordRoom).toHaveBeenCalledWith(PATH);
    expect(writeText).toHaveBeenCalledWith(guestRow.url);
    expect(announcement()).toBe("Record links created and guest link copied");
    await waitFor(() => expect(flow.rows).toHaveLength(2));
  });

  it("keeps and lists a room whose earlier links could not all be revoked, and says so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    createHostRecordRoom.mockResolvedValue({
      ...room,
      linksStale: true,
    });
    listHostShares.mockResolvedValue(listed([guestRow, producerRow]));
    mount();
    act(() => flow.createRecord());
    await waitFor(() => expect(flow.copiedKey).toBe(`link:${guestRow.token}`));
    await waitFor(() => expect(flow.rows).toHaveLength(2));
    expect(writeText).toHaveBeenCalledWith(guestRow.url);
    await waitFor(() =>
      expect(flow.error).toBe(
        "Your new room is ready. Links to an earlier room may still work. End the earlier room in Invite to turn them off.",
      ),
    );
  });

  it("says the room exists when the guest link could not be copied", async () => {
    setClipboard({
      writeText: vi.fn().mockRejectedValue(new Error("NotAllowedError")),
    });
    createHostRecordRoom.mockResolvedValue(room);
    mount();
    act(() => flow.createRecord());
    await waitFor(() => expect(announcement()).toBe("Record links created"));
    expect(flow.error).toBe(
      `Your browser would not copy the guest link. Use Copy guest link, or copy it by hand: ${guestRow.url}`,
    );
  });

  it("shows a refused room", async () => {
    createHostRecordRoom.mockRejectedValue(new Error("No room"));
    mount();
    act(() => flow.createRecord());
    await waitFor(() => expect(flow.error).toBe("No room"));
  });

  it("ends the room at once, lists again, and offers Undo for the server's window", async () => {
    listHostShares
      .mockResolvedValueOnce(listed([guestRow, producerRow]))
      .mockResolvedValue(listed([]));
    revokeHostRoom.mockResolvedValue(WINDOW);
    mount();
    act(() => flow.reload());
    await waitFor(() => expect(flow.rows).toHaveLength(2));
    act(() => flow.endRoom("sess1"));
    await waitFor(() =>
      expect(revokeHostRoom).toHaveBeenCalledWith(PATH, "sess1", {
        restorable: true,
      }),
    );
    await waitFor(() => expect(flow.rows).toEqual([]));
    expect(announcement()).toBe("Room ended.");
    expect(toast()?.dwellMs).toBe(9500);
  });

  it("restores the room on Undo", async () => {
    revokeHostRoom.mockResolvedValue(WINDOW);
    mount();
    act(() => flow.endRoom("sess1"));
    await waitFor(() => expect(toast()?.reverse).not.toBeNull());
    await expect(toast()?.reverse?.run()).resolves.toBe(true);
    expect(restoreHostRoom).toHaveBeenCalledWith(PATH, "sess1");
    expect(toast()?.reverse?.done).toBe("Room restored.");
  });

  it.each([
    [
      "record_room_conflict",
      409,
      "Another room is live, so this one stays ended.",
    ],
    ["restore_window_closed", 410, "Too late to undo."],
    [
      "record_room_not_found",
      404,
      "That room is already gone, so there is nothing to undo.",
    ],
  ])(
    "answers a refused room Undo (%s) in plain words",
    async (code, status, message) => {
      revokeHostRoom.mockResolvedValue(WINDOW);
      restoreHostRoom.mockRejectedValue(refusal(status, code));
      mount();
      act(() => flow.endRoom("sess1"));
      await waitFor(() => expect(toast()?.reverse).not.toBeNull());
      await expect(toast()?.reverse?.run()).resolves.toBe(message);
    },
  );

  it("releases a stale record operation after a same-path project reopen", async () => {
    let finishFirst!: (value: typeof room) => void;
    createHostRecordRoom
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(room);
    mount();
    act(() => flow.createRecord());
    expect(flow.busy).toBe(true);
    act(() => useDawStore.setState({ projectEpoch: 2 }));
    expect(flow.busy).toBe(false);
    await act(async () => finishFirst(room));
    act(() => flow.createRecord());
    await waitFor(() => expect(createHostRecordRoom).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(announcement()).toBe("Record links created and guest link copied"),
    );
  });

  it("replaces a closed guest invite, copies the new link and lists again", async () => {
    const closed = { ...guestRow, invite_closed: true };
    const replacement = {
      ...guestRow,
      token: "replacement-guest-token",
      url: "http://127.0.0.1:8765/rec/replacement-guest-token",
    };
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    listHostShares.mockResolvedValue(listed([closed, replacement]));
    replaceHostRecordInvite.mockResolvedValue(replacement);
    mount();
    act(() => flow.replaceInvite(closed.token));
    await waitFor(() =>
      expect(replaceHostRecordInvite).toHaveBeenCalledWith(PATH, closed.token),
    );
    await waitFor(() =>
      expect(flow.copiedKey).toBe(`link:${replacement.token}`),
    );
    expect(writeText).toHaveBeenCalledWith(replacement.url);
    expect(announcement()).toBe("Guest link replaced and copied");
    await waitFor(() => expect(flow.rows).toHaveLength(2));
  });

  it("names a replaced producer invite", async () => {
    replaceHostRecordInvite.mockResolvedValue({
      ...producerRow,
      token: "new-producer",
    });
    mount();
    act(() => flow.replaceInvite(producerRow.token));
    await waitFor(() =>
      expect(announcement()).toBe("Producer link replaced and copied"),
    );
  });

  it("ignores a replacement clipboard completion after the project changed", async () => {
    const replacement = { ...guestRow, token: "replacement-guest-token" };
    const clipboard = deferred<void>();
    const writeText = vi.fn(() => clipboard.promise);
    setClipboard({ writeText });
    replaceHostRecordInvite.mockResolvedValue(replacement);
    listHostShares.mockResolvedValue(listed([liveRow]));
    mount();
    act(() => flow.replaceInvite("closed-guest-token"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    act(() => useDawStore.setState({ projectEpoch: 2 }));
    await act(async () => {
      clipboard.resolve();
      await clipboard.promise;
    });
    expect(flow.copiedKey).toBeNull();
    expect(announcement()).not.toContain("replaced and copied");
    expect(listHostShares).not.toHaveBeenCalled();
  });

  it("ignores a replacement clipboard completion after Deliver is left and shown again", async () => {
    const replacement = { ...guestRow, token: "replacement-guest-token" };
    const clipboard = deferred<void>();
    const writeText = vi.fn(() => clipboard.promise);
    setClipboard({ writeText });
    replaceHostRecordInvite.mockResolvedValue(replacement);
    mount();
    act(() => flow.replaceInvite("closed-guest-token"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    leaveDeliver();
    enterDeliver();
    await act(async () => {
      clipboard.resolve();
      await clipboard.promise;
    });
    expect(flow.copiedKey).toBeNull();
    expect(announcement()).not.toContain("replaced and copied");
  });
});

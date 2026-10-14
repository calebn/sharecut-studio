import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { beginDocumentSend } from "../state/documentSendOrder";
import { minimalProject, offlineConflict } from "../test/fixtures";
import { ATTENTION_BANNER_ID } from "./GuestAttentionBannerView";
import { SaveStatePill } from "./SaveStatePill";

const offlineStore = vi.hoisted(() => ({
  clearConflicts: vi.fn(),
  clearHostConflicts: vi.fn(),
  loadConflicts: vi.fn(),
  loadCommandQueue: vi.fn(),
  loadHostCommandCount: vi.fn(),
  loadHostConflicts: vi.fn(),
}));
const drain = vi.hoisted(() => ({ requestHostDrain: vi.fn() }));

vi.mock("../state/offlineStore", () => offlineStore);
vi.mock("../state/drainOfflineQueue", () => drain);

const PATH = "/tmp/save-state-1448.json";

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("SaveStatePill", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const mock of [
      ...Object.values(offlineStore),
      ...Object.values(drain),
    ]) {
      mock.mockReset();
    }
    offlineStore.loadHostCommandCount.mockResolvedValue(0);
    offlineStore.loadHostConflicts.mockResolvedValue([]);
    offlineStore.loadConflicts.mockResolvedValue([]);
    offlineStore.loadCommandQueue.mockResolvedValue([]);
    drain.requestHostDrain.mockResolvedValue(undefined);
    useDawStore.getState().hydrate(PATH, minimalProject(), null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows nothing until the queue has been read, then Saved", async () => {
    const { container } = render(<SaveStatePill />);
    expect(container).toBeEmptyDOMElement();
    await settle();
    expect(screen.getByText("Saved to project")).toBeInTheDocument();
  });

  it("reads Saving while a send is in flight and Saved once it ends", async () => {
    render(<SaveStatePill />);
    await settle();
    let send!: ReturnType<typeof beginDocumentSend>;
    act(() => {
      send = beginDocumentSend(PATH, "cmd-1");
    });
    expect(screen.getByText("Saving to project…")).toBeInTheDocument();
    act(() => send.finish());
    await settle();
    expect(screen.getByText("Saved to project")).toBeInTheDocument();
  });

  it("reads the queue as soon as a send ends, not at the next poll", async () => {
    render(<SaveStatePill />);
    await settle();
    let send!: ReturnType<typeof beginDocumentSend>;
    act(() => {
      send = beginDocumentSend(PATH, "cmd-2");
    });
    offlineStore.loadHostCommandCount.mockResolvedValue(1);
    act(() => send.finish());
    await settle();
    expect(
      screen.getByRole("button", { name: "Not saved yet · 1 waiting to send" }),
    ).toBeInTheDocument();
  });

  it("offers Send now for queued edits and replays the queue", async () => {
    offlineStore.loadHostCommandCount.mockResolvedValue(2);
    render(<SaveStatePill />);
    await settle();
    fireEvent.click(
      screen.getByRole("button", { name: "Not saved yet · 2 waiting to send" }),
    );
    expect(drain.requestHostDrain).toHaveBeenCalledWith(PATH);
  });

  it("fails on a refused edit, names why, and moves focus to Needs attention", async () => {
    offlineStore.loadHostConflicts.mockResolvedValue([
      offlineConflict({ reason: "The clip moved" }),
    ]);
    const banner = document.createElement("div");
    banner.id = ATTENTION_BANNER_ID;
    banner.tabIndex = -1;
    document.body.append(banner);
    render(<SaveStatePill />);
    await settle();
    const pill = screen.getByRole("button", { name: "Save failed · See why" });
    expect(pill).toHaveAttribute("title", "The clip moved");
    fireEvent.click(pill);
    expect(banner).toHaveFocus();
    banner.remove();
  });

  it("retries reading unreadable saved edits", async () => {
    offlineStore.loadHostCommandCount.mockRejectedValueOnce(new Error("idb"));
    render(<SaveStatePill />);
    await settle();
    offlineStore.loadHostCommandCount.mockResolvedValue(0);
    fireEvent.click(
      screen.getByRole("button", { name: "Save failed · Retry" }),
    );
    await settle();
    expect(screen.getByText("Saved to project")).toBeInTheDocument();
  });

  it("shows nothing to a share guest and reads no host queue", async () => {
    useDawStore.getState().hydrate("share:tok-1448", minimalProject(), null);
    const { container } = render(<SaveStatePill />);
    await settle();
    expect(container).toBeEmptyDOMElement();
    expect(offlineStore.loadHostCommandCount).not.toHaveBeenCalled();
  });
});

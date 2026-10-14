import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { beginDocumentSend } from "../state/documentSendOrder";
import { minimalProject, offlineConflict } from "../test/fixtures";
import { GuestAttentionBanner } from "./GuestAttentionBanner";
import { ATTENTION_BANNER_ID } from "./GuestAttentionBannerView";
import { SaveStateDot } from "./SaveStateDot";

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

describe("SaveStateDot", () => {
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
    const { container } = render(<SaveStateDot />);
    expect(container).toBeEmptyDOMElement();
    await settle();
    expect(
      screen.getByRole("img", { name: "Saved to project" }),
    ).toBeInTheDocument();
  });

  it("reads Saving while a send is in flight and Saved once it ends", async () => {
    render(<SaveStateDot />);
    await settle();
    let send!: ReturnType<typeof beginDocumentSend>;
    act(() => {
      send = beginDocumentSend(PATH, "cmd-1");
    });
    expect(
      screen.getByRole("img", { name: "Saving to project…" }),
    ).toBeInTheDocument();
    act(() => send.finish());
    await settle();
    expect(
      screen.getByRole("img", { name: "Saved to project" }),
    ).toBeInTheDocument();
  });

  it("never reads Saved between a failed send and the queue read that follows it", async () => {
    render(<SaveStateDot />);
    await settle();
    let send!: ReturnType<typeof beginDocumentSend>;
    act(() => {
      send = beginDocumentSend(PATH, "cmd-late");
    });
    let release!: (count: number) => void;
    offlineStore.loadHostCommandCount.mockReturnValue(
      new Promise<number>((resolve) => {
        release = resolve;
      }),
    );
    act(() => send.finish());
    expect(
      screen.queryByRole("img", { name: "Saved to project" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Saving to project…" }),
    ).toBeInTheDocument();
    await settle(500);
    expect(
      screen.queryByRole("img", { name: "Saved to project" }),
    ).not.toBeInTheDocument();
    await act(async () => {
      release(1);
    });
    await settle();
    expect(
      screen.getByRole("button", { name: "Not saved yet · 1 waiting to send" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: "Saved to project" }),
    ).not.toBeInTheDocument();
  });

  it("reads the queue as soon as a send ends, not at the next poll", async () => {
    render(<SaveStateDot />);
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

  it("moves focus to Needs attention when a waiting dot is pressed", async () => {
    offlineStore.loadHostCommandCount.mockResolvedValue(2);
    const banner = document.createElement("div");
    banner.id = ATTENTION_BANNER_ID;
    banner.tabIndex = -1;
    document.body.append(banner);
    render(<SaveStateDot />);
    await settle();
    const dot = screen.getByRole("button", {
      name: "Not saved yet · 2 waiting to send",
    });
    expect(dot).toHaveAttribute("data-save-state", "waiting");
    expect(dot).toHaveAttribute("title", "Not saved yet · 2 waiting to send");
    fireEvent.click(dot);
    expect(banner).toHaveFocus();
    expect(drain.requestHostDrain).not.toHaveBeenCalled();
    banner.remove();
  });

  it("fails on a refused edit and the Needs attention banner gives the reason", async () => {
    offlineStore.loadHostConflicts.mockResolvedValue([
      offlineConflict({ reason: "The clip moved" }),
    ]);
    render(
      <>
        <SaveStateDot />
        <GuestAttentionBanner />
      </>,
    );
    await settle();
    const dot = screen.getByRole("button", { name: "Save failed" });
    expect(dot).toHaveAttribute("data-save-state", "failed");
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("The clip moved");
    fireEvent.click(dot);
    expect(banner).toHaveFocus();
  });

  it("fails on unreadable saved edits and the banner offers Retry", async () => {
    offlineStore.loadHostCommandCount.mockRejectedValueOnce(new Error("idb"));
    render(
      <>
        <SaveStateDot />
        <GuestAttentionBanner />
      </>,
    );
    await settle();
    expect(screen.getByRole("button", { name: "Save failed" })).toHaveAttribute(
      "data-save-state",
      "failed",
    );
    offlineStore.loadHostCommandCount.mockResolvedValue(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(
      screen.getByRole("img", { name: "Saved to project" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows nothing to a share guest and reads no host queue", async () => {
    useDawStore.getState().hydrate("share:tok-1448", minimalProject(), null);
    const { container } = render(<SaveStateDot />);
    await settle();
    expect(container).toBeEmptyDOMElement();
    expect(offlineStore.loadHostCommandCount).not.toHaveBeenCalled();
  });
});

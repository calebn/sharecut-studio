import { act, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuestRoomApp } from "./GuestRoomApp";
import type { BootOutcome, RecordBootstrap } from "./recordBootstrap";

type Pending = {
  signal: AbortSignal | undefined;
  resolve: (value: BootOutcome) => void;
  reject: (reason: unknown) => void;
};

const pending = vi.hoisted((): Pending[] => []);
vi.mock("./recordBootstrap", () => ({
  loadRecordBootstrap: vi.fn(
    (_token: string, signal?: AbortSignal) =>
      new Promise<BootOutcome>((resolve, reject) => {
        pending.push({ signal, resolve, reject });
      }),
  ),
}));

vi.mock("../desktop/useDesktopCloseGuard", () => ({
  useDesktopCloseGuard: vi.fn(),
}));

vi.mock("../services/offlineQueue/offlineStore", () => ({
  loadRecordParticipant: vi.fn(async () => undefined),
  saveRecordParticipant: vi.fn(async () => undefined),
  clearRecordParticipant: vi.fn(async () => undefined),
}));

const BOOTSTRAP = {
  mode: "record",
  kind: "record",
  token: "guest-tok",
  role: "guest",
  session_id: "room1",
  capabilities: ["join"],
  episode: { name: "Shot of Truth" },
  room: { recorded_cap: 4, producer_cap: 2 },
  build: { capture: false, monitor: false, upload: false },
  expires_at: null,
} as unknown as RecordBootstrap;

const connecting = () => screen.queryByText("Still connecting…");
const retry = () => screen.queryByRole("button", { name: "Retry" });
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("GuestRoomApp loading", () => {
  beforeEach(() => {
    pending.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal(
      "WebSocket",
      Object.assign(
        vi.fn(function () {
          return { close: vi.fn(), send: vi.fn(), readyState: 0 };
        }),
        { OPEN: 1, CONNECTING: 0, CLOSING: 2, CLOSED: 3 },
      ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders the Room shell at once, with no blank Loading studio screen", () => {
    const { container } = render(<GuestRoomApp token="guest-tok" />);
    expect(container.querySelector(".sys-room-view-grid")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(container.querySelectorAll(".sys-room-tile--skeleton")).toHaveLength(
      4,
    );
    expect(screen.queryByText("Loading studio…")).toBeNull();
    expect(connecting()).toBeNull();
  });

  it("offers Still connecting and Retry at 4 s and not before", async () => {
    render(<GuestRoomApp token="guest-tok" />);
    await tick(3999);
    expect(connecting()).toBeNull();
    expect(retry()).toBeNull();
    await tick(1);
    expect(connecting()).toBeInTheDocument();
    expect(retry()).toBeInTheDocument();
    expect(connecting()?.closest("[aria-busy]")).toBeNull();
    expect(retry()?.closest("[aria-busy]")).toBeNull();
  });

  it("Retry aborts the first lookup, runs a second and restarts the 4 s timer", async () => {
    render(<GuestRoomApp token="guest-tok" />);
    await tick(4000);
    act(() => retry()?.click());
    expect(pending).toHaveLength(2);
    expect(pending[0]?.signal?.aborted).toBe(true);
    expect(pending[1]?.signal?.aborted).toBe(false);
    expect(connecting()).toBeNull();
    await tick(3999);
    expect(connecting()).toBeNull();
    await tick(1);
    expect(connecting()).toBeInTheDocument();
  });

  it("Retry moves focus to the title, and a first load does not", async () => {
    render(<GuestRoomApp token="guest-tok" />);
    const title = () => screen.getByRole("heading", { level: 1 });
    expect(title()).not.toHaveFocus();
    await tick(4000);
    retry()?.focus();
    act(() => retry()?.click());
    expect(title()).toHaveFocus();
  });

  it("keeps exactly one status region while loading, with and without the alert", async () => {
    render(<GuestRoomApp token="guest-tok" />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    await tick(4000);
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("titles the tab Joining the room while the room is looked up", () => {
    document.title = "ShareCut Studio";
    const { unmount } = render(<GuestRoomApp token="guest-tok" />);
    expect(document.title).toBe("Joining the room | ShareCut Studio");
    unmount();
    expect(document.title).toBe("ShareCut Studio");
  });

  it("leaves no connecting alert when the lookup resolves early", async () => {
    const { container } = render(<GuestRoomApp token="guest-tok" />);
    await tick(1000);
    await act(async () =>
      pending[0]?.resolve({ bootstrap: BOOTSTRAP, failure: null }),
    );
    expect(container.querySelector("[aria-busy]")).toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: "Shot of Truth" }),
    ).toBeInTheDocument();
    await tick(5000);
    expect(connecting()).toBeNull();
  });

  it("leaves no alert and no crash when the lookup resolves at exactly 4000 ms", async () => {
    const { container } = render(<GuestRoomApp token="guest-tok" />);
    await tick(3999);
    await act(async () => {
      pending[0]?.resolve({ bootstrap: BOOTSTRAP, failure: null });
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(container.querySelector("[aria-busy]")).toBeNull();
    expect(connecting()).toBeNull();
    expect(retry()).toBeNull();
    await tick(5000);
    expect(connecting()).toBeNull();
  });

  it("mounts under StrictMode and still shows the alert once at 4 s", async () => {
    render(
      <StrictMode>
        <GuestRoomApp token="guest-tok" />
      </StrictMode>,
    );
    await tick(3999);
    expect(connecting()).toBeNull();
    await tick(1);
    expect(screen.getAllByText("Still connecting…")).toHaveLength(1);
  });

  it("shows the Cover, not the skeleton, when the lookup fails", async () => {
    const { container } = render(<GuestRoomApp token="guest-tok" />);
    await act(async () =>
      pending[0]?.resolve({ bootstrap: null, failure: "network" }),
    );
    expect(container.querySelector(".sys-room-view")).toBeNull();
    expect(container.querySelector(".sys-room-tile--skeleton")).toBeNull();
  });
});

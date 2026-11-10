import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuestRoomApp } from "./GuestRoomApp";
import type { RecordBootstrap } from "./recordBootstrap";

type Pending = {
  signal: AbortSignal | undefined;
  resolve: (value: RecordBootstrap) => void;
  reject: (reason: unknown) => void;
};

const pending = vi.hoisted((): Pending[] => []);
vi.mock("./recordBootstrap", () => ({
  loadRecordBootstrap: vi.fn(
    (_token: string, signal?: AbortSignal) =>
      new Promise<RecordBootstrap>((resolve, reject) => {
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
    expect(container.querySelector(".sys-room-view")).toHaveAttribute(
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

  it("leaves no connecting alert when the lookup resolves early", async () => {
    const { container } = render(<GuestRoomApp token="guest-tok" />);
    await tick(1000);
    await act(async () => pending[0]?.resolve(BOOTSTRAP));
    expect(container.querySelector("[aria-busy]")).toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: "Shot of Truth" }),
    ).toBeInTheDocument();
    await tick(5000);
    expect(connecting()).toBeNull();
  });

  it("shows the Cover, not the skeleton, when the lookup fails", async () => {
    const { container } = render(<GuestRoomApp token="guest-tok" />);
    await act(async () => pending[0]?.reject(new Error("offline")));
    expect(container.querySelector(".sys-room-view")).toBeNull();
    expect(container.querySelector(".sys-room-tile--skeleton")).toBeNull();
  });
});

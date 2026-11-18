import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRecordParticipant } from "../services/offlineQueue/offlineStore";
import { expectNoA11yViolations } from "../test/a11y";
import { seedPendingKeeper } from "../test/keepers";
import { stubMatchMedia } from "../test/matchMedia";
import { urlOf } from "../test/urlOf";
import { GuestRoomApp } from "./GuestRoomApp";
import {
  createOpfsSink,
  keeperMetaPath,
  MemorySink,
  OpfsUnavailableError,
  parseKeeperMeta,
} from "./keeper/store";
import {
  MIC_ALLOW_LABEL,
  MIC_SAVED_DEVICE_MISSING_COPY,
} from "./micPermission";
import { UPLOAD_SINK_ERROR_COPY } from "./types";
import { recordSyncErrorCopy } from "./useRecordSync";

const closeGuardSpy = vi.hoisted(() => vi.fn());
vi.mock("../desktop/useDesktopCloseGuard", () => ({
  useDesktopCloseGuard: closeGuardSpy,
}));

const encodeRoomTone = vi.hoisted(() => vi.fn());
vi.mock("./encodeRoomTone", () => ({
  encodeRoomToneWav: (...args: unknown[]) => encodeRoomTone(...args),
}));

vi.mock("./monitor/useRecordMonitor", () => ({
  useRecordMonitor: () => ({ hearing: false, remoteCount: 0, error: null }),
}));

vi.mock("./keeper/graph", () => ({
  openKeeperTap: vi.fn(async () => ({
    stop: () => undefined,
    resume: async () => "running",
  })),
}));

vi.mock("./keeper/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./keeper/store")>();
  return {
    ...actual,
    createOpfsSink: vi.fn(async () => new actual.MemorySink()),
  };
});

vi.mock("../services/offlineQueue/offlineStore", () => ({
  loadRecordParticipant: vi.fn(async () => undefined),
  saveRecordParticipant: vi.fn(async () => undefined),
  clearRecordParticipant: vi.fn(async () => undefined),
}));

const guestBootstrap = {
  mode: "record",
  kind: "record",
  token: "guest-tok",
  role: "guest",
  session_id: "room1",
  capabilities: ["join", "monitor", "comment"],
  episode: { name: "Shot of Truth" },
  room: { recorded_cap: 4, producer_cap: 2 },
  build: { capture: true, monitor: true, upload: false },
  expires_at: null,
};

const producerBootstrap = {
  ...guestBootstrap,
  token: "prod-tok",
  role: "producer",
  capabilities: ["monitor", "comment"],
};

const guestSnap = {
  session_id: "room1",
  state: "lobby" as const,
  take_index: -1,
  recording_ms: 0,
  start_blockers: [
    {
      code: "consent_pending" as const,
      participant_id: "p_g",
      display_name: "Ava",
    },
  ],
  caps: { recorded: 4, producers: 2 },
  participants: [
    {
      participant_id: "p_g",
      role: "guest" as const,
      display_name: "Ava",
      connected: true,
      consented: null,
      muted: false,
      headphones_ack: false,
    },
  ],
};

let joinedAs: Record<string, unknown> = {};

class FakeSocket {
  static OPEN = 1;
  readyState = FakeSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  sent: string[] = [];
  url = "";
  reply: "join" | "full" | "declined" | "invalid" | "silent" = "join";
  holdConsent = false;

  send(data: string) {
    this.sent.push(data);
    const msg = JSON.parse(data) as {
      command_type?: string;
      payload?: { accepted?: boolean };
    };
    if (msg.command_type === "Consent") {
      if (this.holdConsent) return;
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({
            plane: "record",
            type: "Echo",
            command_type: "Consent",
            participant_id: "p_g",
            snapshot: {
              ...guestSnap,
              start_blockers: [],
              state: !msg.payload?.accepted ? "recording" : guestSnap.state,
              participants: [
                {
                  ...guestSnap.participants[0],
                  consented: Boolean(msg.payload?.accepted),
                },
              ],
            },
          }),
        });
      });
      return;
    }
    if (msg.command_type !== "Join" || this.reply === "silent") {
      return;
    }
    queueMicrotask(() => {
      if (this.reply === "full") {
        this.onmessage?.({
          data: JSON.stringify({
            plane: "record",
            type: "Error",
            code: "room_full",
          }),
        });
        return;
      }
      if (this.reply === "invalid") {
        this.onmessage?.({
          data: JSON.stringify({
            plane: "record",
            type: "Error",
            code: "invalid_state",
          }),
        });
      }
      const consented = this.reply === "declined" ? false : null;
      const state = this.reply === "declined" ? "recording" : "lobby";
      this.onmessage?.({
        data: JSON.stringify({
          plane: "record",
          type: "Echo",
          participant_id: "p_g",
          lease: "lease-1",
        }),
      });
      this.onmessage?.({
        data: JSON.stringify({
          plane: "record",
          type: "Snapshot",
          snapshot: {
            ...guestSnap,
            state,
            participants: [
              { ...guestSnap.participants[0], consented, ...joinedAs },
            ],
          },
        }),
      });
    });
  }

  close() {}
}

function stubWebSocket(
  sockets: FakeSocket[],
  reply: FakeSocket["reply"] = "join",
) {
  const ctor = Object.assign(
    // `function`, not an arrow: Vitest >= 4 requires a constructible mock for `new`.
    vi.fn(function (url: string) {
      const ws = new FakeSocket();
      ws.url = url;
      ws.reply = reply;
      sockets.push(ws);
      queueMicrotask(() => ws.onopen?.());
      return ws;
    }),
    { OPEN: 1, CONNECTING: 0, CLOSING: 2, CLOSED: 3 },
  );
  vi.stubGlobal("WebSocket", ctor);
}

function stubBootstrap(bootstrap: Record<string, unknown> = guestBootstrap) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (urlOf(input).includes("/bootstrap")) {
        return new Response(JSON.stringify(bootstrap), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

function snapshotMessage(
  patch: Record<string, unknown> = {},
  consented: boolean | null = true,
) {
  return {
    data: JSON.stringify({
      plane: "record",
      type: "Snapshot",
      snapshot: {
        ...guestSnap,
        start_blockers: [],
        participants: [{ ...guestSnap.participants[0], consented }],
        ...patch,
      },
    }),
  };
}

const allowMic = () => screen.getByRole("button", { name: MIC_ALLOW_LABEL });
const joinButton = () =>
  screen.getByRole("button", { name: "Join and record" });

async function enterName(name = "Ava") {
  await userEvent.type(
    await screen.findByRole("textbox", { name: "Your name" }),
    name,
  );
}

async function readyToJoin(getUserMedia: ReturnType<typeof vi.fn>) {
  await enterName();
  await userEvent.click(allowMic());
  await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
  await userEvent.click(
    await screen.findByRole("button", { name: "I'm wearing headphones" }),
  );
  await waitFor(() => expect(joinButton()).toBeEnabled());
}

describe("GuestRoomApp", () => {
  let sockets: FakeSocket[];
  let getUserMedia: ReturnType<typeof vi.fn>;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  beforeEach(() => {
    joinedAs = {};
    closeGuardSpy.mockClear();
    sockets = [];
    stubWebSocket(sockets);
    getUserMedia = vi.fn(async () => {
      const track = {
        stop: vi.fn(),
        getSettings: () => ({
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: false,
        }),
      };
      return {
        getTracks: () => [track],
        getAudioTracks: () => [track],
      };
    });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia,
        enumerateDevices: vi.fn(async () => []),
      },
    });
    vi.mocked(createOpfsSink).mockReset();
    vi.mocked(createOpfsSink).mockResolvedValue(new MemorySink());
  });

  it("shows the room under the Join sheet and is axe-clean", async () => {
    stubBootstrap();
    const { container } = render(<GuestRoomApp token="guest-tok" />);
    expect(
      await screen.findByRole("heading", { name: "Join the room" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Shot of Truth" }),
    ).toBeInTheDocument();
    expect(allowMic()).toBeInTheDocument();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(joinButton()).toBeDisabled();
    expect(joinButton()).toHaveAttribute("aria-describedby");
    await expectNoA11yViolations(container);
    await expectNoA11yViolations(document.body);
  });

  it("requests the dry keeper tap only after Allow microphone", async () => {
    stubBootstrap();
    render(<GuestRoomApp token="guest-tok" />);
    await screen.findByRole("button", { name: MIC_ALLOW_LABEL });
    expect(getUserMedia).not.toHaveBeenCalled();
    await userEvent.click(allowMic());
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    expect(getUserMedia.mock.calls[0]?.[0]).toMatchObject({
      audio: {
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
        channelCount: 1,
      },
    });
    expect(joinButton()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
  });

  it("asks for the microphone again from How to allow after a denial", async () => {
    stubBootstrap();
    const denied = new Error("denied");
    denied.name = "NotAllowedError";
    getUserMedia.mockRejectedValueOnce(denied);
    render(<GuestRoomApp token="guest-tok" />);
    await userEvent.click(
      await screen.findByRole("button", { name: MIC_ALLOW_LABEL }),
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: "How to allow the microphone",
      }),
    );
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByRole("button", { name: "I'm wearing headphones" }),
    ).toBeInTheDocument();
  });

  it("falls back from a stale saved microphone and forgets it", async () => {
    localStorage.setItem("record:guest-tok:mic", "dead-id");
    stubBootstrap();
    const staleDevice = new Error("gone");
    staleDevice.name = "OverconstrainedError";
    getUserMedia.mockRejectedValueOnce(staleDevice);
    render(<GuestRoomApp token="guest-tok" />);
    await userEvent.click(
      await screen.findByRole("button", { name: MIC_ALLOW_LABEL }),
    );
    expect(
      await screen.findByText(MIC_SAVED_DEVICE_MISSING_COPY),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(localStorage.getItem("record:guest-tok:mic")).toBe(""),
    );
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole("button", { name: "I'm wearing headphones" }),
    ).toBeInTheDocument();
  });

  it("does not write the dead mic id back after Not now", async () => {
    localStorage.setItem("record:guest-tok:mic", "dead-id");
    stubBootstrap();
    const staleDevice = new Error("gone");
    staleDevice.name = "OverconstrainedError";
    getUserMedia.mockRejectedValueOnce(staleDevice);
    render(<GuestRoomApp token="guest-tok" />);
    await userEvent.click(
      await screen.findByRole("button", { name: MIC_ALLOW_LABEL }),
    );
    await screen.findByText(MIC_SAVED_DEVICE_MISSING_COPY);
    await waitFor(() =>
      expect(localStorage.getItem("record:guest-tok:mic")).toBe(""),
    );
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(await screen.findByText("You're not being recorded.")).toBeVisible();
    expect(localStorage.getItem("record:guest-tok:mic")).toBe("");
  });

  it("sends consent once and waits for the host", async () => {
    stubBootstrap();
    render(<GuestRoomApp token="guest-tok" />);
    await readyToJoin(getUserMedia);
    const ws = sockets[0];
    const extraSnap = {
      plane: "record",
      type: "Applied",
      snapshot: guestSnap,
    };
    ws.onmessage?.({ data: JSON.stringify(extraSnap) });
    ws.onmessage?.({ data: JSON.stringify(extraSnap) });
    await userEvent.click(joinButton());
    await screen.findByText("Waiting");
    const types = ws.sent.map(
      (row) => JSON.parse(row) as { command_type?: string },
    );
    expect(types.filter((t) => t.command_type === "Consent")).toHaveLength(1);
    expect(
      types.filter((t) => t.command_type === "HeadphonesAck").length,
    ).toBeLessThan(3);
  });

  it("waits for a changed join result and preserves a retry under an unchanged error", async () => {
    stubBootstrap();
    render(<GuestRoomApp token="guest-tok" />);
    await readyToJoin(getUserMedia);
    const socket = sockets[0];
    socket.holdConsent = true;
    await userEvent.click(joinButton());
    expect(screen.getByRole("button", { name: "Joining…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    act(() =>
      socket.onmessage?.({
        data: JSON.stringify({
          plane: "record",
          type: "Error",
          code: "invalid_state",
        }),
      }),
    );
    await waitFor(() => expect(joinButton()).toBeEnabled());
    await userEvent.click(joinButton());
    expect(screen.getByRole("button", { name: "Joining…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    act(() => socket.onmessage?.(snapshotMessage({}, true)));
    await screen.findByRole("button", { name: "Leave room" });
    expect(
      screen.queryByRole("heading", { name: "Join the room" }),
    ).not.toBeInTheDocument();
    expect(
      socket.sent.filter(
        (message) => JSON.parse(message).command_type === "Consent",
      ),
    ).toHaveLength(2);
  });

  it("raises no saving alert when the connection drops before this guest recorded anything", async () => {
    const uploadCalls = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/bootstrap")) {
          return new Response(
            JSON.stringify({
              ...guestBootstrap,
              build: { capture: true, monitor: false, upload: true },
            }),
            { status: 200 },
          );
        }
        if (url.includes("/upload")) {
          uploadCalls();
          throw new TypeError("Failed to fetch");
        }
        return new Response("not found", { status: 404 });
      }),
    );
    render(<GuestRoomApp token="guest-tok" />);
    await readyToJoin(getUserMedia);
    await userEvent.click(joinButton());
    await screen.findByRole("button", { name: "Leave room" });
    await waitFor(() => expect(uploadCalls).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("Saving stopped.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume saving" })).toBeNull();
  });

  it("remembers the name on this device only after the room confirms the join", async () => {
    stubBootstrap();
    render(<GuestRoomApp token="guest-tok" />);
    await readyToJoin(getUserMedia);
    sockets[0].holdConsent = true;
    await userEvent.click(joinButton());
    expect(screen.getByRole("button", { name: "Joining…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(localStorage.getItem("sharecut.recordName")).toBeNull();
    act(() => sockets[0].onmessage?.(snapshotMessage({}, true)));
    await screen.findByRole("button", { name: "Leave room" });
    expect(localStorage.getItem("sharecut.recordName")).toBe("Ava");
  });

  it("holds a remembered name back until Join, then sends it just before Consent", async () => {
    localStorage.setItem("sharecut.recordName", "Ava Okafor");
    stubBootstrap();
    render(<GuestRoomApp token="guest-tok" />);
    await userEvent.click(
      await screen.findByRole("button", { name: MIC_ALLOW_LABEL }),
    );
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    await userEvent.click(
      await screen.findByRole("button", { name: "I'm wearing headphones" }),
    );
    await waitFor(() => expect(joinButton()).toBeEnabled());
    const commands = () =>
      sockets[0].sent.map(
        (row) =>
          JSON.parse(row) as {
            command_type: string;
            payload: Record<string, unknown>;
          },
      );
    expect(
      commands().find((row) => row.command_type === "Join")?.payload
        .display_name,
    ).toBe("Guest");
    expect(
      commands().filter((row) => row.command_type === "UpdateName"),
    ).toHaveLength(0);
    await userEvent.click(joinButton());
    const sent = commands().map((row) => row.command_type);
    const consent = sent.indexOf("Consent");
    expect(sent[consent - 1]).toBe("UpdateName");
    expect(commands()[consent - 1].payload).toEqual({
      display_name: "Ava Okafor",
    });
  });

  it("sends the remembered name right before Consent when Join is pressed before the first Echo", async () => {
    localStorage.setItem("sharecut.recordName", "Ava Okafor");
    stubWebSocket(sockets, "silent");
    stubBootstrap();
    render(<GuestRoomApp token="guest-tok" />);
    await userEvent.click(
      await screen.findByRole("button", { name: MIC_ALLOW_LABEL }),
    );
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    await userEvent.click(
      await screen.findByRole("button", { name: "I'm wearing headphones" }),
    );
    await waitFor(() => expect(joinButton()).toBeEnabled());
    await userEvent.click(joinButton());
    const frames = sockets[0].sent.map(
      (row) =>
        JSON.parse(row) as {
          command_type: string;
          payload: Record<string, unknown>;
        },
    );
    const consent = frames.findIndex((row) => row.command_type === "Consent");
    expect(consent).toBeGreaterThan(0);
    expect(frames[consent - 1]).toMatchObject({
      command_type: "UpdateName",
      payload: { display_name: "Ava Okafor" },
    });
  });

  it("closes the sheet and shows the room once consent lands", async () => {
    stubBootstrap();
    render(<GuestRoomApp token="guest-tok" />);
    await readyToJoin(getUserMedia);
    await userEvent.click(joinButton());
    await screen.findByRole("button", { name: "Leave room" });
    expect(screen.queryByRole("heading", { name: "Join the room" })).toBeNull();
    expect(screen.getByText("Waiting")).toBeInTheDocument();
  });

  describe("people looking in", () => {
    const LINE = "Someone with the producer link is looking in";
    const polite = () =>
      document.querySelector('[aria-live="polite"].sr-only') as HTMLElement;
    const lineText = () =>
      document.querySelector(".sys-room-looking-in")?.textContent ?? null;

    it("names them in the consent Details and on the page behind it", async () => {
      stubBootstrap();
      render(<GuestRoomApp token="guest-tok" />);
      await screen.findByRole("heading", { name: "Join the room" });
      await waitFor(() => expect(sockets).toHaveLength(1));
      act(() =>
        sockets[0].onmessage?.(
          snapshotMessage({ watchers: 1, server_time_ns: 5 }, null),
        ),
      );
      await userEvent.click(
        await screen.findByRole("button", { name: "Details" }),
      );
      expect(
        screen.getByText(`${LINE}. They can see the room but can't hear it.`),
      ).toBeInTheDocument();
      expect(lineText()).toBe(LINE);
    });

    it("shows the line on the guest seat, updates it and announces the first arrival once", async () => {
      stubBootstrap();
      render(<GuestRoomApp token="guest-tok" />);
      await readyToJoin(getUserMedia);
      await userEvent.click(joinButton());
      await screen.findByRole("button", { name: "Leave room" });
      expect(lineText()).toBeNull();
      act(() =>
        sockets[0].onmessage?.(
          snapshotMessage({ watchers: 1, server_time_ns: 10 }, true),
        ),
      );
      expect(lineText()).toBe(LINE);
      expect(polite()).toHaveTextContent(LINE);
      act(() =>
        sockets[0].onmessage?.(
          snapshotMessage({ watchers: 3, server_time_ns: 11 }, true),
        ),
      );
      expect(lineText()).toBe("3 people with the producer link are looking in");
      expect(polite()).toHaveTextContent(LINE);
      act(() =>
        sockets[0].onmessage?.(
          snapshotMessage({ watchers: 0, server_time_ns: 12 }, true),
        ),
      );
      expect(lineText()).toBeNull();
    });

    it("renders a new note for a later room's arrival that uses the same words", async () => {
      stubBootstrap();
      render(<GuestRoomApp token="guest-tok" />);
      await readyToJoin(getUserMedia);
      await userEvent.click(joinButton());
      await screen.findByRole("button", { name: "Leave room" });
      const send = (extra: Record<string, unknown>) =>
        act(() => sockets[0].onmessage?.(snapshotMessage(extra, true)));
      send({ watchers: 0, server_time_ns: 9 });
      send({ watchers: 1, server_time_ns: 10 });
      expect(polite()).toHaveTextContent(LINE);
      send({ watchers: 0, server_time_ns: 11 });
      send({ session_id: "room2", watchers: 0, server_time_ns: 12 });
      const added: string[] = [];
      const watch = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.textContent?.includes("looking in")) {
              added.push(node.textContent);
            }
          }
        }
      });
      watch.observe(polite(), { childList: true, subtree: true });
      send({ session_id: "room2", watchers: 1, server_time_ns: 13 });
      await Promise.resolve();
      send({ session_id: "room2", watchers: 3, server_time_ns: 14 });
      await Promise.resolve();
      watch.disconnect();
      expect(added).toEqual([LINE]);
    });

    it("shows nothing for a count that is not a count", async () => {
      stubBootstrap();
      render(<GuestRoomApp token="guest-tok" />);
      await readyToJoin(getUserMedia);
      await userEvent.click(joinButton());
      await screen.findByRole("button", { name: "Leave room" });
      for (const [i, bad] of [-1, 2.5, "2", 1000].entries()) {
        act(() =>
          sockets[0].onmessage?.(
            snapshotMessage({ watchers: bad, server_time_ns: 10 + i }, true),
          ),
        );
        expect(lineText()).toBeNull();
      }
    });

    it("stays silent for a rise during a take, then announces a lobby rise", async () => {
      stubBootstrap();
      render(<GuestRoomApp token="guest-tok" />);
      await readyToJoin(getUserMedia);
      await userEvent.click(joinButton());
      await screen.findByRole("button", { name: "Leave room" });
      const send = (patch: Record<string, unknown>, ns: number) =>
        act(() =>
          sockets[0].onmessage?.(
            snapshotMessage({ ...patch, server_time_ns: ns }, true),
          ),
        );
      send({ state: "recording", take_index: 0, watchers: 0 }, 10);
      send({ state: "recording", take_index: 0, watchers: 1 }, 11);
      expect(lineText()).toBe(LINE);
      expect(polite()).not.toHaveTextContent(LINE);
      send({ state: "lobby", take_index: 0, watchers: 0 }, 12);
      send({ state: "lobby", take_index: 0, watchers: 1 }, 13);
      expect(polite()).toHaveTextContent(LINE);
    });
  });

  it("shows producer copy without a microphone prompt", async () => {
    stubBootstrap(producerBootstrap);
    const { container } = render(<GuestRoomApp token="prod-tok" />);
    await screen.findByRole("button", { name: "Join to listen" });
    expect(screen.queryByRole("button", { name: MIC_ALLOW_LABEL })).toBeNull();
    expect(screen.queryByText("Microphone")).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(document.title).toBe("Join to listen | Shot of Truth");
    });
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(new URL(sockets[0].url).searchParams.get("observe")).toBe("1");
    expect(sockets[0].sent).toEqual([]);
    expect(closeGuardSpy).toHaveBeenLastCalledWith(false, "guest", false);
    await expectNoA11yViolations(container);
  });

  it("keeps keeper upload and its status off the producer room after Stop", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.includes("/bootstrap")) {
        return new Response(
          JSON.stringify({
            ...producerBootstrap,
            build: { capture: true, monitor: true, upload: true },
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<GuestRoomApp token="prod-tok" />);
    await enterName("Pat");
    await userEvent.click(
      await screen.findByRole("button", { name: "Join to listen" }),
    );
    await waitFor(() => {
      expect(sockets[0]?.sent.some((raw) => raw.includes('"Join"'))).toBe(true);
    });
    await screen.findByRole("button", { name: "Leave room" });
    sockets[0]?.onmessage?.(
      snapshotMessage(
        {
          state: "stopped",
          take_index: 0,
          takes: [{ take_index: 0, consented_participant_ids: [] }],
          participants: [
            {
              ...guestSnap.participants[0],
              role: "producer",
              display_name: "Pat",
              consented: null,
            },
          ],
        },
        null,
      ),
    );
    await screen.findByText("Saved");
    expect(screen.queryByText(/keep this page open/)).toBeNull();
    expect(screen.getByRole("button", { name: "Leave room" })).toBeEnabled();
    expect(
      fetchMock.mock.calls.some(([input]) => urlOf(input).includes("/upload")),
    ).toBe(false);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("lets a producer who closed the sheet open it again", async () => {
    stubBootstrap(producerBootstrap);
    render(<GuestRoomApp token="prod-tok" />);
    await waitFor(() => expect(sockets).toHaveLength(1));
    const close = vi.fn();
    sockets[0].close = close;
    await userEvent.click(
      await screen.findByRole("button", { name: "Not now" }),
    );
    expect(close).toHaveBeenCalled();
    expect(
      screen.getByRole("region", { name: "Not in the room" }),
    ).toBeVisible();
    expect(
      screen.getByText("You're not in the room yet. You won't be recorded."),
    ).toBeVisible();
    await waitFor(() => {
      expect(document.title).toBe("Not in the room | Shot of Truth");
    });
    expect(screen.queryByText("Waiting")).toBeNull();
    expect(screen.queryByRole("button", { name: "Join recording" })).toBeNull();
    const back = screen.getByRole("button", { name: "Join to listen" });
    expect(back).toBeEnabled();
    await userEvent.click(back);
    expect(
      await screen.findByRole("heading", { name: "Join the room" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Join to listen" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(sockets).toHaveLength(2));
    expect(new URL(sockets[1].url).searchParams.get("observe")).toBe("1");
  });

  describe("a producer looking in before the press", () => {
    const hana = {
      participant_id: "p_host",
      role: "host" as const,
      display_name: "Hana",
      connected: true,
      consented: true,
      muted: false,
      headphones_ack: true,
    };
    const ava = { ...guestSnap.participants[0], consented: true };
    const look = (patch: Record<string, unknown> = {}) =>
      act(() =>
        sockets[0].onmessage?.(
          snapshotMessage(
            {
              state: "recording",
              take_index: 0,
              recording_ms: 5000,
              participants: [hana, ava],
              server_time_ns: 100,
              ...patch,
            },
            true,
          ),
        ),
      );
    const SEEN = "The room can see that someone is looking in.";
    const rowText = () =>
      document.querySelector(".sys-room-looking-in")?.textContent ?? null;

    const refuseJoinOnTheRetrySocket = async () => {
      await enterName("Pat");
      await userEvent.click(
        screen.getByRole("button", { name: "Join to listen" }),
      );
      await waitFor(() => {
        expect(
          sockets[0].sent.filter((raw) => raw.includes('"Join"')),
        ).toHaveLength(1);
      });
      act(() => sockets[0].onclose?.({ code: 1006 }));
      await waitFor(() => expect(sockets).toHaveLength(2));
      await waitFor(() => {
        expect(
          sockets[1].sent.filter((raw) => raw.includes('"Join"')),
        ).toHaveLength(1);
      });
      act(() =>
        sockets[1].onmessage?.({
          data: JSON.stringify({
            plane: "record",
            type: "Error",
            code: "invalid_state",
          }),
        }),
      );
    };

    async function lookIn() {
      stubBootstrap(producerBootstrap);
      stubWebSocket(sockets, "silent");
      render(<GuestRoomApp token="prod-tok" />);
      await waitFor(() => expect(sockets).toHaveLength(1));
      await screen.findByRole("button", { name: "Join to listen" });
    }

    it("shows who is there, the live pill and the real tiles behind the sheet", async () => {
      await lookIn();
      look({ watchers: 1 });
      expect(
        await screen.findByRole("heading", { name: "Hana and Ava are here" }),
      ).toBeVisible();
      expect(document.querySelector(".sys-pill-text")?.textContent).toBe(
        "0:05 · Take 1",
      );
      expect(sockets[0].sent).toEqual([]);
      expect(document.title).toBe("Join to listen | Shot of Truth");
      expect(screen.queryByText("You")).toBeNull();
    });

    it("tells the producer the room can see them only once the server has counted them", async () => {
      await lookIn();
      expect(
        screen.queryByText(SEEN, { selector: ".sys-join-seen" }),
      ).toBeNull();
      look({ server_time_ns: 100 });
      expect(
        screen.queryByText(SEEN, { selector: ".sys-join-seen" }),
      ).toBeNull();
      look({ watchers: 0, server_time_ns: 101 });
      expect(
        screen.queryByText(SEEN, { selector: ".sys-join-seen" }),
      ).toBeNull();
      look({ watchers: 1, server_time_ns: 102 });
      const sentence = screen.getByText(SEEN, { selector: ".sys-join-seen" });
      expect(sentence).toBeVisible();
      const dialog = screen.getByRole("dialog");
      expect(dialog.getAttribute("aria-describedby")?.split(" ")).toContain(
        sentence.id,
      );
    });

    it("keeps the sheet and no room when a look is refused for a producer who holds a lease, and joins with it", async () => {
      vi.mocked(loadRecordParticipant).mockResolvedValue({
        participant_id: "p_prod",
        lease: "kept",
      });
      await lookIn();
      look({ watchers: 1 });
      await screen.findByRole("heading", { name: "Hana and Ava are here" });
      act(() => sockets[0].onclose?.({ code: 4403 }));
      expect(
        screen.queryByRole("heading", { name: "This session has ended" }),
      ).toBeNull();
      expect(
        screen.queryByRole("heading", { name: "Hana and Ava are here" }),
      ).toBeNull();
      await enterName("Pat");
      await userEvent.click(
        screen.getByRole("button", { name: "Join to listen" }),
      );
      await waitFor(() => expect(sockets).toHaveLength(2));
      expect(
        new URL(sockets[1].url, "http://x").searchParams.has("observe"),
      ).toBe(false);
      await waitFor(() => expect(sockets[1].sent.length).toBeGreaterThan(0));
      expect(sockets[1].sent.join("")).toContain('"lease":"kept"');
      act(() => sockets[1].onclose?.({ code: 4403 }));
      expect(
        await screen.findByRole("heading", { name: "This session has ended" }),
      ).toBeInTheDocument();
    });

    afterEach(() => {
      vi.mocked(loadRecordParticipant).mockResolvedValue(undefined);
    });

    it("shows the invite link closed cover when a look is refused with that error and no lease", async () => {
      await lookIn();
      act(() => {
        sockets[0].onmessage?.({
          data: JSON.stringify({
            plane: "record",
            type: "Error",
            code: "invite_closed",
          }),
        });
        sockets[0].onclose?.({ code: 4403 });
      });
      expect(
        await screen.findByRole("heading", { name: "Invite link closed" }),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Thanks for recording/)).toBeNull();
    });

    it("shows the ended cover when a look is refused for a producer without a lease", async () => {
      await lookIn();
      act(() => sockets[0].onclose?.({ code: 4403 }));
      expect(
        await screen.findByRole("heading", { name: "This session has ended" }),
      ).toBeInTheDocument();
    });

    it("does not tell a lone producer that someone is looking in", async () => {
      await lookIn();
      look({ watchers: 1, server_time_ns: 101 });
      expect(
        screen.getByText(SEEN, { selector: ".sys-join-seen" }),
      ).toBeVisible();
      expect(rowText()).toBeNull();
      expect(
        document.querySelector('[aria-live="polite"].sr-only'),
      ).not.toHaveTextContent("looking in");
    });

    it("counts only the others when more than one is looking in", async () => {
      await lookIn();
      look({ watchers: 3, server_time_ns: 101 });
      expect(rowText()).toBe("2 people with the producer link are looking in");
      look({ watchers: 2, server_time_ns: 102 });
      expect(rowText()).toBe("Someone with the producer link is looking in");
    });

    it("ends the look on Not now: no pill, no people, no row", async () => {
      await lookIn();
      const close = vi.fn();
      sockets[0].close = close;
      look({ watchers: 2, server_time_ns: 101 });
      expect(rowText()).not.toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Not now" }));
      await screen.findByRole("region", { name: "Not in the room" });
      expect(close).toHaveBeenCalled();
      expect(document.querySelector(".sys-pill-text")).toBeNull();
      expect(screen.queryByText("Hana")).toBeNull();
      expect(rowText()).toBeNull();
    });

    it("drops the room and the sentence when the look's socket closes, and shows neither on the next socket until it is counted", async () => {
      await lookIn();
      look({ watchers: 1, server_time_ns: 101 });
      expect(
        screen.getByText(SEEN, { selector: ".sys-join-seen" }),
      ).toBeVisible();
      expect(document.querySelector(".sys-pill-text")).not.toBeNull();
      act(() => sockets[0].onclose?.({ code: 4429 }));
      expect(
        screen.queryByText(SEEN, { selector: ".sys-join-seen" }),
      ).toBeNull();
      expect(document.querySelector(".sys-pill-text")).toBeNull();
      expect(rowText()).toBeNull();
    });

    it("says nothing about the room seeing the page when a failed Join leaves it on a socket that was never counted", async () => {
      await lookIn();
      look({ watchers: 1, server_time_ns: 101 });
      expect(
        screen.getByText(SEEN, { selector: ".sys-join-seen" }),
      ).toBeVisible();
      await refuseJoinOnTheRetrySocket();
      await screen.findByRole("button", { name: "Join to listen" });
      expect(
        screen.queryByText(SEEN, { selector: ".sys-join-seen" }),
      ).toBeNull();
    });

    it("drops the room it showed and looks again when a failed Join leaves the page on a socket that is not looking", async () => {
      await lookIn();
      look({ watchers: 1, server_time_ns: 101 });
      await screen.findByRole("heading", { name: "Hana and Ava are here" });
      await refuseJoinOnTheRetrySocket();
      await screen.findByRole("button", { name: "Join to listen" });
      expect(document.querySelector(".sys-pill-text")).toBeNull();
      expect(
        screen.queryByRole("heading", { name: "Hana and Ava are here" }),
      ).toBeNull();
      await waitFor(() => expect(sockets).toHaveLength(3));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "That isn't possible in the room's current state.",
      );
      expect(
        new URL(sockets[2].url, "http://x").searchParams.get("observe"),
      ).toBe("1");
    });

    it("leaves no alert in the room when the press that follows the restart succeeds", async () => {
      await lookIn();
      look({ watchers: 1, server_time_ns: 101 });
      await screen.findByRole("heading", { name: "Hana and Ava are here" });
      await refuseJoinOnTheRetrySocket();
      await waitFor(() => expect(sockets).toHaveLength(3));
      await userEvent.click(
        await screen.findByRole("button", { name: "Join to listen" }),
      );
      await waitFor(() => {
        expect(
          sockets[2].sent.filter((raw) => raw.includes('"Join"')),
        ).toHaveLength(1);
      });
      act(() => sockets[2].onmessage?.(producerEcho));
      act(() =>
        sockets[2].onmessage?.(
          producerSnapshot({ state: "recording", server_time_ns: 100 }),
        ),
      );
      await waitFor(() => {
        expect(
          screen.queryByRole("button", { name: /Join to listen/ }),
        ).toBeNull();
      });
      expect(
        screen.queryByText("That isn't possible in the room's current state."),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    });

    it("keeps the count right when the Echo and the snapshot that lists the producer follow one another", async () => {
      await lookIn();
      look({ watchers: 2, server_time_ns: 101 });
      expect(rowText()).toBe("Someone with the producer link is looking in");
      await enterName("Pat");
      await userEvent.click(
        screen.getByRole("button", { name: "Join to listen" }),
      );
      await waitFor(() => {
        expect(
          sockets[0].sent.filter((raw) => raw.includes('"Join"')),
        ).toHaveLength(1);
      });
      expect(rowText()).toBe("Someone with the producer link is looking in");
      act(() => {
        sockets[0].onmessage?.(producerEcho);
        sockets[0].onmessage?.(
          producerSnapshot({
            state: "recording",
            take_index: 0,
            watchers: 1,
            server_time_ns: 102,
          }),
        );
      });
      expect(rowText()).toBe("Someone with the producer link is looking in");
    });

    it("joins on the same socket and stops saying it is looking in", async () => {
      await lookIn();
      look({ watchers: 1, server_time_ns: 101 });
      await enterName("Pat");
      await userEvent.click(
        screen.getByRole("button", { name: "Join to listen" }),
      );
      await waitFor(() => {
        expect(
          sockets[0].sent.filter((raw) => raw.includes('"Join"')),
        ).toHaveLength(1);
      });
      expect(sockets).toHaveLength(1);
      expect(
        screen.queryByText(SEEN, { selector: ".sys-join-seen" }),
      ).toBeNull();
      expect(rowText()).toBeNull();
    });
  });

  const producerSnapshot = (patch: Record<string, unknown> = {}) => ({
    data: JSON.stringify({
      plane: "record",
      type: "Snapshot",
      snapshot: {
        ...guestSnap,
        start_blockers: [],
        participants: [
          {
            ...guestSnap.participants[0],
            participant_id: "p_prod",
            role: "producer",
            display_name: "Pat",
          },
        ],
        ...patch,
      },
    }),
  });
  const producerEcho = {
    data: JSON.stringify({
      plane: "record",
      type: "Echo",
      participant_id: "p_prod",
      lease: "lease-prod",
    }),
  };

  it("shows the line and announces it on the producer seat", async () => {
    stubBootstrap(producerBootstrap);
    stubWebSocket(sockets, "silent");
    render(<GuestRoomApp token="prod-tok" />);
    await enterName("Pat");
    await userEvent.click(
      await screen.findByRole("button", { name: "Join to listen" }),
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    act(() => sockets[0].onmessage?.(producerEcho));
    act(() =>
      sockets[0].onmessage?.(
        producerSnapshot({ watchers: 0, server_time_ns: 10 }),
      ),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Join the room" }),
      ).toBeNull();
    });
    expect(document.querySelector(".sys-room-looking-in")).toBeNull();
    act(() =>
      sockets[0].onmessage?.(
        producerSnapshot({ watchers: 2, server_time_ns: 11 }),
      ),
    );
    expect(document.querySelector(".sys-room-looking-in")).toHaveTextContent(
      "2 people with the producer link are looking in",
    );
    expect(
      document.querySelector('[aria-live="polite"].sr-only'),
    ).toHaveTextContent("2 people with the producer link are looking in");
  });

  it("holds Joining until the room lists the producer, and never says Waiting", async () => {
    stubBootstrap(producerBootstrap);
    stubWebSocket(sockets, "silent");
    const { container } = render(<GuestRoomApp token="prod-tok" />);
    const pills = new Set<string>();
    const watch = new MutationObserver(() => {
      for (const el of container.querySelectorAll(".sys-pill-text")) {
        pills.add(el.textContent ?? "");
      }
    });
    watch.observe(container, { childList: true, subtree: true });
    await enterName("Pat");
    await userEvent.click(
      await screen.findByRole("button", { name: "Join to listen" }),
    );
    await waitFor(() => {
      expect(sockets[0]?.sent.some((raw) => raw.includes('"Join"'))).toBe(true);
    });
    expect(sockets).toHaveLength(1);
    const joins = sockets[0].sent.filter((raw) => raw.includes('"Join"'));
    expect(joins).toHaveLength(1);
    expect(JSON.parse(joins[0]).payload.display_name).toBe("Pat");
    const joining = screen.getByRole("button", { name: /Joining/ });
    expect(joining).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Not now" })).toBeEnabled();
    expect(
      screen.getByText("You can comment once you're in the room."),
    ).toBeVisible();
    expect(screen.queryByText(/while a take is running/)).toBeNull();
    expect(screen.queryByText("Waiting")).toBeNull();

    act(() => sockets[0].onmessage?.(producerEcho));
    expect(
      screen.getByRole("heading", { name: "Join the room" }),
    ).toBeVisible();

    act(() =>
      sockets[0].onmessage?.(
        producerSnapshot({
          state: "recording",
          take_index: 0,
          recording_ms: 5000,
          server_time_ns: 100,
        }),
      ),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Join the room" }),
      ).toBeNull();
    });
    expect(screen.getByText("0:05 · Take 1")).toBeVisible();
    expect(document.title).toBe("Recording | Shot of Truth");
    watch.disconnect();
    expect(pills.has("Waiting")).toBe(false);
  });

  async function pressJoinToListen() {
    stubBootstrap(producerBootstrap);
    stubWebSocket(sockets, "silent");
    render(<GuestRoomApp token="prod-tok" />);
    await enterName("Pat");
    await userEvent.click(
      await screen.findByRole("button", { name: "Join to listen" }),
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].close = vi.fn();
    await screen.findByRole("button", { name: /Joining/ });
  }
  const sendError = (code: string) =>
    act(() =>
      sockets[0].onmessage?.({
        data: JSON.stringify({ plane: "record", type: "Error", code }),
      }),
    );

  it.each(["invalid_state", "rate_limited", "something_new"])(
    "returns the sheet with the reason when Join fails with %s, and a second press tries again",
    async (code) => {
      await pressJoinToListen();
      await sendError(code);
      const again = await screen.findByRole("button", {
        name: "Join to listen",
      });
      expect(again).toBeEnabled();
      expect(screen.getByRole("alert")).toBeVisible();
      expect(sockets[0].close).not.toHaveBeenCalled();
      await userEvent.click(again);
      await waitFor(() => {
        expect(
          sockets[0].sent.filter((raw) => raw.includes('"Join"')),
        ).toHaveLength(2);
      });
      expect(sockets).toHaveLength(1);
    },
  );

  const REFUSED = "That isn't possible in the room's current state.";

  it("leaves no alert in the room after a second press succeeds", async () => {
    await pressJoinToListen();
    await sendError("invalid_state");
    expect(screen.getByRole("alert")).toHaveTextContent(REFUSED);
    await userEvent.click(
      await screen.findByRole("button", { name: "Join to listen" }),
    );
    await waitFor(() => {
      expect(
        sockets[0].sent.filter((raw) => raw.includes('"Join"')),
      ).toHaveLength(2);
    });
    act(() => sockets[0].onmessage?.(producerEcho));
    act(() =>
      sockets[0].onmessage?.(
        producerSnapshot({ state: "recording", server_time_ns: 100 }),
      ),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /Join to listen/ }),
      ).toBeNull();
    });
    expect(screen.queryByText(REFUSED)).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("shows the new reason when a second press is refused too", async () => {
    await pressJoinToListen();
    await sendError("invalid_state");
    await userEvent.click(
      await screen.findByRole("button", { name: "Join to listen" }),
    );
    await waitFor(() => {
      expect(
        sockets[0].sent.filter((raw) => raw.includes('"Join"')),
      ).toHaveLength(2);
    });
    await sendError("rate_limited");
    await screen.findByRole("button", { name: "Join to listen" });
    expect(screen.getByRole("alert")).toHaveTextContent(
      recordSyncErrorCopy("rate_limited") ?? "",
    );
    expect(screen.queryByText(REFUSED)).toBeNull();
  });

  it("does not hang on a second tab's lease_in_use: Not now still cancels", async () => {
    await pressJoinToListen();
    await sendError("lease_in_use");
    expect(screen.getByRole("button", { name: /Joining/ })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(
      await screen.findByRole("region", { name: "Not in the room" }),
    ).toBeVisible();
    expect(sockets[0].close).toHaveBeenCalled();
  });

  it.each([
    [
      "Not now",
      () => userEvent.click(screen.getByRole("button", { name: "Not now" })),
    ],
    [
      "Close",
      () => userEvent.click(screen.getByRole("button", { name: "Close" })),
    ],
    ["Escape", () => userEvent.keyboard("{Escape}")],
  ])("cancels a Joining producer with %s", async (_name, cancel) => {
    await pressJoinToListen();
    await cancel();
    expect(
      await screen.findByRole("region", { name: "Not in the room" }),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Join the room" })).toBeNull();
    expect(sockets[0].close).toHaveBeenCalled();
    await waitFor(() => {
      expect(document.title).toBe("Not in the room | Shot of Truth");
    });
  });

  it("stays out of the room when an Echo and snapshot arrive after the cancel", async () => {
    await pressJoinToListen();
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    await screen.findByRole("region", { name: "Not in the room" });
    act(() => sockets[0].onmessage?.(producerEcho));
    act(() =>
      sockets[0].onmessage?.(
        producerSnapshot({ state: "recording", server_time_ns: 100 }),
      ),
    );
    expect(
      screen.getByRole("region", { name: "Not in the room" }),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Join the room" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Join to listen" }),
    ).toBeEnabled();
  });

  it("moves focus to the room's title when the sheet closes on the confirmed room", async () => {
    await pressJoinToListen();
    act(() => sockets[0].onmessage?.(producerEcho));
    act(() =>
      sockets[0].onmessage?.(producerSnapshot({ server_time_ns: 100 })),
    );
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
    });
  });

  it("shows a failed Join's reason once, in the sheet, and clears it on Not now and on reopen", async () => {
    await pressJoinToListen();
    await sendError("rate_limited");
    const reason = "Too many requests. Wait a moment and try again.";
    expect(await screen.findAllByText(reason)).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent(reason);
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    await screen.findByRole("region", { name: "Not in the room" });
    expect(screen.queryByText(reason)).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Join to listen" }),
    );
    await screen.findByRole("heading", { name: "Join the room" });
    expect(screen.queryByText(reason)).toBeNull();
  });

  it("keeps the producer in the room when an older snapshot arrives after the live one", async () => {
    stubBootstrap(producerBootstrap);
    stubWebSocket(sockets, "silent");
    render(<GuestRoomApp token="prod-tok" />);
    await enterName("Pat");
    await userEvent.click(
      await screen.findByRole("button", { name: "Join to listen" }),
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    act(() => sockets[0].onmessage?.(producerEcho));
    act(() =>
      sockets[0].onmessage?.(
        producerSnapshot({
          state: "recording",
          take_index: 0,
          recording_ms: 5000,
          server_time_ns: 200,
        }),
      ),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Join the room" }),
      ).toBeNull();
    });
    act(() =>
      sockets[0].onmessage?.(
        producerSnapshot({
          participants: [],
          server_time_ns: 100,
        }),
      ),
    );
    expect(screen.queryByRole("heading", { name: "Join the room" })).toBeNull();
    expect(screen.getByText("0:05 · Take 1")).toBeVisible();
  });

  it("blocks joining when local backup storage is unavailable", async () => {
    vi.mocked(createOpfsSink).mockRejectedValueOnce(new Error("quota"));
    stubBootstrap();
    render(<GuestRoomApp token="guest-tok" />);
    const copy =
      "This device can't store your full-quality recording. Check that this browser or app allows local storage, then retry.";
    await screen.findByText(copy);
    expect(joinButton()).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Retry storage check" }),
    );
    await waitFor(() => expect(createOpfsSink).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(copy)).not.toBeInTheDocument();
  });

  it("shows pending backup copy while the guest storage preflight is running", async () => {
    vi.mocked(createOpfsSink).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    stubBootstrap();
    render(<GuestRoomApp token="guest-tok" />);
    expect(
      await screen.findByText(
        "Preparing device storage for your full-quality recording…",
      ),
    ).toBeInTheDocument();
    expect(joinButton()).toBeDisabled();
  });

  it("shows the specific OPFS copy when the storage API is missing", async () => {
    vi.mocked(createOpfsSink).mockRejectedValueOnce(new OpfsUnavailableError());
    stubBootstrap();
    render(<GuestRoomApp token="guest-tok" />);
    expect(
      await screen.findByText(
        "This device can't store your full-quality recording because this browser or app does not support private file storage. Use a compatible browser, then retry.",
      ),
    ).toBeInTheDocument();
  });

  it("preflights storage for room-tone upload even without keeper capture", async () => {
    stubBootstrap({
      ...guestBootstrap,
      build: { capture: false, monitor: false, upload: true },
    });
    render(<GuestRoomApp token="guest-tok" />);
    await waitFor(() => expect(createOpfsSink).toHaveBeenCalledOnce());
  });

  it("restores the previous document title after unmount", async () => {
    document.title = "ShareCut Studio";
    stubBootstrap(producerBootstrap);
    const { unmount } = render(<GuestRoomApp token="prod-tok" />);
    await waitFor(() => {
      expect(document.title).toBe("Join to listen | Shot of Truth");
    });
    unmount();
    expect(document.title).toBe("ShareCut Studio");
  });

  describe("partial keeper recovery", () => {
    function stubUploadFetch() {
      const puts: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = urlOf(input);
          if (url.includes("/bootstrap")) {
            return new Response(
              JSON.stringify({
                ...guestBootstrap,
                build: { capture: false, monitor: false, upload: true },
              }),
              { status: 200 },
            );
          }
          if (url.includes("/upload")) {
            if (init?.method === "POST") {
              puts.push(url);
              return new Response(
                JSON.stringify({
                  acked: true,
                  take_index: 0,
                  participant_id: "p_g",
                  segment_index: 0,
                  part_seq: 0,
                  file_ack: true,
                }),
                { status: 200 },
              );
            }
            return new Response(JSON.stringify({ segments: [] }), {
              status: 200,
            });
          }
          return new Response("not found", { status: 404 });
        }),
      );
      return puts;
    }

    async function renderStoppedRoom(sink: MemorySink, consented = true) {
      vi.mocked(createOpfsSink).mockResolvedValue(sink);
      const view = render(<GuestRoomApp token="guest-tok" />);
      await screen.findByRole("heading", { name: "Join the room" });
      await waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]?.onmessage?.(
        snapshotMessage(
          { state: "stopped", take_index: 0 },
          consented ? true : null,
        ),
      );
      return view;
    }

    it("recovers the guest keeper and uploads it on the next poll", async () => {
      const puts = stubUploadFetch();
      const sink = new MemorySink();
      const wavPath = await seedPendingKeeper(sink, {
        sessionId: "room1",
        takeIndex: 0,
        participantId: "p_g",
      });
      await renderStoppedRoom(sink);
      await userEvent.click(
        await screen.findByRole(
          "button",
          { name: "Finish saving" },
          { timeout: 4000 },
        ),
      );
      await screen.findAllByText(/Recovered 1 partial segment/);
      expect(
        (await screen.findAllByText(/Recovered 1 partial segment/)).some(
          (node) => !node.closest(".sr-only"),
        ),
      ).toBe(true);
      expect(
        parseKeeperMeta(await sink.read(keeperMetaPath(wavPath)))?.complete,
      ).toBe(true);
      await waitFor(() => expect(puts.length).toBeGreaterThan(0));
    });

    it("shows the unsaved take after a reload, not the Join sheet", async () => {
      stubUploadFetch();
      const sink = new MemorySink();
      await seedPendingKeeper(sink, {
        sessionId: "room1",
        takeIndex: 0,
        participantId: "p_g",
      });
      await renderStoppedRoom(sink, false);
      expect(
        await screen.findByRole(
          "button",
          { name: "Finish saving" },
          { timeout: 4000 },
        ),
      ).toBeInTheDocument();
      expect(screen.getByText("Saving stopped")).toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "Join the room" }),
      ).toBeNull();
      expect(screen.getByRole("button", { name: "Leave room" })).toBeEnabled();
    });

    it("recovers a removed guest's local audio and offers download without uploading", async () => {
      const puts = stubUploadFetch();
      const sink = new MemorySink();
      const wavPath = await seedPendingKeeper(sink, {
        sessionId: "room1",
        takeIndex: 0,
        participantId: "p_g",
      });
      await renderStoppedRoom(sink);
      await screen.findByRole(
        "button",
        { name: "Finish saving" },
        { timeout: 4000 },
      );
      sockets[0]?.onclose?.({ code: 4403 });
      expect(
        await screen.findByRole("heading", {
          name: "Your recording didn't finish saving",
        }),
      ).toBeInTheDocument();
      await userEvent.click(
        screen.getByRole("button", { name: "Try saving again" }),
      );
      expect(
        await screen.findByText(
          "Recovered 1 partial segment. Download your full-quality recording to keep a copy.",
        ),
      ).toBeInTheDocument();
      expect(
        parseKeeperMeta(await sink.read(keeperMetaPath(wavPath)))?.complete,
      ).toBe(true);
      expect(
        screen.getByRole("button", { name: "Save my recording" }),
      ).toBeEnabled();
      expect(screen.queryByText(/Upload will resume/)).toBeNull();
      expect(puts).toEqual([]);
    });

    it("shows the plain ended cover when access ends after the upload landed and the local copy is still on the device", async () => {
      const puts = stubUploadFetch();
      const sink = new MemorySink();
      await seedPendingKeeper(sink, {
        sessionId: "room1",
        takeIndex: 0,
        participantId: "p_g",
      });
      await renderStoppedRoom(sink);
      await userEvent.click(
        await screen.findByRole(
          "button",
          { name: "Finish saving" },
          { timeout: 4000 },
        ),
      );
      await waitFor(() => expect(puts.length).toBeGreaterThan(0));
      await screen.findAllByText("Saved");
      sockets[0]?.onclose?.({ code: 4403 });
      expect(
        await screen.findByRole("heading", { name: "This session has ended" }),
      ).toBeInTheDocument();
      await act(async () => undefined);
      expect(screen.getByText("Thanks for recording.")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Save my recording" }),
      ).toBeNull();
    });

    it("keeps Save and Recover on the closed-invite cover for an unsent local take", async () => {
      const puts = stubUploadFetch();
      const sink = new MemorySink();
      const wavPath = await seedPendingKeeper(sink, {
        sessionId: "room1",
        takeIndex: 0,
        participantId: "p_g",
      });
      await renderStoppedRoom(sink);
      await screen.findByRole(
        "button",
        { name: "Finish saving" },
        { timeout: 4000 },
      );
      sockets[0]?.onmessage?.({
        data: JSON.stringify({
          plane: "record",
          type: "Error",
          code: "invite_closed",
        }),
      });
      expect(
        await screen.findByRole("heading", { name: "Invite link closed" }),
      ).toBeInTheDocument();
      expect(screen.getByText(/safe on this device/)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Save my recording" }),
      ).toBeEnabled();
      await userEvent.click(
        screen.getByRole("button", { name: "Try saving again" }),
      );
      expect(
        await screen.findByText(/Recovered 1 partial segment/),
      ).toBeInTheDocument();
      expect(
        parseKeeperMeta(await sink.read(keeperMetaPath(wavPath)))?.complete,
      ).toBe(true);
      expect(puts).toEqual([]);
    });

    it("shows the plain closed-invite cover once the keeper was reclaimed", async () => {
      stubUploadFetch();
      const sink = new MemorySink();
      const wavPath = await seedPendingKeeper(sink, {
        sessionId: "room1",
        takeIndex: 0,
        participantId: "p_g",
      });
      await sink.remove(wavPath);
      await renderStoppedRoom(sink);
      sockets[0]?.onmessage?.({
        data: JSON.stringify({
          plane: "record",
          type: "Error",
          code: "invite_closed",
        }),
      });
      expect(
        await screen.findByRole("heading", { name: "Invite link closed" }),
      ).toBeInTheDocument();
      expect(screen.queryByText(/safe on this device/)).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Save my recording" }),
      ).toBeNull();
    });

    it("keeps a failed recovery out of the storage error channel", async () => {
      stubUploadFetch();
      const sink = new MemorySink();
      await seedPendingKeeper(sink, {
        sessionId: "room1",
        takeIndex: 0,
        participantId: "p_g",
      });
      sink.rewriteHeader = async () => {
        throw new Error("locked by another tab");
      };
      await renderStoppedRoom(sink);
      await userEvent.click(
        await screen.findByRole(
          "button",
          { name: "Finish saving" },
          { timeout: 4000 },
        ),
      );
      await userEvent.click(
        await screen.findByRole("button", { name: "1 more alert" }),
      );
      expect(
        await screen.findByText(/locked by another tab/),
      ).toBeInTheDocument();
      expect(screen.queryByText(UPLOAD_SINK_ERROR_COPY)).toBeNull();
      expect(
        screen.queryByText("This device couldn't save the recording."),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: /Retry storage check/ }),
      ).toBeNull();
    });
  });

  it("takes live comments after consent once the take is recording", async () => {
    stubBootstrap();
    render(<GuestRoomApp token="guest-tok" />);
    await readyToJoin(getUserMedia);
    await userEvent.click(joinButton());
    await screen.findByText("Waiting");
    await userEvent.click(screen.getByRole("button", { name: "Comments" }));
    expect(screen.getByPlaceholderText("Add a comment")).toBeDisabled();
    sockets[0].onmessage?.(
      snapshotMessage({ state: "recording", take_index: 0, recording_ms: 800 }),
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Add a comment")).toBeEnabled(),
    );
    await userEvent.type(
      screen.getByPlaceholderText("Add a comment"),
      "Retake that",
    );
    await userEvent.click(screen.getByRole("button", { name: "Post" }));
    await waitFor(() => {
      expect(
        sockets[0].sent.some(
          (raw) => raw.includes('"Comment"') && raw.includes("Retake that"),
        ),
      ).toBe(true);
    });
  });

  it("records room tone when the host starts a round that names the guest", async () => {
    encodeRoomTone.mockReset();
    encodeRoomTone.mockResolvedValue({
      wav: new Uint8Array(44 + 8),
      samples: new Float32Array(4).fill(0.001),
    });
    // Its bed uploads on its own clock, so this test answers it and waits for it:
    // an upload left in flight would land in the next test's fetch stub.
    const uploads: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.includes("/bootstrap")) {
          return new Response(
            JSON.stringify({
              ...guestBootstrap,
              build: { capture: true, monitor: false, upload: true },
            }),
            { status: 200 },
          );
        }
        if (url.includes("/upload") && init?.method === "POST") {
          uploads.push(url);
          return new Response(
            JSON.stringify({ acked: true, part_seq: 0, file_ack: true }),
            { status: 200 },
          );
        }
        if (url.includes("/upload")) {
          return new Response(
            JSON.stringify({ segments: [], room_tone_status: [] }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );
    render(<GuestRoomApp token="guest-tok" />);
    await readyToJoin(getUserMedia);
    await userEvent.click(joinButton());
    await screen.findByText("Waiting");
    expect(
      screen.queryByRole("button", { name: "Record room tone" }),
    ).toBeNull();
    expect(encodeRoomTone).not.toHaveBeenCalled();
    sockets[0].onmessage?.(
      snapshotMessage({
        room_tone: {
          round: 1,
          requested_wall_ms: 1000,
          duration_ms: 60_000,
          participant_ids: ["p_g"],
        },
        countdown_left_ms: 60_000,
      }),
    );
    await waitFor(() => expect(encodeRoomTone).toHaveBeenCalledOnce());
    // The room pill and the guest's own capture row both read the minute.
    expect(
      (await screen.findAllByText("Stay quiet · 1:00")).length,
    ).toBeGreaterThanOrEqual(1);
    await waitFor(() => expect(uploads).toHaveLength(1));
  });

  describe("room tone for a guest who joins late", () => {
    const uploadBootstrap = {
      ...guestBootstrap,
      build: { capture: true, monitor: false, upload: true },
    };
    const round = (ids: string[]) => ({
      round: 1,
      requested_wall_ms: 1000,
      duration_ms: 60_000,
      participant_ids: ids,
    });
    const bed = new Uint8Array(44 + 8).fill(7);
    type Put = { query: Record<string, string>; body: Uint8Array };

    function stubUploadFetch(puts: Put[]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = urlOf(input);
          if (url.includes("/bootstrap")) {
            return new Response(JSON.stringify(uploadBootstrap), {
              status: 200,
            });
          }
          if (url.includes("/upload") && init?.method === "POST") {
            puts.push({
              query: Object.fromEntries(new URL(url, "http://x").searchParams),
              body: new Uint8Array(init.body as Uint8Array),
            });
            return new Response(
              JSON.stringify({
                acked: true,
                take_index: 0,
                participant_id: "p_g",
                segment_index: 0,
                part_seq: 0,
                file_ack: true,
              }),
              { status: 200 },
            );
          }
          if (url.includes("/upload")) {
            return new Response(
              JSON.stringify({ segments: [], room_tone_status: [] }),
              { status: 200 },
            );
          }
          return new Response("not found", { status: 404 });
        }),
      );
    }

    async function joinRoom() {
      const view = render(<GuestRoomApp token="guest-tok" />);
      await readyToJoin(getUserMedia);
      await userEvent.click(joinButton());
      await screen.findByText("Waiting");
      return view;
    }

    const recordButton = () =>
      screen.queryByRole("button", { name: "Record room tone" });

    beforeEach(() => {
      encodeRoomTone.mockReset();
      encodeRoomTone.mockResolvedValue({
        wav: bed,
        samples: new Float32Array(4).fill(0.001),
      });
    });

    it("offers the late guest Record room tone and records it through the shared capture", async () => {
      const puts: Put[] = [];
      stubUploadFetch(puts);
      await joinRoom();
      sockets[0].onmessage?.(
        snapshotMessage({
          room_tone: round(["p_other"]),
          countdown_left_ms: 0,
        }),
      );
      const action = await screen.findByRole("button", {
        name: "Record room tone",
      });
      expect(
        screen.getByText("Record 1 minute of room tone."),
      ).toBeInTheDocument();
      await userEvent.click(action);
      await waitFor(() => expect(puts).toHaveLength(1));
      expect(encodeRoomTone).toHaveBeenCalledOnce();
      await waitFor(() => expect(recordButton()).toBeNull());
      expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    });

    it("announces the take once when it starts and keeps the ticking line out of the live region", async () => {
      stubUploadFetch([]);
      let finish: (value: unknown) => void = () => undefined;
      encodeRoomTone.mockReset();
      encodeRoomTone.mockImplementation(
        () => new Promise((resolve) => (finish = resolve)),
      );
      await joinRoom();
      sockets[0].onmessage?.(
        snapshotMessage({
          room_tone: round(["p_other"]),
          countdown_left_ms: 0,
        }),
      );
      await userEvent.click(
        await screen.findByRole("button", { name: "Record room tone" }),
      );
      const announced = await screen.findByText(
        "Recording room tone, one minute, stay quiet",
      );
      expect(announced.closest('[aria-live="polite"]')).not.toBeNull();
      const tick = await screen.findByRole("timer");
      expect(tick).toHaveTextContent("Stay quiet · 1:00");
      expect(tick.closest('[aria-live="polite"]')).toBeNull();
      expect(screen.getByRole("button", { name: "End early" })).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(await screen.findByText("Room tone cancelled")).toBeVisible();
      finish({
        wav: bed,
        samples: new Float32Array(4).fill(0.001),
        durationSec: 60,
      });
    });

    it("keeps the looking-in note and the room-tone note apart in the polite region", async () => {
      stubUploadFetch([]);
      let finish: (value: unknown) => void = () => undefined;
      encodeRoomTone.mockReset();
      encodeRoomTone.mockImplementation(
        () => new Promise((resolve) => (finish = resolve)),
      );
      await joinRoom();
      const region = () =>
        document.querySelector('[aria-live="polite"].sr-only') as HTMLElement;
      const notes = () =>
        [...region().querySelectorAll("p")].map((p) => p.textContent);
      const LINE = "Someone with the producer link is looking in";
      const send = (extra: Record<string, unknown>) =>
        act(() =>
          sockets[0].onmessage?.(
            snapshotMessage(
              { room_tone: round(["p_other"]), countdown_left_ms: 0, ...extra },
              true,
            ),
          ),
        );
      send({ watchers: 0, server_time_ns: 20 });
      send({ watchers: 1, server_time_ns: 21 });
      expect(notes().filter((text) => text === LINE)).toHaveLength(1);
      const added: string[] = [];
      const watch = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            added.push(node.textContent ?? "");
          }
        }
      });
      watch.observe(region(), { childList: true, subtree: true });
      await userEvent.click(
        await screen.findByRole("button", { name: "Record room tone" }),
      );
      await screen.findByText("Recording room tone, one minute, stay quiet");
      act(() =>
        finish({
          wav: bed,
          samples: new Float32Array(4).fill(0.001),
          durationSec: 60,
        }),
      );
      await waitFor(() => expect(notes()).toContain("Room tone recorded"));
      expect(added).not.toContain(LINE);
      expect(
        notes().filter((text) => text === LINE),
        "one looking-in node, not a stale copy",
      ).toHaveLength(1);
      expect(notes()).toHaveLength(new Set(notes()).size);
      watch.disconnect();
      added.length = 0;
      send({ session_id: "room2", watchers: 0, server_time_ns: 22 });
      watch.observe(region(), { childList: true, subtree: true });
      send({ session_id: "room2", watchers: 1, server_time_ns: 23 });
      await Promise.resolve();
      watch.disconnect();
      expect(added.filter((text) => text === LINE)).toHaveLength(1);
      expect(notes().filter((text) => text === LINE)).toHaveLength(1);
      expect(
        notes().filter((text) => text === "Room tone recorded"),
      ).toHaveLength(1);
    });

    it("uploads exactly what a host-started round uploads", async () => {
      const onTime: Put[] = [];
      stubUploadFetch(onTime);
      const first = await joinRoom();
      sockets[0].onmessage?.(snapshotMessage({ room_tone: undefined }));
      sockets[0].onmessage?.(
        snapshotMessage({
          room_tone: round(["p_g"]),
          countdown_left_ms: 60_000,
        }),
      );
      await waitFor(() => expect(onTime).toHaveLength(1));
      expect(recordButton()).toBeNull();
      first.unmount();
      localStorage.clear();
      sockets.length = 0;
      encodeRoomTone.mockClear();

      const late: Put[] = [];
      stubUploadFetch(late);
      await joinRoom();
      sockets[0].onmessage?.(
        snapshotMessage({
          room_tone: round(["p_other"]),
          countdown_left_ms: 0,
        }),
      );
      await userEvent.click(
        await screen.findByRole("button", { name: "Record room tone" }),
      );
      await waitFor(() => expect(late).toHaveLength(1));
      expect(late[0]).toEqual(onTime[0]);
      expect(late[0]?.query).toMatchObject({
        kind: "room_tone",
        take_index: "0",
        segment_index: "0",
        part_seq: "0",
        final: "true",
      });
    });

    it.each([
      ["a take is recording", { state: "recording", take_index: 0 }],
      ["a take is paused", { state: "paused", take_index: 0 }],
      ["the countdown named the guest", { room_tone: round(["p_g"]) }],
    ])("shows no prompt when %s", async (_name, patch) => {
      stubUploadFetch([]);
      await joinRoom();
      sockets[0].onmessage?.(
        snapshotMessage({
          room_tone: round(["p_other"]),
          countdown_left_ms: 0,
          ...patch,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(recordButton()).toBeNull();
    });

    it("asks again after Stop when the guest joined during a take", async () => {
      stubUploadFetch([]);
      await joinRoom();
      sockets[0].onmessage?.(
        snapshotMessage({
          state: "recording",
          take_index: 0,
          room_tone: round(["p_other"]),
          countdown_left_ms: 0,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(recordButton()).toBeNull();
      sockets[0].onmessage?.(
        snapshotMessage({
          state: "stopped",
          take_index: 0,
          room_tone: round(["p_other"]),
          countdown_left_ms: 0,
        }),
      );
      expect(
        await screen.findByRole("button", { name: "Record room tone" }),
      ).toBeInTheDocument();
    });

    it("leaves the guest as an on-time guest who skipped, and a reload does not ask again", async () => {
      const puts: Put[] = [];
      stubUploadFetch(puts);
      const first = await joinRoom();
      const late = snapshotMessage({
        room_tone: round(["p_other"]),
        countdown_left_ms: 0,
      });
      sockets[0].onmessage?.(late);
      await userEvent.click(
        await screen.findByRole("button", { name: "Skip" }),
      );
      await waitFor(() => expect(recordButton()).toBeNull());
      expect(encodeRoomTone).not.toHaveBeenCalled();
      expect(puts).toHaveLength(0);
      first.unmount();
      sockets.length = 0;

      await joinRoom();
      sockets[0].onmessage?.(late);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(recordButton()).toBeNull();
    });

    it("does not ask again after a reload or a landing once the host has the bed", async () => {
      const puts: Put[] = [];
      stubUploadFetch(puts);
      const first = await joinRoom();
      const late = snapshotMessage({
        room_tone: round(["p_other"]),
        countdown_left_ms: 0,
      });
      sockets[0].onmessage?.(late);
      await userEvent.click(
        await screen.findByRole("button", { name: "Record room tone" }),
      );
      await waitFor(() => expect(puts).toHaveLength(1));
      first.unmount();
      localStorage.clear();
      sockets.length = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = urlOf(input);
          if (url.includes("/bootstrap")) {
            return new Response(JSON.stringify(uploadBootstrap), {
              status: 200,
            });
          }
          return new Response(
            JSON.stringify({
              segments: [],
              room_tone_status: [
                { participant_id: "p_g", file_ack: true, landed: true },
              ],
            }),
            { status: 200 },
          );
        }),
      );

      await joinRoom();
      sockets[0].onmessage?.(late);
      sockets[0].onmessage?.(
        snapshotMessage({
          state: "stopped",
          take_index: 0,
          room_tone: round(["p_other"]),
          countdown_left_ms: 0,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(recordButton()).toBeNull();
    });
  });

  it("shows a 404 as the invalid-link cover", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    render(<GuestRoomApp token="gone" />);
    expect(
      await screen.findByRole("heading", {
        name: "This link doesn't open a room",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Ask the person who invited you for a new link."),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  describe("when the room does not open", () => {
    function stubUnreachableOnce() {
      let bootstraps = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          if (!urlOf(input).includes("/bootstrap")) {
            return new Response("not found", { status: 404 });
          }
          bootstraps += 1;
          if (bootstraps === 1) {
            throw new TypeError("Failed to fetch");
          }
          return new Response(JSON.stringify(guestBootstrap), { status: 200 });
        }),
      );
      return () => bootstraps;
    }

    it("shows a network failure as Try again, never the error text, and lands in the Join sheet", async () => {
      stubUnreachableOnce();
      render(<GuestRoomApp token="guest-tok" />);
      expect(
        await screen.findByRole("heading", {
          level: 1,
          name: "Couldn't reach the room",
        }),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(
          "Couldn't reach the server. Check your connection and try again.",
        ),
      ).toBeNull();
      await waitFor(() =>
        expect(document.title).toBe(
          "Couldn't reach the room | ShareCut Studio",
        ),
      );
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(
        await screen.findByRole("heading", { name: "Join the room" }),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(document.title).toBe("Join the room | Shot of Truth"),
      );
    });

    it("loads the room by itself when the browser comes back online", async () => {
      const bootstraps = stubUnreachableOnce();
      const listen = vi.spyOn(window, "addEventListener");
      render(<GuestRoomApp token="guest-tok" />);
      await screen.findByRole("heading", { name: "Couldn't reach the room" });
      await waitFor(() =>
        expect(listen).toHaveBeenCalledWith("online", expect.any(Function), {
          once: true,
        }),
      );
      act(() => {
        window.dispatchEvent(new Event("online"));
      });
      expect(
        await screen.findByRole("heading", { name: "Join the room" }),
      ).toBeInTheDocument();
      expect(bootstraps()).toBe(2);
    });

    function stubSlowUnreachable(releases: Array<() => void>) {
      let bootstraps = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          if (!urlOf(input).includes("/bootstrap")) {
            return new Response("not found", { status: 404 });
          }
          bootstraps += 1;
          if (bootstraps === 3) {
            return new Response(JSON.stringify(guestBootstrap), {
              status: 200,
            });
          }
          await new Promise<void>((resolve) => releases.push(resolve));
          throw new TypeError("Failed to fetch");
        }),
      );
      return () => bootstraps;
    }

    it("retries once by itself when the browser came back online during a manual retry", async () => {
      const releases: Array<() => void> = [];
      const bootstraps = stubSlowUnreachable(releases);
      render(<GuestRoomApp token="guest-tok" />);
      await waitFor(() => expect(releases).toHaveLength(1));
      await act(async () => releases[0]());
      await screen.findByRole("heading", { name: "Couldn't reach the room" });
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(releases).toHaveLength(2));
      act(() => {
        window.dispatchEvent(new Event("online"));
      });
      await act(async () => releases[1]());
      expect(
        await screen.findByRole("heading", { name: "Join the room" }),
      ).toBeInTheDocument();
      expect(bootstraps()).toBe(3);
    });

    it("does not retry by itself when no online transition happened during the attempt", async () => {
      const releases: Array<() => void> = [];
      const bootstraps = stubSlowUnreachable(releases);
      render(<GuestRoomApp token="guest-tok" />);
      await waitFor(() => expect(releases).toHaveLength(1));
      await act(async () => releases[0]());
      await screen.findByRole("heading", { name: "Couldn't reach the room" });
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(releases).toHaveLength(2));
      await act(async () => releases[1]());
      await screen.findByRole("heading", { name: "Couldn't reach the room" });
      expect(bootstraps()).toBe(2);
    });

    it("retries by itself at most once per online transition", async () => {
      const releases: Array<() => void> = [];
      const bootstraps = stubSlowUnreachable(releases);
      render(<GuestRoomApp token="guest-tok" />);
      await waitFor(() => expect(releases).toHaveLength(1));
      act(() => {
        window.dispatchEvent(new Event("online"));
      });
      await act(async () => releases[0]());
      await waitFor(() => expect(releases).toHaveLength(2));
      await act(async () => releases[1]());
      await screen.findByRole("heading", { name: "Couldn't reach the room" });
      expect(bootstraps()).toBe(2);
    });

    it("shows a sleeping host as The room didn't answer and waits for Try again", async () => {
      const fetchMock = vi.fn(async () =>
        Response.json({ detail: "host offline" }, { status: 503 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      render(<GuestRoomApp token="guest-tok" />);
      await screen.findByRole("heading", { name: "The room didn't answer" });
      expect(screen.queryByText(/Host offline|podcast tunnel/)).toBeNull();
      act(() => {
        window.dispatchEvent(new Event("online"));
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  it("names the tab once the guest is in the room", async () => {
    stubBootstrap();
    render(<GuestRoomApp token="guest-tok" />);
    await readyToJoin(getUserMedia);
    await userEvent.click(joinButton());
    await screen.findByRole("button", { name: "Leave room" });
    await waitFor(() => expect(document.title).toBe("Waiting | Shot of Truth"));
  });

  it("shows the invite-closed cover and is axe-clean", async () => {
    stubBootstrap();
    const { container } = render(<GuestRoomApp token="guest-tok" />);
    await waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].onmessage?.({
      data: JSON.stringify({
        plane: "record",
        type: "Error",
        code: "invite_closed",
      }),
    });
    expect(
      await screen.findByRole("heading", { name: "Invite link closed" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/closed this invite link\. Ask for a new link\./),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save my recording" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Try saving again" }),
    ).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("shows the ended cover after the room closes with 4403", async () => {
    stubBootstrap();
    const { container } = render(<GuestRoomApp token="guest-tok" />);
    await waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].onclose?.({ code: 4403 });
    expect(
      await screen.findByRole("heading", { name: "This session has ended" }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("stops a live local capture and offers its keeper after removal", async () => {
    stubBootstrap();
    const sink = new MemorySink();
    await seedPendingKeeper(sink, {
      sessionId: "room1",
      takeIndex: 0,
      participantId: "p_g",
    });
    vi.mocked(createOpfsSink).mockResolvedValue(sink);
    const { container } = render(<GuestRoomApp token="guest-tok" />);
    await readyToJoin(getUserMedia);
    await userEvent.click(joinButton());
    await screen.findByText("Waiting");
    sockets[0].onmessage?.(
      snapshotMessage({ state: "recording", take_index: 0 }),
    );
    sockets[0].onclose?.({ code: 4403 });
    await screen.findByRole("heading", {
      name: /This session has ended|didn't finish/,
    });
    await waitFor(() => {
      expect(getUserMedia.mock.results[0].value).toBeDefined();
    });
    const stream = await getUserMedia.mock.results[0].value;
    await waitFor(() => expect(stream.getTracks()[0].stop).toHaveBeenCalled());
    await screen.findByRole("button", { name: "Save my recording" });
    await expectNoA11yViolations(container);
  });

  it("routes room_full to the full cover without a mic prompt, and Try again reconnects", async () => {
    stubBootstrap();
    stubWebSocket(sockets, "full");
    render(<GuestRoomApp token="guest-tok" />);
    expect(
      await screen.findByRole("heading", { name: "The room is full" }),
    ).toBeInTheDocument();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(sockets).toHaveLength(2));
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("shows a dismissible alert for a non-terminal record error", async () => {
    stubBootstrap();
    stubWebSocket(sockets, "invalid");
    const { container } = render(<GuestRoomApp token="guest-tok" />);
    expect(
      await screen.findByText(recordSyncErrorCopy("invalid_state") ?? ""),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("dims the room for a declined guest while recording", async () => {
    stubBootstrap();
    stubWebSocket(sockets, "declined");
    render(<GuestRoomApp token="guest-tok" />);
    expect(await screen.findByText("You're not being recorded.")).toBeVisible();
    expect(closeGuardSpy).toHaveBeenLastCalledWith(false, "guest", true);
    expect(
      screen.getByRole("button", { name: "Join recording" }),
    ).toBeDisabled();
    expect(screen.queryByRole("heading", { name: "Join the room" })).toBeNull();
  });

  it("asks for the microphone in the Join recording click, then opens the sheet", async () => {
    stubBootstrap();
    render(<GuestRoomApp token="guest-tok" />);
    await readyToJoin(getUserMedia);
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    sockets[0].onmessage?.(snapshotMessage({ state: "lobby" }, false));
    await userEvent.click(
      await screen.findByRole("button", { name: "Join recording" }),
    );
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    const sheetButton = await screen.findByRole("button", {
      name: "Join and record",
    });
    await waitFor(() => expect(sheetButton).toBeEnabled());
    await userEvent.click(sheetButton);
    await screen.findByRole("button", { name: "Leave room" });
    const consents = sockets[0].sent.filter((row) => row.includes('"Consent"'));
    expect(consents.map((row) => JSON.parse(row).payload.accepted)).toEqual([
      false,
      true,
    ]);
  });

  describe("headphones on a phone", () => {
    const commands = (socket: FakeSocket) =>
      socket.sent.map(
        (row) =>
          JSON.parse(row) as { command_type?: string; payload?: unknown },
      );
    const phone = () => {
      stubMatchMedia(true);
      vi.stubGlobal("screen", { width: 390, height: 844 });
    };
    const answerMic = async () => {
      await enterName();
      await userEvent.click(allowMic());
      await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    };

    it("lets a guest join after saying they are not wearing headphones", async () => {
      phone();
      stubBootstrap();
      render(<GuestRoomApp token="guest-tok" />);
      await answerMic();
      expect(
        await screen.findByRole("button", {
          name: "I'm not wearing headphones",
        }),
      ).toHaveAttribute("aria-pressed", "false");
      expect(joinButton()).toBeDisabled();
      expect(joinButton()).toHaveAccessibleDescription(
        "Say if you're wearing headphones first",
      );
      await userEvent.click(
        screen.getByRole("button", { name: "I'm not wearing headphones" }),
      );
      expect(screen.getByText(/Others may hear their own echo/)).toBeVisible();
      await waitFor(() => expect(joinButton()).toBeEnabled());
      await userEvent.click(joinButton());
      await waitFor(() =>
        expect(
          commands(sockets[0] as FakeSocket).filter(
            (row) => row.command_type === "Consent",
          ),
        ).toHaveLength(1),
      );
      expect(
        commands(sockets[0] as FakeSocket).filter(
          (row) => row.command_type === "HeadphonesAck",
        ),
      ).toEqual([]);
    });

    it("sends the yes before the consent", async () => {
      phone();
      stubBootstrap();
      render(<GuestRoomApp token="guest-tok" />);
      await answerMic();
      await userEvent.click(
        await screen.findByRole("button", { name: "I'm wearing headphones" }),
      );
      await waitFor(() => expect(joinButton()).toBeEnabled());
      await userEvent.click(joinButton());
      await waitFor(() =>
        expect(
          commands(sockets[0] as FakeSocket).some(
            (row) => row.command_type === "Consent",
          ),
        ).toBe(true),
      );
      const order = commands(sockets[0] as FakeSocket)
        .map((row) => row.command_type)
        .filter((type) => type === "HeadphonesAck" || type === "Consent");
      expect(order).toEqual(["HeadphonesAck", "Consent"]);
      expect(
        commands(sockets[0] as FakeSocket).find(
          (row) => row.command_type === "HeadphonesAck",
        )?.payload,
      ).toEqual({ ok: true });
    });

    it("keeps the laptop's single toggle where the screen is not a phone's", async () => {
      stubMatchMedia(true);
      vi.stubGlobal("screen", { width: 1440, height: 900 });
      stubBootstrap();
      render(<GuestRoomApp token="guest-tok" />);
      await answerMic();
      await screen.findByRole("button", { name: "I'm wearing headphones" });
      expect(
        screen.queryByRole("button", { name: "I'm not wearing headphones" }),
      ).toBeNull();
      expect(joinButton()).toHaveAccessibleDescription(
        "Put on headphones first",
      );
    });

    const bea = {
      ...guestSnap.participants[0],
      participant_id: "p_b",
      display_name: "Bea",
      consented: true,
      headphones_ack: false,
    };

    it("shows a guest only their own marker, never another guest's", async () => {
      joinedAs = { consented: true, headphones_ack: true };
      stubBootstrap();
      render(<GuestRoomApp token="guest-tok" />);
      await screen.findByText("Waiting");
      const me = { ...guestSnap.participants[0], consented: true };
      sockets[0]?.onmessage?.(
        snapshotMessage({
          participants: [{ ...me, headphones_ack: true }, bea],
        }),
      );
      await screen.findByRole("group", { name: /^Bea/ });
      expect(
        screen.getByRole("group", { name: /^Bea/ }),
      ).not.toHaveAccessibleName(/not wearing headphones/);
      sockets[0]?.onmessage?.(
        snapshotMessage({
          participants: [{ ...me, headphones_ack: false }, bea],
        }),
      );
      await waitFor(() =>
        expect(
          screen.getByRole("group", { name: /^Ava/ }),
        ).toHaveAccessibleName(/not wearing headphones/),
      );
      expect(
        screen.getByRole("group", { name: /^Bea/ }),
      ).not.toHaveAccessibleName(/not wearing headphones/);
    });

    it("shows a producer the marker on a guest who is not wearing headphones", async () => {
      stubBootstrap(producerBootstrap);
      render(<GuestRoomApp token="prod-tok" />);
      await enterName("Pat");
      await userEvent.click(
        await screen.findByRole("button", { name: "Join to listen" }),
      );
      await screen.findByRole("button", { name: "Leave room" });
      sockets[0]?.onmessage?.(
        snapshotMessage(
          {
            participants: [
              {
                ...guestSnap.participants[0],
                role: "producer",
                display_name: "Pat",
                consented: null,
              },
              bea,
            ],
          },
          null,
        ),
      );
      expect(
        await screen.findByRole("group", {
          name: /^Bea.*not wearing headphones/,
        }),
      ).toBeInTheDocument();
    });

    it("sends no HeadphonesAck when a consented guest reloads", async () => {
      joinedAs = { consented: true, headphones_ack: true };
      stubBootstrap();
      render(<GuestRoomApp token="guest-tok" />);
      await screen.findByText("Waiting");
      await act(async () => undefined);
      expect(
        commands(sockets[0] as FakeSocket).filter(
          (row) => row.command_type === "HeadphonesAck",
        ),
      ).toEqual([]);
    });
  });
});

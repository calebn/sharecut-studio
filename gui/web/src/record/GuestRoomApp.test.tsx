import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { seedPendingKeeper } from "../test/keepers";
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

class FakeSocket {
  static OPEN = 1;
  readyState = FakeSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  sent: string[] = [];
  reply: "join" | "full" | "declined" | "invalid" = "join";

  send(data: string) {
    this.sent.push(data);
    const msg = JSON.parse(data) as {
      command_type?: string;
      payload?: { accepted?: boolean };
    };
    if (msg.command_type === "Consent") {
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
    if (msg.command_type !== "Join") {
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
            participants: [{ ...guestSnap.participants[0], consented }],
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
    vi.fn(function () {
      const ws = new FakeSocket();
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

  it("closes the sheet and shows the room once consent lands", async () => {
    stubBootstrap();
    render(<GuestRoomApp token="guest-tok" />);
    await readyToJoin(getUserMedia);
    await userEvent.click(joinButton());
    await screen.findByRole("button", { name: "Leave room" });
    expect(screen.queryByRole("heading", { name: "Join the room" })).toBeNull();
    expect(screen.getByText("Waiting")).toBeInTheDocument();
  });

  it("shows producer copy without a microphone prompt", async () => {
    stubBootstrap(producerBootstrap);
    const { container } = render(<GuestRoomApp token="prod-tok" />);
    await screen.findByRole("button", { name: "Join to listen" });
    expect(screen.queryByRole("button", { name: MIC_ALLOW_LABEL })).toBeNull();
    expect(screen.queryByText("Microphone")).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(document.title).toBe("Producer (not recorded) | Shot of Truth");
    });
    expect(sockets).toHaveLength(0);
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
    await userEvent.click(
      await screen.findByRole("button", { name: "Not now" }),
    );
    expect(sockets).toHaveLength(0);
    await userEvent.click(
      await screen.findByRole("button", { name: "Join recording" }),
    );
    expect(
      await screen.findByRole("button", { name: "Join to listen" }),
    ).toBeInTheDocument();
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
      expect(document.title).toBe("Producer (not recorded) | Shot of Truth");
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
    await userEvent.click(screen.getByRole("button", { name: "Notes" }));
    expect(screen.getByPlaceholderText("Add a note")).toBeDisabled();
    sockets[0].onmessage?.(
      snapshotMessage({ state: "recording", take_index: 0, recording_ms: 800 }),
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Add a note")).toBeEnabled(),
    );
    await userEvent.type(
      screen.getByPlaceholderText("Add a note"),
      "Retake that",
    );
    await userEvent.click(screen.getByRole("button", { name: "Send note" }));
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
    stubBootstrap({
      ...guestBootstrap,
      build: { capture: true, monitor: false, upload: true },
    });
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
          duration_ms: 3000,
          participant_ids: ["p_g"],
        },
        countdown_left_ms: 3000,
      }),
    );
    await waitFor(() => expect(encodeRoomTone).toHaveBeenCalledOnce());
    expect(await screen.findByText("Quiet please · 3")).toBeInTheDocument();
  });

  describe("room tone for a guest who joins late", () => {
    const uploadBootstrap = {
      ...guestBootstrap,
      build: { capture: true, monitor: false, upload: true },
    };
    const round = (ids: string[]) => ({
      round: 1,
      requested_wall_ms: 1000,
      duration_ms: 3000,
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
        screen.getByText("Record 3 seconds of room tone."),
      ).toBeInTheDocument();
      await userEvent.click(action);
      await waitFor(() => expect(puts).toHaveLength(1));
      expect(encodeRoomTone).toHaveBeenCalledOnce();
      await waitFor(() => expect(recordButton()).toBeNull());
      expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    });

    it("uploads exactly what a host-started round uploads", async () => {
      const onTime: Put[] = [];
      stubUploadFetch(onTime);
      const first = await joinRoom();
      sockets[0].onmessage?.(snapshotMessage({ room_tone: undefined }));
      sockets[0].onmessage?.(
        snapshotMessage({
          room_tone: round(["p_g"]),
          countdown_left_ms: 3000,
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
});

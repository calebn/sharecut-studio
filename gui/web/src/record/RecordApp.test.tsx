import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { seedPendingKeeper } from "../test/keepers";
import { urlOf } from "../test/urlOf";
import {
  createOpfsSink,
  keeperMetaPath,
  MemorySink,
  OpfsUnavailableError,
  parseKeeperMeta,
} from "./keeper/store";
import { MIC_ALLOW_LABEL } from "./micPermission";
import { RecordApp } from "./RecordApp";
import {
  CONSENT_COPY,
  DECLINED_COPY,
  FULL_ROOM_COPY,
  ROOM_TONE_PROMPT_COPY,
  UPLOAD_SINK_ERROR_COPY,
} from "./types";

const closeGuardSpy = vi.hoisted(() => vi.fn());
vi.mock("../desktop/useDesktopCloseGuard", () => ({
  useDesktopCloseGuard: closeGuardSpy,
}));

vi.mock("./monitor/useRecordMonitor", () => ({
  useRecordMonitor: () => ({ hearing: false, remoteCount: 0, error: null }),
}));

vi.mock("./keeper/graph", () => ({
  attachKeeperTap: vi.fn(async () => () => undefined),
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

vi.mock("../state/offlineStore", () => ({
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
  start_blockers: ["Ava"],
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
  reply: "join" | "full" | "declined" = "join";

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

describe("RecordApp", () => {
  let sockets: FakeSocket[];
  let getUserMedia: ReturnType<typeof vi.fn>;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  it("shows guest copy, consent, and is axe-clean", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/bootstrap")) {
          return new Response(JSON.stringify(guestBootstrap), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    const { container } = render(<RecordApp token="guest-tok" />);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Join the recording" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("You will be recorded")).toBeInTheDocument();
    expect(screen.getByText("Shot of Truth")).toBeInTheDocument();
    expect(await screen.findByText(CONSENT_COPY)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: MIC_ALLOW_LABEL }),
    ).toBeInTheDocument();
    expect(getUserMedia).not.toHaveBeenCalled();
    const accept = screen.getByRole("button", { name: "Accept" });
    expect(accept).toBeDisabled();
    expect(accept).toHaveAttribute("aria-describedby");
    await expectNoA11yViolations(container);
  });

  it("requests the dry keeper tap only after Allow microphone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/bootstrap")) {
          return new Response(JSON.stringify(guestBootstrap), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    render(<RecordApp token="guest-tok" />);
    await screen.findByRole("button", { name: MIC_ALLOW_LABEL });
    expect(getUserMedia).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: MIC_ALLOW_LABEL }),
    );
    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalled();
    });
    expect(getUserMedia.mock.calls[0]?.[0]).toMatchObject({
      audio: {
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
        channelCount: 1,
      },
    });
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
    expect(screen.queryByText(ROOM_TONE_PROMPT_COPY)).toBeNull();
  });

  it("accepts consent once and waits for the host", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/bootstrap")) {
          return new Response(JSON.stringify(guestBootstrap), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    render(<RecordApp token="guest-tok" />);
    await screen.findByRole("button", { name: MIC_ALLOW_LABEL });
    await userEvent.click(
      screen.getByRole("button", { name: MIC_ALLOW_LABEL }),
    );
    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalled();
    });
    await screen.findByRole("button", { name: "Accept" });
    await userEvent.click(screen.getByLabelText(/I am wearing headphones/));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled();
    });
    const ws = sockets[0];
    const extraSnap = {
      plane: "record",
      type: "Applied",
      snapshot: guestSnap,
    };
    ws.onmessage?.({ data: JSON.stringify(extraSnap) });
    ws.onmessage?.({ data: JSON.stringify(extraSnap) });
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    await screen.findByText("Waiting for host");
    const types = ws.sent.map(
      (row) => JSON.parse(row) as { command_type?: string },
    );
    expect(types.filter((t) => t.command_type === "Consent")).toHaveLength(1);
    expect(
      types.filter((t) => t.command_type === "HeadphonesAck").length,
    ).toBeLessThan(3);
  });

  it("transitions from the lobby to the room after consent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/bootstrap")) {
          return new Response(JSON.stringify(guestBootstrap), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    const { container } = render(<RecordApp token="guest-tok" />);
    await screen.findByText(CONSENT_COPY);

    sockets[0]?.onmessage?.({
      data: JSON.stringify({
        plane: "record",
        type: "Snapshot",
        snapshot: {
          ...guestSnap,
          participants: [{ ...guestSnap.participants[0], consented: true }],
        },
      }),
    });

    await screen.findByRole("button", { name: "Leave" });
    expect(container.querySelector(".focus-pull-exit")?.textContent).toContain(
      CONSENT_COPY,
    );
    expect(container.querySelector(".focus-pull-pending")).not.toBeNull();
  });

  it("shows producer copy without a microphone prompt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/bootstrap")) {
          return new Response(JSON.stringify(producerBootstrap), {
            status: 200,
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    const { container } = render(<RecordApp token="prod-tok" />);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Producer (not recorded)" }),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole("heading", { name: "Not recorded" }),
    ).toBeInTheDocument();
    expect(screen.getByText("You are listening only")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Join" })).toBeInTheDocument();
    expect(screen.queryByText("Microphone")).toBeNull();
    expect(screen.queryByRole("button", { name: MIC_ALLOW_LABEL })).toBeNull();
    expect(screen.queryByText(ROOM_TONE_PROMPT_COPY)).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(document.title).toBe("Producer (not recorded) | Shot of Truth");
    });
    expect(sockets).toHaveLength(0);
    expect(closeGuardSpy).toHaveBeenLastCalledWith(false, "guest", false);
    await expectNoA11yViolations(container);
  });

  it("blocks guest consent when local backup storage is unavailable", async () => {
    vi.mocked(createOpfsSink).mockRejectedValueOnce(new Error("quota"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/bootstrap")) {
          return new Response(JSON.stringify(guestBootstrap), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    render(<RecordApp token="guest-tok" />);
    await screen.findByText(
      "Local recording backup is unavailable. Check that this browser or app environment allows local storage, then retry.",
    );
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Retry local backup" }),
    );
    await waitFor(() => expect(createOpfsSink).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByText(
        "Local recording backup is unavailable. Check that this browser or app environment allows local storage, then retry.",
      ),
    ).not.toBeInTheDocument();
  });

  it("shows pending backup copy while the guest storage preflight is running", async () => {
    vi.mocked(createOpfsSink).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/bootstrap")) {
          return new Response(JSON.stringify(guestBootstrap), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    render(<RecordApp token="guest-tok" />);
    expect(
      await screen.findByText("Preparing local recording backup…"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
  });

  it("shows the specific OPFS copy when the storage API is missing", async () => {
    vi.mocked(createOpfsSink).mockRejectedValueOnce(new OpfsUnavailableError());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/bootstrap")) {
          return new Response(JSON.stringify(guestBootstrap), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    render(<RecordApp token="guest-tok" />);
    expect(
      await screen.findByText(
        "Local recording backup is unavailable because this browser or app environment does not support OPFS. Use a compatible browser, then retry.",
      ),
    ).toBeInTheDocument();
  });

  it("preflights storage for room-tone upload even without keeper capture", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/bootstrap")) {
          return new Response(
            JSON.stringify({
              ...guestBootstrap,
              build: { capture: false, monitor: false, upload: true },
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );
    render(<RecordApp token="guest-tok" />);
    await waitFor(() => expect(createOpfsSink).toHaveBeenCalledOnce());
  });

  it("restores the previous document title after unmount", async () => {
    document.title = "Sharecut Studio";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(producerBootstrap), { status: 200 }),
      ),
    );
    const { unmount } = render(<RecordApp token="prod-tok" />);

    await waitFor(() => {
      expect(document.title).toBe("Producer (not recorded) | Shot of Truth");
    });
    unmount();
    expect(document.title).toBe("Sharecut Studio");
  });

  it("requires skip of room tone when upload is on", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/bootstrap")) {
          return new Response(
            JSON.stringify({
              ...guestBootstrap,
              build: { ...guestBootstrap.build, upload: true },
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );
    render(<RecordApp token="guest-tok" />);
    expect(await screen.findByText(ROOM_TONE_PROMPT_COPY)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: MIC_ALLOW_LABEL }),
    );
    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalled();
    });
    await userEvent.click(screen.getByLabelText(/I am wearing headphones/));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
    });
    await userEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled();
    });
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

    async function renderStoppedRoom(sink: MemorySink) {
      vi.mocked(createOpfsSink).mockResolvedValue(sink);
      const view = render(<RecordApp token="guest-tok" />);
      await screen.findByText(CONSENT_COPY);
      sockets[0]?.onmessage?.({
        data: JSON.stringify({
          plane: "record",
          type: "Snapshot",
          snapshot: {
            ...guestSnap,
            state: "stopped",
            take_index: 0,
            start_blockers: [],
            participants: [{ ...guestSnap.participants[0], consented: true }],
          },
        }),
      });
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
        await screen.findByRole("button", { name: "Recover partial take" }),
      );
      expect(
        await screen.findByText(/Recovered 1 partial segment/),
      ).toBeInTheDocument();
      expect(
        parseKeeperMeta(await sink.read(keeperMetaPath(wavPath)))?.complete,
      ).toBe(true);
      await waitFor(() => expect(puts.length).toBeGreaterThan(0));
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
        await screen.findByRole("button", { name: "Recover partial take" }),
      );
      expect(
        await screen.findByText(/locked by another tab/),
      ).toBeInTheDocument();
      expect(screen.queryByText(UPLOAD_SINK_ERROR_COPY)).toBeNull();
      expect(
        screen.queryByRole("button", { name: /Retry local backup/ }),
      ).toBeNull();
    });
  });

  it("shows live comments after consent once the take is recording", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/bootstrap")) {
          return new Response(JSON.stringify(guestBootstrap), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    render(<RecordApp token="guest-tok" />);
    await screen.findByRole("button", { name: MIC_ALLOW_LABEL });
    await userEvent.click(
      screen.getByRole("button", { name: MIC_ALLOW_LABEL }),
    );
    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalled();
    });
    await screen.findByRole("button", { name: "Accept" });
    await userEvent.click(screen.getByLabelText(/I am wearing headphones/));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    await screen.findByText("Waiting for host");
    const ws = sockets[0];
    ws.onmessage?.({
      data: JSON.stringify({
        plane: "record",
        type: "Snapshot",
        snapshot: {
          ...guestSnap,
          state: "recording",
          take_index: 0,
          recording_ms: 800,
          start_blockers: [],
          participants: [{ ...guestSnap.participants[0], consented: true }],
        },
      }),
    });
    expect(
      await screen.findByRole("heading", { name: "Live comments" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Marker" })).toBeEnabled();
  });

  it("shows a 404 error state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    render(<RecordApp token="gone" />);
    await waitFor(() => {
      expect(
        screen.getByText("This recording link is invalid or has ended."),
      ).toBeInTheDocument();
    });
  });

  it("shows ended access after the room closes with 4403", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/bootstrap")) {
          return new Response(JSON.stringify(guestBootstrap), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    const { container } = render(<RecordApp token="guest-tok" />);
    await waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].onclose?.({ code: 4403 });
    await waitFor(() => {
      expect(
        screen.getByText("Your access to this recording room has ended."),
      ).toBeInTheDocument();
    });
    await expectNoA11yViolations(container);
  });

  it("stops a live local capture and offers its keeper after removal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/bootstrap")) {
          return new Response(JSON.stringify(guestBootstrap), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    const { container } = render(<RecordApp token="guest-tok" />);
    await screen.findByRole("button", { name: MIC_ALLOW_LABEL });
    await userEvent.click(
      screen.getByRole("button", { name: MIC_ALLOW_LABEL }),
    );
    await screen.findByRole("button", { name: "Accept" });
    await userEvent.click(screen.getByLabelText(/I am wearing headphones/));
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    await screen.findByText("Waiting for host");
    sockets[0].onmessage?.({
      data: JSON.stringify({
        plane: "record",
        type: "Snapshot",
        snapshot: {
          ...guestSnap,
          state: "recording",
          take_index: 0,
          participants: [{ ...guestSnap.participants[0], consented: true }],
        },
      }),
    });
    sockets[0].onclose?.({ code: 4403 });
    await screen.findByText("Your access to this recording room has ended.");
    await waitFor(() => {
      expect(getUserMedia.mock.results[0].value).toBeDefined();
    });
    const stream = await getUserMedia.mock.results[0].value;
    await waitFor(() => expect(stream.getTracks()[0].stop).toHaveBeenCalled());
    await screen.findByRole("button", { name: "Download local recording" });
    await expectNoA11yViolations(container);
  });

  it("routes room_full to the full-room page without a mic prompt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/bootstrap")) {
          return new Response(JSON.stringify(guestBootstrap), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    stubWebSocket(sockets, "full");
    render(<RecordApp token="guest-tok" />);
    expect(await screen.findByText(FULL_ROOM_COPY)).toBeInTheDocument();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("routes a declined guest to the declined page while recording", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/bootstrap")) {
          return new Response(JSON.stringify(guestBootstrap), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    stubWebSocket(sockets, "declined");
    render(<RecordApp token="guest-tok" />);
    expect(await screen.findByText(DECLINED_COPY)).toBeInTheDocument();
    expect(closeGuardSpy).toHaveBeenLastCalledWith(false, "guest", true);
  });
});

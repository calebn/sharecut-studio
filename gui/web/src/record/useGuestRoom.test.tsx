import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedPendingKeeper } from "../test/keepers";
import { urlOf } from "../test/urlOf";
import {
  createOpfsSink,
  keeperMetaPath,
  MemorySink,
  OpfsUnavailableError,
  parseKeeperMeta,
} from "./keeper/store";
import { MIC_SAVED_DEVICE_MISSING_COPY } from "./micPermission";
import { OPFS_UNAVAILABLE_COPY, UPLOAD_SINK_ERROR_COPY } from "./types";
import { useGuestRoom } from "./useGuestRoom";

vi.mock("../desktop/useDesktopCloseGuard", () => ({
  useDesktopCloseGuard: () => undefined,
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

const guest = {
  participant_id: "p_g",
  role: "guest" as const,
  display_name: "Ava",
  connected: true,
  consented: null as boolean | null,
  muted: false,
  headphones_ack: false,
};

const snapshotOf = (over: Record<string, unknown> = {}) => ({
  session_id: "room1",
  state: "lobby",
  take_index: -1,
  recording_ms: 0,
  start_blockers: [],
  caps: { recorded: 4, producers: 2 },
  participants: [guest],
  ...over,
});

class FakeSocket {
  static OPEN = 1;
  readyState = FakeSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  sent: string[] = [];
  reply: "join" | "full" = "join";

  send(data: string) {
    this.sent.push(data);
    const msg = JSON.parse(data) as { command_type?: string };
    if (msg.command_type !== "Join") {
      return;
    }
    queueMicrotask(() => {
      if (this.reply === "full") {
        this.emit({ type: "Error", code: "room_full" });
        return;
      }
      this.emit({ type: "Echo", participant_id: "p_g", lease: "lease-1" });
      this.emit({ type: "Snapshot", snapshot: snapshotOf() });
    });
  }

  emit(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ plane: "record", ...frame }) });
  }

  commands(type: string) {
    return this.sent
      .map((row) => JSON.parse(row) as { command_type?: string })
      .filter((row) => row.command_type === type);
  }

  close() {}
}

describe("useGuestRoom", () => {
  let sockets: FakeSocket[];
  let getUserMedia: ReturnType<typeof vi.fn>;

  function stubFetch(bootstrap: object, extra?: typeof fetch) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (urlOf(input).includes("/bootstrap")) {
          return new Response(JSON.stringify(bootstrap), { status: 200 });
        }
        return extra
          ? extra(input, init)
          : new Response("not found", { status: 404 });
      }),
    );
  }

  function stubSocket(reply: FakeSocket["reply"] = "join") {
    vi.stubGlobal(
      "WebSocket",
      Object.assign(
        vi.fn(function () {
          const ws = new FakeSocket();
          ws.reply = reply;
          sockets.push(ws);
          queueMicrotask(() => ws.onopen?.());
          return ws;
        }),
        { OPEN: 1, CONNECTING: 0, CLOSING: 2, CLOSED: 3 },
      ),
    );
  }

  beforeEach(() => {
    sockets = [];
    stubSocket();
    getUserMedia = vi.fn(async () => {
      const track = {
        stop: vi.fn(),
        getSettings: () => ({
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: false,
        }),
      };
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    });
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia, enumerateDevices: vi.fn(async () => []) },
    });
    vi.mocked(createOpfsSink).mockReset();
    vi.mocked(createOpfsSink).mockResolvedValue(new MemorySink());
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("boots into the lobby and reads the saved name", async () => {
    localStorage.setItem("record:guest-tok:name", "Ava");
    stubFetch(guestBootstrap);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    expect(result.current.bootstrap).toBeNull();
    expect(result.current.name).toBe("Ava");
    await waitFor(() => expect(result.current.me?.participant_id).toBe("p_g"));
    expect(result.current.producer).toBe(false);
    expect(result.current.heading).toBe("Join the room");
    expect(result.current.episodeName).toBe("Shot of Truth");
    expect(result.current.view).toBe("lobby");
    expect(sockets[0]?.commands("UpdateName")).toHaveLength(0);
  });

  it("reports a bootstrap failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    const { result } = renderHook(() => useGuestRoom("gone"));
    await waitFor(() => expect(result.current.bootError).toBe("not found"));
    expect(result.current.bootstrap).toBeNull();
  });

  it("asks for the microphone only after request", async () => {
    stubFetch(guestBootstrap);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    await waitFor(() => expect(result.current.me).not.toBeNull());
    expect(getUserMedia).not.toHaveBeenCalled();
    act(() => result.current.mic.request());
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    expect(getUserMedia.mock.calls[0]?.[0]).toMatchObject({
      audio: { echoCancellation: false, channelCount: 1 },
    });
    await waitFor(() => expect(result.current.mic.stream).not.toBeNull());
  });

  it("falls back from a stale saved microphone and forgets it", async () => {
    localStorage.setItem("record:guest-tok:mic", "dead-id");
    stubFetch(guestBootstrap);
    const stale = new Error("gone");
    stale.name = "OverconstrainedError";
    getUserMedia.mockRejectedValueOnce(stale);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    await waitFor(() => expect(result.current.me).not.toBeNull());
    act(() => result.current.mic.request());
    await waitFor(() => expect(result.current.staleMic).toBe(true));
    expect(result.current.mic.staleDeviceId).toBe("dead-id");
    await waitFor(() =>
      expect(localStorage.getItem("record:guest-tok:mic")).toBe(""),
    );
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(MIC_SAVED_DEVICE_MISSING_COPY).toBeTruthy();
  });

  it("sends headphones and name once the participant is known", async () => {
    stubFetch(guestBootstrap);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    await waitFor(() => expect(result.current.me).not.toBeNull());
    await waitFor(() =>
      expect(sockets[0]?.commands("HeadphonesAck")).toHaveLength(1),
    );
    act(() => result.current.setHeadphonesOk(true));
    await waitFor(() =>
      expect(sockets[0]?.commands("HeadphonesAck")).toHaveLength(2),
    );
    act(() => result.current.setName("Bea"));
    await waitFor(() =>
      expect(sockets[0]?.commands("UpdateName")).toHaveLength(1),
    );
    expect(localStorage.getItem("record:guest-tok:name")).toBe("Bea");
  });

  it("sends consent once and moves to the room when it lands", async () => {
    stubFetch(guestBootstrap);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    await waitFor(() => expect(result.current.me).not.toBeNull());
    await act(async () => {
      result.current.send("Consent", { accepted: true });
    });
    expect(sockets[0]?.commands("Consent")).toHaveLength(1);
    expect(result.current.view).toBe("lobby");
    act(() =>
      sockets[0]?.emit({
        type: "Snapshot",
        snapshot: snapshotOf({
          participants: [{ ...guest, consented: true }],
        }),
      }),
    );
    await waitFor(() => expect(result.current.view).toBe("room"));
    expect(sockets[0]?.commands("Consent")).toHaveLength(1);
  });

  it("routes a declined guest while the room is recording", async () => {
    stubFetch(guestBootstrap);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    await waitFor(() => expect(result.current.me).not.toBeNull());
    act(() =>
      sockets[0]?.emit({
        type: "Snapshot",
        snapshot: snapshotOf({
          state: "recording",
          take_index: 0,
          participants: [{ ...guest, consented: false }],
        }),
      }),
    );
    await waitFor(() => expect(result.current.view).toBe("declined"));
  });

  describe("storage preflight", () => {
    it("blocks on a failed sink and retries", async () => {
      vi.mocked(createOpfsSink).mockRejectedValueOnce(new Error("quota"));
      stubFetch(guestBootstrap);
      const { result } = renderHook(() => useGuestRoom("guest-tok"));
      await waitFor(() =>
        expect(result.current.sinkError).toBe(UPLOAD_SINK_ERROR_COPY),
      );
      expect(result.current.sink).toBeNull();
      expect(result.current.storageRequired).toBe(true);
      act(() => result.current.retryStorage());
      await waitFor(() => expect(result.current.sink).not.toBeNull());
      expect(createOpfsSink).toHaveBeenCalledTimes(2);
      expect(result.current.sinkError).toBeNull();
    });

    it("stays pending while the preflight runs", async () => {
      vi.mocked(createOpfsSink).mockImplementationOnce(
        () => new Promise(() => undefined),
      );
      stubFetch(guestBootstrap);
      const { result } = renderHook(() => useGuestRoom("guest-tok"));
      await waitFor(() => expect(createOpfsSink).toHaveBeenCalledOnce());
      expect(result.current.sink).toBeNull();
      expect(result.current.sinkError).toBeNull();
    });

    it("names a missing storage API", async () => {
      vi.mocked(createOpfsSink).mockRejectedValueOnce(
        new OpfsUnavailableError(),
      );
      stubFetch(guestBootstrap);
      const { result } = renderHook(() => useGuestRoom("guest-tok"));
      await waitFor(() =>
        expect(result.current.sinkError).toBe(OPFS_UNAVAILABLE_COPY),
      );
    });

    it("preflights for room-tone upload without keeper capture", async () => {
      stubFetch({
        ...guestBootstrap,
        build: { capture: false, monitor: false, upload: true },
      });
      renderHook(() => useGuestRoom("guest-tok"));
      await waitFor(() => expect(createOpfsSink).toHaveBeenCalledOnce());
    });

    it("skips storage when neither capture nor upload is built", async () => {
      stubFetch({
        ...guestBootstrap,
        build: { capture: false, monitor: false, upload: false },
      });
      const { result } = renderHook(() => useGuestRoom("guest-tok"));
      await waitFor(() => expect(result.current.bootstrap).not.toBeNull());
      expect(result.current.storageRequired).toBe(false);
      expect(createOpfsSink).not.toHaveBeenCalled();
    });
  });

  describe("producer", () => {
    it("is listen-only: no mic, no sink, no socket until joined", async () => {
      stubFetch(producerBootstrap);
      document.title = "ShareCut Studio";
      const { result, unmount } = renderHook(() => useGuestRoom("prod-tok"));
      await waitFor(() => expect(result.current.producer).toBe(true));
      expect(document.title).toBe("Producer (not recorded) | Shot of Truth");
      expect(sockets).toHaveLength(0);
      expect(createOpfsSink).not.toHaveBeenCalled();
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(result.current.view).toBe("lobby");
      act(() => result.current.setProducerJoined(true));
      await waitFor(() => expect(sockets).toHaveLength(1));
      expect(result.current.uploadTransport).toBeNull();
      expect(sockets[0]?.commands("HeadphonesAck")).toHaveLength(0);
      unmount();
      expect(document.title).toBe("ShareCut Studio");
    });
  });

  describe("terminal states", () => {
    it("routes room_full to the full view without a mic prompt", async () => {
      stubFetch(guestBootstrap);
      stubSocket("full");
      const { result } = renderHook(() => useGuestRoom("guest-tok"));
      await waitFor(() => expect(result.current.view).toBe("full"));
      expect(result.current.accessEnded).toBe(false);
      act(() => result.current.mic.request());
      await act(async () => undefined);
      expect(getUserMedia).not.toHaveBeenCalled();
    });

    it("flags ended access on close 4403", async () => {
      stubFetch(guestBootstrap);
      const { result } = renderHook(() => useGuestRoom("guest-tok"));
      await waitFor(() => expect(sockets).toHaveLength(1));
      act(() => sockets[0]?.onclose?.({ code: 4403 }));
      await waitFor(() => expect(result.current.accessEnded).toBe(true));
      expect(result.current.inviteClosed).toBe(false);
    });

    it("flags a closed invite link", async () => {
      stubFetch(guestBootstrap);
      const { result } = renderHook(() => useGuestRoom("guest-tok"));
      await waitFor(() => expect(sockets).toHaveLength(1));
      act(() => sockets[0]?.emit({ type: "Error", code: "invite_closed" }));
      await waitFor(() => expect(result.current.accessEnded).toBe(true));
      expect(result.current.inviteClosed).toBe(true);
    });

    it("keeps a non-terminal error dismissible", async () => {
      stubFetch(guestBootstrap);
      const { result } = renderHook(() => useGuestRoom("guest-tok"));
      await waitFor(() => expect(result.current.me).not.toBeNull());
      act(() => sockets[0]?.emit({ type: "Error", code: "invalid_state" }));
      await waitFor(() => expect(result.current.error).toBe("invalid_state"));
      expect(result.current.accessEnded).toBe(false);
      act(() => result.current.clearError());
      expect(result.current.error).toBeNull();
    });
  });

  describe("partial keeper recovery", () => {
    function stubUploadFetch() {
      const puts: string[] = [];
      stubFetch(
        {
          ...guestBootstrap,
          build: { capture: false, monitor: false, upload: true },
        },
        (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = urlOf(input);
          if (!url.includes("/upload")) {
            return new Response("not found", { status: 404 });
          }
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
        }) as typeof fetch,
      );
      return puts;
    }

    async function renderStopped(sink: MemorySink) {
      vi.mocked(createOpfsSink).mockResolvedValue(sink);
      const hook = renderHook(() => useGuestRoom("guest-tok"));
      await waitFor(() => expect(hook.result.current.me).not.toBeNull());
      act(() =>
        sockets[0]?.emit({
          type: "Snapshot",
          snapshot: snapshotOf({
            state: "stopped",
            take_index: 0,
            participants: [{ ...guest, consented: true }],
          }),
        }),
      );
      await waitFor(() =>
        expect(hook.result.current.keeperActions.recover).toBeDefined(),
      );
      return hook;
    }

    it("recovers the keeper and lets the upload resume", async () => {
      const puts = stubUploadFetch();
      const sink = new MemorySink();
      const wavPath = await seedPendingKeeper(sink, {
        sessionId: "room1",
        takeIndex: 0,
        participantId: "p_g",
      });
      const { result } = await renderStopped(sink);
      await act(async () => result.current.keeperActions.recover?.());
      await waitFor(() =>
        expect(result.current.keeperActions.notice).toMatch(
          /Recovered 1 partial segment/,
        ),
      );
      expect(
        parseKeeperMeta(await sink.read(keeperMetaPath(wavPath)))?.complete,
      ).toBe(true);
      await waitFor(() => expect(puts.length).toBeGreaterThan(0));
    });

    it("recovers after removal without uploading", async () => {
      const puts = stubUploadFetch();
      const sink = new MemorySink();
      await seedPendingKeeper(sink, {
        sessionId: "room1",
        takeIndex: 0,
        participantId: "p_g",
      });
      const { result } = await renderStopped(sink);
      act(() => sockets[0]?.onclose?.({ code: 4403 }));
      await waitFor(() => expect(result.current.accessEnded).toBe(true));
      expect(result.current.uploadTransport).toBeNull();
      await waitFor(() => expect(result.current.captureSettled).toBe(true));
      await act(async () => result.current.keeperActions.recover?.());
      await waitFor(() =>
        expect(result.current.keeperActions.notice).toMatch(
          /Recovered 1 partial segment. Download/,
        ),
      );
      expect(result.current.keeperActions.download).toBeDefined();
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
      const { result } = await renderStopped(sink);
      await act(async () => result.current.keeperActions.recover?.());
      await waitFor(() =>
        expect(result.current.keeperActions.error).toMatch(
          /locked by another tab/,
        ),
      );
      expect(result.current.sinkError).toBeNull();
    });
  });
});

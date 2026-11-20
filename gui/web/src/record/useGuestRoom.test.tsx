import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRecordParticipant } from "../services/offlineQueue/offlineStore";
import { deferred } from "../test/deferred";
import { seedPendingKeeper } from "../test/keepers";
import { urlOf } from "../test/urlOf";
import {
  createOpfsSink,
  keeperMetaPath,
  keeperWavPath,
  MemorySink,
  OpfsUnavailableError,
  parseKeeperMeta,
} from "./keeper/store";
import { MIC_SAVED_DEVICE_MISSING_COPY } from "./micPermission";
import { OPFS_UNAVAILABLE_COPY, UPLOAD_SINK_ERROR_COPY } from "./types";
import { requestedRecordMode, useGuestRoom } from "./useGuestRoom";

vi.mock("./encodeRoomTone", () => ({
  encodeRoomToneWav: (
    _stream: MediaStream,
    { signal }: { signal: AbortSignal },
  ) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason));
    }),
}));

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

let joinedAs: Partial<typeof guest> = {};

class FakeSocket {
  static OPEN = 1;
  readyState = FakeSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  sent: string[] = [];
  reply: "join" | "full" | "silent" = "join";

  send(data: string) {
    this.sent.push(data);
    const msg = JSON.parse(data) as { command_type?: string };
    if (msg.command_type !== "Join") {
      return;
    }
    if (this.reply === "silent") {
      return;
    }
    queueMicrotask(() => {
      if (this.reply === "full") {
        this.emit({ type: "Error", code: "room_full" });
        return;
      }
      this.emit({ type: "Echo", participant_id: "p_g", lease: "lease-1" });
      this.emit({
        type: "Snapshot",
        snapshot: snapshotOf({ participants: [{ ...guest, ...joinedAs }] }),
      });
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

  closed = false;

  close() {
    this.closed = true;
  }
}

describe("useGuestRoom", () => {
  let sockets: FakeSocket[];
  let socketUrls: string[];
  let holdOpen = false;
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
        vi.fn(function (url: string) {
          socketUrls.push(url);
          const ws = new FakeSocket();
          ws.reply = reply;
          sockets.push(ws);
          if (!holdOpen) queueMicrotask(() => ws.onopen?.());
          return ws;
        }),
        { OPEN: 1, CONNECTING: 0, CLOSING: 2, CLOSED: 3 },
      ),
    );
  }

  beforeEach(() => {
    joinedAs = {};
    holdOpen = false;
    sockets = [];
    socketUrls = [];
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
    localStorage.setItem("sharecut.recordName", "Ava");
    stubFetch(guestBootstrap);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    expect(result.current.bootstrap).toBeNull();
    expect(result.current.name).toBe("Ava");
    await waitFor(() => expect(result.current.me?.participant_id).toBe("p_g"));
    expect(result.current.producer).toBe(false);
    expect(result.current.episodeName).toBe("Shot of Truth");
    expect(result.current.view).toBe("lobby");
    expect(sockets[0]?.commands("UpdateName")).toHaveLength(0);
  });

  it("keeps an upload in flight across unrelated roster updates and replaces credentials on lease or identity change", async () => {
    const reads: {
      signal: AbortSignal | null | undefined;
      headers: Headers;
      finish: (response: Response) => void;
    }[] = [];
    stubFetch(
      {
        ...guestBootstrap,
        build: { capture: false, monitor: false, upload: true },
      },
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!urlOf(input).includes("/upload"))
          return new Response("not found", { status: 404 });
        return new Promise<Response>((finish) => {
          reads.push({
            signal: init?.signal,
            headers: new Headers(init?.headers),
            finish,
          });
        });
      },
    );
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    await waitFor(() => expect(result.current.me?.participant_id).toBe("p_g"));
    act(() =>
      sockets[0]?.emit({
        type: "Snapshot",
        snapshot: snapshotOf({ participants: [{ ...guest, consented: true }] }),
      }),
    );
    await waitFor(() => expect(reads).toHaveLength(1));
    const first = result.current.uploadTransport;
    expect(first).not.toBeNull();
    expect(reads[0]?.signal?.aborted).toBe(false);
    expect(reads[0]?.headers.get("X-Record-Lease")).toBe("lease-1");
    act(() =>
      sockets[0]?.emit({
        type: "Snapshot",
        snapshot: snapshotOf({
          participants: [
            {
              ...guest,
              consented: true,
              display_name: "Ava updated",
              muted: true,
            },
          ],
        }),
      }),
    );
    await waitFor(() =>
      expect(result.current.me?.display_name).toBe("Ava updated"),
    );
    expect(result.current.uploadTransport).toBe(first);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.signal?.aborted).toBe(false);
    act(() =>
      sockets[0]?.emit({
        type: "Echo",
        participant_id: "p_g",
        lease: "lease-2",
      }),
    );
    await waitFor(() => expect(reads).toHaveLength(2));
    const second = result.current.uploadTransport;
    expect(second).not.toBe(first);
    expect(reads[0]?.signal?.aborted).toBe(true);
    expect(reads[1]?.headers.get("X-Record-Participant")).toBe("p_g");
    expect(reads[1]?.headers.get("X-Record-Lease")).toBe("lease-2");
    act(() => {
      sockets[0]?.emit({
        type: "Snapshot",
        snapshot: snapshotOf({
          participants: [
            { ...guest, participant_id: "p_new", consented: true },
          ],
        }),
      });
      sockets[0]?.emit({
        type: "Echo",
        participant_id: "p_new",
        lease: "lease-2",
      });
    });
    await waitFor(() => expect(reads).toHaveLength(3));
    expect(result.current.uploadTransport).not.toBe(second);
    expect(reads[1]?.signal?.aborted).toBe(true);
    expect(reads[2]?.headers.get("X-Record-Participant")).toBe("p_new");
    expect(reads[2]?.headers.get("X-Record-Lease")).toBe("lease-2");
    await act(async () => {
      for (const read of reads)
        read.finish(
          new Response(JSON.stringify({ segments: [] }), { status: 200 }),
        );
    });
  });

  it.each(["resolve", "reject"])(
    "retires an old bootstrap through committed token ABA on late %s while retaining local input",
    async (settlement) => {
      const requests: {
        signal: AbortSignal | null | undefined;
        resolve: (response: Response) => void;
        reject: (reason: unknown) => void;
      }[] = [];
      localStorage.setItem("sharecut.recordName", "Retained name");
      localStorage.setItem("record:a:mic", "retained-mic");
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          if (!urlOf(input).includes("/bootstrap"))
            return Promise.resolve(new Response("not found", { status: 404 }));
          return new Promise<Response>((resolve, reject) =>
            requests.push({ signal: init?.signal, resolve, reject }),
          );
        }),
      );
      const { result, rerender, unmount } = renderHook(
        ({ token }) => useGuestRoom(token),
        { initialProps: { token: "a" } },
      );
      expect(requests).toHaveLength(1);
      rerender({ token: "b" });
      expect(requests).toHaveLength(2);
      expect(requests[0]?.signal?.aborted).toBe(true);
      const reply = (token: string, name: string) =>
        new Response(
          JSON.stringify({
            ...guestBootstrap,
            token,
            episode: { name },
            build: { capture: false, monitor: false, upload: false },
          }),
          { status: 200 },
        );
      await act(async () => {
        requests[1]?.resolve(reply("b", "Room B"));
      });
      await waitFor(() => expect(result.current.episodeName).toBe("Room B"));
      expect(result.current.name).toBe("Retained name");
      expect(result.current.deviceId).toBe("retained-mic");
      rerender({ token: "a" });
      expect(requests).toHaveLength(3);
      expect(requests[1]?.signal?.aborted).toBe(true);
      expect(result.current.bootstrap).toBeNull();
      await act(async () => {
        requests[2]?.resolve(reply("a", "Fresh room A"));
      });
      await waitFor(() =>
        expect(result.current.episodeName).toBe("Fresh room A"),
      );
      await act(async () => {
        if (settlement === "resolve")
          requests[0]?.resolve(reply("a", "Retired room A"));
        else requests[0]?.reject(new Error("Retired failure"));
      });
      expect(result.current.episodeName).toBe("Fresh room A");
      expect(result.current.bootError).toBeNull();
      expect(result.current.name).toBe("Retained name");
      expect(result.current.deviceId).toBe("retained-mic");
      expect(getUserMedia).not.toHaveBeenCalled();
      unmount();
      expect(requests[2]?.signal?.aborted).toBe(true);
    },
  );

  it("reports a bootstrap failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    const { result } = renderHook(() => useGuestRoom("gone"));
    await waitFor(() => expect(result.current.bootError).toBe("not-found"));
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

  it("leave closes the room socket and releases the microphone", async () => {
    stubFetch(guestBootstrap);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    await waitFor(() => expect(result.current.me).not.toBeNull());
    act(() => result.current.mic.request());
    await waitFor(() => expect(result.current.mic.stream).not.toBeNull());
    const stream = await getUserMedia.mock.results[0]?.value;
    expect(result.current.left).toBe(false);
    expect(sockets[0]?.closed).toBe(false);

    act(() => result.current.leave());
    act(() => result.current.leave());

    expect(result.current.left).toBe(true);
    await waitFor(() => expect(sockets[0]?.closed).toBe(true));
    expect(stream.getTracks()[0].stop).toHaveBeenCalled();
    expect(result.current.mic.stream).toBeNull();
    expect(result.current.connected).toBe(false);
  });

  it("has no keeper identity before the first take and one once a take exists", async () => {
    stubFetch(guestBootstrap);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    await waitFor(() => expect(result.current.me?.participant_id).toBe("p_g"));
    expect(result.current.keeperIdentity).toBeNull();
    await act(async () => {
      sockets[0]?.emit({
        type: "Snapshot",
        snapshot: snapshotOf({ state: "stopped", take_index: 0 }),
      });
    });
    expect(result.current.keeperIdentity).toEqual({
      sessionId: "room1",
      participantId: "p_g",
      takeIndex: 0,
    });
  });

  describe("leaseFresh", () => {
    const DAY = 24 * 60 * 60 * 1000;

    async function leftRoom(entry: Record<string, unknown> | undefined) {
      vi.mocked(loadRecordParticipant).mockResolvedValue(
        entry as Awaited<ReturnType<typeof loadRecordParticipant>>,
      );
      stubFetch(guestBootstrap);
      const hook = renderHook(() => useGuestRoom("guest-tok"));
      await waitFor(() => expect(hook.result.current.me).not.toBeNull());
      return hook;
    }

    afterEach(() => {
      vi.mocked(loadRecordParticipant).mockResolvedValue(undefined);
    });

    it("is false before the page has left, and until the cached lease is read", async () => {
      const { result } = await leftRoom({
        participant_id: "p_g",
        lease: "l",
        issuedAt: Date.now() - DAY,
      });
      expect(result.current.leaseFresh).toBe(false);
      const held =
        deferred<Awaited<ReturnType<typeof loadRecordParticipant>>>();
      vi.mocked(loadRecordParticipant).mockReturnValue(held.promise);
      act(() => result.current.leave());
      expect(result.current.leaseFresh).toBe(false);
      await act(async () =>
        held.resolve({
          participant_id: "p_g",
          lease: "l",
          issuedAt: Date.now() - DAY,
        }),
      );
      expect(result.current.leaseFresh).toBe(true);
    });

    it("is true after leaving with a lease minted five days ago", async () => {
      const { result } = await leftRoom({
        participant_id: "p_g",
        lease: "l",
        issuedAt: Date.now() - 5 * DAY,
      });
      act(() => result.current.leave());
      await waitFor(() => expect(result.current.leaseFresh).toBe(true));
    });

    it("stays false after leaving with a lease older than six days", async () => {
      const { result } = await leftRoom({
        participant_id: "p_g",
        lease: "l",
        issuedAt: Date.now() - 6 * DAY - 60_000,
      });
      act(() => result.current.leave());
      await waitFor(() => expect(loadRecordParticipant).toHaveBeenCalled());
      await act(async () => undefined);
      expect(result.current.leaseFresh).toBe(false);
    });

    it("stays false for a cached lease with no issue time", async () => {
      const { result } = await leftRoom({ participant_id: "p_g", lease: "l" });
      act(() => result.current.leave());
      await act(async () => undefined);
      expect(result.current.leaseFresh).toBe(false);
    });
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

  it("sends the headphones choice once and the name once the participant is known", async () => {
    stubFetch(guestBootstrap);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    await waitFor(() => expect(result.current.me).not.toBeNull());
    expect(result.current.headphones).toBe("unset");
    expect(sockets[0]?.commands("HeadphonesAck")).toHaveLength(0);
    act(() => result.current.setHeadphones("off"));
    await act(async () => undefined);
    expect(sockets[0]?.commands("HeadphonesAck")).toHaveLength(0);
    act(() => result.current.setHeadphones("on"));
    await waitFor(() =>
      expect(sockets[0]?.commands("HeadphonesAck")).toHaveLength(1),
    );
    expect(sockets[0]?.commands("HeadphonesAck")[0]).toMatchObject({
      payload: { ok: true },
    });
    act(() => result.current.setName("Bea"));
    await waitFor(() =>
      expect(sockets[0]?.commands("UpdateName")).toHaveLength(1),
    );
    expect(localStorage.getItem("sharecut.recordName")).toBeNull();
  });

  it("sends a no only when the room does not already hold it", async () => {
    joinedAs = { headphones_ack: true };
    stubFetch(guestBootstrap);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    await waitFor(() => expect(result.current.me).not.toBeNull());
    act(() => result.current.setHeadphones("off"));
    await waitFor(() =>
      expect(sockets[0]?.commands("HeadphonesAck")).toHaveLength(1),
    );
    expect(sockets[0]?.commands("HeadphonesAck")[0]).toMatchObject({
      payload: { ok: false },
    });
  });

  it.each([
    [true, "on"],
    [false, "off"],
  ] as const)(
    "seeds the choice from a consented guest's ack %s without sending",
    async (ack, choice) => {
      joinedAs = { consented: true, headphones_ack: ack };
      stubFetch(guestBootstrap);
      const { result } = renderHook(() => useGuestRoom("guest-tok"));
      await waitFor(() => expect(result.current.headphones).toBe(choice));
      await act(async () => undefined);
      expect(sockets[0]?.commands("HeadphonesAck")).toHaveLength(0);
    },
  );

  it("resends an answer pressed while the socket was down", async () => {
    joinedAs = { consented: true, headphones_ack: false };
    stubFetch(guestBootstrap);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    await waitFor(() => expect(result.current.headphones).toBe("off"));
    act(() => {
      sockets[0]?.onclose?.({ code: 1006 });
    });
    act(() => result.current.setHeadphones("on"));
    await waitFor(() => expect(sockets).toHaveLength(2));
    await waitFor(() =>
      expect(sockets[1]?.commands("HeadphonesAck")).toEqual([
        expect.objectContaining({ payload: { ok: true } }),
      ]),
    );
    expect(sockets[0]?.commands("HeadphonesAck")).toHaveLength(0);
  });

  it("keeps a press made before the first snapshot over the seed", async () => {
    joinedAs = { consented: true, headphones_ack: false };
    stubFetch(guestBootstrap);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    act(() => result.current.setHeadphones("on"));
    await waitFor(() => expect(result.current.me).not.toBeNull());
    expect(result.current.headphones).toBe("on");
    await waitFor(() =>
      expect(sockets[0]?.commands("HeadphonesAck")).toEqual([
        expect.objectContaining({ payload: { ok: true } }),
      ]),
    );
  });

  it("leaves the choice unset for a guest who has not consented", async () => {
    joinedAs = { consented: null, headphones_ack: true };
    stubFetch(guestBootstrap);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    await waitFor(() => expect(result.current.me).not.toBeNull());
    expect(result.current.headphones).toBe("unset");
    expect(sockets[0]?.commands("HeadphonesAck")).toHaveLength(0);
  });

  it("prefills the name this device joined another room with", () => {
    localStorage.setItem("sharecut.recordName", "Ava");
    stubFetch(guestBootstrap);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    expect(result.current.name).toBe("Ava");
  });

  it("ignores a name stored under the old per-link key", () => {
    localStorage.setItem("record:guest-tok:name", "Old");
    stubFetch(guestBootstrap);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    expect(result.current.name).toBe("");
  });

  it("keeps the name on this device only once the room confirms the join", async () => {
    stubFetch(guestBootstrap);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    await waitFor(() => expect(result.current.me).not.toBeNull());
    act(() => result.current.setName("Bea"));
    expect(localStorage.getItem("sharecut.recordName")).toBeNull();
    act(() =>
      sockets[0]?.emit({
        type: "Snapshot",
        snapshot: snapshotOf({
          participants: [{ ...guest, consented: true }],
        }),
      }),
    );
    await waitFor(() =>
      expect(localStorage.getItem("sharecut.recordName")).toBe("Bea"),
    );
    expect(localStorage.getItem("podcast-mcp-guest-comment-name")).toBeNull();
  });

  it("keeps no name after Not now", async () => {
    stubFetch(guestBootstrap);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    await waitFor(() => expect(result.current.me).not.toBeNull());
    act(() => result.current.setName("Bea"));
    act(() =>
      sockets[0]?.emit({
        type: "Snapshot",
        snapshot: snapshotOf({
          participants: [{ ...guest, consented: false }],
        }),
      }),
    );
    await waitFor(() => expect(result.current.me?.consented).toBe(false));
    expect(localStorage.getItem("sharecut.recordName")).toBeNull();
  });

  it("keeps a remembered name off the socket and the Join hello until the guest acts", async () => {
    localStorage.setItem("sharecut.recordName", "Ava Okafor");
    stubFetch(guestBootstrap);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    expect(result.current.name).toBe("Ava Okafor");
    await waitFor(() => expect(result.current.me).not.toBeNull());
    expect(new URL(socketUrls[0]).searchParams.get("name")).toBe("Guest");
    expect(sockets[0]?.commands("Join")[0]).toMatchObject({
      payload: { display_name: "Guest" },
    });
    expect(sockets[0]?.commands("UpdateName")).toHaveLength(0);
  });

  it("sends the name typed in this room live", async () => {
    localStorage.setItem("sharecut.recordName", "Ava Okafor");
    stubFetch(guestBootstrap);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    await waitFor(() => expect(result.current.me).not.toBeNull());
    act(() => result.current.setName("Ava Okafor "));
    await waitFor(() =>
      expect(sockets[0]?.commands("UpdateName")).toEqual([
        expect.objectContaining({ payload: { display_name: "Ava Okafor" } }),
      ]),
    );
  });

  it("sends the remembered name when Join shares it", async () => {
    localStorage.setItem("sharecut.recordName", "Ava Okafor");
    stubFetch(guestBootstrap);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    await waitFor(() => expect(result.current.me).not.toBeNull());
    act(() => result.current.shareName());
    expect(sockets[0]?.commands("UpdateName")[0]).toMatchObject({
      payload: { display_name: "Ava Okafor" },
    });
  });

  it("sends the remembered name before Consent when Join is pressed before the first Echo", async () => {
    localStorage.setItem("sharecut.recordName", "Ava Okafor");
    stubSocket("silent");
    stubFetch(guestBootstrap);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    await waitFor(() => expect(sockets[0]?.commands("Join")).toHaveLength(1));
    expect(result.current.me).toBeNull();
    expect(sockets[0]?.commands("UpdateName")).toHaveLength(0);
    act(() => {
      result.current.shareName();
    });
    expect(sockets[0]?.commands("UpdateName")).toEqual([
      expect.objectContaining({ payload: { display_name: "Ava Okafor" } }),
    ]);
  });

  it("keeps the real name on every reconnect once the room holds this guest as joined", async () => {
    localStorage.setItem("sharecut.recordName", "Ava Okafor");
    stubFetch(guestBootstrap);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    await waitFor(() => expect(result.current.me).not.toBeNull());
    act(() =>
      sockets[0]?.emit({
        type: "Snapshot",
        snapshot: snapshotOf({
          participants: [{ ...guest, consented: true }],
        }),
      }),
    );
    await waitFor(() => expect(result.current.me?.consented).toBe(true));
    act(() => sockets[0]?.onclose?.({ code: 1006 }));
    await waitFor(() => expect(sockets).toHaveLength(2));
    expect(new URL(socketUrls[1]).searchParams.get("name")).toBe("Ava Okafor");
    expect(sockets[1]?.commands("Join")[0]).toMatchObject({
      payload: { display_name: "Ava Okafor" },
    });
  });

  it("sends the remembered name on the Join of a rejoin that carries the identity of a recording this device holds", async () => {
    localStorage.setItem("sharecut.recordName", "Ava");
    stubFetch(guestBootstrap);
    renderHook(() =>
      useGuestRoom("guest-tok", {
        carried: { sessionId: "room1", participantId: "p_g", takeIndex: 0 },
      }),
    );
    await waitFor(() => expect(sockets[0]?.commands("Join")).toHaveLength(1));
    expect(
      (
        JSON.parse(sockets[0]?.sent[0] ?? "{}") as {
          payload: { display_name: string };
        }
      ).payload.display_name,
    ).toBe("Ava");
  });

  it("lets the live snapshot's session, take and participant win over the carried identity", async () => {
    stubFetch(guestBootstrap);
    const { result } = renderHook(() =>
      useGuestRoom("guest-tok", {
        carried: { sessionId: "old", participantId: "p_old", takeIndex: 0 },
      }),
    );
    expect(result.current.keeperIdentity).toEqual({
      sessionId: "old",
      participantId: "p_old",
      takeIndex: 0,
    });
    await waitFor(() => expect(result.current.me?.participant_id).toBe("p_g"));
    await act(async () => {
      sockets[0]?.emit({
        type: "Snapshot",
        snapshot: snapshotOf({
          session_id: "room2",
          state: "recording",
          take_index: 1,
        }),
      });
    });
    expect(result.current.keeperIdentity).toEqual({
      sessionId: "room2",
      participantId: "p_g",
      takeIndex: 1,
    });
  });

  it("keeps the name off the Join when nothing is carried", async () => {
    localStorage.setItem("sharecut.recordName", "Ava");
    stubFetch(guestBootstrap);
    renderHook(() => useGuestRoom("guest-tok"));
    await waitFor(() => expect(sockets[0]?.commands("Join")).toHaveLength(1));
    expect(
      (
        JSON.parse(sockets[0]?.sent[0] ?? "{}") as {
          payload: { display_name: string };
        }
      ).payload.display_name,
    ).toBe("Guest");
  });

  it("keeps a remembered name off a reconnect when the guest never acted", async () => {
    localStorage.setItem("sharecut.recordName", "Ava Okafor");
    stubFetch(guestBootstrap);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    await waitFor(() => expect(result.current.me).not.toBeNull());
    act(() => sockets[0]?.onclose?.({ code: 1006 }));
    await waitFor(() => expect(sockets).toHaveLength(2));
    expect(new URL(socketUrls[1]).searchParams.get("name")).toBe("Guest");
    expect(sockets[1]?.commands("Join")[0]).toMatchObject({
      payload: { display_name: "Guest" },
    });
    expect(sockets[1]?.commands("UpdateName")).toHaveLength(0);
  });

  it("sends the remembered name once the room already holds this guest as joined", async () => {
    localStorage.setItem("sharecut.recordName", "Ava Okafor");
    stubFetch(guestBootstrap);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    await waitFor(() => expect(result.current.me).not.toBeNull());
    act(() =>
      sockets[0]?.emit({
        type: "Snapshot",
        snapshot: snapshotOf({
          participants: [{ ...guest, consented: true }],
        }),
      }),
    );
    await waitFor(() =>
      expect(sockets[0]?.commands("UpdateName")).toEqual([
        expect.objectContaining({ payload: { display_name: "Ava Okafor" } }),
      ]),
    );
  });

  it("removes the name an older build stored under this link", () => {
    localStorage.setItem("record:guest-tok:name", "Old");
    stubFetch(guestBootstrap);
    renderHook(() => useGuestRoom("guest-tok"));
    expect(localStorage.getItem("record:guest-tok:name")).toBeNull();
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

  it("rebuilds every finished take's own clipping from the keeper after a reload", async () => {
    stubFetch(guestBootstrap);
    const sink = new MemorySink();
    for (const takeIndex of [0, 1]) {
      const ids = { sessionId: "room1", participantId: "p_g", takeIndex };
      const wav = keeperWavPath({ ...ids, segmentIndex: 0 });
      await sink.write(wav, new Uint8Array(44));
      await sink.write(
        keeperMetaPath(wav),
        new TextEncoder().encode(
          JSON.stringify({
            ...ids,
            segmentIndex: 0,
            sampleRate: 48_000,
            joinOffsetMs: 0,
            samplesWritten: 4,
            complete: true,
            clippingRegions: [{ startMs: 1000 * (takeIndex + 1), endMs: 3000 }],
          }),
        ),
      );
    }
    vi.mocked(createOpfsSink).mockResolvedValue(sink);
    const { result } = renderHook(() => useGuestRoom("guest-tok"));
    await waitFor(() => expect(result.current.me).not.toBeNull());
    act(() =>
      sockets[0]?.emit({
        type: "Snapshot",
        snapshot: snapshotOf({
          state: "stopped",
          take_index: 1,
          participants: [{ ...guest, consented: true }],
        }),
      }),
    );
    await waitFor(() =>
      expect(Object.keys(result.current.takeClippings)).toEqual(["0", "1"]),
    );
    expect(result.current.takeClippings[0]?.regions[0]?.startMs).toBe(1000);
    expect(result.current.takeClippings[1]?.regions[0]?.startMs).toBe(2000);
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

  describe("declining before the room answers", () => {
    const consents = (socket: FakeSocket | undefined) =>
      socket
        ?.commands("Consent")
        .map(
          (row) =>
            (row as { payload?: { accepted?: boolean } }).payload?.accepted,
        );
    const commandOrder = (socket: FakeSocket) =>
      socket.sent.map(
        (row) => (JSON.parse(row) as { command_type: string }).command_type,
      );
    const hello = (
      socket: FakeSocket | undefined,
      consented: boolean | null = null,
      state = "lobby",
    ) => {
      socket?.emit({ type: "Echo", participant_id: "p_g", lease: "lease-1" });
      socket?.emit({
        type: "Snapshot",
        snapshot: snapshotOf({
          state,
          take_index: state === "lobby" ? -1 : 0,
          participants: [{ ...guest, consented }],
        }),
      });
    };
    const heldRoom = async () => {
      holdOpen = true;
      stubSocket("silent");
      stubFetch(guestBootstrap);
      const view = renderHook(() => useGuestRoom("guest-tok"));
      await waitFor(() => expect(sockets).toHaveLength(1));
      return view;
    };

    it("is declined with no socket and no snapshot, and the microphone stays off", async () => {
      const { result } = await heldRoom();
      expect(result.current.consented).toBeNull();
      act(() => result.current.declineHere());
      expect(result.current.consented).toBe(false);
      expect(result.current.me).toBeNull();
      act(() => result.current.mic.request());
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(result.current.mic.status).toBe("idle");
      expect(sockets[0]?.sent).toEqual([]);
    });

    it("releases a granted microphone on the same render", async () => {
      const { result } = await heldRoom();
      act(() => result.current.mic.request());
      await waitFor(() => expect(result.current.mic.stream).not.toBeNull());
      const stream = result.current.mic.stream as MediaStream;
      act(() => result.current.declineHere());
      expect(result.current.mic.stream).toBeNull();
      expect(stream.getTracks()[0].stop).toHaveBeenCalled();
    });

    it("sends Consent false once, after Join, and only once the Echo has come", async () => {
      const { result } = await heldRoom();
      act(() => result.current.declineHere());
      act(() => sockets[0]?.onopen?.());
      expect(commandOrder(sockets[0])).toEqual(["Join"]);
      act(() => hello(sockets[0]));
      await waitFor(() => expect(consents(sockets[0])).toEqual([false]));
      expect(commandOrder(sockets[0])).toEqual(["Join", "Consent"]);
    });

    it("sends nothing more once the room shows the decline, however many snapshots follow", async () => {
      const { result } = await heldRoom();
      act(() => result.current.declineHere());
      act(() => sockets[0]?.onopen?.());
      act(() => hello(sockets[0]));
      await waitFor(() => expect(consents(sockets[0])).toEqual([false]));
      for (let n = 0; n < 3; n += 1) {
        act(() =>
          sockets[0]?.emit({
            type: "Snapshot",
            snapshot: snapshotOf({
              participants: [{ ...guest, consented: false }],
            }),
          }),
        );
      }
      expect(consents(sockets[0])).toEqual([false]);
      expect(result.current.consented).toBe(false);
    });

    it("sends it again after a lobby reconnect cleared the room's copy, and stays declined throughout", async () => {
      const { result } = await heldRoom();
      act(() => result.current.declineHere());
      act(() => sockets[0]?.onopen?.());
      act(() => hello(sockets[0]));
      act(() =>
        sockets[0]?.emit({
          type: "Snapshot",
          snapshot: snapshotOf({
            participants: [{ ...guest, consented: false }],
          }),
        }),
      );
      await waitFor(() => expect(consents(sockets[0])).toEqual([false]));
      holdOpen = false;
      act(() => sockets[0]?.onclose?.({ code: 1006 }));
      expect(result.current.consented).toBe(false);
      await waitFor(() => expect(sockets).toHaveLength(2));
      await waitFor(() =>
        expect(commandOrder(sockets[1] as FakeSocket)).toEqual(["Join"]),
      );
      expect(consents(sockets[1])).toEqual([]);
      act(() => hello(sockets[1], null));
      await waitFor(() => expect(consents(sockets[1])).toEqual([false]));
      expect(result.current.consented).toBe(false);
    });

    it("does not send it again after a reconnect in a live take, where the room keeps the decline", async () => {
      const { result } = await heldRoom();
      act(() => result.current.declineHere());
      act(() => sockets[0]?.onopen?.());
      act(() => hello(sockets[0]));
      await waitFor(() => expect(consents(sockets[0])).toEqual([false]));
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
      holdOpen = false;
      act(() => sockets[0]?.onclose?.({ code: 1006 }));
      await waitFor(() => expect(sockets).toHaveLength(2));
      await waitFor(() => expect(sockets[1]?.commands("Join")).toHaveLength(1));
      act(() => hello(sockets[1], false, "recording"));
      expect(consents(sockets[1])).toEqual([]);
      expect(result.current.consented).toBe(false);
    });

    it.each([
      ["paused", false, []],
      ["stopped", null, [false]],
    ] as const)(
      "after a reconnect in a %s room, sends again exactly when the room's copy is gone",
      async (state, roomHolds, resent) => {
        const { result } = await heldRoom();
        act(() => result.current.declineHere());
        act(() => sockets[0]?.onopen?.());
        act(() => hello(sockets[0], null, state));
        await waitFor(() => expect(consents(sockets[0])).toEqual([false]));
        act(() =>
          sockets[0]?.emit({
            type: "Snapshot",
            snapshot: snapshotOf({
              state,
              take_index: 0,
              participants: [{ ...guest, consented: false }],
            }),
          }),
        );
        holdOpen = false;
        act(() => sockets[0]?.onclose?.({ code: 1006 }));
        await waitFor(() => expect(sockets).toHaveLength(2));
        await waitFor(() =>
          expect(sockets[1]?.commands("Join")).toHaveLength(1),
        );
        act(() => hello(sockets[1], roomHolds, state));
        await waitFor(() => expect(consents(sockets[1])).toEqual(resent));
        expect(result.current.consented).toBe(false);
      },
    );

    it("drops the decline when Join recording clears it before the socket opens", async () => {
      const { result } = await heldRoom();
      act(() => result.current.declineHere());
      act(() => result.current.clearDecline());
      expect(result.current.consented).toBeNull();
      act(() => sockets[0]?.onopen?.());
      act(() => hello(sockets[0]));
      await waitFor(() => expect(result.current.me).not.toBeNull());
      expect(consents(sockets[0])).toEqual([]);
    });

    it("never sends a second false after Join recording, even once the room echoes true", async () => {
      const { result } = await heldRoom();
      act(() => result.current.declineHere());
      act(() => sockets[0]?.onopen?.());
      act(() => hello(sockets[0]));
      await waitFor(() => expect(consents(sockets[0])).toEqual([false]));
      act(() =>
        sockets[0]?.emit({
          type: "Snapshot",
          snapshot: snapshotOf({
            participants: [{ ...guest, consented: false }],
          }),
        }),
      );
      act(() => result.current.clearDecline());
      act(() => {
        result.current.send("Consent", { accepted: true });
      });
      act(() =>
        sockets[0]?.emit({
          type: "Snapshot",
          snapshot: snapshotOf({
            participants: [{ ...guest, consented: true }],
          }),
        }),
      );
      await waitFor(() => expect(result.current.consented).toBe(true));
      expect(consents(sockets[0])).toEqual([false, true]);
    });

    it("sends a decline queued while Consent true is in flight", async () => {
      const { result } = await heldRoom();
      act(() => sockets[0]?.onopen?.());
      act(() => hello(sockets[0], true));
      await waitFor(() => expect(result.current.me?.consented).toBe(true));
      act(() => result.current.declineHere());
      expect(result.current.consented).toBe(false);
      await waitFor(() => expect(consents(sockets[0])).toEqual([false]));
    });

    it("sends nothing from a reconnect whose Join the room has not answered, though the old identity is still held", async () => {
      const { result } = await heldRoom();
      act(() => sockets[0]?.onopen?.());
      act(() => hello(sockets[0]));
      await waitFor(() => expect(result.current.me).not.toBeNull());
      act(() => result.current.declineHere());
      await waitFor(() => expect(consents(sockets[0])).toEqual([false]));
      holdOpen = false;
      act(() => sockets[0]?.onclose?.({ code: 1006 }));
      await waitFor(() => expect(sockets).toHaveLength(2));
      await waitFor(() => expect(sockets[1]?.commands("Join")).toHaveLength(1));
      expect(result.current.me).not.toBeNull();
      expect(result.current.connected).toBe(true);
      expect(consents(sockets[1])).toEqual([]);
    });

    it("sends nothing when the room is full", async () => {
      holdOpen = true;
      stubSocket("full");
      stubFetch(guestBootstrap);
      const { result } = renderHook(() => useGuestRoom("guest-tok"));
      await waitFor(() => expect(sockets).toHaveLength(1));
      act(() => result.current.declineHere());
      act(() => sockets[0]?.onopen?.());
      await waitFor(() => expect(result.current.error).toBe("room_full"));
      expect(consents(sockets[0])).toEqual([]);
    });

    it("sends nothing for a producer", async () => {
      holdOpen = true;
      stubSocket("silent");
      stubFetch(producerBootstrap);
      const { result } = renderHook(() => useGuestRoom("prod-tok"));
      await waitFor(() => expect(result.current.producer).toBe(true));
      act(() => result.current.declineHere());
      expect(sockets.flatMap((socket) => socket.commands("Consent"))).toEqual(
        [],
      );
    });

    it("discards a room-tone capture in flight when a decline is queued", async () => {
      holdOpen = true;
      stubSocket("silent");
      stubFetch({
        ...guestBootstrap,
        build: { capture: false, monitor: false, upload: true },
      });
      const { result } = renderHook(() => useGuestRoom("guest-tok"));
      await waitFor(() => expect(sockets).toHaveLength(1));
      act(() => sockets[0]?.onopen?.());
      act(() => hello(sockets[0], true));
      await waitFor(() => expect(result.current.me?.consented).toBe(true));
      act(() => result.current.mic.request());
      await waitFor(() => expect(result.current.mic.stream).not.toBeNull());
      await waitFor(() =>
        expect(result.current.roomTone.captureReady).toBe(true),
      );
      act(() => result.current.roomTone.record());
      expect(result.current.roomTone.status).toBe("capturing");
      act(() => result.current.declineHere());
      await waitFor(() => expect(result.current.roomTone.status).toBe("idle"));
    });

    it("routes a decline made while a take is on to the declined view before the room has heard it", async () => {
      const { result } = await heldRoom();
      act(() => sockets[0]?.onopen?.());
      act(() => hello(sockets[0], null, "recording"));
      await waitFor(() => expect(result.current.me).not.toBeNull());
      act(() => result.current.declineHere());
      expect(result.current.view).toBe("declined");
    });
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

    it("reads the device as unreadable while its storage cannot be opened, and not otherwise", async () => {
      const opening = deferred<MemorySink>();
      vi.mocked(createOpfsSink).mockReturnValueOnce(opening.promise);
      stubFetch(guestBootstrap);
      const { result } = renderHook(() => useGuestRoom("guest-tok"));
      await waitFor(() => expect(createOpfsSink).toHaveBeenCalledTimes(1));
      expect(result.current.localUnreadable).toBe(false);
      await act(async () => opening.reject(new Error("quota")));
      await waitFor(() =>
        expect(result.current.sinkError).toBe(UPLOAD_SINK_ERROR_COPY),
      );
      expect(result.current.localUnreadable).toBe(true);
      act(() => result.current.retryStorage());
      await waitFor(() => expect(result.current.sink).not.toBeNull());
      expect(result.current.localUnreadable).toBe(false);
    });

    it.each(["resolve", "reject"])(
      "retires an old storage initialization after retry on late %s",
      async (settlement) => {
        const old = deferred<MemorySink>();
        const fresh = deferred<MemorySink>();
        vi.mocked(createOpfsSink)
          .mockReturnValueOnce(old.promise)
          .mockReturnValueOnce(fresh.promise);
        stubFetch(guestBootstrap);
        const { result } = renderHook(() => useGuestRoom("guest-tok"));
        await waitFor(() => expect(createOpfsSink).toHaveBeenCalledTimes(1));
        act(() => result.current.retryStorage());
        await waitFor(() => expect(createOpfsSink).toHaveBeenCalledTimes(2));
        const accepted = new MemorySink();
        await act(async () => fresh.resolve(accepted));
        await waitFor(() => expect(result.current.sink).toBe(accepted));
        await act(async () => {
          if (settlement === "resolve") old.resolve(new MemorySink());
          else old.reject(new OpfsUnavailableError());
        });
        expect(result.current.sink).toBe(accepted);
        expect(result.current.sinkError).toBeNull();
        expect(getUserMedia).not.toHaveBeenCalled();
      },
    );

    it.each(["resolve", "reject"])(
      "retires storage eligibility on a producer transition before late %s",
      async (settlement) => {
        const old = deferred<MemorySink>();
        vi.mocked(createOpfsSink).mockReturnValueOnce(old.promise);
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async (input: RequestInfo | URL) =>
              new Response(
                JSON.stringify(
                  urlOf(input).includes("/prod-tok/")
                    ? producerBootstrap
                    : guestBootstrap,
                ),
                { status: 200 },
              ),
          ),
        );
        const { result, rerender } = renderHook(
          ({ token }) => useGuestRoom(token),
          { initialProps: { token: "guest-tok" } },
        );
        await waitFor(() => expect(createOpfsSink).toHaveBeenCalledTimes(1));
        rerender({ token: "prod-tok" });
        await waitFor(() => expect(result.current.producer).toBe(true));
        await act(async () => {
          if (settlement === "resolve") old.resolve(new MemorySink());
          else old.reject(new OpfsUnavailableError());
        });
        expect(result.current.sink).toBeNull();
        expect(result.current.sinkError).toBeNull();
        expect(createOpfsSink).toHaveBeenCalledTimes(1);
        expect(getUserMedia).not.toHaveBeenCalled();
      },
    );

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

  describe("room tone", () => {
    it("cancels a capture in flight when a take starts", async () => {
      stubFetch({
        ...guestBootstrap,
        build: { capture: false, monitor: false, upload: true },
      });
      const { result } = renderHook(() => useGuestRoom("guest-tok"));
      await waitFor(() => expect(result.current.me).not.toBeNull());
      act(() =>
        sockets[0]?.emit({
          type: "Snapshot",
          snapshot: snapshotOf({
            participants: [{ ...guest, consented: true }],
          }),
        }),
      );
      act(() => result.current.mic.request());
      await waitFor(() => expect(result.current.mic.stream).not.toBeNull());
      await waitFor(() =>
        expect(result.current.roomTone.captureReady).toBe(true),
      );
      act(() => result.current.roomTone.record());
      expect(result.current.roomTone.status).toBe("capturing");
      act(() =>
        sockets[0]?.emit({
          type: "Snapshot",
          snapshot: snapshotOf({
            state: "recording",
            take_index: 0,
            participants: [{ ...guest, consented: true }],
          }),
        }),
      );
      await waitFor(() => expect(result.current.roomTone.status).toBe("idle"));
    });
  });

  describe("producer", () => {
    it("is listen-only: no mic, no sink, one silent look at the room until joined", async () => {
      stubFetch(producerBootstrap);
      const { result } = renderHook(() => useGuestRoom("prod-tok"));
      await waitFor(() => expect(result.current.producer).toBe(true));
      await waitFor(() => expect(sockets).toHaveLength(1));
      const looking = new URL(socketUrls[0]);
      expect(looking.searchParams.get("observe")).toBe("1");
      expect(looking.searchParams.has("name")).toBe(false);
      expect(sockets[0]?.sent).toEqual([]);
      expect(result.current.socketMode).toBe("watch");
      expect(createOpfsSink).not.toHaveBeenCalled();
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(result.current.view).toBe("lobby");
      act(() => result.current.setName("Rosa"));
      expect(localStorage.getItem("sharecut.recordName")).toBeNull();
      act(() => result.current.setProducerJoined(true));
      await waitFor(() => expect(sockets[0]?.commands("Join")).toHaveLength(1));
      expect(sockets).toHaveLength(1);
      expect(result.current.socketMode).toBe("join");
      expect(localStorage.getItem("sharecut.recordName")).toBe("Rosa");
      expect(result.current.uploadTransport).toBeNull();
      expect(sockets[0]?.commands("HeadphonesAck")).toHaveLength(0);
    });

    it("ends the look on Not now and looks again when the sheet comes back", async () => {
      stubFetch(producerBootstrap);
      const { result } = renderHook(() => useGuestRoom("prod-tok"));
      await waitFor(() => expect(result.current.socketMode).toBe("watch"));
      await waitFor(() => expect(sockets).toHaveLength(1));
      act(() => result.current.setProducerDismissed(true));
      expect(result.current.socketMode).toBe("off");
      expect(sockets[0]?.closed).toBe(true);
      act(() => result.current.setProducerDismissed(false));
      await waitFor(() => expect(sockets).toHaveLength(2));
      expect(new URL(socketUrls[1]).searchParams.get("observe")).toBe("1");
    });
  });

  describe("the M key", () => {
    const press = () => {
      const event = new KeyboardEvent("keydown", {
        key: "m",
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        window.dispatchEvent(event);
      });
      return event;
    };
    const recording = (participants: unknown[]) =>
      snapshotOf({
        state: "recording",
        take_index: 0,
        recording_ms: 1000,
        participants: participants as (typeof guest)[],
      });

    it("is left alone on a producer page that has not joined", async () => {
      stubFetch(producerBootstrap);
      renderHook(() => useGuestRoom("prod-tok"));
      await waitFor(() => expect(sockets).toHaveLength(1));
      act(() =>
        sockets[0]?.emit({
          type: "Snapshot",
          snapshot: recording([{ ...guest, consented: true }]),
        }),
      );
      expect(press().defaultPrevented).toBe(false);
      expect(sockets[0]?.commands("Comment")).toHaveLength(0);
    });

    it("drops a marker once the producer is in the room", async () => {
      stubFetch(producerBootstrap);
      const { result } = renderHook(() => useGuestRoom("prod-tok"));
      await waitFor(() => expect(sockets).toHaveLength(1));
      act(() => result.current.setProducerJoined(true));
      await waitFor(() => expect(sockets[0]?.commands("Join")).toHaveLength(1));
      act(() => {
        sockets[0]?.emit({ type: "Echo", participant_id: "p_g", lease: "l" });
        sockets[0]?.emit({
          type: "Snapshot",
          snapshot: recording([
            { ...guest, role: "producer", consented: null },
          ]),
        });
      });
      await waitFor(() => expect(result.current.me).not.toBeNull());
      expect(press().defaultPrevented).toBe(true);
      expect(sockets[0]?.commands("Comment")).toHaveLength(1);
    });
  });

  describe("requestedRecordMode", () => {
    const base = {
      bootstrapped: true,
      producer: false,
      producerJoined: false,
      producerDismissed: false,
      left: false,
    };
    it.each([
      ["a guest", {}, "join"],
      ["a producer before the press", { producer: true }, "watch"],
      [
        "a producer who pressed Join to listen",
        { producer: true, producerJoined: true },
        "join",
      ],
      [
        "a producer who pressed Not now",
        { producer: true, producerDismissed: true },
        "off",
      ],
      ["a page that was left", { left: true }, "off"],
      ["a page with no room code yet", { bootstrapped: false }, "off"],
    ] as const)("is %s", (_who, patch, mode) => {
      expect(requestedRecordMode({ ...base, ...patch })).toBe(mode);
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

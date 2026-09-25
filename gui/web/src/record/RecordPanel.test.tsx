import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadHostRecordState } from "../api";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import {
  minimalProject,
  recordParticipant,
  recordSnapshot,
} from "../test/fixtures";
import { seedPendingKeeper } from "../test/keepers";
import { startBlockers } from "./blockers";
import { useRecordHostStore } from "./hostStore";
import {
  createOpfsSink,
  keeperMetaPath,
  MemorySink,
  OpfsUnavailableError,
  parseKeeperMeta,
} from "./keeper/store";
import {
  MIC_DENIED_COPY,
  MIC_DESKTOP_DENIED_COPY,
  MIC_RETRY_LABEL,
} from "./micPermission";
import { RecordPanel } from "./RecordPanel";
import { hostUploadLine, ROOM_TONE_PROMPT_COPY, storageLowCopy } from "./types";

const { exec, roomTone } = vi.hoisted(() => ({
  exec: vi.fn(async () => ({ status: "ok" as const })),
  roomTone: {
    status: "idle" as string,
    error: null as string | null,
    ready: false,
    captureReady: true,
    record: vi.fn(),
    skip: vi.fn(),
    retry: vi.fn(),
  },
}));

vi.mock("../commands/execute", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/execute")>();
  return { ...actual, execute: exec };
});

vi.mock("./useRoomToneCapture", () => ({
  useRoomToneCapture: () => ({
    status: roomTone.status,
    error: roomTone.error,
    ready: roomTone.ready,
    captureReady: roomTone.captureReady,
    record: roomTone.record,
    skip: roomTone.skip,
    retry: roomTone.retry,
  }),
}));

const send = vi.fn();

vi.mock("./hostWire", () => ({
  sendRecordHostCommand: (...args: unknown[]) => send(...args),
}));

const postTransport = vi.fn();

vi.mock("./hostTransport", () => ({
  submitHostRecordTransport: (...args: unknown[]) => postTransport(...args),
}));

vi.mock("./keeper/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./keeper/store")>();
  return {
    ...actual,
    createOpfsSink: vi.fn(async () => new actual.MemorySink()),
  };
});

const uploadStatus = vi.fn(async () => ({ segments: [] as Array<unknown> }));

vi.mock("../api", () => ({
  loadHostRecordState: vi.fn(async () => null),
  hostRecordUploadTransport: () => ({
    status: () => uploadStatus(),
    put: async () => ({
      acked: true,
      take_index: 0,
      participant_id: "p_host",
      segment_index: 0,
      part_seq: 0,
      file_ack: false,
    }),
  }),
}));

const avaGuest = () =>
  recordParticipant({
    participant_id: "p_g",
    role: "guest",
    display_name: "Ava",
  });

const lobby = recordSnapshot({
  session_id: "room1",
  state: "lobby",
  take_index: -1,
  recording_ms: 0,
  start_blockers: ["No one has joined"],
});

describe("RecordPanel", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, "storage");
  });

  beforeEach(() => {
    send.mockReset();
    exec.mockReset();
    exec.mockResolvedValue({ status: "ok" });
    postTransport.mockReset();
    postTransport.mockResolvedValue(undefined);
    uploadStatus.mockReset();
    uploadStatus.mockResolvedValue({ segments: [] });
    vi.mocked(loadHostRecordState).mockReset();
    vi.mocked(loadHostRecordState).mockResolvedValue(null);
    roomTone.status = "idle";
    roomTone.error = null;
    roomTone.ready = false;
    roomTone.captureReady = true;
    roomTone.record.mockReset();
    roomTone.skip.mockReset();
    roomTone.retry.mockReset();
    vi.mocked(createOpfsSink).mockReset();
    vi.mocked(createOpfsSink).mockResolvedValue(new MemorySink());
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.setState({ recordPanelOpen: true, shareDialogOpen: false });
    useRecordHostStore.getState().setSnapshot(null);
    useRecordHostStore.getState().setCaptureHealth(null);
    useRecordHostStore.getState().setKeeperStorage(null, null);
    useRecordHostStore.getState().setConnected(false);
  });

  it("disables Start with the no-one-joined reason", async () => {
    useRecordHostStore.getState().setSnapshot(lobby);
    const { container } = render(<RecordPanel />);
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    expect(await screen.findByText("No one has joined")).toBeInTheDocument();
    expect(screen.getByText(ROOM_TONE_PROMPT_COPY)).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("shows host microphone recovery and retries it", async () => {
    const onRetryMic = vi.fn();
    const { container } = render(
      <RecordPanel
        micError="permission blocked"
        micStatus="denied"
        onRetryMic={onRetryMic}
      />,
    );
    expect(screen.getByText(MIC_DENIED_COPY)).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: MIC_RETRY_LABEL });
    expect(retry).toHaveAttribute("aria-describedby");
    await userEvent.click(retry);
    expect(onRetryMic).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });

  it("reopens a closed active room on mic denial and keeps REC unhealthy until recovery", async () => {
    useRecordHostStore
      .getState()
      .setSnapshot({ ...lobby, state: "recording", take_index: 0 });
    useDawStore.setState({ recordPanelOpen: false });
    useRecordHostStore.getState().setCaptureHealth("failed");
    const { rerender } = render(
      <RecordPanel
        micStatus="denied"
        micError="Permission denied"
        onRetryMic={vi.fn()}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: "Record room" });
    expect(dialog).toHaveTextContent("REC: local capture failed");
    expect(screen.getByText(MIC_DENIED_COPY)).toBeVisible();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();

    act(() => useRecordHostStore.getState().setCaptureHealth(null));
    rerender(<RecordPanel micStatus="granted" stream={{} as MediaStream} />);
    expect(dialog).toHaveTextContent("REC");
    expect(dialog).not.toHaveTextContent("REC: local capture failed");
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
  });

  it("lets Copy links replace the held record panel and reopens it afterward", async () => {
    useRecordHostStore
      .getState()
      .setSnapshot({ ...lobby, state: "recording", take_index: 0 });
    useRecordHostStore.getState().setCaptureHealth("failed");
    render(<RecordPanel micStatus="denied" />);
    await userEvent.click(screen.getByRole("button", { name: "Copy links…" }));
    expect(useDawStore.getState().shareDialogOpen).toBe(true);
    expect(screen.queryByRole("dialog", { name: "Record room" })).toBeNull();
    act(() => useDawStore.getState().setShareDialogOpen(false));
    expect(screen.getByRole("dialog", { name: "Record room" })).toBeVisible();
  });

  it("releases the mic-loss hold after Stop", () => {
    useRecordHostStore
      .getState()
      .setSnapshot({ ...lobby, state: "recording", take_index: 0 });
    const { rerender } = render(<RecordPanel micLost />);
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    act(() =>
      useRecordHostStore
        .getState()
        .setSnapshot({ ...lobby, state: "stopped", take_index: 0 }),
    );
    rerender(<RecordPanel micLost />);
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
    expect(screen.queryByText(/Microphone disconnected/)).toBeNull();
  });

  it("warns when a stopped host take captured no keeper at all", async () => {
    useRecordHostStore.getState().setSnapshot({
      ...lobby,
      state: "stopped",
      take_index: 0,
      participants: [
        recordParticipant({ participant_id: "p_host", role: "host" }),
      ],
    });
    render(<RecordPanel micStatus="denied" />);
    expect(
      await screen.findByText(/No local keeper was captured/),
    ).toBeVisible();
  });

  it("shows operating-system recovery in the macOS desktop host panel", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
    });

    try {
      const { container } = render(
        <RecordPanel micStatus="denied" onRetryMic={() => undefined} />,
      );
      expect(screen.getByText(MIC_DESKTOP_DENIED_COPY)).toBeInTheDocument();
      await expectNoA11yViolations(container);
    } finally {
      delete (window as Window & { __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__;
      Reflect.deleteProperty(navigator, "userAgent");
    }
  });

  it("keeps Start disabled with an actionable storage error", async () => {
    vi.mocked(createOpfsSink).mockRejectedValueOnce(new Error("quota"));
    useRecordHostStore.getState().setSnapshot({
      ...lobby,
      start_blockers: [],
      participants: [avaGuest()],
    });
    render(<RecordPanel />);
    expect(
      await screen.findByText(
        "Local recording backup is unavailable. Check that this browser or app environment allows local storage, then retry.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Retry local backup" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start" })).toBeEnabled(),
    );
  });

  it("keeps Start disabled while the storage preflight is pending", async () => {
    let finish: (sink: MemorySink) => void = () => undefined;
    vi.mocked(createOpfsSink).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    useRecordHostStore.getState().setSnapshot({
      ...lobby,
      start_blockers: [],
      participants: [avaGuest()],
    });
    render(<RecordPanel />);
    expect(
      screen.getByText("Preparing local recording backup…"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    finish(new MemorySink());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start" })).toBeEnabled(),
    );
  });

  it("shows the specific OPFS copy when the storage API is missing", async () => {
    vi.mocked(createOpfsSink).mockRejectedValueOnce(new OpfsUnavailableError());
    useRecordHostStore.getState().setSnapshot({
      ...lobby,
      start_blockers: [],
      participants: [avaGuest()],
    });
    render(<RecordPanel />);
    expect(
      await screen.findByText(
        "Local recording backup is unavailable because this browser or app environment does not support OPFS. Use a compatible browser, then retry.",
      ),
    ).toBeInTheDocument();
  });

  it("dispatches host commands when enabled", async () => {
    useRecordHostStore.getState().setSnapshot({
      ...lobby,
      start_blockers: [],
      participants: [avaGuest()],
    });
    render(<RecordPanel />);
    expect(startBlockers(useRecordHostStore.getState().snapshot)).toEqual([]);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(postTransport).toHaveBeenCalledWith("Start");
  });

  it("warns about low storage without disabling Start", async () => {
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { estimate: vi.fn(async () => ({ usage: 0, quota: 1 })) },
    });
    useRecordHostStore.getState().setSnapshot({
      ...lobby,
      start_blockers: [],
      participants: [avaGuest()],
    });
    const { container } = render(<RecordPanel />);
    await waitFor(() =>
      expect(screen.getByText(storageLowCopy(0))).toBeVisible(),
    );
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
    await expectNoA11yViolations(container);
  });

  it("re-checks storage headroom when a take stops", async () => {
    const estimate = vi.fn(async () => ({ usage: 0, quota: 1 }));
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { estimate },
    });
    useRecordHostStore.getState().setSnapshot({
      ...lobby,
      state: "recording",
      start_blockers: [],
    });
    render(<RecordPanel />);
    await waitFor(() => expect(estimate).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(storageLowCopy(0))).toBeNull();
    useRecordHostStore.getState().setSnapshot({
      ...lobby,
      state: "stopped",
      start_blockers: [],
    });
    await waitFor(() => expect(estimate).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByText(storageLowCopy(0))).toBeVisible(),
    );
  });

  it("disables Start while room tone is capturing", () => {
    roomTone.status = "capturing";
    useRecordHostStore.getState().setSnapshot({
      ...lobby,
      start_blockers: [],
      participants: [avaGuest()],
    });
    render(<RecordPanel />);
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  });

  it("mutes the host from the room panel", async () => {
    useRecordHostStore.getState().setSnapshot({
      ...lobby,
      start_blockers: [],
      participants: [
        recordParticipant({
          participant_id: "p_host",
          role: "host",
          display_name: "Host",
        }),
      ],
    });
    render(<RecordPanel />);
    await userEvent.click(screen.getByLabelText("Mute"));
    expect(send).toHaveBeenCalledWith("SetMuted", { muted: true });
  });

  it("does not claim local capture while a keeper failure is visible", async () => {
    useRecordHostStore.getState().setSnapshot({
      ...lobby,
      state: "recording",
      take_index: 0,
      start_blockers: [],
    });
    const retry = vi.fn();
    const { container } = render(
      <RecordPanel
        recordingLocally
        hearing
        keeperError="OPFS unavailable"
        onRetryKeeper={retry}
      />,
    );
    expect(
      screen.queryByText("Recording locally on this device."),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Hearing the room.")).toBeInTheDocument();
    expect(screen.getByText(/OPFS unavailable/)).toBeInTheDocument();
    expect(screen.getByText("REC: local capture failed")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Retry local recording" }),
    );
    expect(retry).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });

  it("lets the host close the dialog while no audio is flagged", async () => {
    useRecordHostStore
      .getState()
      .setSnapshot({ ...lobby, state: "recording", take_index: 0 });
    useDawStore.setState({ recordPanelOpen: false });
    useRecordHostStore.getState().setCaptureHealth("silent");
    render(
      <RecordPanel
        micStatus="granted"
        stream={{} as MediaStream}
        recordingLocally
      />,
    );
    await screen.findByRole("dialog", { name: "Record room" });
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Record room" })).toBeNull(),
    );
    expect(useDawStore.getState().recordPanelOpen).toBe(false);
  });

  it("does not show REC: no audio while the microphone is lost", async () => {
    useRecordHostStore
      .getState()
      .setSnapshot({ ...lobby, state: "recording", take_index: 0 });
    useDawStore.setState({ recordPanelOpen: true });
    useRecordHostStore.getState().setCaptureHealth("silent");
    render(
      <RecordPanel
        micStatus="granted"
        stream={{} as MediaStream}
        recordingLocally
        micLost
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: "Record room" });
    expect(dialog).not.toHaveTextContent("REC: no audio");
    expect(dialog).not.toHaveTextContent("No audio is reaching the recorder.");
  });

  it("reopens on silent capture and offers Check mic", async () => {
    const check = vi.fn();
    useRecordHostStore
      .getState()
      .setSnapshot({ ...lobby, state: "recording", take_index: 0 });
    useDawStore.setState({ recordPanelOpen: false });
    useRecordHostStore.getState().setCaptureHealth("silent");
    const { container, rerender } = render(
      <RecordPanel
        micStatus="granted"
        stream={{} as MediaStream}
        recordingLocally
        onCheckMic={check}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: "Record room" });
    expect(dialog).toHaveTextContent("REC: no audio");
    expect(dialog).toHaveTextContent("No audio is reaching the recorder.");
    expect(dialog).not.toHaveTextContent("Recording locally on this device.");
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Check mic" }));
    expect(check).toHaveBeenCalledOnce();
    rerender(
      <RecordPanel
        micStatus="granted"
        stream={{} as MediaStream}
        recordingLocally
        onCheckMic={check}
        micCheckFailed
      />,
    );
    expect(dialog).toHaveTextContent("Still no audio");
    await expectNoA11yViolations(container);
  });

  it("offers microphone reconnect while host capture is lost", async () => {
    const retry = vi.fn();
    useRecordHostStore.getState().setSnapshot({
      ...lobby,
      state: "recording",
      take_index: 0,
      start_blockers: [],
    });
    render(<RecordPanel micLost onRetryMic={retry} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Reconnect microphone" }),
    );
    expect(retry).toHaveBeenCalledOnce();
  });

  it("shows denial guidance after a lost microphone fails to reconnect", async () => {
    const retry = vi.fn();
    useRecordHostStore
      .getState()
      .setSnapshot({ ...lobby, state: "recording", take_index: 0 });
    const { container } = render(
      <RecordPanel
        micLost
        micError="Permission denied"
        micStatus="denied"
        onRetryMic={retry}
      />,
    );
    expect(screen.getByText(MIC_DENIED_COPY)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reconnect microphone" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: MIC_RETRY_LABEL })).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("reopens and holds the host panel when the mic ends while it is closed", async () => {
    useRecordHostStore.getState().setSnapshot({
      ...lobby,
      state: "recording",
      take_index: 0,
      start_blockers: [],
    });
    useDawStore.setState({ recordPanelOpen: false });
    const { container } = render(<RecordPanel micLost onRetryMic={vi.fn()} />);
    await waitFor(() => {
      expect(useDawStore.getState().recordPanelOpen).toBe(true);
      expect(
        screen.getByRole("button", { name: "Reconnect microphone" }),
      ).toBeVisible();
    });
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Microphone disconnected. Local recording is paused.",
    );
    await expectNoA11yViolations(container);
  });

  it("shows every recorded participant's upload ACK after Stop", async () => {
    uploadStatus.mockResolvedValue({
      segments: [
        {
          take_index: 0,
          participant_id: "p_g",
          segment_index: 0,
          acked_parts: [0, 1],
          file_ack: true,
        },
        {
          take_index: 0,
          participant_id: "p_host",
          segment_index: 0,
          acked_parts: [0],
          file_ack: false,
        },
      ],
    });
    useRecordHostStore.getState().setSnapshot({
      ...lobby,
      state: "stopped",
      take_index: 0,
      start_blockers: [],
      participants: [
        recordParticipant({
          participant_id: "p_host",
          role: "host",
          display_name: "Host",
        }),
        avaGuest(),
      ],
    });
    render(<RecordPanel />);
    expect(
      await screen.findByText(hostUploadLine("Ava", true, 2)),
    ).toBeInTheDocument();
    expect(
      screen.getByText(hostUploadLine("Host", false, 1)),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
    const land = screen.getByRole("button", { name: "Land" });
    expect(land).toBeEnabled();
    await userEvent.click(land);
    expect(exec).toHaveBeenCalledWith("record.land", {}, { skipWhen: true });
  });

  describe("partial keeper recovery", () => {
    const stopped = recordSnapshot({
      ...lobby,
      state: "stopped",
      take_index: 0,
      start_blockers: [],
    });

    it("recovers the host keeper and resumes upload", async () => {
      const sink = new MemorySink();
      const wavPath = await seedPendingKeeper(sink, {
        sessionId: "room1",
        takeIndex: 0,
        participantId: "p_host",
      });
      vi.mocked(createOpfsSink).mockResolvedValue(sink);
      useRecordHostStore.getState().setSnapshot(stopped);
      const { container } = render(<RecordPanel />);
      const recover = await screen.findByRole("button", {
        name: "Recover partial take",
      });
      await userEvent.click(recover);
      expect(
        await screen.findByText(/Recovered 1 partial segment/),
      ).toBeInTheDocument();
      expect(
        parseKeeperMeta(await sink.read(keeperMetaPath(wavPath)))?.complete,
      ).toBe(true);
      // The retry nonce restarts the pump, which now uploads the segment.
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Recover partial take" }),
        ).toBeNull(),
      );
      await expectNoA11yViolations(container);
    });

    it("shows a failed recovery beside upload status, not as a storage error", async () => {
      const sink = new MemorySink();
      await seedPendingKeeper(sink, {
        sessionId: "room1",
        takeIndex: 0,
        participantId: "p_host",
      });
      sink.rewriteHeader = async () => {
        throw new Error("locked by another tab");
      };
      vi.mocked(createOpfsSink).mockResolvedValue(sink);
      useRecordHostStore.getState().setSnapshot(stopped);
      render(<RecordPanel />);
      await userEvent.click(
        await screen.findByRole("button", { name: "Recover partial take" }),
      );
      expect(
        await screen.findByText(/locked by another tab/),
      ).toBeInTheDocument();
      expect(useRecordHostStore.getState().keeperStorageError).toBeNull();
      expect(useRecordHostStore.getState().keeperSink).toBe(sink);
      expect(
        screen.queryByRole("button", { name: "Retry local backup" }),
      ).toBeNull();
    });
  });

  it("does not expect a local keeper when the host did not join the capture stream", async () => {
    useRecordHostStore.getState().setSnapshot({
      ...lobby,
      state: "stopped",
      take_index: 0,
      start_blockers: [],
    });
    render(<RecordPanel />);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(screen.queryByText(/No local keeper was captured/i)).toBeNull();
  });

  it("posts a live marker while recording", async () => {
    send.mockReturnValue(true);
    useRecordHostStore.getState().setSnapshot({
      ...lobby,
      state: "recording",
      take_index: 0,
      recording_ms: 1500,
      start_blockers: [],
      participants: [
        recordParticipant({
          participant_id: "p_host",
          role: "host",
          display_name: "Host",
        }),
      ],
    });
    render(<RecordPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Marker" }));
    expect(send).toHaveBeenCalledWith(
      "Comment",
      expect.objectContaining({
        body: "Marker",
        author: "p_host",
        take_index: 0,
      }),
      undefined,
    );
  });

  it("keeps Land enabled while a later take is recording", () => {
    useRecordHostStore.getState().setSnapshot({
      ...lobby,
      state: "recording",
      take_index: 1,
      start_blockers: [],
    });
    render(<RecordPanel />);
    expect(screen.getByRole("button", { name: "Land" })).toBeEnabled();
  });

  it("hides room tone capture while recording", () => {
    useRecordHostStore.getState().setSnapshot({
      ...lobby,
      state: "recording",
      take_index: 0,
      start_blockers: [],
    });
    render(<RecordPanel />);
    expect(screen.queryByText(ROOM_TONE_PROMPT_COPY)).toBeNull();
  });

  it("does not rehydrate on WS connected and skips stale HTTP snapshots", async () => {
    vi.mocked(loadHostRecordState).mockResolvedValue({
      ...lobby,
      server_time_ns: 1,
      state: "recording",
      take_index: 0,
      start_blockers: [],
    });
    useRecordHostStore.getState().setSnapshot({
      ...lobby,
      server_time_ns: 9,
      state: "paused",
      take_index: 0,
      pause_reason: "host_reconnect",
      host_offline_gap_ms: 15_000,
    });
    const { rerender } = render(<RecordPanel />);
    await screen.findByText(
      "Paused: the host was offline for 15s. Resume when everyone is ready.",
    );
    expect(loadHostRecordState).toHaveBeenCalledTimes(1);
    useRecordHostStore.getState().setConnected(true);
    rerender(<RecordPanel />);
    expect(loadHostRecordState).toHaveBeenCalledTimes(1);
    expect(useRecordHostStore.getState().snapshot?.state).toBe("paused");
  });

  it("surfaces host record state load errors", async () => {
    vi.mocked(loadHostRecordState).mockRejectedValue(new Error("state failed"));
    render(<RecordPanel />);
    expect(await screen.findByText("state failed")).toBeInTheDocument();
  });

  it("shows host-reconnect pause copy from live pause_reason", async () => {
    useRecordHostStore.getState().setSnapshot({
      ...lobby,
      state: "paused",
      take_index: 0,
      pause_reason: "host_reconnect",
      host_offline_gap_ms: 15_000,
      start_blockers: [],
      participants: [
        recordParticipant({
          participant_id: "p_host",
          role: "host",
          display_name: "Host",
        }),
      ],
    });
    const { container } = render(<RecordPanel />);
    expect(
      screen.getByText(
        "Paused: the host was offline for 15s. Resume when everyone is ready.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled();
    await expectNoA11yViolations(container);
  });
});

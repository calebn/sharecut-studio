import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadHostRecordState } from "../api";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { startBlockers } from "./blockers";
import { useRecordHostStore } from "./hostStore";
import {
  MIC_DENIED_COPY,
  MIC_DESKTOP_DENIED_COPY,
  MIC_RETRY_LABEL,
} from "./micPermission";
import { RecordPanel } from "./RecordPanel";
import {
  hostUploadLine,
  type RecordSnapshot,
  ROOM_TONE_PROMPT_COPY,
} from "./types";

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

const lobby: RecordSnapshot = {
  session_id: "room1",
  state: "lobby",
  take_index: -1,
  recording_ms: 0,
  start_blockers: ["No one has joined"],
  participants: [],
  caps: { recorded: 4, producers: 2 },
};

describe("RecordPanel", () => {
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
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.setState({ recordPanelOpen: true });
    useRecordHostStore.getState().setSnapshot(null);
    useRecordHostStore.getState().setConnected(false);
  });

  it("disables Start with the no-one-joined reason", async () => {
    useRecordHostStore.getState().setSnapshot(lobby);
    const { container } = render(<RecordPanel />);
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    expect(screen.getByText("No one has joined")).toBeInTheDocument();
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

  it("dispatches host commands when enabled", async () => {
    useRecordHostStore.getState().setSnapshot({
      ...lobby,
      start_blockers: [],
      participants: [
        {
          participant_id: "p_g",
          role: "guest",
          display_name: "Ava",
          connected: true,
          consented: true,
          muted: false,
          headphones_ack: true,
        },
      ],
    });
    render(<RecordPanel />);
    expect(startBlockers(useRecordHostStore.getState().snapshot)).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(postTransport).toHaveBeenCalledWith("Start");
  });

  it("disables Start while room tone is capturing", () => {
    roomTone.status = "capturing";
    useRecordHostStore.getState().setSnapshot({
      ...lobby,
      start_blockers: [],
      participants: [
        {
          participant_id: "p_g",
          role: "guest",
          display_name: "Ava",
          connected: true,
          consented: true,
          muted: false,
          headphones_ack: true,
        },
      ],
    });
    render(<RecordPanel />);
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  });

  it("mutes the host from the room panel", async () => {
    useRecordHostStore.getState().setSnapshot({
      ...lobby,
      start_blockers: [],
      participants: [
        {
          participant_id: "p_host",
          role: "host",
          display_name: "Host",
          connected: true,
          consented: true,
          muted: false,
          headphones_ack: true,
        },
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
    expect(screen.getByText("REC — local capture failed")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Retry local recording" }),
    );
    expect(retry).toHaveBeenCalledOnce();
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
        {
          participant_id: "p_host",
          role: "host",
          display_name: "Host",
          connected: true,
          consented: true,
          muted: false,
          headphones_ack: true,
        },
        {
          participant_id: "p_g",
          role: "guest",
          display_name: "Ava",
          connected: true,
          consented: true,
          muted: false,
          headphones_ack: true,
        },
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
        {
          participant_id: "p_host",
          role: "host",
          display_name: "Host",
          connected: true,
          consented: true,
          muted: false,
          headphones_ack: true,
        },
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
      "Paused — the host was offline for 15s. Resume when everyone is ready.",
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
        {
          participant_id: "p_host",
          role: "host",
          display_name: "Host",
          connected: true,
          consented: true,
          muted: false,
          headphones_ack: true,
        },
      ],
    });
    const { container } = render(<RecordPanel />);
    expect(
      screen.getByText(
        "Paused — the host was offline for 15s. Resume when everyone is ready.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled();
    await expectNoA11yViolations(container);
  });
});

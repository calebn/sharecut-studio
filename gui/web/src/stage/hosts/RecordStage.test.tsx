import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadHostRecordState } from "../../api";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { HostRoomProvider } from "../../record/hostRoomContext";
import { useRecordHostStore } from "../../record/hostStore";
import {
  createOpfsSink,
  keeperMetaPath,
  MemorySink,
  OpfsUnavailableError,
  parseKeeperMeta,
} from "../../record/keeper/store";
import { MIC_DENIED_COPY, MIC_RETRY_LABEL } from "../../record/micPermission";
import {
  RECORD_ROOM_RECONNECTING_COPY,
  ROOM_TONE_PROMPT_COPY,
  storageLowCopy,
} from "../../record/types";
import { type HostRoomCapture, useHostRoom } from "../../record/useHostRoom";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import {
  minimalProject,
  recordParticipant,
  recordSnapshot,
} from "../../test/fixtures";
import { seedPendingKeeper } from "../../test/keepers";
import { stubViewportShell } from "../../test/viewportShell";
import { RecordStage } from "./RecordStage";

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

vi.mock("../../commands/execute", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../commands/execute")>();
  return { ...actual, execute: exec };
});

vi.mock("../../record/useRoomToneCapture", () => ({
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

vi.mock("../../record/useInputPeakDb", () => ({
  useInputPeakDb: () => ({
    levelDb: Number.NEGATIVE_INFINITY,
    peakHoldDb: Number.NEGATIVE_INFINITY,
    clipped: false,
    suspended: false,
    resume: () => undefined,
    clearClip: () => undefined,
  }),
}));

const send = vi.fn();

vi.mock("../../record/hostWire", () => ({
  sendRecordHostCommand: (...args: unknown[]) => send(...args),
}));

const postTransport = vi.fn();

vi.mock("../../record/hostTransport", () => ({
  submitHostRecordTransport: (...args: unknown[]) => postTransport(...args),
}));

vi.mock("../../record/keeper/store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../record/keeper/store")>();
  return {
    ...actual,
    createOpfsSink: vi.fn(async () => new actual.MemorySink()),
  };
});

const uploadStatus = vi.fn(async () => ({ segments: [] as Array<unknown> }));

vi.mock("../../api", () => ({
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

const hostPerson = () =>
  recordParticipant({
    participant_id: "p_host",
    role: "host",
    display_name: "Host",
  });

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
  start_blockers: [],
});

function Harness({ capture = {} }: { capture?: HostRoomCapture }) {
  const room = useHostRoom(capture, { hydrate: true });
  return (
    <HostRoomProvider value={room}>
      <main>
        <RecordStage />
      </main>
    </HostRoomProvider>
  );
}

const mount = (capture: HostRoomCapture = {}) =>
  render(<Harness capture={capture} />);

const setRoom = (patch: Partial<ReturnType<typeof recordSnapshot>> = {}) =>
  useRecordHostStore.getState().setSnapshot({ ...lobby, ...patch });

const record = () => screen.getByRole("button", { name: "Record" });

async function openMore() {
  await userEvent.click(screen.getByRole("button", { name: "More" }));
  return screen.findByRole("dialog", { name: "More" });
}

async function openDevices() {
  const more = await openMore();
  await userEvent.click(within(more).getByRole("button", { name: "Devices…" }));
  return screen.findByRole("dialog", { name: "Devices" });
}

beforeEach(() => {
  stubViewportShell("desktop");
  clearRegisteredCommands();
  registerDawCommands();
  send.mockReset();
  exec.mockReset();
  exec.mockResolvedValue({ status: "ok" });
  postTransport.mockReset();
  uploadStatus.mockReset();
  uploadStatus.mockResolvedValue({ segments: [] });
  vi.mocked(loadHostRecordState).mockReset();
  vi.mocked(loadHostRecordState).mockImplementation(
    async () => useRecordHostStore.getState().snapshot,
  );
  roomTone.status = "idle";
  roomTone.error = null;
  roomTone.ready = false;
  roomTone.captureReady = true;
  roomTone.record.mockReset();
  vi.mocked(createOpfsSink).mockReset();
  vi.mocked(createOpfsSink).mockResolvedValue(new MemorySink());
  useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  useDawStore.setState({ stage: "record" });
  const store = useRecordHostStore.getState();
  store.setSnapshot(null);
  store.setTransportError(null);
  store.setConnected(true);
  store.setCaptureHealth(null);
  store.setKeeperStorage(null, null);
  store.resetConnection();
  store.setTakeClipping(null);
});

afterEach(() => {
  useRecordHostStore.getState().resetConnection();
  Reflect.deleteProperty(navigator, "storage");
  clearRegisteredCommands();
});

describe("Record stage", () => {
  it("mounts inside the shell without its own heading or landmarks", async () => {
    setRoom({ participants: [hostPerson(), avaGuest()] });
    const { baseElement } = mount();
    await waitFor(() => expect(record()).toBeEnabled());
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.queryByRole("contentinfo")).toBeNull();
    expect(
      screen.getByRole("group", { name: "Recording controls" }),
    ).toBeVisible();
    await expectNoA11yViolations(baseElement);
  });

  it("does not make a host alone in the room wait for a guest", async () => {
    setRoom({ participants: [hostPerson()] });
    const { baseElement } = mount();
    await waitFor(() => expect(record()).toBeEnabled());
    expect(record()).not.toHaveAccessibleDescription(/guest/i);
    await expectNoA11yViolations(baseElement);
  });

  it("disables Record with Joining the room while nobody recorded is in", async () => {
    setRoom({ participants: [], start_blockers: [{ code: "no_recorder" }] });
    mount();
    await waitFor(() =>
      expect(record()).toHaveAccessibleDescription("Joining the room."),
    );
    expect(record()).toBeDisabled();
  });

  it("names each guest Record is waiting for", async () => {
    setRoom({
      participants: [avaGuest()],
      start_blockers: [
        { code: "consent_pending", participant_id: "p_g", display_name: "Ava" },
      ],
    });
    mount();
    await waitFor(() =>
      expect(record()).toHaveAccessibleDescription(
        "Waiting for Ava to accept recording.",
      ),
    );
  });

  it("creates a record room in place when none exists", async () => {
    const { baseElement } = mount();
    const create = await screen.findByRole("button", {
      name: "Create record room",
    });
    expect(screen.getByText("No record room yet")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Record" }),
    ).not.toBeInTheDocument();
    exec.mockImplementationOnce(async () => {
      useDawStore
        .getState()
        .announceStatus("Record room created and guest link copied");
      useRecordHostStore.getState().setSnapshot(lobby);
      return { status: "ok" as const };
    });
    await userEvent.click(create);
    expect(exec).toHaveBeenCalledWith(
      "record.createRoom",
      {},
      { skipWhen: true },
    );
    await waitFor(() => expect(record()).toBeVisible());
    await expectNoA11yViolations(baseElement);
  });

  it("drops a stale room once the server says it has ended", async () => {
    setRoom();
    vi.mocked(loadHostRecordState).mockResolvedValue(null);
    mount();
    expect(
      await screen.findByRole("button", { name: "Create record room" }),
    ).toBeInTheDocument();
    expect(useRecordHostStore.getState().snapshot).toBeNull();
  });

  it("surfaces host record state load errors and checks again", async () => {
    vi.mocked(loadHostRecordState).mockRejectedValue(new Error("state failed"));
    mount();
    expect(await screen.findByText("state failed")).toBeInTheDocument();
    vi.mocked(loadHostRecordState).mockResolvedValue(null);
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(
      await screen.findByRole("button", { name: "Create record room" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("state failed")).not.toBeInTheDocument();
  });

  it("renders a host record command failure from the store", () => {
    useRecordHostStore.getState().setTransportError("Room is not ready");
    mount();
    expect(screen.getByText("Room is not ready")).toBeInTheDocument();
  });

  it("shows a command failure as a room alert that can be dismissed", async () => {
    setRoom({ participants: [hostPerson()] });
    useRecordHostStore.getState().setTransportError("Stop failed");
    mount();
    expect(await screen.findByText("Stop failed")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(useRecordHostStore.getState().transportError).toBeNull();
  });

  it("clears a stored command failure when the project changes", () => {
    useRecordHostStore.getState().setTransportError("Stop failed");
    mount();
    act(() =>
      useDawStore.getState().hydrate("/tmp/other.json", minimalProject()),
    );
    expect(useRecordHostStore.getState().transportError).toBeNull();
  });

  it("does not rehydrate on WS connected and skips stale HTTP snapshots", async () => {
    vi.mocked(loadHostRecordState).mockResolvedValue({
      ...lobby,
      server_time_ns: 1,
      state: "recording",
      take_index: 0,
    });
    setRoom({
      server_time_ns: 9,
      state: "paused",
      take_index: 0,
      pause_reason: "host_reconnect",
      host_offline_gap_ms: 15_000,
    });
    mount();
    await screen.findByText(
      "Paused: the host was offline for 15s. Resume when everyone is ready.",
    );
    expect(loadHostRecordState).toHaveBeenCalledTimes(1);
    act(() => useRecordHostStore.getState().setConnected(true));
    expect(loadHostRecordState).toHaveBeenCalledTimes(1);
    expect(useRecordHostStore.getState().snapshot?.state).toBe("paused");
  });

  it("shows host-reconnect pause copy and offers Resume", async () => {
    setRoom({
      state: "paused",
      take_index: 0,
      pause_reason: "host_reconnect",
      host_offline_gap_ms: 15_000,
      participants: [hostPerson()],
    });
    const { baseElement } = mount();
    expect(
      screen.getByText(
        "Paused: the host was offline for 15s. Resume when everyone is ready.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Resume recording" }),
    ).toBeEnabled();
    await expectNoA11yViolations(baseElement);
  });

  it("shows reconnecting copy when the host socket drops mid-take", () => {
    setRoom({ state: "recording", take_index: 0 });
    useRecordHostStore.getState().setConnected(true);
    useRecordHostStore.getState().setConnected(false);
    mount();
    expect(screen.getByText(RECORD_ROOM_RECONNECTING_COPY)).toBeInTheDocument();
  });

  it("does not claim a reconnect before the host socket first opens", () => {
    setRoom({ state: "recording", take_index: 0 });
    mount();
    expect(screen.queryByText(RECORD_ROOM_RECONNECTING_COPY)).toBeNull();
  });
});

describe("Record stage capture and storage", () => {
  it("keeps Record disabled with an actionable storage error", async () => {
    vi.mocked(createOpfsSink).mockRejectedValueOnce(new Error("quota"));
    setRoom({ participants: [avaGuest()] });
    mount();
    const message =
      "This device can't store your full-quality recording. Check that this browser or app allows local storage, then retry.";
    expect(await screen.findAllByText(message)).not.toHaveLength(0);
    expect(record()).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Retry recording" }),
    );
    await waitFor(() => expect(record()).toBeEnabled());
  });

  it("keeps Record disabled while the storage preflight is pending", async () => {
    let finish: (sink: MemorySink) => void = () => undefined;
    vi.mocked(createOpfsSink).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    setRoom({ participants: [avaGuest()] });
    mount();
    expect(record()).toBeDisabled();
    expect(record()).toHaveAccessibleDescription(
      "Preparing device storage for your full-quality recording…",
    );
    finish(new MemorySink());
    await waitFor(() => expect(record()).toBeEnabled());
  });

  it("shows the specific OPFS copy when the storage API is missing", async () => {
    vi.mocked(createOpfsSink).mockRejectedValueOnce(new OpfsUnavailableError());
    setRoom({ participants: [avaGuest()] });
    mount();
    expect(
      (
        await screen.findAllByText(
          "This device can't store your full-quality recording because this browser or app does not support private file storage. Use a compatible browser, then retry.",
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it("warns about low storage without disabling Record", async () => {
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { estimate: vi.fn(async () => ({ usage: 0, quota: 1 })) },
    });
    setRoom({ participants: [avaGuest()] });
    const { baseElement } = mount();
    await waitFor(() =>
      expect(screen.getByText(storageLowCopy(0))).toBeVisible(),
    );
    expect(record()).toBeEnabled();
    await expectNoA11yViolations(baseElement);
  });

  it("re-checks storage headroom when a take stops", async () => {
    const estimate = vi.fn(async () => ({ usage: 0, quota: 1 }));
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { estimate },
    });
    setRoom({ state: "recording", take_index: 0 });
    mount();
    await waitFor(() => expect(estimate).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(storageLowCopy(0))).toBeNull();
    act(() => setRoom({ state: "stopped", take_index: 0 }));
    await waitFor(() => expect(estimate).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByText(storageLowCopy(0))).toBeVisible(),
    );
  });

  it("disables Record while room tone is capturing", async () => {
    roomTone.status = "capturing";
    setRoom({ participants: [avaGuest()] });
    mount();
    expect(record()).toBeDisabled();
    await waitFor(() =>
      expect(record()).toHaveAccessibleDescription(
        "Recording room tone. Start is available when it finishes.",
      ),
    );
  });

  it("offers room tone in Devices and holds it during a take", async () => {
    setRoom({ participants: [avaGuest()] });
    const { unmount } = mount({ stream: {} as MediaStream });
    await openDevices();
    await userEvent.click(
      screen.getByRole("button", { name: ROOM_TONE_PROMPT_COPY }),
    );
    expect(roomTone.record).toHaveBeenCalledOnce();
    unmount();
    setRoom({ state: "recording", take_index: 0 });
    mount({ stream: {} as MediaStream });
    await openDevices();
    expect(
      screen.getByRole("button", { name: ROOM_TONE_PROMPT_COPY }),
    ).toBeDisabled();
  });

  it("opens Devices from the host's own tile and from More", async () => {
    setRoom({ participants: [hostPerson()] });
    mount({ stream: {} as MediaStream });
    await userEvent.click(screen.getByRole("button", { name: "Devices" }));
    await screen.findByRole("dialog", { name: "Devices" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Devices" })).toBeNull(),
    );
    await openDevices();
  });

  it("picks the host's input, and locks it while a take is live", async () => {
    const devices = [
      { deviceId: "a", label: "USB Mic", kind: "audioinput" },
      { deviceId: "b", label: "Headset", kind: "audioinput" },
    ] as MediaDeviceInfo[];
    const onDeviceChange = vi.fn();
    const capture = {
      stream: {} as MediaStream,
      micStatus: "granted" as const,
      devices,
      deviceId: "a",
      onDeviceChange,
    };
    setRoom({ participants: [hostPerson()] });
    const { unmount } = mount(capture);
    await openDevices();
    await userEvent.selectOptions(screen.getByLabelText("Input"), "b");
    expect(onDeviceChange).toHaveBeenCalledWith("b");
    unmount();
    setRoom({
      state: "recording",
      take_index: 0,
      participants: [hostPerson()],
    });
    mount(capture);
    await openDevices();
    expect(screen.getByLabelText("Input")).toBeDisabled();
  });

  it("offers Retry in Devices when the host mic is denied", async () => {
    const onRetryMic = vi.fn();
    setRoom({ participants: [hostPerson()] });
    mount({ micStatus: "denied", onRetryMic });
    await openDevices();
    const dialog = screen.getByRole("dialog", { name: "Devices" });
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "How to allow the microphone",
      }),
    );
    expect(onRetryMic).toHaveBeenCalledOnce();
    expect(within(dialog).getByText(MIC_DENIED_COPY)).toBeVisible();
  });

  it("keeps the input locked while Stop's keeper flush settles", async () => {
    const devices = [
      { deviceId: "a", label: "USB Mic", kind: "audioinput" },
      { deviceId: "b", label: "Headset", kind: "audioinput" },
    ] as MediaDeviceInfo[];
    const capture = {
      stream: {} as MediaStream,
      micStatus: "granted" as const,
      devices,
      deviceId: "a",
    };
    setRoom({
      state: "stopped",
      take_index: 0,
      participants: [hostPerson()],
    });
    const { unmount } = mount({ ...capture, keeperFinalizing: true });
    await openDevices();
    expect(screen.getByLabelText("Input")).toBeDisabled();
    unmount();
    mount(capture);
    await openDevices();
    expect(screen.getByLabelText("Input")).toBeEnabled();
  });

  it("closes Devices when the room goes away, so the next room starts without it", async () => {
    setRoom({ participants: [hostPerson()] });
    mount({ stream: {} as MediaStream });
    await openDevices();
    act(() => useRecordHostStore.getState().setSnapshot(null));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Devices" })).toBeNull(),
    );
    act(() => setRoom({ participants: [hostPerson()] }));
    await screen.findByRole("button", { name: "More" });
    expect(screen.queryByRole("dialog", { name: "Devices" })).toBeNull();
  });

  it("shows microphone denial guidance and retries it", async () => {
    const onRetryMic = vi.fn();
    setRoom({ participants: [hostPerson()] });
    const { baseElement } = mount({
      micError: "permission blocked",
      micStatus: "denied",
      onRetryMic,
    });
    expect(screen.getByText(MIC_DENIED_COPY)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: MIC_RETRY_LABEL }),
    );
    expect(onRetryMic).toHaveBeenCalledOnce();
    await expectNoA11yViolations(baseElement);
  });

  it("offers microphone reconnect while host capture is lost", async () => {
    const retry = vi.fn();
    setRoom({ state: "recording", take_index: 0 });
    mount({ micLost: true, onRetryMic: retry });
    expect(screen.getByText("Your mic stopped.")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Reconnect mic" }),
    );
    expect(retry).toHaveBeenCalledOnce();
  });

  it("releases the mic-loss alert after Stop", () => {
    setRoom({ state: "recording", take_index: 0 });
    const { rerender } = render(<Harness capture={{ micLost: true }} />);
    expect(screen.getByText("Your mic stopped.")).toBeVisible();
    act(() => setRoom({ state: "stopped", take_index: 0 }));
    rerender(<Harness capture={{ micLost: true }} />);
    expect(screen.queryByText("Your mic stopped.")).toBeNull();
  });

  it("does not show no-audio while the microphone is lost", () => {
    setRoom({ state: "recording", take_index: 0 });
    useRecordHostStore.getState().setCaptureHealth("silent");
    mount({ micLost: true, stream: {} as MediaStream, recordingLocally: true });
    expect(screen.queryByText("No sound is reaching the recorder.")).toBeNull();
    expect(screen.getByText("Your mic stopped.")).toBeVisible();
  });

  it("flags silent capture and offers Check mic", async () => {
    const check = vi.fn();
    setRoom({ state: "recording", take_index: 0 });
    useRecordHostStore.getState().setCaptureHealth("silent");
    const { baseElement } = mount({
      micStatus: "granted",
      stream: {} as MediaStream,
      recordingLocally: true,
      onCheckMic: check,
    });
    expect(
      screen.getByText("No sound is reaching the recorder."),
    ).toBeVisible();
    expect(
      screen.queryByText("Recording in full quality on this device."),
    ).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Check mic" }));
    expect(check).toHaveBeenCalledOnce();
    await expectNoA11yViolations(baseElement);
  });

  it("does not claim local capture while a keeper failure is visible", async () => {
    setRoom({ state: "recording", take_index: 0 });
    const retry = vi.fn();
    const { baseElement } = mount({
      recordingLocally: true,
      hearing: true,
      keeperError: "OPFS unavailable",
      onRetryKeeper: retry,
    });
    expect(
      screen.queryByText("Recording in full quality on this device."),
    ).toBeNull();
    expect(screen.getByText("Hearing the room.")).toBeInTheDocument();
    expect(screen.getByText(/OPFS unavailable/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Retry recording" }),
    );
    expect(retry).toHaveBeenCalledOnce();
    await expectNoA11yViolations(baseElement);
  });

  it("warns when a stopped host take captured no keeper at all", async () => {
    setRoom({
      state: "stopped",
      take_index: 0,
      participants: [hostPerson()],
    });
    mount({ micStatus: "denied" });
    expect(
      await screen.findByText(/No full-quality recording was captured/),
    ).toBeVisible();
  });

  it("does not expect a local keeper when the host did not join the capture stream", async () => {
    setRoom({ state: "stopped", take_index: 0 });
    mount();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(
      screen.queryByText(/No full-quality recording was captured/i),
    ).toBeNull();
  });

  it("explains a removed participant's closed invite in More", async () => {
    setRoom({
      participants: [
        recordParticipant({
          participant_id: "p_g",
          role: "guest",
          removed: true,
        }),
      ],
    });
    mount();
    const dialog = await openMore();
    expect(
      within(dialog).getByText(
        /A removed participant’s invite is closed to new participants/,
      ),
    ).toBeVisible();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Invite and links…" }),
    );
    expect(useDawStore.getState().chrome.shareDialogOpen).toBe(true);
  });
});

describe("Record stage take controls", () => {
  it("dispatches host commands when enabled", async () => {
    setRoom({ participants: [avaGuest()] });
    mount();
    await waitFor(() => expect(record()).toBeEnabled());
    await userEvent.click(record());
    expect(exec).toHaveBeenCalledWith("record.start", {}, { skipWhen: true });
  });

  it("keeps transport busy until the record command settles", async () => {
    let resolveCommand!: (value: { status: "ok" }) => void;
    const pendingCommand = new Promise<{ status: "ok" }>((resolve) => {
      resolveCommand = resolve;
    });
    exec.mockReturnValueOnce(pendingCommand);
    setRoom({ participants: [avaGuest()] });
    mount();
    await waitFor(() => expect(record()).toBeEnabled());
    await userEvent.click(record());
    await waitFor(() => expect(record()).toBeDisabled());
    expect(exec).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveCommand({ status: "ok" });
      await pendingCommand;
    });
    await waitFor(() => expect(record()).toBeEnabled());
  });

  it("follows the room state between Record, Stop and Resume", () => {
    setRoom({ state: "recording", take_index: 0 });
    mount();
    expect(screen.getByRole("button", { name: "Stop take" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Pause take" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.queryByRole("button", { name: "Record" })).toBeNull();
    act(() => setRoom({ state: "paused", take_index: 0 }));
    expect(
      screen.getByRole("button", { name: "Resume recording" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Pause take" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("pauses and resumes through the record commands", async () => {
    setRoom({ state: "recording", take_index: 0 });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Pause take" }));
    expect(exec).toHaveBeenCalledWith("record.pause", {}, { skipWhen: true });
    act(() => setRoom({ state: "paused", take_index: 0 }));
    await userEvent.click(
      screen.getByRole("button", { name: "Resume recording" }),
    );
    expect(exec).toHaveBeenCalledWith("record.resume", {}, { skipWhen: true });
  });

  it("routes Stop through the record.stop command after the question", async () => {
    setRoom({ state: "recording", take_index: 0 });
    const { baseElement } = mount();
    const stop = screen.getByRole("button", { name: "Stop take" });
    stop.focus();
    await userEvent.keyboard("{Enter}");
    expect(exec).not.toHaveBeenCalled();
    expect(
      screen.getByRole("group", {
        name: "Stop this take? Recording ends for everyone in the room.",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Keep recording" }),
    ).toHaveFocus();
    await expectNoA11yViolations(baseElement);
    const confirm = screen
      .getAllByRole("button", { name: "Stop take" })
      .find((el) => el !== stop);
    await userEvent.click(confirm!);
    expect(exec).toHaveBeenCalledWith("record.stop", {}, { skipWhen: true });
    expect(postTransport).not.toHaveBeenCalled();
  });

  it("stops a paused take from More after the question", async () => {
    setRoom({ state: "paused", take_index: 0 });
    mount();
    const dialog = await openMore();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Stop take" }),
    );
    expect(exec).not.toHaveBeenCalled();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Stop take" }),
    );
    expect(exec).toHaveBeenCalledWith("record.stop", {}, { skipWhen: true });
  });

  it("keeps recording when the Stop question is declined", async () => {
    setRoom({ state: "paused", take_index: 0 });
    mount();
    const dialog = await openMore();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Stop take" }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Keep recording" }),
    );
    expect(exec).not.toHaveBeenCalled();
    expect(
      within(dialog).getByRole("button", { name: "Stop take" }),
    ).toBeVisible();
  });

  it("mutes the host from the dock", async () => {
    setRoom({ participants: [hostPerson()] });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Mute" }));
    expect(send).toHaveBeenCalledWith("SetMuted", { muted: true });
  });

  it("posts a live marker from Comment while recording", async () => {
    send.mockReturnValue(true);
    setRoom({
      state: "recording",
      take_index: 0,
      recording_ms: 1500,
      participants: [hostPerson()],
    });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));
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

  it("posts a typed note to the room from the Notes rail", async () => {
    send.mockReturnValue(true);
    setRoom({
      state: "recording",
      take_index: 0,
      recording_ms: 4000,
      participants: [hostPerson()],
    });
    mount();
    await userEvent.type(screen.getByRole("textbox"), "Redo the intro");
    await userEvent.click(screen.getByRole("button", { name: "Send note" }));
    expect(send).toHaveBeenCalledWith(
      "Comment",
      expect.objectContaining({ body: "Redo the intro", author: "p_host" }),
      undefined,
    );
  });
});

describe("Record stage Land", () => {
  it("disables Land mid-take with the reason beside it", async () => {
    setRoom({ state: "recording", take_index: 1 });
    mount();
    const dialog = await openMore();
    const land = within(dialog).getByRole("button", { name: "Land" });
    expect(land).toBeDisabled();
    expect(land).toHaveAccessibleDescription(
      "Stop the take to land it on the timeline.",
    );
  });

  it("holds Land while recordings are still saving", async () => {
    uploadStatus.mockResolvedValue({
      segments: [
        {
          take_index: 0,
          participant_id: "p_g",
          segment_index: 0,
          acked_parts: [0],
          file_ack: false,
        },
      ],
    });
    setRoom({
      state: "stopped",
      take_index: 0,
      participants: [avaGuest()],
    });
    mount();
    const dialog = await openMore();
    const land = within(dialog).getByRole("button", { name: "Land" });
    await waitFor(() =>
      expect(land).toHaveAccessibleDescription(
        "Recordings are still saving to the project.",
      ),
    );
    expect(land).toBeDisabled();
  });

  it("holds Land while a take saves even with a live comment", async () => {
    uploadStatus.mockResolvedValue({
      segments: [
        {
          take_index: 0,
          participant_id: "p_g",
          segment_index: 0,
          acked_parts: [0],
          file_ack: false,
        },
      ],
    });
    setRoom({
      state: "stopped",
      take_index: 0,
      participants: [avaGuest()],
      comments: [
        {
          id: "c1",
          take_index: 0,
          recording_ms: 10,
          pressed_wall_ms: 10,
          author: "p_host",
          body: "Marker",
        },
      ],
    });
    mount();
    const dialog = await openMore();
    const land = within(dialog).getByRole("button", { name: "Land" });
    await waitFor(() =>
      expect(land).toHaveAccessibleDescription(
        "Recordings are still saving to the project.",
      ),
    );
    expect(land).toBeDisabled();
  });

  it("lands once every recording is saved and keeps controls busy meanwhile", async () => {
    let finish: ((value: { status: "ok" }) => void) | undefined;
    exec.mockImplementationOnce(
      () =>
        new Promise<{ status: "ok" }>((resolve) => {
          finish = resolve;
        }),
    );
    uploadStatus.mockResolvedValue({
      segments: [
        {
          take_index: 0,
          participant_id: "p_g",
          segment_index: 0,
          acked_parts: [0],
          file_ack: true,
          land_failed: true,
        },
      ],
    });
    setRoom({
      state: "stopped",
      take_index: 0,
      participants: [avaGuest()],
    });
    mount();
    const dialog = await openMore();
    const land = await within(dialog).findByRole("button", {
      name: "Retry land",
    });
    await userEvent.click(land);
    expect(land).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(land);
    expect(
      exec.mock.calls.filter(
        (call) => (call as unknown[])[0] === "record.land",
      ),
    ).toHaveLength(1);
    await act(async () => {
      finish?.({ status: "ok" });
    });
    expect(land).not.toHaveAttribute("aria-disabled");
  });
});

describe("Record stage takes", () => {
  const stoppedTwo = () =>
    setRoom({
      state: "stopped",
      take_index: 0,
      participants: [hostPerson(), avaGuest()],
      takes: [
        {
          take_index: 0,
          session_start_wall_ms: 1000,
          session_start_iso: "t",
          stopped_wall_ms: 61_000,
          pauses: [],
          consented_participant_ids: ["p_host", "p_g"],
        },
      ],
    });

  it("lists every recorded participant's upload state after Stop", async () => {
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
          expected_parts: 4,
          file_ack: false,
        },
      ],
    });
    stoppedTwo();
    const { baseElement } = mount();
    await userEvent.click(screen.getByRole("tab", { name: "Takes" }));
    const take = await screen.findByRole("button", {
      name: /^Take/,
      expanded: false,
    });
    await userEvent.click(take);
    expect(await screen.findByText(/Saving 25%/)).toBeInTheDocument();
    expect(screen.getAllByText("Ava").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Host").length).toBeGreaterThan(0);
    await expectNoA11yViolations(baseElement);
  });

  it("leaves a producer out of the takes tray", async () => {
    uploadStatus.mockResolvedValue({
      segments: [
        {
          take_index: 0,
          participant_id: "p_g",
          segment_index: 0,
          acked_parts: [0],
          file_ack: true,
        },
        {
          take_index: 0,
          participant_id: "p_host",
          segment_index: 0,
          acked_parts: [0],
          file_ack: true,
        },
      ],
    });
    setRoom({
      state: "stopped",
      take_index: 0,
      participants: [
        hostPerson(),
        avaGuest(),
        recordParticipant({
          participant_id: "p_pat",
          role: "producer",
          display_name: "Pat",
        }),
      ],
      takes: [
        {
          take_index: 0,
          session_start_wall_ms: 1000,
          session_start_iso: "t",
          stopped_wall_ms: 61_000,
          pauses: [],
          consented_participant_ids: ["p_host", "p_g"],
        },
      ],
    });
    mount();
    await userEvent.click(screen.getByRole("tab", { name: "Takes" }));
    await userEvent.click(
      await screen.findByRole("button", { name: /^Take/, expanded: false }),
    );
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).queryByText("Pat")).toBeNull();
    expect(within(panel).getAllByText("Ava").length).toBeGreaterThan(0);
  });

  it("lists clipping and hears the landed clip on the timeline", async () => {
    const project = minimalProject();
    useDawStore.getState().hydrate("/tmp/p.json", {
      ...project,
      clips: {
        ...project.clips,
        tracks: {
          t1: [
            {
              id: "c9",
              track_id: "t1",
              source_start: 0,
              source_end: 30,
              timeline_start: 100,
              timeline_end: 130,
              fade_in_ms: 0,
              fade_out_ms: 0,
              join_in_mode: "fade",
              source_id: "rec-room1-0-p_host-0",
              source_duration_sec: null,
              recording_key: null,
            },
          ],
        },
      },
    });
    uploadStatus.mockResolvedValue({
      segments: [
        {
          take_index: 0,
          participant_id: "p_host",
          segment_index: 0,
          acked_parts: [0],
          file_ack: true,
          landed: true,
        },
      ],
    });
    act(() => {
      setRoom({
        state: "stopped",
        take_index: 0,
        participants: [hostPerson()],
        takes: [
          {
            take_index: 0,
            session_start_wall_ms: 1000,
            session_start_iso: "t",
            stopped_wall_ms: 61_000,
            pauses: [],
            consented_participant_ids: ["p_host"],
          },
        ],
      });
      useRecordHostStore.getState().setTakeClipping({
        takeIndex: 0,
        known: true,
        regions: [
          { segmentIndex: 0, startMs: 5000, endMs: 6000, segmentStartMs: 5000 },
        ],
      });
    });
    mount();
    await userEvent.click(screen.getByRole("tab", { name: "Takes" }));
    await userEvent.click(
      await screen.findByRole("button", { name: /^Take/, expanded: false }),
    );
    expect(await screen.findByText(/Clipped 1 time/)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: /Hear/ }));
    expect(exec).toHaveBeenCalledWith(
      "transport.seek",
      { sec: 105 },
      { skipWhen: true },
    );
    const ids = exec.mock.calls.map((call) => (call as unknown[])[0]);
    expect(ids.indexOf("stage.edit")).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf("stage.edit")).toBeLessThan(
      ids.indexOf("transport.seek"),
    );
  });

  describe("post-take clipping summary", () => {
    const takes = [
      {
        take_index: 0,
        session_start_wall_ms: 1000,
        session_start_iso: "t",
        stopped_wall_ms: 61_000,
        pauses: [],
        consented_participant_ids: ["p_host", "p_g"],
      },
      {
        take_index: 1,
        session_start_wall_ms: 100_000,
        session_start_iso: "t",
        stopped_wall_ms: 130_000,
        pauses: [],
        consented_participant_ids: ["p_host", "p_g"],
      },
    ];
    const segment = (over: Record<string, unknown>) => ({
      take_index: 0,
      participant_id: "p_g",
      segment_index: 0,
      acked_parts: [0],
      file_ack: true,
      landed: true,
      ...over,
    });
    const openTakes = async () => {
      await userEvent.click(screen.getByRole("tab", { name: "Takes" }));
    };

    it("names every clipped person on the take row, from the uploaded rows alone", async () => {
      uploadStatus.mockResolvedValue({
        segments: [
          segment({
            participant_id: "p_host",
            clipping_regions: [[4000, 5000]],
          }),
          segment({
            clipping_regions: [
              [65_000, 66_000],
              [130_000, 131_000],
            ],
            join_offset_ms: 500,
          }),
          segment({ take_index: 1 }),
          segment({ take_index: 1, participant_id: "p_host" }),
        ],
      });
      act(() => {
        setRoom({
          state: "stopped",
          take_index: 1,
          participants: [hostPerson(), avaGuest()],
          takes,
        });
      });
      mount();
      await openTakes();
      expect(
        await screen.findByText(
          "1:00 · 2 people · Host clipped 1 time, Ava clipped 2 times",
        ),
      ).toBeInTheDocument();
      expect(screen.getByText("0:30 · 2 people")).toBeInTheDocument();
      await userEvent.click(
        screen.getByRole("button", { name: /^Take 1/, expanded: false }),
      );
      expect(
        screen.getByText("Saved · Clipped 2 times · 1:05, 2:10"),
      ).toBeInTheDocument();
    });

    it("hears the earliest clipped span of anyone, here the guest's landed clip", async () => {
      const project = minimalProject();
      useDawStore.getState().hydrate("/tmp/p.json", {
        ...project,
        clips: {
          ...project.clips,
          tracks: {
            t2: [
              {
                id: "c8",
                track_id: "t2",
                source_start: 0,
                source_end: 30,
                timeline_start: 200,
                timeline_end: 230,
                fade_in_ms: 0,
                fade_out_ms: 0,
                join_in_mode: "fade",
                source_id: "rec-room1-0-p_g-0",
                source_duration_sec: null,
                recording_key: null,
              },
            ],
          },
        },
      });
      uploadStatus.mockResolvedValue({
        segments: [
          segment({
            participant_id: "p_host",
            clipping_regions: [[9000, 9500]],
          }),
          segment({ clipping_regions: [[3000, 3500]] }),
        ],
      });
      act(() => {
        setRoom({
          state: "stopped",
          take_index: 0,
          participants: [hostPerson(), avaGuest()],
          takes: takes.slice(0, 1),
        });
      });
      mount();
      await openTakes();
      await userEvent.click(
        await screen.findByRole("button", { name: /Hear/ }),
      );
      expect(exec).toHaveBeenCalledWith(
        "transport.seek",
        { sec: 203 },
        { skipWhen: true },
      );
    });

    it("lists nothing for a take nobody clipped", async () => {
      uploadStatus.mockResolvedValue({
        segments: [
          segment({ participant_id: "p_host" }),
          segment({ clipping_regions: null }),
        ],
      });
      act(() => {
        setRoom({
          state: "stopped",
          take_index: 0,
          participants: [hostPerson(), avaGuest()],
          takes: takes.slice(0, 1),
        });
      });
      mount();
      await openTakes();
      expect(await screen.findByText("1:00 · 2 people")).toBeInTheDocument();
      expect(screen.queryByText(/clipped/)).toBeNull();
    });
  });

  it("retries a failed past take through the project-wide land command", async () => {
    uploadStatus.mockResolvedValue({
      segments: [
        {
          take_index: 0,
          participant_id: "p_g",
          segment_index: 0,
          acked_parts: [0],
          file_ack: true,
          land_failed: true,
        },
      ],
    });
    act(() => {
      setRoom({
        state: "recording",
        take_index: 1,
        participants: [hostPerson(), avaGuest()],
        takes: [
          {
            take_index: 0,
            session_start_wall_ms: 1000,
            session_start_iso: "t",
            stopped_wall_ms: 61_000,
            pauses: [],
            consented_participant_ids: ["p_host", "p_g"],
          },
          {
            take_index: 1,
            session_start_wall_ms: 70_000,
            session_start_iso: "t",
            stopped_wall_ms: null,
            pauses: [],
            consented_participant_ids: ["p_host", "p_g"],
          },
        ],
      });
    });
    mount();
    await userEvent.click(screen.getByRole("tab", { name: "Takes" }));
    await userEvent.click(
      await screen.findByRole("button", { name: /^Take 1/, expanded: false }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /^Retry Ava/ }),
    );
    expect(exec).toHaveBeenCalledWith("record.land", {}, { skipWhen: true });
  });
});

describe("Record stage partial keeper recovery", () => {
  const stopped = () => setRoom({ state: "stopped", take_index: 0 });

  it("recovers the host keeper and resumes upload from More", async () => {
    const sink = new MemorySink();
    const wavPath = await seedPendingKeeper(sink, {
      sessionId: "room1",
      takeIndex: 0,
      participantId: "p_host",
    });
    vi.mocked(createOpfsSink).mockResolvedValue(sink);
    stopped();
    const { baseElement } = mount();
    const dialog = await openMore();
    await userEvent.click(
      await within(dialog).findByRole("button", {
        name: "Recover partial take",
      }),
    );
    expect(
      await within(dialog).findByText(/Recovered 1 partial segment/),
    ).toBeInTheDocument();
    expect(
      parseKeeperMeta(await sink.read(keeperMetaPath(wavPath)))?.complete,
    ).toBe(true);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Recover partial take" }),
      ).toBeNull(),
    );
    await expectNoA11yViolations(baseElement);
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
    stopped();
    mount();
    const dialog = await openMore();
    await userEvent.click(
      await within(dialog).findByRole("button", {
        name: "Recover partial take",
      }),
    );
    expect(
      await within(dialog).findByText(/locked by another tab/),
    ).toBeInTheDocument();
    expect(useRecordHostStore.getState().keeperStorageError).toBeNull();
    expect(useRecordHostStore.getState().keeperSink).toBe(sink);
  });
});

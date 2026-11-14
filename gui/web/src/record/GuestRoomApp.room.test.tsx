import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations, expectOutsideLiveRegions } from "../test/a11y";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import { GuestRoomApp } from "./GuestRoomApp";
import { roomToneClock } from "./roomTone";
import type { RecordUploadProgress } from "./upload/useRecordUpload";
import type { GuestRoom } from "./useGuestRoom";
import { NO_OUTPUT } from "./useOutputDevice";

const current = vi.hoisted(() => ({ room: null as unknown }));
vi.mock("./useGuestRoom", () => ({
  useGuestRoom: () => current.room,
}));

const speech = vi.hoisted(() => ({ heard: false, calls: [] as unknown[][] }));
vi.mock("./useMutedSpeech", () => ({
  useMutedSpeech: (...args: unknown[]) => {
    speech.calls.push(args);
    return speech.heard;
  },
}));

const me = recordParticipant({ participant_id: "p_g", display_name: "Ava" });
const host = recordParticipant({
  participant_id: "p_host",
  role: "host",
  display_name: "Hana",
});

const idleUpload: RecordUploadProgress = {
  acked: 0,
  total: 0,
  fileAck: false,
  landed: false,
  landFailed: false,
  reclaimFailed: false,
  uploading: false,
  pending: false,
  recoverable: false,
  segments: [],
  error: null,
};

type Overrides = {
  snapshot?: Partial<ReturnType<typeof recordSnapshot>>;
  me?: typeof me;
  producer?: boolean;
  mic?: Partial<GuestRoom["mic"]>;
  output?: Partial<GuestRoom["output"]>;
  deviceId?: string;
  keeper?: Partial<GuestRoom["keeper"]>;
  upload?: Partial<RecordUploadProgress>;
  takeClipping?: GuestRoom["takeClipping"];
  takeClippings?: GuestRoom["takeClippings"];
  keeperActions?: Partial<GuestRoom["keeperActions"]>;
  left?: boolean;
  roomTone?: Partial<GuestRoom["roomTone"]>;
  captureSettled?: boolean;
  localRecording?: boolean;
};

function fakeRoom(over: Overrides = {}) {
  const self = over.me ?? me;
  const room = {
    bootstrap: { build: { capture: true, monitor: false, upload: true } },
    bootError: null,
    producer: over.producer ?? false,
    episodeName: "Shot of Truth",
    snapshot: recordSnapshot({
      session_id: "room1",
      state: "recording",
      recording_ms: 1000,
      participants: [host, self],
      ...over.snapshot,
    }),
    me: self,
    send: vi.fn(() => true),
    connected: true,
    error: null,
    clearError: vi.fn(),
    accessEnded: false,
    inviteClosed: false,
    mic: {
      status: "granted",
      request: vi.fn(),
      retry: vi.fn(),
      stream: {} as MediaStream,
      devices: [],
      error: null,
      settingsWarning: null,
      lost: false,
      staleDeviceId: null,
      pending: false,
      ...over.mic,
    },
    staleMic: false,
    sink: {},
    sinkError: null,
    storageRequired: true,
    retryStorage: vi.fn(),
    keeper: {
      recordingLocally: true,
      finalizing: false,
      error: null,
      noAudio: false,
      micCheckFailed: false,
      checkMic: vi.fn(),
      retry: vi.fn(),
      ...over.keeper,
    },
    monitor: {
      hearing: false,
      remoteCount: 0,
      error: null as string | null,
      levels: {},
      retry: vi.fn(),
    },
    output: { ...NO_OUTPUT, ...over.output },
    upload: { ...idleUpload, ...over.upload },
    takeClipping: over.takeClipping ?? null,
    takeClippings: over.takeClippings ?? {},
    keeperActions: {
      busy: false,
      error: null,
      notice: null,
      recover: vi.fn(),
      ...over.keeperActions,
    },
    roomTone: {
      status: "idle",
      delivery: "device",
      error: null,
      captureReady: false,
      record: vi.fn(),
      clock: roomToneClock(0),
      endEarly: vi.fn(),
      cancel: vi.fn(),
      ...over.roomTone,
    },
    liveComments: {
      note: "",
      setNote: vi.fn(),
      postMarker: vi.fn(),
      postNote: vi.fn(),
      submitNote: vi.fn(),
    },
    captureSettled: over.captureSettled ?? true,
    localRecording: over.localRecording ?? false,
    name: "Ava",
    setName: vi.fn(),
    headphonesOk: true,
    setHeadphonesOk: vi.fn(),
    deviceId: over.deviceId ?? "",
    setDeviceId: vi.fn(),
    producerJoined: true,
    setProducerJoined: vi.fn(),
    resumeUpload: vi.fn(),
    left: over.left ?? false,
    leave: vi.fn(),
  };
  current.room = room;
  return room;
}

const stopped = { state: "stopped" as const, take_index: 0 };
beforeEach(() => {
  vi.spyOn(window, "close").mockImplementation(() => undefined);
  speech.heard = false;
  speech.calls = [];
  current.room = null;
});

const leave = () => screen.getByRole("button", { name: "Leave room" });

describe("GuestRoomApp in the room", () => {
  it("holds Leave until the stopped take is file-ACK'd", () => {
    fakeRoom({
      snapshot: stopped,
      upload: { acked: 1, total: 3, uploading: true },
    });
    render(<GuestRoomApp token="t" />);
    expect(leave()).toHaveAttribute("aria-disabled", "true");
    expect(leave()).toHaveAttribute("title", "Your recording is still saving");
    expect(screen.getByText("Saving · 33%")).toBeInTheDocument();
  });

  it("holds Leave during a take and says why on press", async () => {
    const room = fakeRoom();
    render(<GuestRoomApp token="t" />);
    expect(leave()).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(leave());
    expect(
      screen.getByText("You can leave after this take."),
    ).toBeInTheDocument();
    expect(room.leave).not.toHaveBeenCalled();
  });

  it("Leave in the waiting room leaves the room", async () => {
    const room = fakeRoom({ snapshot: { state: "lobby" } });
    const { rerender } = render(<GuestRoomApp token="t" />);
    expect(leave()).not.toHaveAttribute("aria-disabled");
    await userEvent.click(leave());
    expect(room.leave).toHaveBeenCalledOnce();
    (current.room as { left: boolean }).left = true;
    rerender(<GuestRoomApp token="t" />);
    expect(
      screen.getByRole("heading", { name: "You left the room" }),
    ).toBeInTheDocument();
    expect(screen.getByText("You can close this page.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Join again" }),
    ).toBeInTheDocument();
  });

  it("offers Retry when the guest can't hear the room", async () => {
    const room = fakeRoom();
    room.monitor.error = "Signal lost";
    render(<GuestRoomApp token="t" />);
    expect(
      screen.getByText("You can't hear the room. Recording is fine."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(room.monitor.retry).toHaveBeenCalledOnce();
  });

  it("tells a saved guest they can close the page, and Done leaves", async () => {
    const room = fakeRoom({
      snapshot: stopped,
      upload: { acked: 3, total: 3, fileAck: true, landed: true },
    });
    render(<GuestRoomApp token="t" />);
    expect(
      screen.getByText("Saved to project. You can close this page."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Leave room" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(room.leave).toHaveBeenCalledOnce();
    expect(window.close).toHaveBeenCalledOnce();
  });

  it("brings the normal dock back when a later take starts", () => {
    fakeRoom({
      snapshot: stopped,
      upload: { acked: 3, total: 3, fileAck: true, landed: true },
    });
    const { rerender } = render(<GuestRoomApp token="t" />);
    expect(
      screen.getByText("Saved to project. You can close this page."),
    ).toBeInTheDocument();
    fakeRoom({
      snapshot: { state: "recording", take_index: 1 },
      upload: { acked: 3, total: 3, fileAck: true, landed: true },
    });
    rerender(<GuestRoomApp token="t" />);
    expect(screen.getByRole("button", { name: "Mute" })).toBeInTheDocument();
    expect(leave()).toBeInTheDocument();
    expect(
      screen.queryByText("Saved to project. You can close this page."),
    ).toBeNull();
  });

  it("gives a saved guest Done and lets Leave go after an upload error", () => {
    fakeRoom({
      snapshot: stopped,
      upload: { acked: 3, total: 3, fileAck: true, landed: true },
    });
    const { rerender } = render(<GuestRoomApp token="t" />);
    expect(screen.queryByRole("button", { name: "Leave room" })).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(screen.getAllByText("Saved").length).toBeGreaterThan(0);
    fakeRoom({
      snapshot: stopped,
      upload: { acked: 1, total: 3, error: "upload failed" },
    });
    rerender(<GuestRoomApp token="t" />);
    expect(leave()).not.toHaveAttribute("aria-disabled");
    expect(screen.getByText("Saving stopped")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Resume saving" }),
    ).toBeInTheDocument();
  });

  it("offers Save a copy beside Resume saving", async () => {
    const download = vi.fn();
    fakeRoom({
      snapshot: stopped,
      upload: { acked: 1, total: 3, error: "upload failed" },
      keeperActions: { download },
    });
    render(<GuestRoomApp token="t" />);
    await userEvent.click(screen.getByRole("button", { name: "Save a copy" }));
    expect(download).toHaveBeenCalledOnce();
  });

  it("shows the recovery result in the room, and still announces it", () => {
    const notice =
      "Recovered 1 partial segment. Download your full-quality recording to keep a copy.";
    fakeRoom({ snapshot: stopped, keeperActions: { notice } });
    render(<GuestRoomApp token="t" />);
    const copies = screen.getAllByText(notice);
    const shown = copies.filter((node) => !node.closest(".sr-only"));
    expect(shown).toHaveLength(1);
    expect(shown[0]).toBeVisible();
    expect(shown[0]?.closest('[role="status"]')).not.toBeNull();
    expect(copies.some((node) => node.closest("[aria-live=polite]"))).toBe(
      true,
    );
  });

  describe("no audio", () => {
    it("shows a persistent alert with Check mic", async () => {
      const room = fakeRoom({ keeper: { noAudio: true } });
      const { container } = render(<GuestRoomApp token="t" />);
      expect(
        screen.getByText("No sound is reaching the recorder."),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Recording in full quality on this device."),
      ).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Check mic" }));
      expect(room.keeper.checkMic).toHaveBeenCalledOnce();
      await expectNoA11yViolations(container);
    });

    it("adds what to try after a failed check, and drops it once the check passes", () => {
      const failedCopy =
        "Still no audio: unmute or reconnect your microphone, then Check mic again.";
      fakeRoom({ keeper: { noAudio: true, micCheckFailed: true } });
      const view = render(<GuestRoomApp token="t" />);
      expect(
        screen.getByText(new RegExp(failedCopy.replace(/[.:]/g, "\\$&"))),
      ).toBeVisible();
      view.unmount();
      fakeRoom({ keeper: { noAudio: true, micCheckFailed: false } });
      render(<GuestRoomApp token="t" />);
      expect(
        screen.getByText("No sound is reaching the recorder."),
      ).toBeVisible();
      expect(screen.queryByText(/Still no audio/)).toBeNull();
    });

    it("stays quiet while paused", () => {
      fakeRoom({ snapshot: { state: "paused" }, keeper: { noAudio: true } });
      render(<GuestRoomApp token="t" />);
      expect(
        screen.queryByText("No sound is reaching the recorder."),
      ).not.toBeInTheDocument();
    });

    it("yields to microphone loss", () => {
      fakeRoom({ keeper: { noAudio: true }, mic: { lost: true } });
      render(<GuestRoomApp token="t" />);
      expect(
        screen.queryByText("No sound is reaching the recorder."),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Your mic stopped.")).toBeInTheDocument();
    });
  });

  it("offers microphone reconnect while local capture is lost", async () => {
    const room = fakeRoom({ mic: { lost: true } });
    render(<GuestRoomApp token="t" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Reconnect mic" }),
    );
    expect(room.mic.retry).toHaveBeenCalledOnce();
  });

  it("treats a cleared stream without a lost flag as a mic problem", () => {
    fakeRoom({ mic: { stream: null, lost: false } });
    render(<GuestRoomApp token="t" />);
    expect(screen.getByText("Your mic stopped.")).toBeInTheDocument();
  });

  it("clears mic loss after Stop but keeps keeper recovery", () => {
    fakeRoom({
      snapshot: stopped,
      mic: { lost: true },
      upload: { recoverable: true, error: "partial" },
    });
    render(<GuestRoomApp token="t" />);
    expect(screen.queryByText("Your mic stopped.")).toBeNull();
    expect(
      screen.getByText("We found part of your recording."),
    ).toBeInTheDocument();
  });

  it("keeps a listening producer out of local microphone failure", () => {
    fakeRoom({
      producer: true,
      me: { ...me, role: "producer" },
      mic: { stream: null, lost: true },
      keeper: { noAudio: true, error: "x" },
    });
    render(<GuestRoomApp token="t" />);
    expect(screen.queryByText("Your mic stopped.")).toBeNull();
    expect(screen.queryByText("No sound is reaching the recorder.")).toBeNull();
    expect(screen.getByRole("button", { name: "Leave room" })).toBeEnabled();
  });

  it("says the room connection dropped, not the host, when this page's socket drops mid-take", () => {
    fakeRoom({ snapshot: { state: "recording" } });
    (current.room as { connected: boolean }).connected = false;
    render(<GuestRoomApp token="t" />);
    expect(
      screen.getByText(
        "Lost connection to the room. You're still recording on this device.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Hana dropped/)).toBeNull();
    expect(screen.getByText(/^\d+:\d{2} · Reconnecting…$/)).toBeInTheDocument();
  });

  it("names the host only when the host leaves while this guest is connected", () => {
    fakeRoom({
      snapshot: {
        state: "recording",
        participants: [{ ...host, connected: false }, me],
      },
    });
    render(<GuestRoomApp token="t" />);
    expect(
      screen.getByText("Hana dropped. You're still recording on this device."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Lost connection to the room/)).toBeNull();
  });

  it("reads Reconnecting… on the guest's own tile when the socket drops while waiting", () => {
    fakeRoom({ snapshot: { state: "lobby" } });
    (current.room as { connected: boolean }).connected = false;
    render(<GuestRoomApp token="t" />);
    expect(screen.getByText("Waiting for Hana to start")).toBeInTheDocument();
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
    expect(screen.queryByText(/Lost connection to the room/)).toBeNull();
    expect(screen.queryByText(/dropped/)).toBeNull();
  });

  it("keeps chunk counts out of live regions and speaks only segment changes", async () => {
    const segment = (saved: boolean, acked: number) => ({
      take: 0,
      segment: 1,
      state: saved ? ("saved" as const) : ("saving" as const),
      chunks: saved ? null : { acked, total: 5 },
      landFailed: false,
    });
    const first = {
      take: 0,
      segment: 0,
      state: "saved" as const,
      chunks: null,
      landFailed: false,
    };
    const spoken = (container: HTMLElement) =>
      [...container.querySelectorAll('[aria-live="polite"]')]
        .map((el) => el.textContent)
        .join("|");
    const set = (saved: boolean, acked: number) =>
      fakeRoom({
        snapshot: stopped,
        upload: {
          acked,
          total: 5,
          uploading: !saved,
          fileAck: saved,
          segments: [first, segment(saved, acked)],
        },
      });
    set(false, 2);
    const { container, rerender } = render(<GuestRoomApp token="t" />);
    expectOutsideLiveRegions(container, /keep this page open/);
    const before = spoken(container);
    expect(before).toContain("Take 1 segment 2: Saving to project…");
    expect(before).not.toMatch(/chunk|\d%/);

    set(false, 3);
    rerender(<GuestRoomApp token="t" />);
    expect(spoken(container)).toBe(before);

    set(true, 5);
    rerender(<GuestRoomApp token="t" />);
    expect(spoken(container)).toContain("Take 1 segment 2: Saved to project");
    await expectNoA11yViolations(container);
  });

  it("shows You're muted only once muted speech is heard", () => {
    const stream = {} as MediaStream;
    const muted = { ...me, muted: true };
    fakeRoom({ me: muted, mic: { stream } });
    const { rerender } = render(<GuestRoomApp token="t" />);
    expect(screen.queryByText("You're muted.")).toBeNull();
    expect(speech.calls.at(-1)).toEqual([
      stream,
      { muted: true, counting: true, onAir: true },
    ]);
    speech.heard = true;
    rerender(<GuestRoomApp token="t" />);
    expect(screen.getByText("You're muted.")).toBeVisible();
  });

  it("gives a producer no mic to listen to", () => {
    fakeRoom({ producer: true, me: { ...me, role: "producer", muted: true } });
    render(<GuestRoomApp token="t" />);
    expect(speech.calls.at(-1)).toEqual([
      null,
      { muted: false, counting: true, onAir: true },
    ]);
  });

  it("badges the guest's own tile on the first clip and alerts only after the third within 30 s", () => {
    const region = (startMs: number) => ({
      segmentIndex: 0,
      startMs,
      endMs: startMs + 500,
      segmentStartMs: startMs,
    });
    const once = { takeIndex: 0, known: true, regions: [region(1000)] };
    const thrice = {
      takeIndex: 0,
      known: true,
      regions: [region(1000), region(10000), region(25000)],
    };
    const spread = {
      takeIndex: 0,
      known: true,
      regions: [region(1000), region(20000), region(40000)],
    };
    fakeRoom({ takeClipping: once });
    const { container, rerender } = render(<GuestRoomApp token="t" />);
    expect(container.querySelector(".sys-room-clip")).toHaveTextContent("1");
    expect(
      screen.queryByText("You're clipping. Move back a little."),
    ).toBeNull();
    fakeRoom({ takeClipping: spread });
    rerender(<GuestRoomApp token="t" />);
    expect(
      screen.queryByText("You're clipping. Move back a little."),
    ).toBeNull();
    fakeRoom({ takeClipping: thrice });
    rerender(<GuestRoomApp token="t" />);
    expect(
      screen.getByText("You're clipping. Move back a little."),
    ).toBeVisible();
    fakeRoom({
      producer: true,
      me: { ...me, role: "producer" },
      takeClipping: thrice,
    });
    rerender(<GuestRoomApp token="t" />);
    expect(container.querySelector(".sys-room-clip")).toBeNull();
    expect(
      screen.queryByText("You're clipping. Move back a little."),
    ).toBeNull();
  });

  describe("Devices", () => {
    const devices = [
      { deviceId: "a", label: "USB Mic", kind: "audioinput" },
      { deviceId: "b", label: "Headset", kind: "audioinput" },
    ] as MediaDeviceInfo[];

    it("opens from the guest's own tile with the mic, headphones and room tone", async () => {
      const room = fakeRoom({
        snapshot: { state: "lobby", take_index: -1 },
        mic: { devices },
      });
      room.roomTone.captureReady = true;
      const { baseElement } = render(<GuestRoomApp token="t" />);
      expect(screen.queryByRole("dialog", { name: "Devices" })).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Devices" }));
      const dialog = await screen.findByRole("dialog", { name: "Devices" });
      await userEvent.click(
        within(dialog).getByRole("button", { name: /^Input:/ }),
      );
      await userEvent.click(
        screen.getByRole("menuitemradio", { name: "Headset" }),
      );
      expect(room.setDeviceId).toHaveBeenCalledWith("b");
      await userEvent.click(
        within(dialog).getByRole("button", {
          name: "I'm wearing headphones",
        }),
      );
      expect(room.setHeadphonesOk).toHaveBeenCalledWith(false);
      await userEvent.click(
        within(dialog).getByRole("button", {
          name: "Record 1 minute of room tone",
        }),
      );
      expect(room.roomTone.record).toHaveBeenCalledOnce();
      await expectNoA11yViolations(baseElement);
    });

    it("draws the Speaker menu only where the browser can pick one, and applies a pick", async () => {
      fakeRoom({ mic: { devices } });
      const { unmount } = render(<GuestRoomApp token="t" />);
      await userEvent.click(screen.getByRole("button", { name: "Devices" }));
      const none = await screen.findByRole("dialog", { name: "Devices" });
      expect(within(none).queryByLabelText("Speaker")).toBeNull();
      unmount();
      const onChange = vi.fn();
      fakeRoom({
        mic: { devices },
        output: {
          supported: true,
          devices: [{ id: "hp", label: "Headset" }],
          selectedId: "",
          onChange,
          refresh: vi.fn(),
        },
      });
      render(<GuestRoomApp token="t" />);
      await userEvent.click(screen.getByRole("button", { name: "Devices" }));
      const dialog = await screen.findByRole("dialog", { name: "Devices" });
      await userEvent.selectOptions(
        within(dialog).getByLabelText("Speaker"),
        "hp",
      );
      expect(onChange).toHaveBeenCalledWith("hp");
    });

    it("locks the input menu and room tone while a take is running", async () => {
      fakeRoom({ mic: { devices } });
      render(<GuestRoomApp token="t" />);
      await userEvent.click(screen.getByRole("button", { name: "Devices" }));
      const dialog = await screen.findByRole("dialog", { name: "Devices" });
      expect(
        within(dialog).getByRole("button", { name: /^Input:/ }),
      ).toBeDisabled();
      const tone = within(dialog).getByRole("button", {
        name: "Record 1 minute of room tone",
      });
      expect(tone).toHaveAttribute("aria-disabled", "true");
      expect(tone).toBeEnabled();
      expect(tone).toHaveAccessibleDescription(
        "Record room tone between takes.",
      );
      expect(
        within(dialog).getByText("Record room tone between takes."),
      ).toBeVisible();
    });

    it("keeps the Input menu mounted and focused while the new input opens", async () => {
      const stream = {} as MediaStream;
      fakeRoom({
        snapshot: { state: "lobby", take_index: -1 },
        mic: { devices, stream },
      });
      const { rerender } = render(<GuestRoomApp token="t" />);
      await userEvent.click(screen.getByRole("button", { name: "Devices" }));
      const dialog = await screen.findByRole("dialog", { name: "Devices" });
      const select = within(dialog).getByRole("button", { name: /^Input:/ });
      select.focus();
      fakeRoom({
        snapshot: { state: "lobby", take_index: -1 },
        mic: { devices, stream },
        deviceId: "b",
      });
      rerender(<GuestRoomApp token="t" />);
      fakeRoom({
        snapshot: { state: "lobby", take_index: -1 },
        mic: { devices, status: "idle", stream: null },
        deviceId: "b",
      });
      rerender(<GuestRoomApp token="t" />);
      const open = screen.getByRole("dialog", { name: "Devices" });
      expect(within(open).getByRole("button", { name: /^Input:/ })).toBe(
        select,
      );
      expect(select).toHaveFocus();
      expect(
        within(open).queryByRole("button", { name: "Allow microphone" }),
      ).toBeNull();
    });

    it("does not bring the Devices sheet back after the Join sheet takes over", async () => {
      fakeRoom({ snapshot: { state: "lobby", take_index: -1 } });
      const { rerender } = render(<GuestRoomApp token="t" />);
      await userEvent.click(screen.getByRole("button", { name: "Devices" }));
      await screen.findByRole("dialog", { name: "Devices" });
      fakeRoom({
        snapshot: { state: "lobby", take_index: -1 },
        me: { ...me, consented: null },
      });
      rerender(<GuestRoomApp token="t" />);
      expect(screen.queryByRole("dialog", { name: "Devices" })).toBeNull();
      fakeRoom({ snapshot: { state: "lobby", take_index: -1 } });
      rerender(<GuestRoomApp token="t" />);
      expect(screen.queryByRole("dialog", { name: "Devices" })).toBeNull();
    });

    it("gives a listening producer no device entry", () => {
      fakeRoom({ producer: true, me: { ...me, role: "producer" } });
      render(<GuestRoomApp token="t" />);
      expect(screen.queryByRole("button", { name: "Devices" })).toBeNull();
    });
  });

  describe("post-take clipping summary", () => {
    const takeOne = {
      take_index: 0,
      session_start_wall_ms: 1000,
      session_start_iso: "t",
      stopped_wall_ms: 61_000,
      pauses: [],
      consented_participant_ids: ["p_g"],
    };
    const clipped = {
      takeIndex: 0,
      known: true,
      regions: [
        {
          segmentIndex: 0,
          startMs: 65_000,
          endMs: 66_000,
          segmentStartMs: 65_000,
        },
        {
          segmentIndex: 0,
          startMs: 130_000,
          endMs: 131_000,
          segmentStartMs: 130_000,
        },
      ],
    };
    const stoppedTake = { ...stopped, takes: [takeOne] };
    const openTakes = async () => {
      await userEvent.click(screen.getByRole("button", { name: /^Notes/ }));
      await userEvent.click(screen.getByRole("tab", { name: "Takes" }));
    };

    it("names the guest and how many times they clipped, without a jump action", async () => {
      fakeRoom({
        snapshot: stoppedTake,
        takeClipping: clipped,
        takeClippings: { 0: clipped },
        upload: {
          fileAck: true,
          total: 1,
          acked: 1,
          segments: [
            {
              take: 0,
              segment: 0,
              state: "saved",
              chunks: null,
              landFailed: false,
            },
          ],
        },
      });
      const { container } = render(<GuestRoomApp token="t" />);
      await openTakes();
      expect(
        screen.getByText("1:00 · 1 person · Ava clipped 2 times"),
      ).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /Take 1/ }));
      expect(
        screen.getByText("Saved · Clipped 2 times · 1:05, 2:10"),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Hear/ })).toBeNull();
      await expectNoA11yViolations(container);
    });

    it("shows nothing for a clean take", () => {
      fakeRoom({
        snapshot: stoppedTake,
        takeClipping: { ...clipped, regions: [] },
        takeClippings: { 0: { ...clipped, regions: [] } },
      });
      render(<GuestRoomApp token="t" />);
      expect(screen.queryByRole("tab", { name: "Takes" })).toBeNull();
      expect(screen.queryByText(/clipped/)).toBeNull();
    });

    it("rebuilds from the earlier takes' stored clipping after a reload", async () => {
      fakeRoom({
        snapshot: {
          ...stopped,
          state: "recording",
          take_index: 1,
          takes: [
            takeOne,
            { ...takeOne, take_index: 1, stopped_wall_ms: null },
          ],
        },
        takeClippings: { 0: clipped },
      });
      render(<GuestRoomApp token="t" />);
      await openTakes();
      expect(screen.getByText(/Ava clipped 2 times/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Take 2/ })).toBeNull();
    });

    it("gives a producer no clipping summary", () => {
      fakeRoom({
        producer: true,
        me: { ...me, role: "producer" },
        snapshot: stoppedTake,
        takeClippings: { 0: clipped },
      });
      render(<GuestRoomApp token="t" />);
      expect(screen.queryByRole("tab", { name: "Takes" })).toBeNull();
    });
  });

  it("speaks the keeper line and what a new comment says", () => {
    fakeRoom();
    const { container, rerender } = render(<GuestRoomApp token="t" />);
    const live = () => container.querySelector('.sr-only[aria-live="polite"]');
    expect(live()).toHaveTextContent(
      "Recording in full quality on this device.",
    );
    const room = current.room as {
      snapshot: ReturnType<typeof recordSnapshot>;
    };
    room.snapshot = {
      ...room.snapshot,
      participants: [
        ...room.snapshot.participants,
        recordParticipant({ participant_id: "p_n", display_name: "Nia" }),
      ],
    };
    rerender(<GuestRoomApp token="t" />);
    expect(live()).toHaveTextContent("Nia joined");
  });
});

describe("GuestRoomApp Leave holds", () => {
  const rostered = {
    ...stopped,
    takes: [
      {
        take_index: 0,
        session_start_wall_ms: 1000,
        session_start_iso: "t",
        stopped_wall_ms: 61_000,
        pauses: [],
        consented_participant_ids: ["p_g"],
      },
    ],
  };

  it("lets Leave go while the saving line has no upload behind it", () => {
    fakeRoom({ snapshot: rostered });
    render(<GuestRoomApp token="t" />);
    expect(screen.getAllByText(/Saving · 0 of 1/).length).toBeGreaterThan(0);
    expect(leave()).not.toHaveAttribute("aria-disabled");
  });

  it("holds Leave until capture has finished, even after an upload error", () => {
    fakeRoom({
      snapshot: rostered,
      upload: { acked: 1, total: 3, error: "upload failed" },
      captureSettled: false,
    });
    render(<GuestRoomApp token="t" />);
    expect(leave()).toHaveAttribute("aria-disabled", "true");
    expect(leave()).toHaveAttribute(
      "title",
      "Your recording is still finishing",
    );
  });

  it("holds Leave while room tone records on this device", () => {
    fakeRoom({
      snapshot: { state: "lobby" },
      roomTone: { status: "capturing" },
    });
    render(<GuestRoomApp token="t" />);
    expect(leave()).toHaveAttribute("aria-disabled", "true");
    expect(leave()).toHaveAttribute(
      "title",
      "Finish or cancel the room tone first",
    );
  });
});

describe("GuestRoomApp after Leave", () => {
  const failedSave = {
    snapshot: {
      ...stopped,
      takes: [
        {
          take_index: 0,
          session_start_wall_ms: 1000,
          session_start_iso: "t",
          stopped_wall_ms: 61_000,
          pauses: [],
          consented_participant_ids: ["p_g"],
        },
      ],
    },
    upload: { acked: 1, total: 3, error: "upload failed" },
    left: true,
  };

  it("keeps Save my recording after a rejoin reset consent while a save failed", async () => {
    const download = vi.fn();
    fakeRoom({
      ...failedSave,
      me: { ...me, consented: null },
      localRecording: true,
      keeperActions: { download },
    });
    render(<GuestRoomApp token="t" />);
    expect(
      screen.getByRole("heading", {
        name: "Your recording didn't finish saving",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("You can close this page.")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Save my recording" }),
    );
    expect(download).toHaveBeenCalledOnce();
  });

  it("never says a guest can close the page while capture is still finishing", () => {
    fakeRoom({ ...failedSave, captureSettled: false, localRecording: true });
    render(<GuestRoomApp token="t" />);
    expect(
      screen.getByText("Finishing your full-quality recording…"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/close this page/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Join again" })).toBeNull();
  });

  it("tells a producer who left they can close the page", () => {
    fakeRoom({
      producer: true,
      me: { ...me, role: "producer" },
      snapshot: { ...stopped, takes: failedSave.snapshot.takes },
      left: true,
    });
    render(<GuestRoomApp token="t" />);
    expect(screen.getByText("You can close this page.")).toBeInTheDocument();
  });
});

describe("GuestRoomApp dock outside the saving phase", () => {
  const SAVING = /Saving · \d+%/;
  const open = { acked: 3, total: 3, fileAck: false, uploading: false };
  const dock = () => ({
    mute: screen.queryByRole("button", { name: /^(Mute|Unmute)/ }),
    comment: screen.queryByRole("button", { name: /^Comment/ }),
    notes: screen.queryByRole("button", { name: /^Notes/ }),
  });
  const expectControls = () => {
    const { mute, comment, notes } = dock();
    expect(mute).toBeInTheDocument();
    expect(comment).toBeInTheDocument();
    expect(notes).toBeInTheDocument();
    expect(screen.queryByText(SAVING)).toBeNull();
  };

  it("keeps the controls after pause and resume with segment 1 open", () => {
    fakeRoom({ snapshot: { state: "recording" }, upload: open });
    render(<GuestRoomApp token="t" />);
    expectControls();
    expect(screen.getByRole("button", { name: /^Mute/ })).toBeInTheDocument();
  });

  it("shows Unmute and the other controls when muted after resume", () => {
    fakeRoom({
      snapshot: { state: "recording" },
      me: { ...me, muted: true },
      upload: open,
    });
    render(<GuestRoomApp token="t" />);
    expectControls();
    expect(screen.getByRole("button", { name: /^Unmute/ })).toBeInTheDocument();
  });

  it.each([
    ["segment 0 acked", true],
    ["segment 0 not yet acked", false],
  ])("keeps the controls while paused with %s", (_label, fileAck) => {
    fakeRoom({ snapshot: { state: "paused" }, upload: { ...open, fileAck } });
    render(<GuestRoomApp token="t" />);
    expectControls();
  });

  it("shows the full saving line and hides the controls after Stop", () => {
    fakeRoom({
      snapshot: stopped,
      upload: { acked: 1, total: 3, uploading: true },
    });
    render(<GuestRoomApp token="t" />);
    expect(
      screen.getByText("Saving · 33% · keep this page open"),
    ).toBeInTheDocument();
    const { mute, comment, notes } = dock();
    expect(mute).toBeNull();
    expect(comment).toBeNull();
    expect(notes).toBeNull();
    expect(leave()).toHaveAttribute("aria-disabled", "true");
  });

  it("swaps the saving line for the saved line, Done and Notes once the stopped take is file-ACK'd", () => {
    fakeRoom({
      snapshot: stopped,
      upload: { acked: 3, total: 3, fileAck: true, landed: true },
    });
    render(<GuestRoomApp token="t" />);
    expect(screen.queryByText(SAVING)).toBeNull();
    expect(
      screen.getByText("Saved to project. You can close this page."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(dock().notes).toBeInTheDocument();
    expect(dock().mute).toBeNull();
  });

  it("shows no saving line in the lobby with a leftover upload", () => {
    fakeRoom({
      snapshot: { state: "lobby" },
      upload: { acked: 1, total: 3, fileAck: false },
    });
    render(<GuestRoomApp token="t" />);
    expect(screen.queryByText(SAVING)).toBeNull();
    expect(dock().notes).toBeInTheDocument();
  });

  it.each(["recording", "paused", "stopped"] as const)(
    "never shows the saving line to a producer while %s",
    (state) => {
      fakeRoom({
        producer: true,
        me: { ...me, role: "producer" },
        snapshot: { state },
        upload: { acked: 1, total: 3, uploading: true },
      });
      render(<GuestRoomApp token="t" />);
      expect(screen.queryByText(SAVING)).toBeNull();
      expect(dock().notes).toBeInTheDocument();
      if (state !== "stopped") expect(dock().comment).toBeInTheDocument();
    },
  );

  it("keeps the controls on a stuck partial take and offers Finish saving", () => {
    fakeRoom({
      snapshot: stopped,
      upload: { acked: 1, total: 3, recoverable: true },
    });
    render(<GuestRoomApp token="t" />);
    expect(screen.queryByText(SAVING)).toBeNull();
    expect(dock().notes).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Finish saving" }),
    ).toBeInTheDocument();
  });

  it("keeps the controls after an upload error", () => {
    fakeRoom({
      snapshot: stopped,
      upload: { acked: 1, total: 3, error: "x" },
    });
    render(<GuestRoomApp token="t" />);
    expect(screen.queryByText(SAVING)).toBeNull();
    expect(dock().notes).toBeInTheDocument();
    expect(screen.getByText("Saving stopped")).toBeInTheDocument();
  });
});

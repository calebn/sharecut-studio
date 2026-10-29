import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations, expectOutsideLiveRegions } from "../test/a11y";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import { GuestRoomApp } from "./GuestRoomApp";
import type { RecordUploadProgress } from "./upload/useRecordUpload";
import type { GuestRoom } from "./useGuestRoom";

const current = vi.hoisted(() => ({ room: null as unknown }));
vi.mock("./useGuestRoom", () => ({
  useGuestRoom: () => current.room,
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
  deviceId?: string;
  keeper?: Partial<GuestRoom["keeper"]>;
  upload?: Partial<RecordUploadProgress>;
  takeClipping?: GuestRoom["takeClipping"];
  takeClippings?: GuestRoom["takeClippings"];
  keeperActions?: Partial<GuestRoom["keeperActions"]>;
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
    monitor: { hearing: false, remoteCount: 0, error: null, levels: {} },
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
    },
    liveComments: {
      note: "",
      setNote: vi.fn(),
      postMarker: vi.fn(),
      postNote: vi.fn(),
      submitNote: vi.fn(),
    },
    captureSettled: true,
    name: "Ava",
    setName: vi.fn(),
    headphonesOk: true,
    setHeadphonesOk: vi.fn(),
    deviceId: over.deviceId ?? "",
    setDeviceId: vi.fn(),
    producerJoined: true,
    setProducerJoined: vi.fn(),
    resumeUpload: vi.fn(),
  };
  current.room = room;
  return room;
}

const stopped = { state: "stopped" as const, take_index: 0 };
const leave = () => screen.getByRole("button", { name: "Leave room" });

describe("GuestRoomApp in the room", () => {
  beforeEach(() => {
    current.room = null;
  });

  it("holds Leave until the stopped take is file-ACK'd", () => {
    fakeRoom({
      snapshot: stopped,
      upload: { acked: 1, total: 3, uploading: true },
    });
    render(<GuestRoomApp token="t" />);
    expect(leave()).toBeDisabled();
    expect(leave()).toHaveAttribute(
      "title",
      "Keep this tab open until your recording is saved.",
    );
    expect(screen.getByText("Saving · 33%")).toBeInTheDocument();
  });

  it("lets Leave go after file ACK or an upload error", () => {
    fakeRoom({
      snapshot: stopped,
      upload: { acked: 3, total: 3, fileAck: true, landed: true },
    });
    const { rerender } = render(<GuestRoomApp token="t" />);
    expect(leave()).toBeEnabled();
    expect(screen.getAllByText("Saved").length).toBeGreaterThan(0);
    fakeRoom({
      snapshot: stopped,
      upload: { acked: 1, total: 3, error: "upload failed" },
    });
    rerender(<GuestRoomApp token="t" />);
    expect(leave()).toBeEnabled();
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

  it("names the host when this guest's own connection drops mid-take", () => {
    fakeRoom({ snapshot: { state: "recording" } });
    (current.room as { connected: boolean }).connected = false;
    render(<GuestRoomApp token="t" />);
    expect(screen.getByText(/Hana dropped\./)).toBeInTheDocument();
    expect(screen.getByText(/· Take 1/)).toBeInTheDocument();
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

  it("badges the guest's own tile when the take clipped, not a producer's", () => {
    const clipping = {
      takeIndex: 0,
      known: true,
      regions: [
        { segmentIndex: 0, startMs: 1000, endMs: 2000, segmentStartMs: 1000 },
      ],
    };
    fakeRoom({ takeClipping: clipping });
    const { container, rerender } = render(<GuestRoomApp token="t" />);
    expect(container.querySelector(".sys-room-clip")).toHaveTextContent("1");
    expect(
      screen.getByText("You're clipping. Move back a little."),
    ).toBeVisible();
    fakeRoom({
      producer: true,
      me: { ...me, role: "producer" },
      takeClipping: clipping,
    });
    rerender(<GuestRoomApp token="t" />);
    expect(container.querySelector(".sys-room-clip")).toBeNull();
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
      await userEvent.selectOptions(
        within(dialog).getByLabelText("Input"),
        "b",
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
          name: "Record 3 seconds of room tone",
        }),
      );
      expect(room.roomTone.record).toHaveBeenCalledOnce();
      await expectNoA11yViolations(baseElement);
    });

    it("locks the input menu and room tone while a take is running", async () => {
      fakeRoom({ mic: { devices } });
      render(<GuestRoomApp token="t" />);
      await userEvent.click(screen.getByRole("button", { name: "Devices" }));
      const dialog = await screen.findByRole("dialog", { name: "Devices" });
      expect(within(dialog).getByLabelText("Input")).toBeDisabled();
      expect(
        within(dialog).getByRole("button", {
          name: "Record 3 seconds of room tone",
        }),
      ).toBeDisabled();
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
      const select = within(dialog).getByLabelText("Input");
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
      expect(within(open).getByLabelText("Input")).toBe(select);
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

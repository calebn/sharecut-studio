import { describe, expect, it, vi } from "vitest";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import {
  guestCovers,
  guestRoomAlerts,
  guestRoomPhase,
  guestTakes,
  guestViewerWidth,
  isNotFound,
  joinHere,
  joinMic,
  ownSaving,
  savingStatus,
  tookPart,
} from "./guestRoomModel";
import { roomPeople } from "./roomPeople";
import type { RecordUploadProgress } from "./upload/useRecordUpload";

const host = recordParticipant({
  participant_id: "p_host",
  role: "host",
  display_name: "Hana",
});
const me = recordParticipant({
  participant_id: "p_g",
  display_name: "Bo",
  consented: true,
});
const other = recordParticipant({ participant_id: "p_o", display_name: "Cy" });

const upload = (over: Partial<RecordUploadProgress> = {}) =>
  ({
    acked: 0,
    total: 0,
    fileAck: false,
    uploading: false,
    pending: false,
    error: null,
    ...over,
  }) as RecordUploadProgress;

const actions = { busy: false, error: null, notice: null };

const coverSource = {
  bootError: null,
  error: null,
  accessEnded: false,
  inviteClosed: false,
  captureSettled: true,
  keeperActions: actions,
};

describe("roomPeople for a guest seat", () => {
  it("marks the guest as you, not the host", () => {
    const people = roomPeople(
      recordSnapshot({ participants: [host, me, other] }),
      { youId: "p_g", youLevel: 0.3, clipped: 1 },
    );
    expect(people.map((person) => Boolean(person.you))).toEqual([
      false,
      true,
      false,
    ]);
    expect(people[1]).toMatchObject({ level: 0.3, clipped: 1 });
  });

  it("keys people by participant and lights others from their peer level", () => {
    const people = roomPeople(
      recordSnapshot({ participants: [host, me, other] }),
      { youId: "p_g", peerLevels: { p_host: 0.6, p_o: 0.1 } },
    );
    expect(people.map((person) => person.id)).toEqual(["p_host", "p_g", "p_o"]);
    expect(people[0]).toMatchObject({ level: 0.6, speaking: true });
    expect(people[2]).toMatchObject({ level: 0.1, speaking: false });
    expect(people[1]?.level).toBeUndefined();
  });
});

describe("guestRoomPhase", () => {
  it("waits on the named host", () => {
    expect(
      guestRoomPhase(
        recordSnapshot({ state: "lobby", participants: [host, me] }),
      ),
    ).toEqual({ kind: "waiting", host: "Hana" });
    expect(guestRoomPhase(null)).toEqual({ kind: "waiting" });
  });

  it("keeps the running clock", () => {
    const snapshot = recordSnapshot({
      state: "recording",
      take_index: 1,
      recording_ms: 4000,
      participants: [host, me],
    });
    expect(guestRoomPhase(snapshot)).toMatchObject({
      kind: "live",
      take: 2,
    });
  });

  it("reads the stopped take from the guest's own upload", () => {
    const snapshot = recordSnapshot({
      state: "stopped",
      take_index: 0,
      takes: [
        {
          take_index: 0,
          consented_participant_ids: ["p_g", "p_o"],
        },
      ] as never,
      participants: [host, me, other],
    });
    expect(
      guestRoomPhase(snapshot, { upload: upload({ acked: 1, total: 3 }) }),
    ).toEqual({
      kind: "saving",
      savedPeople: 0,
      totalPeople: 1,
      percent: 33,
    });
    expect(
      guestRoomPhase(snapshot, { upload: upload({ total: 3, fileAck: true }) }),
    ).toEqual({ kind: "saved" });
    expect(guestRoomPhase(snapshot)).toEqual({ kind: "saved" });
  });

  it("reports a failed upload as a failed save, not as progress", () => {
    const snapshot = recordSnapshot({
      state: "stopped",
      take_index: 0,
      participants: [host, me],
    });
    const failed = {
      kind: "saving",
      savedPeople: 0,
      totalPeople: 1,
      failed: true,
    };
    expect(
      guestRoomPhase(snapshot, {
        upload: upload({ acked: 1, total: 3, error: "offline" }),
      }),
    ).toEqual(failed);
    expect(
      guestRoomPhase(snapshot, { upload: upload({ recoverable: true }) }),
    ).toEqual(failed);
    expect(
      guestRoomPhase(snapshot, {
        upload: upload({ total: 3, recoverable: true, uploading: true }),
      }),
    ).toMatchObject({ kind: "saving", percent: 0 });
  });

  it("does not call a stopped take saving for a guest who never uploaded", () => {
    const snapshot = recordSnapshot({
      state: "stopped",
      take_index: 0,
      takes: [{ take_index: 0, consented_participant_ids: ["p_o"] }] as never,
      participants: [host, me, other],
    });
    expect(
      guestRoomPhase(snapshot, { upload: upload(), tookPart: false }),
    ).toEqual({ kind: "waiting", host: "Hana" });
    expect(guestRoomPhase(snapshot, { tookPart: false })).toEqual({
      kind: "waiting",
      host: "Hana",
    });
    expect(
      guestRoomPhase(snapshot, { upload: upload(), tookPart: true }),
    ).toMatchObject({ kind: "saving" });
    expect(
      guestRoomPhase(snapshot, {
        upload: upload({ pending: true }),
        tookPart: false,
      }),
    ).toMatchObject({ kind: "saving" });
  });

  it("shows a reloaded take that is still uploading as saving", () => {
    const snapshot = recordSnapshot({
      state: "stopped",
      take_index: 0,
      participants: [host, me],
    });
    expect(
      guestRoomPhase(snapshot, { upload: upload({ pending: true }) }),
    ).toMatchObject({ kind: "saving" });
    expect(
      guestRoomPhase(snapshot, { upload: upload({ total: 2, fileAck: true }) }),
    ).toEqual({ kind: "saved" });
  });
});

describe("tookPart", () => {
  const stoppedWith = (ids: string[]) =>
    recordSnapshot({
      state: "stopped",
      take_index: 0,
      takes: [{ take_index: 0, consented_participant_ids: ids }] as never,
      participants: [host, me],
    });

  it("needs consent and a place on the take's roster", () => {
    expect(tookPart(stoppedWith(["p_g"]), me)).toBe(true);
    expect(tookPart(stoppedWith([]), me)).toBe(true);
    expect(tookPart(stoppedWith(["p_o"]), me)).toBe(false);
    expect(tookPart(stoppedWith(["p_g"]), { ...me, consented: false })).toBe(
      false,
    );
    expect(tookPart(stoppedWith(["p_g"]), null)).toBe(false);
    expect(tookPart(null, me)).toBe(false);
  });
});

describe("joinHere", () => {
  it("lists connected people except you and the removed", () => {
    const snapshot = recordSnapshot({
      participants: [
        host,
        me,
        other,
        recordParticipant({ participant_id: "a", connected: false }),
        recordParticipant({ participant_id: "b", removed: true }),
      ],
    });
    expect(joinHere(snapshot, me)).toEqual([
      { person: { name: "Hana", colorIndex: 0 }, role: "host" },
      { person: { name: "Cy", colorIndex: 2 }, role: "guest" },
    ]);
    expect(joinHere(null, null)).toEqual([]);
  });
});

describe("joinMic", () => {
  const device = (deviceId: string, label: string) =>
    ({ deviceId, label }) as MediaDeviceInfo;
  const base = { stream: null, devices: [] as MediaDeviceInfo[] };
  const options = { deviceId: "", levelDb: -30 };

  it("maps permission states", () => {
    expect(joinMic({ ...base, status: "idle" }, options)).toEqual({
      status: "idle",
    });
    expect(joinMic({ ...base, status: "prompting" }, options)).toEqual({
      status: "prompting",
    });
    expect(joinMic({ ...base, status: "denied" }, options)).toEqual({
      status: "denied",
    });
    for (const status of ["lost", "unavailable", "error"] as const) {
      expect(joinMic({ ...base, status }, options)).toEqual({ status: "lost" });
    }
  });

  it("is ready with the selected input and a 0..1 level", () => {
    const stream = {} as MediaStream;
    const mic = {
      status: "granted" as const,
      stream,
      devices: [device("a", "Desk"), device("b", "Headset")],
    };
    expect(
      joinMic(mic, { deviceId: "b", levelDb: 0, clipped: true }),
    ).toMatchObject({
      status: "ready",
      input: "Headset",
      level: 1,
      clipped: true,
    });
    const ready = joinMic(mic, { deviceId: "", levelDb: -Infinity });
    expect(ready).toMatchObject({ input: "Desk", level: 0 });
    expect(joinMic({ ...mic, devices: [] }, options)).toMatchObject({
      input: "Microphone",
    });
  });

  it("offers the inputs once there is a choice, and carries the lock", () => {
    const mic = {
      status: "granted" as const,
      stream: {} as MediaStream,
      devices: [device("a", "Desk"), device("b", "Headset")],
    };
    expect(
      joinMic(mic, { deviceId: "b", levelDb: -30, inputLocked: true }),
    ).toMatchObject({
      devices: [
        { id: "a", label: "Desk" },
        { id: "b", label: "Headset" },
      ],
      inputId: "b",
      inputLocked: true,
    });
    expect(
      joinMic({ ...mic, devices: [device("a", "Desk")] }, options),
    ).not.toHaveProperty("devices");
  });

  it("carries why the microphone is lost", () => {
    expect(
      joinMic({ ...base, status: "lost" }, { ...options, detail: "Gone." }),
    ).toEqual({ status: "lost", detail: "Gone." });
  });

  it("keeps the lock on a lost microphone's input menu", () => {
    const lost = {
      ...base,
      status: "lost" as const,
      devices: [device("a", "Desk"), device("b", "Headset")],
    };
    expect(
      joinMic(lost, { ...options, deviceId: "a", inputLocked: true }),
    ).toMatchObject({ status: "lost", inputId: "a", inputLocked: true });
    expect(joinMic(lost, { ...options, deviceId: "a" })).not.toHaveProperty(
      "inputLocked",
      true,
    );
  });

  it("keeps the lost input menu on Default and after a stale saved input", () => {
    const lost = {
      ...base,
      status: "lost" as const,
      devices: [device("a", "Desk"), device("b", "Headset")],
    };
    expect(joinMic(lost, { ...options, deviceId: "" })).toMatchObject({
      status: "lost",
      devices: [
        { id: "a", label: "Desk" },
        { id: "b", label: "Headset" },
      ],
      inputId: "",
    });
  });

  it("is not ready while granted without a stream", () => {
    expect(joinMic({ ...base, status: "granted" }, options)).toEqual({
      status: "idle",
    });
  });
});

describe("guestViewerWidth", () => {
  it("separates phone, phone landscape and desktop", () => {
    expect(guestViewerWidth("phone", false)).toBe("phone");
    expect(guestViewerWidth("phone", true)).toBe("phone-landscape");
    expect(guestViewerWidth("tablet", true)).toBe("desktop");
    expect(guestViewerWidth("desktop", false)).toBe("desktop");
  });
});

describe("guestRoomAlerts", () => {
  const source = {
    state: "recording" as const,
    captureHealth: null,
    keeperError: null,
    micLost: false,
    sinkError: null,
    uploadError: null,
    recoverable: false,
    monitorError: null,
    transportError: null,
    clipped: 0,
    muted: false,
  };

  it("is empty when nothing is wrong", () => {
    expect(guestRoomAlerts(source)).toEqual([]);
  });

  it("wraps the shared alerts and wires actions", () => {
    const retryMic = vi.fn();
    const alerts = guestRoomAlerts(
      { ...source, micLost: true, transportError: "Try again." },
      { retryMic },
    );
    expect(alerts.map((alert) => alert.kind)).toEqual(["mic-lost", "generic"]);
    alerts[0]?.onAction?.();
    expect(retryMic).toHaveBeenCalledOnce();
  });

  it("tells a failed mic check apart from the first no-audio alert", () => {
    const noAudio = { ...source, captureHealth: "silent" as const };
    expect(guestRoomAlerts(noAudio)).toEqual([
      { kind: "no-audio", onAction: undefined, checkFailed: undefined },
    ]);
    expect(
      guestRoomAlerts({ ...noAudio, micCheckFailed: true })[0],
    ).toMatchObject({ kind: "no-audio", checkFailed: true });
    expect(guestRoomAlerts({ ...source, micCheckFailed: true })).toEqual([]);
  });

  it("carries a recovery notice as a done row", () => {
    expect(guestRoomAlerts({ ...source, notice: "Recovered it." })).toEqual([
      { kind: "notice", message: "Recovered it." },
    ]);
    expect(guestRoomAlerts({ ...source, notice: null })).toEqual([]);
  });

  it("adds host-offline for the guest's own dropped socket", () => {
    expect(
      guestRoomAlerts(
        { ...source, dropped: true, muted: true },
        {},
        "Hana",
      ).map((alert) => alert.kind),
    ).toEqual(["host-offline", "muted"]);
    expect(guestRoomAlerts({ ...source, dropped: true })[0]).toEqual({
      kind: "host-offline",
      name: undefined,
    });
  });
});

describe("savingStatus", () => {
  it("shows percent while saving", () => {
    expect(savingStatus(upload({ acked: 1, total: 4 }))).toBe(
      "Saving · 25% · keep this page open",
    );
    expect(savingStatus(upload({ acked: 4, total: 4 }))).toBe(
      "Saving · 100% · keep this page open",
    );
  });

  it("is quiet with nothing to save, once saved or when failed", () => {
    expect(savingStatus(null)).toBeNull();
    expect(savingStatus(upload())).toBeNull();
    expect(
      savingStatus(upload({ acked: 1, total: 4, fileAck: true })),
    ).toBeNull();
    expect(savingStatus(upload({ acked: 1, total: 4, error: "x" }))).toBeNull();
  });
});

describe("ownSaving", () => {
  it("follows the guest's own upload", () => {
    expect(ownSaving(null)).toBeNull();
    expect(ownSaving(upload())).toBeNull();
    expect(ownSaving(upload({ acked: 1, total: 4 }))).toEqual({
      done: 1,
      total: 4,
    });
    expect(ownSaving(upload({ total: 4, fileAck: true }))).toBe("saved");
    expect(ownSaving(upload({ total: 4, error: "x" }))).toBe("failed");
  });
});

describe("isNotFound", () => {
  it("matches missing and revoked links", () => {
    expect(isNotFound("HTTP 404")).toBe(true);
    expect(isNotFound("Token revoked")).toBe(true);
    expect(isNotFound("network down")).toBe(false);
  });
});

describe("guestCovers", () => {
  it("is null for a healthy room", () => {
    expect(guestCovers(coverSource)).toBeNull();
  });

  it("covers an invalid link and other boot failures", () => {
    expect(guestCovers({ ...coverSource, bootError: "404" })).toMatchObject({
      title: "This link doesn't open a room",
    });
    expect(
      guestCovers({ ...coverSource, bootError: "network down" }),
    ).toMatchObject({
      title: "This link does not work",
      children: "network down",
    });
  });

  it("covers a full room with a retry", () => {
    const onRetry = vi.fn();
    const cover = guestCovers({
      ...coverSource,
      error: "room_full",
      host: "Hana",
      onRetry,
    });
    expect(cover).toMatchObject({
      title: "The room is full",
      children: "Ask Hana to make space or send you a new link.",
    });
    cover?.primary?.onClick();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(guestCovers({ ...coverSource, error: "room_full" })).toMatchObject({
      children: "Ask the host to make space or send you a new link.",
      primary: undefined,
    });
  });

  it("covers a closed invite", () => {
    expect(
      guestCovers({ ...coverSource, accessEnded: true, inviteClosed: true }),
    ).toMatchObject({
      title: "Invite link closed",
      children: "The host closed this invite link. Ask for a new link.",
      primary: undefined,
      secondary: undefined,
    });
  });

  it("keeps Save and Recover on a closed invite while a local take is unsent", () => {
    const download = vi.fn();
    const recover = vi.fn();
    const closed = {
      ...coverSource,
      accessEnded: true,
      inviteClosed: true,
      host: "Hana",
    };
    const cover = guestCovers({
      ...closed,
      keeperActions: { ...actions, busy: true, download, recover },
    });
    expect(cover).toMatchObject({
      title: "Invite link closed",
      children:
        "Hana closed this invite link. Your recording is safe on this device. Save it and send it to Hana, or ask for a new link.",
      primary: { label: "Save my recording", busy: true },
      secondary: { label: "Try saving again" },
    });
    cover?.primary?.onClick();
    cover?.secondary?.onClick();
    expect(download).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledOnce();
    expect(
      guestCovers({
        ...closed,
        captureSettled: false,
        keeperActions: { ...actions, download, recover },
      }),
    ).toMatchObject({
      children: "Hana closed this invite link. Ask for a new link.",
      primary: undefined,
      secondary: undefined,
    });
    expect(
      guestCovers({ ...closed, keeperActions: { ...actions, recover } }),
    ).toMatchObject({
      primary: undefined,
      secondary: { label: "Try saving again" },
    });
  });

  it("covers ended access, with local recording actions once settled", () => {
    const download = vi.fn();
    const recover = vi.fn();
    expect(guestCovers({ ...coverSource, accessEnded: true })).toMatchObject({
      title: "This session has ended",
    });
    expect(
      guestCovers({ ...coverSource, accessEnded: true, captureSettled: false }),
    ).toMatchObject({ children: "Finishing your full-quality recording…" });
    const cover = guestCovers({
      ...coverSource,
      accessEnded: true,
      host: "Hana",
      keeperActions: { ...actions, download, recover },
    });
    expect(cover).toMatchObject({
      title: "Your recording didn't finish saving",
      children: "It's safe on this device. Save it and send it to Hana.",
    });
    cover?.primary?.onClick();
    cover?.secondary?.onClick();
    expect(download).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledOnce();
  });
});

describe("guestTakes", () => {
  const take = (index: number, ids: string[]) => ({
    take_index: index,
    session_start_wall_ms: index * 100_000,
    session_start_iso: "t",
    stopped_wall_ms: index * 100_000 + 60_000,
    pauses: [
      {
        seq: 0,
        pause_wall_ms: index * 100_000 + 10_000,
        resume_wall_ms: index * 100_000 + 20_000,
      },
    ],
    consented_participant_ids: ids,
  });
  const snapshot = (state: "stopped" | "recording" = "stopped") =>
    recordSnapshot({
      state,
      take_index: 2,
      participants: [host, me],
      takes: [
        take(0, ["p_host", "p_g"]),
        take(1, ["p_host", "p_g"]),
        take(2, ["p_host", "p_g"]),
      ],
    });
  const clip = (takeIndex: number, ...startMs: number[]) => ({
    takeIndex,
    known: true,
    regions: startMs.map((ms) => ({
      segmentIndex: 0,
      startMs: ms,
      endMs: ms + 500,
      segmentStartMs: ms,
    })),
  });
  const saved = (take: number) => ({
    take,
    segment: 0,
    state: "saved" as const,
    chunks: null,
    landFailed: false,
  });

  it("lists only the takes where this guest clipped, with only their own line", () => {
    const takes = guestTakes(snapshot(), me, [saved(0), saved(1)], {
      0: clip(0, 134_000, 340_000),
      1: clip(1),
      2: clip(2, 5000),
    });
    expect(takes.map((t) => [t.number, t.lengthSec])).toEqual([
      [1, 50],
      [3, 50],
    ]);
    expect(takes[0]?.people).toEqual([
      {
        person: { name: "Bo", colorIndex: 1 },
        line: { kind: "saved" },
        clipTimes: ["2:14", "5:40"],
        clipTruncated: undefined,
      },
    ]);
    expect(takes[1]?.people[0]?.line).toEqual({
      kind: "saving",
      done: 0,
      total: 1,
    });
  });

  it("is empty for a clean room, a producer, a guest who sat the take out or an open take", () => {
    expect(guestTakes(snapshot(), me, [], { 0: clip(0) })).toEqual([]);
    expect(
      guestTakes(snapshot(), { ...me, consented: null }, [], { 0: clip(0, 1) }),
    ).toEqual([]);
    expect(
      guestTakes(snapshot(), { ...me, participant_id: "p_o" }, [], {
        0: clip(0, 1),
      }),
    ).toEqual([]);
    expect(
      guestTakes(snapshot("recording"), me, [], { 2: clip(2, 1) }),
    ).toEqual([]);
    expect(guestTakes(null, me, [], { 0: clip(0, 1) })).toEqual([]);
  });

  it("shows saving progress from the chunks until every segment is saved", () => {
    const [row] = guestTakes(
      snapshot(),
      me,
      [
        { ...saved(0), state: "saving", chunks: { acked: 1, total: 4 } },
        { ...saved(0), segment: 1, state: "saved" },
      ],
      { 0: { ...clip(0, 1000), truncated: true } },
    );
    expect(row?.people[0]).toMatchObject({
      line: { kind: "saving", done: 1, total: 4 },
      clipTruncated: true,
    });
  });
});

describe("joinMic while the input switches", () => {
  const devices = [
    { deviceId: "a", label: "USB Mic" },
    { deviceId: "b", label: "Headset" },
  ] as MediaDeviceInfo[];
  const options = { deviceId: "b", levelDb: -60, switching: true };

  it("keeps the menu on the picked input, not ready to join", () => {
    for (const status of ["prompting", "idle"] as const) {
      expect(joinMic({ status, stream: null, devices }, options)).toMatchObject(
        {
          status: "ready",
          input: "Headset",
          inputId: "b",
          switching: true,
        },
      );
    }
  });

  it("falls back to the plain state without a menu to keep", () => {
    expect(
      joinMic({ status: "prompting", stream: null, devices: [] }, options),
    ).toEqual({ status: "prompting" });
    expect(
      joinMic({ status: "denied", stream: null, devices }, options),
    ).toEqual({ status: "denied" });
  });
});

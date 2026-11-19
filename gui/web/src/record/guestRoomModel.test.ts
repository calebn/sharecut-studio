import { describe, expect, it, vi } from "vitest";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import {
  guestCovers,
  guestRoomAlerts,
  guestRoomPhase,
  guestTakes,
  guestViewerWidth,
  hostGoneMidTake,
  joinHere,
  joinMic,
  ownSaving,
  tookAnyTake,
  tookPart,
  uploadInFlight,
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
    seenSegments: 0,
    uploading: false,
    pending: false,
    error: null,
    ...over,
  }) as RecordUploadProgress;

const actions = {
  busy: false,
  error: null,
  notice: null,
  downloaded: false,
};

const coverSource = {
  bootError: null,
  error: null,
  accessEnded: false,
  inviteClosed: false,
  left: false,
  stake: "none" as const,
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
        { localSegments: 0 },
      ),
    ).toEqual({ kind: "waiting", host: "Hana" });
    expect(guestRoomPhase(null, { localSegments: 0 })).toEqual({
      kind: "waiting",
    });
  });

  it("keeps the running clock", () => {
    const snapshot = recordSnapshot({
      state: "recording",
      take_index: 1,
      recording_ms: 4000,
      participants: [host, me],
    });
    expect(guestRoomPhase(snapshot, { localSegments: 0 })).toMatchObject({
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
      guestRoomPhase(snapshot, {
        localSegments: 0,
        upload: upload({ acked: 1, total: 3 }),
      }),
    ).toEqual({
      kind: "saving",
      savedPeople: 0,
      totalPeople: 1,
      percent: 33,
    });
    expect(
      guestRoomPhase(snapshot, {
        localSegments: 0,
        upload: upload({ total: 3, fileAck: true }),
      }),
    ).toEqual({ kind: "saved" });
    expect(guestRoomPhase(snapshot, { localSegments: 0 })).toEqual({
      kind: "saved",
    });
  });

  it("does not read a stale acknowledgement as saved when the device holds more", () => {
    const snapshot = recordSnapshot({
      state: "stopped",
      take_index: 0,
      participants: [host, me],
    });
    const acknowledged = upload({ total: 1, fileAck: true, seenSegments: 1 });
    expect(
      guestRoomPhase(snapshot, { upload: acknowledged, localSegments: 1 }),
    ).toEqual({ kind: "saved" });
    expect(
      guestRoomPhase(snapshot, { upload: acknowledged, localSegments: 2 }),
    ).toMatchObject({ kind: "saving" });
  });

  it("never reads an unknown device count as saved", () => {
    const snapshot = recordSnapshot({
      state: "stopped",
      take_index: 0,
      participants: [host, me],
    });
    const acknowledged = upload({ total: 1, fileAck: true, seenSegments: 1 });
    expect(
      guestRoomPhase(snapshot, { upload: acknowledged, localSegments: null }),
    ).toMatchObject({ kind: "saving" });
  });

  it("neither says saved nor holds Leave for an acknowledged upload whose device count is unknown", () => {
    expect(
      uploadInFlight(
        upload({ total: 1, fileAck: true, seenSegments: 1 }),
        null,
      ),
    ).toBe(false);
    expect(uploadInFlight(upload({ total: 1, pending: true }), null)).toBe(
      true,
    );
  });

  it("reads an acknowledged upload as stopped once the device scan failed twice", () => {
    const snapshot = recordSnapshot({
      state: "stopped",
      take_index: 0,
      participants: [host, me],
    });
    const acknowledged = upload({ total: 1, fileAck: true, seenSegments: 1 });
    expect(
      guestRoomPhase(snapshot, {
        upload: acknowledged,
        localSegments: null,
        localUnreadable: true,
      }),
    ).toMatchObject({ kind: "saving", failed: true });
    expect(ownSaving(acknowledged, null, true)).toBe("failed");
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
        localSegments: 0,
        upload: upload({ acked: 1, total: 3, error: "offline" }),
      }),
    ).toEqual(failed);
    expect(
      guestRoomPhase(snapshot, {
        localSegments: 0,
        upload: upload({ recoverable: true }),
      }),
    ).toEqual(failed);
    expect(
      guestRoomPhase(snapshot, {
        localSegments: 0,
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
      guestRoomPhase(snapshot, {
        localSegments: 0,
        upload: upload(),
        tookPart: false,
      }),
    ).toEqual({ kind: "waiting", host: "Hana" });
    expect(
      guestRoomPhase(snapshot, { localSegments: 0, tookPart: false }),
    ).toEqual({
      kind: "waiting",
      host: "Hana",
    });
    expect(
      guestRoomPhase(snapshot, {
        localSegments: 0,
        upload: upload(),
        tookPart: true,
      }),
    ).toMatchObject({ kind: "saving" });
    expect(
      guestRoomPhase(snapshot, {
        localSegments: 0,
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
      guestRoomPhase(snapshot, {
        localSegments: 0,
        upload: upload({ pending: true }),
      }),
    ).toMatchObject({ kind: "saving" });
    expect(
      guestRoomPhase(snapshot, {
        localSegments: 0,
        upload: upload({ total: 2, fileAck: true }),
      }),
    ).toEqual({ kind: "saved" });
  });
});

describe("guestRoomPhase when this page's socket drops", () => {
  it("a dropped socket mid-take reads reconnecting and keeps the take clock", () => {
    const snapshot = recordSnapshot({
      state: "recording",
      take_index: 0,
      recording_ms: 42_000,
      participants: [host, me],
    });
    expect(
      guestRoomPhase(snapshot, {
        localSegments: 0,
        connected: false,
        elapsedSinceSnapshotMs: 1000,
      }),
    ).toEqual({ kind: "reconnecting", paused: false, clockSec: 43 });
  });

  it("a dropped socket while waiting stays waiting", () => {
    expect(
      guestRoomPhase(
        recordSnapshot({ state: "lobby", participants: [host, me] }),
        { connected: false, localSegments: 0 },
      ),
    ).toEqual({ kind: "waiting", host: "Hana" });
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
    clipping: false,
    mutedSpeech: false,
    phase: { kind: "live" as const, take: 1, clockSec: 5 },
    inTake: true,
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

  it("a recorded guest's dropped socket raises connection-lost, never host-offline", () => {
    const alerts = guestRoomAlerts({
      ...source,
      phase: { kind: "reconnecting", paused: false, clockSec: 43 },
    });
    expect(alerts.map((alert) => alert.kind)).toEqual(["connection-lost"]);
  });

  it("a paused drop raises no connection alert", () => {
    expect(
      guestRoomAlerts({
        ...source,
        phase: { kind: "reconnecting", paused: true },
      }),
    ).toEqual([]);
  });

  describe("while this page is offline", () => {
    const offline = {
      ...source,
      uploadError: "Network error",
      phase: { kind: "reconnecting" as const, paused: false, clockSec: 43 },
    };
    const kinds = (input: Parameters<typeof guestRoomAlerts>[0]) =>
      guestRoomAlerts(input).map((alert) => alert.kind);

    it("shows only the connection alert on a take the guest is in", () => {
      expect(kinds(offline)).toEqual(["connection-lost"]);
    });

    it("brings the upload failure back once the page is connected again", () => {
      expect(kinds({ ...offline, phase: source.phase })).toEqual([
        "saving-failed",
      ]);
    });

    it("keeps the upload failure on a paused take, where no connection alert is raised", () => {
      expect(
        kinds({
          ...offline,
          state: "paused",
          phase: { kind: "reconnecting", paused: true },
        }),
      ).toEqual(["saving-failed"]);
    });

    it("keeps the upload failure for a guest who is on air but not in the take", () => {
      expect(kinds({ ...offline, inTake: false })).toEqual(["saving-failed"]);
    });

    it("keeps the upload failure after Stop", () => {
      expect(
        kinds({
          ...offline,
          state: "stopped",
          phase: { kind: "saving", savedPeople: 0, totalPeople: 1 },
        }),
      ).toEqual(["saving-failed"]);
    });

    it("keeps the other alerts beside the connection alert", () => {
      expect(kinds({ ...offline, micLost: true })).toEqual([
        "mic-lost",
        "connection-lost",
      ]);
    });
  });

  it("a dropped socket raises no connection alert for a guest outside the take", () => {
    expect(
      guestRoomAlerts({
        ...source,
        inTake: false,
        phase: { kind: "reconnecting", paused: false, clockSec: 43 },
      }),
    ).toEqual([]);
  });
});

describe("tookAnyTake", () => {
  it("reads the server roster, so it holds after a reload", () => {
    const roster = (ids: string[]) =>
      recordSnapshot({
        take_index: 1,
        participants: [host, me],
        takes: [
          { take_index: 0, consented_participant_ids: ids },
          { take_index: 1, consented_participant_ids: [] },
        ] as never,
      });
    const consented = { ...me, consented: true };
    expect(tookAnyTake(roster(["p_g"]), consented)).toBe(true);
    expect(tookAnyTake(roster(["p_o"]), consented)).toBe(false);
    expect(tookAnyTake(roster(["p_g"]), { ...me, consented: null })).toBe(
      false,
    );
    expect(tookAnyTake(null, consented)).toBe(false);
  });
});

describe("ownSaving", () => {
  it("follows the guest's own upload", () => {
    expect(ownSaving(null, 0)).toBeNull();
    expect(ownSaving(upload(), 0)).toBeNull();
    expect(ownSaving(upload({ acked: 1, total: 4 }), 0)).toEqual({
      done: 1,
      total: 4,
    });
    expect(ownSaving(upload({ total: 4, fileAck: true }), 0)).toBe("saved");
    expect(ownSaving(upload({ total: 4, error: "x" }), 0)).toBe("failed");
  });

  it("does not call an acknowledged take saved while the device count is unknown", () => {
    const acknowledged = upload({ total: 2, fileAck: true, seenSegments: 1 });
    expect(ownSaving(acknowledged, null)).toEqual({ done: 0, total: 2 });
  });

  it("trusts an acknowledgement only for the segments its pass saw", () => {
    const acknowledged = upload({ total: 2, fileAck: true, seenSegments: 1 });
    expect(ownSaving(acknowledged, 1)).toBe("saved");
    expect(ownSaving(acknowledged, 2)).toEqual({ done: 0, total: 2 });
  });
});

describe("guestCovers", () => {
  it("is null for a healthy room", () => {
    expect(guestCovers(coverSource)).toBeNull();
  });

  it.each([
    [
      "not-found",
      {
        glyph: "octagon-alert",
        title: "This link doesn't open a room",
        children: "Ask the person who invited you for a new link.",
      },
      false,
    ],
    [
      "network",
      {
        glyph: "cloud-off",
        title: "Couldn't reach the room",
        children:
          "Check your internet connection, then try again. If it keeps happening, let the person who invited you know.",
      },
      true,
    ],
    [
      "server",
      {
        glyph: "triangle-alert",
        title: "The room didn't answer",
        children:
          "Try again in a minute. If it keeps happening, let the person who invited you know.",
      },
      true,
    ],
  ] as const)(
    "covers each boot failure with its own words and never the server's (%s)",
    (bootError, copy, retries) => {
      const onRetry = vi.fn();
      const cover = guestCovers({ ...coverSource, bootError, onRetry });
      expect(cover).toEqual({
        size: "page",
        ...copy,
        primary: retries ? { label: "Try again", onClick: onRetry } : undefined,
      });
      cover?.primary?.onClick();
      expect(onRetry).toHaveBeenCalledTimes(retries ? 1 : 0);
    },
  );

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

  describe("after Save my recording handed the whole zip to the browser", () => {
    const downloaded = {
      busy: false,
      error: null,
      notice: null,
      download: vi.fn(),
      downloaded: true,
    };

    it.each([
      ["the ended cover", { accessEnded: true }],
      ["the invite-closed cover", { accessEnded: true, inviteClosed: true }],
    ])("says Check your downloads with Save it again on %s", (_name, over) => {
      const cover = guestCovers({
        ...coverSource,
        ...over,
        keeperActions: downloaded,
        host: "Hana",
      });
      expect(cover).toMatchObject({
        glyph: "download",
        title: "Check your downloads",
        children:
          "Look for the zip file of your recording and send it to Hana. If it isn't there, save it again.",
        secondary: { label: "Save it again" },
      });
      expect(cover?.primary).toBeUndefined();
      cover?.secondary?.onClick();
      expect(downloaded.download).toHaveBeenCalledOnce();
    });

    it("shows no cover for a room still running", () => {
      expect(
        guestCovers({
          ...coverSource,
          accessEnded: false,
          keeperActions: downloaded,
        }),
      ).toBeNull();
    });

    it("lets Finishing your full-quality recording win while capture is still settling", () => {
      expect(
        guestCovers({
          ...coverSource,
          accessEnded: true,
          stake: "finishing",
          keeperActions: downloaded,
        }),
      ).toMatchObject({
        title: "This session has ended",
        children: "Finishing your full-quality recording… Keep this page open.",
      });
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

  it("does not call the device safe on a closed invite when its scan could not be read", () => {
    const cover = guestCovers({
      ...coverSource,
      accessEnded: true,
      inviteClosed: true,
      host: "Hana",
      stake: "unsent",
      localUnreadable: true,
      keeperActions: { ...actions, download: vi.fn(), recover: vi.fn() },
    });
    expect(cover).toMatchObject({
      title: "Invite link closed",
      children:
        "Hana closed this invite link. We couldn't check this device. Try saving it again, or save a copy, or ask for a new link.",
      primary: { label: "Save my recording" },
      secondary: { label: "Try saving again" },
    });
    expect(cover?.children).toEqual(
      expect.not.stringContaining("safe on this device"),
    );
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
      stake: "unsent",
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
        stake: "finishing",
        keeperActions: { ...actions, download, recover },
      }),
    ).toMatchObject({
      children: "Hana closed this invite link. Ask for a new link.",
      primary: undefined,
      secondary: undefined,
    });
    expect(
      guestCovers({
        ...closed,
        stake: "unsent",
        keeperActions: { ...actions, recover },
      }),
    ).toMatchObject({
      primary: undefined,
      secondary: { label: "Try saving again" },
    });
  });

  it("says Saving… only on the action that was pressed, and holds both while it runs", () => {
    const download = vi.fn();
    const recover = vi.fn();
    const ended = {
      ...coverSource,
      accessEnded: true,
      stake: "unsent" as const,
    };
    const recovering = guestCovers({
      ...ended,
      keeperActions: {
        ...actions,
        busy: true,
        running: "recover",
        download,
        recover,
      },
    });
    expect(recovering?.primary).toMatchObject({
      label: "Save my recording",
      busy: true,
      busyLabel: undefined,
    });
    expect(recovering?.secondary).toMatchObject({
      label: "Try saving again",
      busy: true,
      busyLabel: "Saving…",
    });
    const downloading = guestCovers({
      ...ended,
      keeperActions: {
        ...actions,
        busy: true,
        running: "download",
        download,
        recover,
      },
    });
    expect(downloading?.primary).toMatchObject({ busyLabel: "Saving…" });
    expect(downloading?.secondary).toMatchObject({
      busy: true,
      busyLabel: undefined,
    });
    const leftRunning = guestCovers({
      ...coverSource,
      left: true,
      stake: "unsent",
      keeperActions: {
        ...actions,
        busy: true,
        running: "recover",
        download,
        recover,
      },
    });
    expect(leftRunning?.primary).toMatchObject({
      busy: true,
      busyLabel: undefined,
    });
    expect(leftRunning?.secondary).toMatchObject({
      busy: true,
      busyLabel: "Saving…",
    });
  });

  it("does not call the device safe when its scan could not be read", () => {
    const download = vi.fn();
    const recover = vi.fn();
    const unreadable = {
      ...coverSource,
      stake: "unsent" as const,
      host: "Hana",
      localUnreadable: true,
      keeperActions: { ...actions, download, recover },
    };
    for (const state of [{ accessEnded: true }, { left: true }]) {
      const cover = guestCovers({ ...unreadable, ...state });
      expect(cover).toMatchObject({
        title: "Your recording didn't finish saving",
        children:
          "We couldn't check this device. Try saving it again, or save a copy.",
        primary: { label: "Save my recording" },
        secondary: { label: "Try saving again" },
      });
      expect(cover?.children).toEqual(
        expect.not.stringContaining("safe on this device"),
      );
    }
  });

  it("keeps the safe wording when the scan was readable", () => {
    expect(
      guestCovers({
        ...coverSource,
        accessEnded: true,
        stake: "unsent",
        host: "Hana",
        localUnreadable: false,
        keeperActions: actions,
      }),
    ).toMatchObject({
      children: "It's safe on this device. Save it and send it to Hana.",
    });
  });

  it("covers ended access, with local recording actions once settled", () => {
    const download = vi.fn();
    const recover = vi.fn();
    expect(guestCovers({ ...coverSource, accessEnded: true })).toMatchObject({
      title: "This session has ended",
    });
    expect(
      guestCovers({ ...coverSource, accessEnded: true, stake: "finishing" }),
    ).toMatchObject({
      children: "Finishing your full-quality recording… Keep this page open.",
    });
    const cover = guestCovers({
      ...coverSource,
      accessEnded: true,
      stake: "unsent",
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

describe("guestCovers after leaving", () => {
  it("a guest who left with nothing at stake is told they can close the page", () => {
    const onRetry = vi.fn();
    const cover = guestCovers({
      ...coverSource,
      left: true,
      host: "Hana",
      onRetry,
    });
    expect(cover).toMatchObject({
      title: "You left the room",
      children: "You can close this page.",
      primary: { label: "Join again" },
    });
    cover?.primary?.onClick();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("a guest who left after a saved take is told it is saved", () => {
    expect(
      guestCovers({
        ...coverSource,
        left: true,
        stake: "saved",
        host: "Hana",
      }),
    ).toMatchObject({
      title: "You left the room",
      children:
        "Your recording is saved to Hana's project. You can close this page.",
    });
    expect(
      guestCovers({ ...coverSource, left: true, stake: "saved" })?.children,
    ).toBe(
      "Your recording is saved to the host's project. You can close this page.",
    );
  });

  it("a guest who left while saving had stopped is offered Save my recording", () => {
    const download = vi.fn();
    const recover = vi.fn();
    const cover = guestCovers({
      ...coverSource,
      left: true,
      stake: "unsent",
      host: "Hana",
      keeperActions: { ...actions, download, recover },
    });
    expect(cover).toMatchObject({
      title: "Your recording didn't finish saving",
      primary: { label: "Save my recording" },
      secondary: { label: "Try saving again" },
    });
  });

  it("a guest who left while capture finishes is told so, with no Join again", () => {
    const cover = guestCovers({
      ...coverSource,
      left: true,
      stake: "finishing",
      onRetry: vi.fn(),
    });
    expect(cover).toMatchObject({
      title: "You left the room",
      children: "Finishing your full-quality recording… Keep this page open.",
      primary: undefined,
    });
  });

  it("lets a boot error or ended access outrank having left", () => {
    expect(
      guestCovers({ ...coverSource, left: true, bootError: "not-found" }),
    ).toMatchObject({ title: "This link doesn't open a room" });
    expect(
      guestCovers({ ...coverSource, left: true, accessEnded: true }),
    ).toMatchObject({ title: "This session has ended" });
  });
});

describe("guestCovers Join again on the unsent cover", () => {
  const download = vi.fn();
  const recover = vi.fn();
  const unsentLeft = (over: Record<string, unknown> = {}) => ({
    ...coverSource,
    left: true,
    stake: "unsent" as const,
    host: "Hana",
    leaseFresh: true,
    onRetry: vi.fn(),
    keeperActions: { ...actions, download, recover },
    ...over,
  });

  it("offers Join again as a tertiary action under Save my recording and Try saving again", () => {
    const onRetry = vi.fn();
    const cover = guestCovers(unsentLeft({ onRetry }));
    expect(cover).toMatchObject({
      title: "Your recording didn't finish saving",
      children:
        "It's safe on this device. Save it and send it to Hana. Or join again from this page.",
      primary: { label: "Save my recording" },
      secondary: { label: "Try saving again" },
      tertiary: { label: "Join again" },
    });
    cover?.tertiary?.onClick();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("does not promise an upload", () => {
    const cover = guestCovers(unsentLeft());
    expect(cover?.children).toEqual(
      expect.not.stringMatching(/upload|send it from here/i),
    );
  });

  it("keeps the plain copy and no Join again when the lease is not known to be fresh", () => {
    for (const leaseFresh of [false, undefined]) {
      const cover = guestCovers(unsentLeft({ leaseFresh }));
      expect(cover?.tertiary).toBeUndefined();
      expect(cover?.children).toBe(
        "It's safe on this device. Save it and send it to Hana.",
      );
    }
  });

  it("offers no Join again without a retry to run", () => {
    const cover = guestCovers(unsentLeft({ onRetry: undefined }));
    expect(cover?.tertiary).toBeUndefined();
    expect(cover?.children).toBe(
      "It's safe on this device. Save it and send it to Hana.",
    );
  });

  it("offers no Join again to a guest the host removed", () => {
    const cover = guestCovers(unsentLeft({ accessEnded: true }));
    expect(cover).toMatchObject({
      title: "Your recording didn't finish saving",
      primary: { label: "Save my recording" },
    });
    expect(cover?.tertiary).toBeUndefined();
  });

  it("offers no Join again once the invite link is closed", () => {
    const cover = guestCovers(
      unsentLeft({ accessEnded: true, inviteClosed: true }),
    );
    expect(cover?.title).toBe("Invite link closed");
    expect(cover?.tertiary).toBeUndefined();
  });

  it("offers no Join again when the device could not be read", () => {
    const cover = guestCovers(unsentLeft({ localUnreadable: true }));
    expect(cover).toMatchObject({
      children:
        "We couldn't check this device. Try saving it again, or save a copy.",
    });
    expect(cover?.tertiary).toBeUndefined();
  });

  it("offers no Join again while capture is still finishing", () => {
    const cover = guestCovers(unsentLeft({ stake: "finishing" }));
    expect(cover?.tertiary).toBeUndefined();
    expect(cover?.primary).toBeUndefined();
  });

  it("offers no Join again on Check your downloads", () => {
    const cover = guestCovers(
      unsentLeft({ keeperActions: { ...actions, download, downloaded: true } }),
    );
    expect(cover?.title).toBe("Check your downloads");
    expect(cover?.tertiary).toBeUndefined();
  });

  it("leaves the saved cover as it was, with Join again as its primary", () => {
    const cover = guestCovers(unsentLeft({ stake: "saved" }));
    expect(cover).toMatchObject({
      title: "You left the room",
      primary: { label: "Join again" },
    });
    expect(cover?.tertiary).toBeUndefined();
  });

  it("holds Join again busy with the other actions while a save runs", () => {
    const cover = guestCovers(
      unsentLeft({
        keeperActions: {
          ...actions,
          busy: true,
          running: "recover",
          download,
          recover,
        },
      }),
    );
    expect(cover?.tertiary).toMatchObject({ label: "Join again", busy: true });
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

describe("hostGoneMidTake", () => {
  const people = (hostLeft: boolean) =>
    roomPeople(
      recordSnapshot({
        state: "recording",
        participants: [
          recordParticipant({
            participant_id: "p_host",
            role: "host",
            display_name: "Hana",
            connected: !hostLeft,
          }),
          me,
        ],
      }),
      { youId: "p_g" },
    );
  const live = { kind: "live" as const, take: 1, clockSec: 5 };

  it("is true when the host is seen gone on a live or paused take and this page is connected", () => {
    expect(hostGoneMidTake(people(true), live, true)).toBe(true);
    expect(
      hostGoneMidTake(people(true), { kind: "paused", clockSec: 5 }, true),
    ).toBe(true);
  });

  it("is false while the host is there", () => {
    expect(hostGoneMidTake(people(false), live, true)).toBe(false);
  });

  it("is false while the host is there and another guest has left", () => {
    const room = roomPeople(
      recordSnapshot({
        state: "recording",
        participants: [
          recordParticipant({
            participant_id: "p_host",
            role: "host",
            display_name: "Hana",
          }),
          me,
          recordParticipant({
            participant_id: "p_o",
            display_name: "Cy",
            connected: false,
          }),
        ],
      }),
      { youId: "p_g" },
    );
    expect(room.find((person) => person.id === "p_o")?.presence).toBe("left");
    expect(hostGoneMidTake(room, live, true)).toBe(false);
  });

  it("is false when this page's own connection is down, whatever the stale snapshot says", () => {
    expect(
      hostGoneMidTake(
        people(true),
        { kind: "reconnecting", paused: false, clockSec: 5 },
        false,
      ),
    ).toBe(false);
    expect(hostGoneMidTake(people(true), live, false)).toBe(false);
  });

  it("is false outside a take", () => {
    expect(
      hostGoneMidTake(people(true), { kind: "waiting", host: "Hana" }, true),
    ).toBe(false);
    expect(hostGoneMidTake(people(true), { kind: "saved" }, true)).toBe(false);
  });
});

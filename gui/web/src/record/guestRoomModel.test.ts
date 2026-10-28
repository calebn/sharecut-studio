import { describe, expect, it, vi } from "vitest";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import {
  guestCovers,
  guestRoomAlerts,
  guestRoomPhase,
  guestViewerWidth,
  isNotFound,
  joinHere,
  joinMic,
  savingStatus,
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
    expect(guestRoomPhase(snapshot, { upload: upload({ total: 3 }) })).toEqual({
      kind: "saving",
      savedPeople: 0,
      totalPeople: 1,
    });
    expect(
      guestRoomPhase(snapshot, { upload: upload({ total: 3, fileAck: true }) }),
    ).toEqual({ kind: "saved" });
    expect(guestRoomPhase(snapshot)).toEqual({ kind: "saved" });
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
    expect(joinMic(mic, { deviceId: "b", levelDb: 0, clipped: true })).toEqual({
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
    ).toMatchObject({ title: "Invite link closed" });
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

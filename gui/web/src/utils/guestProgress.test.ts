import { describe, expect, it, vi } from "vitest";
import { guestProgressToJob, guestProgressWsUrl } from "./guestProgress";

describe("guestProgressToJob", () => {
  it("maps a running event to an Activity job snapshot without host paths", () => {
    const job = guestProgressToJob({
      type: "progress",
      plane: "progress",
      kind: "update",
      task_id: "guest_render_preview",
      label: "Render preview",
      message: "Mixing stems",
      current: 1,
      total: 2,
      elapsed_sec: 3,
      status: "running",
    });
    expect(job?.kind).toBe("agent");
    expect(job?.status).toBe("running");
    expect(job?.project_path).toBe("");
    expect(job?.message).toBe("Mixing stems");
  });

  it("maps end to ok and fail to error", () => {
    expect(
      guestProgressToJob({
        type: "progress",
        plane: "progress",
        kind: "end",
        status: "ok",
        message: "done",
      })?.status,
    ).toBe("ok");
    expect(
      guestProgressToJob({
        type: "progress",
        plane: "progress",
        kind: "fail",
        status: "error",
        message: "boom",
      })?.status,
    ).toBe("error");
    expect(
      guestProgressToJob({
        type: "progress",
        plane: "progress",
        kind: "fail",
        status: "error",
        message: "boom",
      })?.error,
    ).toBe("boom");
  });

  it("keeps cancelled and maps an unknown status to running", () => {
    expect(
      guestProgressToJob({
        type: "progress",
        plane: "progress",
        status: "cancelled",
      })?.status,
    ).toBe("cancelled");
    expect(
      guestProgressToJob({
        type: "progress",
        plane: "progress",
        status: "weird",
      })?.status,
    ).toBe("running");
  });

  it("ignores other planes", () => {
    const prev = guestProgressToJob({
      type: "progress",
      plane: "progress",
      status: "running",
      task_id: "keep",
    });
    expect(
      guestProgressToJob({ type: "Applied", plane: "document" }, prev)?.id,
    ).toBe("keep");
  });

  it("keeps the previous job on malformed or empty frames", () => {
    const prev = guestProgressToJob({
      type: "progress",
      plane: "progress",
      status: "running",
      task_id: "keep",
    });
    expect(guestProgressToJob({}, prev)?.id).toBe("keep");
    expect(guestProgressToJob({ type: "progress" }, prev)?.id).toBe("keep");
  });

  it("keeps the running headline on a null-message update", () => {
    const prev = guestProgressToJob({
      type: "progress",
      plane: "progress",
      status: "running",
      kind: "message",
      task_id: "guest_mute_bleed",
      label: "Mute bleed",
      message: "Scoring bleed windows…",
    });
    const next = guestProgressToJob(
      {
        type: "progress",
        plane: "progress",
        status: "running",
        kind: "update",
        task_id: "guest_mute_bleed",
        label: "Mute bleed",
        message: null,
        current: 3,
        total: 10,
      },
      prev,
    );
    expect(next?.message).toBe("Scoring bleed windows…");
    expect(next?.current).toBe(3);
  });

  it("keeps the running headline on a heartbeat", () => {
    const prev = guestProgressToJob({
      type: "progress",
      plane: "progress",
      status: "running",
      kind: "message",
      task_id: "guest_mute_bleed",
      label: "Mute bleed",
      message: "Scoring bleed windows…",
    });
    const next = guestProgressToJob(
      {
        type: "progress",
        plane: "progress",
        status: "running",
        kind: "heartbeat",
        task_id: "guest_mute_bleed",
        label: "Mute bleed",
        message: null,
      },
      prev,
    );
    expect(next?.message).toBe("Scoring bleed windows…");
  });

  it("a new event message still replaces the headline", () => {
    const prev = guestProgressToJob({
      type: "progress",
      plane: "progress",
      status: "running",
      kind: "message",
      task_id: "guest_mute_bleed",
      label: "Mute bleed",
      message: "Scoring bleed windows…",
    });
    const next = guestProgressToJob(
      {
        type: "progress",
        plane: "progress",
        status: "running",
        kind: "update",
        task_id: "guest_mute_bleed",
        label: "Mute bleed",
        message: "Applying mutes",
      },
      prev,
    );
    expect(next?.message).toBe("Applying mutes");
  });

  it("falls back to the label for a different task", () => {
    const prev = guestProgressToJob({
      type: "progress",
      plane: "progress",
      status: "running",
      kind: "message",
      task_id: "guest_mute_bleed",
      label: "Mute bleed",
      message: "Scoring bleed windows…",
    });
    const next = guestProgressToJob(
      {
        type: "progress",
        plane: "progress",
        status: "running",
        kind: "update",
        task_id: "guest_render_preview",
        label: "Render preview",
        message: null,
      },
      prev,
    );
    expect(next?.message).toBe("Render preview");
  });

  it("falls back to the label on a start frame", () => {
    const prev = guestProgressToJob({
      type: "progress",
      plane: "progress",
      status: "running",
      kind: "message",
      task_id: "guest_mute_bleed",
      label: "Mute bleed",
      message: "Scoring bleed windows…",
    });
    const next = guestProgressToJob(
      {
        type: "progress",
        plane: "progress",
        status: "running",
        kind: "start",
        task_id: "guest_mute_bleed",
        label: "Mute bleed",
        message: null,
      },
      prev,
    );
    expect(next?.message).toBe("Mute bleed");
  });

  it("does not carry a finished job's message into a new run", () => {
    const prevDone = guestProgressToJob({
      type: "progress",
      plane: "progress",
      kind: "end",
      status: "ok",
      task_id: "guest_mute_bleed",
      label: "Mute bleed",
      message: "done",
    });
    const next = guestProgressToJob(
      {
        type: "progress",
        plane: "progress",
        status: "running",
        kind: "update",
        task_id: "guest_mute_bleed",
        label: "Mute bleed",
        message: null,
      },
      prevDone,
    );
    expect(next?.message).toBe("Mute bleed");
  });
});

describe("guestProgressWsUrl", () => {
  it("builds the token-scoped progress socket", () => {
    vi.stubGlobal("window", {
      location: { protocol: "https:", host: "share.example" },
    });
    expect(guestProgressWsUrl("cool-name")).toBe(
      "wss://share.example/api/review/cool-name/progress/ws",
    );
    vi.unstubAllGlobals();
  });
});

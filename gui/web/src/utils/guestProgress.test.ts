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

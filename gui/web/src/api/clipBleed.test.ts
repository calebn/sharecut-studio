import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/commandQueue", () => ({
  submitQueuedDocumentCommand: vi.fn(),
}));

import { submitQueuedDocumentCommand } from "../services/commandQueue";
import { ApiError } from "../utils/apiError";
import { loadClipBleedInspection, restoreClipBleed } from "./clipBleed";

const request = {
  projectPath: "/tmp/project file.json",
  clipId: "clip/selected",
  trackId: "host",
  clipLabel: "Host selected clip",
};

function fixture() {
  return {
    clip_id: "clip/selected",
    track_id: "host",
    plan_state: "disabled",
    artifact_state: "missing",
    restore_state: "current",
    reasons: [],
    fade_sec: null,
    reduction: null,
    attenuation_db: null,
    saved_source_regions: [
      {
        start_s: 14.0,
        end_s: 16.0,
      },
    ],
    regions: [
      {
        kind: "bleed_mute:off_speaker",
        actual_source: {
          start_s: 10.0,
          end_s: 16.0,
        },
        source: {
          start_s: 12.0,
          end_s: 14.0,
        },
        timeline: {
          start: 30.0,
          end: 32.0,
        },
        restore_state: "available",
        target: {
          track_id: "host",
          occurrence_kind: "explicit",
          clip: {
            id: "clip/selected",
            track_id: "host",
            source_start: 12.0,
            source_end: 18.0,
            timeline_start: 30.0,
            source_id: null,
            fade_in_ms: 0,
            fade_out_ms: 0,
            join_in_mode: "fade",
            mute_regions: [],
            off_speaker_mute_regions: [
              {
                start_s: 10.0,
                end_s: 16.0,
                fade_out_ms: 5,
                fade_in_ms: 5,
              },
            ],
            bleed_restore: {
              source_sha256:
                "91050b46cb19bed96b46dbf139e9e498b0c90d5231513702dcb37515435a175e",
              regions: [
                {
                  start_s: 14.0,
                  end_s: 16.0,
                },
              ],
            },
          },
          kind: "bleed_mute:off_speaker",
          region: {
            start_s: 12.0,
            end_s: 14.0,
          },
          mapping_revision: "editorial-source-v1",
          media_seal:
            "b99f159849175a8c5c56b59c8e3bc70af20bc95f2cab0eb3f786bf1f14fe4beb",
          source_sha256:
            "91050b46cb19bed96b46dbf139e9e498b0c90d5231513702dcb37515435a175e",
          dependencies_digest:
            "9e746e4a31c9f8a6a80d5c634592948eed93a73f933af783d939000f4e171615",
          plan_digest:
            "28ffeccad42d17ff7fc9514d0fa46b41e0ec467ddc1862b867c28f69cf99665f",
          expected_head_id: "root",
        },
      },
      {
        kind: "bleed_mute:off_speaker",
        actual_source: {
          start_s: 10.0,
          end_s: 16.0,
        },
        source: {
          start_s: 14.0,
          end_s: 16.0,
        },
        timeline: {
          start: 32.0,
          end: 34.0,
        },
        restore_state: "saved",
        target: null,
      },
    ],
  };
}

function respond(value: unknown): void {
  const response = new Response();
  vi.spyOn(response, "json").mockResolvedValue(value);
  vi.mocked(fetch).mockResolvedValueOnce(response);
}

function load(value: unknown = fixture()) {
  respond(value);
  return loadClipBleedInspection(request, new AbortController().signal);
}

async function loadedTarget() {
  const inspection = await load();
  const restore = inspection.regions[0].restore;
  if (restore.state !== "available") throw new Error("Missing fixture target");
  return restore.target;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.mocked(submitQueuedDocumentCommand).mockReset();
});

afterEach(() => vi.unstubAllGlobals());

describe("loadClipBleedInspection", () => {
  it("loads a host inspection with its exact source fragments and timeline seconds", async () => {
    const wire = fixture();
    respond(wire);
    const signal = new AbortController().signal;
    const inspection = await loadClipBleedInspection(request, signal);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "/api/clips/clip%2Fselected/bleed?path=%2Ftmp%2Fproject+file.json&track_id=host",
      expect.objectContaining({ signal }),
    );
    expect(inspection).toMatchObject({
      clipLabel: "Host selected clip",
      planState: "disabled",
      planReasons: [],
      artifactState: "missing",
      restoreState: "current",
      fadeSec: null,
      reduction: null,
      attenuationDb: null,
      savedSourceSpans: [{ start: 14, end: 16 }],
      regions: [
        {
          trackId: "host",
          occurrenceId: "clip/selected",
          sourceSpan: { start: 12, end: 14 },
          timelineSpan: { start: 30, end: 32 },
          actualSourceSpan: { start: 10, end: 16 },
          restore: { state: "available", sourceSpan: { start: 12, end: 14 } },
        },
        { restore: { state: "saved" } },
      ],
    });
    const restore = inspection.regions[0].restore;
    expect(restore.state === "available" && restore.target).toBe(
      wire.regions[0].target,
    );
    expect(submitQueuedDocumentCommand).not.toHaveBeenCalled();
  });

  it("maps the active policy and plan reasons without changing either clock", async () => {
    const inspection = await load({
      ...fixture(),
      plan_state: "ready",
      artifact_state: "stale",
      fade_sec: 0.01,
      reduction: "attenuate",
      attenuation_db: -20,
      reasons: ["one_reason"],
    });
    expect(inspection).toMatchObject({
      planState: "ready",
      artifactState: "stale",
      fadeSec: 0.01,
      reduction: "attenuate",
      attenuationDb: -20,
      planReasons: ["one_reason"],
    });
  });

  it.each(["share:", "share:guest-token"])(
    "refuses %s before making any host or guest request",
    async (projectPath) => {
      await expect(
        loadClipBleedInspection(
          { ...request, projectPath },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/host/i);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["disabled", "unavailable_evidence", "ready"])(
    "preserves a valid empty %s inspection",
    async (plan_state) => {
      const inspection = await load({
        ...fixture(),
        plan_state,
        regions: [],
        fade_sec: null,
        reduction: null,
        attenuation_db: null,
      });
      expect(inspection.planState).toBe(plan_state);
      expect(inspection.regions).toEqual([]);
    },
  );

  it("preserves unavailable region state without inventing a target", async () => {
    const wire = fixture();
    const inspection = await load({
      ...wire,
      regions: [
        { ...wire.regions[0], restore_state: "unavailable", target: null },
      ],
    });
    expect(inspection.regions[0].restore).toEqual({
      state: "unavailable",
      reason: expect.any(String),
    });
  });

  it.each([
    null,
    { clip_id: "clip/selected" },
    { ...fixture(), clip_id: "other" },
    { ...fixture(), track_id: "other" },
    { ...fixture(), plan_state: "unknown" },
    { ...fixture(), artifact_state: "unknown" },
    { ...fixture(), restore_state: "unknown" },
    { ...fixture(), reasons: [12] },
    { ...fixture(), reasons: null },
    { ...fixture(), fade_sec: -1 },
    { ...fixture(), fade_sec: Infinity },
    { ...fixture(), reduction: "ordinary_mute" },
    { ...fixture(), attenuation_db: NaN },
    { ...fixture(), saved_source_regions: [{ start_s: 2, end_s: 1 }] },
    { ...fixture(), regions: null },
    ...[
      { kind: "ordinary_mute" },
      { restore_state: "unknown" },
      { source: { start_s: -1, end_s: 2 } },
      { source: { start_s: 2, end_s: 2 } },
      { source: { start_s: "1", end_s: 2 } },
      { actual_source: { start_s: 1, end_s: Infinity } },
      { timeline: { start: NaN, end: 32 } },
      { timeline: { start: -1, end: 32 } },
      { timeline: { start: 32, end: 30 } },
      { target: null },
      { target: [] },
      { target: {} },
      { restore_state: "saved" },
      { restore_state: "unavailable" },
    ].map((region) => ({
      ...fixture(),
      regions: [{ ...fixture().regions[0], ...region }],
    })),
  ])("refuses malformed inspection %#", async (wire) => {
    await expect(load(wire)).rejects.toThrow(/reduction response/i);
    expect(submitQueuedDocumentCommand).not.toHaveBeenCalled();
  });

  it.each([
    { track_id: "other" },
    { clip: { id: "other", track_id: "host" } },
    { clip: { id: "clip/selected", track_id: "other" } },
    { kind: "late_gate" },
    { region: { start_s: 10, end_s: 16 } },
    { region: { start_s: 12, end_s: 13 } },
    { occurrence_kind: "unknown" },
  ])(
    "refuses a target for another occurrence, kind, or fragment %#",
    async (target) => {
      const wire = fixture();
      await expect(
        load({
          ...wire,
          regions: [
            {
              ...wire.regions[0],
              target: { ...wire.regions[0].target, ...target },
            },
          ],
        }),
      ).rejects.toThrow(/reduction response/i);
    },
  );

  it.each([
    "media_seal",
    "source_sha256",
    "dependencies_digest",
    "plan_digest",
    "expected_head_id",
  ])("refuses a target missing its required %s", async (field) => {
    const wire = fixture();
    const target: Record<string, unknown> = { ...wire.regions[0].target };
    delete target[field];
    await expect(
      load({ ...wire, regions: [{ ...wire.regions[0], target }] }),
    ).rejects.toThrow(/reduction response/i);
    expect(submitQueuedDocumentCommand).not.toHaveBeenCalled();
  });

  it.each([
    { media_seal: null },
    { media_seal: 12 },
    { dependencies_digest: null },
    { dependencies_digest: 12 },
    { plan_digest: null },
    { plan_digest: 12 },
    { expected_head_id: "" },
    { expected_head_id: null },
    { expected_head_id: 12 },
    { source_sha256: null },
    { source_sha256: "not-a-hash" },
    { source_sha256: "A".repeat(64) },
    { source_sha256: "a".repeat(63) },
    { source_sha256: `${"a".repeat(64)}\n` },
    { mapping_revision: "unknown" },
    { mapping_revision: null },
  ])("refuses malformed target wire fields %#", async (fields) => {
    const wire = fixture();
    await expect(
      load({
        ...wire,
        regions: [
          {
            ...wire.regions[0],
            target: { ...wire.regions[0].target, ...fields },
          },
        ],
      }),
    ).rejects.toThrow(/reduction response/i);
    expect(submitQueuedDocumentCommand).not.toHaveBeenCalled();
  });

  it.each(["source_start", "source_end", "timeline_start"])(
    "refuses a target clip missing its required %s",
    async (field) => {
      const wire = fixture();
      const target = wire.regions[0].target;
      const clip: Record<string, unknown> = { ...target?.clip };
      delete clip[field];
      await expect(
        load({
          ...wire,
          regions: [{ ...wire.regions[0], target: { ...target, clip } }],
        }),
      ).rejects.toThrow(/reduction response/i);
      expect(submitQueuedDocumentCommand).not.toHaveBeenCalled();
    },
  );

  it.each([
    { source_start: null },
    { source_end: "18" },
    { timeline_start: NaN },
    { timeline_start: Infinity },
    { join_in_mode: "unknown" },
    { join_in_mode: null },
  ])("refuses malformed target clip fields %#", async (fields) => {
    const wire = fixture();
    const target = wire.regions[0].target;
    await expect(
      load({
        ...wire,
        regions: [
          {
            ...wire.regions[0],
            target: { ...target, clip: { ...target?.clip, ...fields } },
          },
        ],
      }),
    ).rejects.toThrow(/reduction response/i);
    expect(submitQueuedDocumentCommand).not.toHaveBeenCalled();
  });

  it.each([undefined, "fade", "crossfade", "cut"])(
    "preserves the backend's valid join mode %s without filling defaults",
    async (joinMode) => {
      const wire = fixture();
      const target = wire.regions[0].target;
      if (!target) throw new Error("Missing fixture target");
      const clip: Record<string, unknown> = { ...target.clip };
      if (joinMode === undefined) delete clip.join_in_mode;
      else clip.join_in_mode = joinMode;
      const original = { ...target, clip };
      const before = JSON.stringify(original);
      const inspection = await load({
        ...wire,
        regions: [{ ...wire.regions[0], target: original }],
      });
      const restore = inspection.regions[0].restore;
      expect(restore.state === "available" && restore.target).toBe(original);
      expect(JSON.stringify(original)).toBe(before);
    },
  );

  it("preserves a required-only backend target without imposing digest or default rules", async () => {
    const wire = fixture();
    const target: Record<string, unknown> = {
      ...wire.regions[0].target,
      media_seal: "",
      dependencies_digest: "",
      plan_digest: "",
      expected_head_id: " ",
      clip: {
        id: "clip/selected",
        track_id: "host",
        source_start: 12,
        source_end: 18,
        timeline_start: 30,
      },
    };
    delete target.mapping_revision;
    const before = JSON.stringify(target);
    const inspection = await load({
      ...wire,
      regions: [{ ...wire.regions[0], target }],
    });
    const restore = inspection.regions[0].restore;
    expect(restore.state === "available" && restore.target).toBe(target);
    expect(JSON.stringify(target)).toBe(before);
  });

  it("preserves host API failure details without submitting a command", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Inspect the clip again." }), {
        status: 409,
        headers: { "X-Sharecut-Error-Code": "bleed_restore_changed" },
      }),
    );
    await expect(
      loadClipBleedInspection(request, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "bleed_restore_changed",
      status: 409,
      message: "Inspect the clip again.",
    });
    expect(submitQueuedDocumentCommand).not.toHaveBeenCalled();
  });

  it("forwards cancellation and preserves the aborted read outcome", async () => {
    const controller = new AbortController();
    vi.mocked(fetch).mockImplementationOnce(async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      controller.signal.throwIfAborted();
      return new Response();
    });
    await expect(
      loadClipBleedInspection(request, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(submitQueuedDocumentCommand).not.toHaveBeenCalled();
  });
});

describe("restoreClipBleed", () => {
  it("forwards the untouched opaque target through the existing command journal", async () => {
    const wire = fixture();
    const before = structuredClone(wire.regions[0].target);
    const beforeJson = JSON.stringify(wire.regions[0].target);
    const inspection = await load(wire);
    const restore = inspection.regions[0].restore;
    if (restore.state !== "available")
      throw new Error("Missing fixture target");
    vi.mocked(fetch).mockClear();
    vi.mocked(submitQueuedDocumentCommand).mockResolvedValueOnce({
      history_head_id: "own-mutation-head",
    });
    expect(await restoreClipBleed(request.projectPath, restore.target)).toEqual(
      {
        status: "acknowledged",
        historyHead: "own-mutation-head",
      },
    );
    expect(submitQueuedDocumentCommand).toHaveBeenCalledExactlyOnceWith(
      request.projectPath,
      "RestoreClipBleed",
      { target: wire.regions[0].target },
      undefined,
    );
    expect(
      vi.mocked(submitQueuedDocumentCommand).mock.calls[0][2]?.target,
    ).toBe(wire.regions[0].target);
    expect(wire.regions[0].target).toEqual(before);
    expect(JSON.stringify(wire.regions[0].target)).toBe(beforeJson);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [{ queued: true }, "queued"],
    [{ queued: true, history_head_id: "untrusted-head" }, "queued"],
    [{ history_head_id: null }, "noop"],
    [{}, "unconfirmed"],
    [{ history_head_id: "" }, "unconfirmed"],
    [{ history_head_id: 123 }, "unconfirmed"],
    [
      {
        idempotent: true,
        command: {
          payload: { result: { history_head_id: "old-result-head" } },
        },
        snapshot: { history: { head_id: "peer-head" } },
      },
      "unconfirmed",
    ],
  ])("offers no Undo for reply %#", async (reply, status) => {
    const target = await loadedTarget();
    vi.mocked(submitQueuedDocumentCommand).mockResolvedValueOnce(reply);
    expect(await restoreClipBleed(request.projectPath, target)).toEqual({
      status,
    });
  });

  it("refuses a share key before entering the command journal", async () => {
    const target = await loadedTarget();
    vi.mocked(fetch).mockClear();
    await expect(restoreClipBleed("share:guest", target)).rejects.toThrow(
      /host/i,
    );
    expect(submitQueuedDocumentCommand).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves a rejected command as an error without retrying or fetching", async () => {
    const target = await loadedTarget();
    vi.mocked(fetch).mockClear();
    const failure = new ApiError("Inspect again", "bleed_restore_changed", 409);
    vi.mocked(submitQueuedDocumentCommand).mockRejectedValueOnce(failure);
    await expect(restoreClipBleed(request.projectPath, target)).rejects.toBe(
      failure,
    );
    expect(submitQueuedDocumentCommand).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});

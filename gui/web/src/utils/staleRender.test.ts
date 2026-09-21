import { describe, expect, it } from "vitest";
import { minimalProject } from "../test/fixtures";
import {
  reasonChipLabel,
  staleRenderBreakdown,
  wholeTrackReasonsForTrack,
} from "./staleRender";

describe("staleRenderBreakdown", () => {
  it("is fresh when nothing is out of date", () => {
    const b = staleRenderBreakdown(
      minimalProject({
        tracks: [
          {
            id: "host",
            label: "Host",
            role: "dialogue",
            speaker: null,
            gain_db: 0,
            muted: false,
            duration_sec: 60,
            fx_count: 0,
            stem_is_fresh: true,
          },
        ],
        render_status: {
          needs_rerender: false,
          reconciliation: { stale: false },
          premix: { exists: true, stale_vs_stems: false },
          invalidations: [],
        },
      }),
    );
    expect(b.stale).toBe(false);
    expect(b.summary).toBe("Fresh");
    expect(b.invalidations).toEqual([]);
  });

  it("exposes regional and whole-track invalidations", () => {
    const b = staleRenderBreakdown(
      minimalProject({
        tracks: [
          {
            id: "host",
            label: "Host",
            role: "dialogue",
            speaker: null,
            gain_db: 0,
            muted: false,
            duration_sec: 60,
            fx_count: 0,
            stem_is_fresh: false,
          },
          {
            id: "guest",
            label: "Guest",
            role: "dialogue",
            speaker: null,
            gain_db: 0,
            muted: false,
            duration_sec: 60,
            fx_count: 0,
            stem_is_fresh: false,
          },
        ],
        render_status: {
          needs_rerender: true,
          reconciliation: { stale: false },
          premix: { exists: true, stale_vs_stems: false },
          invalidations: [
            {
              id: "inv_1",
              track_ids: ["host"],
              timeline_start: 12,
              timeline_end: 14,
              reason: "cut",
              at: "2026-01-01T00:00:00Z",
            },
            {
              id: "inv_2",
              track_ids: ["guest"],
              timeline_start: null,
              timeline_end: null,
              reason: "fx",
              at: "2026-01-01T00:00:00Z",
            },
          ],
        },
      }),
    );
    expect(b.stale).toBe(true);
    expect(b.regionalOnlyTrackIds).toEqual(["host"]);
    expect(b.wholeTrackIds).toEqual(["guest"]);
    expect(wholeTrackReasonsForTrack(b, "guest")).toEqual(["fx"]);
    expect(wholeTrackReasonsForTrack(b, "host")).toEqual([]);
    expect(reasonChipLabel("fx")).toBe("FX");
    expect(b.summary).toContain("region");
  });

  it("does not mark stale from invalidations alone when freshness says fresh", () => {
    const b = staleRenderBreakdown(
      minimalProject({
        tracks: [
          {
            id: "host",
            label: "Host",
            role: "dialogue",
            speaker: null,
            gain_db: 0,
            muted: false,
            duration_sec: 60,
            fx_count: 0,
            stem_is_fresh: true,
          },
        ],
        render_status: {
          needs_rerender: false,
          reconciliation: { stale: false },
          premix: { exists: true, stale_vs_stems: false },
          invalidations: [
            {
              id: "inv_stale_journal",
              track_ids: ["host"],
              timeline_start: 1,
              timeline_end: 2,
              reason: "cut",
              at: "2026-01-01T00:00:00Z",
            },
          ],
        },
      }),
    );
    expect(b.stale).toBe(false);
    expect(b.invalidations).toHaveLength(1);
    expect(b.summary).toBe("Fresh");
  });

  it("reports a never-rendered project as fresh, not stale", () => {
    // What the server reports for a brand-new project: no premix, no stems,
    // needs_rerender true, reconciliation never run (stale). None of that
    // means the preview is out of date — no preview was ever made.
    const b = staleRenderBreakdown(
      minimalProject({
        tracks: [
          {
            id: "host",
            label: "Host",
            role: "dialogue",
            speaker: null,
            gain_db: 0,
            muted: false,
            duration_sec: 60,
            fx_count: 0,
            stem_is_fresh: false,
          },
        ],
        render_status: {
          needs_rerender: true,
          reconciliation: { stale: true },
          premix: { exists: false },
          invalidations: [],
          tracks: { host: { stem_is_fresh: false, stem_exists: false } },
        },
      }),
    );
    expect(b.stale).toBe(false);
    expect(b.summary).toBe("Fresh");
    expect(b.staleTrackIds).toEqual([]);
  });

  it("still reports stale when rendered stems are no longer fresh", () => {
    const b = staleRenderBreakdown(
      minimalProject({
        tracks: [
          {
            id: "host",
            label: "Host",
            role: "dialogue",
            speaker: null,
            gain_db: 0,
            muted: false,
            duration_sec: 60,
            fx_count: 0,
            stem_is_fresh: false,
          },
        ],
        render_status: {
          needs_rerender: true,
          reconciliation: { stale: false },
          premix: { exists: true, stale_vs_stems: false },
          invalidations: [],
          tracks: { host: { stem_is_fresh: false, stem_exists: true } },
        },
      }),
    );
    expect(b.stale).toBe(true);
    expect(b.staleTrackIds).toEqual(["host"]);
  });
});

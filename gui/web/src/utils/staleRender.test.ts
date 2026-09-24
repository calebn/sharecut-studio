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

  it("treats a never-rendered project as fresh (#78)", () => {
    const b = staleRenderBreakdown(
      minimalProject({
        tracks: [],
        render_status: {
          // render_status_report: no premix file yet
          needs_rerender: true,
          reconciliation: { stale: false },
          premix: { exists: false, stale_vs_stems: false },
          invalidations: [],
        },
      }),
    );
    expect(b.stale).toBe(false);
    expect(b.summary).toBe("Fresh");
    expect(b.premixMissing).toBe(false);
  });

  it("keeps an empty track fresh despite its creation invalidation", () => {
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
            duration_sec: 0,
            fx_count: 0,
            stem_is_fresh: false,
          },
        ],
        render_status: {
          needs_rerender: true,
          reconciliation: { stale: true },
          premix: { exists: false },
          invalidations: [
            {
              id: "inv-1",
              track_ids: ["host"],
              timeline_start: null,
              timeline_end: null,
              reason: "other",
              at: "2026-01-01T00:00:00Z",
            },
          ],
        },
      }),
    );
    expect(b.stale).toBe(false);
    expect(b.summary).toBe("Fresh");
  });

  it("still flags a project with source media but no premix", () => {
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
            media_path: "/tmp/host.wav",
          },
        ],
        render_status: {
          needs_rerender: true,
          reconciliation: { stale: false },
          premix: { exists: false, stale_vs_stems: false },
          invalidations: [],
        },
      }),
    );
    expect(b.stale).toBe(true);
    expect(b.premixMissing).toBe(true);
  });

  it("flags a guest project with redacted media paths and unknown duration", () => {
    const b = staleRenderBreakdown(
      minimalProject({
        project_path: "",
        tracks: [
          {
            id: "host",
            label: "Host",
            role: "dialogue",
            speaker: null,
            gain_db: 0,
            muted: false,
            duration_sec: null,
            fx_count: 0,
            stem_is_fresh: true,
            has_source_audio: true,
            media_path: null,
          },
        ],
        render_status: {
          needs_rerender: true,
          reconciliation: { stale: false },
          premix: { exists: false },
        },
      }),
    );
    expect(b.stale).toBe(true);
    expect(b.premixMissing).toBe(true);
  });

  it("does not call a project fresh when a source clip moved onto an empty track", () => {
    const b = staleRenderBreakdown(
      minimalProject({
        tracks: [
          {
            id: "destination",
            label: "Destination",
            role: "dialogue",
            speaker: null,
            gain_db: 0,
            muted: false,
            duration_sec: null,
            fx_count: 0,
            stem_is_fresh: false,
            has_source_audio: false,
            media_path: null,
          },
        ],
        clips: {
          clip_count: 1,
          tracks: {
            destination: [
              {
                id: "moved",
                track_id: "destination",
                source_start: 0,
                source_end: 1,
                timeline_start: 0,
                timeline_end: 1,
                fade_in_ms: 0,
                fade_out_ms: 0,
                join_in_mode: "fade",
                source_id: "original-source",
              },
            ],
          },
        },
        render_status: {
          needs_rerender: true,
          reconciliation: { stale: false },
          premix: { exists: false },
        },
      }),
    );
    expect(b.stale).toBe(true);
    expect(b.premixMissing).toBe(true);
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

  it("flags a premix mixed before a volume or mute change (#386)", () => {
    const b = staleRenderBreakdown(
      minimalProject({
        tracks: [
          {
            id: "host",
            label: "Host",
            role: "dialogue",
            speaker: null,
            gain_db: 0,
            fader_db: -3,
            muted: false,
            duration_sec: 60,
            fx_count: 0,
            stem_is_fresh: true,
          },
        ],
        render_status: {
          needs_rerender: true,
          reconciliation: { stale: false },
          premix: { exists: true, stale_vs_stems: false, stale_vs_mix: true },
          invalidations: [],
        },
      }),
    );
    expect(b.stale).toBe(true);
    expect(b.premixStaleVsMix).toBe(true);
    expect(b.staleTrackIds).toEqual([]);
    expect(b.summary).toBe("Volume or mute changed");
  });
});

import { describe, expect, it, vi } from "vitest";
import type { ModelGate } from "../../models";
import type { ExportRequest } from "../../stages/deliver/deliverLogic";
import type { PipelineJobSnapshot } from "../../types/pipeline";
import {
  CANCELLED_NOTHING,
  CANCELLING_DETAIL,
  CANCELLING_REASON,
  exportFormatOptions,
  exportOptionsOf,
  exportStateOf,
  exportWhen,
  STARTING_REASON,
} from "./deliverExport";
import type { ExportFlow, ExportRun } from "./exportFlowContext";
import { exportSettingsFromConfig } from "./exportSettings";

const SETTINGS = exportSettingsFromConfig({
  export: {
    wav: true,
    formats: [{ ext: "mp3", codec: "libmp3lame", bitrate_kbps: 192 }],
  },
  master: { integrated_lufs: -16, true_peak_db: -1.5 },
});

const REQUEST: ExportRequest = {
  settings: { formats: ["mp3"], loudness: "podcast", part: { mode: "whole" } },
  clips: [],
  chapters: [],
  range: null,
};

const GATE: ModelGate = {
  run: vi.fn(),
  prompt: null,
  declined: null,
  accept: vi.fn(),
  decline: vi.fn(),
  cancelDownload: vi.fn(),
  openModels: vi.fn(),
  reset: vi.fn(),
};

function flowOf(over: Partial<ExportFlow> = {}): ExportFlow {
  return {
    run: { kind: "idle" },
    job: null,
    settings: SETTINGS,
    settingsError: null,
    loading: false,
    selected: ["mp3"],
    setSelected: vi.fn(),
    gate: GATE,
    request: REQUEST,
    start: vi.fn(),
    cancel: vi.fn(),
    again: vi.fn(),
    reload: vi.fn(),
    ...over,
  };
}

const JOB: PipelineJobSnapshot = {
  id: "x1",
  project_path: "/p",
  from_step: null,
  only_step: null,
  kind: "export",
  status: "running",
  current: 1,
  total: 4,
  message: "Encoding MP3",
  error: null,
  elapsed_sec: 75,
  steps: [],
  last_progress_at: 1000,
};

const running = (over: Partial<Extract<ExportRun, { kind: "running" }>> = {}) =>
  ({
    kind: "running",
    jobId: "x1",
    cancelling: false,
    cancelError: null,
    ...over,
  }) as const;

describe("exportFormatOptions", () => {
  it("sizes a format from its bitrate, a lossless one like FLAC, and the rest like a default MP3", () => {
    expect(
      exportFormatOptions(SETTINGS).map((o) => [o.id, o.bytesPerSecond]),
    ).toEqual([
      ["mp3", 24_000],
      ["m4a", 16_000],
      ["flac", 97_000],
    ]);
    const plain = exportSettingsFromConfig({
      export: { formats: [{ ext: "ogg" }] },
    });
    expect(
      exportFormatOptions(plain).find((o) => o.id === "ogg")?.bytesPerSecond,
    ).toBe(16_000);
  });
});

describe("exportOptionsOf", () => {
  it("offers the project's formats and the loudness sentence, and hides what has no backend", () => {
    expect(exportOptionsOf(flowOf())).toEqual({
      formats: exportFormatOptions(SETTINGS),
      wavAlwaysWritten: true,
      selected: ["mp3"],
      loading: false,
      settingsError: undefined,
      loudnessNote: "Mastered to −16.0 LUFS, peaks under −1.5 dBTP.",
      loudness: false,
      range: false,
      folder: false,
      gate: GATE,
      onExportAgain: undefined,
    });
  });

  it("says loading, then the error, with no formats until the config arrives", () => {
    expect(
      exportOptionsOf(flowOf({ settings: null, loading: true })),
    ).toMatchObject({ formats: [], loading: true, wavAlwaysWritten: false });
    expect(
      exportOptionsOf(flowOf({ settings: null, settingsError: "offline" })),
    ).toMatchObject({ formats: [], loading: false, settingsError: "offline" });
  });

  it("has no sentence when the project sets no target", () => {
    const bare = exportSettingsFromConfig({});
    expect(
      exportOptionsOf(flowOf({ settings: bare })).loudnessNote,
    ).toBeUndefined();
  });

  it("offers Try again only after a failure or a cancel", () => {
    const again = vi.fn();
    const at = (run: ExportRun) =>
      exportOptionsOf(flowOf({ run, again })).onExportAgain;
    expect(at({ kind: "failed", reason: "x" })).toBe(again);
    expect(at({ kind: "cancelled", paths: [] })).toBe(again);
    expect(at({ kind: "idle" })).toBeUndefined();
    expect(at(running())).toBeUndefined();
  });
});

describe("exportStateOf", () => {
  it("is never before anything runs", () => {
    expect(exportStateOf(flowOf(), 0)).toEqual({ phase: "never" });
  });

  it("starts without a job: no bar, nothing to cancel yet", () => {
    expect(exportStateOf(flowOf({ run: running({ jobId: null }) }), 0)).toEqual(
      {
        phase: "running",
        progress: null,
        detail: "Starting export… · Elapsed 0:00",
        cancelReason: STARTING_REASON,
        cancelError: undefined,
      },
    );
  });

  it("reports the job's step, bar, elapsed time and a stall", () => {
    expect(exportStateOf(flowOf({ run: running(), job: JOB }), 1000)).toEqual({
      phase: "running",
      progress: 0.25,
      detail: "Encoding MP3 · 1/4 steps · Elapsed 1:15",
      cancelReason: undefined,
      cancelError: undefined,
    });
    expect(
      exportStateOf(flowOf({ run: running(), job: JOB }), 1100),
    ).toMatchObject({
      detail: "Encoding MP3 · 1/4 steps · Elapsed 1:15 · last update 100s ago",
    });
  });

  it("says it is cancelling, and why Cancel is off", () => {
    expect(
      exportStateOf(
        flowOf({ run: running({ cancelling: true }), job: JOB }),
        1000,
      ),
    ).toMatchObject({
      detail: `${CANCELLING_DETAIL} · 1/4 steps · Elapsed 1:15`,
      cancelReason: CANCELLING_REASON,
    });
  });

  it("passes on a failed cancel", () => {
    expect(
      exportStateOf(
        flowOf({ run: running({ cancelError: "gone" }), job: JOB }),
        1000,
      ),
    ).toMatchObject({ cancelError: "gone", cancelReason: undefined });
  });

  it("asks for the model while the gate has a prompt, whatever the run is", () => {
    const gate = {
      ...GATE,
      prompt: { label: "Speaker model", size: "25 MB" },
    } as unknown as ModelGate;
    expect(
      exportStateOf(flowOf({ run: running({ jobId: null }), gate }), 0),
    ).toEqual({
      phase: "needs-model",
      model: "Speaker model",
      size: "25 MB",
    });
  });

  it("lists what a finished export wrote, with the request it covers", () => {
    const finishedAt = Date.parse("2026-01-02T15:04:00Z");
    expect(
      exportStateOf(
        flowOf({
          run: {
            kind: "done",
            paths: ["/p/export/ep.wav", "C:\\p\\export\\ep.MP3"],
            measured: "Measured −16.1 LUFS, true peak −1.6 dBTP.",
            lufs: -16.1,
            truePeak: -1.6,
            finishedAt,
          },
        }),
        0,
      ),
    ).toEqual({
      phase: "done",
      files: [
        { name: "ep.wav", format: "wav" },
        { name: "ep.MP3", format: "mp3" },
      ],
      when: exportWhen(finishedAt),
      exported: REQUEST,
      summary: "Exported 2 files to export/",
      measured: "Measured −16.1 LUFS, true peak −1.6 dBTP.",
    });
  });

  it("names a failure", () => {
    expect(
      exportStateOf(flowOf({ run: { kind: "failed", reason: "no disk" } }), 0),
    ).toEqual({ phase: "failed", cause: "no disk" });
  });

  it("says a cancel wrote nothing, or came too late and lists the files", () => {
    expect(
      exportStateOf(flowOf({ run: { kind: "cancelled", paths: [] } }), 0),
    ).toEqual({ phase: "cancelled", files: [], detail: CANCELLED_NOTHING });
    expect(
      exportStateOf(
        flowOf({ run: { kind: "cancelled", paths: ["/p/export/ep.mp3"] } }),
        0,
      ),
    ).toEqual({
      phase: "cancelled",
      files: [{ name: "ep.mp3", format: "mp3" }],
      detail: "Cancel came too late. Exported 1 file to export/",
    });
  });
});

describe("exportWhen", () => {
  it("is the clock time of the finish", () => {
    expect(exportWhen(Date.parse("2026-01-02T15:04:00Z"), "UTC")).toBe(
      "at 3:04 PM",
    );
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CDPSession, Page, TestInfo } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditorProfiler, readWaveforms } from "./editorProfile";
import {
  compatibilityReasons,
  counterDeltas,
  fixtureIdentity,
  measured,
  statistics,
  unavailable,
} from "./editorProfileReport";

const project = {
  meta: {
    name: "benchmark",
    created_at: "generated",
    workspace_dir: "/tmp/one",
  },
  timeline: {
    duration_sec: 120,
    tracks: ["host", "guest"],
    clips: [{ id: "one" }],
  },
  transcripts: {
    combined: { utterances: ["one"] },
    per_track: [{ words: ["one"] }],
  },
  history: {
    entries: [
      { created_at: "generated", snapshot_file: "/tmp/one/history/base.json" },
    ],
  },
};
let directory: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("editor profile evidence", () => {
  it("uses literal median, nearest-rank p95, and explicit empty statistics", () => {
    expect(statistics([1, 10, 2, 4])).toEqual({
      count: 4,
      medianMs: 3,
      p95Ms: 10,
      maximumMs: 10,
    });
    expect(statistics([])).toEqual({
      count: 0,
      medianMs: null,
      p95Ms: null,
      maximumMs: null,
    });
  });
  it("converts supported duration counters to milliseconds without inventing missing zeroes", () => {
    const deltas = counterDeltas(
      measured(
        { TaskDuration: 0, LayoutDuration: 2, RecalcStyleDuration: 0 },
        "raw",
      ),
      measured(
        { TaskDuration: 0.005, LayoutDuration: 1, RecalcStyleDuration: 0 },
        "raw",
      ),
    );
    expect(deltas.TaskDuration).toMatchObject({ status: "measured", value: 5 });
    expect(deltas.RecalcStyleDuration).toMatchObject({
      status: "measured",
      value: 0,
    });
    expect(deltas.ScriptDuration).toMatchObject({ status: "unavailable" });
    expect(deltas.LayoutDuration).toMatchObject({ status: "unavailable" });
    expect(
      counterDeltas(unavailable("no CDP"), measured({}, "raw")).TaskDuration,
    ).toEqual({ status: "unavailable", reason: "no CDP" });
  });
  it("ignores only named generated dates and workspace paths when fingerprinting relocated fixtures", () => {
    const first = fixtureIdentity(
      JSON.stringify(project),
      "/tmp/one/project.json",
    );
    const relocated = structuredClone(project);
    relocated.meta.created_at = "later";
    relocated.meta.workspace_dir = "/tmp/two";
    relocated.history.entries[0]!.created_at = "later";
    relocated.history.entries[0]!.snapshot_file = "/tmp/two/history/base.json";
    const second = fixtureIdentity(
      JSON.stringify(relocated),
      "/tmp/two/project.json",
    );
    expect(second.canonicalSha256).toBe(first.canonicalSha256);
    expect(second.rawSha256).not.toBe(first.rawSha256);
    relocated.timeline.clips[0]!.id = "different";
    expect(
      fixtureIdentity(JSON.stringify(relocated), "/tmp/two/project.json")
        .canonicalSha256,
    ).not.toBe(first.canonicalSha256);
    expect(first.counts).toEqual({
      durationSec: 120,
      tracks: 2,
      clips: 1,
      utterances: 1,
      words: 1,
      historyEntries: 1,
    });
  });
  it("compares waveform content by ref across generated filenames and detects changed data", () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "editor-waveform-test-"));
    const peaks = path.join(directory, "artifacts", "peaks");
    fs.mkdirSync(peaks, { recursive: true });
    const first = path.join(peaks, "track-host.abc.wfpk");
    fs.writeFileSync(first, "synthetic peaks");
    const a = readWaveforms(path.join(directory, "project.json"));
    fs.renameSync(first, path.join(peaks, "track-host.def.wfpk"));
    expect(readWaveforms(path.join(directory, "project.json"))).toEqual(a);
    fs.writeFileSync(path.join(peaks, "track-host.def.wfpk"), "silent peaks");
    const b = readWaveforms(path.join(directory, "project.json"));
    expect(
      fixtureIdentity(JSON.stringify(project), "/tmp/one/project.json", a)
        .canonicalSha256,
    ).not.toBe(
      fixtureIdentity(JSON.stringify(project), "/tmp/one/project.json", b)
        .canonicalSha256,
    );
  });
  it("retains partial frames and a failed action before rethrowing, then refuses incompatible results", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "editor-profile-test-"));
    vi.stubEnv("DAW_PROFILE_OUT", directory);
    const projectPath = path.join(directory, "project.json");
    fs.writeFileSync(projectPath, JSON.stringify(project));
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        intervalsMs: [16, 48],
        capped: false,
        longTaskDurationsMs: [55],
        longTasksSupported: true,
      })
      .mockResolvedValueOnce({
        theme: "light",
        reducedMotion: true,
        deviceScale: 1,
        hardwareConcurrency: 4,
      });
    const page = {
      on: vi.fn(),
      context: () => ({ browser: () => ({ version: () => "browser-1" }) }),
      viewportSize: () => ({ width: 1440, height: 900 }),
      addInitScript: vi.fn(),
      evaluate,
    } as unknown as Page;
    const send = vi
      .fn()
      .mockResolvedValue({ metrics: [{ name: "TaskDuration", value: 1 }] });
    const cdp = { send } as unknown as CDPSession;
    const attach = vi.fn();
    const info = {
      outputPath: (name: string) => path.join(directory!, name),
      project: { use: { trace: "off" }, retries: 0 },
      repeatEachIndex: 0,
      attach,
    } as unknown as TestInfo;
    const recorder = await createEditorProfiler(
      page,
      cdp,
      info,
      projectPath,
      3,
      true,
    );
    const error = new Error("real workload failed");
    await expect(
      recorder.measure(
        {
          id: "failure-validation",
          phase: "warm",
          input: "test-only collector validation",
        },
        async () => {
          throw error;
        },
      ),
    ).rejects.toBe(error);
    const retained = JSON.parse(
      fs.readFileSync(path.join(directory, "report.json"), "utf8"),
    );
    expect(retained.status).toBe("incomplete");
    expect(retained.samples[0].result).toEqual({
      status: "failed",
      reason: "Error: real workload failed",
    });
    expect(retained.samples[0].frames.value.intervalsMs).toEqual([16, 48]);
    expect(retained.samples[0].longTasks.value).toEqual({
      count: 1,
      totalMs: 55,
      maximumMs: 55,
    });
    expect(send).not.toHaveBeenCalledWith("HeapProfiler.collectGarbage");
    await recorder.finish(error);
    expect(attach).toHaveBeenCalledWith(
      "editor-profile-report",
      expect.objectContaining({ path: path.join(directory, "report.json") }),
    );
    const a = structuredClone(recorder.report);
    a.fixture.waveforms = measured(
      [{ ref: "track-host", sha256: "known" }],
      "actual content",
    );
    a.status = "complete";
    a.samples[0]!.result = {
      status: "completed",
      observation: { kind: "existing", contract: "validation only" },
    };
    a.environment.build = measured(
      {
        mode: "production",
        assets: [{ path: "/assets/app.js", sha256: "old" }],
        e2eHooks: false,
      },
      "actual served assets",
    );
    const b = structuredClone(a);
    b.protocol.repeatIndex = 2;
    b.environment.revision = "next";
    b.environment.build = measured(
      {
        mode: "production",
        assets: [{ path: "/assets/app.js", sha256: "new" }],
        e2eHooks: false,
      },
      "actual served assets",
    );
    expect(compatibilityReasons(a, b)).toEqual([]);
    b.environment.headless = "unknown";
    expect(compatibilityReasons(a, b)).toContain(
      "unknown browser/headless/theme provenance",
    );
    b.environment.headless = true;
    b.protocol.scrubRounds = 4;
    expect(compatibilityReasons(a, b)).toContain("protocol differs");
    b.status = "incomplete";
    expect(compatibilityReasons(a, b)).toContain("incomplete report");
  });
});

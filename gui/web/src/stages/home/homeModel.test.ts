import { describe, expect, it } from "vitest";
import type { BootstrapJobSnapshot, RecentProject } from "../../api";
import type { ModelView } from "../../models";
import { downloadRows, overlay } from "../../models/controller";
import { modelStatus, registryRows } from "../../test/renderWithModels";
import { dayMonth } from "../../utils/relativeTime";
import {
  bundleToGet,
  cardOf,
  downloadTotals,
  episodeNameFromFiles,
  formatDuration,
  formatEdited,
  holdTotals,
  importingLine,
  importStoppedLine,
  setupOf,
  timeLeftText,
  toolsMissing,
  toolsUnsupportedSentence,
  untitledEpisodeName,
} from "./homeModel";

const NOW = new Date(2026, 9, 27, 15, 30);

function recent(overrides: Partial<RecentProject> = {}): RecentProject {
  return {
    path: "/ep/episode.sharecut",
    name: "Rosa and Maya",
    opened_at: "2026-10-27T10:00:00+00:00",
    edited_at: new Date(2026, 9, 27, 13, 30).toISOString(),
    duration_sec: 3130,
    stage: "review",
    chip: { text: "Review 6", state: "needs-you" },
    peaks: [],
    folder_missing: false,
    ...overrides,
  };
}

function model(overrides: Partial<ModelView> = {}): ModelView {
  return {
    id: "whisper",
    label: "Whisper",
    purpose: "transcription",
    tier: "required",
    size: "~1.6 GB",
    sizeBytes: 1_600_000_000,
    variant: null,
    state: { kind: "missing" },
    ...overrides,
  };
}

describe("formatDuration", () => {
  it("writes minutes and seconds, and hours from an hour up", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(3130)).toBe("52:10");
    expect(formatDuration(3870)).toBe("1:04:30");
  });
});

describe("formatEdited", () => {
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  it("counts up from just now", () => {
    expect(formatEdited(ago(20_000), NOW)).toBe("edited just now");
    expect(formatEdited(ago(5 * 60_000), NOW)).toBe("edited 5 min ago");
    expect(formatEdited(ago(2 * 3_600_000), NOW)).toBe("edited 2 h ago");
  });
  it("names calendar days, not 24-hour spans", () => {
    expect(formatEdited(new Date(2026, 9, 26, 23, 50).toISOString(), NOW)).toBe(
      "edited yesterday",
    );
    expect(formatEdited(new Date(2026, 9, 24, 9, 0).toISOString(), NOW)).toBe(
      "edited 3 days ago",
    );
    expect(formatEdited(new Date(2026, 9, 18, 9, 0).toISOString(), NOW)).toBe(
      "edited last week",
    );
    expect(formatEdited(new Date(2026, 8, 1, 9, 0).toISOString(), NOW)).toBe(
      "edited 1 Sep",
    );
  });
  it("is empty for a missing or unreadable time", () => {
    expect(formatEdited(null, NOW)).toBe("");
    expect(formatEdited("nonsense", NOW)).toBe("");
  });
});

describe("cardOf", () => {
  it("builds the card from a recent entry", () => {
    expect(cardOf(recent(), NOW)).toEqual({
      id: "/ep/episode.sharecut",
      name: "Rosa and Maya",
      meta: "52:10 · edited 2 h ago",
      stage: "review",
      chip: { text: "Review 6", state: "needs-you" },
      peaks: [],
      folderMissing: undefined,
    });
  });
  it("drops what it does not know and flags a moved folder", () => {
    const card = cardOf(
      recent({ duration_sec: null, edited_at: null, folder_missing: true }),
      NOW,
    );
    expect(card.meta).toBe("");
    expect(card.folderMissing).toBe(true);
  });
  it("turns an unknown chip state into Not yet", () => {
    const card = cardOf(recent({ chip: { text: "x", state: "weird" } }), NOW);
    expect(card.chip.state).toBe("not-yet");
  });
});

describe("new episode names", () => {
  it("names one file after itself and several by the day", () => {
    expect(episodeNameFromFiles([{ name: "Rosa.take2.wav" }], NOW)).toBe(
      "Rosa.take2",
    );
    expect(
      episodeNameFromFiles([{ name: "a.wav" }, { name: "b.wav" }], NOW),
    ).toBe("Episode, 27 Oct");
    expect(episodeNameFromFiles([{ name: ".wav" }], NOW)).toBe(
      "Episode, 27 Oct",
    );
  });
  it("falls back to the day when the file's name is one Windows reserves", () => {
    for (const name of [
      "con.wav",
      "NUL.mp3",
      "aux.m4a",
      "Com1.take2.wav",
      " lpt9 .wav",
    ]) {
      expect(episodeNameFromFiles([{ name }], NOW)).toBe("Episode, 27 Oct");
    }
    expect(episodeNameFromFiles([{ name: "console.wav" }], NOW)).toBe(
      "console",
    );
  });
  it("dates an untitled recording", () => {
    expect(untitledEpisodeName(NOW)).toBe("Untitled episode · 27 Oct");
    expect(dayMonth(new Date(2026, 0, 5))).toBe("5 Jan");
    expect(importingLine(1)).toBe("Importing 1 file…");
    expect(importingLine(3)).toBe("Importing 3 files…");
  });
});

function setupApi(api: Omit<Parameters<typeof setupOf>[0], "downloads">) {
  return { ...api, downloads: api.models ?? [] };
}

describe("setupOf", () => {
  const base = {
    ready: false,
    loadError: null,
    tools: { ffmpeg: "installed" as const, hint: null },
  };
  it("is checking while the first status is on its way", () => {
    expect(setupOf(setupApi({ ...base, models: null }))).toEqual({
      state: "checking",
      sizeLabel: "",
    });
  });
  it("offers a check again when the status never came", () => {
    expect(
      setupOf(setupApi({ ...base, models: null, loadError: "x" }))?.state,
    ).toBe("check-error");
  });
  it("shows nothing once the required models are in", () => {
    expect(
      setupOf(
        setupApi({
          ...base,
          ready: true,
          models: [model({ state: { kind: "installed" } })],
        }),
      ),
    ).toBeNull();
  });
  it("asks for the bundle and sizes it in words", () => {
    const data = setupOf(
      setupApi({
        ...base,
        models: [
          model(),
          model({ id: "aligner", tier: "recommended", sizeBytes: 360_000_000 }),
          model({ id: "ecapa", tier: "recommended", sizeBytes: 80_000_000 }),
        ],
      }),
    );
    expect(data).toEqual({ state: "needed", sizeLabel: "about 2 GB" });
  });
  it("does not guess a size it does not have", () => {
    const data = setupOf(
      setupApi({
        ...base,
        models: [model({ sizeBytes: null })],
      }),
    );
    expect(data?.sizeLabel).toBe("a few gigabytes");
  });
  it("reports a running download with its bytes", () => {
    const data = setupOf(
      setupApi({
        ...base,
        models: [
          model({
            state: {
              kind: "downloading",
              bytes: 800_000_000,
              total: 1_600_000_000,
            },
          }),
        ],
      }),
    );
    expect(data).toMatchObject({
      state: "downloading",
      progress: 0.5,
      detail: "800 MB of 1.6 GB",
    });
  });
  it("adds the time left to a download that has a rate", () => {
    const models = [
      model({
        state: {
          kind: "downloading",
          bytes: 1_100_000_000,
          total: 2_000_000_000,
        },
      }),
    ];
    expect(setupOf(setupApi({ ...base, models }), 180)?.detail).toBe(
      "1.1 GB of 2.0 GB · about 3 min",
    );
    expect(setupOf(setupApi({ ...base, models }), null)?.detail).toBe(
      "1.1 GB of 2.0 GB",
    );
  });
  it("leaves progress open when a total is unknown", () => {
    const data = setupOf(
      setupApi({
        ...base,
        models: [
          model({
            state: { kind: "downloading", bytes: 5_000_000, total: null },
          }),
        ],
      }),
    );
    expect(data?.progress).toBeUndefined();
    expect(data?.detail).toBe("5 MB downloaded");
  });
  it("names missing audio tools with nothing to download", () => {
    const models = [model({ state: { kind: "installed" } })];
    const tools = { ffmpeg: "missing" as const, hint: "Cannot run ffprobe" };
    expect(setupOf(setupApi({ ...base, tools, models }))).toEqual({
      state: "tools-missing",
      sizeLabel: "",
    });
    expect(toolsMissing({ tools, models })).toBe(true);
    expect(toolsMissing({ tools, models: null })).toBe(false);
    expect(toolsMissing({ tools: base.tools, models })).toBe(false);
  });
  it("names unsupported audio tools with the server's sentence and nothing to download", () => {
    const models = [model({ state: { kind: "unsupported", hint: "x" } })];
    const tools = {
      ffmpeg: "unsupported" as const,
      hint: "ShareCut can't process audio on this device yet.",
    };
    expect(setupOf(setupApi({ ...base, tools, models }))).toEqual({
      state: "tools-unsupported",
      sizeLabel: "",
      detail: "ShareCut can't process audio on this device yet.",
    });
    expect(toolsMissing({ tools, models })).toBe(false);
    expect(toolsUnsupportedSentence({ tools, models })).toBe(
      "ShareCut can't process audio on this device yet.",
    );
    expect(toolsUnsupportedSentence({ tools, models: null })).toBeNull();
    expect(
      setupOf(
        setupApi({
          ...base,
          tools: { ffmpeg: "unsupported", hint: null },
          models,
        }),
      )?.detail,
    ).toBe("Audio tools aren't available on this device yet.");
  });
  it("puts a running download ahead of missing audio tools", () => {
    const tools = { ffmpeg: "missing" as const, hint: null };
    const models = [model({ state: { kind: "queued" } })];
    expect(setupOf(setupApi({ ...base, tools, models }))?.state).toBe(
      "downloading",
    );
  });
  it("reports a failed model", () => {
    const data = setupOf(
      setupApi({
        ...base,
        models: [
          model({
            state: { kind: "failed", failure: { kind: "network", plain: "x" } },
          }),
        ],
      }),
    );
    expect(data?.state).toBe("failed");
  });
});

describe("downloadTotals across the bundle", () => {
  const sizes = [1_600_000_000, 40_000_000, 378_000_000, 83_000_000];
  const bundle = (current: number, bytes: number, total: number | null) =>
    sizes.map((sizeBytes, i) =>
      model({
        id: `c${i}`,
        sizeBytes,
        state:
          i === current
            ? { kind: "downloading", bytes, total }
            : { kind: "queued" },
      }),
    );
  const sum = sizes.reduce((a, b) => a + b, 0);

  it("replays four components without the bytes or progress ever falling back", () => {
    const events: [number, number, number][] = [
      [0, 0, sizes[0]!],
      [0, 800_000_000, sizes[0]!],
      [0, sizes[0]!, sizes[0]!],
      [1, 0, sizes[1]!],
      [1, 2_048, sizes[1]!],
      [1, sizes[1]!, sizes[1]!],
      [2, 0, sizes[2]!],
      [2, 12_000_000, sizes[2]!],
      [2, sizes[2]!, sizes[2]!],
      [3, 0, sizes[3]!],
      [3, sizes[3]!, sizes[3]!],
    ];
    let previous = -1;
    for (const [current, bytes, total] of events) {
      const totals = downloadTotals(bundle(current, bytes, total))!;
      expect(totals.total).not.toBeNull();
      expect(totals.bytes).toBeGreaterThanOrEqual(previous);
      previous = totals.bytes;
      const data = setupOf(
        setupApi({
          ready: false,
          loadError: null,
          tools: { ffmpeg: "installed", hint: null },
          models: bundle(current, bytes, total),
        }),
        null,
      );
      expect(data?.progress).toBeGreaterThanOrEqual(0);
      expect(data?.progress).toBeLessThanOrEqual(1);
    }
    expect(previous).toBe(sum);
  });

  it("counts the finished components in the numerator at a boundary", () => {
    expect(downloadTotals(bundle(1, 0, sizes[1]!))).toEqual({
      bytes: sizes[0],
      total: sizes[0]! + sizes[1]! + sizes[2]! + sizes[3]!,
    });
    expect(downloadTotals(bundle(3, 0, sizes[3]!))?.bytes).toBe(
      sizes[0]! + sizes[1]! + sizes[2]!,
    );
  });

  it("leaves the total open while a queued size is unknown", () => {
    const models = bundle(0, 5, sizes[0]!);
    models[2] = { ...models[2]!, sizeBytes: null };
    expect(downloadTotals(models)?.total).toBeNull();
  });
});

describe("holdTotals across the in-between frames", () => {
  const sizes = [1_600_000_000, 40_000_000, 378_000_000, 83_000_000];
  const sum = sizes.reduce((a, b) => a + b, 0);
  const frame = (current: number | null, bytes = 0) =>
    sizes.map((sizeBytes, i) =>
      model({
        id: `c${i}`,
        sizeBytes,
        state:
          i === current
            ? { kind: "downloading", bytes, total: sizeBytes }
            : { kind: "queued" },
      }),
    );

  it("never reads less than it did, through gaps and the last frame", () => {
    const frames = [
      frame(0, 0),
      frame(0, sizes[0]),
      frame(null),
      frame(1, 0),
      frame(1, sizes[1]),
      frame(null),
      frame(2, 100),
      frame(2, sizes[2]),
      frame(null),
      frame(3, sizes[3]),
      frame(null),
      frame(null),
    ];
    let held: ReturnType<typeof holdTotals> = null;
    let previous = 0;
    for (const models of frames) {
      held = holdTotals(held, downloadTotals(models));
      expect(held!.bytes).toBeGreaterThanOrEqual(previous);
      expect(held!.total).toBe(sum);
      previous = held!.bytes;
    }
    expect(held).toEqual({ bytes: sum, total: sum });
  });

  it("starts over once the download is over", () => {
    const held = holdTotals(null, downloadTotals(frame(3, sizes[3])));
    expect(holdTotals(held, null)).toBeNull();
    expect(holdTotals(null, downloadTotals(frame(0, 5)))?.bytes).toBe(5);
  });

  it("keeps the total open while a size is unknown", () => {
    const open = { bytes: 5, total: null };
    expect(holdTotals({ bytes: 3, total: 10 }, open)).toEqual(open);
  });
});

describe("timeLeftText", () => {
  it("words the time left", () => {
    expect(timeLeftText(20)).toBe("less than a minute");
    expect(timeLeftText(170)).toBe("about 3 min");
    expect(timeLeftText(3600)).toBe("about 1 h");
    expect(timeLeftText(3900)).toBe("about 1 h 5 min");
  });
});

describe("bundleToGet", () => {
  it("lists every model still to fetch, the word aligner and speaker model included", () => {
    expect(
      bundleToGet([
        model(),
        model({ id: "done", state: { kind: "installed" } }),
        model({ id: "word-aligner", tier: "recommended" }),
        model({ id: "speaker-ecapa", tier: "recommended" }),
        model({
          id: "fix",
          tier: "recommended",
          state: { kind: "update_needed" },
        }),
      ]),
    ).toEqual(["whisper", "word-aligner", "speaker-ecapa", "fix"]);
    expect(bundleToGet(null)).toEqual([]);
  });
});

describe("importStoppedLine", () => {
  it("names the folder of a Windows path and keeps a reason's own full stop", () => {
    expect(
      importStoppedLine({
        reason: "Upload failed",
        added: 1,
        total: 2,
        name: "Rosa",
        projectPath: "C:\\ShareCut\\Rosa\\episode.sharecut",
      }),
    ).toBe(
      'Upload failed. 1 of 2 files were added to "Rosa". Open it from Recent to add the rest. Its folder is C:\\ShareCut\\Rosa.',
    );
  });
});

describe("live bootstrap component order", () => {
  it("keeps earlier completed components and never counts a later queued component as completed", () => {
    const selectedStatus = modelStatus(registryRows());
    const fastStatus = modelStatus(
      registryRows().map((row) =>
        row.id === "whisper"
          ? { ...row, model: "tiny.en", size: "75 MB", size_bytes: 75_000_000 }
          : row,
      ),
      { whisper_model: "tiny.en" },
    );
    const job: BootstrapJobSnapshot = {
      id: "bundle",
      kind: "bootstrap",
      failed_components: [],
      status: "running",
      whisper_model: "tiny.en",
      components: ["whisper", "word-aligner"],
      download: { component: "whisper", bytes: 25_000_000, total: 75_000_000 },
    };
    const project = (active: BootstrapJobSnapshot) =>
      downloadRows(fastStatus, active, {}, overlay(selectedStatus, active, {}));
    expect(project(job).map((row) => row.id)).toEqual([
      "whisper",
      "word-aligner",
    ]);
    expect(downloadTotals(project(job))).toEqual({
      bytes: 25_000_000,
      total: 435_000_000,
    });
    const boundary = {
      ...job,
      download: {
        component: "word-aligner",
        bytes: 10_000_000,
        total: 360_000_000,
      },
    };
    expect(project(boundary).map((row) => row.id)).toEqual([
      "whisper",
      "word-aligner",
    ]);
    expect(downloadTotals(project(boundary))).toEqual({
      bytes: 85_000_000,
      total: 435_000_000,
    });
    expect(
      downloadTotals(
        project({
          ...boundary,
          download: { ...boundary.download, total: null },
        }),
      ),
    ).toEqual({ bytes: 85_000_000, total: null });

    const failed = { ...boundary, failed_components: ["whisper"] };
    const partialFast = downloadTotals(project(job));
    const remaining = downloadTotals(project(failed));
    expect(remaining).toMatchObject({ bytes: 10_000_000, total: 360_000_000 });
    expect(holdTotals(partialFast, remaining)).toMatchObject({
      bytes: 10_000_000,
      total: 360_000_000,
    });
    const unknown = downloadTotals(
      project({ ...failed, download: { ...failed.download, total: null } }),
    );
    expect(holdTotals(partialFast, unknown)).toMatchObject({
      bytes: 10_000_000,
      total: null,
    });
    expect(
      holdTotals(
        remaining,
        downloadTotals(project({ ...failed, download: null })),
      ),
    ).toMatchObject({ bytes: 10_000_000, total: 360_000_000 });
  });
});

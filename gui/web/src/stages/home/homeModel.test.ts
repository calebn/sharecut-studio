import { describe, expect, it } from "vitest";
import type { RecentProject } from "../../api";
import type { ModelView } from "../../models";
import {
  bundleToGet,
  cardOf,
  dayMonth,
  episodeNameFromFiles,
  formatDuration,
  formatEdited,
  importingLine,
  importStoppedLine,
  setupOf,
  toolsMissing,
  untitledEpisodeName,
} from "./homeModel";

const NOW = new Date(2026, 9, 27, 15, 30);

function recent(overrides: Partial<RecentProject> = {}): RecentProject {
  return {
    path: "/ep/episode.project.json",
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
      id: "/ep/episode.project.json",
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
    for (const name of ["con.wav", "NUL.mp3", "aux.m4a", "Com1.take2.wav", " lpt9 .wav"]) {
      expect(episodeNameFromFiles([{ name }], NOW)).toBe("Episode, 27 Oct");
    }
    expect(episodeNameFromFiles([{ name: "console.wav" }], NOW)).toBe("console");
  });
  it("dates an untitled recording", () => {
    expect(untitledEpisodeName(NOW)).toBe("Untitled episode · 27 Oct");
    expect(dayMonth(new Date(2026, 0, 5))).toBe("5 Jan");
    expect(importingLine(1)).toBe("Importing 1 file…");
    expect(importingLine(3)).toBe("Importing 3 files…");
  });
});

describe("setupOf", () => {
  const base = {
    ready: false,
    loadError: null,
    tools: { ffmpeg: "installed" as const, hint: null },
  };
  it("shows nothing while the first status is on its way", () => {
    expect(setupOf({ ...base, models: null })).toBeNull();
  });
  it("offers a check again when the status never came", () => {
    expect(setupOf({ ...base, models: null, loadError: "x" })?.state).toBe(
      "check-error",
    );
  });
  it("shows nothing once the required models are in", () => {
    expect(
      setupOf({
        ...base,
        ready: true,
        models: [model({ state: { kind: "installed" } })],
      }),
    ).toBeNull();
  });
  it("asks for the bundle and sizes it in words", () => {
    const data = setupOf({
      ...base,
      models: [
        model(),
        model({ id: "ecapa", tier: "recommended", sizeBytes: 400_000_000 }),
        model({ id: "extra", tier: "offered", sizeBytes: 9_000_000_000 }),
      ],
    });
    expect(data).toEqual({ state: "needed", sizeLabel: "about 2 GB" });
  });
  it("does not guess a size it does not have", () => {
    const data = setupOf({
      ...base,
      models: [model({ sizeBytes: null })],
    });
    expect(data?.sizeLabel).toBe("a few gigabytes");
  });
  it("reports a running download with its bytes", () => {
    const data = setupOf({
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
    });
    expect(data).toMatchObject({
      state: "downloading",
      progress: 0.5,
      detail: "800 MB of 1.6 GB",
    });
  });
  it("leaves progress open when a total is unknown", () => {
    const data = setupOf({
      ...base,
      models: [
        model({
          state: { kind: "downloading", bytes: 5_000_000, total: null },
        }),
      ],
    });
    expect(data?.progress).toBeUndefined();
    expect(data?.detail).toBe("5 MB downloaded");
  });
  it("names missing audio tools with nothing to download", () => {
    const models = [
      model({ state: { kind: "installed" } }),
      model({ id: "opt", tier: "offered" }),
    ];
    const tools = { ffmpeg: "missing" as const, hint: "Cannot run ffprobe" };
    expect(setupOf({ ...base, tools, models })).toEqual({
      state: "tools-missing",
      sizeLabel: "",
    });
    expect(toolsMissing({ tools, models })).toBe(true);
    expect(toolsMissing({ tools, models: null })).toBe(false);
    expect(toolsMissing({ tools: base.tools, models })).toBe(false);
  });
  it("puts a running download ahead of missing audio tools", () => {
    const tools = { ffmpeg: "missing" as const, hint: null };
    const models = [model({ state: { kind: "queued" } })];
    expect(setupOf({ ...base, tools, models })?.state).toBe("downloading");
  });
  it("reports a failed model", () => {
    const data = setupOf({
      ...base,
      models: [
        model({
          state: { kind: "failed", failure: { kind: "network", plain: "x" } },
        }),
      ],
    });
    expect(data?.state).toBe("failed");
  });
});

describe("bundleToGet", () => {
  it("lists the required and recommended models still to fetch", () => {
    expect(
      bundleToGet([
        model(),
        model({ id: "done", state: { kind: "installed" } }),
        model({ id: "opt", tier: "offered" }),
        model({
          id: "fix",
          tier: "recommended",
          state: { kind: "update_needed" },
        }),
      ]),
    ).toEqual(["whisper", "fix"]);
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
        projectPath: "C:\\ShareCut\\Rosa\\episode.project.json",
      }),
    ).toBe(
      'Upload failed. 1 of 2 files were added to "Rosa". Open it from Recent to add the rest. Its folder is C:\\ShareCut\\Rosa.',
    );
  });
});

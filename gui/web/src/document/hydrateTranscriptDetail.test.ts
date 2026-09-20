import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { noteDocumentSeq, resetDocumentSeqForTests } from "./cursor";
import {
  needsTranscriptDetailHydrate,
  scheduleTranscriptDetailHydrate,
} from "./hydrateTranscriptDetail";

const loadProjectDetail = vi.fn();

vi.mock("../api", () => ({
  loadProjectDetail: (...args: unknown[]) => loadProjectDetail(...args),
}));

describe("needsTranscriptDetailHydrate", () => {
  it("is true only when host hydration flips true to false", () => {
    const hydrated = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: true, history_groups: true },
      },
    });
    const incomplete = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: false, history_groups: true },
      },
    });
    expect(needsTranscriptDetailHydrate(hydrated, incomplete)).toBe(true);
    expect(needsTranscriptDetailHydrate(incomplete, incomplete)).toBe(false);
    expect(
      needsTranscriptDetailHydrate(hydrated, {
        ...incomplete,
        project_path: "share:tok",
      }),
    ).toBe(false);
  });
});

describe("scheduleTranscriptDetailHydrate", () => {
  beforeEach(() => {
    loadProjectDetail.mockReset();
    resetDocumentSeqForTests();
    useDawStore.getState().hydrate("/tmp/p.json", null);
  });

  it("merges detail when seq is unchanged", async () => {
    const previous = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: true, history_groups: true },
      },
    });
    const next = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: false, history_groups: true },
      },
      transcript: {
        utterances: [
          {
            track_id: "host",
            speaker: "Host",
            start: 0,
            end: 0.4,
            text: "hello",
          },
        ],
      },
    });
    useDawStore.getState().setProject(next);
    loadProjectDetail.mockResolvedValue({
      transcript: {
        utterances: [
          {
            track_id: "host",
            speaker: "Host",
            start: 0,
            end: 0.4,
            text: "hello",
            words: [{ text: "hello", start: 0, end: 0.4 }],
          },
        ],
      },
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: true, history_groups: true },
      },
    });
    scheduleTranscriptDetailHydrate(previous, next);
    await vi.waitFor(() => {
      expect(
        useDawStore.getState().project?.meta.hydration?.transcript_words,
      ).toBe(true);
    });
    expect(
      useDawStore.getState().project?.transcript?.utterances[0]?.words,
    ).toEqual([{ text: "hello", start: 0, end: 0.4 }]);
  });

  it("skips a stale detail response after document seq advances", async () => {
    let resolveDetail: (value: unknown) => void = () => undefined;
    loadProjectDetail.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDetail = resolve;
        }),
    );
    const previous = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: true, history_groups: true },
      },
    });
    const next = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: false, history_groups: true },
      },
    });
    useDawStore.getState().setProject(next);
    scheduleTranscriptDetailHydrate(previous, next);
    noteDocumentSeq(4);
    resolveDetail({
      transcript: { utterances: [] },
      meta: {
        name: "stale",
        workspace_dir: "/tmp",
        hydration: { transcript_words: true, history_groups: true },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(useDawStore.getState().project?.meta.name).toBe("Test");
    expect(
      useDawStore.getState().project?.meta.hydration?.transcript_words,
    ).toBe(false);
  });
});

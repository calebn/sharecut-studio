import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { useProjectBootstrap } from "./useProjectBootstrap";

const loadProject = vi.fn();
const loadProjectDetail = vi.fn();

vi.mock("../api", () => ({
  loadProject: (...args: unknown[]) => loadProject(...args),
  loadProjectDetail: (...args: unknown[]) => loadProjectDetail(...args),
}));

describe("useProjectBootstrap", () => {
  beforeEach(() => {
    loadProject.mockReset();
    loadProjectDetail.mockReset();
    useDawStore.getState().hydrate("/tmp/p.json", null);
  });

  it("loads shell then merges detail without store.hydrate()", async () => {
    const shell = minimalProject({
      tracks: [
        {
          id: "host",
          label: "Host",
          role: "dialogue",
          speaker: null,
          gain_db: 0,
          muted: false,
          duration_sec: 10,
          fx_count: 0,
          stem_is_fresh: true,
        },
      ],
    });
    const tracks = shell.tracks;
    loadProject.mockResolvedValue(shell);
    loadProjectDetail.mockResolvedValue({
      transcript: { utterances: [] },
      history: { cursor: 0, can_undo: false, can_redo: false, groups: [] },
      meta: {
        name: "Test Episode",
        workspace_dir: "/tmp/test",
        hydration: { transcript_words: true, history_groups: true },
      },
    });
    const hydrate = vi.spyOn(useDawStore.getState(), "hydrate");
    renderHook(() => useProjectBootstrap("/tmp/p.json"));
    await waitFor(() => {
      expect(useDawStore.getState().project?.tracks).toBe(tracks);
    });
    expect(loadProject).toHaveBeenCalledWith(
      "/tmp/p.json",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(loadProjectDetail).toHaveBeenCalledWith(
      "/tmp/p.json",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(
      useDawStore.getState().project?.meta.hydration?.transcript_words,
    ).toBe(true);
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("aborts in-flight fetches on unmount so a late shell cannot land", async () => {
    let resolveShell: (value: ReturnType<typeof minimalProject>) => void = () =>
      undefined;
    loadProject.mockImplementation(
      (_path: string, init?: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
          resolveShell = resolve;
        }),
    );
    const { unmount } = renderHook(() => useProjectBootstrap("/tmp/p.json"));
    await waitFor(() => expect(loadProject).toHaveBeenCalled());
    unmount();
    resolveShell(minimalProject());
    await Promise.resolve();
    expect(useDawStore.getState().project).toBeNull();
  });

  it("skips a stale detail merge when document seq advanced", async () => {
    const shell = minimalProject();
    let resolveDetail: (value: unknown) => void = () => undefined;
    loadProject.mockResolvedValue(shell);
    loadProjectDetail.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDetail = resolve;
        }),
    );
    renderHook(() => useProjectBootstrap("/tmp/p.json"));
    await waitFor(() => {
      expect(useDawStore.getState().project).toBe(shell);
    });
    applyDocumentSnapshot({
      server_seq: 7,
      project: minimalProject({
        meta: {
          name: "after-applied",
          workspace_dir: "/tmp/test",
          hydration: { transcript_words: false, history_groups: false },
        },
      }),
    });
    resolveDetail({
      transcript: { utterances: [] },
      history: { cursor: 0, can_undo: false, can_redo: false, groups: [] },
      meta: {
        name: "stale-detail",
        workspace_dir: "/tmp/test",
        hydration: { transcript_words: true, history_groups: true },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(useDawStore.getState().project?.meta.name).toBe("after-applied");
  });

  it("clears a previous project's audio error when bootstrapping", async () => {
    const shell = minimalProject();
    loadProject.mockResolvedValue(shell);
    loadProjectDetail.mockResolvedValue({
      transcript: { utterances: [] },
      history: { cursor: 0, can_undo: false, can_redo: false, groups: [] },
      meta: {
        name: "Test Episode",
        workspace_dir: "/tmp/test",
        hydration: { transcript_words: true, history_groups: true },
      },
    });
    useDawStore.getState().setAudioError("Failed to load audio (premix)");
    renderHook(() => useProjectBootstrap("/tmp/p.json"));
    await waitFor(() => {
      expect(useDawStore.getState().project).not.toBeNull();
    });
    expect(useDawStore.getState().audioError).toBeNull();
  });
});

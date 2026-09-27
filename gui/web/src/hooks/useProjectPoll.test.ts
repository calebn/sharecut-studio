import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  noteDocumentFile,
  noteDocumentSeq,
  resetDocumentSeqForTests,
} from "../document/cursor";
import { minimalProject } from "../test/fixtures";
import type { ProjectView } from "../types/project";
import { useProjectPoll } from "./useProjectPoll";

const loadProject = vi.fn();
const loadProjectMeta = vi.fn();
const applyDocumentSnapshot = vi.fn();

vi.mock("../api", () => ({
  loadProject: (...args: unknown[]) => loadProject(...args),
  loadProjectMeta: (...args: unknown[]) => loadProjectMeta(...args),
}));

vi.mock("../document/applyDocumentUpdate", () => ({
  applyDocumentSnapshot: (...args: unknown[]) => applyDocumentSnapshot(...args),
}));

describe("useProjectPoll", () => {
  beforeEach(() => {
    resetDocumentSeqForTests();
    loadProject.mockReset();
    loadProjectMeta.mockReset();
    applyDocumentSnapshot.mockReset();
    loadProject.mockResolvedValue(minimalProject());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not GET when the socket already delivered this exact file", async () => {
    loadProjectMeta.mockResolvedValueOnce({
      mtime_ns: 1,
      size: 1,
      server_seq: 3,
    });
    loadProjectMeta.mockResolvedValue({ mtime_ns: 2, size: 5, server_seq: 3 });
    noteDocumentSeq(3);
    noteDocumentFile({ project: {}, file: { mtime_ns: 2, size: 5 } });

    renderHook(() => useProjectPoll("/p.json", vi.fn()));
    await vi.advanceTimersByTimeAsync(1500);

    expect(loadProject).not.toHaveBeenCalled();
  });

  it("GETs on an out-of-process write the socket never announced", async () => {
    loadProjectMeta.mockResolvedValueOnce({
      mtime_ns: 1,
      size: 1,
      server_seq: 3,
    });
    loadProjectMeta.mockResolvedValue({ mtime_ns: 3, size: 5, server_seq: 3 });

    renderHook(() => useProjectPoll("/p.json", vi.fn()));
    await vi.advanceTimersByTimeAsync(1500);

    expect(loadProject).toHaveBeenCalledTimes(1);
    expect(applyDocumentSnapshot).toHaveBeenCalledTimes(1);
  });

  it("drops its GET when the socket delivers the same file while it is in flight", async () => {
    loadProjectMeta.mockResolvedValueOnce({
      mtime_ns: 1,
      size: 1,
      server_seq: 10,
    });
    loadProjectMeta.mockResolvedValue({ mtime_ns: 2, size: 5, server_seq: 10 });
    let resolveProject: (p: ProjectView) => void = () => undefined;
    loadProject.mockImplementation(
      () =>
        new Promise<ProjectView>((resolve) => {
          resolveProject = resolve;
        }),
    );

    renderHook(() => useProjectPoll("/p.json", vi.fn()));
    await vi.advanceTimersByTimeAsync(1500);
    expect(loadProject).toHaveBeenCalledTimes(1);

    noteDocumentSeq(10);
    noteDocumentFile({ project: {}, file: { mtime_ns: 2, size: 5 } });
    resolveProject(minimalProject());
    await vi.advanceTimersByTimeAsync(0);

    expect(applyDocumentSnapshot).not.toHaveBeenCalled();
  });

  it("does not GET again once the poll's own fetch chains onto a later patch", async () => {
    loadProjectMeta.mockResolvedValueOnce({
      mtime_ns: 1,
      size: 1,
      server_seq: 3,
    });
    loadProjectMeta.mockResolvedValueOnce({
      mtime_ns: 3,
      size: 5,
      server_seq: 3,
    });
    loadProjectMeta.mockResolvedValue({ mtime_ns: 4, size: 6, server_seq: 4 });

    renderHook(() => useProjectPoll("/p.json", vi.fn()));
    await vi.advanceTimersByTimeAsync(1500);
    expect(loadProject).toHaveBeenCalledTimes(1);

    noteDocumentSeq(4);
    noteDocumentFile({
      file_before: { mtime_ns: 3, size: 5 },
      file: { mtime_ns: 4, size: 6 },
    });

    await vi.advanceTimersByTimeAsync(1500);
    expect(loadProject).toHaveBeenCalledTimes(1);
  });

  it("does not GET when meta seq is behind the applied seq", async () => {
    loadProjectMeta.mockResolvedValueOnce({
      mtime_ns: 1,
      size: 1,
      server_seq: 3,
    });
    loadProjectMeta.mockResolvedValue({ mtime_ns: 2, size: 5, server_seq: 2 });
    noteDocumentSeq(9);

    renderHook(() => useProjectPoll("/p.json", vi.fn()));
    await vi.advanceTimersByTimeAsync(1500);

    expect(loadProject).not.toHaveBeenCalled();
  });

  it("does not poll meta at all when disabled", async () => {
    renderHook(() => useProjectPoll("/p.json", vi.fn(), false));
    await vi.advanceTimersByTimeAsync(1500);

    expect(loadProjectMeta).not.toHaveBeenCalled();
  });
});

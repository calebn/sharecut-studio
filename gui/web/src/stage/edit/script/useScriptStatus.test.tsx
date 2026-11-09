import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../../state/dawStore";
import { seedScript } from "../../../test/scriptHostKit";
import type { PipelineJobSnapshot } from "../../../types/pipeline";
import { useScriptStatus } from "./useScriptStatus";

const PATH = "/tmp/ep";

function job(overrides: Partial<PipelineJobSnapshot> = {}) {
  return {
    id: "j1",
    project_path: PATH,
    from_step: null,
    only_step: null,
    status: "running",
    current: 1,
    total: 4,
    message: null,
    error: null,
    elapsed_sec: 0,
    steps: [],
    ...overrides,
  } satisfies PipelineJobSnapshot;
}

const status = (hasWords: boolean, onTranscribe?: () => void) =>
  renderHook(() => useScriptStatus(hasWords, onTranscribe));

beforeEach(() => {
  seedScript({ projectPath: PATH });
  useDawStore.setState({ pipelineJob: null });
});

describe("useScriptStatus", () => {
  it("is ready with words and empty without, carrying Transcribe", () => {
    const onTranscribe = vi.fn();
    expect(status(true).result.current).toEqual({ kind: "ready" });
    expect(status(false, onTranscribe).result.current).toEqual({
      kind: "empty",
      onTranscribe,
    });
  });

  it("is loading while the words hydrate", () => {
    useDawStore.setState((s) => ({
      project: s.project && {
        ...s.project,
        meta: {
          ...s.project.meta,
          hydration: { transcript_words: false },
        } as typeof s.project.meta,
      },
    }));
    expect(status(true).result.current).toEqual({ kind: "loading" });
  });

  it("is transcribing, with the run's progress, while a run that transcribes is live", () => {
    useDawStore.setState({ pipelineJob: job({ current: 1, total: 4 }) });
    expect(status(false).result.current).toEqual({
      kind: "transcribing",
      progress: 0.25,
    });
  });

  it("starts at zero when the run reports no total", () => {
    useDawStore.setState({ pipelineJob: job({ current: null, total: null }) });
    expect(status(true).result.current).toEqual({
      kind: "transcribing",
      progress: 0,
    });
  });

  it("follows the job to its end", () => {
    useDawStore.setState({ pipelineJob: job() });
    const { result } = status(true);
    expect(result.current.kind).toBe("transcribing");
    act(() => useDawStore.setState({ pipelineJob: job({ status: "ok" }) }));
    expect(result.current).toEqual({ kind: "ready" });
  });

  it.each([
    ["a run that starts after transcribing", { from_step: "detect_fillers" }],
    ["a run of another step", { only_step: "detect_fillers" }],
    ["another project's run", { project_path: "/tmp/other" }],
    ["a bounce", { kind: "bounce" }],
    ["a finished run", { status: "error" }],
  ] as const)("ignores %s", (_name, overrides) => {
    useDawStore.setState({ pipelineJob: job(overrides) });
    expect(status(true).result.current).toEqual({ kind: "ready" });
  });
});

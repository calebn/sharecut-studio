import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../../state/dawStore";
import {
  seedScript,
  setTranscriptLoading,
  transcribeRun,
} from "../../../test/scriptHostKit";
import { useScriptStatus } from "./useScriptStatus";

const status = (hasWords: boolean, onTranscribe?: () => void) =>
  renderHook(() => useScriptStatus(hasWords, onTranscribe));

beforeEach(() => seedScript());

describe("useScriptStatus", () => {
  it("is ready with words and empty without, carrying Transcribe", () => {
    const onTranscribe = vi.fn();
    expect(status(true).result.current).toEqual({ kind: "ready" });
    const empty = status(false, onTranscribe).result.current;
    expect(empty.kind).toBe("empty");
    expect(empty.kind === "empty" && empty.onTranscribe).toBe(onTranscribe);
  });

  it("is loading while the words hydrate, even with a live run", () => {
    setTranscriptLoading(true);
    useDawStore.setState({ pipelineJob: transcribeRun() });
    expect(status(true).result.current).toEqual({ kind: "loading" });
  });

  it("is transcribing, with the run's progress, over existing words", () => {
    useDawStore.setState({ pipelineJob: transcribeRun() });
    expect(status(true).result.current).toEqual({
      kind: "transcribing",
      progress: 0.25,
    });
  });

  it("follows the run to its end", () => {
    useDawStore.setState({ pipelineJob: transcribeRun() });
    const { result } = status(true);
    expect(result.current.kind).toBe("transcribing");
    act(() =>
      useDawStore.setState({ pipelineJob: transcribeRun({ status: "ok" }) }),
    );
    expect(result.current).toEqual({ kind: "ready" });
  });
});

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadTranscriptLanguageStatus,
  type TranscriptLanguageStatus,
} from "../../api";
import { recordedLanguageName, useLanguageStatus } from "./useLanguageStatus";

vi.mock("../../api", async (original) => ({
  ...(await original<typeof import("../../api")>()),
  loadTranscriptLanguageStatus: vi.fn(),
}));

const load = vi.mocked(loadTranscriptLanguageStatus);
const track = (id: string, recorded = "en") => ({
  track_id: id,
  name: id,
  recorded,
});

function answer(over: Partial<TranscriptLanguageStatus>) {
  return { language: "es", stale_tracks: [], edited_stale_tracks: [], ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  load.mockResolvedValue(answer({ stale_tracks: [track("a"), track("b")] }));
});

describe("useLanguageStatus", () => {
  it("reads the stale tracks for the staged language", async () => {
    const { result } = renderHook(() => useLanguageStatus("/p", "es", ""));
    expect(result.current).toBeNull();
    await waitFor(() =>
      expect(result.current).toEqual({
        language: "es",
        stale: [track("a"), track("b")],
        edited: [],
      }),
    );
    expect(load).toHaveBeenCalledWith("/p", "es", expect.anything());
  });

  it("reads again when the staged language changes, claiming nothing until it lands", async () => {
    const { result, rerender } = renderHook(
      ({ language }: { language: string | null }) =>
        useLanguageStatus("/p", language, ""),
      { initialProps: { language: "es" as string | null } },
    );
    await waitFor(() => expect(result.current?.stale).toHaveLength(2));
    let release: (value: TranscriptLanguageStatus) => void = () => undefined;
    load.mockReturnValueOnce(
      new Promise<TranscriptLanguageStatus>((resolve) => {
        release = resolve;
      }),
    );
    rerender({ language: "de" });
    expect(result.current).toBeNull();
    release(answer({ language: "de", stale_tracks: [track("a")] }));
    await waitFor(() => expect(result.current?.language).toBe("de"));
    expect(load).toHaveBeenLastCalledWith("/p", "de", expect.anything());
  });

  it("reads again when a run ends", async () => {
    const { rerender } = renderHook(
      ({ key }: { key: string }) => useLanguageStatus("/p", "es", key),
      { initialProps: { key: "" } },
    );
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    rerender({ key: "job-1:ok" });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it("drops an answer for a language that is no longer staged", async () => {
    let late: (value: TranscriptLanguageStatus) => void = () => undefined;
    load.mockReturnValueOnce(
      new Promise<TranscriptLanguageStatus>((resolve) => {
        late = resolve;
      }),
    );
    load.mockResolvedValueOnce(
      answer({ language: "de", stale_tracks: [track("z")] }),
    );
    const { result, rerender } = renderHook(
      ({ language }: { language: string | null }) =>
        useLanguageStatus("/p", language, ""),
      { initialProps: { language: "es" as string | null } },
    );
    rerender({ language: "de" });
    await waitFor(() => expect(result.current?.language).toBe("de"));
    late(answer({ stale_tracks: [track("a"), track("b")] }));
    await Promise.resolve();
    expect(result.current?.stale).toEqual([track("z")]);
  });

  it("hides the old answer until the read after a run ends lands", async () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useLanguageStatus("/p", "es", key),
      { initialProps: { key: "" } },
    );
    await waitFor(() => expect(result.current?.stale).toHaveLength(2));
    let release: (value: TranscriptLanguageStatus) => void = () => undefined;
    load.mockReturnValueOnce(
      new Promise<TranscriptLanguageStatus>((resolve) => {
        release = resolve;
      }),
    );
    rerender({ key: "job-1:ok" });
    expect(result.current).toBeNull();
    release(answer({ stale_tracks: [track("a")] }));
    await waitFor(() => expect(result.current?.stale).toEqual([track("a")]));
  });

  it("clears a good answer when the next read fails", async () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useLanguageStatus("/p", "es", key),
      { initialProps: { key: "" } },
    );
    await waitFor(() => expect(result.current?.stale).toHaveLength(2));
    load.mockRejectedValueOnce(new Error("down"));
    rerender({ key: "job-1:ok" });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(result.current).toBeNull();
  });

  it("asks nothing and claims nothing without a project path", async () => {
    const { result } = renderHook(() => useLanguageStatus("", "es", ""));
    await Promise.resolve();
    expect(load).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it("makes no claim when the read fails", async () => {
    load.mockRejectedValue(new Error("down"));
    const { result } = renderHook(() => useLanguageStatus("/p", "es", ""));
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });
});

describe("recordedLanguageName", () => {
  it("names one language, and says other languages when they differ", () => {
    expect(recordedLanguageName([track("a"), track("b")])).toBe("English");
    expect(recordedLanguageName([track("a"), track("b", "de")])).toBe(
      "other languages",
    );
  });
});

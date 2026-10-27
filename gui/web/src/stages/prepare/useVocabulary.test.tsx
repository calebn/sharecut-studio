import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadTranscriptVocabulary,
  saveTranscriptVocabulary,
  type TranscriptVocabulary,
} from "../../api";
import { useDawStore } from "../../state/dawStore";
import { ApiError } from "../../utils/apiError";
import { useVocabulary, VOCABULARY_CONFLICT } from "./useVocabulary";

vi.mock("../../api", async (original) => ({
  ...(await original<typeof import("../../api")>()),
  loadTranscriptVocabulary: vi.fn(),
  saveTranscriptVocabulary: vi.fn(),
}));

const load = vi.mocked(loadTranscriptVocabulary);
const save = vi.mocked(saveTranscriptVocabulary);

function vocab(over: Partial<TranscriptVocabulary> = {}): TranscriptVocabulary {
  return {
    show_title: null,
    prompt_limit: 400,
    prompt_primer: "",
    terms: ["Quetzalcoatlus"],
    guest_names: ["Okonkwo"],
    revision: "r1",
    needs_retranscription: false,
    edited_tracks: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  load.mockResolvedValue(vocab());
  save.mockImplementation(async (_path, next) =>
    vocab({
      terms: next.terms,
      guest_names: next.guest_names,
      revision: `after-${next.base_revision}`,
    }),
  );
});

describe("useVocabulary", () => {
  it("shows the saved terms and guest names as chips", async () => {
    const { result } = renderHook(() => useVocabulary("/p", ""));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.terms).toEqual(["Quetzalcoatlus", "Okonkwo"]);
    expect(result.current.needsRetranscribe).toBe(false);
  });

  it("saves every change at once against the last revision", async () => {
    const { result } = renderHook(() => useVocabulary("/p", ""));
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() =>
      result.current.onTermsChange(["Quetzalcoatlus", "Okonkwo", "Hyperion"]),
    );
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith("/p", {
      terms: ["Quetzalcoatlus", "Hyperion"],
      guest_names: ["Okonkwo"],
      base_revision: "r1",
    });
    await waitFor(() =>
      expect(result.current.terms).toEqual([
        "Quetzalcoatlus",
        "Hyperion",
        "Okonkwo",
      ]),
    );
  });

  it("writes quick changes in order, each on the revision the last one returned", async () => {
    const { result } = renderHook(() => useVocabulary("/p", ""));
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.onTermsChange(["Quetzalcoatlus", "Okonkwo", "A"]));
    act(() =>
      result.current.onTermsChange(["Quetzalcoatlus", "Okonkwo", "A", "B"]),
    );
    await waitFor(() => expect(result.current.terms).toContain("B"));
    const revisions = save.mock.calls.map(([, body]) => body.base_revision);
    expect(revisions[0]).toBe("r1");
    expect(revisions.at(-1)).toBe("after-r1");
    expect(save.mock.calls.at(-1)?.[1].terms).toEqual([
      "Quetzalcoatlus",
      "A",
      "B",
    ]);
  });

  it("says another window got there first and shows the saved list again", async () => {
    const announce = vi.fn();
    useDawStore.setState({ announceStatus: announce });
    save.mockRejectedValueOnce(new ApiError("stale", "revision_conflict", 409));
    const { result } = renderHook(() => useVocabulary("/p", ""));
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.onTermsChange(["Quetzalcoatlus", "Okonkwo", "X"]));
    await waitFor(() =>
      expect(announce).toHaveBeenCalledWith(VOCABULARY_CONFLICT, {
        tone: "error",
      }),
    );
    await waitFor(() =>
      expect(result.current.terms).toEqual(["Quetzalcoatlus", "Okonkwo"]),
    );
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("offers Re-transcribe when the saved list needs it", async () => {
    load.mockResolvedValue(vocab({ needs_retranscription: true }));
    const { result } = renderHook(() => useVocabulary("/p", ""));
    await waitFor(() => expect(result.current.needsRetranscribe).toBe(true));
  });

  it("loads again when a run ends", async () => {
    const { rerender } = renderHook(({ key }) => useVocabulary("/p", key), {
      initialProps: { key: "" },
    });
    await waitFor(() => expect(load).toHaveBeenCalledOnce());
    rerender({ key: "j1:ok" });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });
});

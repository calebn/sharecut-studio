import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../../state/dawStore";
import {
  scriptUtterance,
  scriptWord,
  seedScript,
} from "../../../test/scriptHostKit";
import type { TranscriptWordView } from "../../../types/project";
import { ScriptHost } from "./ScriptHost";

const preview = vi.hoisted(() => vi.fn());
const replace = vi.hoisted(() => vi.fn());
vi.mock("../../../api", async (original) => ({
  ...(await original<typeof import("../../../api")>()),
  previewTranscriptReplacement: preview,
  replaceTranscriptMatches: replace,
}));

const row = (
  track: string,
  sourceId: string | null,
  start: number,
  before = "Maya",
  end = start,
) => ({
  track_id: track,
  source_id: sourceId,
  start_word_index: start,
  end_word_index: end,
  before,
  after: "",
  start: 0,
  end: 0,
  retimes_words: false,
});

const mayaTwice = () =>
  seedScript({
    utterances: [
      scriptUtterance("host", "Maya", [
        scriptWord("Maya", 0, 10),
        scriptWord("one", 1, 11),
      ]),
      scriptUtterance("guest", "Anneke", [
        scriptWord("Maya", 0, 14),
        scriptWord("two", 1, 15),
      ]),
    ],
  });

const replaceField = () =>
  screen.getByRole("textbox", { name: "Replace with" });

async function openReplace(query: string, replacement: string) {
  render(<ScriptHost />);
  await userEvent.click(
    screen.getByRole("button", { name: "Find in transcript" }),
  );
  await userEvent.type(screen.getByRole("searchbox", { name: "Find" }), query);
  await userEvent.click(screen.getByRole("button", { name: "Show replace" }));
  await userEvent.type(replaceField(), replacement);
}

beforeEach(() => {
  preview.mockReset();
  replace.mockReset();
  preview.mockResolvedValue({
    matches: [row("guest", null, 0), row("host", null, 0)],
    count: 2,
    skipped_words: 0,
    preview_token: "tok-1",
  });
  replace.mockResolvedValue({ type: "Applied", history_head_id: "h1" });
  useDawStore.setState({ statusAnnouncement: "", feedbackToast: null });
  mayaTwice();
});

describe("ScriptHost single Replace", () => {
  it("sends the preview position of the current hit, not its place on screen", async () => {
    await openReplace("maya", "Maia");
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(replace).toHaveBeenCalledWith(
      "/tmp/ep",
      { search: "maya", replacement: "Maia", match_case: false },
      "tok-1",
      1,
    );
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe("Replaced 1"),
    );
    expect(useDawStore.getState().feedbackToast?.undo).toBe("h1");
  });

  it("follows the current hit when stepped to the next one", async () => {
    await openReplace("maya", "Maia");
    await userEvent.click(screen.getByRole("button", { name: "Next match" }));
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(replace.mock.calls[0][3]).toBe(0);
  });

  it("refuses a hit the preview no longer lists", async () => {
    preview.mockResolvedValue({
      matches: [],
      count: 0,
      skipped_words: 0,
      preview_token: "t",
    });
    await openReplace("maya", "Maia");
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(
      await screen.findByText("That match changed. Find it again."),
    ).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("says a no-op replacement already reads this way, without a request", async () => {
    await openReplace("maya", "Maya");
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(
      await screen.findByText("That match already reads this way."),
    ).toBeInTheDocument();
    expect(preview).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("waits with a reason on a hit that has no word index", async () => {
    const unsaved = scriptWord("Maya", 0, 14, {
      word_index: undefined,
    } as Partial<TranscriptWordView>);
    seedScript({
      utterances: [scriptUtterance("guest", "Anneke", [unsaved])],
    });
    await openReplace("maya", "Maia");
    const button = screen.getByRole("button", { name: "Replace" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText(
        "This match has no saved word position yet. Use Replace all.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(button);
    expect(preview).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Replace all" }),
    ).not.toHaveAttribute("aria-disabled");
  });

  it("moves past a replacement that still matches the search", async () => {
    replace.mockImplementation(async () => {
      act(() => {
        seedScript({
          utterances: [
            scriptUtterance("host", "Maya", [
              scriptWord("Maya", 0, 10),
              scriptWord("again", 1, 10.5),
              scriptWord("one", 2, 11),
            ]),
            scriptUtterance("guest", "Anneke", [
              scriptWord("Maya", 0, 14),
              scriptWord("two", 1, 15),
            ]),
          ],
        });
        useDawStore.getState().setTranscriptFindReplaceOpen(true);
      });
      return { type: "Applied", history_head_id: "h1" };
    });
    await openReplace("maya", "Maya again");
    expect(screen.getByRole("search")).toHaveTextContent("1 of 2");
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() =>
      expect(screen.getByRole("search")).toHaveTextContent("2 of 2"),
    );
  });

  it("stays clear of a replacement that holds the query when no hit follows", async () => {
    preview.mockResolvedValue({
      matches: [row("host", null, 0, "cat")],
      count: 1,
      skipped_words: 0,
      preview_token: "tok-1",
    });
    replace.mockImplementation(async () => {
      act(() => {
        seedScript({
          utterances: [
            scriptUtterance("host", "Maya", [
              scriptWord("cat", 0, 10),
              scriptWord("cat", 1, 10.5),
            ]),
          ],
        });
        useDawStore.getState().setTranscriptFindReplaceOpen(true);
      });
      return { type: "Applied", history_head_id: "h1" };
    });
    seedScript({
      utterances: [scriptUtterance("host", "Maya", [scriptWord("cat", 0, 10)])],
    });
    await openReplace("cat", "cat cat");
    expect(screen.getByRole("search")).toHaveTextContent("1 of 1");
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() =>
      expect(screen.getByRole("search")).toHaveTextContent("2 matches"),
    );
    expect(screen.getByRole("search")).not.toHaveTextContent("of 2");
    await userEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByRole("search")).toHaveTextContent("1 of 2");
  });

  it("steps back to the last hit when no hit is current", async () => {
    preview.mockResolvedValue({
      matches: [row("host", null, 0, "cat")],
      count: 1,
      skipped_words: 0,
      preview_token: "tok-1",
    });
    replace.mockImplementation(async () => {
      act(() => {
        seedScript({
          utterances: [
            scriptUtterance("host", "Maya", [
              scriptWord("cat", 0, 10),
              scriptWord("cat", 1, 10.5),
            ]),
          ],
        });
        useDawStore.getState().setTranscriptFindReplaceOpen(true);
      });
      return { type: "Applied", history_head_id: "h1" };
    });
    seedScript({
      utterances: [scriptUtterance("host", "Maya", [scriptWord("cat", 0, 10)])],
    });
    await openReplace("cat", "cat cat");
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() =>
      expect(screen.getByRole("search")).toHaveTextContent("2 matches"),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Previous match" }),
    );
    expect(screen.getByRole("search")).toHaveTextContent("2 of 2");
  });

  it("lands on the hit before the replaced span when none follows", async () => {
    preview.mockResolvedValue({
      matches: [row("host", null, 2, "cat")],
      count: 1,
      skipped_words: 0,
      preview_token: "tok-1",
    });
    replace.mockImplementation(async () => {
      act(() => {
        seedScript({
          utterances: [
            scriptUtterance("host", "Maya", [
              scriptWord("cat", 0, 10),
              scriptWord("dog", 1, 11),
              scriptWord("cat", 2, 12),
              scriptWord("cat", 3, 12.5),
            ]),
          ],
        });
        useDawStore.getState().setTranscriptFindReplaceOpen(true);
      });
      return { type: "Applied", history_head_id: "h1" };
    });
    seedScript({
      utterances: [
        scriptUtterance("host", "Maya", [
          scriptWord("cat", 0, 10),
          scriptWord("dog", 1, 11),
          scriptWord("cat", 2, 12),
        ]),
      ],
    });
    await openReplace("cat", "cat cat");
    await userEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByRole("search")).toHaveTextContent("2 of 2");
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() =>
      expect(screen.getByRole("search")).toHaveTextContent("1 of 3"),
    );
  });

  it("does not replace twice when Replace is clicked again before the model updates", async () => {
    seedScript({
      utterances: [scriptUtterance("host", "Maya", [scriptWord("Ada", 0, 10)])],
    });
    preview.mockResolvedValue({
      matches: [row("host", null, 0, "Ada")],
      count: 1,
      skipped_words: 0,
      preview_token: "tok-1",
    });
    await openReplace("Ada", "Ada Lovelace");
    const button = screen.getByRole("button", { name: "Replace" });
    await userEvent.click(button);
    await userEvent.click(button);
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(replace).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("refuses a preview match whose text is not the hit's text", async () => {
    preview.mockResolvedValue({
      matches: [row("guest", null, 0, "Maya Rao"), row("host", null, 0, "Rao")],
      count: 2,
      skipped_words: 0,
      preview_token: "tok-1",
    });
    await openReplace("maya", "Maia");
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(
      await screen.findByText("That match changed. Find it again."),
    ).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("keeps focus in the Replace field when Enter replaces", async () => {
    await openReplace("maya", "Maia");
    await userEvent.type(replaceField(), "{Enter}");
    await waitFor(() => expect(replace).toHaveBeenCalled());
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe("Replaced 1"),
    );
    expect(replaceField()).toHaveFocus();
  });

  it("says a queued replace is still sending, with no count", async () => {
    replace.mockResolvedValue({ queued: true });
    await openReplace("maya", "Maia");
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Replace queued. Still sending.",
      ),
    );
  });

  it("replaces again after the preview failed", async () => {
    preview.mockRejectedValueOnce(new Error("Host is busy."));
    await openReplace("maya", "Maia");
    const button = screen.getByRole("button", { name: "Replace" });
    await userEvent.click(button);
    expect(await screen.findByText("Host is busy.")).toBeInTheDocument();
    await userEvent.click(button);
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    expect(preview).toHaveBeenCalledTimes(2);
  });

  it("replaces again after a queued replace", async () => {
    replace.mockResolvedValueOnce({ queued: true });
    await openReplace("maya", "Maia");
    const button = screen.getByRole("button", { name: "Replace" });
    await userEvent.click(button);
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Replace queued. Still sending.",
      ),
    );
    await userEvent.click(button);
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(2));
  });

  it("replaces again after the replacement is edited when the model has not changed", async () => {
    await openReplace("maya", "Maia");
    const button = screen.getByRole("button", { name: "Replace" });
    await userEvent.click(button);
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    await userEvent.click(button);
    expect(preview).toHaveBeenCalledTimes(1);
    await userEvent.type(replaceField(), "a");
    await userEvent.click(button);
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(2));
  });

  it("tells two matches apart by their source", async () => {
    seedScript({
      utterances: [
        scriptUtterance("host", "Maya", [scriptWord("Maya", 0, 10)], {
          source_id: "a",
        }),
        scriptUtterance("host", "Maya", [scriptWord("Maya", 0, 14)], {
          source_id: "b",
        }),
      ],
    });
    preview.mockResolvedValue({
      matches: [row("host", "b", 0), row("host", "a", 0)],
      count: 2,
      skipped_words: 0,
      preview_token: "tok-1",
    });
    await openReplace("maya", "Maia");
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(replace.mock.calls[0][3]).toBe(1);
  });
});

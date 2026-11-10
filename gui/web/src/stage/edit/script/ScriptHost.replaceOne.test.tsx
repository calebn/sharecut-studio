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
  end = start,
) => ({
  track_id: track,
  source_id: sourceId,
  start_word_index: start,
  end_word_index: end,
  before: "",
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
});

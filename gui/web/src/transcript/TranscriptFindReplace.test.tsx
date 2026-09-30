import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { previewTranscriptReplacement, replaceTranscriptMatches } from "../api";
import { resetDocumentSeqForTests } from "../document/cursor";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { TranscriptFindReplace } from "./TranscriptFindReplace";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  previewTranscriptReplacement: vi.fn(),
  replaceTranscriptMatches: vi.fn(),
}));
const preview = {
  count: 1,
  skipped_words: 2,
  preview_token: "a".repeat(64),
  matches: [
    {
      track_id: "host",
      source_id: "take2",
      start_word_index: 0,
      end_word_index: 0,
      before: "Ada,",
      after: "Mira,",
      start: 10,
      end: 10.5,
      retimes_words: false,
    },
  ],
};
function fill() {
  fireEvent.change(screen.getByRole("textbox", { name: "Find" }), {
    target: { value: "Ada" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Replace with" }), {
    target: { value: "Mira" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview replacements" }));
}

describe("TranscriptFindReplace", () => {
  beforeEach(() => {
    resetDocumentSeqForTests();
    useDawStore
      .getState()
      .hydrate("/tmp/ep", minimalProject({ tracks: [sampleTrack()] }));
    vi.mocked(previewTranscriptReplacement)
      .mockReset()
      .mockResolvedValue(preview);
    vi.mocked(replaceTranscriptMatches)
      .mockReset()
      .mockResolvedValue({ ok: true });
  });
  it("previews literal source-keyed changes before applying the exact reviewed plan", async () => {
    const { container } = render(
      <main>
        <TranscriptFindReplace />
      </main>,
    );
    await expectNoA11yViolations(container);
    expect(screen.queryByRole("button", { name: /^Replace all/ })).toBeNull();
    fill();
    expect(
      await screen.findByRole("list", { name: "Replacement preview" }),
    ).toHaveTextContent("Source take2");
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 replacement. 2 suppressed or ignored words skipped.",
    );
    expect(screen.getByText("Ada,")).toBeVisible();
    expect(screen.getByText("Mira,")).toBeVisible();
    await expectNoA11yViolations(container);
    fireEvent.click(screen.getByRole("button", { name: "Replace all 1" }));
    await waitFor(() =>
      expect(replaceTranscriptMatches).toHaveBeenCalledExactlyOnceWith(
        "/tmp/ep",
        { search: "Ada", replacement: "Mira", match_case: false },
        preview.preview_token,
      ),
    );
    expect(
      await screen.findByRole("button", { name: "Undo replacements" }),
    ).toBeEnabled();
    act(() => useDawStore.getState().setProject(minimalProject()));
    expect(
      screen.getByRole("button", { name: "Undo replacements" }),
    ).toBeDisabled();
  });
  it("invalidates preview when replacement or case policy changes", async () => {
    render(<TranscriptFindReplace />);
    fill();
    await screen.findByRole("button", { name: "Replace all 1" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Match case" }));
    expect(screen.queryByRole("button", { name: /^Replace all/ })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Preview replacements" }),
    );
    await screen.findByRole("button", { name: "Replace all 1" });
    expect(previewTranscriptReplacement).toHaveBeenLastCalledWith("/tmp/ep", {
      search: "Ada",
      replacement: "Mira",
      match_case: true,
    });
  });
  it("shows phrase timing warning before apply and recovers from a stale refusal", async () => {
    vi.mocked(previewTranscriptReplacement).mockResolvedValue({
      ...preview,
      matches: [{ ...preview.matches[0], retimes_words: true }],
    });
    vi.mocked(replaceTranscriptMatches).mockRejectedValue(
      new Error("Transcript changed. Preview again."),
    );
    render(<TranscriptFindReplace />);
    fill();
    await screen.findByRole("button", { name: "Replace all 1" });
    expect(
      screen.getByText(/Different word counts redistribute/),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Replace all 1" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Preview again");
    expect(screen.getByRole("textbox", { name: "Replace with" })).toHaveValue(
      "Mira",
    );
    expect(screen.queryByRole("button", { name: /^Replace all/ })).toBeNull();
  });
  it("reports queued delivery and offers no undo before application", async () => {
    vi.mocked(replaceTranscriptMatches).mockResolvedValue({ queued: true });
    render(<TranscriptFindReplace />);
    fill();
    await screen.findByRole("button", { name: "Replace all 1" });
    fireEvent.click(screen.getByRole("button", { name: "Replace all 1" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Replacement queued for delivery",
      ),
    );
    expect(
      screen.queryByRole("button", { name: "Undo replacements" }),
    ).toBeNull();
  });
});

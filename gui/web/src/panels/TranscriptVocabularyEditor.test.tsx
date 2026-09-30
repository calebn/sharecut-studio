import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptVocabulary } from "../api";
import { expectNoA11yViolations } from "../test/a11y";
import { ApiError } from "../utils/apiError";
import {
  TranscriptVocabularyEditor,
  VOCABULARY_CONFLICT_MESSAGE,
} from "./TranscriptVocabularyEditor";

const loadTranscriptVocabulary = vi.fn();
const saveTranscriptVocabulary = vi.fn();

vi.mock("../api", () => ({
  loadTranscriptVocabulary: (...args: unknown[]) =>
    loadTranscriptVocabulary(...args),
  saveTranscriptVocabulary: (...args: unknown[]) =>
    saveTranscriptVocabulary(...args),
}));

const PATH = "/tmp/ep.project.json";

function vocabulary(
  overrides: Partial<TranscriptVocabulary> = {},
): TranscriptVocabulary {
  return {
    show_title: null,
    prompt_limit: 400,
    prompt_primer: "Podcast episode transcript.",
    terms: [],
    guest_names: [],
    revision: "r1",
    needs_retranscription: false,
    edited_tracks: [],
    ...overrides,
  };
}

function renderEditor(
  overrides: Partial<Parameters<typeof TranscriptVocabularyEditor>[0]> = {},
) {
  const props = {
    projectPath: PATH,
    busy: false,
    onRetranscribe: vi.fn(),
    refreshKey: "",
    ...overrides,
  };
  return { ...render(<TranscriptVocabularyEditor {...props} />), props };
}

async function termsInput() {
  const input = await screen.findByLabelText("Terms");
  await waitFor(() => expect(input).toBeEnabled());
  return input;
}

function savedTerms() {
  return within(screen.getByRole("list", { name: "Saved terms" }));
}

describe("TranscriptVocabularyEditor", () => {
  describe("Re-transcribe confirmation", () => {
    beforeEach(() => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
    });
    afterEach(() => {
      vi.mocked(window.confirm).mockRestore();
    });

    it("re-transcribes without asking when no transcript is hand-edited", async () => {
      const user = userEvent.setup();
      loadTranscriptVocabulary.mockResolvedValue(
        vocabulary({ needs_retranscription: true }),
      );
      const { props } = renderEditor();
      await user.click(
        await screen.findByRole("button", { name: "Re-transcribe" }),
      );
      expect(window.confirm).not.toHaveBeenCalled();
      expect(props.onRetranscribe).toHaveBeenCalledWith(false);
    });

    it("asks before replacing hand-edited transcripts", async () => {
      const user = userEvent.setup();
      loadTranscriptVocabulary.mockResolvedValue(
        vocabulary({
          needs_retranscription: true,
          edited_tracks: ["host", "guest"],
        }),
      );
      const { props } = renderEditor();
      await user.click(
        await screen.findByRole("button", { name: "Re-transcribe" }),
      );
      expect(window.confirm).toHaveBeenCalledWith(
        "2 tracks have hand-edited transcripts that Re-transcribe will replace: host, guest. Replace them?",
      );
      expect(props.onRetranscribe).toHaveBeenCalledWith(true);
    });

    it("does not re-transcribe when the replace prompt is declined", async () => {
      const user = userEvent.setup();
      vi.mocked(window.confirm).mockReturnValue(false);
      loadTranscriptVocabulary.mockResolvedValue(
        vocabulary({ needs_retranscription: true, edited_tracks: ["host"] }),
      );
      const { props } = renderEditor();
      await user.click(
        await screen.findByRole("button", { name: "Re-transcribe" }),
      );
      expect(window.confirm).toHaveBeenCalledWith(
        "1 track has hand-edited transcripts that Re-transcribe will replace: host. Replace them?",
      );
      expect(props.onRetranscribe).not.toHaveBeenCalled();
    });
  });

  beforeEach(() => {
    loadTranscriptVocabulary.mockReset();
    saveTranscriptVocabulary.mockReset();
    loadTranscriptVocabulary.mockResolvedValue(vocabulary());
    saveTranscriptVocabulary.mockImplementation(async (_path, body) =>
      vocabulary({
        terms: body.terms,
        guest_names: body.guest_names,
        revision: "r2",
        needs_retranscription: true,
      }),
    );
  });

  it.each([
    [
      {
        show_title: " Alpha ",
        terms: ["Alpha", "Beta", "  "],
        guest_names: ["Beta", "Bea"],
      },
      44,
      400,
    ],
    [{ terms: ["😀"] }, 29, 400],
    [{ terms: ["Alpha"], prompt_limit: 10 }, 5, 10],
    [{ prompt_limit: 0 }, 0, 0],
  ] satisfies [Partial<TranscriptVocabulary>, number, number][])(
    "counts the server prompt for %j",
    async (value, used, limit) => {
      loadTranscriptVocabulary.mockResolvedValue(vocabulary(value));
      renderEditor();
      expect(
        await screen.findByText(
          `Whisper prompt: ${used} of ${limit} characters.`,
        ),
      ).toBeInTheDocument();
    },
  );

  it("disables overflow saves and recovers at the exact limit", async () => {
    const user = userEvent.setup();
    loadTranscriptVocabulary.mockResolvedValue(
      vocabulary({ prompt_limit: 33 }),
    );
    const { container } = renderEditor();
    await user.type(await termsInput(), "Alpha{Enter}");
    const save = screen.getByRole("button", { name: "Save vocabulary" });
    expect(save).toBeEnabled();
    expect(
      screen.getByText("Whisper prompt: 33 of 33 characters."),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("Guest names"), "Bea{Enter}");
    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription(
      /38 of 33 characters.*Remove terms or guest names/,
    );
    await user.click(save);
    expect(saveTranscriptVocabulary).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
    await user.click(screen.getByRole("button", { name: "Remove Bea" }));
    expect(save).toBeEnabled();
  });

  it("allows saves when prompting is disabled", async () => {
    const user = userEvent.setup();
    loadTranscriptVocabulary.mockResolvedValue(
      vocabulary({ prompt_limit: null }),
    );
    renderEditor();
    await user.type(await termsInput(), "Alpha{Enter}");
    expect(screen.getByText(/Whisper prompt is disabled/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save vocabulary" }),
    ).toBeEnabled();
  });

  it("uses refreshed prompt metadata while preserving a dirty draft", async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderEditor();
    await user.type(await termsInput(), "Alpha{Enter}");
    loadTranscriptVocabulary.mockResolvedValue(
      vocabulary({ show_title: "Show", prompt_limit: 35 }),
    );
    rerender(
      <TranscriptVocabularyEditor {...props} refreshKey="new-context" />,
    );
    await screen.findByText(/Whisper prompt: 39 of 35 characters/);
    expect(savedTerms().getByText("Alpha")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save vocabulary" }),
    ).toBeDisabled();
  });

  it("clears a failed refresh after a successful refresh", async () => {
    const { props, rerender } = renderEditor();
    await termsInput();
    loadTranscriptVocabulary.mockRejectedValueOnce(
      new Error("Refresh unavailable"),
    );
    rerender(<TranscriptVocabularyEditor {...props} refreshKey="failed" />);
    await screen.findByText("Refresh unavailable");
    rerender(<TranscriptVocabularyEditor {...props} refreshKey="recovered" />);
    await waitFor(() =>
      expect(screen.queryByText("Refresh unavailable")).not.toBeInTheDocument(),
    );
  });

  it("clears a 503 save error after reload and keeps the draft", async () => {
    const user = userEvent.setup();
    let resolveReload!: (value: TranscriptVocabulary) => void;
    loadTranscriptVocabulary
      .mockResolvedValueOnce(vocabulary())
      .mockImplementationOnce(
        () =>
          new Promise<TranscriptVocabulary>((resolve) => {
            resolveReload = resolve;
          }),
      );
    saveTranscriptVocabulary.mockRejectedValueOnce(
      new ApiError("Project busy", null, 503),
    );
    renderEditor();
    await user.type(await termsInput(), "Alpha{Enter}");
    await user.click(screen.getByRole("button", { name: "Save vocabulary" }));
    await screen.findByText("Project busy");
    await act(async () => {
      resolveReload(vocabulary());
    });
    expect(screen.queryByText("Project busy")).not.toBeInTheDocument();
    expect(savedTerms().getByText("Alpha")).toBeInTheDocument();
  });

  it("keeps unsaved vocabulary when a refresh lands", async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderEditor();
    await user.type(await termsInput(), "Unpublished{Enter}");
    loadTranscriptVocabulary.mockResolvedValue(
      vocabulary({ terms: ["Published"] }),
    );
    rerender(<TranscriptVocabularyEditor {...props} refreshKey="job-1:ok" />);
    await waitFor(() =>
      expect(loadTranscriptVocabulary).toHaveBeenCalledTimes(2),
    );
    await act(async () => {});
    expect(savedTerms().getByText("Unpublished")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save vocabulary" }),
    ).toBeEnabled();
  });

  it("removes a term and saves the shorter list", async () => {
    const user = userEvent.setup();
    loadTranscriptVocabulary.mockResolvedValue(
      vocabulary({ terms: ["Alpha", "Beta"] }),
    );
    renderEditor();
    await user.click(
      await screen.findByRole("button", { name: "Remove Alpha" }),
    );
    expect(
      await screen.findByText(
        "Removed Alpha. Save vocabulary to keep this change.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save vocabulary" }));
    expect(saveTranscriptVocabulary).toHaveBeenCalledWith(PATH, {
      terms: ["Beta"],
      guest_names: [],
      base_revision: "r1",
    });
    expect(await screen.findByText("Vocabulary saved.")).toBeInTheDocument();
  });

  it("announces a duplicate without clearing the input", async () => {
    const user = userEvent.setup();
    loadTranscriptVocabulary.mockResolvedValue(
      vocabulary({ terms: ["Alpha"] }),
    );
    renderEditor();
    const input = await termsInput();
    await user.type(input, "Alpha{Enter}");
    expect(
      await screen.findByText("Alpha is already in the list."),
    ).toBeInTheDocument();
    expect(input).toHaveValue("Alpha");
  });

  it("shows a load failure and retries", async () => {
    const user = userEvent.setup();
    loadTranscriptVocabulary.mockRejectedValueOnce(
      new Error("Project unavailable"),
    );
    renderEditor();
    expect(await screen.findByText("Project unavailable")).toBeInTheDocument();
    expect(screen.getByLabelText("Terms")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByLabelText("Terms")).toBeEnabled());
    expect(screen.queryByText("Project unavailable")).not.toBeInTheDocument();
  });

  it("shows the server message when save fails and keeps the draft", async () => {
    const user = userEvent.setup();
    saveTranscriptVocabulary.mockRejectedValueOnce(
      new ApiError(
        "Vocabulary needs 520 Whisper prompt characters but the prompt limit is 400",
        null,
        400,
      ),
    );
    renderEditor();
    await user.type(await termsInput(), "Kaczynski{Enter}");
    await user.click(screen.getByRole("button", { name: "Save vocabulary" }));
    expect(
      await screen.findByText(/the prompt limit is 400/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(loadTranscriptVocabulary).toHaveBeenCalledTimes(2),
    );
    await act(async () => {});
    expect(savedTerms().getByText("Kaczynski")).toBeInTheDocument();
  });

  it("reloads the latest list after a save conflict", async () => {
    const user = userEvent.setup();
    loadTranscriptVocabulary
      .mockResolvedValueOnce(vocabulary({ terms: ["Alpha"] }))
      .mockResolvedValueOnce(
        vocabulary({ terms: ["Alpha", "FromOtherTab"], revision: "r9" }),
      );
    saveTranscriptVocabulary.mockRejectedValueOnce(
      new ApiError(
        "Vocabulary changed in another window; reload it before saving",
        null,
        409,
      ),
    );
    renderEditor();
    await user.type(await termsInput(), "Mine{Enter}");
    await user.click(screen.getByRole("button", { name: "Save vocabulary" }));
    expect(
      await screen.findByText(VOCABULARY_CONFLICT_MESSAGE),
    ).toBeInTheDocument();
    expect(await savedTerms().findByText("FromOtherTab")).toBeInTheDocument();
    expect(savedTerms().queryByText("Mine")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Added Mine. Save vocabulary to keep it."),
    ).not.toBeInTheDocument();
  });

  it("keeps a later draft when the conflict reload fails", async () => {
    const user = userEvent.setup();
    loadTranscriptVocabulary
      .mockResolvedValueOnce(vocabulary({ terms: ["Alpha"] }))
      .mockRejectedValueOnce(new Error("Host unavailable"))
      .mockResolvedValueOnce(vocabulary({ terms: ["Alpha"] }));
    saveTranscriptVocabulary.mockRejectedValueOnce(
      new ApiError(
        "Vocabulary changed in another window; reload it before saving",
        null,
        409,
      ),
    );
    const { props, rerender } = renderEditor();
    await user.type(await termsInput(), "Mine{Enter}");
    await user.click(screen.getByRole("button", { name: "Save vocabulary" }));
    expect(await screen.findByText("Host unavailable")).toBeInTheDocument();
    await user.type(await termsInput(), "Later{Enter}");
    rerender(<TranscriptVocabularyEditor {...props} refreshKey="job-1:ok" />);
    await waitFor(() =>
      expect(loadTranscriptVocabulary).toHaveBeenCalledTimes(3),
    );
    await act(async () => {});
    expect(savedTerms().getByText("Later")).toBeInTheDocument();
    expect(savedTerms().getByText("Mine")).toBeInTheDocument();
  });

  it("ignores a refresh that started while a save was pending", async () => {
    const user = userEvent.setup();
    let resolveSave!: (value: TranscriptVocabulary) => void;
    let resolveRefresh!: (value: TranscriptVocabulary) => void;
    saveTranscriptVocabulary.mockImplementationOnce(
      () =>
        new Promise<TranscriptVocabulary>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const { props, rerender } = renderEditor();
    await user.type(await termsInput(), "Kaczynski{Enter}");
    await user.click(screen.getByRole("button", { name: "Save vocabulary" }));
    loadTranscriptVocabulary.mockImplementationOnce(
      () =>
        new Promise<TranscriptVocabulary>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    rerender(<TranscriptVocabularyEditor {...props} refreshKey="job-1:ok" />);
    await act(async () => {
      resolveSave(
        vocabulary({
          terms: ["Kaczynski"],
          revision: "r2",
          needs_retranscription: true,
        }),
      );
    });
    expect(await screen.findByText("Vocabulary saved.")).toBeInTheDocument();
    await act(async () => {
      resolveRefresh(vocabulary());
    });
    expect(savedTerms().getByText("Kaczynski")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Re-transcribe" }),
    ).toBeInTheDocument();
  });

  it("explains that a save during a run applies next time", async () => {
    const user = userEvent.setup();
    renderEditor({ busy: true });
    await user.type(await termsInput(), "Kaczynski{Enter}");
    expect(
      screen.getByText(
        "A save during a run applies to the next transcription.",
      ),
    ).toBeInTheDocument();
  });

  it("has no axe violations with saved entries and the re-transcribe prompt", async () => {
    loadTranscriptVocabulary.mockResolvedValue(
      vocabulary({
        terms: ["Alpha"],
        guest_names: ["Bea"],
        needs_retranscription: true,
      }),
    );
    const { container } = renderEditor();
    await screen.findByRole("button", { name: "Re-transcribe" });
    await expectNoA11yViolations(container);
  });
});

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { previewTranscriptReplacement, replaceTranscriptMatches } from "../api";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import { resetDocumentAuthority } from "../document/authorityState";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import {
  interceptDetailLoads,
  shellSnapshot,
  withoutWords,
  withWords,
} from "../test/transcriptHydration";
import { TranscriptFindReplace } from "./TranscriptFindReplace";

vi.mock("../api/project", () => ({
  loadDocumentState: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  previewTranscriptReplacement: vi.fn(),
  replaceTranscriptMatches: vi.fn(),
}));

const path = "/tmp/ep";
const shell = () =>
  withoutWords(
    minimalProject({
      project_path: path,
      tracks: [sampleTrack()],
      transcript: {
        utterances: [
          {
            track_id: "host",
            speaker: "Host",
            start: 0,
            end: 1,
            text: "Ada",
          },
        ],
      },
    }),
  );

describe("TranscriptFindReplace after late word hydration", () => {
  beforeEach(() => {
    resetDocumentAuthority(path);
    useDawStore.getState().hydrate(path, shell());
    applyDocumentSnapshot(shellSnapshot(shell(), 4));
    vi.mocked(previewTranscriptReplacement)
      .mockReset()
      .mockResolvedValue({
        count: 1,
        skipped_words: 0,
        preview_token: "a".repeat(64),
        matches: [],
      });
  });

  it("keeps Undo replacements enabled when only the words arrive at the same seq", async () => {
    const detail = interceptDetailLoads();
    vi.mocked(replaceTranscriptMatches)
      .mockReset()
      .mockImplementation(async () => {
        applyDocumentSnapshot(shellSnapshot(shell(), 5));
        return { ok: true };
      });
    render(
      <main>
        <TranscriptFindReplace />
      </main>,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Find" }), {
      target: { value: "Ada" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Replace with" }), {
      target: { value: "Mira" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Preview replacements" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Replace all 1" }),
    );
    const undo = await screen.findByRole("button", {
      name: "Undo replacements",
    });
    expect(undo).toBeEnabled();
    await act(async () => {
      await detail.land(withWords(shell()));
    });
    expect(
      screen.getByRole("button", { name: "Undo replacements" }),
    ).toBeEnabled();
    act(() => {
      applyDocumentSnapshot(shellSnapshot(withWords(shell()), 6));
    });
    expect(
      screen.getByRole("button", { name: "Undo replacements" }),
    ).toBeDisabled();
  });
});

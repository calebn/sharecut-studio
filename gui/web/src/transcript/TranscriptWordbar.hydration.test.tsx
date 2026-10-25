import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  loadWordTimingContext,
  saveWordTiming,
  type WordTimingContext,
} from "../api/transcriptTiming";
import { registerTranscriptWordCommands } from "../commands/transcriptWord";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import { resetDocumentAuthority } from "../document/authorityState";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import {
  interceptDetailLoads,
  shellSnapshot,
  withoutWords,
  withWords,
} from "../test/transcriptHydration";
import { TranscriptWordbar } from "./TranscriptWordbar";

vi.mock("../api/project", () => ({ loadDocumentState: vi.fn() }));
vi.mock("../api/transcriptTiming", () => ({
  loadWordTimingContext: vi.fn(),
  saveWordTiming: vi.fn(),
}));
vi.mock("../timeline/WaveformLayer", () => ({
  WaveformLayer: vi.fn(() => <div>Source waveform</div>),
}));

const path = "/tmp/timing";
const target = { track_id: "host", source_id: "extra", word_index: 1 };
const word = {
  text: "hello",
  start: 2,
  end: 2.5,
  word_index: 1,
  timing_target: target,
};
const context = (): WordTimingContext => ({
  target,
  expected_token: "token",
  word,
  neighbors: [
    { word_index: 0, text: "before", start: 1, end: 2 },
    { word_index: 1, text: "hello", start: 2, end: 2.5 },
    { word_index: 2, text: "after", start: 3, end: 4 },
  ],
  media: {
    ref: "source:extra",
    duration_sec: 10,
    sample_rate: 1000,
    cache_key: "media-key",
  },
  window: { start: 1, end: 4 },
  warnings: [],
  transcript_gate: false,
});
const utterance = (end: number, withTimedWords: boolean) => ({
  track_id: "host",
  speaker: "Host",
  start: 2,
  end,
  text: "hello",
  ...(withTimedWords ? { words: [word] } : {}),
});

beforeEach(() => {
  vi.clearAllMocks();
  resetDocumentAuthority(path);
  const loaded = minimalProject({
    project_path: path,
    transcript: { utterances: [utterance(2.5, true)] },
    meta: {
      name: "Test",
      workspace_dir: "/tmp",
      hydration: { transcript_words: true, history_groups: true },
    },
  });
  useDawStore.getState().hydrate(path, loaded);
  applyDocumentSnapshot(shellSnapshot(loaded, 4));
  useDawStore.setState({
    transcriptTimingRequest: {
      projectPath: path,
      trackId: "host",
      sourceId: "extra",
      wordIndex: 1,
    },
  });
  vi.mocked(loadWordTimingContext).mockImplementation(
    async (_path, _target, shown) => ({ ...context(), word: shown }),
  );
  registerTranscriptWordCommands();
});

it("keeps Undo timing enabled when only the words arrive at the same seq", async () => {
  const detail = interceptDetailLoads();
  const saved = withoutWords(
    minimalProject({
      project_path: path,
      transcript: { utterances: [utterance(2.7, false)] },
    }),
  );
  vi.mocked(saveWordTiming).mockImplementation(async () => {
    applyDocumentSnapshot(shellSnapshot(saved, 5));
    return { changed: true, server_seq: 5 };
  });
  render(<TranscriptWordbar word={word} trackId="host" wordIndex={1} />);
  const slider = await screen.findByRole("slider", { name: "Word start" });
  fireEvent.change(slider, { target: { value: 2.2 } });
  fireEvent.click(screen.getByRole("button", { name: "Apply timing" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Undo timing" })).toBeEnabled(),
  );
  await act(async () => {
    await detail.land(withWords(saved));
  });
  expect(screen.getByRole("button", { name: "Undo timing" })).toBeEnabled();
  act(() => {
    applyDocumentSnapshot(shellSnapshot(withWords(saved), 6));
  });
  expect(screen.getByRole("button", { name: "Undo timing" })).toBeDisabled();
});

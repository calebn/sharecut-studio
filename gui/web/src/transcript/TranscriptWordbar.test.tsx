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
import { execute, registerCommand } from "../commands/execute";
import { registerTranscriptWordCommands } from "../commands/transcriptWord";
import {
  currentDocumentSeq,
  noteDocumentSeq,
  resetDocumentSeqForTests,
} from "../document/cursor";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { WaveformLayer } from "../timeline/WaveformLayer";
import { TranscriptWordbar } from "./TranscriptWordbar";

vi.mock("../api/transcriptTiming", () => ({
  loadWordTimingContext: vi.fn(),
  saveWordTiming: vi.fn(),
}));
vi.mock("../timeline/WaveformLayer", () => ({
  WaveformLayer: vi.fn(() => <div>Source waveform</div>),
}));
const target = { track_id: "host", source_id: "extra", word_index: 1 };
const word = {
  text: "hello",
  start: 2,
  end: 2.5,
  word_index: 1,
  timing_target: target,
};
function context(): WordTimingContext {
  return {
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
  };
}
function setup() {
  return render(<TranscriptWordbar word={word} trackId="host" wordIndex={1} />);
}
async function ready() {
  await screen.findByRole("slider", { name: "Word start" });
}
beforeEach(() => {
  vi.clearAllMocks();
  resetDocumentSeqForTests();
  useDawStore.getState().hydrate(
    "/tmp/timing",
    minimalProject({
      transcript: {
        utterances: [
          {
            track_id: "host",
            speaker: "Host",
            start: 2,
            end: 2.5,
            text: "hello",
            words: [word],
          },
        ],
      },
    }),
  );
  useDawStore.setState({
    transcriptTimingRequest: {
      projectPath: "/tmp/timing",
      trackId: "host",
      wordIndex: 1,
    },
    sourcePreview: null,
    playheadSec: 42,
    isPlaying: false,
  });
  vi.mocked(loadWordTimingContext).mockImplementation(
    async (_path, _target, shown) => ({ ...context(), word: shown }),
  );
  vi.mocked(saveWordTiming).mockResolvedValue({
    changed: true,
    server_seq: currentDocumentSeq(),
  });
  registerTranscriptWordCommands();
});
it("pointer changes stay local until one release, with independent source viewport", async () => {
  setup();
  await ready();
  const slider = screen.getByRole("slider", { name: "Word start" });
  fireEvent.pointerDown(slider, { pointerId: 1 });
  for (const value of [2.01, 2.02, 2.1, 2.2])
    fireEvent.change(slider, { target: { value } });
  expect(saveWordTiming).not.toHaveBeenCalled();
  expect(loadWordTimingContext).toHaveBeenCalledTimes(1);
  fireEvent.pointerUp(slider, { pointerId: 1 });
  await waitFor(() => expect(saveWordTiming).toHaveBeenCalledTimes(1));
  expect(saveWordTiming).toHaveBeenCalledWith(
    "/tmp/timing",
    expect.objectContaining({ target }),
    2.2,
    2.5,
  );
  expect(useDawStore.getState().playheadSec).toBe(42);
  expect(vi.mocked(WaveformLayer).mock.calls.at(-1)?.[0]).toMatchObject({
    mediaRef: "source:extra",
    mediaStartSec: 1,
    viewport: { scrollLeft: 0 },
  });
});
it("keyboard and numeric changes require explicit Apply and invalid drafts do not save", async () => {
  setup();
  await ready();
  const slider = screen.getByRole("slider", { name: "Word start" });
  fireEvent.change(slider, { target: { value: 2.1 } });
  fireEvent.keyUp(slider, { key: "ArrowRight" });
  expect(saveWordTiming).not.toHaveBeenCalled();
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "End source seconds" }),
    { target: { value: 1.5 } },
  );
  expect(screen.getByRole("button", { name: "Apply timing" })).toBeDisabled();
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "End source seconds" }),
    { target: { value: 3.2 } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Apply timing" }));
  await waitFor(() => expect(saveWordTiming).toHaveBeenCalledTimes(1));
  expect(saveWordTiming).toHaveBeenCalledWith(
    "/tmp/timing",
    expect.objectContaining({ target }),
    2.1,
    3.2,
  );
});
it.each(["pointerCancel", "lostPointerCapture", "escape"])(
  "%s cancels without writing",
  async (action) => {
    setup();
    await ready();
    const slider = screen.getByRole("slider", { name: "Word start" });
    fireEvent.pointerDown(slider, { pointerId: 1 });
    fireEvent.change(slider, { target: { value: 2.2 } });
    if (action === "escape") fireEvent.keyDown(slider, { key: "Escape" });
    else if (action === "pointerCancel")
      fireEvent.pointerCancel(slider, { pointerId: 1 });
    else fireEvent.lostPointerCapture(slider, { pointerId: 1 });
    fireEvent.pointerUp(slider, { pointerId: 1 });
    expect(slider).toHaveValue("2");
    expect(saveWordTiming).not.toHaveBeenCalled();
  },
);
it("preview uses raw source identity without changing the global clock, and unmount releases ownership", async () => {
  const view = setup();
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Play draft" }));
  expect(useDawStore.getState().sourcePreview).toMatchObject({
    trackId: "host",
    sourceId: "extra",
    cacheKey: "media-key",
    startSec: 1.85,
    endSec: 2.65,
  });
  expect(useDawStore.getState().playheadSec).toBe(42);
  view.unmount();
  expect(useDawStore.getState().sourcePreview).toBeNull();
});
it("Undo closes the draft before the restored inspector word is displayed", async () => {
  const undo = vi.fn(() => {
    useDawStore.getState().setProject(minimalProject());
    return { status: "ok" as const };
  });
  registerCommand("history.undo", undo);
  setup();
  await ready();
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Start source seconds" }),
    { target: { value: 2.2 } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Apply timing" }));
  await screen.findByRole("button", { name: "Undo timing" });
  fireEvent.click(screen.getByRole("button", { name: "Undo timing" }));
  await waitFor(() => expect(undo).toHaveBeenCalledTimes(1));
  expect(
    screen.queryByRole("slider", { name: "Word start" }),
  ).not.toBeInTheDocument();
});
it("stale save requires reload and never silently retries", async () => {
  vi.mocked(saveWordTiming).mockRejectedValue(
    new Error("Recording changed. Reopen Adjust timing."),
  );
  setup();
  await ready();
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Start source seconds" }),
    { target: { value: 2.2 } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Apply timing" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Recording changed",
  );
  expect(saveWordTiming).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("slider")).not.toBeInTheDocument();
});
it("command requires a precise source word and the open controls pass axe", async () => {
  const view = setup();
  await ready();
  await expectNoA11yViolations(view.container);
  await act(async () => {
    expect(
      await execute("transcript.adjustTiming", {
        trackId: "host",
        wordIndex: 1,
      }),
    ).toEqual({ status: "ok" });
  });
  expect(
    await execute("transcript.adjustTiming", {
      trackId: "missing",
      wordIndex: 1,
    }),
  ).toMatchObject({ status: "disabled" });
});

it("does not offer Undo for a newer command that arrives before the timing response", async () => {
  vi.mocked(saveWordTiming).mockImplementation(async () => {
    noteDocumentSeq(2);
    useDawStore.getState().setProject(minimalProject());
    return { changed: true, server_seq: 1 };
  });
  setup();
  await ready();
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Start source seconds" }),
    { target: { value: 2.2 } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Apply timing" }));
  await screen.findByText("Timing saved. One Undo restores both boundaries.");
  expect(
    screen.queryByRole("button", { name: "Undo timing" }),
  ).not.toBeInTheDocument();
});
it("guards the document cursor again when the rendered Undo button is clicked", async () => {
  const undo = vi.fn(() => ({ status: "ok" as const }));
  registerCommand("history.undo", undo);
  setup();
  await ready();
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Start source seconds" }),
    { target: { value: 2.2 } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Apply timing" }));
  const button = await screen.findByRole("button", { name: "Undo timing" });
  noteDocumentSeq(2);
  fireEvent.click(button);
  expect(undo).not.toHaveBeenCalled();
});
it("reports queued timing without showing a saved draft or inviting another Apply", async () => {
  vi.mocked(saveWordTiming).mockResolvedValue({ queued: true });
  setup();
  await ready();
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Start source seconds" }),
    { target: { value: 2.2 } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Apply timing" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Timing is queued",
  );
  expect(
    screen.queryByRole("button", { name: "Apply timing" }),
  ).not.toBeInTheDocument();
});
it("a no-op Stop invalidates pending listen feedback before any player starts", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    setup();
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Listen while adjusting" }),
    );
    fireEvent.change(screen.getByRole("slider", { name: "Word start" }), {
      target: { value: 2.2 },
    });
    act(() => useDawStore.getState().stopPlayback());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(useDawStore.getState().sourcePreview).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("remounts when null source identity changes to a recording literally named primary", async () => {
  const primary = { ...word, timing_target: { ...target, source_id: null } };
  const view = render(
    <TranscriptWordbar word={primary} trackId="host" wordIndex={1} />,
  );
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Play draft" }));
  view.rerender(
    <TranscriptWordbar
      word={{ ...word, timing_target: { ...target, source_id: "primary" } }}
      trackId="host"
      wordIndex={1}
    />,
  );
  await waitFor(() => expect(loadWordTimingContext).toHaveBeenCalledTimes(2));
  expect(
    vi.mocked(loadWordTimingContext).mock.calls.at(-1)?.[1].source_id,
  ).toBe("primary");
  expect(useDawStore.getState().sourcePreview).toBeNull();
});

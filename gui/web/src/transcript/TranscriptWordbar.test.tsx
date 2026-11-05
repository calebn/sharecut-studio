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
import { execute } from "../commands/execute";
import { registerTranscriptWordCommands } from "../commands/transcriptWord";
import {
  currentDocumentSeq,
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
  await screen.findByRole("spinbutton", { name: "Word start" });
}
const handle = (which: "start" | "end") =>
  screen.getByTestId(`handle-${which}`);
/** 300 px for the 1 s to 4 s window: 100 px a second. */
function sizeWaveform() {
  const frame = document.querySelector<HTMLElement>(".wordbar-waveform")!;
  frame.getBoundingClientRect = () =>
    ({
      left: 0,
      width: 300,
      right: 300,
      top: 0,
      bottom: 96,
      height: 96,
    }) as DOMRect;
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
it("handle drags stay local until one release, with independent source viewport", async () => {
  setup();
  await ready();
  sizeWaveform();
  fireEvent.pointerDown(handle("start"), { pointerId: 1 });
  for (const clientX of [101, 102, 110, 120])
    fireEvent.pointerMove(handle("start"), { pointerId: 1, clientX });
  expect(saveWordTiming).not.toHaveBeenCalled();
  expect(loadWordTimingContext).toHaveBeenCalledTimes(1);
  fireEvent.pointerUp(handle("start"), { pointerId: 1 });
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
it("names the neighboring words as a group", async () => {
  setup();
  await ready();
  const group = screen.getByRole("group", { name: "Neighboring words" });
  expect(group).toHaveTextContent("before");
  expect(group).toHaveTextContent("after");
});
it("has Start and End Scrub fields and Hear, and no Apply, Cancel, number or range inputs", async () => {
  const view = setup();
  await ready();
  expect(screen.getByRole("spinbutton", { name: "Word end" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Hear" })).toBeVisible();
  expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
    "Hear",
  ]);
  expect(view.container.querySelector('input[type="range"]')).toBeNull();
  expect(view.container.querySelector('input[type="number"]')).toBeNull();
  await expectNoA11yViolations(view.container);
});
it("a field commit saves on its own, and an invalid span writes nothing", async () => {
  setup();
  await ready();
  const end = screen.getByRole("spinbutton", { name: "Word end" });
  end.focus();
  fireEvent.keyDown(end, { key: "Enter" });
  fireEvent.change(document.activeElement as HTMLInputElement, {
    target: { value: "3.2" },
  });
  fireEvent.keyDown(document.activeElement as HTMLInputElement, {
    key: "Enter",
  });
  await waitFor(() => expect(saveWordTiming).toHaveBeenCalledTimes(1));
  expect(saveWordTiming).toHaveBeenCalledWith(
    "/tmp/timing",
    expect.objectContaining({ target }),
    2,
    3.2,
  );
});
it.each(["pointerCancel", "escape"])(
  "%s during a drag cancels without writing",
  async (action) => {
    setup();
    await ready();
    sizeWaveform();
    fireEvent.pointerDown(handle("start"), { pointerId: 1 });
    fireEvent.pointerMove(handle("start"), { pointerId: 1, clientX: 120 });
    expect(
      screen.getByRole("spinbutton", { name: "Word start" }),
    ).toHaveAttribute("aria-valuenow", "2.2");
    if (action === "escape")
      fireEvent.keyDown(handle("start"), { key: "Escape" });
    else fireEvent.pointerCancel(handle("start"), { pointerId: 1 });
    fireEvent.pointerUp(handle("start"), { pointerId: 1 });
    expect(
      screen.getByRole("spinbutton", { name: "Word start" }),
    ).toHaveAttribute("aria-valuenow", "2");
    expect(saveWordTiming).not.toHaveBeenCalled();
  },
);
it("Hear uses raw source identity without changing the global clock, and unmount releases ownership", async () => {
  const view = setup();
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Hear" }));
  expect(useDawStore.getState().sourcePreview).toMatchObject({
    media: {
      kind: "raw",
      trackId: "host",
      sourceId: "extra",
      cacheKey: "media-key",
    },
    startSec: 1.85,
    endSec: 2.65,
  });
  expect(useDawStore.getState().playheadSec).toBe(42);
  expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();
  view.unmount();
  expect(useDawStore.getState().sourcePreview).toBeNull();
});
it("stale save requires reload and never silently retries", async () => {
  vi.mocked(saveWordTiming).mockRejectedValue(
    new Error("Recording changed. Reopen Adjust timing."),
  );
  setup();
  await ready();
  sizeWaveform();
  fireEvent.pointerDown(handle("start"), { pointerId: 1 });
  fireEvent.pointerMove(handle("start"), { pointerId: 1, clientX: 120 });
  fireEvent.pointerUp(handle("start"), { pointerId: 1 });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Recording changed",
  );
  expect(saveWordTiming).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
});
it("adjust timing selects the word and opens its Inspector, and needs a precise source word", async () => {
  useDawStore.setState({ selection: null, inspectorKey: null });
  await act(async () => {
    expect(
      await execute("transcript.adjustTiming", {
        trackId: "host",
        wordIndex: 1,
      }),
    ).toEqual({ status: "ok" });
  });
  expect(useDawStore.getState().selection).toMatchObject({
    kind: "transcriptRange",
    trackId: "host",
    startWordIndex: 1,
  });
  expect(useDawStore.getState().inspectorKey).not.toBeNull();
  expect(
    await execute("transcript.adjustTiming", {
      trackId: "missing",
      wordIndex: 1,
    }),
  ).toMatchObject({ status: "disabled" });
});
it("reports queued timing without showing a saved draft", async () => {
  vi.mocked(saveWordTiming).mockResolvedValue({ queued: true });
  setup();
  await ready();
  sizeWaveform();
  fireEvent.pointerDown(handle("start"), { pointerId: 1 });
  fireEvent.pointerMove(handle("start"), { pointerId: 1, clientX: 120 });
  fireEvent.pointerUp(handle("start"), { pointerId: 1 });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Timing is queued",
  );
});
it("remounts when null source identity changes to a recording literally named primary", async () => {
  const primary = { ...word, timing_target: { ...target, source_id: null } };
  const view = render(
    <TranscriptWordbar word={primary} trackId="host" wordIndex={1} />,
  );
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Hear" }));
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

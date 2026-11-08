import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { applyDocumentSnapshot } from "../../document/applyDocumentUpdate";
import { resetDocumentAuthority } from "../../document/authorityState";
import type { DocumentSnapshot } from "../../document/projectPatch";
import { ReviewStage } from "../../review/ReviewStage";
import { useDawStore } from "../../state/dawStore";
import { deferred } from "../../test/deferred";
import {
  minimalProject,
  pendingEditView,
  sampleTrack,
} from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import { useReviewQueue } from "./useReviewQueue";

const wire = vi.hoisted(() => ({ detail: vi.fn(), correct: vi.fn() }));
vi.mock("../../api/project", async (original) => ({
  ...(await original<typeof import("../../api/project")>()),
  loadDocumentState: wire.detail,
}));
vi.mock("../../api", async (original) => ({
  ...(await original<typeof import("../../api")>()),
  loadTranscriptCheck: async () => null,
  correctTranscriptWord: wire.correct,
}));

let path = "";
let runs = 0;
const words = [
  {
    text: "anchor",
    start: 1.5,
    end: 1.95,
    confidence: 0.95,
    word_index: 0,
    mappable: true,
    timeline_start: 1.5,
    timeline_end: 1.95,
  },
  {
    text: "cut",
    start: 2.6,
    end: 2.85,
    confidence: 0.4,
    unsure: true,
    word_index: 1,
    mappable: false,
    timeline_start: null,
    timeline_end: null,
  },
  {
    text: "valid",
    start: 3.6,
    end: 3.9,
    confidence: 0.4,
    unsure: true,
    word_index: 2,
    mappable: true,
    timeline_start: 2.6,
    timeline_end: 2.9,
  },
  {
    text: "tail",
    start: 4,
    end: 4.2,
    confidence: 0.95,
    word_index: 3,
    mappable: true,
    timeline_start: 3,
    timeline_end: 3.2,
  },
];
function project(ready = true, changed = false) {
  const base = minimalProject();
  return minimalProject({
    tracks: [sampleTrack({ id: "host" })],
    clips: {
      clip_count: 2,
      tracks: {
        host: [
          {
            id: "left",
            source_start: 0,
            source_end: ready ? 2 : 2.5,
            timeline_start: 0,
            timeline_end: ready ? 2 : 2.5,
          },
          {
            id: "right",
            source_start: ready ? 3 : 3.5,
            source_end: 60,
            timeline_start: ready ? 2 : 2.5,
            timeline_end: 59,
          },
        ].map((clip) => ({
          ...clip,
          track_id: "host",
          source_id: null,
          recording_key: null,
          source_duration_sec: 60,
          fade_in_ms: 0,
          fade_out_ms: 0,
          join_in_mode: "fade",
        })),
      },
    },
    meta: { ...base.meta, hydration: { transcript_words: ready } },
    pending_edits: [
      pendingEditView({
        id: "p1",
        label: "Proposal",
        track_id: "host",
        timeline_start: 1.5,
        timeline_end: 3.2,
        unsure_words: [1, 2].map((i) => ({
          track_id: "host",
          source_id: null,
          word_index: i,
          text: words[i].text,
          confidence: 0.4,
        })),
      }),
    ],
    transcript: {
      utterances: [
        {
          track_id: "host",
          speaker: "Host",
          text: "anchor cut valid tail",
          start: 1.5,
          end: 4.2,
          timeline_start: 1.5,
          timeline_end: 3.2,
          timeline_spans: [{ start: 1.5, end: 3.2 }],
          mappable: true,
          ...(ready
            ? {
                words: changed
                  ? words.map((w) =>
                      w.word_index === 1
                        ? {
                            ...w,
                            mappable: true,
                            timeline_start: 2.6,
                            timeline_end: 2.85,
                          }
                        : w.word_index === 2
                          ? {
                              ...w,
                              mappable: false,
                              timeline_start: null,
                              timeline_end: null,
                            }
                          : w,
                    )
                  : words,
              }
            : {}),
        },
      ],
    },
  });
}
const interrupted = deferred<void>();
function App({ suspend = false }: { suspend?: boolean }) {
  const queue = useReviewQueue();
  if (suspend) throw interrupted.promise;
  return <ReviewStage {...queue.stageProps} />;
}
function publish(next: ReturnType<typeof project>, seq: number) {
  void act(() =>
    applyDocumentSnapshot({
      server_seq: seq,
      state_token: "test",
      project: next,
    }),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  clearRegisteredCommands();
  registerDawCommands();
  path = `/tmp/review-hydration-${++runs}/episode.sharecut`;
  stubViewportShell("desktop");
  useDawStore.getState().hydrate(path, project());
  useDawStore.setState({ stage: "review", guestMode: null });
  resetDocumentAuthority(path);
  publish(project(), 1);
});
afterEach(() => resetDocumentAuthority());

it.each([true, false])(
  "keeps the committed second target while Detail is pending, draft open=%s",
  async (open) => {
    const request = deferred<DocumentSnapshot>();
    wire.detail.mockReturnValueOnce(request.promise);
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /Proposal/ }));
    if (open) {
      await userEvent.click(screen.getByRole("button", { name: "Fix text" }));
      await userEvent.type(
        screen.getByRole("textbox", { name: "Corrected text for “valid”" }),
        " draft",
      );
    }
    const before = screen.queryByRole("textbox", {
      name: "Corrected text for “valid”",
    });
    const shell = project(false);
    publish(shell, 2);
    expect(wire.detail).toHaveBeenCalledOnce();
    expect(
      screen.getByText("“valid”", { selector: ".sys-sugg-unsure" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("“cut”", { selector: ".sys-sugg-unsure" }),
    ).not.toBeInTheDocument();
    if (open) {
      const input = screen.getByRole("textbox", {
        name: "Corrected text for “valid”",
      });
      expect(input).toBe(before);
      expect(input).toHaveValue("valid draft");
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
      fireEvent.submit(input.closest("form")!);
      expect(wire.correct).not.toHaveBeenCalled();
    }
    await act(async () =>
      request.resolve({
        server_seq: 2,
        state_token: "test",
        project: project(),
      }),
    );
    if (open)
      expect(
        screen.getByRole("textbox", { name: "Corrected text for “valid”" }),
      ).toHaveValue("valid draft");
    else
      expect(
        screen.queryByRole("textbox", { name: /Corrected text/ }),
      ).not.toBeInTheDocument();
  },
);

it("keeps a draft through failed Detail and normal retry", async () => {
  const request = deferred<DocumentSnapshot>();
  const retry = deferred<DocumentSnapshot>();
  wire.detail
    .mockReturnValueOnce(request.promise)
    .mockReturnValueOnce(retry.promise);
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: /Proposal/ }));
  await userEvent.click(screen.getByRole("button", { name: "Fix text" }));
  const input = screen.getByRole("textbox", {
    name: "Corrected text for “valid”",
  });
  await userEvent.type(input, " retained");
  publish(project(false), 2);
  await act(async () => request.reject(new Error("Detail unavailable")));
  expect(input).toHaveValue("valid retained");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(screen.getAllByText("The transcript didn't load")).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(wire.detail).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
  await act(async () =>
    retry.resolve({ server_seq: 2, state_token: "test", project: project() }),
  );
  expect(
    screen.getByRole("textbox", { name: "Corrected text for “valid”" }),
  ).toBe(input);
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  expect(wire.correct).not.toHaveBeenCalled();
});

it("retires the draft when authoritative Detail genuinely changes the target", async () => {
  const request = deferred<DocumentSnapshot>();
  wire.detail.mockReturnValueOnce(request.promise);
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: /Proposal/ }));
  await userEvent.click(screen.getByRole("button", { name: "Fix text" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: /Corrected text/ }),
    " discard",
  );
  publish(project(false), 2);
  await act(async () =>
    request.resolve({
      server_seq: 2,
      state_token: "test",
      project: project(true, true),
    }),
  );
  expect(
    screen.queryByRole("textbox", { name: /Corrected text/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText("“cut”", { selector: ".sys-sugg-unsure" }),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Fix text" }));
  expect(screen.getByRole("textbox", { name: /Corrected text/ })).toHaveValue(
    "cut",
  );
});

it.each(["path", "epoch"])(
  "does not retain a draft or target across a project %s change",
  async (change) => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /Proposal/ }));
    await userEvent.click(screen.getByRole("button", { name: "Fix text" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: /Corrected text/ }),
      " old project",
    );
    act(() => {
      if (change === "path")
        useDawStore.getState().hydrate(`${path}.other`, project(false));
      else
        useDawStore.setState((s) => ({
          project: project(false),
          projectEpoch: s.projectEpoch + 1,
        }));
    });
    expect(
      screen.queryByRole("textbox", { name: /Corrected text/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("“valid”", { selector: ".sys-sugg-unsure" }),
    ).not.toBeInTheDocument();
    expect(wire.correct).not.toHaveBeenCalled();
  },
);

it("does not publish the projection from an abandoned render", async () => {
  const request = deferred<DocumentSnapshot>();
  wire.detail.mockReturnValueOnce(request.promise);
  const view = render(
    <Suspense fallback={<p>Interrupted</p>}>
      <App />
    </Suspense>,
  );
  await userEvent.click(screen.getByRole("button", { name: /Proposal/ }));
  await userEvent.click(screen.getByRole("button", { name: "Fix text" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: /Corrected text/ }),
    " committed",
  );
  act(() => {
    view.rerender(
      <Suspense fallback={<p>Interrupted</p>}>
        <App suspend />
      </Suspense>,
    );
    applyDocumentSnapshot({
      server_seq: 2,
      state_token: "test",
      project: project(true, true),
    });
  });
  expect(screen.getByText("Interrupted")).toBeInTheDocument();
  act(() => {
    applyDocumentSnapshot({
      server_seq: 3,
      state_token: "test",
      project: project(false),
    });
    view.rerender(
      <Suspense fallback={<p>Interrupted</p>}>
        <App />
      </Suspense>,
    );
  });
  expect(
    screen.getByRole("textbox", { name: "Corrected text for “valid”" }),
  ).toHaveValue("valid committed");
  await act(async () =>
    request.resolve({ server_seq: 3, state_token: "test", project: project() }),
  );
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
});

it("replaces retained words with an authoritative empty result", async () => {
  const request = deferred<DocumentSnapshot>();
  wire.detail.mockReturnValueOnce(request.promise);
  render(<App />);
  publish(project(false), 2);
  const empty = project();
  empty.pending_edits = [];
  empty.transcript = { utterances: [] };
  await act(async () =>
    request.resolve({ server_seq: 2, state_token: "test", project: empty }),
  );
  expect(
    screen.queryByRole("region", { name: "Unsure words" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Fix text" }),
  ).not.toBeInTheDocument();
});

it("rejects a stale word callback before the pending render commits", async () => {
  const request = deferred<DocumentSnapshot>();
  wire.detail.mockReturnValueOnce(request.promise);
  const view = renderHook(() => useReviewQueue());
  const decide = view.result.current.stageProps.onDecide;
  await act(async () => {
    applyDocumentSnapshot({
      server_seq: 2,
      state_token: "test",
      project: project(false),
    });
    await decide({ ids: ["word:host::2"], result: "applied", text: "unsafe" });
  });
  expect(wire.correct).not.toHaveBeenCalled();
  expect(
    view.result.current.stageProps.items.find(
      (item) => item.id === "word:host::2",
    )?.result,
  ).toBeUndefined();
});

it("does not reconstruct raw pending targets on an initial word-free shell", () => {
  act(() => useDawStore.getState().hydrate(`${path}.new`, project(false)));
  const view = renderHook(() => useReviewQueue());
  const proposal = view.result.current.stageProps.items.find(
    (item) => item.id === "edit:p1",
  );
  expect(
    view.result.current.stageProps.items.filter(
      (item) => item.kind === "unsure-word",
    ),
  ).toHaveLength(0);
  expect(proposal?.unsure).toBe(true);
  if (!proposal) throw new Error("Expected proposal");
  expect(
    view.result.current.stageProps.content(proposal).card.unsure,
  ).toBeUndefined();
});

it.each(["pending", "failed"])(
  "does not use retained word coordinates for Hear or Open in Edit while %s",
  async (phase) => {
    const request = deferred<DocumentSnapshot>();
    wire.detail.mockReturnValueOnce(request.promise);
    const view = renderHook(() => useReviewQueue());
    const originalBegin = useDawStore.getState().beginAudition;
    const begin = vi.fn();
    useDawStore.setState({
      beginAudition: begin,
      playheadSec: 42,
      selection: null,
    });
    try {
      publish(project(false), 2);
      if (phase === "failed")
        await act(async () => request.reject(new Error("Detail unavailable")));
      await act(async () => {
        await view.result.current.stageProps.onHear("word:host::2", "A");
      });
      expect(begin).not.toHaveBeenCalled();
      await act(async () => {
        await view.result.current.stageProps.onOpenInEdit("word:host::2");
      });
      expect(useDawStore.getState().playheadSec).toBe(42);
      expect(useDawStore.getState().selection).toBeNull();
      expect(useDawStore.getState().stage).toBe("review");
      act(() => {
        void view.result.current.stageProps.onOpenInEdit("edit:p1");
      });
      expect(useDawStore.getState().selection).toMatchObject({
        kind: "pending",
        id: "p1",
      });
      if (phase === "pending") {
        const fresh = project();
        fresh.transcript!.utterances[0].words = words.map((word) =>
          word.word_index === 2
            ? { ...word, timeline_start: 8, timeline_end: 8.3 }
            : word,
        );
        await act(async () =>
          request.resolve({
            server_seq: 2,
            state_token: "test",
            project: fresh,
          }),
        );
        await act(async () => {
          await view.result.current.stageProps.onHear("word:host::2", "A");
        });
        expect(begin).toHaveBeenCalledWith({ playheadSec: 6, untilSec: 10.3 });
        await act(async () => {
          await view.result.current.stageProps.onOpenInEdit("word:host::2");
        });
        expect(useDawStore.getState().playheadSec).toBe(8);
        expect(useDawStore.getState().selection).toMatchObject({
          kind: "transcriptRange",
          startWordIndex: 2,
          endWordIndex: 2,
        });
      }
    } finally {
      useDawStore.setState({ beginAudition: originalBegin });
    }
  },
);

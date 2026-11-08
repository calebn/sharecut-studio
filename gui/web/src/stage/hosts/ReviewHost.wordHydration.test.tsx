import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
function App() {
  const queue = useReviewQueue();
  return <ReviewStage {...queue.stageProps} />;
}
function publish(next: ReturnType<typeof project>, seq: number) {
  act(() => applyDocumentSnapshot({ server_seq: seq, project: next }));
}
beforeEach(() => {
  vi.clearAllMocks();
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
      expect(
        screen.getByRole("button", { name: "Save", exact: true }),
      ).toBeDisabled();
      fireEvent.submit(input.closest("form")!);
      expect(wire.correct).not.toHaveBeenCalled();
    }
    await act(async () =>
      request.resolve({ server_seq: 2, project: project() }),
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

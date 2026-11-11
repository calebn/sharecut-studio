import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { applyDocumentSnapshot } from "../../document/applyDocumentUpdate";
import { resetDocumentAuthority } from "../../document/authorityState";
import type { DocumentSnapshot } from "../../document/projectPatch";
import { useTranscriptDetail } from "../../document/useTranscriptDetail";
import { useDawStore } from "../../state/dawStore";
import { deferred } from "../../test/deferred";
import { fakeExportServer } from "../../test/fakeExportServer";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import { DeliverStage } from "./DeliverStage";
import { ExportFlowProvider } from "./exportFlow";
import { ReviewHost } from "./ReviewHost";
import { ShareFlowProvider } from "./shareFlow";

const wire = vi.hoisted(() => ({ detail: vi.fn() }));
vi.mock("../../api/project", async (original) => ({
  ...(await original<typeof import("../../api/project")>()),
  loadDocumentState: wire.detail,
}));
let runs = 0;
function project(ready: boolean, count = 1) {
  const base = minimalProject();
  return minimalProject({
    tracks: [sampleTrack()],
    meta: { ...base.meta, hydration: { transcript_words: ready } },
    transcript: {
      utterances: [
        {
          track_id: "t1",
          speaker: "Host",
          text: "word",
          start: 0,
          end: 1,
          ...(ready
            ? {
                words: count
                  ? [
                      {
                        text: "word",
                        start: 0,
                        end: 1,
                        word_index: 0,
                        confidence: 0.4,
                        unsure: true,
                        mappable: true,
                        timeline_start: 0,
                        timeline_end: 1,
                      },
                    ]
                  : [],
              }
            : {}),
        },
      ],
    },
  });
}
function App() {
  const stage = useDawStore((s) => s.stage);
  if (stage === "review") return <ReviewHost />;
  return (
    <ExportFlowProvider>
      <ShareFlowProvider>
        <DeliverStage />
      </ShareFlowProvider>
    </ExportFlowProvider>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  fakeExportServer();
  clearRegisteredCommands();
  registerDawCommands();
  stubViewportShell("desktop");
  const path = `/tmp/deliver-hydration-${++runs}/episode.sharecut`;
  useDawStore.getState().hydrate(path, project(false));
  useDawStore.setState({ stage: "deliver", guestMode: null });
  resetDocumentAuthority(path);
});
afterEach(() => resetDocumentAuthority());

it.each([0, 1])(
  "keeps unknown detail actionable until a real count of %s arrives",
  async (count) => {
    const request = deferred<DocumentSnapshot>();
    wire.detail.mockReturnValueOnce(request.promise);
    void act(() =>
      applyDocumentSnapshot({
        server_seq: 1,
        state_token: "test",
        project: project(false),
      }),
    );
    render(<App />);
    expect(screen.getByRole("button", { name: "Check" })).toBeEnabled();
    expect(
      screen.queryByText("0 left", { exact: true }),
    ).not.toBeInTheDocument();
    await act(async () =>
      request.resolve({
        server_seq: 1,
        state_token: "test",
        project: project(true, count),
      }),
    );
    expect(
      screen.getByText(`${count} left`, { exact: true }),
    ).toBeInTheDocument();
    if (count === 0)
      expect(
        screen.queryByRole("button", { name: "Check" }),
      ).not.toBeInTheDocument();
    else expect(screen.getByRole("button", { name: "Check" })).toBeEnabled();
  },
);

it("keeps failed Detail actionable and retries through Review without duplicate announcements", async () => {
  const request = deferred<DocumentSnapshot>();
  const retry = deferred<DocumentSnapshot>();
  wire.detail
    .mockReturnValueOnce(request.promise)
    .mockReturnValueOnce(retry.promise);
  void act(() =>
    applyDocumentSnapshot({
      server_seq: 1,
      state_token: "test",
      project: project(false),
    }),
  );
  render(<App />);
  await act(async () => request.reject(new Error("Detail unavailable")));
  expect(screen.getAllByText("The transcript didn't load")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Check" })).toBeEnabled();
  expect(screen.queryByText("0 left", { exact: true })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Check" }));
  expect(useDawStore.getState().stage).toBe("review");
  expect(screen.getAllByText("The transcript didn't load")).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(wire.detail).toHaveBeenCalledTimes(2);
  await act(async () =>
    retry.resolve({
      server_seq: 1,
      state_token: "test",
      project: project(true),
    }),
  );
  act(() => useDawStore.setState({ stage: "deliver" }));
  expect(screen.getByText("1 left", { exact: true })).toBeInTheDocument();
});

it("does not retry a failed previous project's Detail", async () => {
  const request = deferred<DocumentSnapshot>();
  wire.detail.mockReturnValueOnce(request.promise);
  void act(() =>
    applyDocumentSnapshot({
      server_seq: 1,
      state_token: "test",
      project: project(false),
    }),
  );
  render(<App />);
  const view = renderHook(useTranscriptDetail);
  await act(async () => request.reject(new Error("Detail unavailable")));
  const old = view.result.current;
  if (old.kind !== "failed") throw new Error("Expected failed Detail");
  act(() => {
    useDawStore
      .getState()
      .hydrate("/tmp/deliver-other/episode.sharecut", project(true, 0));
    resetDocumentAuthority("/tmp/deliver-other/episode.sharecut");
  });
  act(() => old.retry());
  expect(wire.detail).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByText("The transcript didn't load"),
  ).not.toBeInTheDocument();
  expect(screen.getByText("0 left", { exact: true })).toBeInTheDocument();
});

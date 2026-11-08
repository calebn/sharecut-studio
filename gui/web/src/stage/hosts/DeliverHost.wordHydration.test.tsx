import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyDocumentSnapshot } from "../../document/applyDocumentUpdate";
import { resetDocumentAuthority } from "../../document/authorityState";
import type { DocumentSnapshot } from "../../document/projectPatch";
import { useDawStore } from "../../state/dawStore";
import { deferred } from "../../test/deferred";
import { fakeExportServer } from "../../test/fakeExportServer";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import { BounceFlowProvider } from "./bounceFlow";
import { DeliverStage } from "./DeliverStage";
import { ExportFlowProvider } from "./exportFlow";
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
  return (
    <ExportFlowProvider>
      <BounceFlowProvider>
        <ShareFlowProvider>
          <DeliverStage />
        </ShareFlowProvider>
      </BounceFlowProvider>
    </ExportFlowProvider>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  fakeExportServer();
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
    act(() =>
      applyDocumentSnapshot({ server_seq: 1, project: project(false) }),
    );
    render(<App />);
    expect(
      screen.getByRole("button", { name: "Check", exact: true }),
    ).toBeEnabled();
    expect(
      screen.queryByText("0 left", { exact: true }),
    ).not.toBeInTheDocument();
    await act(async () =>
      request.resolve({ server_seq: 1, project: project(true, count) }),
    );
    expect(
      screen.getByText(`${count} left`, { exact: true }),
    ).toBeInTheDocument();
    if (count === 0)
      expect(
        screen.queryByRole("button", { name: "Check", exact: true }),
      ).not.toBeInTheDocument();
    else
      expect(
        screen.getByRole("button", { name: "Check", exact: true }),
      ).toBeEnabled();
  },
);

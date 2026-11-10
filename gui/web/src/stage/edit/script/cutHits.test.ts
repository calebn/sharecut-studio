import { beforeEach, describe, expect, it, vi } from "vitest";
import { submitDocumentCommand } from "../../../api/documentEdits";
import { loadHostCommandQueue } from "../../../services/offlineQueue/offlineStore";
import { findMatches } from "../../../stages/edit/findMatches";
import { useDawStore } from "../../../state/dawStore";
import { clipRow } from "../../../test/fixtures";
import {
  scriptUtterance,
  scriptWord,
  seedScript,
} from "../../../test/scriptHostKit";
import { cutHits, resetQueuedCutsForTests } from "./cutHits";
import { scriptModelFor } from "./scriptHostModel";

vi.mock("../../../api/documentEdits", async (orig) => ({
  ...(await orig<typeof import("../../../api/documentEdits")>()),
  submitDocumentCommand: vi.fn(),
}));
vi.mock("../../../services/offlineQueue/offlineStore", async (orig) => ({
  ...(await orig<
    typeof import("../../../services/offlineQueue/offlineStore")
  >()),
  loadHostCommandQueue: vi.fn(),
  loadCommandQueue: vi.fn(),
}));

function hitsOf(query: string) {
  const { model } = scriptModelFor(useDawStore.getState().project!);
  return { model, hits: findMatches(model.turns, query, false) };
}

beforeEach(() => {
  vi.resetAllMocks();
  resetQueuedCutsForTests();
  seedScript({
    utterances: [
      scriptUtterance("host", "Maya", [
        scriptWord("um", 0, 10),
        scriptWord("so", 1, 12),
        scriptWord("um", 2, 20),
      ]),
    ],
    project: {
      clips: {
        clip_count: 1,
        tracks: {
          host: [
            clipRow({
              id: "c",
              track_id: "host",
              source_end: 60,
              timeline_end: 60,
            }),
          ],
        },
      },
    },
  });
  useDawStore.setState({ projectEpoch: 1, rangeBusy: false });
  vi.mocked(submitDocumentCommand).mockResolvedValue({
    queued: true,
    command_id: "c1",
  });
  vi.mocked(loadHostCommandQueue).mockResolvedValue([
    { command_id: "c1" },
  ] as never);
});

describe("cutHits queued guard", () => {
  it("is shared by every caller of the module", async () => {
    const { model, hits } = hitsOf("um");
    await cutHits(model, hits);
    await expect(cutHits(model, hits)).rejects.toThrow(
      "Cut all is already queued. Wait for it to send.",
    );
    expect(submitDocumentCommand).toHaveBeenCalledTimes(1);
    expect(useDawStore.getState().rangeBusy).toBe(false);
  });

  it("forgets a queued cut once its row has left the queue", async () => {
    const { model, hits } = hitsOf("um");
    await cutHits(model, hits);
    vi.mocked(loadHostCommandQueue).mockResolvedValue([]);
    await cutHits(model, hits);
    expect(submitDocumentCommand).toHaveBeenCalledTimes(2);
  });

  it("drops entries from an earlier epoch", async () => {
    const { model, hits } = hitsOf("um");
    await cutHits(model, hits);
    useDawStore.setState({ projectEpoch: 2 });
    await cutHits(model, hits);
    expect(submitDocumentCommand).toHaveBeenCalledTimes(2);
    expect(loadHostCommandQueue).not.toHaveBeenCalled();
  });

  it("keeps projects apart", async () => {
    const { model, hits } = hitsOf("um");
    await cutHits(model, hits);
    useDawStore.setState({ projectPath: "/tmp/other" });
    await cutHits(model, hits);
    expect(submitDocumentCommand).toHaveBeenCalledTimes(2);
  });
});

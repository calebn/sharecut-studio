import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/commandQueue", () => ({
  submitLiveHistoryCommand: vi.fn(),
  submitQueuedDocumentCommand: vi.fn(),
}));

import { documentScope } from "../document/authorityState";
import { submitLiveHistoryCommand } from "../services/commandQueue";
import { useDawStore } from "../state/dawStore";
import type { HistoryEntryId } from "../types/project";
import { redoHistory, undoHistory } from "./documentEdits";

const HEAD = "head" as HistoryEntryId;

function reply(guestStep: boolean) {
  vi.mocked(submitLiveHistoryCommand).mockResolvedValueOnce({
    history_head_id: "after",
    guest_step: guestStep,
  });
}

describe("a host moving a guest's step", () => {
  beforeEach(() => {
    useDawStore.setState({ statusAnnouncement: "" });
    vi.mocked(submitLiveHistoryCommand).mockReset();
  });

  it("announces Undo of a guest's change", async () => {
    reply(true);
    await undoHistory("/tmp/ep", {
      expectedHeadId: HEAD,
      scope: documentScope(),
    });
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Undid a guest's change.",
    );
  });

  it("announces Redo of a guest's change", async () => {
    reply(true);
    await redoHistory("/tmp/ep", {
      expectedHeadId: HEAD,
      scope: documentScope(),
    });
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Redid a guest's change.",
    );
  });

  it("says nothing when the step was the host's own, or the reply names no guest", async () => {
    reply(false);
    await undoHistory("/tmp/ep", {
      expectedHeadId: HEAD,
      scope: documentScope(),
    });
    vi.mocked(submitLiveHistoryCommand).mockResolvedValueOnce({
      history_head_id: "after",
    });
    await redoHistory("/tmp/ep", {
      expectedHeadId: HEAD,
      scope: documentScope(),
    });
    expect(useDawStore.getState().statusAnnouncement).toBe("");
  });
});

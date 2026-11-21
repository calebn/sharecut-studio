import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import {
  appendOutbox,
  type OutboxRow,
  returnOutboxRow,
} from "../../state/outboxStore";
import { DawProvider } from "../../state/store";
import { stubIndexedDb } from "../../test/fakeIndexedDb";
import { minimalProject } from "../../test/fixtures";
import { OfflineAttentionAnnouncer } from "./OfflineAttentionAnnouncer";

vi.mock("../../services/offlineQueue/offlineStore", () => ({
  loadHostAttention: vi.fn(async () => ({ pending: 0, conflicts: [] })),
  loadGuestAttention: vi.fn(async () => ({ pending: 0, conflicts: [] })),
  dismissHostConflicts: vi.fn(),
}));

const KEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const row: OutboxRow = {
  id: KEY,
  kind: "comment",
  body: "Words",
  author: "Ana",
  created_at: 1,
  anchor: {
    timeline_start: 12,
    timeline_end: null,
    timeline_spans: null,
    track_ids: [],
    edit_decision_id: null,
  },
};
const rows = new Map<string, unknown>();

beforeEach(() => {
  rows.clear();
  stubIndexedDb(rows);
  useDawStore
    .getState()
    .hydrate("share:tok", minimalProject(), "comment", ["view", "comment"]);
  useDawStore.setState({ statusAnnouncement: "", statusAnnouncementSeq: 0 });
});
afterEach(() => vi.unstubAllGlobals());

describe("the Needs attention summary for a guest's posts", () => {
  it("speaks a comment the host refused while the guest is somewhere else", async () => {
    await appendOutbox("tok", row);
    await returnOutboxRow("tok", KEY, "No.", 403);
    await act(async () => {
      render(
        <DawProvider projectPath="share:tok" initialProject={minimalProject()}>
          <OfflineAttentionAnnouncer />
        </DawProvider>,
      );
    });
    await vi.waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Needs attention. 1 not posted",
      ),
    );
  });

  it("speaks what waits to send", async () => {
    await appendOutbox("tok", row);
    await act(async () => {
      render(
        <DawProvider projectPath="share:tok" initialProject={minimalProject()}>
          <OfflineAttentionAnnouncer />
        </DawProvider>,
      );
    });
    await vi.waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Needs attention. 1 waiting to send",
      ),
    );
  });
});

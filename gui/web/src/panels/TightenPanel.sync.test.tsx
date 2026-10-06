import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import { resetDocumentSeqForTests } from "../document/cursor";
import { useHostSync } from "../hooks/useHostSync";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { FakeWebSocket } from "../test/fakeWebSocket";
import { minimalProject } from "../test/fixtures";
import type { PendingEditView } from "../types/project";
import { TightenPanel } from "./TightenPanel";

vi.mock("../state/requestDrainLazy", () => ({
  requestHostDrainLazy: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    loadPipelineConfig: vi.fn(async () => new Promise(() => undefined)),
  };
});

const PATH = "/tmp/ep.json";
const TOKEN = "b".repeat(64);

function pendingHit(id: string, reason: string): PendingEditView {
  return {
    id,
    track_id: "host",
    type: "remove",
    reason,
    source_start: 1,
    source_end: 1.2,
    timeline_start: 1,
    timeline_end: 1.2,
    source_start_timeline: 1,
    source_end_timeline: 1.2,
    timeline_spans: [{ start: 1, end: 1.2 }],
    mappable: true,
    crossfade_ms: 10,
    boundary_mode: null,
    cut_confidence: 0.9,
    review_required: false,
    applied: false,
    suggest_reason: null,
  };
}

function Harness() {
  useHostSync(
    PATH,
    () => undefined,
    () => ({}),
    true,
    0,
    null,
    false,
    "tighten-sync-test",
    true,
  );
  return <TightenPanel />;
}

describe("TightenPanel on a server-side job commit", () => {
  beforeEach(() => {
    FakeWebSocket.reset({ autoOpen: false });
    resetDocumentSeqForTests();
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    useDawStore.getState().hydrate(PATH, minimalProject());
    applyDocumentSnapshot({
      server_seq: 1,
      state_token: TOKEN,
      project: minimalProject(),
    });
    useDawStore.setState({
      activeTab: "tighten",
      guestMode: null,
      shareCapabilities: [],
      pipelineJob: null,
      activityJob: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists the hits a finished Find hits job proposed from its document event, with no poll", async () => {
    const fetchSpy = vi.fn(
      (_input: RequestInfo | URL) => new Promise<Response>(() => undefined),
    );
    vi.stubGlobal("fetch", fetchSpy);
    render(
      <DawProvider
        projectPath={PATH}
        initialProject={useDawStore.getState().project ?? minimalProject()}
      >
        <Harness />
      </DawProvider>,
    );
    expect(screen.getByText("No pending tighten decisions.")).toBeTruthy();
    expect(FakeWebSocket.instances).toHaveLength(1);

    await act(async () => {
      FakeWebSocket.instances[0].emit({
        plane: "document",
        type: "Applied",
        server_seq: 2,
        command: {
          server_seq: 2,
          command_id: "ext-1",
          client_id: "server:external",
          client_seq: -1,
          role: "agent",
          type: "ExternalMutate",
          payload: { projection: "shell" },
        },
        snapshot: {
          server_seq: 2,
          state_token: "c".repeat(64),
          project: minimalProject({
            pending_edits: [
              pendingHit("e1", "filler:um"),
              pendingHit("e2", "pause:0.9s"),
            ],
          }),
        },
      });
    });

    const table = await screen.findByRole("table", {
      name: "Pending tighten decisions",
    });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText(/^2 of 2 hits/)).toBeTruthy();
    const polled = fetchSpy.mock.calls.filter(([input]) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      return url.includes("/api/document/state");
    });
    expect(polled).toEqual([]);
  });
});

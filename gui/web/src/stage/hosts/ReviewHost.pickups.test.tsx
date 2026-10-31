import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const wire = vi.hoisted(() => ({
  post: vi.fn(),
  fetch: vi.fn(),
  rows: [] as { command_id: string }[],
}));
vi.mock("../../api/documentTransport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/documentTransport")>()),
  postHostDocumentCommand: wire.post,
  hostFetch: wire.fetch,
}));
vi.mock("../../services/offlineQueue/offlineStore", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../services/offlineQueue/offlineStore")
  >()),
  enqueueHostCommand: async (_path: string, cmd: { command_id: string }) => {
    const hadPredecessor = wire.rows.length > 0;
    wire.rows.push(cmd);
    return { persisted: true, hadPredecessor };
  },
  loadHostCommandQueue: async () => [...wire.rows],
  loadHostAttention: async () => ({ pending: wire.rows.length, conflicts: [] }),
  settleHostCommandOutcome: async (
    _path: string,
    id: string,
    _outcome: unknown,
    remove: boolean,
  ) => {
    if (remove) wire.rows = wire.rows.filter((r) => r.command_id !== id);
  },
  removeHostQueuedCommands: async (_path: string, ids: string[]) => {
    wire.rows = wire.rows.filter((r) => !ids.includes(r.command_id));
  },
}));
vi.mock("../edit/EditWorkspace", () => ({
  EditWorkspace: () => <div>edit workspace</div>,
}));

import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { applyDocumentSnapshot } from "../../document/applyDocumentUpdate";
import { FeedbackToast } from "../../feedback/FeedbackToast";
import { REFINE_GATE_GUI_MESSAGE } from "../../inspector/TranscriptRefineRecovery";
import { useDawKeymapListener } from "../../keymap/listener";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { commandLocks } from "../../test/commandLocks";
import {
  minimalProject,
  sampleTrack,
  sessionSuggestionView,
  wavResponse,
} from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import type {
  HistoryEntryId,
  SessionSuggestionView,
} from "../../types/project";
import { ApiError } from "../../utils/apiError";
import { StageHost } from "./StageHost";

let runs = 0;
let PATH = "";

const INSERT = sessionSuggestionView({
  id: "ss-i",
  take_count: 2,
  take_indexes: [0, 1],
});
const REPLACE = sessionSuggestionView({
  id: "ss-r",
  kind: "replace",
  session_number: 3,
  at_sec: null,
  from_sec: 300,
  to_sec: 360,
  take_count: 3,
  take_indexes: [0, 1, 2],
  selected_take: 1,
});

const server = {
  suggestions: [] as SessionSuggestionView[],
  seq: 0,
  head: "h0",
  hold: false,
  gate: false,
  fail: false,
};

const projectOf = () =>
  minimalProject({
    tracks: [
      sampleTrack({ id: "host", label: "Jon" }),
      sampleTrack({ id: "guest", label: "Rosa" }),
    ],
    timeline_duration_sec: 600,
    session_suggestions: server.suggestions,
    history: {
      ...minimalProject().history,
      head_id: server.head as HistoryEntryId,
    },
  });

function answer(body: { type: string; payload: Record<string, unknown> }) {
  const id = body.payload.suggestion_id as string;
  if (server.gate)
    return {
      ok: false,
      status: 409,
      failure: new ApiError("Check", "transcript_refine_required", 409),
    };
  if (server.fail)
    return {
      ok: false,
      status: 422,
      failure: new ApiError("Broke", null, 422),
    };
  server.seq += 1;
  if (body.type === "AcceptSessionSuggestion" && server.hold) {
    if (body.payload.override_audio_checks !== true)
      return {
        ok: true,
        data: {
          needs_confirmation: {
            reason: "cuts_other_speech",
            message: "held",
            speech: {
              tracks: [
                { track_id: "guest", speaker: "Rosa", words: [] },
                { track_id: "host", speaker: "Jon", words: [] },
              ],
            },
          },
        },
      };
  }
  server.head = `h${server.seq}`;
  server.suggestions = server.suggestions.filter((s) => s.id !== id);
  return {
    ok: true,
    data: {
      history_head_id: server.head,
      snapshot: { server_seq: server.seq, project: projectOf() },
    },
  };
}

const sent = (type: string) =>
  wire.post.mock.calls
    .map(([, body]) => body)
    .filter((body) => body.type === type);
const stage = () => document.querySelector(".rv-stage") as HTMLElement;
const press = (key: string) => fireEvent.keyDown(stage(), { key });
const heading = () => screen.getByRole("heading", { level: 2 }).textContent;
const toast = () => useDawStore.getState().feedbackToast?.message;
const groups = () =>
  [...document.querySelectorAll(".rv-group")].map((g) =>
    g.getAttribute("aria-label"),
  );

function App() {
  useDawKeymapListener();
  return (
    <>
      <StageHost />
      <FeedbackToast />
    </>
  );
}

const mount = (suggestions: SessionSuggestionView[] = [INSERT, REPLACE]) => {
  server.suggestions = suggestions;
  useDawStore.getState().hydrate(PATH, projectOf());
  useDawStore.setState({ stage: "review", guestMode: null });
  return render(<App />);
};

beforeEach(() => {
  runs += 1;
  PATH = `/tmp/review-pickups/${runs}/episode.sharecut`;
  vi.clearAllMocks();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: commandLocks(),
  });
  Object.assign(server, {
    suggestions: [],
    seq: 100 * runs,
    head: "h0",
    hold: false,
    gate: false,
    fail: false,
  });
  wire.rows = [];
  wire.post.mockImplementation(async (_path: string, body) => answer(body));
  wire.fetch.mockImplementation(async (url: string) =>
    String(url).includes("/warm")
      ? new Response(JSON.stringify({ sides: { current: "ready" } }))
      : wavResponse(1),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 404 })),
  );
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  stubViewportShell("desktop");
  clearRegisteredCommands();
  registerDawCommands();
});

describe("Review host pickups", () => {
  it("lists staged sessions as Pickups with their titles and counts them in the progress line", () => {
    mount();
    expect(groups()).toEqual(["Pickups"]);
    expect(heading()).toBe("Replace 5:00–6:00 with Session 3");
    expect(screen.getAllByText("Insert Session 2 at 12:04")[0]).toBeVisible();
    expect(screen.getByText("0 of 2 decided · saves 0.0 s")).toBeVisible();
    expect(screen.queryByRole("button", { name: /all \d/ })).toBeNull();
    expect(screen.getByText(/Take 2 of 3 · Jon/)).toBeVisible();
    const card = within(screen.getByRole("article"));
    expect(card.getByRole("button", { name: "Replace" })).toBeVisible();
    expect(card.getByRole("button", { name: "Skip" })).toBeVisible();
  });

  it("Accept on an insert sends AcceptSessionSuggestion once with no take, says Added Session N and offers Undo", async () => {
    mount([INSERT]);
    expect(
      within(screen.getByRole("article")).getByRole("button", {
        name: "Insert",
      }),
    ).toBeVisible();
    press("Enter");
    await waitFor(() => expect(toast()).toBe("Added Session 2"));
    expect(sent("AcceptSessionSuggestion")).toHaveLength(1);
    expect(sent("AcceptSessionSuggestion")[0].payload).toEqual({
      suggestion_id: "ss-i",
      override_audio_checks: false,
    });
    expect(useDawStore.getState().feedbackToast?.undo).toBeTruthy();
    expect(screen.getByText("1 of 1 decided · saves 0.0 s")).toBeVisible();
  });

  it("Accept on a replace sends the selected take, or the default one", async () => {
    mount([REPLACE]);
    press("Enter");
    await waitFor(() =>
      expect(sent("AcceptSessionSuggestion")).toHaveLength(1),
    );
    expect(sent("AcceptSessionSuggestion")[0].payload).toMatchObject({
      suggestion_id: "ss-r",
      take_index: 1,
    });
  });

  it("sends the last take when none is picked", async () => {
    mount([{ ...REPLACE, selected_take: null }]);
    press("Enter");
    await waitFor(() =>
      expect(sent("AcceptSessionSuggestion")).toHaveLength(1),
    );
    expect(sent("AcceptSessionSuggestion")[0].payload).toMatchObject({
      take_index: 2,
    });
  });

  it("Skip sends SkipSessionSuggestion and says so", async () => {
    mount([INSERT]);
    await userEvent.click(screen.getByRole("button", { name: /^Skip/ }));
    await waitFor(() => expect(toast()).toBe("Skipped Session 2"));
    expect(sent("SkipSessionSuggestion")[0].payload).toEqual({
      suggestion_id: "ss-i",
    });
    expect(sent("AcceptSessionSuggestion")).toHaveLength(0);
  });

  it("asks before replacing over other speech, keeps the card open, and Replace anyway re-sends with the override", async () => {
    server.hold = true;
    mount([REPLACE]);
    press("Enter");
    expect(
      await screen.findByText(
        /This also removes speech from Rosa and Jon\. Replace anyway\?/,
      ),
    ).toBeVisible();
    expect(heading()).toBe("Replace 5:00–6:00 with Session 3");
    expect(screen.getByText("0 of 1 decided · saves 0.0 s")).toBeVisible();
    expect(toast()).toBeUndefined();
    expect(screen.queryByRole("button", { name: "Add a note" })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Replace anyway" }),
    );
    await waitFor(() => expect(toast()).toBe("Added Session 3"));
    const calls = sent("AcceptSessionSuggestion");
    expect(calls).toHaveLength(2);
    expect(calls[0].payload.override_audio_checks).toBe(false);
    expect(calls[1].payload.override_audio_checks).toBe(true);
  });

  it("surfaces the refine gate like a cut and leaves the pickup open", async () => {
    server.gate = true;
    mount([REPLACE]);
    press("Enter");
    await waitFor(() => expect(toast()).toBe(REFINE_GATE_GUI_MESSAGE));
    expect(screen.getByText("0 of 1 decided · saves 0.0 s")).toBeVisible();
  });

  it("reopens the pickup and says why when the server refuses", async () => {
    server.fail = true;
    mount([INSERT]);
    press("Enter");
    await waitFor(() => expect(toast()).toBe("Broke"));
    expect(screen.getByText("0 of 1 decided · saves 0.0 s")).toBeVisible();
  });

  it("plays Before and After through the session audition routes, after warming on show", async () => {
    mount([REPLACE]);
    await waitFor(() =>
      expect(
        wire.fetch.mock.calls.some(([u]) =>
          String(u).includes("/api/session-suggestion/warm?"),
        ),
      ).toBe(true),
    );
    await userEvent.click(screen.getByRole("button", { name: "B" }));
    await waitFor(() =>
      expect(
        wire.fetch.mock.calls.some(([u]) => String(u).includes("hear-wav")),
      ).toBe(true),
    );
    const hear = wire.fetch.mock.calls
      .map(([u]) => String(u))
      .filter((u) => u.includes("hear-wav"));
    expect(hear[0]).toContain("suggestion_id=ss-r");
    expect(hear[0]).toContain("mode=suggested");
    expect(hear[0]).toContain("take_index=1");
    await userEvent.click(screen.getByRole("button", { name: "A" }));
    await waitFor(() =>
      expect(
        wire.fetch.mock.calls.filter(([u]) => String(u).includes("hear-wav")),
      ).toHaveLength(2),
    );
    expect(String(wire.fetch.mock.calls.at(-1)?.[0])).toContain("mode=current");
  });

  it("opens in Edit at the session position", async () => {
    mount([REPLACE]);
    await userEvent.click(screen.getByRole("button", { name: /Open in Edit/ }));
    expect(useDawStore.getState().stage).toBe("edit");
    expect(useDawStore.getState().playheadSec).toBe(300);
  });

  it("drops a pickup the server no longer lists", () => {
    mount();
    server.suggestions = [INSERT];
    act(() => {
      applyDocumentSnapshot({ server_seq: ++server.seq, project: projectOf() });
    });
    expect(screen.queryByText(/Replace 5:00/)).toBeNull();
    expect(screen.getAllByText("Insert Session 2 at 12:04")[0]).toBeVisible();
  });

  it("has no accessibility violations on a held replace", async () => {
    server.hold = true;
    const { container } = mount([REPLACE]);
    press("Enter");
    await screen.findByText(/Replace anyway\?/);
    await expectNoA11yViolations(container);
  });
});

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
  release: vi.fn(),
  odd: false,
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
vi.mock("../../audio/pendingPreview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../audio/pendingPreview")>()),
  releaseSessionPreview: wire.release,
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
  /** A SelectSessionTake refusal: its code and message. */
  refuse: null as { code: string; message: string } | null,
  /** Takes the route reports as refused: take_index to message. */
  refusals: {} as Record<number, string>,
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
  if (body.type === "SelectSessionTake") {
    if (server.refuse)
      return {
        ok: false,
        status: 409,
        failure: new ApiError(server.refuse.message, server.refuse.code, 409),
      };
    server.seq += 1;
    server.head = `h${server.seq}`;
    server.suggestions = server.suggestions.map((s) =>
      s.id === id
        ? { ...s, selected_take: body.payload.take_index as number }
        : s,
    );
    return {
      ok: true,
      data: {
        history_head_id: server.head,
        snapshot: { server_seq: server.seq, project: projectOf() },
      },
    };
  }
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
  if (wire.odd) return { ok: true, data: { needs_confirmation: "yes" } };
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
    refuse: null,
    refusals: {},
  });
  wire.rows = [];
  wire.odd = false;
  wire.post.mockImplementation(async (_path: string, body) => answer(body));
  wire.fetch.mockImplementation(async (url: string) => {
    if (String(url).includes("/warm"))
      return new Response(JSON.stringify({ sides: { current: "ready" } }));
    if (String(url).includes("/api/session-suggestion/takes?")) {
      const row = server.suggestions.find((s) =>
        String(url).includes(`suggestion_id=${s.id}`),
      );
      return new Response(
        JSON.stringify({
          suggestion_id: row?.id,
          kind: row?.kind,
          selectable: true,
          selected_take: row?.selected_take ?? null,
          default_take: row?.take_indexes.at(-1) ?? null,
          takes: (row?.take_indexes ?? []).map((i) => ({
            take_index: i,
            duration_s: 8 + i,
            word_count: 20 + i,
            speech_text: `Words of take ${i}`,
            chosen: row?.selected_take === i,
            default: row?.take_indexes.at(-1) === i,
            acceptable: !(i in server.refusals),
            refusal:
              i in server.refusals
                ? { code: "take_unusable", message: server.refusals[i] }
                : null,
          })),
        }),
      );
    }
    return wavResponse(1);
  });
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
    const card = within(screen.getByRole("article"));
    expect(card.getByText("Jon")).toBeVisible();
    expect(card.getByRole("group", { name: "Take 2 of 3" })).toBeVisible();
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

  describe("take switcher", () => {
    const switcher = () =>
      within(screen.getByRole("article")).getByRole("group", {
        name: /^Take \d of 3$/,
      });
    const fetched = (part: string) =>
      wire.fetch.mock.calls
        .map(([u]) => String(u))
        .filter((u) => u.includes(part));

    it("shows the take's length, words and first words from the takes route, and none on an insert", async () => {
      mount();
      expect(
        await within(switcher()).findByText("9.0 s · 21 words"),
      ).toBeVisible();
      expect(within(switcher()).getByText("“Words of take 1”")).toBeVisible();
      expect(fetched("/api/session-suggestion/takes?")[0]).toContain(
        "suggestion_id=ss-r",
      );
      await userEvent.click(
        screen.getAllByText("Insert Session 2 at 12:04")[0],
      );
      expect(screen.queryByRole("button", { name: "Next take" })).toBeNull();
    });

    it("Next sends SelectSessionTake with that take, the card reads it from the next patch, and Accept places it", async () => {
      mount([REPLACE]);
      await userEvent.click(screen.getByRole("button", { name: "Next take" }));
      await waitFor(() =>
        expect(within(switcher()).getByText("Take 3 of 3")).toBeVisible(),
      );
      expect(sent("SelectSessionTake")).toHaveLength(1);
      expect(sent("SelectSessionTake")[0].payload).toEqual({
        suggestion_id: "ss-r",
        take_index: 2,
      });
      expect(
        await within(switcher()).findByText("10.0 s · 22 words"),
      ).toBeVisible();
      press("Enter");
      await waitFor(() =>
        expect(sent("AcceptSessionSuggestion")).toHaveLength(1),
      );
      expect(sent("AcceptSessionSuggestion")[0].payload).toMatchObject({
        take_index: 2,
      });
    });

    it("sends one command for a double press and none for the take already chosen", async () => {
      mount([{ ...REPLACE, selected_take: 0 }]);
      const next = screen.getByRole("button", { name: "Next take" });
      fireEvent.click(next);
      fireEvent.click(next);
      await waitFor(() =>
        expect(within(switcher()).getByText("Take 2 of 3")).toBeVisible(),
      );
      expect(sent("SelectSessionTake")).toHaveLength(1);
      expect(sent("SelectSessionTake")[0].payload.take_index).toBe(1);
    });

    it("hears and re-warms the take just chosen", async () => {
      mount([REPLACE]);
      await waitFor(() =>
        expect(fetched("/api/session-suggestion/warm?")).toHaveLength(1),
      );
      await userEvent.click(screen.getByRole("button", { name: "Next take" }));
      await waitFor(() =>
        expect(fetched("/api/session-suggestion/warm?")).toHaveLength(2),
      );
      await userEvent.click(screen.getByRole("button", { name: "B" }));
      await waitFor(() =>
        expect(fetched("hear-wav").length).toBeGreaterThan(0),
      );
      expect(fetched("hear-wav").at(-1)).toContain("take_index=2");
    });

    it("releases the pickup's preview when the chosen take changes from elsewhere, such as Undo", async () => {
      mount([REPLACE]);
      wire.release.mockClear();
      server.suggestions = [{ ...REPLACE, selected_take: 0 }];
      act(() => {
        applyDocumentSnapshot({
          server_seq: ++server.seq,
          project: projectOf(),
        });
      });
      await waitFor(() => expect(wire.release).toHaveBeenCalledWith("ss-r"));
      wire.release.mockClear();
      act(() => {
        applyDocumentSnapshot({
          server_seq: ++server.seq,
          project: projectOf(),
        });
      });
      expect(wire.release).not.toHaveBeenCalledWith("ss-r");
    });

    it("cannot Accept a chosen take that Accept would refuse, and says why", async () => {
      server.refusals = { 1: "It is shorter than the range." };
      mount([REPLACE]);
      const card = within(screen.getByRole("article"));
      const accept = card.getByRole("button", { name: "Replace" });
      await waitFor(() =>
        expect(accept).toHaveAttribute(
          "title",
          "This take cannot be placed: It is shorter than the range.",
        ),
      );
      expect(accept).toBeDisabled();
      press("Enter");
      expect(sent("AcceptSessionSuggestion")).toHaveLength(0);
    });

    it("disables a take Accept would refuse, with the reason", async () => {
      server.refusals = { 2: "It is shorter than the range." };
      mount([REPLACE]);
      const next = screen.getByRole("button", { name: "Next take" });
      await waitFor(() =>
        expect(next).toHaveAttribute(
          "title",
          "Take 3 cannot be placed: It is shorter than the range.",
        ),
      );
      expect(next).toBeDisabled();
      await userEvent.click(next);
      expect(sent("SelectSessionTake")).toHaveLength(0);
    });

    it.each([
      ["session_anchor_stale", "The range moved. Re-record the pickup."],
      ["take_not_found", "That take no longer exists."],
    ])(
      "says why on a toast when the server refuses with %s, and the card stays on its take",
      async (code, message) => {
        server.refuse = { code, message };
        mount([REPLACE]);
        await userEvent.click(
          screen.getByRole("button", { name: "Previous take" }),
        );
        await waitFor(() => expect(toast()).toBe(message));
        expect(useDawStore.getState().feedbackToast?.tone).toBe("error");
        expect(within(switcher()).getByText("Take 2 of 3")).toBeVisible();
      },
    );

    it("has no accessibility violations", async () => {
      const { container } = mount([REPLACE]);
      await within(switcher()).findByText("“Words of take 1”");
      await expectNoA11yViolations(container);
    });
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

  it("stops a pickup's preview when another item is selected and when the queue unmounts", async () => {
    const view = mount();
    await userEvent.click(screen.getByText("Insert Session 2 at 12:04"));
    expect(wire.release).toHaveBeenCalledWith("ss-r");
    view.unmount();
    expect(wire.release).toHaveBeenCalledWith("ss-i");
  });

  it("shows an error, not Added Session, for a confirmation that is not an object", async () => {
    wire.odd = true;
    mount([INSERT]);
    press("Enter");
    await waitFor(() =>
      expect(toast()).toBe(
        "The host sent an unexpected reply. Nothing changed.",
      ),
    );
    expect(screen.getByText("0 of 1 decided · saves 0.0 s")).toBeVisible();
  });

  it("sends nothing for a replace another client already handled, and reloads", async () => {
    mount([REPLACE]);
    const real = useDawStore.getState();
    const spy = vi.spyOn(useDawStore, "getState").mockImplementation(() => ({
      ...real,
      project: real.project && { ...real.project, session_suggestions: [] },
    }));
    press("Enter");
    spy.mockRestore();
    await waitFor(() =>
      expect(toast()).toBe("This suggestion was already handled."),
    );
    expect(sent("AcceptSessionSuggestion")).toHaveLength(0);
    expect(screen.getByText("0 of 1 decided · saves 0.0 s")).toBeVisible();
  });

  it("lists a replace with no distinct takes and accepts it without a take_index", async () => {
    mount([{ ...REPLACE, take_indexes: [], selected_take: null }]);
    expect(screen.getByText(/3 takes · Jon/)).toBeVisible();
    press("Enter");
    await waitFor(() =>
      expect(sent("AcceptSessionSuggestion")).toHaveLength(1),
    );
    expect(sent("AcceptSessionSuggestion")[0].payload).not.toHaveProperty(
      "take_index",
    );
  });

  it("offers no A/B and plays nothing for a replace with no range", async () => {
    mount([{ ...REPLACE, from_sec: null, to_sec: null }]);
    expect(screen.queryByRole("button", { name: "B" })).toBeNull();
    press("b");
    press("a");
    await Promise.resolve();
    expect(
      wire.fetch.mock.calls.some(([u]) => String(u).includes("hear-wav")),
    ).toBe(false);
  });

  it("lets the keyboard reach Replace anyway and press it with Enter", async () => {
    server.hold = true;
    mount([REPLACE]);
    press("Enter");
    const button = await screen.findByRole("button", {
      name: "Replace anyway",
    });
    button.focus();
    expect(button).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(toast()).toBe("Added Session 3"));
    expect(
      sent("AcceptSessionSuggestion")[1].payload.override_audio_checks,
    ).toBe(true);
  });

  it("skips a pickup on the server with a left swipe on the phone", async () => {
    stubViewportShell("phone");
    mount([INSERT]);
    act(() => useDawStore.setState({ shellBreakpoint: "phone" }));
    const body = document.querySelector(".sys-decision-body") as HTMLElement;
    const at = { clientX: 200, clientY: 300, isPrimary: true, pointerId: 1 };
    fireEvent.pointerDown(body, at);
    fireEvent.pointerMove(body, { ...at, clientX: 100 });
    fireEvent.pointerUp(body, { ...at, clientX: 100 });
    await waitFor(() => expect(toast()).toBe("Skipped Session 2"));
    expect(sent("SkipSessionSuggestion")).toHaveLength(1);
  });
});

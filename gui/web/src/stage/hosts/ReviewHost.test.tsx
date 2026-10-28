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

type Held = { id: string; label: string; reason: string };

const wire = vi.hoisted(() => ({
  post: vi.fn(),
  preview: vi.fn(),
  refresh: vi.fn(),
  rows: [] as { command_id: string }[],
}));
vi.mock("../../api/documentTransport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/documentTransport")>()),
  postHostDocumentCommand: wire.post,
  hostFetch: wire.preview,
}));
vi.mock("../../document/applyDocumentUpdate", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../document/applyDocumentUpdate")
  >()),
  refreshDocumentProject: wire.refresh,
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
vi.mock("../../panels/TightenPanel", () => ({
  TightenPanel: () => <div>tighten panel</div>,
}));
vi.mock("../../panels/CommentsPanel", () => ({
  CommentsPanel: () => <div>comments panel</div>,
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
import { STAGE_FOR_TAB, tabForStage } from "../../state/stageRoutes";
import { commandLocks } from "../../test/commandLocks";
import {
  minimalProject,
  pendingEditView,
  sampleTrack,
  wavResponse,
} from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import type { HistoryEntryId, PendingEditView } from "../../types/project";
import { ApiError } from "../../utils/apiError";
import { PENDING_REVIEW_QUEUED_MESSAGE } from "../../utils/pendingEditLabels";
import { StageHost } from "./StageHost";

let runs = 0;
let PATH = "";

const edit = (
  id: string,
  kind: PendingEditView["kind"],
  at: number,
  over: Partial<PendingEditView> = {},
) =>
  pendingEditView({
    id,
    kind,
    label: `${kind} ${id}`,
    timeline_start: at,
    timeline_end: at + 1,
    timeline_spans: [{ start: at, end: at + 1 }],
    mappable: true,
    ...over,
  });

const F1 = edit("f1", "filler", 10, { why: "Jon restarts." });
const F2 = edit("f2", "filler", 20);
const F3 = edit("f3", "filler", 30);

const fresh = () => ({
  seq: 100 * runs,
  head: "h0",
  stack: [] as { head: string; pending: PendingEditView[] }[],
  pending: [] as PendingEditView[],
  gate: false,
  gateSticks: false,
  count: null as number | null,
  held: [] as Held[],
  omitSnapshot: false,
  status: "clear" as "clear" | "pending",
  waiveFails: false,
  down: false,
});
const server = fresh();
const order: string[] = [];

const projectOf = () =>
  minimalProject({
    tracks: [sampleTrack()],
    timeline_duration_sec: 600,
    pending_edits: server.pending,
    history: {
      ...minimalProject().history,
      head_id: server.head as HistoryEntryId,
      can_undo: server.stack.length > 0,
    },
  });

const statusBody = () => ({
  status: server.status,
  clear: server.status === "clear",
  low_confidence_words: 3,
});

function serverUndo() {
  const prev = server.stack.pop();
  if (prev) {
    server.pending = prev.pending;
    server.head = prev.head;
  }
}

const snapshot = (seq = ++server.seq) =>
  act(() => {
    applyDocumentSnapshot({ server_seq: seq, project: projectOf() });
  });

function reply(count: number, held: Held[] = []) {
  server.seq += 1;
  return {
    ok: true,
    data: {
      history_head_id: server.head,
      command: { payload: { result: { count, held } } },
      ...(server.omitSnapshot
        ? {}
        : { snapshot: { server_seq: server.seq, project: projectOf() } }),
    },
  };
}

function answer(body: { type: string; payload: Record<string, unknown> }) {
  order.push(body.type);
  const ids = (body.payload.ids as string[] | undefined) ?? [];
  if (server.down)
    return { ok: false, status: 503, failure: new ApiError("busy", null, 503) };
  if (body.type === "UndoHistory") {
    serverUndo();
    return reply(0);
  }
  if (body.type === "ApproveEdits" && server.gate) {
    const failure = new ApiError("Check", "transcript_refine_required", 409);
    return { ok: false, status: 409, failure };
  }
  server.stack.push({ head: server.head, pending: server.pending });
  server.head = `h${server.stack.length}`;
  const heldIds = new Set(server.held.map((h) => h.id));
  const done = server.count ?? ids.length - heldIds.size;
  const take = server.count === 0 ? [] : ids.filter((id) => !heldIds.has(id));
  server.pending =
    body.type === "RejectEdits"
      ? server.pending.filter((e) => !ids.includes(e.id))
      : server.pending.map((e) =>
          take.includes(e.id) ? { ...e, applied: true } : e,
        );
  return reply(done, server.held);
}

const fetchStub = vi.fn(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status });
    if (url.includes("/refine/status")) return json(statusBody());
    if (url.includes("/refine/waive")) {
      order.push("waive");
      if (!server.gateSticks) server.gate = false;
      return server.waiveFails ? json({ detail: "no" }, 500) : json({});
    }
    return json({}, init ? 200 : 404);
  },
);

const sent = (type: string) =>
  wire.post.mock.calls
    .map(([, body]) => body)
    .filter((body) => body.type === type);
const stage = () => document.querySelector(".rv-stage") as HTMLElement;
const press = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(stage(), { key, ...init });
const heading = () => screen.getByRole("heading", { level: 2 }).textContent;
const decided = () =>
  screen.queryByRole("region", { name: "Decided" })?.textContent ?? "";
const toast = () => useDawStore.getState().feedbackToast?.message;
const undoButton = () => screen.findByRole("button", { name: "Undo" });
const cutAnyway = () => screen.findByRole("button", { name: "Cut anyway" });
const checks = () => screen.findByRole("region", { name: "Checks" });

function App() {
  useDawKeymapListener();
  return (
    <>
      <StageHost />
      <FeedbackToast />
    </>
  );
}

const mount = (pending: PendingEditView[] = [F1, F2, F3]) => {
  server.pending = pending;
  useDawStore.getState().hydrate(PATH, projectOf());
  useDawStore.setState({ stage: "review", guestMode: null });
  return render(<App />);
};

beforeEach(() => {
  runs += 1;
  PATH = `/tmp/review-host/${runs}/episode.project.json`;
  vi.clearAllMocks();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: commandLocks(),
  });
  sessionStorage.clear();
  Object.assign(server, fresh());
  order.length = 0;
  wire.rows = [];
  wire.post.mockImplementation(async (_path: string, body) => answer(body));
  wire.preview.mockImplementation(async () => wavResponse(1));
  wire.refresh.mockImplementation(async () => {
    const project = projectOf();
    applyDocumentSnapshot({ server_seq: ++server.seq, project });
    return project;
  });
  vi.stubGlobal("fetch", fetchStub);
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

describe("Review host queue", () => {
  it("groups every kind, puts the unplaced edit last, and drops applied and unreviewed edits", () => {
    mount([
      ...(["pause", "repeat", "false-start", "sound", "other"] as const).map(
        (kind, i) => edit(kind, kind, 5 + i),
      ),
      F2,
      F1,
      edit("u", "filler", 0, {
        timeline_start: null,
        timeline_end: null,
        label: "filler unplaced",
      }),
      edit("done", "filler", 40, { applied: true, label: "filler applied" }),
      edit("quiet", "filler", 41, {
        review_required: false,
        label: "filler quiet",
      }),
    ]);
    const groups = screen.getAllByRole("region", {
      name: /^(Fillers|Pauses|Repeats|False starts|Sounds|Other suggestions)$/,
    });
    expect(groups.map((g) => g.getAttribute("aria-label")).join()).toBe(
      "Fillers,Pauses,Repeats,False starts,Sounds,Other suggestions",
    );
    const rows = within(groups[0] as HTMLElement).getAllByRole("button");
    expect(rows.at(-1)).toHaveTextContent("filler unplaced");
    expect(screen.queryByText("filler applied")).toBeNull();
    expect(screen.queryByText("filler quiet")).toBeNull();
    expect(screen.getByText("Jon restarts.")).toBeVisible();
  });

  it("lands on Queue first, publishes the wire tab impact, and gives a guest Comments only", () => {
    const view = mount();
    const tabs = within(
      screen.getByRole("tablist", { name: "Review sections" }),
    ).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.replace(" ●", "")).join()).toBe(
      "Queue,Comments,Tighten",
    );
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    const s = useDawStore.getState();
    expect(tabForStage(s.stage, s.reviewSection)).toBe("impact");
    act(() => useDawStore.getState().openStage("edit"));
    act(() =>
      useDawStore.getState().openStage(STAGE_FOR_TAB.impact.stage, {
        section: STAGE_FOR_TAB.impact.section,
      }),
    );
    expect(useDawStore.getState().reviewSection).toBe("queue");
    view.unmount();
    useDawStore.getState().hydrate("share:abc", minimalProject());
    useDawStore.setState({ stage: "review", guestMode: "comment" });
    render(<StageHost guestShare />);
    expect(
      screen.queryByRole("tablist", { name: "Review sections" }),
    ).toBeNull();
    expect(screen.getByText("comments panel")).toBeVisible();
  });

  it("ignores a lower server_seq for a decided id and drops an undecided id a snapshot removes", async () => {
    mount();
    press("Enter");
    await undoButton();
    server.pending = [F1, F2, F3];
    snapshot(server.seq - 1);
    expect(decided()).toMatch(/Decided\s*1/);
    expect(heading()).toBe("filler f2");
    server.pending = [{ ...F1, applied: true }, F3];
    snapshot();
    expect(heading()).toBe("filler f3");
    expect(screen.queryByText("filler f2")).toBeNull();
  });
});

describe("Review host decisions", () => {
  it("advances in the same act, sends one ApproveEdits without skip_unsure and one toast for two Enters", async () => {
    mount();
    expect(heading()).toBe("filler f1");
    act(() => {
      press("Enter");
      press("Enter");
    });
    expect(heading()).toBe("filler f2");
    await waitFor(() => expect(toast()).toBeTruthy());
    expect(sent("ApproveEdits")).toHaveLength(1);
    expect(sent("ApproveEdits")[0].payload).toEqual({
      ids: ["f1"],
      hold_blocked: true,
    });
  });

  it.each([
    ["x", false, false],
    ["x", false, true],
    ["Enter", true, false],
  ])(
    "Undo from the toast after %s (decision snapshot omitted: %s, Undo snapshot omitted: %s) returns the row selected with focus on the stage",
    async (key, omitDecision, omitUndo) => {
      server.omitSnapshot = omitDecision;
      mount();
      press(key);
      await undoButton();
      expect(sent(key === "x" ? "RejectEdits" : "ApproveEdits")).toHaveLength(
        1,
      );
      expect(heading()).toBe("filler f2");
      server.omitSnapshot = omitUndo;
      await userEvent.click(screen.getByRole("button", { name: "Undo" }));
      await waitFor(() => expect(sent("UndoHistory")).toHaveLength(1));
      expect(sent("UndoHistory")[0].payload.expected_head_id).toBe("h1");
      if (omitUndo) snapshot();
      await waitFor(() => expect(heading()).toBe("filler f1"));
      expect(decided()).toBe("");
      expect(document.activeElement).toBe(stage());
    },
  );

  it("returns a decided row that another tab undid when no decision snapshot was seen", async () => {
    server.omitSnapshot = true;
    mount();
    press("Enter");
    await undoButton();
    expect(decided()).toMatch(/Decided\s*1/);
    serverUndo();
    server.head = "h5";
    snapshot();
    await waitFor(() => expect(heading()).toBe("filler f1"));
    expect(decided()).toBe("");
  });

  it("Mod+Z undoes the last decision, and no Review key moves the transport", async () => {
    mount();
    stage().focus();
    for (const key of ["a", "b", "ArrowDown", "ArrowUp"]) press(key);
    expect(wire.post).not.toHaveBeenCalled();
    expect(useDawStore.getState().stage).toBe("review");
    press("Enter");
    await undoButton();
    press("z", { ctrlKey: true });
    await waitFor(() => expect(sent("UndoHistory")).toHaveLength(1));
    await waitFor(() => expect(heading()).toBe("filler f1"));
    expect(decided()).toBe("");
  });

  it("Cut all sends one command with skip_unsure and one toast; suggestion, leave and lower get no group verb", async () => {
    mount([
      F1,
      F2,
      F3,
      edit("o", "other", 50),
      edit("sl", "sound", 60, { suggested_action: "leave" }),
      edit("sw", "sound", 70, { suggested_action: "lower" }),
    ]);
    for (const name of ["Other suggestions", "Sounds"])
      expect(
        within(screen.getByRole("region", { name })).queryByRole("button", {
          name: /all/i,
        }),
      ).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Cut all 3" }));
    await undoButton();
    expect(sent("ApproveEdits")).toHaveLength(1);
    expect(sent("ApproveEdits")[0].payload).toEqual({
      ids: ["f1", "f2", "f3"],
      hold_blocked: true,
      skip_unsure: true,
    });
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("tab", { name: /Tighten/ }));
    await userEvent.click(screen.getByRole("tab", { name: /Queue/ }));
    expect(decided()).toMatch(/Decided\s*3/);
  });

  it("words and routes Lower, Leave and Shorten by the suggested action, and gates only the cut", async () => {
    server.status = "pending";
    mount([
      edit("sw", "sound", 10, { suggested_action: "lower" }),
      edit("sl", "sound", 20, { suggested_action: "leave" }),
      edit("sg", "other", 30, { suggested_action: "shorten" }),
    ]);
    await checks();
    expect(screen.getByRole("button", { name: /^Lower/ })).toBeVisible();
    press("Enter");
    await waitFor(() => expect(sent("ApplySuggestedActions")).toHaveLength(1));
    expect(sent("ApplySuggestedActions")[0].payload).toEqual({ ids: ["sw"] });
    expect(order).toEqual(["ApplySuggestedActions"]);
    expect(screen.getByRole("button", { name: /^Keep/ })).toBeVisible();
    press("Enter");
    await waitFor(() => expect(sent("RejectEdits")).toHaveLength(1));
    expect(sent("RejectEdits")[0].payload).toEqual({ ids: ["sl"] });
    expect(screen.getByRole("button", { name: /^Shorten/ })).toBeVisible();
    press("Enter");
    await userEvent.click(
      await screen.findByRole("button", { name: "Shorten anyway" }),
    );
    await waitFor(() => expect(toast()).toMatch(/^Shorten/));
    expect(sent("ApproveEdits")).toHaveLength(1);
  });

  it("returns a held row blocked and disabled without moving the user's selection, until its range changes", async () => {
    server.held = [{ id: "f1", label: "filler f1", reason: "Too close" }];
    let release = (_value: unknown) => {};
    wire.post.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    mount();
    press("Enter");
    press("ArrowDown");
    expect(heading()).toBe("filler f3");
    await waitFor(() => expect(wire.post).toHaveBeenCalledOnce());
    await act(async () =>
      release(answer({ type: "ApproveEdits", payload: { ids: ["f1"] } })),
    );
    expect(toast()).toMatch(/held/);
    expect(heading()).toBe("filler f3");
    await userEvent.click(screen.getByRole("button", { name: /filler f1/ }));
    expect(screen.getByText("Too close")).toBeVisible();
    expect(screen.getByRole("button", { name: "Cut" })).toBeDisabled();
    server.held = [];
    server.pending = [
      { ...F1, timeline_end: 12, timeline_spans: [{ start: 10, end: 12 }] },
      F2,
      F3,
    ];
    snapshot();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cut" })).toBeEnabled(),
    );
    expect(screen.queryByText("Too close")).toBeNull();
  });

  it.each([false, true])(
    "holds what the ledger still lists after a shortfall reply (refresh fails: %s)",
    async (fails) => {
      if (fails) wire.refresh.mockRejectedValue(new Error("down"));
      server.count = 0;
      mount();
      press("Enter");
      await waitFor(() => expect(wire.refresh).toHaveBeenCalled());
      await waitFor(() => expect(heading()).toBe("filler f1"));
      expect(screen.getByText("Needs a closer look in Edit")).toBeVisible();
      expect(toast()).toMatch(/held 1/);
    },
  );

  it("does not revert a lowered row when the refresh fails and the ledger shows it applied", async () => {
    wire.refresh.mockRejectedValue(new Error("down"));
    mount([
      edit("sw", "sound", 10, { suggested_action: "lower" }),
      edit("s2", "sound", 20),
    ]);
    press("Enter");
    await waitFor(() => expect(toast()).toMatch(/^Lower/));
    expect(toast()).not.toMatch(/held/);
    expect(decided()).toMatch(/Decided\s*1/);
    expect(heading()).toBe("sound s2");
  });

  it("keeps the row decided with no Undo when the reply is queued", async () => {
    server.down = true;
    mount();
    press("Enter");
    await waitFor(() => expect(toast()).toBe(PENDING_REVIEW_QUEUED_MESSAGE));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(decided()).toMatch(/Decided\s*1/);
  });

  it("shows no toast for a reply that arrives after a project switch", async () => {
    let release = (_value: unknown) => {};
    wire.post.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    mount();
    press("Enter");
    await waitFor(() => expect(wire.post).toHaveBeenCalledOnce());
    act(() =>
      useDawStore.getState().hydrate(`${PATH}.other`, minimalProject()),
    );
    await act(async () =>
      release(answer({ type: "ApproveEdits", payload: { ids: ["f1"] } })),
    );
    expect(toast()).toBeUndefined();
  });
});

describe("Review host transcript check", () => {
  const confirm = async () => {
    press("Enter");
    await userEvent.click(await cutAnyway());
  };

  it.each([false, true])(
    "restores the row, brings the check back and confirms Cut anyway as waive then approve (gate sticks: %s)",
    async (sticks) => {
      server.gate = true;
      server.gateSticks = sticks;
      mount();
      server.status = "pending";
      press("Enter");
      await waitFor(() => expect(toast()).toMatch(/Cut again to cut anyway/));
      expect(heading()).toBe("filler f1");
      await checks();
      await confirm();
      await waitFor(() => expect(sent("ApproveEdits")).toHaveLength(2));
      expect(order).toEqual(["ApproveEdits", "waive", "ApproveEdits"]);
      if (sticks)
        await waitFor(() => expect(toast()).toBe(REFINE_GATE_GUI_MESSAGE));
    },
  );

  it("asks for Cut anyway at once; sends no approve when the waive fails, and asks again on the next cut", async () => {
    server.status = "pending";
    server.waiveFails = true;
    mount();
    await checks();
    press("Enter");
    expect(await cutAnyway()).toBeVisible();
    expect(wire.post).not.toHaveBeenCalled();
    await userEvent.click(await cutAnyway());
    await waitFor(() => expect(toast()).toBeTruthy());
    expect(order).toEqual(["waive"]);
    expect(sent("ApproveEdits")).toHaveLength(0);
    await waitFor(() => expect(heading()).toBe("filler f1"));
    press("Enter");
    expect(await cutAnyway()).toBeVisible();
  });

  it("does not let Keep on the check hide Cut anyway or send anything", async () => {
    server.status = "pending";
    mount();
    await userEvent.click(
      within(await checks()).getByRole("button", { name: "Review" }),
    );
    expect(heading()).toBe("Check the transcript");
    expect(screen.queryByRole("button", { name: /^Keep/ })).toBeNull();
    press("x");
    expect(wire.post).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cut all 3" }));
    expect(await cutAnyway()).toBeVisible();
  });

  it("ignores a stale status response that arrives after a newer one", async () => {
    let release = (_value: Response) => {};
    fetchStub.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    server.gate = true;
    mount();
    press("Enter");
    await waitFor(() => expect(toast()).toBe(REFINE_GATE_GUI_MESSAGE));
    const stale = { ...statusBody(), status: "pending", clear: false };
    await act(async () =>
      release(new Response(JSON.stringify(stale), { status: 200 })),
    );
    expect(screen.queryByRole("region", { name: "Checks" })).toBeNull();
  });
});

describe("Review host hearing and editing", () => {
  it("plays B with mode suggested and 3 s of padding, with no waveform handles", async () => {
    mount();
    expect(screen.queryAllByRole("slider")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "B" }));
    await waitFor(() => expect(wire.preview).toHaveBeenCalled());
    const url = String(wire.preview.mock.calls[0][0]);
    expect(url).toContain("edit_id=f1");
    expect(url).toContain("mode=suggested");
    expect(url).toContain("pad_sec=3");
  });

  it.each([
    ["placed", F1, "f1"],
    [
      "unplaced",
      edit("u", "filler", 0, { timeline_start: null, timeline_end: null }),
      "u",
    ],
  ])("opens a %s edit in Edit", async (_name, target, id) => {
    mount([target]);
    await userEvent.click(screen.getByRole("button", { name: /Open in Edit/ }));
    expect(useDawStore.getState().stage).toBe("edit");
    expect(useDawStore.getState().selection).toMatchObject({
      kind: "pending",
      id,
    });
  });
});

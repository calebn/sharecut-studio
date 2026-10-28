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
import { requestHostDrain } from "../../services/offlineQueue/drainOfflineQueue";
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

const server = {
  seq: 0,
  head: "h0",
  stack: [] as { head: string; pending: PendingEditView[] }[],
  pending: [] as PendingEditView[],
  gate: false,
  gateSticks: false,
  count: null as number | null,
  held: [] as Held[],
  omitSnapshot: false,
  keep: false,
  status: "clear" as "clear" | "pending",
  waiveFails: false,
  down: false,
};
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
  stale: false,
  mode: "require",
  source: null,
  notes: "",
  updated_at: null,
  hint: null,
  low_confidence_words: 3,
  low_confidence_threshold: 0.5,
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
    const prev = server.stack.pop();
    if (prev) {
      server.pending = prev.pending;
      server.head = prev.head;
    }
    return reply(0);
  }
  if (body.type === "ApproveEdits" && server.gate) {
    return {
      ok: false,
      status: 409,
      failure: new ApiError(
        "Check the transcript",
        "transcript_refine_required",
        409,
      ),
    };
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
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (url.includes("/refine/status")) return json(statusBody());
    if (url.includes("/refine/waive")) {
      order.push("waive");
      if (!server.gateSticks) server.gate = false;
      return server.waiveFails ? json({ detail: "no" }, 500) : json({});
    }
    if (url.includes("/refine/done")) {
      order.push("done");
      server.status = "clear";
      return json(statusBody());
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
const decidedCount = () =>
  screen.queryByRole("region", { name: "Decided" })?.textContent ?? "";
const toast = () => useDawStore.getState().feedbackToast?.message;

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
  Object.assign(server, {
    seq: 100 * runs,
    head: "h0",
    stack: [],
    gate: false,
    gateSticks: false,
    count: null,
    held: [],
    omitSnapshot: false,
    status: "clear",
    waiveFails: false,
    down: false,
  });
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
      edit("p", "pause", 5),
      edit("r", "repeat", 6),
      edit("k", "false-start", 7),
      edit("s", "sound", 8),
      edit("o", "other", 9),
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
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "Fillers",
      "Pauses",
      "Repeats",
      "False starts",
      "Sounds",
      "Other suggestions",
    ]);
    const fillers = within(groups[0] as HTMLElement).getAllByRole("button", {
      name: /filler/,
    });
    expect(fillers.at(-1)).toHaveTextContent("filler unplaced");
    expect(screen.queryByText("filler applied")).toBeNull();
    expect(screen.queryByText("filler quiet")).toBeNull();
    expect(screen.getByText("Jon restarts.")).toBeVisible();
  });

  it("lands on Queue first and publishes the wire tab impact", () => {
    mount();
    const tabs = within(
      screen.getByRole("tablist", { name: "Review sections" }),
    ).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.replace(" ●", ""))).toEqual([
      "Queue",
      "Comments",
      "Tighten",
    ]);
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
  });

  it("gives a guest Comments only", () => {
    useDawStore.getState().hydrate("share:abc", minimalProject());
    useDawStore.setState({ stage: "review", guestMode: "comment" });
    render(<StageHost guestShare />);
    expect(
      screen.queryByRole("tablist", { name: "Review sections" }),
    ).toBeNull();
    expect(screen.getByText("comments panel")).toBeVisible();
  });
});

describe("Review host decisions", () => {
  it("advances in the same act and sends one ApproveEdits without skip_unsure", async () => {
    wire.post.mockImplementation(() => new Promise(() => {}));
    mount();
    expect(heading()).toBe("filler f1");
    act(() => press("Enter"));
    expect(heading()).toBe("filler f2");
    await waitFor(() => expect(wire.post).toHaveBeenCalledOnce());
    expect(sent("ApproveEdits")[0].payload).toEqual({
      ids: ["f1"],
      hold_blocked: true,
    });
  });

  it("sends one POST and one toast for two Enters in one act", async () => {
    mount();
    act(() => {
      press("Enter");
      press("Enter");
    });
    await waitFor(() => expect(toast()).toBeTruthy());
    expect(sent("ApproveEdits")).toHaveLength(1);
  });

  it("Keep sends RejectEdits; Undo from the toast brings the row back selected with focus on the stage", async () => {
    mount();
    press("x");
    await screen.findByRole("button", { name: "Undo" });
    expect(sent("RejectEdits")[0].payload).toEqual({ ids: ["f1"] });
    expect(heading()).toBe("filler f2");
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(heading()).toBe("filler f1"));
    expect(sent("UndoHistory")[0].payload.expected_head_id).toBe("h1");
    expect(screen.queryByRole("region", { name: "Decided" })).toBeNull();
    expect(document.activeElement).toBe(stage());
  });

  it("returns the row when onUndone runs before the Undo snapshot lands", async () => {
    mount();
    press("x");
    await screen.findByRole("button", { name: "Undo" });
    server.omitSnapshot = true;
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(sent("UndoHistory")).toHaveLength(1));
    act(() => {
      applyDocumentSnapshot({ server_seq: ++server.seq, project: projectOf() });
    });
    await waitFor(() => expect(heading()).toBe("filler f1"));
  });

  it("returns the row on a fast Undo before any snapshot showed it leave", async () => {
    server.omitSnapshot = true;
    mount();
    press("Enter");
    await screen.findByRole("button", { name: "Undo" });
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(heading()).toBe("filler f1"));
    expect(screen.queryByRole("region", { name: "Decided" })).toBeNull();
  });

  it("Mod+Z with focus on the stage undoes the last decision, and no Review key moves the transport", async () => {
    mount();
    stage().focus();
    for (const key of ["a", "b", "ArrowDown", "ArrowUp"]) press(key);
    expect(wire.post).not.toHaveBeenCalled();
    expect(useDawStore.getState().stage).toBe("review");
    press("Enter");
    await screen.findByRole("button", { name: "Undo" });
    press("z", { ctrlKey: true });
    await waitFor(() => expect(sent("UndoHistory")).toHaveLength(1));
    await waitFor(() => expect(heading()).toBe("filler f1"));
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
    expect(
      within(
        screen.getByRole("region", { name: "Other suggestions" }),
      ).queryByRole("button", { name: /all/i }),
    ).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "Sounds" })).queryByRole(
        "button",
        { name: /all/i },
      ),
    ).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Cut all 3" }));
    await screen.findByRole("button", { name: "Undo" });
    expect(sent("ApproveEdits")).toHaveLength(1);
    expect(sent("ApproveEdits")[0].payload).toEqual({
      ids: ["f1", "f2", "f3"],
      hold_blocked: true,
      skip_unsure: true,
    });
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
  });

  it("words and routes Lower, Leave and a Shorten suggestion by the suggested action", async () => {
    mount([
      edit("sw", "sound", 10, { suggested_action: "lower" }),
      edit("sl", "sound", 20, { suggested_action: "leave" }),
      edit("sg", "other", 30, { suggested_action: "shorten" }),
    ]);
    expect(screen.getByRole("button", { name: /^Lower/ })).toBeVisible();
    press("Enter");
    await waitFor(() => expect(sent("ApplySuggestedActions")).toHaveLength(1));
    expect(sent("ApplySuggestedActions")[0].payload).toEqual({ ids: ["sw"] });
    expect(sent("ApproveEdits")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /^Keep/ })).toBeVisible();
    press("Enter");
    await waitFor(() => expect(sent("RejectEdits")).toHaveLength(1));
    expect(sent("RejectEdits")[0].payload).toEqual({ ids: ["sl"] });
    expect(screen.getByRole("button", { name: /^Shorten/ })).toBeVisible();
    press("Enter");
    await waitFor(() => expect(toast()).toMatch(/^Shorten/));
  });

  it("returns a held row blocked with its reason", async () => {
    server.held = [
      { id: "f1", label: "filler f1", reason: "A join would click" },
    ];
    mount();
    press("Enter");
    await waitFor(() => expect(toast()).toMatch(/held/));
    await waitFor(() => expect(heading()).toBe("filler f1"));
    expect(screen.getByText("A join would click")).toBeVisible();
  });

  it("refreshes after a shortfall reply and returns the row as needing a closer look", async () => {
    server.count = 0;
    mount();
    press("Enter");
    await waitFor(() => expect(wire.refresh).toHaveBeenCalled());
    await waitFor(() => expect(heading()).toBe("filler f1"));
    expect(screen.getByText("Needs a closer look in Edit")).toBeVisible();
    expect(toast()).toMatch(/held 1/);
  });

  it("keeps the row decided with no Undo when the reply is queued", async () => {
    server.down = true;
    mount();
    press("Enter");
    await waitFor(() => expect(toast()).toBe(PENDING_REVIEW_QUEUED_MESSAGE));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(decidedCount()).toMatch(/Decided\s*1/);
    await act(async () => {
      server.down = false;
      await requestHostDrain(PATH);
    });
  });

  it("shows no toast for a reply that arrives after a project switch", async () => {
    let release = (_value: unknown) => {};
    wire.post.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
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

  it("keeps Decided rows through Queue, Tighten, Queue", async () => {
    mount();
    press("Enter");
    await screen.findByRole("button", { name: "Undo" });
    await userEvent.click(screen.getByRole("tab", { name: /Tighten/ }));
    expect(screen.getByText("tighten panel")).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: /Queue/ }));
    expect(decidedCount()).toMatch(/Decided\s*1/);
  });
});

describe("Review host transcript check", () => {
  it("restores the row, brings the check back and confirms Cut anyway as waive then approve", async () => {
    server.gate = true;
    mount();
    server.status = "pending";
    press("Enter");
    await waitFor(() => expect(toast()).toMatch(/Cut again to cut anyway/));
    expect(heading()).toBe("filler f1");
    await screen.findByRole("region", { name: "Checks" });
    press("Enter");
    await userEvent.click(
      await screen.findByRole("button", { name: "Cut anyway" }),
    );
    await waitFor(() => expect(sent("ApproveEdits")).toHaveLength(2));
    expect(order).toEqual(["ApproveEdits", "waive", "ApproveEdits"]);
  });

  it("asks for Cut anyway at once while the check is open", async () => {
    server.status = "pending";
    mount();
    await screen.findByRole("region", { name: "Checks" });
    press("Enter");
    expect(
      await screen.findByRole("button", { name: "Cut anyway" }),
    ).toBeVisible();
    expect(wire.post).not.toHaveBeenCalled();
  });

  it("sends no approve when the waive fails", async () => {
    server.status = "pending";
    server.waiveFails = true;
    mount();
    await screen.findByRole("region", { name: "Checks" });
    press("Enter");
    await userEvent.click(
      await screen.findByRole("button", { name: "Cut anyway" }),
    );
    await waitFor(() => expect(toast()).toBeTruthy());
    expect(order).toEqual(["waive"]);
    expect(sent("ApproveEdits")).toHaveLength(0);
    await waitFor(() => expect(heading()).toBe("filler f1"));
  });

  it("shows the gate error when an approve is refused again after a waive", async () => {
    server.status = "pending";
    server.gate = true;
    server.gateSticks = true;
    mount();
    await screen.findByRole("region", { name: "Checks" });
    press("Enter");
    await userEvent.click(
      await screen.findByRole("button", { name: "Cut anyway" }),
    );
    await waitFor(() => expect(toast()).toBe(REFINE_GATE_GUI_MESSAGE));
    expect(order).toEqual(["waive", "ApproveEdits"]);
  });

  it("ignores a stale status response that arrives after a newer one", async () => {
    let release = (_value: Response) => {};
    fetchStub.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
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

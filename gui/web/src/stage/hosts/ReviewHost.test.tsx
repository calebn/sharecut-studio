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
import { commandLocks } from "../../test/commandLocks";
import {
  minimalProject,
  pendingEditView,
  sampleTrack,
  wavResponse,
} from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import type {
  HistoryEntryId,
  PendingEditView,
  PendingUnsureWord,
} from "../../types/project";
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

const W1: PendingUnsureWord = {
  track_id: "host",
  source_id: null,
  word_index: 4,
  text: "uncle",
  confidence: 0.4,
};
const F1 = edit("f1", "filler", 10, { why: "Jon restarts." });
const F2 = edit("f2", "filler", 20);
const F3 = edit("f3", "filler", 30);

type ServerWord = {
  text: string;
  unsure: boolean;
  at: number;
  listed: boolean;
};

const fresh = () => ({
  words: [] as ServerWord[],
  corrections: [] as number[],
  correctFails: false,
  markFails: false,
  markChanged: false,
  notes: "",
  waived: [] as string[],
  seq: 100 * runs,
  head: "h0",
  stack: [] as {
    head: string;
    pending: PendingEditView[];
    words: ServerWord[];
  }[],
  pending: [] as PendingEditView[],
  gate: false,
  gateSticks: false,
  count: null as number | null,
  held: [] as Held[],
  omitSnapshot: false,
  status: "clear" as "clear" | "pending" | "done" | "waived",
  waiveFails: false,
  down: false,
});
const server = fresh();
const order: string[] = [];
const marks: { expected_fingerprint?: string }[] = [];

const stillUnsure = (index: number) => server.words[index]?.unsure ?? true;

const transcriptOf = () =>
  server.words.length === 0
    ? null
    : {
        utterances: [
          {
            track_id: "host",
            speaker: "Jon",
            start: 0,
            end: 60,
            text: "",
            mappable: true,
            words: server.words.flatMap((w, i) =>
              w.listed
                ? [
                    {
                      text: w.text,
                      start: w.at,
                      end: w.at + 0.5,
                      timeline_start: w.at,
                      timeline_end: w.at + 0.5,
                      word_index: i,
                      unsure: w.unsure,
                    },
                  ]
                : [],
            ),
          },
        ],
      };

const projectOf = () =>
  minimalProject({
    transcript: transcriptOf(),
    tracks: [sampleTrack()],
    timeline_duration_sec: 600,
    pending_edits: server.pending.map((e) =>
      e.unsure_words
        ? {
            ...e,
            unsure_words: e.unsure_words.filter((w) =>
              stillUnsure(w.word_index),
            ),
          }
        : e,
    ),
    history: {
      ...minimalProject().history,
      head_id: server.head as HistoryEntryId,
      can_undo: server.stack.length > 0,
    },
  });

const statusBody = () => ({
  status: server.status,
  clear: server.status !== "pending",
  fingerprint: `fp:${server.words.map((w) => w.text)}`,
  notes: server.notes,
  hint: "Run the CLI refine.",
  low_confidence_words: 3,
});

function serverUndo() {
  const prev = server.stack.pop();
  if (prev) {
    server.pending = prev.pending;
    server.words = prev.words;
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
      command: {
        payload: { result: { count, held } },
      },
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
  if (body.type === "CorrectTranscriptWord" && server.correctFails)
    return {
      ok: false,
      status: 409,
      failure: new ApiError("Moved", null, 409),
    };
  server.stack.push({
    head: server.head,
    pending: server.pending,
    words: server.words,
  });
  server.head = `h${server.stack.length}`;
  if (body.type === "CorrectTranscriptWord") {
    const index = body.payload.word_index as number;
    const text = body.payload.text as string;
    server.corrections.push(index);
    if (server.status !== "pending" && text !== server.words[index].text)
      server.status = "pending";
    server.words = server.words.map((w, i) =>
      i === index ? { ...w, text, unsure: false } : w,
    );
    return reply(0);
  }
  const heldIds = new Set(server.held.map((h) => h.id));
  const done = server.count ?? ids.length - heldIds.size;
  const take = server.count === 0 ? [] : ids.filter((id) => !heldIds.has(id));
  server.pending =
    body.type === "RejectEdits"
      ? server.pending.filter((e) => !ids.includes(e.id))
      : server.pending.map((e) =>
          take.includes(e.id) ? { ...e, applied: true } : e,
        );
  server.pending = server.pending.map((e) =>
    server.held.some((h) => h.id === e.id && h.reason === "unsure_word")
      ? { ...e, unsure_words: [W1] }
      : e,
  );
  return reply(done, server.held);
}

const fetchStub = vi.fn(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status });
    if (url.includes("/refine/status")) return json(statusBody());
    if (url.includes("/refine/done")) {
      order.push("done");
      marks.push(JSON.parse(init?.body as string));
      if (marks.at(-1)?.expected_fingerprint !== statusBody().fingerprint)
        server.markChanged = true;
      if (server.markChanged)
        return new Response(JSON.stringify({ detail: "changed" }), {
          status: 409,
          headers: { "X-Sharecut-Error-Code": "transcript_changed" },
        });
      if (server.markFails) return json({ detail: "no" }, 500);
      server.status = "done";
      return json(statusBody());
    }
    if (url.includes("/refine/waive")) {
      order.push("waive");
      server.waived.push(JSON.parse(init?.body as string).reason);
      if (!server.gateSticks) server.gate = false;
      return server.waiveFails ? json({ detail: "no" }, 500) : json({});
    }
    return json({}, init ? 200 : 404);
  },
);

const holdNextPost = () => {
  let release = (_value: unknown) => {};
  wire.post.mockImplementationOnce(
    () => new Promise((resolve) => (release = resolve)),
  );
  return (value: unknown) => release(value);
};

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
  Object.assign(server, fresh());
  order.length = 0;
  marks.length = 0;
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

  it("Cut all sends one command with skip_unsure, and holds an unsure cut in plain words", async () => {
    server.held = [{ id: "f2", label: "filler f2", reason: "unsure_word" }];
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Cut all 3" }));
    await undoButton();
    expect(sent("ApproveEdits")).toHaveLength(1);
    expect(sent("ApproveEdits")[0].payload).toEqual({
      ids: ["f1", "f2", "f3"],
      hold_blocked: true,
      skip_unsure: true,
    });
    const why =
      "It has a word we're not sure of. Check the word first, then cut.";
    expect(toast()).toMatch(new RegExp(`held 1. filler f2 is held: ${why}$`));
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("tab", { name: /Tighten/ }));
    await userEvent.click(screen.getByRole("tab", { name: /Queue/ }));
    expect(decided()).toMatch(/Decided\s*2/);
    await userEvent.click(screen.getByRole("button", { name: /filler f2/ }));
    expect(screen.getByText(why)).toBeVisible();
    expect(screen.getByRole("button", { name: "Cut" })).toBeDisabled();
  });

  it("offers Cut all for real-shape harsh fillers, keeps join-risk ones out, and sends skip_unsure", async () => {
    const real = {
      review_required: true,
      harsh: true,
      listen_one_by_one: false,
      join_risk: null,
    };
    mount([
      edit("f1", "filler", 10, real),
      edit("f2", "filler", 20, real),
      edit("f3", "filler", 30, {
        ...real,
        join_risk: { verdict: "review" } as never,
      }),
    ]);
    expect(screen.getByText("1 to decide one by one")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Cut all 2" }));
    await undoButton();
    expect(sent("ApproveEdits")[0].payload).toEqual({
      ids: ["f1", "f2"],
      hold_blocked: true,
      skip_unsure: true,
    });
  });

  it("sends skip_unsure for a one-item group verb, and again through Cut anyway", async () => {
    server.status = "pending";
    mount([F1]);
    expect(
      screen.getByRole("button", { name: "Cut this one" }),
    ).toHaveTextContent(/^Cut$/);
    await userEvent.click(screen.getByRole("button", { name: "Cut this one" }));
    await userEvent.click(await cutAnyway());
    await waitFor(() => expect(sent("ApproveEdits")).toHaveLength(1));
    expect(sent("ApproveEdits")[0].payload).toEqual({
      ids: ["f1"],
      hold_blocked: true,
      skip_unsure: true,
    });
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
    const release = holdNextPost();
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
    const release = holdNextPost();
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

describe("Review host unsure words", () => {
  const word = (index: number, text: string) => ({
    track_id: "host",
    source_id: null,
    word_index: index,
    text,
    confidence: 0.4,
  });
  const cuts = () => [
    edit("f1", "filler", 10, { unsure_words: [word(1, "gnu")] }),
    edit("f2", "filler", 20, { unsure_words: [word(1, "gnu")] }),
    edit("f3", "filler", 30, {
      timeline_start: null as never,
      unsure_words: [word(2, "orc")],
    }),
  ];
  const setup = (status: typeof server.status = "pending") => {
    server.status = status;
    server.words = [
      { text: "uncle", unsure: true, at: 5, listed: true },
      { text: "gnu", unsure: true, at: 10, listed: true },
      { text: "orc", unsure: true, at: 30, listed: false },
    ];
    mount(cuts());
  };
  const rows = () =>
    within(screen.getByRole("region", { name: "Unsure words" }))
      .getAllByRole("button")
      .map((b) => b.textContent ?? "");
  const pick = (name: RegExp) =>
    userEvent.click(
      within(screen.getByRole("region", { name: "Unsure words" })).getByRole(
        "button",
        { name },
      ),
    );
  const fix = async (text: string) => {
    await userEvent.click(screen.getByRole("button", { name: "Fix text" }));
    const field = screen.getByRole("textbox", { name: "Fix text" });
    await userEvent.clear(field);
    await userEvent.type(field, text);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
  };

  it("lists each unsure word once, after Checks, in time order, with the count copy", async () => {
    setup();
    await checks();
    expect(rows()).toEqual([
      expect.stringContaining("uncle"),
      expect.stringContaining("gnu"),
      expect.stringContaining("orc"),
    ]);
    const regions = screen
      .getAllByRole("region")
      .map((r) => r.getAttribute("aria-label"));
    expect(regions.indexOf("Checks")).toBeLessThan(
      regions.indexOf("Unsure words"),
    );
    expect(
      screen.getAllByText("3 words the transcript is unsure of.").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Run the CLI refine.")).toBeNull();
  });

  it("Looks right on a non-final word sends one correction and nothing else, and Undo returns it", async () => {
    setup();
    await pick(/uncle/);
    expect(heading()).toBe("Is this “uncle”?");
    expect(screen.queryByRole("button", { name: /^Keep/ })).toBeNull();
    act(() => {
      press("Enter");
    });
    expect(heading()).toBe("Is this “gnu”?");
    await undoButton();
    expect(sent("CorrectTranscriptWord")).toHaveLength(1);
    expect(sent("CorrectTranscriptWord")[0].payload).toEqual({
      track_id: "host",
      word_index: 0,
      text: "uncle",
      expected_text: "uncle",
    });
    expect(sent("RejectEdits")).toHaveLength(0);
    expect(order).not.toContain("done");
    expect(toast()).toBe("Looks right");
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(sent("UndoHistory")).toHaveLength(1));
    await waitFor(() => expect(heading()).toBe("Is this “uncle”?"));
    expect(document.activeElement).toBe(stage());
  });

  it("marks the check after the correction that closes the last word, and puts the check back if the mark fails", async () => {
    setup();
    await pick(/uncle/);
    for (let i = 0; i < 3; i++) {
      act(() => {
        press("Enter");
      });
      await waitFor(() =>
        expect(sent("CorrectTranscriptWord")).toHaveLength(i + 1),
      );
    }
    await waitFor(() => expect(order).toContain("done"));
    expect(order.filter((t) => t !== "UndoHistory")).toEqual([
      "CorrectTranscriptWord",
      "CorrectTranscriptWord",
      "CorrectTranscriptWord",
      "done",
    ]);
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Checks" })).toBeNull(),
    );
  });

  it("closes the check with the fingerprint of the text after a Fix on the last word", async () => {
    setup();
    await pick(/uncle/);
    for (let i = 0; i < 2; i++)
      act(() => {
        press("Enter");
      });
    await waitFor(() => expect(sent("CorrectTranscriptWord")).toHaveLength(2));
    await fix("orc2");
    await waitFor(() => expect(order).toContain("done"));
    expect(marks[0].expected_fingerprint).toBe("fp:uncle,gnu,orc2");
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Checks" })).toBeNull(),
    );
  });

  it("keeps the check, with an error toast, when the closing mark fails", async () => {
    server.markFails = true;
    setup();
    await pick(/uncle/);
    for (let i = 0; i < 3; i++)
      act(() => {
        press("Enter");
      });
    await waitFor(() => expect(order).toContain("done"));
    await checks();
    expect(useDawStore.getState().feedbackToast?.tone).toBe("error");
  });

  it("sends the reviewed fingerprint and explains a changed transcript", async () => {
    server.markChanged = true;
    setup();
    await pick(/uncle/);
    for (let i = 0; i < 3; i++)
      act(() => {
        press("Enter");
      });
    await waitFor(() => expect(order).toContain("done"));
    expect(marks[0].expected_fingerprint).toBe("fp:uncle,gnu,orc");
    await waitFor(() =>
      expect(toast()).toBe(
        "The transcript changed after you reviewed it. Review it again, then mark it checked.",
      ),
    );
    await checks();
  });

  it("sends no mark when the transcript words are not all loaded", async () => {
    setup();
    const { project } = useDawStore.getState();
    useDawStore.setState({
      project: project && {
        ...project,
        meta: { ...project.meta, hydration: { transcript_words: false } },
      },
    });
    await pick(/uncle/);
    for (let i = 0; i < 3; i++)
      act(() => {
        press("Enter");
      });
    await waitFor(() => expect(sent("CorrectTranscriptWord")).toHaveLength(3));
    expect(order).not.toContain("done");
    expect(toast()).toBe(
      "Looks right. The transcript check stays open until every word has loaded.",
    );
    await checks();
  });

  it("Fix text sends the new text, then re-marks a done check and re-waives a waived one", async () => {
    server.notes = "heard it";
    setup("done");
    await pick(/uncle/);
    await fix("oncle");
    await undoButton();
    expect(sent("CorrectTranscriptWord")[0].payload).toMatchObject({
      text: "oncle",
      expected_text: "uncle",
    });
    expect(toast()).toBe("Fixed “uncle” to “oncle”");
    await waitFor(() => expect(order).toContain("done"));
    expect(marks[0].expected_fingerprint).toBe("fp:oncle,gnu,orc");
    expect(server.waived).toEqual([]);
  });

  it("says so in the toast when keeping a done check after a Fix fails", async () => {
    server.markFails = true;
    setup("done");
    await pick(/uncle/);
    await fix("oncle");
    await waitFor(() => expect(order).toContain("done"));
    await waitFor(() =>
      expect(toast()).toMatch(
        /^Fixed “uncle” to “oncle”\. The transcript check could not be kept/,
      ),
    );
  });

  it("frees the cuts that hold a word as soon as the word is confirmed from its own row", async () => {
    setup("done");
    await pick(/gnu/);
    act(() => {
      press("Enter");
    });
    await waitFor(() => expect(sent("CorrectTranscriptWord")).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: /filler f1/ }));
    expect(screen.getByRole("button", { name: "Cut" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: /filler f2/ }));
    expect(screen.getByRole("button", { name: "Cut" })).toBeEnabled();
  });

  it("re-waives a waived check with its notes", async () => {
    server.notes = "heard it";
    setup("waived");
    await pick(/gnu/);
    await fix("new");
    await waitFor(() => expect(server.waived).toEqual(["heard it"]));
    expect(order).not.toContain("done");
  });

  it("sends neither mark nor waiver after a Fix while the check is pending", async () => {
    setup();
    await pick(/gnu/);
    await fix("new");
    await undoButton();
    expect(order).toEqual(["CorrectTranscriptWord"]);
  });

  it("leaves an unsure cut out of Cut all, and Fix on its card frees the verb for a plain Cut", async () => {
    setup("done");
    expect(screen.queryByRole("button", { name: /^Cut all/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /filler f1/ }));
    expect(screen.getByRole("button", { name: "Cut" })).toBeDisabled();
    await fix("knew");
    await waitFor(() => expect(sent("CorrectTranscriptWord")).toHaveLength(1));
    expect(heading()).toBe("filler f1");
    await userEvent.click(screen.getByRole("button", { name: "Cut" }));
    await waitFor(() => expect(sent("ApproveEdits")).toHaveLength(1));
    expect(sent("ApproveEdits")[0].payload).toEqual({
      ids: ["f1"],
      hold_blocked: true,
    });
  });

  it("reverts a word and says why when the correction is refused", async () => {
    server.correctFails = true;
    setup();
    await pick(/uncle/);
    act(() => {
      press("Enter");
    });
    await waitFor(() =>
      expect(useDawStore.getState().feedbackToast?.tone).toBe("error"),
    );
    expect(heading()).toBe("Is this “uncle”?");
  });

  it("opens a word in Edit and hears it padded, or says it is off the timeline", async () => {
    setup();
    const begin = vi.fn();
    useDawStore.setState({ beginAudition: begin });
    await pick(/gnu/);
    await userEvent.click(screen.getByRole("button", { name: "Hear" }));
    expect(begin).toHaveBeenCalledWith({ playheadSec: 8, untilSec: 12.5 });
    await pick(/orc/);
    await userEvent.click(screen.getByRole("button", { name: "Hear" }));
    expect(toast()).toBe("This word is not on the timeline.");
    await pick(/gnu/);
    await userEvent.click(screen.getByRole("button", { name: /Open in Edit/ }));
    expect(useDawStore.getState().selection).toEqual({
      kind: "transcriptRange",
      trackId: "host",
      sourceId: null,
      startWordIndex: 1,
      endWordIndex: 1,
    });
    expect(useDawStore.getState().stage).toBe("edit");
  });

  it("drops a held unsure note once the cut has no unsure words", async () => {
    server.held = [{ id: "f2", label: "filler f2", reason: "unsure_word" }];
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Cut all 3" }));
    await undoButton();
    await userEvent.click(screen.getByRole("tab", { name: /Tighten/ }));
    await userEvent.click(screen.getByRole("tab", { name: /Queue/ }));
    await userEvent.click(screen.getByRole("button", { name: /filler f2/ }));
    expect(screen.getByText(/Unsure word: is this/)).toBeVisible();
    server.pending = server.pending.map((e) =>
      e.id === "f2" ? { ...e, unsure_words: [] } : e,
    );
    snapshot();
    await waitFor(() =>
      expect(
        within(document.querySelector(".rv-card") as HTMLElement).queryByText(
          /Check the word first/,
        ),
      ).toBeNull(),
    );
  });
});

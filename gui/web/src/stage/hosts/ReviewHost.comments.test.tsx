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
  rows: [] as { command_id: string }[],
}));
vi.mock("../../api/documentTransport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/documentTransport")>()),
  postHostDocumentCommand: wire.post,
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
import { useDawKeymapListener } from "../../keymap/listener";
import { useDawStore } from "../../state/dawStore";
import { commandLocks } from "../../test/commandLocks";
import {
  minimalProject,
  sampleComment,
  sampleTrack,
} from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import type { TimelineComment } from "../../types/project";
import { ApiError } from "../../utils/apiError";
import { StageHost } from "./StageHost";

let runs = 0;
let PATH = "";

const server = {
  comments: [] as TimelineComment[],
  seq: 0,
  refuse: new Set<string>(),
};

const projectOf = () =>
  minimalProject({
    tracks: [sampleTrack()],
    timeline_duration_sec: 600,
    comments: server.comments,
  });

function answer(body: { type: string; payload: Record<string, unknown> }) {
  const p = body.payload;
  if (server.refuse.has(body.type))
    return { ok: false, status: 422, failure: new ApiError("No", null, 422) };
  const id = (p.comment_id as string | undefined) ?? "";
  let result: unknown = {};
  if (body.type === "AddComment") {
    result = sampleComment({
      id: `new${server.comments.length}`,
      body: p.body as string,
      author: p.author as string,
      timeline_start: p.timeline_start as number,
      timeline_end: p.timeline_end as number | null,
    });
    server.comments = [...server.comments, result as TimelineComment];
  } else {
    server.comments = server.comments.map((c) => {
      if (c.id !== id) return c;
      const next =
        body.type === "ResolveComment"
          ? { ...c, resolved: p.resolved as boolean, resolved_by: "me" }
          : body.type === "AddReply"
            ? {
                ...c,
                replies: [
                  ...c.replies,
                  {
                    id: `r${c.replies.length}`,
                    body: p.body as string,
                    author: p.author as string,
                    created_at: "",
                  },
                ],
              }
            : {
                ...c,
                action_items: c.action_items.map((a) =>
                  a.id === p.action_id ? { ...a, done: p.done as boolean } : a,
                ),
              };
      result = next;
      return next;
    });
  }
  server.seq += 1;
  return {
    ok: true,
    data: {
      history_head_id: "h0",
      command: { payload: { result } },
      snapshot: { server_seq: server.seq, project: projectOf() },
    },
  };
}

const OPEN = sampleComment({
  id: "c1",
  author: "Rosa",
  body: "Lose the cough",
  timeline_start: 30,
  replies: [{ id: "r0", body: "On it", author: "Sam", created_at: "" }],
  action_items: [
    {
      id: "a1",
      text: "Trim the cough",
      done: false,
      completed_at: null,
      completed_by: null,
    },
  ],
});
const LATER = sampleComment({
  id: "c2",
  author: "Sam",
  body: "Re-level the intro",
  timeline_start: 90,
});
const DONE = sampleComment({
  id: "c3",
  author: "Ana",
  body: "Fixed already",
  timeline_start: 120,
  resolved: true,
  resolved_by: "Sam",
});

const sent = (type: string) =>
  wire.post.mock.calls.map(([, body]) => body).filter((b) => b.type === type);
const heading = () => screen.getByRole("heading", { level: 2 }).textContent;
const stage = () => document.querySelector(".rv-stage") as HTMLElement;
const press = (key: string) => fireEvent.keyDown(stage(), { key });
const decided = async () => {
  const region = screen.getByRole("region", { name: "Decided" });
  const toggle = within(region).getByRole("button", { name: /Decided/ });
  if (toggle.getAttribute("aria-expanded") !== "true")
    await userEvent.click(toggle);
  return screen.getByRole("region", { name: "Decided" });
};
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

const mount = (comments = [OPEN, LATER, DONE], picked?: string) => {
  server.comments = comments;
  useDawStore.getState().hydrate(PATH, projectOf());
  useDawStore.setState({
    stage: "review",
    guestMode: null,
    ...(picked ? { selection: { kind: "comment", id: picked } } : {}),
  });
  return render(<App />);
};

beforeEach(() => {
  runs += 1;
  PATH = `/tmp/review-comments/${runs}/episode.project.json`;
  vi.clearAllMocks();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: commandLocks(),
  });
  Object.assign(server, { comments: [], seq: 100 * runs });
  wire.rows = [];
  server.refuse.clear();
  wire.post.mockImplementation(async (_path: string, body) => answer(body));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 404 })),
  );
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

describe("Review host comments", () => {
  it("lists every comment as a queue item, resolved ones decided", async () => {
    mount();
    const group = screen.getByRole("region", { name: "Comments" });
    expect(within(group).getByText("Lose the cough")).toBeInTheDocument();
    expect(within(group).getByText("Re-level the intro")).toBeInTheDocument();
    expect(within(group).getByText("1 reply")).toBeInTheDocument();
    expect(within(await decided()).getByText("Resolved")).toBeInTheDocument();
    expect(heading()).toBe("Comment from Rosa");
  });

  it("shows the thread on the card and posts a reply and an action toggle", async () => {
    mount();
    const card = screen.getByRole("article");
    expect(within(card).getByText("On it")).toBeInTheDocument();
    await userEvent.click(
      within(card).getByRole("checkbox", { name: "Trim the cough" }),
    );
    await waitFor(() => expect(sent("SetActionDone")).toHaveLength(1));
    expect(sent("SetActionDone")[0].payload).toMatchObject({
      comment_id: "c1",
      action_id: "a1",
      done: true,
    });
    await userEvent.type(
      within(card).getByRole("textbox", { name: "Reply to Rosa" }),
      "Done{Enter}",
    );
    await waitFor(() => expect(sent("AddReply")).toHaveLength(1));
    expect(sent("AddReply")[0].payload).toMatchObject({
      comment_id: "c1",
      body: "Done",
    });
    expect(sent("ResolveComment")).toHaveLength(0);
    await waitFor(() =>
      expect(
        within(screen.getByRole("article")).getByText("Done"),
      ).toBeInTheDocument(),
    );
  });

  it("resolves with Enter, moves to the next comment, and Undo reopens it", async () => {
    mount();
    act(() => {
      press("Enter");
    });
    expect(heading()).toBe("Comment from Sam");
    await waitFor(() => expect(sent("ResolveComment")).toHaveLength(1));
    expect(sent("ResolveComment")[0].payload).toMatchObject({
      comment_id: "c1",
      resolved: true,
    });
    await waitFor(() => expect(toast()).toMatch(/^Resolved comment at 0:30/));
    expect(within(await decided()).getAllByText("Resolved")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(sent("ResolveComment")).toHaveLength(2));
    expect(sent("ResolveComment")[1].payload.resolved).toBe(false);
    await waitFor(() => expect(heading()).toBe("Comment from Rosa"));
    expect(server.comments.find((c) => c.id === "c1")?.resolved).toBe(false);
  });

  it("puts a comment back when the resolve is refused", async () => {
    server.refuse.add("ResolveComment");
    mount();
    act(() => {
      press("Enter");
    });
    await waitFor(() => expect(heading()).toBe("Comment from Rosa"));
    expect(toast()).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Comments" })).getByText(
        "Lose the cough",
      ),
    ).toBeInTheDocument();
  });

  it("reopens a resolved comment from its card", async () => {
    mount();
    await userEvent.click(
      within(await decided()).getByRole("button", { name: /Resolved/ }),
    );
    expect(heading()).toBe("Comment from Ana");
    await userEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(sent("ResolveComment")).toHaveLength(1));
    expect(sent("ResolveComment")[0].payload.resolved).toBe(false);
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Decided" })).toBeNull(),
    );
  });

  it("moves a comment another client resolved to Decided without moving the selection", async () => {
    mount();
    press("ArrowDown");
    expect(heading()).toBe("Comment from Sam");
    server.comments = server.comments.map((c) =>
      c.id === "c1" ? { ...c, resolved: true } : c,
    );
    act(() => {
      applyDocumentSnapshot({ server_seq: ++server.seq, project: projectOf() });
    });
    expect(heading()).toBe("Comment from Sam");
    expect(within(await decided()).getAllByText("Resolved")).toHaveLength(2);
  });

  it("keeps J, K and Enter in the reply field from moving the queue", async () => {
    mount();
    const field = screen.getByRole("textbox", { name: "Reply to Rosa" });
    await userEvent.type(field, "x jk");
    expect(heading()).toBe("Comment from Rosa");
    expect(sent("ResolveComment")).toHaveLength(0);
  });

  it("focuses the reply field on R", () => {
    mount();
    act(() => {
      press("r");
    });
    expect(
      screen.getByRole("textbox", { name: "Reply to Rosa" }),
    ).toHaveFocus();
  });

  it("selects the comment the timeline or Deliver picked", () => {
    mount([OPEN, LATER, DONE], "c2");
    expect(heading()).toBe("Comment from Sam");
  });

  it("gives a guest the Comments section and no queue comments", () => {
    server.comments = [OPEN];
    useDawStore.getState().hydrate(PATH, projectOf());
    useDawStore.setState({ stage: "review", guestMode: "comment" });
    render(<App />);
    expect(document.querySelector(".rv-stage")).toBeNull();
    expect(document.querySelector(".comments-panel")).not.toBeNull();
  });
});

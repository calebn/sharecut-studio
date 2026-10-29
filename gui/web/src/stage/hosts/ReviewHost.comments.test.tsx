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

import { openCommentDraft } from "../../commands/comments";
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

  it("sends one resolve for two Enters in the same frame", async () => {
    mount();
    act(() => {
      press("Enter");
      press("Enter");
    });
    await waitFor(() => expect(sent("ResolveComment")).toHaveLength(1));
    expect(heading()).toBe("Comment from Sam");
  });

  it("resolves the next comment on a second Enter and Undo reopens only that one", async () => {
    mount();
    act(() => {
      press("Enter");
    });
    await waitFor(() => expect(sent("ResolveComment")).toHaveLength(1));
    act(() => {
      press("Enter");
    });
    await waitFor(() => expect(sent("ResolveComment")).toHaveLength(2));
    await waitFor(() => expect(toast()).toMatch(/^Resolved comment at 1:30/));
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(sent("ResolveComment")).toHaveLength(3));
    expect(sent("ResolveComment")[2].payload).toMatchObject({
      comment_id: "c2",
      resolved: false,
    });
    expect(server.comments.find((c) => c.id === "c1")?.resolved).toBe(true);
    await userEvent.click(
      within(await decided()).getAllByRole("button", { name: /Resolved/ })[0],
    );
    expect(screen.getByRole("button", { name: "Reopen" })).toBeInTheDocument();
  });

  it("drops the optimistic resolve once a later snapshot shows it open", async () => {
    mount();
    wire.post.mockImplementationOnce(async () => ({
      ok: true,
      data: {
        history_head_id: "h0",
        command: { payload: { result: OPEN } },
        snapshot: { server_seq: ++server.seq, project: projectOf() },
      },
    }));
    act(() => {
      press("Enter");
    });
    await waitFor(() => expect(sent("ResolveComment")).toHaveLength(1));
    await waitFor(() => expect(toast()).toMatch(/^Resolved comment/));
    act(() => {
      server.comments = [...server.comments];
      applyDocumentSnapshot({ server_seq: ++server.seq, project: projectOf() });
    });
    expect(
      within(screen.getByRole("region", { name: "Comments" })).getByText(
        "Lose the cough",
      ),
    ).toBeInTheDocument();
  });

  it("leaves the selection alone when a refusal arrives after the host moved on", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mount([OPEN, LATER, { ...LATER, id: "c4", author: "Lee" }]);
    wire.post.mockImplementationOnce(async (_path: string, body) => {
      await gate;
      return answer(body);
    });
    server.refuse.add("ResolveComment");
    act(() => {
      press("Enter");
    });
    expect(heading()).toBe("Comment from Sam");
    act(() => {
      press("ArrowDown");
    });
    expect(heading()).toBe("Comment from Lee");
    release();
    await waitFor(() => expect(toast()).toBeTruthy());
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Comments" })).getByText(
          "Lose the cough",
        ),
      ).toBeInTheDocument(),
    );
    expect(heading()).toBe("Comment from Lee");
  });

  it("shows a reply error only on the thread it belongs to", async () => {
    server.refuse.add("AddReply");
    mount();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Reply to Rosa" }),
      "Hi{Enter}",
    );
    await waitFor(() => expect(sent("AddReply")).toHaveLength(1));
    await waitFor(() =>
      expect(
        within(screen.getByRole("article")).getByRole("alert"),
      ).toBeTruthy(),
    );
    act(() => {
      press("ArrowDown");
    });
    expect(heading()).toBe("Comment from Sam");
    expect(within(screen.getByRole("article")).queryByRole("alert")).toBeNull();
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

  it("ignores a stale pick of a comment that is already resolved", () => {
    mount([OPEN, LATER, DONE], "c3");
    expect(heading()).toBe("Comment from Rosa");
  });

  it("moves the queue again when the same comment is picked a second time", async () => {
    mount([OPEN, LATER, DONE], "c2");
    expect(heading()).toBe("Comment from Sam");
    act(() => {
      press("ArrowUp");
    });
    expect(heading()).toBe("Comment from Rosa");
    act(() => {
      useDawStore.getState().setSelection({ kind: "comment", id: "c2" });
    });
    expect(heading()).toBe("Comment from Sam");
  });

  const filterPressed = () =>
    screen
      .getAllByRole("button", { pressed: true })
      .map((b) => b.getAttribute("aria-label"))
      .find((l) => /^(All|Suggestions|Comments|Checks), /.test(l ?? ""));
  const pickAfter = (filter: string, id: string) => {
    mount([OPEN, LATER, DONE]);
    fireEvent.click(screen.getByRole("button", { name: filter }));
    act(() => {
      useDawStore.getState().setSelection({ kind: "comment", id });
    });
  };

  it("keeps the Comments filter when a comment is picked", () => {
    pickAfter("Comments, 2", "c2");
    expect(filterPressed()).toBe("Comments, 2");
    expect(heading()).toBe("Comment from Sam");
  });

  it("widens the Suggestions filter to All when a comment is picked", () => {
    pickAfter("Suggestions, 0", "c2");
    expect(filterPressed()).toBe("All, 2");
    expect(heading()).toBe("Comment from Sam");
  });

  it("widens the Checks filter to All when a comment is picked", () => {
    pickAfter("Checks, 0", "c2");
    expect(filterPressed()).toBe("All, 2");
  });

  it("names each Decided comment row by its visible text, author and excerpt", async () => {
    mount([
      OPEN,
      DONE,
      { ...DONE, id: "c5", author: "Lee", body: "Also fixed" },
    ]);
    const region = await decided();
    expect(
      within(region).getByRole("button", {
        name: /^Resolved \d+:\d\d, Ana, Fixed already$/,
      }),
    ).toBeInTheDocument();
    expect(
      within(region).getByRole("button", {
        name: /^Resolved \d+:\d\d, Lee, Also fixed$/,
      }),
    ).toBeInTheDocument();
  });

  const gateNext = () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    wire.post.mockImplementationOnce(async (_path: string, body) => {
      await gate;
      return answer(body);
    });
    return release;
  };

  it("sends a Reopen pressed while the same comment's Resolve is in flight", async () => {
    mount();
    const release = gateNext();
    act(() => {
      press("Enter");
    });
    await waitFor(() => expect(sent("ResolveComment")).toHaveLength(1));
    await userEvent.click(
      within(await decided()).getByRole("button", { name: /Rosa/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(sent("ResolveComment")).toHaveLength(1);
    release();
    await waitFor(() => expect(sent("ResolveComment")).toHaveLength(2));
    expect(sent("ResolveComment")[1].payload).toMatchObject({
      comment_id: "c1",
      resolved: false,
    });
    await waitFor(() =>
      expect(server.comments.find((c) => c.id === "c1")?.resolved).toBe(false),
    );
  });

  it("sends a reply on thread B while thread A is still sending", async () => {
    mount();
    const release = gateNext();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Reply to Rosa" }),
      "One{Enter}",
    );
    await waitFor(() => expect(sent("AddReply")).toHaveLength(1));
    act(() => {
      press("ArrowDown");
    });
    await userEvent.type(
      screen.getByRole("textbox", { name: "Reply to Sam" }),
      "Two{Enter}",
    );
    release();
    await waitFor(() => expect(sent("AddReply")).toHaveLength(2));
    expect(sent("AddReply")[1].payload).toMatchObject({
      comment_id: "c2",
      body: "Two",
    });
  });

  it("does not show Resolved while an Undo is still being sent", async () => {
    mount();
    act(() => {
      press("Enter");
    });
    await waitFor(() => expect(toast()).toMatch(/^Resolved comment/));
    expect(within(await decided()).getAllByText("Resolved")).toHaveLength(2);
    const release = gateNext();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(sent("ResolveComment")).toHaveLength(2));
    expect(within(await decided()).getAllByText("Resolved")).toHaveLength(1);
    release();
    await waitFor(() => expect(heading()).toBe("Comment from Rosa"));
  });

  const reopenDuringResolve = async () => {
    mount();
    const release = gateNext();
    act(() => {
      press("Enter");
    });
    await waitFor(() => expect(sent("ResolveComment")).toHaveLength(1));
    await userEvent.click(
      within(await decided()).getByRole("button", { name: /Rosa/ }),
    );
    const reopen = screen.getByRole("button", { name: "Reopen" });
    await userEvent.click(reopen);
    await userEvent.click(reopen);
    return release;
  };

  it("sends one Reopen when it is pressed twice during a slow Resolve", async () => {
    const release = await reopenDuringResolve();
    release();
    await waitFor(() => expect(sent("ResolveComment")).toHaveLength(2));
    await waitFor(() =>
      expect(server.comments.find((c) => c.id === "c1")?.resolved).toBe(false),
    );
    expect(sent("ResolveComment")).toHaveLength(2);
  });

  it("drops a Reopen when the Resolve it waited for fails", async () => {
    const release = await reopenDuringResolve();
    server.refuse.add("ResolveComment");
    release();
    await waitFor(() => expect(toast()).toBeTruthy());
    await waitFor(async () =>
      expect(within(await decided()).getAllByText("Resolved")).toHaveLength(1),
    );
    expect(sent("ResolveComment")).toHaveLength(1);
  });

  it("keeps Undo's open state when a late snapshot still shows Resolved", async () => {
    mount();
    wire.post.mockImplementationOnce(async () => ({
      ok: true,
      data: {
        history_head_id: "h0",
        command: { payload: { result: OPEN } },
        snapshot: { server_seq: ++server.seq, project: projectOf() },
      },
    }));
    act(() => {
      press("Enter");
    });
    await waitFor(() => expect(toast()).toMatch(/^Resolved comment/));
    gateNext();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(sent("ResolveComment")).toHaveLength(2));
    act(() => {
      server.comments = server.comments.map((c) =>
        c.id === "c1" ? { ...c, resolved: true } : c,
      );
      applyDocumentSnapshot({ server_seq: ++server.seq, project: projectOf() });
    });
    expect(within(await decided()).getAllByText("Resolved")).toHaveLength(1);
  });

  it("keeps the Resolved state when Undo is refused before the Resolve snapshot lands", async () => {
    mount();
    wire.post.mockImplementationOnce(async () => ({
      ok: true,
      data: {
        history_head_id: "h0",
        command: { payload: { result: OPEN } },
        snapshot: { server_seq: ++server.seq, project: projectOf() },
      },
    }));
    act(() => {
      press("Enter");
    });
    await waitFor(() => expect(toast()).toMatch(/^Resolved comment/));
    server.refuse.add("ResolveComment");
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(sent("ResolveComment")).toHaveLength(2));
    await waitFor(() => expect(toast()).toBeTruthy());
    expect(within(await decided()).getAllByText("Resolved")).toHaveLength(2);
  });

  it("puts the comment back when Undo is refused", async () => {
    mount();
    act(() => {
      press("Enter");
    });
    await waitFor(() => expect(toast()).toMatch(/^Resolved comment/));
    server.refuse.add("ResolveComment");
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(sent("ResolveComment")).toHaveLength(2));
    await waitFor(async () =>
      expect(within(await decided()).getAllByText("Resolved")).toHaveLength(2),
    );
  });

  it("shows a failed reply on its own thread after the host moved on and replied elsewhere", async () => {
    mount();
    const release = gateNext();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Reply to Rosa" }),
      "One{Enter}",
    );
    await waitFor(() => expect(sent("AddReply")).toHaveLength(1));
    act(() => {
      press("ArrowDown");
    });
    await userEvent.type(
      screen.getByRole("textbox", { name: "Reply to Sam" }),
      "Two{Enter}",
    );
    server.refuse.add("AddReply");
    release();
    await waitFor(() => expect(sent("AddReply")).toHaveLength(2));
    act(() => {
      press("ArrowUp");
    });
    expect(heading()).toBe("Comment from Rosa");
    await waitFor(() =>
      expect(
        within(screen.getByRole("article")).getByRole("alert"),
      ).toBeTruthy(),
    );
  });

  it("shows the posting state while a reply is sent and clears it after", async () => {
    mount();
    const release = gateNext();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Reply to Rosa" }),
      "One{Enter}",
    );
    await waitFor(() => expect(sent("AddReply")).toHaveLength(1));
    expect(screen.getByRole("button", { name: /Posting/ })).toBeTruthy();
    release();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Posting/ })).toBeNull(),
    );
  });

  describe("composer", () => {
    const field = () => screen.getByRole("textbox", { name: "Comment" });

    it("opens on C at the playhead with focus and posts on Enter under the saved name", async () => {
      mount();
      useDawStore.setState({ playheadSec: 12 });
      expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();
      act(() => {
        press("c");
      });
      await waitFor(() => expect(field()).toHaveFocus());
      expect(screen.getByText("0:12")).toBeVisible();
      await userEvent.type(field(), "Too loud jk{Enter}");
      await waitFor(() => expect(sent("AddComment")).toHaveLength(1));
      expect(sent("AddComment")[0].payload).toMatchObject({
        body: "Too loud jk",
        author: "Host",
        timeline_start: 12,
      });
      await waitFor(() =>
        expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull(),
      );
      expect(useDawStore.getState().commentDraft).toBeNull();
      expect(heading()).toBe("Comment from Rosa");
    });

    it("posts under a changed name", async () => {
      mount();
      act(() => {
        press("c");
      });
      const who = screen.getByRole("textbox", { name: "Your name" });
      await userEvent.clear(who);
      await userEvent.type(who, "Dana");
      await userEvent.type(field(), "Hi{Enter}");
      await waitFor(() => expect(sent("AddComment")).toHaveLength(1));
      expect(sent("AddComment")[0].payload).toMatchObject({ author: "Dana" });
    });

    it("lands on the composer when Edit opens a draft", async () => {
      mount();
      act(() => {
        useDawStore.setState({ stage: "edit" });
        openCommentDraft({ startSec: 42, endSec: 47 });
      });
      expect(useDawStore.getState().stage).toBe("review");
      await waitFor(() => expect(field()).toHaveFocus());
      expect(screen.getByText("0:42 to 0:47")).toBeVisible();
    });

    it("closes on Escape and drops the draft", async () => {
      mount();
      act(() => {
        press("c");
      });
      await userEvent.type(field(), "never mind{Escape}");
      expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();
      expect(useDawStore.getState().commentDraft).toBeNull();
      expect(sent("AddComment")).toHaveLength(0);
    });

    it("stays open with the text when the post is refused", async () => {
      server.refuse.add("AddComment");
      mount();
      act(() => {
        press("c");
      });
      await userEvent.type(field(), "Keep me{Enter}");
      await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
      expect(field()).toHaveValue("Keep me");
      expect(useDawStore.getState().commentDraft).not.toBeNull();
    });
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

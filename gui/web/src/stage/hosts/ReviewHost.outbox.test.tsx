import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import {
  appendOutbox,
  loadOutbox,
  type OutboxRow,
  removeOutbox,
  returnOutboxRow,
  setOutboxSending,
  waitingSlot,
} from "../../services/offlineQueue/outboxStore";
import { useDawStore } from "../../state/dawStore";
import { composing, noComposer } from "../../test/composerStore";
import { stubIndexedDb } from "../../test/fakeIndexedDb";
import {
  minimalProject,
  sampleComment,
  sampleTrack,
} from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import { ReviewHost } from "./ReviewHost";

const createComment = vi.fn();
const addCommentReply = vi.fn();
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  createComment: (...args: unknown[]) => createComment(...args),
  addCommentReply: (...args: unknown[]) => addCommentReply(...args),
}));

const KEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const rows = new Map<string, unknown>();

const keptComment = (over: Partial<OutboxRow> = {}): OutboxRow => ({
  id: KEY,
  kind: "comment",
  body: "Waiting words",
  author: "Ana",
  created_at: 5,
  anchor: {
    timeline_start: 30,
    timeline_end: null,
    timeline_spans: null,
    track_ids: [],
    edit_decision_id: null,
  },
  ...over,
});

function join(comments = [sampleComment({ id: "c1", body: "Host note" })]) {
  useDawStore.getState().hydrate(
    "share:tok",
    minimalProject({
      comments,
      timeline_duration_sec: 600,
      tracks: [sampleTrack()],
    }),
    "comment",
    ["view", "comment", "reply"],
  );
  useDawStore.setState({
    stage: "review",
    playheadSec: 30,
    selection: null,
    ...noComposer,
  });
}

const field = () => screen.getByRole("textbox", { name: "Comment" });
const toast = () => useDawStore.getState().feedbackToast?.message;

beforeEach(() => {
  rows.clear();
  localStorage.clear();
  stubIndexedDb(rows);
  stubViewportShell("desktop");
  createComment.mockReset();
  addCommentReply.mockReset();
  registerDawCommands();
});
afterEach(() => {
  setOutboxSending("tok", KEY, false);
  clearRegisteredCommands();
  vi.unstubAllGlobals();
});

describe("a comment kept for the host", () => {
  it("clears the field, says when it sends, and waits in the list", async () => {
    const user = userEvent.setup();
    join();
    createComment.mockImplementation(async (_path, opts) => {
      await appendOutbox(
        "tok",
        keptComment({ body: opts.body, id: opts.postKey }),
      );
      return { kept: true, id: opts.postKey };
    });
    render(<ReviewHost guestShare />);
    await user.type(field(), "Waiting words");
    await user.click(screen.getByRole("button", { name: "Post" }));
    await waitFor(() => expect(createComment).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(field()).toHaveValue(""));
    expect(toast()).toBe("Comment kept. It sends when you can reach the host.");
    expect(await screen.findAllByText("Waiting to send")).not.toHaveLength(0);
    expect(screen.getAllByText("Waiting words").length).toBeGreaterThan(0);
    expect(screen.getByText("1 comment waiting to send")).toBeVisible();
  });

  it("shows a comment already kept when the page opens", async () => {
    join();
    await appendOutbox("tok", keptComment());
    render(<ReviewHost guestShare />);
    expect(await screen.findAllByText("Waiting words")).not.toHaveLength(0);
    await userEvent.click(screen.getAllByText("Waiting words")[0]);
    expect(
      await screen.findByRole("button", { name: "Don't send: comment by Ana" }),
    ).toBeEnabled();
    expect(screen.getAllByText("Waiting to send")).not.toHaveLength(0);
  });

  it("is the same card, still on screen, when the host takes it", async () => {
    join();
    await appendOutbox("tok", keptComment());
    render(<ReviewHost guestShare />);
    await userEvent.click((await screen.findAllByText("Waiting words"))[0]);
    const card = (
      await screen.findByRole("button", { name: "Don't send: comment by Ana" })
    ).closest(".sys-comment");
    expect(card).not.toBeNull();
    act(() => {
      useDawStore.setState((s) => ({
        project: s.project && {
          ...s.project,
          comments: [
            ...s.project.comments,
            sampleComment({
              id: `g-share1-${KEY}`,
              body: "Waiting words",
              author: "Ana",
              timeline_start: 30,
            }),
          ],
        },
      }));
    });
    await removeOutbox("tok", KEY);
    await waitFor(() =>
      expect(screen.queryByText("Waiting to send")).toBeNull(),
    );
    expect(screen.getAllByText("Waiting words")).not.toHaveLength(0);
    expect(card?.isConnected).toBe(true);
    expect(document.querySelectorAll(".sys-comment")).toHaveLength(1);
  });

  it("says Sending… while it is on its way and cannot be called back", async () => {
    join();
    await appendOutbox("tok", keptComment());
    render(<ReviewHost guestShare />);
    await userEvent.click((await screen.findAllByText("Waiting words"))[0]);
    await screen.findByRole("button", { name: "Don't send: comment by Ana" });
    act(() => setOutboxSending("tok", KEY, true));
    expect(await screen.findAllByText("Sending…")).not.toHaveLength(0);
    expect(
      screen.getByRole("button", { name: "Don't send: comment by Ana" }),
    ).toBeDisabled();
  });

  it("is called back with Don't send, and Undo puts it back where it was", async () => {
    const user = userEvent.setup();
    join();
    await appendOutbox("tok", keptComment());
    render(<ReviewHost guestShare />);
    await user.click((await screen.findAllByText("Waiting words"))[0]);
    await user.click(
      await screen.findByRole("button", { name: "Don't send: comment by Ana" }),
    );
    await waitFor(() => expect(screen.queryByText("Waiting words")).toBeNull());
    expect(await loadOutbox("tok")).toEqual([]);
    expect(toast()).toBe("Comment not sent");
    const undo = useDawStore.getState().feedbackToast?.reverse;
    expect(undo?.done).toBe("Comment put back");
    await act(async () => {
      await undo?.run();
    });
    expect((await loadOutbox("tok")).map((r) => r.id)).toEqual([KEY]);
    expect(
      (await screen.findAllByText("Waiting words")).length,
    ).toBeGreaterThan(0);
  });

  it("keeps a reply under its comment with the same words", async () => {
    join();
    await appendOutbox(
      "tok",
      keptComment({
        kind: "reply",
        anchor: undefined,
        parent_comment_id: "c1",
        body: "Waiting reply",
      }),
    );
    render(<ReviewHost guestShare />);
    await userEvent.click((await screen.findAllByText("Host note"))[0]);
    const replies = await screen.findByRole("list", { name: "1 reply" });
    expect(within(replies).getByText("Waiting reply")).toBeVisible();
    expect(within(replies).getByText("Waiting to send")).toBeVisible();
    expect(
      within(replies).getByRole("button", { name: "Don't send: reply by Ana" }),
    ).toBeEnabled();
  });

  it("has a waiting slot that matches the id the server will give it", () => {
    expect(waitingSlot(KEY)).toBe(`g-${KEY}`);
  });
});

describe("Needs attention for kept and refused comments", () => {
  it("counts what waits, and hands back what the host refused with Copy, Dismiss and Put it back", async () => {
    const user = userEvent.setup();
    join();
    await appendOutbox(
      "tok",
      keptComment({ id: "a".repeat(32), body: "Still waiting" }),
    );
    await appendOutbox(
      "tok",
      keptComment({ id: "b".repeat(32), body: "Refused words" }),
    );
    await returnOutboxRow(
      "tok",
      "b".repeat(32),
      "This link no longer allows comments.",
      403,
    );
    render(<ReviewHost guestShare />);
    const group = await screen.findByRole("group", { name: /Needs attention/ });
    expect(group).toHaveAccessibleName(
      "Needs attention. 1 waiting to send, 1 not posted",
    );
    expect(within(group).getByText("1 comment waiting to send")).toBeVisible();
    expect(
      within(group).getByText("Your comment at 0:30 was not posted"),
    ).toBeVisible();
    expect(
      within(group).getByText("This link no longer allows comments."),
    ).toBeVisible();
    expect(within(group).getByText("Refused words")).toBeVisible();
    await user.click(
      within(group).getByRole("button", {
        name: "Put it back in the comment field: your comment at 0:30",
      }),
    );
    expect(field()).toHaveValue("Refused words");
    await waitFor(() =>
      expect(within(group).queryByText("Refused words")).toBeNull(),
    );
  });

  it("does not offer Put it back while the field holds words of its own", async () => {
    join();
    useDawStore.setState({ ...composing({ startSec: 7, endSec: null }) });
    await appendOutbox("tok", keptComment());
    await returnOutboxRow("tok", KEY, "No.", 403);
    render(<ReviewHost guestShare />);
    await userEvent.type(field(), "mine");
    const group = await screen.findByRole("group", { name: /Needs attention/ });
    expect(within(group).getByRole("button", { name: /^Copy/ })).toBeVisible();
    expect(within(group).queryByRole("button", { name: /Put/ })).toBeNull();
  });

  it("drops a refused comment only when the guest dismisses it", async () => {
    join();
    await appendOutbox("tok", keptComment());
    await returnOutboxRow("tok", KEY, "No.", 403);
    render(<ReviewHost guestShare />);
    const group = await screen.findByRole("group", { name: /Needs attention/ });
    await userEvent.click(
      within(group).getByRole("button", {
        name: "Dismiss your comment at 0:30",
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("group", { name: /Needs attention/ }),
      ).toBeNull(),
    );
  });
});

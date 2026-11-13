import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { executePointerCommand } from "../../commands/pointer";
import { registerDawCommands } from "../../commands/register";
import { resolveCommentAnchor } from "../../comments/commentAnchor";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { composing, noComposer } from "../../test/composerStore";
import {
  minimalProject,
  pendingEditView,
  sampleComment,
  sampleTrack,
  sessionSuggestionView,
} from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import { PlayerBar } from "../frame/PlayerBar";
import { ReviewHost } from "./ReviewHost";

const postGuest = vi.hoisted(() => vi.fn());
vi.mock("../../api/documentTransport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/documentTransport")>()),
  postGuestDocumentCommand: postGuest,
}));

const createComment = vi.fn();
const addCommentReply = vi.fn();

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  createComment: (...args: unknown[]) => createComment(...args),
  addCommentReply: (...args: unknown[]) => addCommentReply(...args),
}));

const PENDING_LABEL = "Trim the long pause";
const NAME_KEY = "podcast-mcp-guest-comment-name";

const CAPS = {
  view: ["view"],
  comment: ["view", "comment"],
  edit: ["view", "comment", "edit"],
};

function join(
  mode: "view" | "comment" | "edit",
  comments = [sampleComment()],
  pending = [pendingEditView({ label: PENDING_LABEL })],
) {
  useDawStore.getState().hydrate(
    "share:tok",
    minimalProject({
      comments,
      pending_edits: pending,
      timeline_duration_sec: 600,
    }),
    mode,
    CAPS[mode],
  );
  useDawStore.setState({
    stage: "review",
    playheadSec: 0,
    selection: null,
    ...noComposer,
  });
}

const field = () => screen.getByRole("textbox", { name: "Comment" });
const post = () => screen.getByRole("button", { name: "Post" });
const name = () => screen.getByRole("textbox", { name: "Your name" });

describe("Review queue for a guest", () => {
  beforeEach(() => {
    localStorage.clear();
    stubViewportShell("desktop");
    postGuest.mockReset().mockResolvedValue({ ok: true, data: {} });
    createComment.mockReset().mockResolvedValue(sampleComment({ id: "new" }));
    addCommentReply.mockReset().mockResolvedValue({});
  });
  afterEach(() => vi.restoreAllMocks());

  it("gives a viewer the comments and no field, reply, Resolve or decision", () => {
    join("view", [sampleComment({ body: "Cut the intro" })]);
    render(<ReviewHost guestShare />);
    expect(screen.getAllByText("Cut the intro")[0]).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Comment$/ })).toBeNull();
    for (const label of [/Resolve/, /^Cut/, /^Keep/, /Find more/, /Deliver/])
      expect(screen.queryByRole("button", { name: label })).toBeNull();
  });

  it("says so when a guest has no comments, not that there is nothing to decide", () => {
    join("view", []);
    render(<ReviewHost guestShare />);
    expect(screen.getAllByText("No comments yet").length).toBeGreaterThan(0);
    expect(screen.queryByText("Nothing to decide")).toBeNull();
  });

  it.each(["view", "comment"] as const)(
    "keeps the host's suggested cuts out of a %s guest's queue",
    (mode) => {
      join(mode);
      render(<ReviewHost guestShare />);
      expect(screen.queryByText(PENDING_LABEL)).toBeNull();
      expect(
        [...document.querySelectorAll(".rv-group")].map((g) =>
          g.getAttribute("aria-label"),
        ),
      ).toEqual(["In time order"]);
      expect(screen.getByText(/^1 comment$/)).toBeVisible();
      expect(screen.queryByText(/saves/)).toBeNull();
      expect(screen.queryByRole("button", { name: /^Suggestions/ })).toBeNull();
    },
  );

  it.each(["view", "comment", "edit"] as const)(
    "never lists a staged record session for a %s guest, even if the payload carried one",
    (mode) => {
      join(mode);
      useDawStore.setState((s) => ({
        project: s.project && {
          ...s.project,
          session_suggestions: [
            sessionSuggestionView(),
            sessionSuggestionView({
              id: "ss-r",
              kind: "replace",
              from_sec: 300,
              to_sec: 360,
              take_count: 3,
              take_indexes: [0, 1, 2],
            }),
          ],
        },
      }));
      render(<ReviewHost guestShare />);
      expect(screen.queryByText(/Insert Session/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Next take" })).toBeNull();
      expect(
        [...document.querySelectorAll(".rv-group")].map((g) =>
          g.getAttribute("aria-label"),
        ),
      ).not.toContain("Pickups");
    },
  );

  it("gives an Editor the suggested cuts to Cut or Keep, without Find more, Deliver or Resolve", () => {
    join("edit", []);
    render(<ReviewHost guestShare />);
    expect(screen.getAllByText(PENDING_LABEL).length).toBeGreaterThan(0);
    expect(screen.getByText(/of 1 decided/)).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: /^Cut/ }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", { name: /^Keep/ }).length,
    ).toBeGreaterThan(0);
    for (const label of [/Find more/, /Deliver/, /Fix/, /Looks right/])
      expect(screen.queryByRole("button", { name: label })).toBeNull();
  });

  it("holds an unsure-flagged cut for an Editor with no unsure-word row, Fix or enabled Cut", () => {
    join(
      "edit",
      [],
      [
        pendingEditView({
          label: PENDING_LABEL,
          unsure_words: [
            {
              track_id: "mira-voice",
              source_id: null,
              word_index: 3,
              text: "maybe",
              confidence: 0.4,
            },
          ],
        }),
      ],
    );
    render(<ReviewHost guestShare />);
    expect(
      [...document.querySelectorAll(".rv-group")].map((g) =>
        g.getAttribute("aria-label"),
      ),
    ).not.toContain("Unsure words");
    expect(
      screen.getByText("The host checks the unsure word first."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Cut" })).toBeDisabled();
    expect(screen.queryByText(/to decide one by one/)).toBeNull();
    for (const label of [/Fix/, /Looks right/])
      expect(screen.queryByRole("button", { name: label })).toBeNull();
  });

  it("gives an Editor link whose capabilities have not arrived comments only, with no suggested cuts", () => {
    useDawStore.getState().hydrate(
      "share:tok",
      minimalProject({
        comments: [sampleComment({ body: "Cut the intro" })],
        pending_edits: [pendingEditView({ label: PENDING_LABEL })],
        timeline_duration_sec: 600,
      }),
      "edit",
      null,
    );
    useDawStore.setState({ stage: "review", ...noComposer });
    render(<ReviewHost guestShare />);
    expect(screen.queryByText(PENDING_LABEL)).toBeNull();
    expect(
      [...document.querySelectorAll(".rv-group")].map((g) =>
        g.getAttribute("aria-label"),
      ),
    ).toEqual(["In time order"]);
    for (const label of [/^Cut/, /^Keep/, /Find more/])
      expect(screen.queryByRole("button", { name: label })).toBeNull();
  });

  it("sends an Editor's Cut as ApproveEdits", async () => {
    const user = userEvent.setup();
    join("edit", []);
    render(<ReviewHost guestShare />);
    await user.click(screen.getAllByRole("button", { name: /^Cut/ })[0]);
    await waitFor(() =>
      expect(postGuest).toHaveBeenCalledWith(
        "tok",
        expect.objectContaining({ type: "ApproveEdits" }),
      ),
    );
  });

  it("shows the same pending edit to the host, so the guest test can tell", () => {
    useDawStore.getState().hydrate(
      "/tmp/host/episode.sharecut",
      minimalProject({
        pending_edits: [pendingEditView({ label: PENDING_LABEL })],
      }),
    );
    useDawStore.setState({ stage: "review", guestMode: null });
    render(<ReviewHost />);
    expect(screen.getAllByText(PENDING_LABEL).length).toBeGreaterThan(0);
  });

  it("gives a commenter the field and no Resolve or decision", () => {
    join("comment");
    render(<ReviewHost guestShare />);
    expect(field()).toBeVisible();
    for (const label of [/Resolve/, /^Cut/, /^Keep/, /Find more/])
      expect(screen.queryByRole("button", { name: label })).toBeNull();
  });

  it("offers a commenter no action items and posts none", async () => {
    join("comment");
    render(<ReviewHost guestShare />);
    expect(
      screen.queryByRole("button", { name: "Add action item" }),
    ).toBeNull();
    await userEvent.type(field(), "Lovely{Enter}");
    await waitFor(() => expect(createComment).toHaveBeenCalledTimes(1));
    expect(createComment.mock.calls[0][1]).toMatchObject({ actionTexts: [] });
  });

  it("pins the guest's chip on typing and lets it follow again when the field is emptied", async () => {
    const user = userEvent.setup();
    join("comment");
    render(<ReviewHost guestShare />);
    await user.type(field(), "ab");
    expect(useDawStore.getState().commentDraft).not.toBeNull();
    await user.type(field(), "{Backspace}");
    expect(useDawStore.getState().commentDraft).not.toBeNull();
    await user.type(field(), "{Backspace}");
    expect(useDawStore.getState().commentDraft).toBeNull();
    expect(field()).toBeVisible();
  });

  it("keeps a draft that was set before typing when the field is emptied", async () => {
    const user = userEvent.setup();
    join("comment");
    useDawStore.setState({ ...composing({ startSec: 7, endSec: null }) });
    render(<ReviewHost guestShare />);
    await user.type(field(), "a{Backspace}");
    expect(useDawStore.getState().commentDraft).toEqual({
      startSec: 7,
      endSec: null,
    });
  });

  it("keeps a time set by C or a range when it replaced the typed draft", async () => {
    const user = userEvent.setup();
    join("comment");
    render(<ReviewHost guestShare />);
    await user.type(field(), "ab");
    const replacement = { startSec: 9, endSec: null };
    act(() => useDawStore.setState({ ...composing(replacement) }));
    await user.type(field(), "c");
    await user.clear(field());
    expect(useDawStore.getState().commentDraft).toBe(replacement);
  });

  it("treats whitespace as text, so it does not return the time to follow", async () => {
    const user = userEvent.setup();
    join("comment");
    render(<ReviewHost guestShare />);
    await user.type(field(), "a");
    const typed = useDawStore.getState().commentDraft;
    fireEvent.change(field(), { target: { value: "  " } });
    expect(useDawStore.getState().commentDraft).toBe(typed);
  });

  it("returns to the selected range, not the playhead, when a range was selected", async () => {
    const user = userEvent.setup();
    join("comment");
    useDawStore.setState({
      selection: {
        kind: "range",
        target: {
          kind: "exact_range",
          intervals: [{ start: 3, end: 5 }],
          track_ids: ["host"],
          clips: [],
          media_seals: {},
        },
      },
    });
    render(<ReviewHost guestShare />);
    await user.type(field(), "a");
    expect(useDawStore.getState().commentDraft).toMatchObject({
      startSec: 3,
      endSec: 5,
    });
    await user.clear(field());
    const s = useDawStore.getState();
    expect(s.commentDraft).toBeNull();
    expect(resolveCommentAnchor(s)).toMatchObject({
      source: "selection",
      draft: { startSec: 3, endSec: 5 },
    });
  });

  it("does not unpin on the empty value an IME composition passes through", () => {
    join("comment");
    render(<ReviewHost guestShare />);
    fireEvent.change(field(), { target: { value: "a" } });
    const typed = useDawStore.getState().commentDraft;
    expect(typed).not.toBeNull();
    fireEvent.input(field(), {
      target: { value: "" },
      isComposing: true,
    });
    expect(useDawStore.getState().commentDraft).toBe(typed);
    fireEvent.change(field(), { target: { value: "b" } });
    fireEvent.change(field(), { target: { value: "" } });
    expect(useDawStore.getState().commentDraft).toBeNull();
  });

  it("unpins when a composition is cancelled and leaves the field empty", () => {
    join("comment");
    render(<ReviewHost guestShare />);
    fireEvent.change(field(), { target: { value: "a" } });
    fireEvent.compositionStart(field());
    fireEvent.input(field(), { target: { value: "" }, isComposing: true });
    expect(useDawStore.getState().commentDraft).not.toBeNull();
    fireEvent.compositionEnd(field());
    expect(useDawStore.getState().commentDraft).toBeNull();
  });

  it("keeps the pin through a whole composition that ends with text", () => {
    join("comment");
    render(<ReviewHost guestShare />);
    fireEvent.change(field(), { target: { value: "a" } });
    const typed = useDawStore.getState().commentDraft;
    fireEvent.compositionStart(field());
    fireEvent.input(field(), { target: { value: "" }, isComposing: true });
    fireEvent.input(field(), { target: { value: "に" }, isComposing: true });
    fireEvent.compositionEnd(field());
    expect(useDawStore.getState().commentDraft).toBe(typed);
  });

  it("restores the originally typed time when undo brings the text back after emptying", () => {
    join("comment");
    useDawStore.setState({ playheadSec: 12 });
    render(<ReviewHost guestShare />);
    fireEvent.change(field(), { target: { value: "Lose the cough" } });
    const typed = useDawStore.getState().commentDraft;
    expect(typed?.startSec).toBe(12);
    fireEvent.change(field(), { target: { value: "" } });
    expect(useDawStore.getState().commentDraft).toBeNull();
    act(() => useDawStore.setState({ playheadSec: 90 }));
    fireEvent.input(field(), {
      target: { value: "Lose the cough" },
      inputType: "historyUndo",
    });
    expect(useDawStore.getState().commentDraft).toBe(typed);
  });

  it("does not restore the dropped pin on redo", () => {
    join("comment");
    useDawStore.setState({ playheadSec: 12 });
    render(<ReviewHost guestShare />);
    fireEvent.change(field(), { target: { value: "a" } });
    fireEvent.change(field(), { target: { value: "" } });
    act(() => useDawStore.setState({ playheadSec: 90 }));
    fireEvent.input(field(), {
      target: { value: "a" },
      inputType: "historyRedo",
    });
    expect(useDawStore.getState().commentDraft?.startSec).toBe(90);
  });

  it("does not bring a stale time back after any other path set and cleared a draft", () => {
    join("comment");
    useDawStore.setState({ playheadSec: 12 });
    render(<ReviewHost guestShare />);
    fireEvent.change(field(), { target: { value: "a" } });
    fireEvent.change(field(), { target: { value: "" } });
    act(() =>
      useDawStore.setState({ ...composing({ startSec: 40, endSec: null }) }),
    );
    act(() => useDawStore.setState({ ...noComposer, playheadSec: 90 }));
    fireEvent.input(field(), {
      target: { value: "a" },
      inputType: "historyUndo",
    });
    expect(useDawStore.getState().commentDraft?.startSec).toBe(90);
  });

  it("does not bring a stale time back by undo after C set a new draft", () => {
    join("comment");
    useDawStore.setState({ playheadSec: 12 });
    const { container } = render(<ReviewHost guestShare />);
    fireEvent.change(field(), { target: { value: "a" } });
    fireEvent.change(field(), { target: { value: "" } });
    act(() => useDawStore.setState({ playheadSec: 90 }));
    const stage = container.querySelector(".rv-stage") as HTMLElement;
    fireEvent.keyDown(stage, { key: "c" });
    expect(useDawStore.getState().commentDraft?.startSec).toBe(90);
    act(() => useDawStore.setState({ ...noComposer }));
    act(() => useDawStore.setState({ playheadSec: 200 }));
    fireEvent.input(field(), {
      target: { value: "a" },
      inputType: "historyUndo",
    });
    expect(useDawStore.getState().commentDraft?.startSec).toBe(200);
  });

  it("pins at the current playhead when new text, not undo, follows emptying", () => {
    join("comment");
    useDawStore.setState({ playheadSec: 12 });
    render(<ReviewHost guestShare />);
    fireEvent.change(field(), { target: { value: "a" } });
    fireEvent.change(field(), { target: { value: "" } });
    act(() => useDawStore.setState({ playheadSec: 90 }));
    fireEvent.change(field(), { target: { value: "b" } });
    expect(useDawStore.getState().commentDraft?.startSec).toBe(90);
  });

  it("posts a blank name as Guest and keeps no saved name", async () => {
    const user = userEvent.setup();
    join("comment");
    render(<ReviewHost guestShare />);
    await user.type(field(), "Hello");
    await user.click(post());
    expect(createComment).toHaveBeenCalledWith(
      "share:tok",
      expect.objectContaining({ body: "Hello", author: "Guest" }),
    );
    expect(localStorage.getItem(NAME_KEY)).toBeNull();
  });

  it("posts under a saved name after Change name blanks it, and folds back", async () => {
    const user = userEvent.setup();
    localStorage.setItem(NAME_KEY, "Maya");
    join("comment");
    render(<ReviewHost guestShare />);
    expect(screen.queryByRole("textbox", { name: "Your name" })).toBeNull();
    expect(screen.getByText("Maya")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Change name/ }));
    await user.clear(name());
    await user.type(field(), "Hello");
    await user.click(post());
    expect(createComment).toHaveBeenCalledWith(
      "share:tok",
      expect.objectContaining({ body: "Hello", author: "Maya" }),
    );
    expect(await screen.findByText("Maya")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Your name" })).toBeNull();
  });

  it("leaves a blank name blank after a failed post, and never saves it", async () => {
    const user = userEvent.setup();
    createComment.mockRejectedValueOnce(new Error("Server said no"));
    join("comment");
    render(<ReviewHost guestShare />);
    await user.type(field(), "Try");
    await user.click(post());
    await screen.findByRole("alert");
    expect(name()).toHaveValue("");
    await user.click(post());
    await waitFor(() => expect(createComment).toHaveBeenCalledTimes(2));
    expect(name()).toHaveValue("");
    expect(localStorage.getItem(NAME_KEY)).toBeNull();
  });

  it("posts under the typed name and keeps it for the next comment", async () => {
    const user = userEvent.setup();
    join("comment");
    render(<ReviewHost guestShare />);
    await user.type(name(), "Dana");
    await user.type(field(), "One");
    await user.click(post());
    await user.type(field(), "Two");
    await user.click(post());
    for (const call of [1, 2])
      expect(createComment).toHaveBeenNthCalledWith(
        call,
        "share:tok",
        expect.objectContaining({ author: "Dana" }),
      );
    expect(localStorage.getItem(NAME_KEY)).toBe("Dana");
  });

  it("keeps the text and shows the reason when the post fails", async () => {
    const user = userEvent.setup();
    createComment.mockRejectedValueOnce(new Error("Server said no"));
    join("comment");
    render(<ReviewHost guestShare />);
    await user.type(field(), "Try");
    await user.click(post());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Server said no",
    );
    expect(field()).toHaveValue("Try");
  });

  it("follows the playhead until typing, then pins where typing began", async () => {
    const user = userEvent.setup();
    join("comment");
    render(<ReviewHost guestShare />);
    act(() => useDawStore.setState({ playheadSec: 65 }));
    expect(screen.getByText("1:05")).toBeVisible();
    await user.type(field(), "x");
    act(() => useDawStore.setState({ playheadSec: 130 }));
    expect(screen.getByText("1:05")).toBeVisible();
    await user.click(post());
    expect(createComment).toHaveBeenCalledWith(
      "share:tok",
      expect.objectContaining({ timelineStart: 65 }),
    );
  });

  it("replies as Guest with no extra prompt", async () => {
    const user = userEvent.setup();
    join("comment", [sampleComment({ id: "c1" })]);
    render(<ReviewHost guestShare />);
    await user.type(screen.getByRole("textbox", { name: /^Reply/ }), "thanks");
    await user.click(screen.getByRole("button", { name: /^Reply/ }));
    expect(addCommentReply).toHaveBeenCalledWith("share:tok", "c1", {
      body: "thanks",
      author: "Guest",
    });
  });

  describe("comment field placement", () => {
    beforeEach(() => {
      clearRegisteredCommands();
      registerDawCommands();
    });
    afterEach(() => {
      useDawStore.setState({ shellBreakpoint: "desktop" });
      vi.unstubAllGlobals();
    });

    const above = () => {
      const compose = document.querySelector(".rv-compose") as Element;
      const card = document.querySelector(
        ".rv-card > :not(.rv-compose):not(.sys-player)",
      );
      return !!(
        card &&
        compose.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING
      );
    };

    it("names the foot strip apart from the Player's Episode overview", () => {
      stubViewportShell("phone");
      useDawStore.setState({ shellBreakpoint: "phone" });
      join("edit");
      render(<ReviewHost guestShare />);
      expect(
        screen.getByRole("slider", { name: "Episode overview, queue markers" }),
      ).toBeVisible();
      expect(
        screen.queryByRole("slider", { name: "Episode overview" }),
      ).toBeNull();
    });

    it("phone Editor: no field is docked; the bar's Comment, visible without a menu, opens it above the card", async () => {
      stubViewportShell("phone");
      useDawStore.setState({ shellBreakpoint: "phone" });
      join("edit");
      render(
        <>
          <ReviewHost guestShare />
          <PlayerBar placement="bar" />
        </>,
      );
      expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: /^Comment/ }));
      expect(field()).toBeVisible();
      expect(above()).toBe(true);
    });

    it("keeps a guest's field in the card on a tablet", () => {
      stubViewportShell("tablet");
      useDawStore.setState({ shellBreakpoint: "tablet" });
      join("comment");
      render(<ReviewHost guestShare />);
      expect(field()).toBeVisible();
    });

    it("keeps the field before the card on a desktop", () => {
      join("comment");
      render(<ReviewHost guestShare />);
      expect(above()).toBe(true);
    });

    it("leaves a host's field before the card on a phone", () => {
      stubViewportShell("phone");
      useDawStore.setState({ shellBreakpoint: "phone" });
      useDawStore.getState().hydrate("/p", minimalProject());
      useDawStore.setState({
        stage: "review",
        ...composing({ startSec: 1, endSec: null }),
      });
      render(<ReviewHost />);
      expect(above()).toBe(true);
    });
  });

  describe("the guest column", () => {
    beforeEach(() => useDawStore.setState({ shellBreakpoint: "desktop" }));

    it("puts the one Player card first, then the composer, then the transcript", () => {
      join("comment");
      render(<ReviewHost guestShare />);
      const card = document.querySelector(".sys-player--expanded");
      const composer = field();
      const script = document.querySelector(".stage-host-guest-script");
      expect(document.querySelectorAll(".sys-player--expanded")).toHaveLength(
        1,
      );
      expect(card?.compareDocumentPosition(composer)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      expect(script).not.toBeNull();
      expect(
        composer.compareDocumentPosition(script as Element) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: "Collapse player" }),
      ).toBeNull();
    });

    it("keeps the bar on a phone and mounts no card", () => {
      stubViewportShell("phone");
      useDawStore.setState({ shellBreakpoint: "phone" });
      join("comment");
      render(<ReviewHost guestShare />);
      expect(document.querySelector(".sys-player--expanded")).toBeNull();
    });

    it("keeps the bar and mounts no card on a window too short for the transcript", () => {
      stubViewportShell("tablet", { short: true });
      join("comment");
      render(<ReviewHost guestShare />);
      expect(document.querySelector(".sys-player--expanded")).toBeNull();
      expect(field()).toBeVisible();
    });

    it("lists the guest's own suggestions in Your suggestions, and no one else's", () => {
      join(
        "comment",
        [sampleComment({ body: "Cut the intro" })],
        [
          pendingEditView({ id: "mine", label: "My trim", author: "share:me" }),
          pendingEditView({
            id: "theirs",
            label: "Rosa's trim",
            author: "share:rosa",
          }),
          pendingEditView({ id: "host", label: PENDING_LABEL }),
        ],
      );
      useDawStore.setState({ shareAuthor: "share:me" });
      render(<ReviewHost guestShare />);
      expect(
        [...document.querySelectorAll(".rv-group")].map((g) =>
          g.getAttribute("aria-label"),
        ),
      ).toEqual(["Comments", "Your suggestions"]);
      expect(screen.getAllByText("My trim").length).toBeGreaterThan(0);
      expect(screen.queryByText("Rosa's trim")).toBeNull();
      expect(screen.queryByText(PENDING_LABEL)).toBeNull();
    });

    it("shows a load failure in the transcript region only and leaves the rest usable", async () => {
      join("comment", [sampleComment({ body: "Cut the intro" })]);
      const onRetry = vi.fn();
      render(
        <ReviewHost
          guestShare
          loadFailure={{ message: "No answer.", onRetry }}
        />,
      );
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent("The transcript didn't load");
      expect(document.querySelector(".stage-host-guest-script")).toBeNull();
      expect(document.querySelector(".sys-player--expanded")).not.toBeNull();
      expect(field()).toBeEnabled();
      expect(screen.getAllByText("Cut the intro")[0]).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(onRetry).toHaveBeenCalledOnce();
    });
  });

  it("plays a comment's clip with 2 s of lead and tail when its queue row is clicked", async () => {
    join("comment", [
      sampleComment({
        id: "c9",
        body: "The podcast restarts",
        timeline_start: 323,
      }),
    ]);
    render(<ReviewHost guestShare />);
    await userEvent.click(
      document.querySelector(".sys-queue-row[data-kind=comment] button")!,
    );
    await waitFor(() => expect(useDawStore.getState().playheadSec).toBe(321));
    expect(useDawStore.getState().playUntilSec).toBe(325);
    expect(useDawStore.getState().isPlaying).toBe(true);
  });

  it("selects without playing when the queue is stepped by arrow keys", async () => {
    join("comment", [
      sampleComment({ id: "c8", timeline_start: 50 }),
      sampleComment({ id: "c9", timeline_start: 323 }),
    ]);
    useDawStore.setState({ isPlaying: false });
    render(<ReviewHost guestShare />);
    fireEvent.keyDown(document.querySelector(".rv-stage")!, {
      key: "ArrowDown",
    });
    expect(useDawStore.getState().isPlaying).toBe(false);
    expect(useDawStore.getState().playheadSec).toBe(0);
  });

  it("is axe-clean with the field and a comment", async () => {
    join("comment");
    const { container } = render(<ReviewHost guestShare />);
    await expectNoA11yViolations(container);
  });
});

describe("Player card for a guest", () => {
  beforeEach(() => {
    localStorage.clear();
    stubViewportShell("desktop");
    useDawStore.setState({ shellBreakpoint: "desktop" });
  });

  it("shows no mix status, even when the live project is stale, and shows the total duration", () => {
    join("comment");
    useDawStore.getState().setProject(
      minimalProject({
        tracks: [sampleTrack({ stem_is_fresh: true })],
        timeline_duration_sec: 600,
        render_status: {
          needs_rerender: true,
          reconciliation: { stale: false },
          premix: { exists: true },
        },
      }),
    );
    render(<ReviewHost guestShare />);
    const card = document.querySelector(".sys-player--expanded") as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.textContent).not.toMatch(/Mix out of date|No mix yet/);
    expect(card.querySelector(".sys-player-total")).toHaveTextContent("10:00");
  });
});

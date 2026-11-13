import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCommentDraft } from "../../commands/comments";
import { clearRegisteredCommands } from "../../commands/execute";
import { runPointerCommand } from "../../commands/pointer";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { noComposer } from "../../test/composerStore";
import {
  minimalProject,
  sampleComment,
  sampleTrack,
} from "../../test/fixtures";
import { scriptUtterances } from "../../test/scriptHostKit";
import { stubViewportShell } from "../../test/viewportShell";
import { PlayerBar } from "../frame/PlayerBar";
import { SheetHost } from "../frame/SheetHost";
import { ReviewHost } from "./ReviewHost";

const createComment = vi.fn();
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  createComment: (...args: unknown[]) => createComment(...args),
}));

const NAME_KEY = "podcast-mcp-guest-comment-name";
const CAPS = { view: ["view"], comment: ["view", "comment"] } as const;

function join(
  mode: "view" | "comment",
  { count = 3, chapters = true, transcript = true } = {},
) {
  useDawStore.getState().hydrate(
    "share:tok",
    minimalProject({
      comments: Array.from({ length: count }, (_, i) =>
        sampleComment({
          id: `c${i + 1}`,
          author: i === 0 ? "Claude" : "Rosa",
          body: `Note number ${i + 1}`,
          timeline_start: 3 + i * 20,
        }),
      ),
      tracks: [sampleTrack({ stem_is_fresh: true })],
      render_status: {
        needs_rerender: true,
        reconciliation: { stale: false },
        premix: { exists: true },
      },
      timeline_duration_sec: 600,
      ...(transcript ? { transcript: { utterances: scriptUtterances() } } : {}),
      chapters: chapters
        ? [
            { title: "Cold open", time: 0 },
            { title: "Second", time: 100 },
          ]
        : [],
    }),
    mode,
    [...CAPS[mode]],
  );
  useDawStore.setState({
    stage: "review",
    playheadSec: 0,
    selection: null,
    ...noComposer,
    openSheet: null,
    isPlaying: false,
    playStartSec: null,
    shellBreakpoint: "phone",
  });
}

function mount(props: Record<string, unknown> = {}) {
  return render(
    <>
      <ReviewHost guestShare {...props} />
      <PlayerBar placement="dock" />
      <SheetHost />
    </>,
  );
}

const field = () => screen.getByRole("textbox", { name: "Comment" });
const value = () => (field() as HTMLTextAreaElement).value;
const commentAt = () => screen.getByRole("button", { name: /^Comment at/ });
const postButton = () => screen.getByRole("button", { name: /^Post/ });
const row = () => screen.getByRole("button", { name: /^Show\b.*\bcomments?/ });
const playing = () => useDawStore.getState().isPlaying;
const startPlaying = (sec = 5) =>
  useDawStore.setState({ isPlaying: true, playStartSec: 0, playheadSec: sec });
const range = {
  startSec: 10,
  endSec: 14,
  trackIds: ["t1"],
  intervals: [{ start: 10, end: 14 }],
};

function inFlight() {
  let landed!: (comment: unknown) => void;
  createComment.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        landed = resolve;
      }),
  );
  return {
    land: () => act(async () => landed(sampleComment({ id: "new" }))),
  };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(NAME_KEY, "Maya");
  HTMLElement.prototype.scrollIntoView = vi.fn();
  stubViewportShell("phone");
  clearRegisteredCommands();
  registerDawCommands();
  createComment.mockReset().mockResolvedValue(sampleComment({ id: "new" }));
});
afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  vi.restoreAllMocks();
  useDawStore.setState({ shellBreakpoint: "desktop" });
});

describe("a Post in flight and the guest's own Play and Pause", () => {
  async function postThenTouchTransport(touch: () => void) {
    const user = userEvent.setup();
    join("comment");
    startPlaying();
    const post = inFlight();
    mount();
    await user.click(commentAt());
    await user.type(field(), "hello");
    await user.click(postButton());
    act(touch);
    await post.land();
  }

  it("stays paused when the guest played and paused it before the Post landed", async () => {
    await postThenTouchTransport(() => {
      useDawStore.getState().togglePlaying();
      useDawStore.getState().togglePlaying();
    });
    expect(playing()).toBe(false);
  });

  it("stays stopped when the episode ended before the Post landed", async () => {
    await postThenTouchTransport(() => {
      useDawStore.getState().togglePlaying();
      useDawStore.getState().setIsPlaying(false);
    });
    expect(playing()).toBe(false);
  });

  it("plays on when nothing touched it", async () => {
    await postThenTouchTransport(() => {});
    expect(playing()).toBe(true);
  });
});

describe("every way to open the composer", () => {
  it("keeps the promise to play on when a range comment replaces the draft", async () => {
    const user = userEvent.setup();
    join("comment");
    startPlaying();
    mount();
    await user.click(commentAt());
    act(() => openCommentDraft(range));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(playing()).toBe(true);
  });

  it("pauses a playing episode when the transcript's Comment opens the composer", async () => {
    const user = userEvent.setup();
    join("comment");
    startPlaying();
    mount();
    act(() => openCommentDraft(range));
    expect(field()).toBeInTheDocument();
    expect(playing()).toBe(false);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(playing()).toBe(true);
  });

  it("leaves an episode the guest had paused alone", async () => {
    const user = userEvent.setup();
    join("comment");
    mount();
    act(() => openCommentDraft(range));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(playing()).toBe(false);
  });
});

describe("the composer in the Listen layout", () => {
  it("is never docked at the foot: it opens from the dock's Comment and sits in the layout", async () => {
    const user = userEvent.setup();
    join("comment");
    mount();
    await user.click(commentAt());
    const compose = field().closest(".rv-compose");
    expect(compose).not.toBeNull();
    expect(compose).not.toHaveAttribute("data-docked");
  });
});

describe("a Post that lands after the composer was closed and reopened", () => {
  it("sends the text once, and closes the reopened field when it lands", async () => {
    const user = userEvent.setup();
    join("comment");
    const post = inFlight();
    mount();
    await user.click(commentAt());
    await user.type(field(), "first");
    await user.click(postButton());
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(commentAt());
    expect(value()).toBe("first");
    await post.land();
    expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();
    expect(useDawStore.getState().composer.draft).toBeNull();
    expect(createComment).toHaveBeenCalledTimes(1);
  });

  it("shows Post disabled while the earlier one is in flight", async () => {
    const user = userEvent.setup();
    join("comment");
    const post = inFlight();
    mount();
    await user.click(commentAt());
    await user.type(field(), "first");
    await user.click(postButton());
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(commentAt());
    expect(postButton()).toHaveAttribute("aria-disabled", "true");
    await user.click(postButton());
    expect(createComment).toHaveBeenCalledTimes(1);
    await post.land();
  });
});

describe("the pin belongs with the text", () => {
  it("keeps the time the text was typed at across Close and Comment again", async () => {
    const user = userEvent.setup();
    join("comment");
    startPlaying(5);
    mount();
    await user.click(commentAt());
    await user.type(field(), "too loud here");
    await user.click(screen.getByRole("button", { name: "Close" }));
    act(() => useDawStore.setState({ playheadSec: 40 }));
    await user.click(commentAt());
    expect(value()).toBe("too loud here");
    expect(useDawStore.getState().commentDraft?.startSec).toBe(5);
    await user.click(postButton());
    await act(async () => {});
    expect(createComment.mock.calls[0]?.[1]).toMatchObject({
      timelineStart: 5,
    });
  });

  it("pins an empty composer at the playhead again", async () => {
    const user = userEvent.setup();
    join("comment");
    mount();
    await user.click(commentAt());
    await user.click(screen.getByRole("button", { name: "Close" }));
    act(() => useDawStore.setState({ playheadSec: 40 }));
    await user.click(commentAt());
    expect(useDawStore.getState().commentDraft?.startSec).toBe(40);
  });
});

describe("one surface at a time", () => {
  it("closes the composer, and plays on, when Chapters opens", async () => {
    const user = userEvent.setup();
    join("comment");
    startPlaying();
    mount();
    await user.click(commentAt());
    await user.type(field(), "abc");
    await user.click(screen.getByRole("button", { name: /^Chapters/ }));
    expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();
    expect(
      screen.getByRole("dialog", { name: "Chapters" }),
    ).toBeInTheDocument();
    expect(playing()).toBe(true);
  });

  it("does not bring a sheet back when the layout stops and starts again", async () => {
    const user = userEvent.setup();
    join("comment");
    mount();
    await user.click(row());
    expect(
      screen.getByRole("dialog", { name: "Comments" }),
    ).toBeInTheDocument();
    stubViewportShell("desktop");
    act(() => {
      useDawStore.setState({ shellBreakpoint: "desktop" });
      window.dispatchEvent(new Event("resize"));
    });
    act(() => {
      stubViewportShell("phone");
      useDawStore.setState({ shellBreakpoint: "phone" });
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Back from a thread", () => {
  it("leaves the list where it was, not centred on the row again", async () => {
    const user = userEvent.setup();
    join("comment", { count: 12 });
    mount();
    await user.click(row());
    const dialog = screen.getByRole("dialog", { name: "Comments" });
    const scroller = dialog.querySelector<HTMLElement>(".sys-sheet-scroll")!;
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    scroller.scrollTop = 120;
    await user.click(within(dialog).getByText("Note number 5"));
    await user.click(screen.getByRole("button", { name: "Back to comments" }));
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getByRole("dialog", { name: "Comments" })
        .querySelector<HTMLElement>(".sys-sheet-scroll")!.scrollTop,
    ).toBe(120);
  });
});

describe("a link with chapters, no transcript and a failed load", () => {
  it("still lists the chapters from the dock", () => {
    join("view", { transcript: false });
    mount({
      loadFailure: { title: "x", message: "Could not load", onRetry: () => {} },
    });
    expect(
      screen.getByRole("button", { name: /^Chapters/ }),
    ).toBeInTheDocument();
  });
});

describe("a Viewer with a Script on the phone", () => {
  it("reads it in the middle, read only, and a tap on a word seeks", async () => {
    const user = userEvent.setup();
    join("view");
    mount();
    const script = document.querySelector<HTMLElement>(
      ".stage-host-guest-script",
    );
    expect(script).not.toBeNull();
    expect(within(script as HTMLElement).getByText("Read only")).toBeVisible();
    const word = (script as HTMLElement).querySelectorAll<HTMLElement>(
      ".sys-script-word",
    )[3] as HTMLElement;
    await user.click(word);
    expect(useDawStore.getState().playheadSec).toBeGreaterThan(0);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Comment at/ })).toBeNull();
    expect(
      screen.queryByRole("group", { name: "Selection actions" }),
    ).toBeNull();
    expect((script as HTMLElement).querySelector("[data-selected]")).toBeNull();
    expect(
      screen.getByRole("button", { name: /^Chapters/ }),
    ).toBeInTheDocument();
  });
});

describe("a layout that is not the phone Listen layout", () => {
  function joinOn(
    shell: "desktop" | "tablet" | "phone",
    mode: "view" | "comment" | "edit",
  ) {
    join(mode === "edit" ? "comment" : mode);
    if (mode === "edit")
      useDawStore
        .getState()
        .hydrate("share:tok", useDawStore.getState().project!, "edit", [
          "view",
          "comment",
          "edit",
        ]);
    stubViewportShell(shell);
    useDawStore.setState({ shellBreakpoint: shell, isPlaying: false });
  }

  it("keeps a guest on a desktop playing when the transcript's Comment opens the composer", async () => {
    joinOn("desktop", "comment");
    startPlaying();
    render(<ReviewHost guestShare />);
    act(() => openCommentDraft(range));
    expect(field()).toBeInTheDocument();
    expect(playing()).toBe(true);
  });

  it("keeps a guest on a tablet playing when the timeline's create menu opens the composer", async () => {
    joinOn("tablet", "comment");
    startPlaying();
    render(<ReviewHost guestShare />);
    act(() => {
      runPointerCommand("comment.draftAt", { atTime: 30 });
    });
    expect(playing()).toBe(true);
  });

  it("keeps an Editor on a phone playing when a range opens the composer", async () => {
    joinOn("phone", "edit");
    startPlaying();
    render(<ReviewHost guestShare />);
    act(() => openCommentDraft(range));
    expect(playing()).toBe(true);
  });

  it("gives a chosen time the pin even where text was typed", async () => {
    const user = userEvent.setup();
    joinOn("desktop", "comment");
    render(<ReviewHost guestShare />);
    await user.type(field(), "too loud here");
    act(() => {
      runPointerCommand("comment.draftAt", { atTime: 40, keepPin: true });
    });
    expect(useDawStore.getState().commentDraft?.startSec).toBe(40);
    expect(value()).toBe("too loud here");
  });
});

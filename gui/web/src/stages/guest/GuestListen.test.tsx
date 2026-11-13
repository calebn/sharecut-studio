import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { PlayerBar } from "../../stage/frame/PlayerBar";
import { SheetHost } from "../../stage/frame/SheetHost";
import { ReviewHost } from "../../stage/hosts/ReviewHost";
import { useDawStore } from "../../state/dawStore";
import {
  expectNoA11yViolations,
  expectOutsideLiveRegions,
} from "../../test/a11y";
import {
  minimalProject,
  sampleComment,
  sampleTrack,
} from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";

const createComment = vi.fn();

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  createComment: (...args: unknown[]) => createComment(...args),
}));

const NAME_KEY = "podcast-mcp-guest-comment-name";
const CAPS = { view: ["view"], comment: ["view", "comment"] };

function comments(count: number) {
  return Array.from({ length: count }, (_, i) =>
    sampleComment({
      id: `c${i + 1}`,
      author: i === 0 ? "Claude" : "Rosa",
      body: `Note number ${i + 1}`,
      timeline_start: 3 + i * 20,
    }),
  );
}

function join(mode: "view" | "comment", count = 3) {
  useDawStore.getState().hydrate(
    "share:tok",
    minimalProject({
      comments: comments(count),
      tracks: [sampleTrack({ stem_is_fresh: true })],
      render_status: {
        needs_rerender: true,
        reconciliation: { stale: false },
        premix: { exists: true },
      },
      timeline_duration_sec: 600,
      chapters: [{ title: "Cold open", time: 0 }],
    }),
    mode,
    CAPS[mode],
  );
  useDawStore.setState({
    stage: "review",
    playheadSec: 0,
    selection: null,
    commentDraft: null,
    isPlaying: false,
    playStartSec: null,
    openSheet: null,
    shellBreakpoint: "phone",
  });
}

function mount() {
  return render(
    <>
      <ReviewHost guestShare />
      <PlayerBar placement="dock" />
      <SheetHost />
    </>,
  );
}

const commentField = () => screen.getByRole("textbox", { name: "Comment" });

const scrollIntoView = vi.fn();

beforeEach(() => {
  localStorage.clear();
  scrollIntoView.mockReset();
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
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

describe("the phone Commenter Listen layout", () => {
  it("shows no text field on first load, the scrubber and the comments row", () => {
    join("comment");
    mount();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Show 3 comments" }),
    ).toBeVisible();
    expect(
      screen.getByRole("slider", { name: "Episode overview" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Comment at 0:00" }),
    ).toBeVisible();
  });

  it("opens the composer on Comment, with the time pinned and the name asked", async () => {
    const user = userEvent.setup();
    join("comment");
    mount();
    await user.click(screen.getByRole("button", { name: "Comment at 0:00" }));
    expect(commentField()).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Your name" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /^Show\b.*\bcomments?/ }),
    ).toBeNull();
  });

  it("asks for no name when the browser already knows it", async () => {
    const user = userEvent.setup();
    localStorage.setItem(NAME_KEY, "Maya");
    join("comment");
    mount();
    await user.click(screen.getByRole("button", { name: "Comment at 0:00" }));
    expect(screen.getByText("Maya")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Your name" })).toBeNull();
  });

  it("posts, then goes back to the comments row", async () => {
    const user = userEvent.setup();
    localStorage.setItem(NAME_KEY, "Maya");
    join("comment");
    mount();
    await user.click(screen.getByRole("button", { name: "Comment at 0:00" }));
    await user.type(commentField(), "Too long a pause");
    await user.click(screen.getByRole("button", { name: "Post" }));
    expect(createComment).toHaveBeenCalledWith(
      "share:tok",
      expect.objectContaining({ body: "Too long a pause", timelineStart: 0 }),
    );
    await act(async () => {});
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(
      screen.getByRole("button", { name: /^Show\b.*\bcomments?/ }),
    ).toBeVisible();
  });

  it("closes without losing the text, and gives it back on the next Comment", async () => {
    const user = userEvent.setup();
    localStorage.setItem(NAME_KEY, "Maya");
    join("comment");
    mount();
    await user.click(screen.getByRole("button", { name: "Comment at 0:00" }));
    await user.type(commentField(), "half a thought");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Comment at 0:00" }));
    expect(commentField()).toHaveValue("half a thought");
  });

  it("returns focus to the Comment button after Close and after Post", async () => {
    const user = userEvent.setup();
    localStorage.setItem(NAME_KEY, "Maya");
    join("comment");
    mount();
    const comment = () =>
      screen.getByRole("button", { name: "Comment at 0:00" });
    await user.click(comment());
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(comment()).toHaveFocus();
    await user.click(comment());
    await user.type(commentField(), "Too long a pause");
    await user.click(screen.getByRole("button", { name: "Post" }));
    await act(async () => {});
    expect(comment()).toHaveFocus();
  });

  it("says a comment was added for a moment after Post", async () => {
    const user = userEvent.setup();
    localStorage.setItem(NAME_KEY, "Maya");
    createComment.mockResolvedValue(
      sampleComment({ id: "new", timeline_start: 86 }),
    );
    join("comment");
    mount();
    await user.click(screen.getByRole("button", { name: "Comment at 0:00" }));
    await user.type(commentField(), "Too long a pause");
    await user.click(screen.getByRole("button", { name: "Post" }));
    await act(async () => {});
    expect(screen.getByText("Comment added at 1:26")).toBeVisible();
  });

  it("leaves the announcement of a post to the status line alone", async () => {
    const user = userEvent.setup();
    localStorage.setItem(NAME_KEY, "Maya");
    createComment.mockResolvedValue(
      sampleComment({ id: "new", timeline_start: 86 }),
    );
    join("comment");
    const { container } = mount();
    await user.click(screen.getByRole("button", { name: "Comment at 0:00" }));
    await user.type(commentField(), "Too long a pause");
    await user.click(screen.getByRole("button", { name: "Post" }));
    await act(async () => {});
    expectOutsideLiveRegions(container, /Comment added at 1:26/);
  });

  describe("playback", () => {
    const playing = () => useDawStore.getState().isPlaying;

    it.each([
      [
        "Post",
        async (user: ReturnType<typeof userEvent.setup>) => {
          await user.type(commentField(), "Too long a pause");
          await user.click(screen.getByRole("button", { name: "Post" }));
          await act(async () => {});
        },
      ],
      [
        "Close",
        async (user: ReturnType<typeof userEvent.setup>) => {
          await user.click(screen.getByRole("button", { name: "Close" }));
        },
      ],
    ])("pauses on Comment and plays again after %s", async (_name, finish) => {
      const user = userEvent.setup();
      localStorage.setItem(NAME_KEY, "Maya");
      join("comment");
      useDawStore.setState({
        isPlaying: true,
        playStartSec: 0,
        playheadSec: 5,
      });
      mount();
      await user.click(screen.getByRole("button", { name: "Comment at 0:05" }));
      expect(playing()).toBe(false);
      await finish(user);
      expect(playing()).toBe(true);
    });

    it("leaves a transport the guest started themselves alone", async () => {
      const user = userEvent.setup();
      localStorage.setItem(NAME_KEY, "Maya");
      join("comment");
      useDawStore.setState({
        isPlaying: true,
        playStartSec: 0,
        playheadSec: 5,
      });
      mount();
      await user.click(screen.getByRole("button", { name: "Comment at 0:05" }));
      act(() => useDawStore.getState().togglePlaying());
      expect(playing()).toBe(true);
      await user.click(screen.getByRole("button", { name: "Close" }));
      expect(playing()).toBe(true);
    });

    it("does not start a transport that was paused when Comment was tapped", async () => {
      const user = userEvent.setup();
      localStorage.setItem(NAME_KEY, "Maya");
      join("comment");
      mount();
      await user.click(screen.getByRole("button", { name: "Comment at 0:00" }));
      await user.click(screen.getByRole("button", { name: "Close" }));
      expect(playing()).toBe(false);
    });
  });

  it("opens the Comments sheet from the row and a thread on its row", async () => {
    const user = userEvent.setup();
    join("comment");
    mount();
    await user.click(screen.getByRole("button", { name: "Show 3 comments" }));
    const sheet = screen.getByRole("dialog", { name: "Comments" });
    await user.click(within(sheet).getByText("Note number 1"));
    expect(
      screen.getByRole("dialog", { name: "Comment from Claude" }),
    ).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "Reply to Claude" }),
    ).toBeVisible();
    const thread = screen.getByRole("dialog", { name: "Comment from Claude" });
    expect(within(thread).getAllByRole("heading")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Back to comments" }));
    expect(screen.getByRole("dialog", { name: "Comments" })).toBeVisible();
  });

  it("shows the comment being heard in the row, with the count beside the icon", () => {
    join("comment");
    mount();
    act(() => useDawStore.setState({ playheadSec: 5 }));
    const row = screen.getByRole("button", { name: "Show 3 comments" });
    expect(row).toHaveTextContent("Claude · 0:03 Note number 1");
    const count = within(row).getByText("3");
    expect(count.previousElementSibling?.tagName.toLowerCase()).toBe("svg");
  });

  it("names the row in the singular for one comment", () => {
    join("comment", 1);
    mount();
    expect(
      screen.getByRole("button", { name: "Show 1 comment" }),
    ).toBeVisible();
  });

  it("has no comments row when there are no comments", () => {
    join("comment", 0);
    mount();
    expect(
      screen.queryByRole("button", { name: /^Show\b.*\bcomments?/ }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Comment at 0:00" }),
    ).toBeVisible();
  });

  it("has no axe violations", async () => {
    join("comment");
    const { container } = mount();
    await expectNoA11yViolations(container);
  });
});

describe("the phone Viewer Listen layout", () => {
  it("has no Comment button and no field, and lists the chapters", () => {
    join("view");
    mount();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Comment at/ })).toBeNull();
    expect(screen.getByRole("list", { name: "Chapters" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: /^Show\b.*\bcomments?/ }),
    ).toBeVisible();
  });
});

const playing = () => useDawStore.getState().isPlaying;
const commentAt = () => screen.getByRole("button", { name: /^Comment at/ });
const rowButton = () =>
  screen.getByRole("button", { name: /^Show\b.*\bcomments?/ });
const startPlaying = () =>
  useDawStore.setState({ isPlaying: true, playStartSec: 0, playheadSec: 5 });

describe("one surface owns the bottom", () => {
  it("closes the Comments sheet when Comment opens the composer", async () => {
    const user = userEvent.setup();
    localStorage.setItem(NAME_KEY, "Maya");
    join("comment");
    mount();
    await user.click(rowButton());
    expect(screen.getByRole("dialog", { name: "Comments" })).toBeVisible();
    await user.click(commentAt());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useDawStore.getState().openSheet).toBeNull();
    expect(commentField()).toHaveFocus();
  });

  it("closes the Chapters sheet when Comment opens the composer", async () => {
    const user = userEvent.setup();
    localStorage.setItem(NAME_KEY, "Maya");
    join("comment");
    mount();
    act(() => useDawStore.getState().setOpenSheet("chapters"));
    expect(screen.getByRole("dialog", { name: "Chapters" })).toBeVisible();
    await user.click(commentAt());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(commentField()).toHaveFocus();
  });

  it("reopens on the list, not an old thread, after Comment closed the sheet", async () => {
    const user = userEvent.setup();
    localStorage.setItem(NAME_KEY, "Maya");
    join("comment");
    mount();
    await user.click(rowButton());
    await user.click(
      within(screen.getByRole("dialog", { name: "Comments" })).getByText(
        "Note number 1",
      ),
    );
    expect(
      screen.getByRole("dialog", { name: "Comment from Claude" }),
    ).toBeVisible();
    await user.click(commentAt());
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(rowButton());
    expect(screen.getByRole("dialog", { name: "Comments" })).toBeVisible();
  });

  it("reopens on the list after another path closed the sheet on a thread", async () => {
    const user = userEvent.setup();
    join("comment");
    mount();
    await user.click(rowButton());
    await user.click(
      within(screen.getByRole("dialog", { name: "Comments" })).getByText(
        "Note number 1",
      ),
    );
    act(() => useDawStore.getState().setOpenSheet(null));
    await user.click(rowButton());
    expect(screen.getByRole("dialog", { name: "Comments" })).toBeVisible();
  });
});

describe("the composer and playback", () => {
  beforeEach(() => localStorage.setItem(NAME_KEY, "Maya"));

  it("plays again after Close when Comment was tapped twice", async () => {
    const user = userEvent.setup();
    join("comment");
    startPlaying();
    mount();
    await user.click(commentAt());
    expect(playing()).toBe(false);
    await user.click(commentAt());
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(playing()).toBe(true);
  });

  it("plays again after Post when Comment was tapped twice", async () => {
    const user = userEvent.setup();
    join("comment");
    startPlaying();
    mount();
    await user.click(commentAt());
    await user.click(commentAt());
    await user.type(commentField(), "Too long a pause");
    await user.click(screen.getByRole("button", { name: "Post" }));
    await act(async () => {});
    expect(playing()).toBe(true);
  });

  it("leaves the episode paused when the guest played and paused it on purpose", async () => {
    const user = userEvent.setup();
    join("comment");
    startPlaying();
    mount();
    await user.click(commentAt());
    act(() => useDawStore.getState().togglePlaying());
    act(() => useDawStore.getState().togglePlaying());
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(playing()).toBe(false);
  });

  it("leaves the episode stopped when it played to its end", async () => {
    const user = userEvent.setup();
    join("comment");
    startPlaying();
    mount();
    await user.click(commentAt());
    act(() => useDawStore.getState().togglePlaying());
    act(() => useDawStore.getState().setIsPlaying(false));
    await user.type(commentField(), "Too long a pause");
    await user.click(screen.getByRole("button", { name: "Post" }));
    await act(async () => {});
    expect(playing()).toBe(false);
  });

  it("does not post twice when Close came while Post was in flight", async () => {
    const user = userEvent.setup();
    join("comment");
    let landed!: (comment: unknown) => void;
    createComment.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          landed = resolve;
        }),
    );
    mount();
    await user.click(commentAt());
    await user.type(commentField(), "Too long a pause");
    await user.click(screen.getByRole("button", { name: "Post" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => landed(sampleComment({ id: "new" })));
    await user.click(commentAt());
    expect(commentField()).toHaveValue("");
    expect(createComment).toHaveBeenCalledTimes(1);
  });
});

describe("the Comments list", () => {
  it("plays and seeks to a comment when its row is tapped", async () => {
    const user = userEvent.setup();
    join("comment");
    mount();
    await user.click(rowButton());
    await user.click(
      within(screen.getByRole("dialog", { name: "Comments" })).getByText(
        "Note number 2",
      ),
    );
    await waitFor(() =>
      expect(useDawStore.getState().selection).toEqual({
        kind: "comment",
        id: "c2",
      }),
    );
    expect(playing()).toBe(true);
    expect(useDawStore.getState().playheadSec).toBeGreaterThanOrEqual(21);
    expect(useDawStore.getState().playheadSec).toBeLessThanOrEqual(23);
  });

  it("opens from the row on the list, at the comment being heard", async () => {
    const user = userEvent.setup();
    join("comment");
    mount();
    act(() => useDawStore.setState({ playheadSec: 25 }));
    await user.click(rowButton());
    const sheet = screen.getByRole("dialog", { name: "Comments" });
    const heard = within(sheet)
      .getByText("Note number 2")
      .closest("button") as HTMLElement;
    expect(heard).toHaveAttribute("aria-current", "true");
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(heard);
    expect(
      screen.queryByRole("dialog", { name: "Comment from Rosa" }),
    ).toBeNull();
  });

  it("puts the guest back on the row they came from when Back leaves a thread", async () => {
    const user = userEvent.setup();
    join("comment");
    mount();
    await user.click(rowButton());
    await user.click(
      within(screen.getByRole("dialog", { name: "Comments" })).getByText(
        "Note number 3",
      ),
    );
    scrollIntoView.mockClear();
    await user.click(screen.getByRole("button", { name: "Back to comments" }));
    const came = within(screen.getByRole("dialog", { name: "Comments" }))
      .getByText("Note number 3")
      .closest("button") as HTMLElement;
    await waitFor(() => expect(came).toHaveFocus());
    expect(scrollIntoView.mock.contexts).toContain(came);
  });
});

describe("one source for who may comment", () => {
  it("keeps the comments row when a Commenter link lacks the comment capability", () => {
    useDawStore.getState().hydrate(
      "share:tok",
      minimalProject({
        comments: comments(3),
        tracks: [sampleTrack({ stem_is_fresh: true })],
        timeline_duration_sec: 600,
      }),
      "comment",
      ["view"],
    );
    useDawStore.setState({
      stage: "review",
      commentDraft: { startSec: 0, endSec: null },
      openSheet: null,
      shellBreakpoint: "phone",
    });
    mount();
    expect(rowButton()).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Comment at/ })).toBeNull();
  });
});

describe("a Viewer's thread", () => {
  it("has no reply field and no Comment button", async () => {
    const user = userEvent.setup();
    join("view");
    mount();
    await user.click(rowButton());
    await user.click(
      within(screen.getByRole("dialog", { name: "Comments" })).getByText(
        "Note number 1",
      ),
    );
    expect(
      screen.getByRole("dialog", { name: "Comment from Claude" }),
    ).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Comment at/ })).toBeNull();
  });
});

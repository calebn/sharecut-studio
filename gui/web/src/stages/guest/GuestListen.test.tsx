import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { PlayerBar } from "../../stage/frame/PlayerBar";
import { SheetHost } from "../../stage/frame/SheetHost";
import { ReviewHost } from "../../stage/hosts/ReviewHost";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
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

beforeEach(() => {
  localStorage.clear();
  stubViewportShell("phone");
  clearRegisteredCommands();
  registerDawCommands();
  createComment.mockReset().mockResolvedValue(sampleComment({ id: "new" }));
});
afterEach(() => {
  vi.restoreAllMocks();
  useDawStore.setState({ shellBreakpoint: "desktop" });
});

describe("the phone Commenter Listen layout", () => {
  it("shows no text field on first load, the scrubber and the comments row", () => {
    join("comment");
    mount();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Show comments, 3" }),
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
    expect(screen.queryByRole("button", { name: /Show comments/ })).toBeNull();
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
      screen.getByRole("button", { name: /^Show comments/ }),
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
    expect(screen.getAllByText("Comment added at 1:26").length).toBeGreaterThan(
      0,
    );
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
    await user.click(screen.getByRole("button", { name: "Show comments, 3" }));
    const sheet = screen.getByRole("dialog", { name: "Comments" });
    await user.click(within(sheet).getByText("Note number 1"));
    expect(
      screen.getByRole("dialog", { name: "Comment from Claude" }),
    ).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "Reply to Claude" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("dialog", { name: "Comments" })).toBeVisible();
  });

  it("shows the comment being heard in the row, and opens its thread from there", async () => {
    const user = userEvent.setup();
    join("comment");
    mount();
    act(() => useDawStore.setState({ playheadSec: 5 }));
    const row = screen.getByRole("button", { name: "Show comments, 3" });
    expect(row).toHaveTextContent("Claude · 0:03 Note number 1");
    await user.click(row);
    expect(
      screen.getByRole("dialog", { name: "Comment from Claude" }),
    ).toBeVisible();
  });

  it("has no comments row when there are no comments", () => {
    join("comment", 0);
    mount();
    expect(screen.queryByRole("button", { name: /Show comments/ })).toBeNull();
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
      screen.getByRole("button", { name: "Show comments, 3" }),
    ).toBeVisible();
  });
});

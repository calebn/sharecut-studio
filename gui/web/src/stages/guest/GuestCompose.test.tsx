import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCRIPT_TURNS } from "../../system/scriptFixtures";
import { stubMatchMedia } from "../../test/matchMedia";
import { GuestReview, type GuestReviewProps } from "./GuestReview";
import { DURATION, PEAKS, WORD_STARTS } from "./guestFixture";

const onPost = vi.fn();
const onRetryComment = vi.fn();
const onRemoveComment = vi.fn();
beforeEach(() => {
  onPost.mockClear();
  onRetryComment.mockClear();
  onRemoveComment.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

function setup(props: Partial<GuestReviewProps> = {}) {
  return render(
    <GuestReview
      access="commenter"
      title="Field Notes 14"
      version="Rough cut"
      turns={SCRIPT_TURNS}
      wordStarts={WORD_STARTS}
      duration={DURATION}
      peaks={PEAKS}
      initialPlayhead={735}
      onPost={onPost}
      onRetryComment={onRetryComment}
      onRemoveComment={onRemoveComment}
      {...props}
    />,
  );
}

const ROLES = ["viewer", "commenter", "editor"] as const;
const LAYOUTS = ["desktop", "phone"] as const;
const box = () => screen.getByRole("textbox", { name: "Comment" });
const forward = () =>
  userEvent.click(screen.getByRole("button", { name: "Forward 15 seconds" }));
const follows = (time: string) =>
  screen.getByRole("button", {
    name: `Comment at ${time}, follows the playhead. Pin it here`,
  });
const pinnedAt = (time: string) =>
  screen.getByRole("button", {
    name: `Pinned at ${time}. Move to the playhead`,
  });

describe("Composer", () => {
  it.each(
    ROLES.flatMap((access) =>
      LAYOUTS.map((layout) => [access, layout] as const),
    ),
  )(
    "%s on %s has a Composer only if they may comment, placed right",
    (access, layout) => {
      setup({ access, layout });
      const boxes = screen.queryAllByRole("textbox", { name: "Comment" });
      expect(boxes).toHaveLength(access === "viewer" ? 0 : 1);
      const [only] = boxes;
      if (only) {
        const script = screen.getByRole("region", { name: "Script" });
        const after =
          script.compareDocumentPosition(only) &
          Node.DOCUMENT_POSITION_FOLLOWING;
        expect(!!after).toBe(layout === "phone");
      }
    },
  );

  it("follows the playhead until the first keystroke pins it", async () => {
    setup();
    expect(follows("12:15")).toBeInTheDocument();
    await forward();
    expect(follows("12:30")).toBeInTheDocument();
    await userEvent.type(box(), "a");
    await forward();
    expect(pinnedAt("12:30")).toBeInTheDocument();
    await userEvent.type(box(), "b");
    expect(pinnedAt("12:30")).toBeInTheDocument();
  });

  it("moves a pinned time to the playhead when the chip is pressed", async () => {
    setup();
    await userEvent.type(box(), "a");
    await forward();
    await userEvent.click(pinnedAt("12:15"));
    expect(pinnedAt("12:30")).toBeInTheDocument();
  });

  it("posts the trimmed text at the pinned time and starts over", async () => {
    setup();
    await userEvent.type(box(), " hello ");
    await forward();
    await userEvent.type(box(), "{Enter}");
    expect(onPost).toHaveBeenCalledExactlyOnceWith({
      body: "hello",
      at: { start: 735 },
      name: "Guest",
    });
    expect(box()).toHaveValue("");
    expect(follows("12:30")).toBeInTheDocument();
  });

  it("posts a whole-episode note with no time", async () => {
    setup();
    await userEvent.click(
      screen.getByRole("button", { name: "Make it a whole-episode note" }),
    );
    expect(
      screen.getByRole("button", {
        name: "Whole-episode note. Pin to the playhead",
      }),
    ).toBeInTheDocument();
    await userEvent.type(box(), "About the whole show{Enter}");
    expect(onPost).toHaveBeenCalledExactlyOnceWith({
      body: "About the whole show",
      name: "Guest",
    });
  });

  it.each([
    ["Dana", "Dana"],
    ["  Dana   Reyes ", "Dana Reyes"],
    ["", "Guest"],
    ["   ", "Guest"],
  ])("a first post named %j posts as %j", async (typed, posted) => {
    setup({ firstPost: true });
    if (typed.trim()) {
      await userEvent.type(screen.getByLabelText("Your name"), typed);
    }
    await userEvent.type(box(), "hi");
    await userEvent.click(screen.getByRole("button", { name: "Post" }));
    expect(onPost).toHaveBeenCalledExactlyOnceWith({
      body: "hi",
      at: { start: 735 },
      name: posted,
    });
  });

  it("asks for a name only on the first post", () => {
    setup();
    expect(screen.queryByLabelText("Your name")).toBeNull();
  });

  it("Enter in the name field moves to the comment and posts nothing", async () => {
    setup({ firstPost: true });
    await userEvent.type(screen.getByLabelText("Your name"), "Dana{Enter}");
    expect(box()).toHaveFocus();
    expect(onPost).not.toHaveBeenCalled();
  });

  describe("keys on a fine pointer", () => {
    it("Shift+Enter adds a line and posts nothing", async () => {
      setup();
      await userEvent.type(box(), "one{Shift>}{Enter}{/Shift}two");
      expect(box()).toHaveValue("one\ntwo");
      expect(onPost).not.toHaveBeenCalled();
    });

    it("Ctrl+Enter posts", async () => {
      setup();
      await userEvent.type(box(), "yes{Control>}{Enter}{/Control}");
      expect(onPost).toHaveBeenCalledOnce();
    });

    it("Enter on an empty comment posts nothing", async () => {
      setup();
      await userEvent.type(box(), "{Enter}");
      expect(onPost).not.toHaveBeenCalled();
    });
  });

  describe("keys on a touch screen", () => {
    beforeEach(() => stubMatchMedia(true));

    it("Return adds a line and the arrow posts", async () => {
      setup({ layout: "phone" });
      await userEvent.type(box(), "one{Enter}two");
      expect(box()).toHaveValue("one\ntwo");
      expect(onPost).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "Post" }));
      expect(onPost).toHaveBeenCalledExactlyOnceWith({
        body: "one\ntwo",
        at: { start: 735 },
        name: "Guest",
      });
    });

    it("Ctrl+Enter still posts", async () => {
      setup({ layout: "phone" });
      await userEvent.type(box(), "yes{Control>}{Enter}{/Control}");
      expect(onPost).toHaveBeenCalledOnce();
    });
  });

  it.each([
    ["online", { online: true }, "Post", false],
    ["offline", { online: false }, "Queue comment", false],
    ["posting", { posting: true }, "Posting…", true],
  ] as const)("%s", (_name, props, label, busy) => {
    setup(props);
    const submit = screen.getByRole("button", { name: label });
    expect(submit.getAttribute("aria-busy") === "true").toBe(busy);
    expect(box().hasAttribute("readonly")).toBe(busy);
  });

  it("will not post an empty comment", () => {
    setup();
    expect(screen.getByRole("button", { name: "Post" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Post" })).toHaveAttribute(
      "title",
      "Write a comment to post.",
    );
  });
});

describe("Comments", () => {
  const base = {
    id: "c1",
    author: "Rosa",
    at: { start: 702.3 },
    body: "Lose the cough",
    resolved: false,
    replies: [],
    actions: [],
  };

  it("lists nothing when there are none", () => {
    setup();
    expect(screen.queryByRole("region", { name: "Comments" })).toBeNull();
  });

  it("shows a queued comment as waiting, with nothing to retry", () => {
    setup({ comments: [{ comment: base, status: "queued" }] });
    expect(screen.getByText("Waiting to send")).toBeInTheDocument();
    expect(screen.queryByText("Not sent")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("offers Try again and Remove on a failed comment, for that comment only", async () => {
    setup({
      comments: [
        { comment: base, status: "failed" },
        { comment: { ...base, id: "c2", body: "Fine" } },
      ],
    });
    expect(screen.getAllByText("Not sent")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetryComment).toHaveBeenCalledExactlyOnceWith("c1");
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemoveComment).toHaveBeenCalledExactlyOnceWith("c1");
  });

  it("shows a sent comment plain, with no Resolve, reply field or checkbox", () => {
    setup({
      comments: [
        {
          comment: {
            ...base,
            actions: [{ id: "a1", text: "Trim", done: false }],
          },
        },
      ],
    });
    expect(screen.queryByText("Waiting to send")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /resolve|reopen/i }),
    ).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("textbox", { name: /^Reply/ })).toBeNull();
  });

  it("jumps the playhead to the comment's time", async () => {
    setup({ comments: [{ comment: base }] });
    await userEvent.click(
      screen.getByRole("button", { name: /Rosa.*11:42.*Lose the cough/ }),
    );
    expect(
      document.querySelector(".sys-player-readout")?.textContent,
    ).toContain("11:42 / 52:00");
  });

  it("has nothing to jump to on a whole-episode note", () => {
    const { at: _at, ...whole } = base;
    setup({ comments: [{ comment: whole }] });
    expect(screen.queryByRole("button", { name: /Lose the cough/ })).toBeNull();
    expect(screen.getByText("Lose the cough")).toBeInTheDocument();
  });

  it.each(LAYOUTS)("sits %s relative to the Script", (layout) => {
    setup({ layout, comments: [{ comment: base }] });
    const comments = screen.getByRole("region", { name: "Comments" });
    const script = screen.getByRole("region", { name: "Script" });
    const after =
      script.compareDocumentPosition(comments) &
      Node.DOCUMENT_POSITION_FOLLOWING;
    expect(!!after).toBe(layout === "phone");
  });
});

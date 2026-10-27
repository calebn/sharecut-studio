import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { CommentCard, type CommentCardData } from "./CommentCard";

const base: CommentCardData = {
  id: "c1",
  author: "Rosa",
  at: { start: 724 },
  body: "Can we lose the cough here?",
  resolved: false,
  replies: [],
  actions: [],
};

const noop = () => undefined;
const replyField = { body: "", onBodyChange: noop, onSubmit: noop };
const failed = { state: "failed", onRetry: noop, onRemove: noop } as const;

describe("CommentCard", () => {
  it("shows who, when and what, and jumps the playhead on select", async () => {
    const onSelect = vi.fn();
    render(<CommentCard comment={base} selected onSelect={onSelect} />);
    const main = screen.getByRole("button", {
      name: /^Rosa\s*12:04\s*Can we lose the cough here\?$/,
    });
    expect(main).toHaveAttribute("aria-current", "true");
    await userEvent.click(main);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("shows a range as timecode with 'to', and no time for a whole-episode note", () => {
    const { rerender } = render(
      <CommentCard comment={{ ...base, at: { start: 724, end: 729 } }} />,
    );
    expect(screen.getByText("12:04 to 12:09")).toBeVisible();
    rerender(<CommentCard comment={{ ...base, at: undefined }} />);
    expect(screen.queryByText(/\d:\d\d/)).toBeNull();
    expect(screen.getByText("Can we lose the cough here?")).toBeVisible();
  });

  it("is plain text when nothing can select it", () => {
    render(<CommentCard comment={base} />);
    expect(screen.queryByRole("button", { name: /cough/ })).toBeNull();
    expect(screen.getByText("Can we lose the cough here?")).toBeVisible();
  });

  it("resolves with the one primary and reopens with a link button", async () => {
    const onResolve = vi.fn();
    const { container, rerender } = render(
      <CommentCard comment={base} onResolve={onResolve} reply={replyField} />,
    );
    const resolve = screen.getByRole("button", { name: "Resolve" });
    expect(resolve).toHaveClass("primary");
    expect(container.querySelectorAll(".primary")).toHaveLength(1);
    await userEvent.click(resolve);
    expect(onResolve).toHaveBeenLastCalledWith(true);
    rerender(
      <CommentCard
        comment={{ ...base, resolved: true, resolvedBy: "Sam" }}
        onResolve={onResolve}
      />,
    );
    expect(screen.getByText("Resolved by Sam")).toBeVisible();
    const reopen = screen.getByRole("button", { name: "Reopen" });
    expect(reopen).toHaveClass("linkish");
    expect(container.querySelectorAll(".primary")).toHaveLength(0);
    await userEvent.click(reopen);
    expect(onResolve).toHaveBeenLastCalledWith(false);
  });

  it("toggles an action item, with who finished it outside the checkbox name", async () => {
    const onToggleAction = vi.fn();
    render(
      <CommentCard
        comment={{
          ...base,
          actions: [
            { id: "a1", text: "Trim the cough", done: false },
            { id: "a2", text: "Re-level intro", done: true, doneBy: "Sam" },
          ],
        }}
        onToggleAction={onToggleAction}
      />,
    );
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Trim the cough" }),
    );
    expect(onToggleAction).toHaveBeenCalledWith("a1", true);
    const done = screen.getByRole("checkbox", { name: "Re-level intro" });
    expect(done).toBeChecked();
    expect(done).toHaveAccessibleDescription("Sam");
  });

  it("lists replies in order", () => {
    render(
      <CommentCard
        comment={{
          ...base,
          replies: [
            { id: "r1", author: "Sam", body: "On it" },
            { id: "r2", author: "Rosa", body: "Thanks" },
          ],
        }}
      />,
    );
    const list = screen.getByRole("list", { name: "2 replies" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["SamOn it", "RosaThanks"]);
  });

  describe("reply", () => {
    it("names the field after the author and posts with Reply", async () => {
      const onSubmit = vi.fn();
      render(
        <CommentCard
          comment={base}
          reply={{ ...replyField, body: "Done", onSubmit }}
        />,
      );
      expect(
        screen.getByRole("textbox", { name: "Reply to Rosa" }),
      ).toHaveAttribute("placeholder", "Reply to Rosa");
      await userEvent.click(screen.getByRole("button", { name: "Reply" }));
      expect(onSubmit).toHaveBeenCalledOnce();
    });

    it("carries no anchor chip", () => {
      render(<CommentCard comment={base} reply={replyField} />);
      expect(screen.queryByRole("button", { name: /playhead/ })).toBeNull();
    });

    it("posts a reply on Enter without resolving the card", async () => {
      const onSubmit = vi.fn();
      const onResolve = vi.fn();
      render(
        <CommentCard
          comment={base}
          onResolve={onResolve}
          reply={{ ...replyField, body: "Done", onSubmit }}
        />,
      );
      await userEvent.click(
        screen.getByRole("textbox", { name: "Reply to Rosa" }),
      );
      await userEvent.keyboard("{Enter}");
      expect(onSubmit).toHaveBeenCalledOnce();
      expect(onResolve).not.toHaveBeenCalled();
    });

    it("ignores a wider reply object, so a reply never carries a time chip", () => {
      const wider = {
        ...replyField,
        anchor: { kind: "pinned", start: 3 },
        onAnchor: noop,
      };
      render(<CommentCard comment={base} reply={wider} />);
      expect(
        screen.queryByRole("button", { name: /Pinned|Move to the playhead/ }),
      ).toBeNull();
      expect(screen.queryByText(/0:03/)).toBeNull();
    });

    it("shows the name line to a guest's first reply", () => {
      render(
        <CommentCard
          comment={base}
          reply={{ ...replyField, name: { value: "", onChange: noop } }}
        />,
      );
      expect(screen.getByRole("textbox", { name: "Your name" })).toBeVisible();
    });
  });

  describe("without callbacks", () => {
    const withActions = {
      ...base,
      actions: [
        { id: "a1", text: "Trim the cough", done: false },
        { id: "a2", text: "Re-level intro", done: true, doneBy: "Sam" },
      ],
    };

    it("has no Resolve, no checkbox and no textbox", () => {
      render(<CommentCard comment={withActions} />);
      expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(screen.queryByRole("textbox")).toBeNull();
      const list = screen.getByRole("list", { name: "Action items" });
      expect(
        within(list)
          .getAllByRole("listitem")
          .map((li) => li.textContent),
      ).toEqual(["Not yetTrim the cough", "DoneRe-level introSam"]);
    });

    it("gives a commenter a reply field and no Resolve", () => {
      render(<CommentCard comment={withActions} reply={replyField} />);
      expect(
        screen.getByRole("textbox", { name: "Reply to Rosa" }),
      ).toBeVisible();
      expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
      expect(screen.queryByRole("checkbox")).toBeNull();
    });
  });

  describe("pending", () => {
    it("marks a queued comment as waiting and takes no action on it", () => {
      render(
        <CommentCard
          comment={base}
          pending={{ state: "queued" }}
          onResolve={noop}
        />,
      );
      expect(screen.getByText("Waiting to send")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });

    it("retries and removes a failed comment", async () => {
      const onRetry = vi.fn();
      const onRemove = vi.fn();
      render(
        <CommentCard
          comment={base}
          pending={{ state: "failed", onRetry, onRemove }}
          onResolve={noop}
        />,
      );
      expect(screen.getByText("Not sent")).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(onRetry).toHaveBeenCalledOnce();
      expect(onRetry).toHaveBeenCalledWith();
      await userEvent.click(screen.getByRole("button", { name: "Remove" }));
      expect(onRemove).toHaveBeenCalledOnce();
      expect(onRemove).toHaveBeenCalledWith();
      expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    });

    it("shows no reply field and static action items on a pending parent", () => {
      render(
        <CommentCard
          comment={{
            ...base,
            actions: [{ id: "a1", text: "Trim", done: false }],
          }}
          pending={{ state: "queued" }}
          reply={replyField}
          onToggleAction={noop}
        />,
      );
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(screen.getByText("Trim")).toBeVisible();
    });

    it("puts Not sent in the select button's own name", () => {
      render(<CommentCard comment={base} pending={failed} onSelect={noop} />);
      expect(
        screen.getByRole("button", { name: /Rosa.*Not sent.*cough/ }),
      ).toBeVisible();
    });
  });

  it("renders no live region: the shell announces", () => {
    const { container } = render(
      <>
        <CommentCard comment={base} pending={failed} />
        <CommentCard comment={base} pending={{ state: "queued" }} />
        <CommentCard comment={base} reply={replyField} onResolve={noop} />
      </>,
    );
    expect(
      container.querySelector('[aria-live], [role="status"], [role="alert"]'),
    ).toBeNull();
  });

  it("has no axe violations across states", async () => {
    const { container } = render(
      <>
        <CommentCard
          comment={{
            ...base,
            replies: [{ id: "r1", author: "Sam", body: "On it" }],
            actions: [{ id: "a1", text: "Trim", done: true, doneBy: "Sam" }],
          }}
          selected
          onSelect={noop}
          onResolve={noop}
          onToggleAction={noop}
          reply={replyField}
        />
        <CommentCard comment={{ ...base, resolved: true }} onResolve={noop} />
        <CommentCard
          comment={{
            ...base,
            actions: [{ id: "a1", text: "Trim", done: true, doneBy: "Sam" }],
          }}
          pending={failed}
        />
      </>,
    );
    await expectNoA11yViolations(container);
  });
});

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { CommentCard, type CommentCardData } from "./CommentCard";

const base: CommentCardData = {
  id: "c1",
  author: "Rosa",
  seconds: 702.3,
  body: "Can we lose the cough here?",
  resolved: false,
  replies: [],
  actions: [],
};

describe("CommentCard", () => {
  it("shows who, when and what, and jumps the playhead on select", async () => {
    const onSelect = vi.fn();
    render(<CommentCard comment={base} selected onSelect={onSelect} />);
    const main = screen.getByRole("button", {
      name: "Rosa, 702.3 s: Can we lose the cough here?",
    });
    expect(main).toHaveAttribute("aria-current", "true");
    await userEvent.click(main);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("is plain text when nothing can select it", () => {
    render(<CommentCard comment={base} />);
    expect(screen.queryByRole("button", { name: /cough/ })).toBeNull();
    expect(screen.getByText("Can we lose the cough here?")).toBeVisible();
  });

  it("resolves and reopens", async () => {
    const onResolve = vi.fn();
    const { rerender } = render(
      <CommentCard comment={base} onResolve={onResolve} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(onResolve).toHaveBeenLastCalledWith(true);
    rerender(
      <CommentCard
        comment={{ ...base, resolved: true, resolvedBy: "Sam" }}
        onResolve={onResolve}
      />,
    );
    expect(screen.getByText("Resolved by Sam")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(onResolve).toHaveBeenLastCalledWith(false);
  });

  it("toggles an action item and names who finished it", async () => {
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
    expect(
      screen.getByRole("checkbox", { name: /Re-level intro/ }),
    ).toBeChecked();
    expect(screen.getByText("Sam")).toBeVisible();
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

  it("reuses the Composer for a reply", async () => {
    const onSubmit = vi.fn();
    render(
      <CommentCard
        comment={base}
        reply={{
          body: "Done",
          onBodyChange: () => undefined,
          onSubmit,
          submitLabel: "Reply",
          compact: true,
        }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("takes away resolve and action toggles for a read-only viewer", () => {
    render(
      <CommentCard
        comment={{
          ...base,
          actions: [{ id: "a1", text: "Trim the cough", done: false }],
        }}
        readOnly
        onResolve={() => undefined}
        onToggleAction={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(screen.getByRole("checkbox")).toBeDisabled();
  });

  it.each([
    ["queued", "Waiting to send"],
    ["failed", "Not sent"],
  ] as const)("marks a %s comment and holds back resolve", (pending, text) => {
    render(
      <CommentCard
        comment={{ ...base, pending }}
        onResolve={() => undefined}
      />,
    );
    expect(screen.getByText(text)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
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
          onSelect={() => undefined}
          onResolve={() => undefined}
          onToggleAction={() => undefined}
          reply={{
            body: "",
            onBodyChange: () => undefined,
            onSubmit: () => undefined,
          }}
        />
        <CommentCard
          comment={{ ...base, resolved: true }}
          onResolve={() => undefined}
        />
        <CommentCard comment={{ ...base, pending: "failed" }} />
      </>,
    );
    await expectNoA11yViolations(container);
  });
});

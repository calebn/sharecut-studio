import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { partial, rule } from "../test/cssRules";
import { Cover } from "./Cover";

describe("Cover", () => {
  it.each([
    ["page", 1],
    ["region", 0],
  ] as const)("a %s cover shows the brand mark %i time(s)", (size, marks) => {
    const { container } = render(
      <Cover size={size} glyph="eye-off" title="Title">
        Body.
      </Cover>,
    );
    expect(container.querySelectorAll(".brand-symbol")).toHaveLength(marks);
    expect(container.querySelector(".sys-cover")).toHaveClass(
      `sys-cover--${size}`,
    );
  });

  it.each(["page", "region"] as const)(
    "titles every cover with a level-two heading by default (%s)",
    (size) => {
      render(
        <Cover size={size} glyph="eye-off" title="Title">
          Body.
        </Cover>,
      );
      expect(
        screen.getByRole("heading", { level: 2, name: "Title" }),
      ).toBeInTheDocument();
    },
  );

  it("titles a cover with a level-one heading when it is the page's only heading", () => {
    render(
      <Cover size="page" glyph="eye-off" title="Title" headingLevel="h1">
        Body.
      </Cover>,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Title" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  it("fires the primary and secondary actions and renders extra", async () => {
    const primary = vi.fn();
    const secondary = vi.fn();
    render(
      <Cover
        size="region"
        glyph="eye-off"
        title="Title"
        primary={{ label: "Go", onClick: primary }}
        secondary={{ label: "Later", onClick: secondary }}
        extra={<span>Rosa and Jon</span>}
      >
        Body.
      </Cover>,
    );
    expect(screen.getByText("Rosa and Jon")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(secondary).toHaveBeenCalledOnce();
    expect(primary).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(primary).toHaveBeenCalledOnce();
  });

  it("holds a busy primary in place, aria-disabled and aria-busy, and keeps its focus", async () => {
    const onClick = vi.fn();
    render(
      <Cover
        size="region"
        glyph="eye-off"
        title="Title"
        primary={{ label: "Save", onClick, busy: true }}
      >
        Body.
      </Cover>,
    );
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(save).toHaveAttribute("aria-busy", "true");
    save.focus();
    expect(save).toHaveFocus();
    await userEvent.click(save);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("holds a busy secondary in place, aria-disabled and aria-busy, and keeps its focus", async () => {
    const onClick = vi.fn();
    render(
      <Cover
        size="region"
        glyph="eye-off"
        title="Title"
        secondary={{ label: "Again", onClick, busy: true }}
      >
        Body.
      </Cover>,
    );
    const again = screen.getByRole("button", { name: "Again" });
    expect(again).toHaveAttribute("aria-disabled", "true");
    expect(again).toHaveAttribute("aria-busy", "true");
    again.focus();
    expect(again).toHaveFocus();
    await userEvent.click(again);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("leaves a primary without busy enabled", () => {
    render(
      <Cover
        size="region"
        glyph="eye-off"
        title="Title"
        primary={{ label: "Save", onClick: vi.fn() }}
      >
        Body.
      </Cover>,
    );
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    expect(save).not.toHaveAttribute("aria-busy");
    expect(save).not.toHaveAttribute("aria-disabled");
  });

  it("renders no action row without actions", () => {
    const { container } = render(
      <Cover size="region" glyph="eye-off" title="Title">
        Body.
      </Cover>,
    );
    expect(container.querySelector(".sys-cover-actions")).toBeNull();
  });

  it("keeps a page cover's action next to its text on a wide screen", () => {
    const css = partial("system.css");
    expect(rule(css, ".sys-cover--page .sys-cover-body")).toMatch(
      /margin-block:\s*auto 0/,
    );
    expect(rule(css, ".sys-cover--page .sys-cover-actions")).toMatch(
      /margin-block-end:\s*auto/,
    );
  });
});

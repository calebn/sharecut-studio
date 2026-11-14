import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestLoadFailure } from "../../guestLoadFailure";
import { expectNoA11yViolations } from "../../test/a11y";
import { GuestPageCover, NotServedCover } from "./StatusCovers";

describe("NotServedCover", () => {
  it("says the episode is not open here, with the spec's two ways forward", async () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <NotServedCover
        notServed={{
          name: "Rosa and Maya",
          openHref: "/?project=%2Fep.sharecut&session_token=t",
          homeHref: "/?home=1&session_token=t",
        }}
        onNavigate={onNavigate}
      />,
    );
    expect(
      screen.getByRole("heading", {
        name: "This episode isn't open on this computer",
      }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Open Rosa and Maya" }),
    );
    expect(onNavigate).toHaveBeenLastCalledWith(
      "/?project=%2Fep.sharecut&session_token=t",
    );
    await userEvent.click(screen.getByRole("button", { name: "All projects" }));
    expect(onNavigate).toHaveBeenLastCalledWith("/?home=1&session_token=t");
    await expectNoA11yViolations(container);
  });
});

describe("GuestPageCover", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function renderCover(
    failure: GuestLoadFailure,
    { trying = false, onRetry = vi.fn() } = {},
  ) {
    const view = render(
      <GuestPageCover failure={failure} trying={trying} onRetry={onRetry} />,
    );
    return {
      ...view,
      onRetry,
      again: (next: Partial<{ failure: GuestLoadFailure; trying: boolean }>) =>
        view.rerender(
          <GuestPageCover
            failure={next.failure ?? failure}
            trying={next.trying ?? trying}
            onRetry={onRetry}
          />,
        ),
    };
  }

  it("is the page's main with an h1 title and no tabindex", () => {
    renderCover({ kind: "unreachable" });
    const main = screen.getByRole("main");
    expect(main).not.toHaveAttribute("tabindex");
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "The host's computer is asleep",
      }),
    ).toBeInTheDocument();
  });

  it("moves focus to the title when it arrives", () => {
    renderCover({ kind: "server" });
    expect(
      screen.getByRole("heading", { name: "This link did not load" }),
    ).toHaveFocus();
  });

  it("keeps the button mounted and focused while a press is busy, and says each step", () => {
    const { again, onRetry } = renderCover({ kind: "unreachable" });
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("");
    const button = screen.getByRole("button", { name: "Try now" });
    button.focus();
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledOnce();
    again({ trying: true });
    expect(screen.getByRole("button", { name: "Trying…" })).toBe(button);
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveFocus();
    expect(status).toHaveTextContent("Trying again…");

    again({ trying: false });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("Trying again…");
    act(() => void vi.advanceTimersByTime(600));
    expect(screen.getByRole("button", { name: "Try now" })).toBe(button);
    expect(button).not.toHaveAttribute("aria-busy");
    expect(button).toHaveFocus();
    expect(status).toHaveTextContent("Still asleep.");
  });

  it("says Still not loading. for any other failure", () => {
    const { again } = renderCover({ kind: "server" });
    const button = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(button);
    again({ trying: true });
    expect(screen.getByRole("status")).toHaveTextContent("Trying again…");
    again({ trying: false });
    act(() => void vi.advanceTimersByTime(600));
    expect(screen.getByRole("status")).toHaveTextContent("Still not loading.");
  });

  it("shows no busy state and no status for an attempt nobody pressed", () => {
    const { again } = renderCover({ kind: "unreachable" });
    again({ trying: true });
    const button = screen.getByRole("button", { name: "Try now" });
    expect(button).not.toHaveAttribute("aria-busy");
    expect(screen.getByRole("status")).toHaveTextContent("");
    again({ trying: false });
    act(() => void vi.advanceTimersByTime(5_000));
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("keeps the line of the last press through the page's own retry", () => {
    const { again } = renderCover({ kind: "unreachable" });
    fireEvent.click(screen.getByRole("button", { name: "Try now" }));
    again({ trying: true });
    again({ trying: false });
    act(() => void vi.advanceTimersByTime(600));
    again({ trying: true });
    expect(screen.getByRole("status")).toHaveTextContent("Still asleep.");
    expect(screen.getByRole("button", { name: "Try now" })).not.toHaveAttribute(
      "aria-busy",
    );
  });

  it("does not take focus from the button when the title changes", () => {
    const { again } = renderCover({ kind: "unreachable" });
    const button = screen.getByRole("button", { name: "Try now" });
    button.focus();
    again({ failure: { kind: "server" } });
    expect(
      screen.getByRole("heading", { name: "This link did not load" }),
    ).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "Retry" })).toHaveFocus();
  });

  it("moves focus to the new title when focus is outside the cover", () => {
    const { again } = renderCover({ kind: "unreachable" });
    (document.activeElement as HTMLElement | null)?.blur();
    again({ failure: { kind: "server" } });
    expect(
      screen.getByRole("heading", { name: "This link did not load" }),
    ).toHaveFocus();
  });

  it("has no button and no status for a link that opens nothing", () => {
    renderCover({ kind: "bad-link" });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      screen.getByText("Ask the person who sent it for a new link."),
    ).toBeInTheDocument();
  });

  it("has no accessibility violations at rest or while busy", async () => {
    vi.useRealTimers();
    const { container, again } = renderCover({ kind: "server" });
    await expectNoA11yViolations(container);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    again({ trying: true });
    await expectNoA11yViolations(container);
  });
});

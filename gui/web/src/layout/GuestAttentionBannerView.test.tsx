import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { offlineConflict } from "../test/fixtures";
import { GuestAttentionBannerView } from "./GuestAttentionBannerView";

function expandDetails() {
  fireEvent.click(screen.getByText("Details"));
}

describe("GuestAttentionBannerView", () => {
  it("renders nothing when there is no pending work and no conflicts", () => {
    const { container } = render(
      <GuestAttentionBannerView
        pending={0}
        conflicts={[]}
        onDismissAll={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("opens recovery details from its summary", async () => {
    render(
      <GuestAttentionBannerView
        pending={1}
        conflicts={[
          offlineConflict({ kind: "unknown", recovery: "inspect-history" }),
        ]}
        onDismissAll={vi.fn()}
        onInspectHistory={vi.fn()}
      />,
    );
    const summary = screen.getByText("Details");
    await userEvent.click(summary);
    expect(summary.parentElement).toHaveAttribute("open");
    expect(
      screen.getByRole("button", { name: "Inspect History" }),
    ).toBeVisible();
  });

  it("shows pending-only state with no dismiss button", async () => {
    const { container } = render(
      <GuestAttentionBannerView
        pending={2}
        conflicts={[]}
        onDismissAll={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveAccessibleName(/2 pending/);
    expect(
      screen.queryByRole("button", { name: "Dismiss all" }),
    ).not.toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("shows pending and conflicts, lists items and dismisses", async () => {
    const onDismissAll = vi.fn();
    const conflicts = [
      offlineConflict({
        command: { command_id: "cmd-1", type: "SetEnvelope" },
        reason: "Envelope changed since this edit was queued",
      }),
      offlineConflict({
        command: { command_id: "cmd-2", type: "TrimClip" },
        reason: "Clip was already trimmed",
      }),
    ];
    const { container } = render(
      <GuestAttentionBannerView
        pending={1}
        conflicts={conflicts}
        onDismissAll={onDismissAll}
      />,
    );
    expect(screen.getByRole("alert")).toHaveAccessibleName(
      /1 pending, 2 conflicts/,
    );
    expandDetails();
    expandDetails();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("SetEnvelope");
    expect(items[0].textContent).toContain(
      "Envelope changed since this edit was queued",
    );
    expect(items[1].textContent).toContain("TrimClip");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss all" }));
    expect(onDismissAll).toHaveBeenCalledTimes(1);
    await expectNoA11yViolations(container);
  });

  it("lists only the first 5 of 7 conflicts plus a +2 more item", () => {
    const conflicts = Array.from({ length: 7 }, (_, i) =>
      offlineConflict({ command: { command_id: `cmd-${i}` } }),
    );
    render(
      <GuestAttentionBannerView
        pending={0}
        conflicts={conflicts}
        onDismissAll={vi.fn()}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(6);
    expect(items[5]).toHaveTextContent("+2 more");
    expect(items[5]).toHaveClass("guest-attention-more");
    for (const item of items.slice(0, 5)) {
      expect(item).not.toHaveClass("guest-attention-more");
    }
    expect(screen.getByRole("alert")).toHaveAccessibleName(/7 conflicts/);
  });

  it("shows no more item when exactly 5 conflicts fit", () => {
    const conflicts = Array.from({ length: 5 }, (_, i) =>
      offlineConflict({ command: { command_id: `cmd-${i}` } }),
    );
    render(
      <GuestAttentionBannerView
        pending={0}
        conflicts={conflicts}
        onDismissAll={vi.fn()}
      />,
    );
    expandDetails();
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.queryByText(/more$/)).not.toBeInTheDocument();
  });

  it("renders unreadable saved work accessibly and withholds dismissal", async () => {
    const { container, rerender } = render(
      <GuestAttentionBannerView
        pending={0}
        conflicts={[]}
        unreadable
        onDismissAll={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveAccessibleName(
      /Saved edits could not be read/,
    );
    expandDetails();
    await expectNoA11yViolations(container);
    rerender(
      <GuestAttentionBannerView
        pending={2}
        conflicts={[offlineConflict()]}
        unreadable
        onDismissAll={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveAccessibleName(
      /2 pending, 1 conflict/,
    );
    expect(screen.getByRole("button", { name: "Dismiss all" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Dismiss all" }),
    ).toHaveAccessibleDescription(
      "Saved edits could not be read. Dismissal is unavailable.",
    );
    await expectNoA11yViolations(container);
  });

  it("retains visible values while checking and admits dismissal afterward", async () => {
    const { container, rerender } = render(
      <GuestAttentionBannerView
        pending={2}
        conflicts={[offlineConflict()]}
        checking
        onDismissAll={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveAccessibleName(
      /2 pending, 1 conflict/,
    );
    expect(screen.getByRole("button", { name: "Dismiss all" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expectNoA11yViolations(container);
    rerender(
      <GuestAttentionBannerView
        pending={2}
        conflicts={[offlineConflict()]}
        onDismissAll={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Dismiss all" }),
    ).toBeInTheDocument();
  });

  it("uses the singular form for a single conflict", () => {
    render(
      <GuestAttentionBannerView
        pending={0}
        conflicts={[offlineConflict()]}
        onDismissAll={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveAccessibleName(/1 conflict/);
  });

  it("offers Send now beside pending edits and calls it", async () => {
    const onSendNow = vi.fn();
    const { container } = render(
      <GuestAttentionBannerView
        pending={2}
        conflicts={[]}
        onDismissAll={vi.fn()}
        onSendNow={onSendNow}
      />,
    );
    expandDetails();
    await userEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(onSendNow).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("offers Retry when saved edits are unreadable and calls it", async () => {
    const onRetry = vi.fn();
    render(
      <GuestAttentionBannerView
        pending={0}
        conflicts={[]}
        unreadable
        onDismissAll={vi.fn()}
        onRetry={onRetry}
      />,
    );
    expandDetails();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: "Send now" }),
    ).not.toBeInTheDocument();
  });

  it("offers no Send now without pending edits", () => {
    render(
      <GuestAttentionBannerView
        pending={0}
        conflicts={[offlineConflict()]}
        onDismissAll={vi.fn()}
        onSendNow={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Send now" }),
    ).not.toBeInTheDocument();
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { offlineConflict } from "../test/fixtures";
import { GuestAttentionBannerView } from "./GuestAttentionBannerView";

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

  it("shows pending-only state with no dismiss button", async () => {
    const { container } = render(
      <GuestAttentionBannerView
        pending={2}
        conflicts={[]}
        onDismissAll={vi.fn()}
      />,
    );
    expect(screen.getByText("2 pending")).toBeInTheDocument();
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
    expect(screen.getByText("1 pending, 2 conflicts")).toBeInTheDocument();
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
    expect(screen.getByText("7 conflicts")).toBeInTheDocument();
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
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.queryByText(/more$/)).not.toBeInTheDocument();
  });

  it("uses the singular form for a single conflict", () => {
    render(
      <GuestAttentionBannerView
        pending={0}
        conflicts={[offlineConflict()]}
        onDismissAll={vi.fn()}
      />,
    );
    expect(screen.getByText("1 conflict")).toBeInTheDocument();
  });
});

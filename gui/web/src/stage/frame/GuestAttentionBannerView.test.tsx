import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { offlineConflict } from "../../test/fixtures";
import { GuestAttentionBannerView } from "./GuestAttentionBannerView";

afterEach(() => {
  vi.useRealTimers();
});

const conflictsOf = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    offlineConflict({ command: { command_id: `cmd-${i}` } }),
  );

function expandDetails() {
  fireEvent.click(screen.getByLabelText(/^Needs attention (?:\d+|!) Details$/));
}

describe("GuestAttentionBannerView", () => {
  it("renders nothing when there are no conflicts", () => {
    const { container } = render(
      <GuestAttentionBannerView conflicts={[]} onDismissAll={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it.each([
    {
      state: "a conflicting edit",
      conflicts: [offlineConflict()],
      unreadable: false,
      visibleLabel: /^Needs attention\s+1\s+Details$/,
      accessibleLabel: /^Needs attention\s+1\s+Details\b/,
      recoveryAction: "Dismiss all",
    },
    {
      state: "unreadable saved edits with no count",
      conflicts: [],
      unreadable: true,
      visibleLabel: /^Needs attention\s+!\s+Details$/,
      accessibleLabel: /^Needs attention\s+!\s+Details\b/,
      recoveryAction: "Retry",
    },
  ])(
    "includes the visible summary label and opens recovery details for $state",
    async ({
      conflicts,
      unreadable,
      visibleLabel,
      accessibleLabel,
      recoveryAction,
    }) => {
      render(
        <GuestAttentionBannerView
          conflicts={conflicts}
          unreadable={unreadable}
          onDismissAll={vi.fn()}
          onRetry={vi.fn()}
        />,
      );
      const summary = screen.getByText("Needs attention").closest("summary")!;
      expect(summary).toHaveTextContent(visibleLabel);
      expect(summary).toHaveAccessibleName(accessibleLabel);
      await userEvent.click(summary);
      expect(summary.closest("details")).toHaveAttribute("open");
      expect(
        screen.getByRole("button", { name: recoveryAction }),
      ).toBeVisible();
    },
  );

  it("keeps attention before app controls and removes each portal on unmount", () => {
    vi.useFakeTimers();
    const originalChildren = [...document.body.children];
    const first = render(
      <StrictMode>
        <GuestAttentionBannerView
          conflicts={conflictsOf(1)}
          onDismissAll={vi.fn()}
        />
        <button type="button">Transport</button>
      </StrictMode>,
    );
    const second = render(
      <StrictMode>
        <GuestAttentionBannerView
          conflicts={conflictsOf(2)}
          onDismissAll={vi.fn()}
        />
      </StrictMode>,
    );
    expect(
      screen.getAllByRole("region", { name: /Needs attention/ }),
    ).toHaveLength(2);
    const summary = screen.getByLabelText("Needs attention 1 Details");
    expect(
      summary.compareDocumentPosition(
        screen.getByRole("button", { name: "Transport" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    first.unmount();
    expect(
      screen.getAllByRole("region", { name: /Needs attention/ }),
    ).toHaveLength(1);
    second.unmount();
    expect(
      screen.queryByRole("region", { name: /Needs attention/ }),
    ).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
    expect(
      [...document.body.children].filter(
        (child) => !originalChildren.includes(child),
      ),
    ).toEqual([first.container, second.container]);
  });

  it("keeps one open disclosure and focused action across inspector host close and stow", async () => {
    const host = document.createElement("div");
    const header = document.createElement("button");
    header.textContent = "Inspector close";
    document.body.append(header, host);
    const props = {
      conflicts: conflictsOf(1),
      onDismissAll: vi.fn(),
    };
    const { rerender, unmount, container } = render(
      <StrictMode>
        <GuestAttentionBannerView {...props} />
      </StrictMode>,
    );
    const summary = screen.getByLabelText("Needs attention 1 Details");
    await userEvent.click(summary);
    const details = summary.closest("details")!;
    const action = screen.getByRole("button", { name: "Dismiss all" });
    action.focus();
    rerender(
      <StrictMode>
        <GuestAttentionBannerView {...props} host={host} />
      </StrictMode>,
    );
    expect(host).toContainElement(details);
    expect(details).toHaveAttribute("open");
    expect(action).toHaveFocus();
    expect(
      header.compareDocumentPosition(summary) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    host.remove();
    rerender(
      <StrictMode>
        <GuestAttentionBannerView {...props} />
      </StrictMode>,
    );
    expect(container).toContainElement(details);
    expect(details).toHaveAttribute("open");
    expect(action).toHaveFocus();
    const nextHost = document.createElement("div");
    document.body.append(nextHost);
    rerender(
      <StrictMode>
        <GuestAttentionBannerView {...props} host={nextHost} />
      </StrictMode>,
    );
    expect(nextHost).toContainElement(details);
    expect(
      screen.getAllByRole("region", { name: /Needs attention/ }),
    ).toHaveLength(1);
    unmount();
    expect(nextHost).toBeEmptyDOMElement();
    nextHost.remove();
    header.remove();
  });

  it("does not carry open state or focus into another project", async () => {
    const props = { conflicts: conflictsOf(1), onDismissAll: vi.fn() };
    const { rerender } = render(
      <GuestAttentionBannerView key="first-project" {...props} />,
    );
    const summary = screen.getByLabelText("Needs attention 1 Details");
    await userEvent.click(summary);
    summary.focus();
    rerender(<GuestAttentionBannerView key="second-project" {...props} />);
    expect(
      screen.getByLabelText("Needs attention 1 Details").closest("details"),
    ).not.toHaveAttribute("open");
    expect(summary).not.toBeInTheDocument();
    expect(
      screen.getByLabelText("Needs attention 1 Details"),
    ).not.toHaveFocus();
  });

  it("removes an open disclosure when attention disappears and starts closed next time", () => {
    const { rerender } = render(
      <GuestAttentionBannerView
        conflicts={conflictsOf(1)}
        onDismissAll={vi.fn()}
      />,
    );
    expandDetails();
    expect(
      screen.getByLabelText("Needs attention 1 Details").closest("details"),
    ).toHaveAttribute("open");
    rerender(
      <GuestAttentionBannerView conflicts={[]} onDismissAll={vi.fn()} />,
    );
    expect(
      screen.queryByLabelText("Needs attention 1 Details"),
    ).not.toBeInTheDocument();
    rerender(
      <GuestAttentionBannerView
        conflicts={conflictsOf(1)}
        onDismissAll={vi.fn()}
      />,
    );
    expect(
      screen.getByLabelText("Needs attention 1 Details").closest("details"),
    ).not.toHaveAttribute("open");
  });

  it("lists conflicts and dismisses", async () => {
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
    const { baseElement } = render(
      <GuestAttentionBannerView
        conflicts={conflicts}
        onDismissAll={onDismissAll}
      />,
    );
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveAccessibleName(/2 conflicts/);
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
    await expectNoA11yViolations(baseElement);
  });

  it("lists only the first 5 of 7 conflicts plus a +2 more item", () => {
    const conflicts = Array.from({ length: 7 }, (_, i) =>
      offlineConflict({ command: { command_id: `cmd-${i}` } }),
    );
    render(
      <GuestAttentionBannerView conflicts={conflicts} onDismissAll={vi.fn()} />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(6);
    expect(items[5]).toHaveTextContent("+2 more");
    expect(items[5]).toHaveClass("guest-attention-more");
    for (const item of items.slice(0, 5)) {
      expect(item).not.toHaveClass("guest-attention-more");
    }
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveAccessibleName(/7 conflicts/);
  });

  it("shows no more item when exactly 5 conflicts fit", () => {
    const conflicts = Array.from({ length: 5 }, (_, i) =>
      offlineConflict({ command: { command_id: `cmd-${i}` } }),
    );
    render(
      <GuestAttentionBannerView conflicts={conflicts} onDismissAll={vi.fn()} />,
    );
    expandDetails();
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.queryByText(/more$/)).not.toBeInTheDocument();
  });

  it("renders unreadable saved work accessibly and withholds dismissal", async () => {
    const { baseElement, rerender } = render(
      <GuestAttentionBannerView
        conflicts={[]}
        unreadable
        onDismissAll={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveAccessibleName(/Saved edits could not be read/);
    expandDetails();
    await expectNoA11yViolations(baseElement);
    rerender(
      <GuestAttentionBannerView
        conflicts={[offlineConflict()]}
        unreadable
        onDismissAll={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveAccessibleName(/1 conflict/);
    expect(screen.getByRole("button", { name: "Dismiss all" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Dismiss all" }),
    ).toHaveAccessibleDescription(
      "Saved edits could not be read. Dismissal is unavailable.",
    );
    await expectNoA11yViolations(baseElement);
  });

  it("retains visible values while checking and admits dismissal afterward", async () => {
    const { baseElement, rerender } = render(
      <GuestAttentionBannerView
        conflicts={[offlineConflict()]}
        checking
        onDismissAll={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveAccessibleName(/1 conflict/);
    expect(screen.getByRole("button", { name: "Dismiss all" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expectNoA11yViolations(baseElement);
    rerender(
      <GuestAttentionBannerView
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
        conflicts={[offlineConflict()]}
        onDismissAll={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveAccessibleName(/1 conflict/);
  });

  it("offers Retry when saved edits are unreadable and calls it", async () => {
    const onRetry = vi.fn();
    render(
      <GuestAttentionBannerView
        conflicts={[]}
        unreadable
        onDismissAll={vi.fn()}
        onRetry={onRetry}
      />,
    );
    expandDetails();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe("a refusal that blocks saving", () => {
  const blocking = {
    ...offlineConflict({ reason: "The project file is missing." }),
    blocksSave: true,
  } as ReturnType<typeof offlineConflict>;

  it("tells the guest to ask the project owner", () => {
    render(
      <GuestAttentionBannerView
        conflicts={[blocking]}
        onDismissAll={vi.fn()}
      />,
    );
    expandDetails();
    expect(
      screen.getByText("Ask the project owner to check the project."),
    ).toBeVisible();
    expect(
      screen.queryByText("Edit the change and submit it again."),
    ).not.toBeInTheDocument();
  });
});

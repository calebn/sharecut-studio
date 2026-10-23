import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { offlineConflict } from "../test/fixtures";
import { DocumentCommand } from "../types/documentCommands.generated";
import { TRANSCRIPT_REFINE_REFUSAL } from "../utils/apiError";
import { GuestAttentionBannerView } from "./GuestAttentionBannerView";

const waive = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ waiveTranscriptRefine: waive }));

afterEach(() => {
  vi.useRealTimers();
  waive.mockReset();
});

function expandDetails() {
  fireEvent.click(
    screen.getByLabelText("Needs attention details and recovery actions"),
  );
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
    const summary = screen.getByLabelText(
      "Needs attention details and recovery actions",
    );
    await userEvent.click(summary);
    expect(summary.closest("details")).toHaveAttribute("open");
    expect(
      screen.getByRole("button", { name: "Inspect History" }),
    ).toBeVisible();
  });

  it("keeps attention before app controls and removes each portal on unmount", () => {
    vi.useFakeTimers();
    const originalChildren = [...document.body.children];
    const first = render(
      <StrictMode>
        <GuestAttentionBannerView
          pending={1}
          conflicts={[]}
          onDismissAll={vi.fn()}
        />
        <button type="button">Transport</button>
      </StrictMode>,
    );
    const second = render(
      <StrictMode>
        <GuestAttentionBannerView
          pending={2}
          conflicts={[]}
          onDismissAll={vi.fn()}
        />
      </StrictMode>,
    );
    expect(
      screen.getAllByRole("region", { name: /Needs attention/ }),
    ).toHaveLength(2);
    const summary = screen.getAllByLabelText(
      "Needs attention details and recovery actions",
    )[0];
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
      pending: 1,
      conflicts: [],
      onDismissAll: vi.fn(),
      onSendNow: vi.fn(),
    };
    const { rerender, unmount, container } = render(
      <StrictMode>
        <GuestAttentionBannerView {...props} />
      </StrictMode>,
    );
    const summary = screen.getByLabelText(
      "Needs attention details and recovery actions",
    );
    await userEvent.click(summary);
    const details = summary.closest("details")!;
    const action = screen.getByRole("button", { name: "Send now" });
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
    const props = { pending: 1, conflicts: [], onDismissAll: vi.fn() };
    const { rerender } = render(
      <GuestAttentionBannerView key="first-project" {...props} />,
    );
    const summary = screen.getByLabelText(
      "Needs attention details and recovery actions",
    );
    await userEvent.click(summary);
    summary.focus();
    rerender(<GuestAttentionBannerView key="second-project" {...props} />);
    expect(
      screen
        .getByLabelText("Needs attention details and recovery actions")
        .closest("details"),
    ).not.toHaveAttribute("open");
    expect(summary).not.toBeInTheDocument();
    expect(
      screen.getByLabelText("Needs attention details and recovery actions"),
    ).not.toHaveFocus();
  });

  it("removes an open disclosure when attention disappears and starts closed next time", () => {
    const { rerender } = render(
      <GuestAttentionBannerView
        pending={1}
        conflicts={[]}
        onDismissAll={vi.fn()}
      />,
    );
    expandDetails();
    expect(
      screen
        .getByLabelText("Needs attention details and recovery actions")
        .closest("details"),
    ).toHaveAttribute("open");
    rerender(
      <GuestAttentionBannerView
        pending={0}
        conflicts={[]}
        onDismissAll={vi.fn()}
      />,
    );
    expect(
      screen.queryByLabelText("Needs attention details and recovery actions"),
    ).not.toBeInTheDocument();
    rerender(
      <GuestAttentionBannerView
        pending={1}
        conflicts={[]}
        onDismissAll={vi.fn()}
      />,
    );
    expect(
      screen
        .getByLabelText("Needs attention details and recovery actions")
        .closest("details"),
    ).not.toHaveAttribute("open");
  });

  it("shows pending-only state with no dismiss button", async () => {
    const { baseElement } = render(
      <GuestAttentionBannerView
        pending={2}
        conflicts={[]}
        onDismissAll={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveAccessibleName(/2 pending/);
    expect(
      screen.queryByRole("button", { name: "Dismiss all" }),
    ).not.toBeInTheDocument();
    await expectNoA11yViolations(baseElement);
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
    const { baseElement } = render(
      <GuestAttentionBannerView
        pending={1}
        conflicts={conflicts}
        onDismissAll={onDismissAll}
      />,
    );
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveAccessibleName(/1 pending, 2 conflicts/);
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
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveAccessibleName(/7 conflicts/);
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
    const { baseElement, rerender } = render(
      <GuestAttentionBannerView
        pending={0}
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
        pending={2}
        conflicts={[offlineConflict()]}
        unreadable
        onDismissAll={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveAccessibleName(/2 pending, 1 conflict/);
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
        pending={2}
        conflicts={[offlineConflict()]}
        checking
        onDismissAll={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveAccessibleName(/2 pending, 1 conflict/);
    expect(screen.getByRole("button", { name: "Dismiss all" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expectNoA11yViolations(baseElement);
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
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveAccessibleName(/1 conflict/);
  });

  it("offers Send now beside pending edits and calls it", async () => {
    const onSendNow = vi.fn();
    const { baseElement } = render(
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
    await expectNoA11yViolations(baseElement);
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

  describe("a refine-gate refusal", () => {
    const gated = () =>
      offlineConflict({
        reason: TRANSCRIPT_REFINE_REFUSAL,
        command: { type: DocumentCommand.ApproveEdits },
      });

    describe("when the details open", () => {
      const scrollIntoView = vi.fn();
      const original = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "scrollIntoView",
      );
      beforeEach(() => {
        scrollIntoView.mockReset();
        Element.prototype.scrollIntoView = scrollIntoView;
      });
      afterEach(() => {
        if (original) {
          Object.defineProperty(Element.prototype, "scrollIntoView", original);
        } else {
          Reflect.deleteProperty(Element.prototype, "scrollIntoView");
        }
      });

      function renderGated(conflict = gated(), project: string | null = "/p") {
        render(
          <GuestAttentionBannerView
            pending={0}
            conflicts={[conflict]}
            onDismissAll={vi.fn()}
            refineWaiverProject={project ?? undefined}
          />,
        );
        return screen
          .getByLabelText("Needs attention details and recovery actions")
          .closest("details") as HTMLDetailsElement;
      }

      it("brings the waiver form into view and leaves focus on the summary", () => {
        const details = renderGated();
        scrollIntoView.mockClear();
        details.open = true;
        fireEvent(details, new Event("toggle"));
        expect(scrollIntoView).toHaveBeenCalledOnce();
        expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
        expect(scrollIntoView.mock.contexts[0]).toBe(
          details.querySelector(".transcript-refine-recovery"),
        );
        expect(details.contains(document.activeElement)).toBe(false);
      });

      it("does not scroll when the details close", () => {
        const details = renderGated();
        scrollIntoView.mockClear();
        details.open = false;
        fireEvent(details, new Event("toggle"));
        expect(scrollIntoView).not.toHaveBeenCalled();
      });

      it("does not scroll when there is no waiver form", () => {
        const details = renderGated(gated(), null);
        scrollIntoView.mockClear();
        details.open = true;
        fireEvent(details, new Event("toggle"));
        expect(scrollIntoView).not.toHaveBeenCalled();
      });

      it("copes with a browser that cannot scroll an element into view", () => {
        const details = renderGated();
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
        details.open = true;
        expect(() => fireEvent(details, new Event("toggle"))).not.toThrow();
      });
    });

    it("lets the host waive from the banner and says to approve again", async () => {
      waive.mockResolvedValue({});
      render(
        <GuestAttentionBannerView
          pending={0}
          conflicts={[gated()]}
          onDismissAll={vi.fn()}
          refineWaiverProject="/p"
        />,
      );
      expandDetails();
      expect(screen.getByText(/^Approve:/)).toBeVisible();
      expect(
        screen.queryByText("Edit the change and submit it again."),
      ).not.toBeInTheDocument();
      await userEvent.type(
        screen.getByLabelText("Waiver reason"),
        "episode is a rerun",
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Waive with reason" }),
      );
      expect(waive).toHaveBeenCalledWith("/p", "episode is a rerun");
      const status = await screen.findByRole("status");
      expect(status).toHaveTextContent(
        "Waiver recorded. Retry approval to apply pending edits.",
      );
      expect(status).toHaveFocus();
      expect(
        screen.queryByRole("button", { name: "Waive with reason" }),
      ).not.toBeInTheDocument();
    });

    it("names Approve only for an approve command", () => {
      render(
        <GuestAttentionBannerView
          pending={0}
          conflicts={[
            offlineConflict({
              reason: TRANSCRIPT_REFINE_REFUSAL,
              command: {
                command_id: "tighten-1",
                type: DocumentCommand.RemoveTrack,
              },
            }),
          ]}
          onDismissAll={vi.fn()}
          refineWaiverProject="/p"
        />,
      );
      expandDetails();
      expect(screen.getByText(DocumentCommand.RemoveTrack)).toBeVisible();
      expect(screen.queryByText(/^Approve$/)).not.toBeInTheDocument();
    });

    it("clears every gated entry with one waiver", async () => {
      waive.mockResolvedValue({});
      render(
        <GuestAttentionBannerView
          pending={0}
          conflicts={[
            offlineConflict({
              reason: TRANSCRIPT_REFINE_REFUSAL,
              command: { command_id: "a-1" },
            }),
            offlineConflict({
              reason: TRANSCRIPT_REFINE_REFUSAL,
              command: { command_id: "a-2" },
            }),
          ]}
          onDismissAll={vi.fn()}
          refineWaiverProject="/p"
        />,
      );
      expandDetails();
      await userEvent.type(
        screen.getAllByLabelText("Waiver reason")[0],
        "rerun",
      );
      await userEvent.click(
        screen.getAllByRole("button", { name: "Waive with reason" })[0],
      );
      expect(await screen.findAllByRole("status")).toHaveLength(2);
      expect(
        screen.queryByRole("button", { name: "Waive with reason" }),
      ).not.toBeInTheDocument();
    });

    it("offers no waiver on an entry that was not refused", () => {
      render(
        <GuestAttentionBannerView
          pending={0}
          conflicts={[
            offlineConflict({
              kind: "unknown",
              recovery: "inspect-history",
              reason: TRANSCRIPT_REFINE_REFUSAL,
            }),
          ]}
          onDismissAll={vi.fn()}
          refineWaiverProject="/p"
        />,
      );
      expandDetails();
      expect(
        screen.queryByRole("button", { name: "Waive with reason" }),
      ).not.toBeInTheDocument();
    });

    it("offers the form again for a refusal that arrives after a waiver", async () => {
      waive.mockResolvedValue({});
      const entry = (id: string) =>
        offlineConflict({
          reason: TRANSCRIPT_REFINE_REFUSAL,
          command: { command_id: id },
        });
      const view = (ids: string[]) => (
        <GuestAttentionBannerView
          pending={0}
          conflicts={ids.map(entry)}
          onDismissAll={vi.fn()}
          refineWaiverProject="/p"
        />
      );
      const { rerender } = render(view(["first"]));
      expandDetails();
      await userEvent.type(screen.getByLabelText("Waiver reason"), "rerun");
      await userEvent.click(
        screen.getByRole("button", { name: "Waive with reason" }),
      );
      await screen.findByRole("status");
      rerender(view(["first", "second"]));
      expect(
        screen.getAllByRole("button", { name: "Waive with reason" }),
      ).toHaveLength(1);
      expect(screen.getAllByRole("status")).toHaveLength(1);
    });

    it("forgets a waiver once its entry leaves the list", async () => {
      waive.mockResolvedValue({});
      const gatedEntry = () =>
        offlineConflict({
          reason: TRANSCRIPT_REFINE_REFUSAL,
          command: { command_id: "same-id" },
        });
      const view = (entries: ReturnType<typeof gatedEntry>[]) => (
        <GuestAttentionBannerView
          pending={0}
          conflicts={entries}
          onDismissAll={vi.fn()}
          refineWaiverProject="/p"
        />
      );
      const { rerender } = render(view([gatedEntry()]));
      expandDetails();
      await userEvent.type(screen.getByLabelText("Waiver reason"), "rerun");
      await userEvent.click(
        screen.getByRole("button", { name: "Waive with reason" }),
      );
      await screen.findByRole("status");
      rerender(view([]));
      rerender(view([gatedEntry()]));
      expandDetails();
      expect(
        await screen.findByRole("button", { name: "Waive with reason" }),
      ).toBeVisible();
    });

    it("offers a guest no waiver", () => {
      render(
        <GuestAttentionBannerView
          pending={0}
          conflicts={[gated()]}
          onDismissAll={vi.fn()}
        />,
      );
      expandDetails();
      expect(
        screen.queryByRole("button", { name: "Waive with reason" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText("Edit the change and submit it again."),
      ).toBeVisible();
    });

    it("keeps other refusals on the edit-and-resubmit line", () => {
      render(
        <GuestAttentionBannerView
          pending={0}
          conflicts={[offlineConflict()]}
          onDismissAll={vi.fn()}
          refineWaiverProject="/p"
        />,
      );
      expandDetails();
      expect(
        screen.queryByRole("button", { name: "Waive with reason" }),
      ).not.toBeInTheDocument();
    });
  });
});

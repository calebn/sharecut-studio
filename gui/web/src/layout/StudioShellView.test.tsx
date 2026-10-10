import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { StudioShellView, type StudioShellViewProps } from "./StudioShellView";

function presentation(): StudioShellViewProps {
  return {
    appearance: { guestShare: false, following: false },
    layout: "default",
    chrome: {
      notices: { banners: null, follow: null },
      transport: (
        <header>
          <h1>Field notes</h1>
        </header>
      ),
      footer: <footer>Ready</footer>,
      overlay: null,
    },
    workspace: {
      kind: "arrange",
      canvas: (
        <section aria-label="Timeline">
          <p>Arranged clips</p>
        </section>
      ),
    },
    panels: {
      activeTab: "transcript",
      pipelineRunning: true,
      splitter: <span>Panel splitter</span>,
      content: <p>Transcript turn</p>,
      onTabChange: vi.fn(),
    },
    inspector: { kind: "desktop", content: null },
  };
}

describe("StudioShellView", () => {
  it("registers compact tablet feedback and releases it on stow or Close", () => {
    const props = presentation();
    const ref = vi.fn();
    const sheet = {
      open: true,
      expanded: false,
      content: <p>Fields</p>,
      onClose: vi.fn(),
      onExpandedChange: vi.fn(),
      compact: { className: "bottom-sheet--compact", stowed: false },
    };
    const { rerender } = render(
      <StudioShellView
        {...props}
        inspector={{ kind: "tablet", tools: null, sheet }}
        feedbackHostRef={ref}
      />,
    );
    expect(ref).toHaveBeenLastCalledWith(expect.any(HTMLDivElement));
    rerender(
      <StudioShellView
        {...props}
        inspector={{
          kind: "tablet",
          tools: null,
          sheet: { ...sheet, compact: { ...sheet.compact, stowed: true } },
        }}
        feedbackHostRef={ref}
      />,
    );
    expect(ref.mock.calls.at(-1)?.[0]).toBeNull();
    rerender(
      <StudioShellView
        {...props}
        inspector={{
          kind: "tablet",
          tools: null,
          sheet: { ...sheet, open: false },
        }}
        feedbackHostRef={ref}
      />,
    );
    expect(document.querySelector(".compact-feedback-slot")).toBeNull();
  });
  it("renders desktop chrome, six tabs, pressed state and navigation payload", async () => {
    const props = presentation();
    const { container } = render(<StudioShellView {...props} />);
    expect(container.querySelector(".daw-shell")).toHaveAttribute(
      "data-shell",
      "desktop",
    );
    expect(container.querySelector(".daw-shell")).toHaveAttribute(
      "class",
      "daw-shell daw-shell--attention daw-shell--desktop",
    );
    expect(screen.getByRole("main")).toHaveClass(
      "daw-main--arrange",
      "daw-main--inspector-collapsed",
    );
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const panels = screen.getByRole("region", { name: "Editor panels" });
    expect(
      within(panels)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual([
      "Transcript",
      "Comments",
      "History",
      "Impact",
      "Tighten",
      "Pipeline ●",
    ]);
    expect(
      within(panels).getByRole("button", { name: "Transcript" }),
    ).toHaveAttribute("data-presence-anchor", "tab:transcript");
    await userEvent.click(
      within(panels).getByRole("button", { name: "Comments" }),
    );
    expect(props.panels.onTabChange).toHaveBeenCalledWith("comments");
    expect(
      within(panels).getByRole("button", { name: "Transcript" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expectNoA11yViolations(document.body);
  });

  it("preserves root, transport, main and panels refs", () => {
    const props = presentation();
    const root = createRef<HTMLDivElement>();
    const transport = createRef<HTMLDivElement>();
    const main = createRef<HTMLElement>();
    const panels = createRef<HTMLElement>();
    const { container } = render(
      <StudioShellView
        {...props}
        bindings={{ root, transport, main, panels }}
      />,
    );
    expect(root.current).toBe(container.querySelector(".daw-shell"));
    expect(transport.current).toBe(
      container.querySelector(".daw-shell > .daw-shell-transport"),
    );
    expect(main.current).toBe(screen.getByRole("main"));
    expect(panels.current).toBe(
      screen.getByRole("region", { name: "Editor panels" }),
    );
  });

  it.each(["history", "impact", "tighten", "pipeline"] as const)(
    "hides stale guest %s content and host-only tabs",
    async (activeTab) => {
      const props = presentation();
      props.appearance.guestShare = true;
      props.panels.activeTab = activeTab;
      props.panels.content = <p>Host panel</p>;
      const { rerender } = render(<StudioShellView {...props} />);
      expect(
        within(screen.getByRole("region", { name: "Editor panels" }))
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(["Transcript", "Comments"]);
      expect(screen.queryByText("Host panel")).toBeNull();
      await expectNoA11yViolations(document.body);
      rerender(
        <StudioShellView
          {...props}
          appearance={{ guestShare: false, following: false }}
        />,
      );
      expect(screen.getByText("Host panel")).toBeInTheDocument();
    },
  );

  it("distinguishes loading from ingest and arrangement", async () => {
    const props = presentation();
    props.workspace = {
      kind: "loading",
      headers: <p>Track headers</p>,
      canvas: <p aria-label="Loading timeline">Timeline skeleton</p>,
    };
    const { rerender } = render(<StudioShellView {...props} />);
    expect(screen.getByRole("main")).not.toHaveClass("daw-main--arrange");
    expect(screen.getByLabelText("Loading timeline")).toHaveTextContent(
      "Timeline skeleton",
    );
    expect(
      screen.queryByRole("button", { name: "Drop audio files or import" }),
    ).toBeNull();
    await expectNoA11yViolations(document.body);
    rerender(<StudioShellView {...presentation()} />);
    expect(screen.getByRole("main")).toHaveClass("daw-main--arrange");
    expect(screen.getByRole("main")).toHaveTextContent("Arranged clips");
  });

  it("owns ingest drop and coach markup and forwards DOM events and import", async () => {
    const props = presentation();
    const onDragOver = vi.fn();
    const onDrop = vi.fn();
    const onDragLeave = vi.fn();
    const onImport = vi.fn();
    const onDismissCoach = vi.fn();
    props.workspace = {
      kind: "ingest",
      headers: <p>Track headers</p>,
      ingest: {
        over: true,
        dropLabel: "Add 2 tracks",
        importShortcut: "Ctrl+I",
        coachOpen: true,
        onDragOver,
        onDrop,
        onDragLeave,
        onImport,
        onDismissCoach,
      },
    };
    render(<StudioShellView {...props} />);
    const target = screen.getByRole("button", {
      name: "Drop audio files or import",
    });
    expect(target).toHaveClass("lane-drop-target");
    expect(target).toHaveTextContent("Add 2 tracks");
    expect(target.querySelector(".empty-session-ghost")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    fireEvent.dragOver(target, { dataTransfer: { dropEffect: "copy" } });
    fireEvent.drop(target);
    fireEvent.dragLeave(target);
    expect(onDragOver.mock.calls[0][0].type).toBe("dragover");
    expect(onDrop.mock.calls[0][0].type).toBe("drop");
    expect(onDragLeave.mock.calls[0][0].type).toBe("dragleave");
    await userEvent.click(target);
    expect(onImport.mock.calls).toEqual([[]]);
    await userEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(onDismissCoach.mock.calls).toEqual([[]]);
    expect(screen.getByRole("status")).toHaveTextContent("Menu (Ctrl+I)");
    await expectNoA11yViolations(document.body);
  });

  it("renders tablet tools and sheet and omits the splitter in text focus", async () => {
    const props = presentation();
    const onClose = vi.fn();
    const onExpandedChange = vi.fn();
    props.layout = "text";
    props.inspector = {
      kind: "tablet",
      tools: <p>Select tool rail</p>,
      sheet: {
        open: true,
        expanded: true,
        content: <p>Selected track</p>,
        onClose,
        onExpandedChange,
      },
    };
    const { container } = render(<StudioShellView {...props} />);
    expect(container.querySelector(".daw-shell")).toHaveClass(
      "daw-shell--tablet",
      "daw-shell--layout-text",
    );
    expect(screen.getByRole("main")).toHaveTextContent("Select tool rail");
    expect(screen.queryByText("Panel splitter")).toBeNull();
    const dialog = screen.getByRole("dialog", { name: "Inspector" });
    expect(dialog).toHaveAttribute("aria-modal", "false");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Collapse" }),
    );
    expect(onExpandedChange).toHaveBeenCalledWith(false);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Close" }),
    );
    expect(onClose.mock.calls).toEqual([[]]);
    await expectNoA11yViolations(document.body);
  });
});

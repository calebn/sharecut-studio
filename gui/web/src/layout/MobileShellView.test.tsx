import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { MobileShellView, type MobileShellViewProps } from "./MobileShellView";

function presentation(): MobileShellViewProps {
  return {
    appearance: { guestShare: false, following: false },
    chrome: {
      notices: { banners: null, follow: null },
      announcement: "Playback paused",
      transport: (
        <header>
          <h1>Field notes</h1>
        </header>
      ),
      status: <span>REC 0:12</span>,
      overlay: null,
    },
    screen: {
      kind: "listen",
      content: (
        <section aria-label="Episode">
          <h1>Field notes</h1>
          <p>Ready to listen</p>
        </section>
      ),
    },
    onModeChange: vi.fn(),
    sheet: { kind: "closed" },
  };
}

describe("MobileShellView", () => {
  it("registers feedback only for an open, unstowed compact inspector", () => {
    const props = presentation();
    const ref = vi.fn();
    const compact = { className: "bottom-sheet--compact", stowed: false };
    const sheet = {
      kind: "inspector",
      content: <p>Fields</p>,
      expanded: false,
      onExpandedChange: vi.fn(),
      onClose: vi.fn(),
      compact,
    } satisfies MobileShellViewProps["sheet"];
    const { rerender } = render(
      <MobileShellView {...props} sheet={sheet} feedbackHostRef={ref} />,
    );
    expect(ref).toHaveBeenLastCalledWith(expect.any(HTMLDivElement));
    rerender(
      <MobileShellView
        {...props}
        sheet={{ ...sheet, compact: { ...compact, stowed: true } }}
        feedbackHostRef={ref}
      />,
    );
    expect(ref.mock.calls.at(-1)?.[0]).toBeNull();
    expect(document.querySelector(".compact-feedback-slot")).toBeNull();
    rerender(
      <MobileShellView
        {...props}
        sheet={{ ...sheet, compact: undefined }}
        feedbackHostRef={ref}
      />,
    );
    expect(document.querySelector(".compact-feedback-slot")).toBeNull();
    rerender(
      <MobileShellView
        {...props}
        sheet={{ kind: "closed" }}
        feedbackHostRef={ref}
      />,
    );
    expect(document.querySelector(".compact-feedback-slot")).toBeNull();
  });

  it("renders Listen with one heading, recording first, and all primary modes", async () => {
    const props = presentation();
    const { container } = render(<MobileShellView {...props} />);
    expect(container.querySelector(".daw-shell")).toHaveAttribute(
      "data-shell",
      "phone",
    );
    expect(container.querySelector(".daw-shell")).toHaveAttribute(
      "class",
      "daw-shell daw-shell--phone daw-shell--listen daw-shell--attention",
    );
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("main").firstElementChild).toHaveTextContent(
      "REC 0:12",
    );
    expect(container.querySelector(".daw-shell-transport")).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(
      within(nav)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Listen", "Timeline", "Text", "More"]);
    expect(within(nav).getByRole("button", { name: "Listen" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent(
      "Playback paused",
    );
    await userEvent.click(
      within(nav).getByRole("button", { name: "Timeline" }),
    );
    expect(props.onModeChange).toHaveBeenCalledWith("timeline");
    await expectNoA11yViolations(document.body);
  });

  it.each(["timeline", "text", "more"] as const)(
    "attaches original refs and transport in %s",
    (kind) => {
      const props = presentation();
      const root = createRef<HTMLDivElement>();
      const transport = createRef<HTMLDivElement>();
      const text = createRef<HTMLDivElement>();
      const more = createRef<HTMLDivElement>();
      props.bindings = { root, transport, text, more };
      props.screen =
        kind === "timeline"
          ? { kind, canvas: <p>Timeline canvas</p>, tools: <p>Select tools</p> }
          : kind === "text"
            ? { kind, content: <p>Transcript turn</p> }
            : {
                kind,
                destination: "comments",
                content: <p>Review comment</p>,
                onBack: vi.fn(),
              };
      const { container } = render(<MobileShellView {...props} />);
      expect(root.current).toBe(container.querySelector(".daw-shell"));
      expect(transport.current).toBe(
        container.querySelector(".daw-shell > .daw-shell-transport"),
      );
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        "Field notes",
      );
      expect(screen.getByRole("main")).toHaveTextContent(
        kind === "timeline"
          ? "Timeline canvasSelect tools"
          : kind === "text"
            ? "Transcript turn"
            : "Review comment",
      );
      if (kind === "text")
        expect(text.current).toBe(container.querySelector(".mobile-text-mode"));
      if (kind === "more")
        expect(more.current).toBe(container.querySelector(".mobile-more-mode"));
    },
  );

  it("renders More back and forwards its action", async () => {
    const props = presentation();
    const onBack = vi.fn();
    props.screen = {
      kind: "more",
      destination: "comments",
      content: <p>Review comment</p>,
      onBack,
    };
    render(<MobileShellView {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "← More" }));
    expect(onBack.mock.calls).toEqual([[]]);
    expect(screen.getByRole("main")).toHaveTextContent("Review comment");
    await expectNoA11yViolations(document.body);
  });

  it.each(["history", "impact", "tighten", "pipeline"] as const)(
    "suppresses guest %s while retaining guest chrome",
    (destination) => {
      const props = presentation();
      props.appearance = { guestShare: true, following: true };
      props.screen = {
        kind: "more",
        destination,
        content: <p>Host panel</p>,
        onBack: vi.fn(),
      };
      const { container, rerender } = render(<MobileShellView {...props} />);
      expect(container.querySelector(".daw-shell")).toHaveClass(
        "daw-shell-guest",
        "daw-shell--following",
      );
      expect(screen.queryByText("Host panel")).toBeNull();
      expect(screen.queryByRole("button", { name: "← More" })).toBeNull();
      rerender(
        <MobileShellView
          {...props}
          appearance={{ guestShare: false, following: false }}
        />,
      );
      expect(screen.getByText("Host panel")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "← More" }),
      ).toBeInTheDocument();
    },
  );

  it("keeps the inspector background interactive and forwards expand and close", async () => {
    const props = presentation();
    const onClose = vi.fn();
    const onExpandedChange = vi.fn();
    props.sheet = {
      kind: "inspector",
      expanded: false,
      content: <p>Selected track</p>,
      onClose,
      onExpandedChange,
    };
    render(<MobileShellView {...props} />);
    const dialog = screen.getByRole("dialog", { name: "Inspector" });
    expect(dialog).toHaveAttribute("aria-modal", "false");
    expect(dialog).toHaveTextContent("Selected track");
    expect(
      document.querySelector(".bottom-sheet-scrim--interactive"),
    ).toHaveAttribute("aria-hidden", "true");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Expand" }),
    );
    expect(onExpandedChange).toHaveBeenCalledWith(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(vi.mocked(onClose).mock.calls).toEqual([[]]);
    await expectNoA11yViolations(document.body);
  });
});

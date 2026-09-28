import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import {
  InspectorSeekFooterView,
  type InspectorSeekFooterViewProps,
} from "./InspectorSeekFooterView";

describe("InspectorSeekFooterView", () => {
  it("renders seek and play actions and calls back", async () => {
    const onSeek = vi.fn();
    const onPlay = vi.fn();
    const { container } = render(
      <InspectorSeekFooterView onSeek={onSeek} onPlay={onPlay} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Seek" }));
    expect(onSeek).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Play around" }));
    expect(onPlay).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });

  it("hides play when showPlay is false and uses custom labels", () => {
    render(
      <InspectorSeekFooterView
        onSeek={vi.fn()}
        onPlay={vi.fn()}
        showPlay={false}
        seekLabel="Seek to start"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Seek to start" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Play around" })).toBeNull();
  });

  it("renders preview modes and reports changes", async () => {
    const onMode = vi.fn();
    const { container } = render(
      <InspectorSeekFooterView
        onSeek={vi.fn()}
        onPlay={vi.fn()}
        previewMode="suggested"
        onPreviewModeChange={onMode}
      />,
    );
    const previewGroup = screen.getByRole("group", { name: "Preview mode" });
    expect(previewGroup.classList.contains("ui-segmented")).toBe(true);
    expect(screen.getByRole("button", { name: "Suggested" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "A/B" }));
    expect(onMode).toHaveBeenCalledWith("ab");
    await expectNoA11yViolations(container);
  });

  it("blocks Suggested and A/B with a described reason", () => {
    const reason = "A split does not change the mix until you delete a side.";
    render(
      <InspectorSeekFooterView
        onSeek={vi.fn()}
        onPlay={vi.fn()}
        previewMode="current"
        onPreviewModeChange={vi.fn()}
        suggestDisabled
        suggestDisabledReason={reason}
      />,
    );
    const suggested = screen.getByRole("button", { name: "Suggested" });
    const ab = screen.getByRole("button", { name: "A/B" });
    expect(suggested).toBeDisabled();
    expect(ab).toBeDisabled();
    const reasonEl = screen.getByText(reason);
    expect(reasonEl.id).not.toBe("");
    expect(suggested).toHaveAttribute("aria-describedby", reasonEl.id);
    expect(ab).toHaveAttribute("aria-describedby", reasonEl.id);
    expect(suggested).toHaveAttribute("title", reason);
    expect(ab).toHaveAttribute("title", reason);
    expect(screen.getByRole("button", { name: "Current" })).toBeEnabled();
  });

  it("gives each footer its own reason id", async () => {
    const reason = "A split does not change the mix until you delete a side.";
    const props: InspectorSeekFooterViewProps = {
      onSeek: vi.fn(),
      onPlay: vi.fn(),
      previewMode: "current",
      onPreviewModeChange: vi.fn(),
      suggestDisabled: true,
      suggestDisabledReason: reason,
    };
    const { container } = render(
      <>
        <InspectorSeekFooterView {...props} />
        <InspectorSeekFooterView {...props} />
      </>,
    );
    const [first, second] = screen.getAllByText(reason);
    expect(first.id).not.toBe(second.id);
    const suggested = screen.getAllByRole("button", { name: "Suggested" });
    expect(suggested[0]).toHaveAttribute("aria-describedby", first.id);
    expect(suggested[1]).toHaveAttribute("aria-describedby", second.id);
    await expectNoA11yViolations(container);
  });

  it("omits the reason and preview group without onPreviewModeChange", () => {
    render(
      <InspectorSeekFooterView
        onSeek={vi.fn()}
        onPlay={vi.fn()}
        suggestDisabled
        suggestDisabledReason="A split does not change the mix until you delete a side."
      />,
    );
    expect(screen.queryByRole("group")).toBeNull();
    expect(
      screen.queryByText(
        "A split does not change the mix until you delete a side.",
      ),
    ).toBeNull();
  });

  it("renders seek and play as buttons with icons", () => {
    const props: InspectorSeekFooterViewProps = {
      onSeek: vi.fn(),
      onPlay: vi.fn(),
    };
    render(<InspectorSeekFooterView {...props} />);
    for (const name of ["Seek", "Play around"]) {
      const button = screen.getByRole("button", { name });
      expect(button).not.toHaveClass("linkish");
      expect(button).toHaveClass("modifier-action");
      expect(
        button.querySelector("svg.ui-icon[aria-hidden='true']"),
      ).not.toBeNull();
    }
  });

  it("disables Play with a tooltip reason but leaves Seek enabled", () => {
    render(
      <InspectorSeekFooterView
        onSeek={vi.fn()}
        onPlay={vi.fn()}
        playDisabled
        playDisabledReason="Guests listen in Mix"
      />,
    );
    const play = screen.getByRole("button", { name: "Play around" });
    expect(play).toBeDisabled();
    expect(play).toHaveAttribute("title", "Guests listen in Mix");
    expect(screen.getByRole("button", { name: "Seek" })).not.toBeDisabled();
  });
});

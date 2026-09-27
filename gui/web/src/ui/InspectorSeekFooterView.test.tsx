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
    expect(suggested).toHaveAttribute(
      "aria-describedby",
      "preview-mode-skip-reason",
    );
    expect(ab).toHaveAttribute("aria-describedby", "preview-mode-skip-reason");
    expect(suggested).toHaveAttribute("title", reason);
    expect(ab).toHaveAttribute("title", reason);
    expect(screen.getByRole("button", { name: "Current" })).toBeEnabled();
    expect(screen.getByText(reason)).toBeInTheDocument();
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
      document.getElementById("preview-mode-skip-reason"),
    ).not.toBeInTheDocument();
  });

  it("switches action variant", () => {
    const props: InspectorSeekFooterViewProps = {
      onSeek: vi.fn(),
      onPlay: vi.fn(),
    };
    const { rerender } = render(<InspectorSeekFooterView {...props} />);
    const link = screen.getByRole("button", { name: "Seek" }).className;
    rerender(<InspectorSeekFooterView {...props} actionVariant="default" />);
    expect(screen.getByRole("button", { name: "Seek" }).className).not.toBe(
      link,
    );
  });
});

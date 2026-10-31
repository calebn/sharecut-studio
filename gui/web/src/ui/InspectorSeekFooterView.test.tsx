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

  it("shows a pulse and the seconds elapsed while play is preparing", async () => {
    const { container } = render(
      <InspectorSeekFooterView
        onSeek={vi.fn()}
        onPlay={vi.fn()}
        playBusySec={7}
        playDisabledReason="Preparing full mix preview"
      />,
    );
    const play = screen.getByRole("button", {
      name: "Preparing this preview… 7s",
    });
    expect(play).toHaveAttribute("aria-busy", "true");
    expect(container.querySelector(".pipeline-pulse")).not.toBeNull();
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
        suggestDisabledReason={reason}
      />,
    );
    const suggested = screen.getByRole("button", { name: "Suggested" });
    const ab = screen.getByRole("button", { name: "A/B" });
    expect(suggested).toBeDisabled();
    expect(ab).toBeDisabled();
    expect(suggested).toHaveAccessibleDescription(reason);
    expect(ab).toHaveAccessibleDescription(reason);
    expect(suggested).toHaveAttribute("title", reason);
    expect(ab).toHaveAttribute("title", reason);
    expect(screen.getByRole("button", { name: "Current" })).toBeEnabled();
  });

  it("keeps an unavailable play focusable and says why, on touch and by key", async () => {
    const reason = "Guests hear the full mix. Ask the host for editor access.";
    const onPlay = vi.fn();
    const { container } = render(
      <InspectorSeekFooterView
        onSeek={vi.fn()}
        onPlay={onPlay}
        playLabel="Preview effects at track start"
        playDisabledReason={reason}
      />,
    );
    const play = screen.getByRole("button", {
      name: "Preview effects at track start",
    });
    expect(play).toBeEnabled();
    expect(play).toHaveAttribute("aria-disabled", "true");
    expect(play).not.toHaveAttribute("title");
    expect(play).toHaveAccessibleDescription(reason);
    expect(screen.getByText(reason)).toBeVisible();
    play.focus();
    expect(play).toHaveFocus();
    fireEvent.click(play);
    expect(onPlay).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  it("refuses a second press and shows no note before the seconds appear", () => {
    const onPlay = vi.fn();
    render(
      <InspectorSeekFooterView
        onSeek={vi.fn()}
        onPlay={onPlay}
        playPreparing
      />,
    );
    const play = screen.getByRole("button", { name: "Play around" });
    expect(play).toHaveAttribute("aria-busy", "true");
    expect(play).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(play);
    expect(onPlay).not.toHaveBeenCalled();
    expect(document.querySelector(".export-dialog-note")).toBeNull();
  });

  it("shows no note while play is preparing, even with a reason, and refuses a press", () => {
    const onPlay = vi.fn();
    render(
      <InspectorSeekFooterView
        onSeek={vi.fn()}
        onPlay={onPlay}
        playBusySec={3}
        playDisabledReason="Guests hear the full mix."
      />,
    );
    const play = screen.getByRole("button", {
      name: "Preparing this preview… 3s",
    });
    expect(play).toHaveAttribute("aria-disabled", "true");
    expect(play).not.toHaveAttribute("aria-describedby");
    fireEvent.click(play);
    expect(onPlay).not.toHaveBeenCalled();
    expect(screen.queryByText("Guests hear the full mix.")).toBeNull();
  });

  it("plays again once the reason is removed", () => {
    const onPlay = vi.fn();
    const { rerender } = render(
      <InspectorSeekFooterView
        onSeek={vi.fn()}
        onPlay={onPlay}
        playDisabledReason="Guests hear the full mix."
      />,
    );
    const play = screen.getByRole("button", { name: "Play around" });
    fireEvent.click(play);
    expect(onPlay).not.toHaveBeenCalled();
    rerender(<InspectorSeekFooterView onSeek={vi.fn()} onPlay={onPlay} />);
    expect(play).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByText("Guests hear the full mix.")).toBeNull();
    fireEvent.click(play);
    expect(onPlay).toHaveBeenCalledOnce();
  });

  it("gives each disabled preview mode its reason", async () => {
    const reason = "A split does not change the mix until you delete a side.";
    const props: InspectorSeekFooterViewProps = {
      onSeek: vi.fn(),
      onPlay: vi.fn(),
      previewMode: "current",
      onPreviewModeChange: vi.fn(),
      suggestDisabledReason: reason,
    };
    const { container } = render(
      <>
        <InspectorSeekFooterView {...props} />
        <InspectorSeekFooterView {...props} />
      </>,
    );
    const suggested = screen.getAllByRole("button", { name: "Suggested" });
    expect(suggested[0]).toHaveAccessibleDescription(reason);
    expect(suggested[1]).toHaveAccessibleDescription(reason);
    await expectNoA11yViolations(container);
  });

  it("omits the reason and preview group without onPreviewModeChange", () => {
    render(
      <InspectorSeekFooterView
        onSeek={vi.fn()}
        onPlay={vi.fn()}
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

  it("makes Play unavailable with a described reason but leaves Seek enabled", () => {
    render(
      <InspectorSeekFooterView
        onSeek={vi.fn()}
        onPlay={vi.fn()}
        playDisabledReason="Guests listen in Mix"
      />,
    );
    const play = screen.getByRole("button", { name: "Play around" });
    expect(play).toHaveAttribute("aria-disabled", "true");
    expect(play).toHaveAccessibleDescription("Guests listen in Mix");
    expect(screen.getByRole("button", { name: "Seek" })).not.toBeDisabled();
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { InspectorSeekFooter } from "./InspectorSeekFooter";

describe("InspectorSeekFooter", () => {
  beforeEach(() => {
    useDawStore
      .getState()
      .hydrate("/tmp/test/episode.project.json", minimalProject());
    useDawStore.setState({
      playheadSec: 0,
      playUntilSec: null,
      isPlaying: false,
    });
  });

  it("seeks playhead on Seek", async () => {
    const user = userEvent.setup();
    render(<InspectorSeekFooter seekSec={10} playStart={10} playEnd={12} />);
    await user.click(screen.getByRole("button", { name: "Seek" }));
    expect(useDawStore.getState().playheadSec).toBe(10);
  });

  it("plays around range with padding", async () => {
    const user = userEvent.setup();
    render(
      <InspectorSeekFooter
        seekSec={10}
        playStart={10}
        playEnd={12}
        padSec={0.5}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Play around" }));
    const s = useDawStore.getState();
    expect(s.playheadSec).toBe(9.5);
    expect(s.playUntilSec).toBe(12.5);
    expect(s.isPlaying).toBe(true);
  });

  it("offers preview modes and plays Suggested skip", async () => {
    const user = userEvent.setup();
    const onMode = vi.fn();
    render(
      <InspectorSeekFooter
        seekSec={10}
        playStart={10}
        playEnd={12}
        padSec={0.5}
        previewMode="suggested"
        onPreviewModeChange={onMode}
      />,
    );
    expect(screen.getByRole("group", { name: "Preview mode" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Play around" }));
    const s = useDawStore.getState();
    expect(s.playheadSec).toBe(9.5);
    expect(s.playUntilSec).toBe(12.5);
    expect(s.playSkipStartSec).toBe(10);
    expect(s.playSkipEndSec).toBe(12);
    expect(s.isPlaying).toBe(true);
    await user.click(screen.getByRole("button", { name: "Current" }));
    expect(onMode).toHaveBeenCalledWith("current");
  });

  it("disables Suggested and A/B when skip is unavailable", () => {
    render(
      <InspectorSeekFooter
        seekSec={1}
        playStart={1}
        playEnd={1}
        previewMode="current"
        onPreviewModeChange={() => undefined}
        suggestDisabled
        suggestDisabledReason="A split does not change the mix until you delete a side."
      />,
    );
    expect(screen.getByRole("button", { name: "Suggested" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "A/B" })).toBeDisabled();
    expect(screen.getByText(/split does not change the mix/i)).toBeTruthy();
  });

  it("hides play when showPlay is false", () => {
    render(
      <InspectorSeekFooter
        seekSec={1}
        playStart={1}
        playEnd={2}
        showPlay={false}
        seekLabel="Seek join"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Seek join" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Play around" })).toBeNull();
  });

  it("is axe-clean including preview modes", async () => {
    const { container } = render(
      <InspectorSeekFooter
        seekSec={1}
        playStart={1}
        playEnd={2}
        previewMode="suggested"
        onPreviewModeChange={() => undefined}
      />,
    );
    expect(screen.getByRole("group", { name: "Preview mode" })).toBeTruthy();
    await expectNoA11yViolations(container);
  });
});

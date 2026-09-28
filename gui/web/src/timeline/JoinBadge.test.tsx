import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setClipJoin } from "../api";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { JoinBadge, JoinBadgeView } from "./JoinBadge";

vi.mock("../api", () => ({
  setClipJoin: vi.fn(async () => undefined),
}));

describe("JoinBadgeView", () => {
  it("renders a named button for the fade glyph at the seam", async () => {
    const { container } = render(
      <JoinBadgeView
        glyph="fade"
        blocked={false}
        seamSec={2}
        zoomPxPerSec={50}
        expanded={false}
        onClick={vi.fn()}
      />,
    );
    const badge = screen.getByRole("button", { name: "Fade join at 0:02.0" });
    expect(badge.className).toContain("join-badge");
    expect(badge.className).toContain("join-badge--fade");
    expect(badge.className).not.toContain("join-badge--blocked");
    expect(badge.style.left).toBe("100px");
    const path = container.querySelector("svg path");
    expect(path?.getAttribute("d")).toBe("M1 2L6 10L11 2");
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    await expectNoA11yViolations(container);
  });

  it.each([
    ["cut", "M6 1V11", "Cut"],
    ["fade", "M1 2L6 10L11 2", "Fade"],
    ["crossfade", "M1 1L11 11M11 1L1 11", "Crossfade"],
  ] as const)("draws the %s glyph", async (glyph, path, word) => {
    const { container } = render(
      <JoinBadgeView
        glyph={glyph}
        blocked={false}
        seamSec={2}
        zoomPxPerSec={50}
        expanded={false}
        onClick={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: `${word} join at 0:02.0` }),
    ).toHaveClass(`join-badge--${glyph}`);
    expect(container.querySelector("svg path")?.getAttribute("d")).toBe(path);
    await expectNoA11yViolations(container);
  });

  it("marks a blocked crossfade in its class and name", async () => {
    const { container } = render(
      <JoinBadgeView
        glyph="crossfade"
        blocked
        seamSec={2}
        zoomPxPerSec={50}
        expanded={false}
        onClick={vi.fn()}
      />,
    );
    const badge = screen.getByRole("button", {
      name: "Crossfade join at 0:02.0, will not blend",
    });
    expect(badge).toHaveClass("join-badge--blocked");
    await expectNoA11yViolations(container);
  });

  it("announces itself as a popover trigger", () => {
    render(
      <JoinBadgeView
        glyph="fade"
        blocked={false}
        seamSec={2}
        zoomPxPerSec={50}
        expanded={false}
        onClick={vi.fn()}
      />,
    );
    const badge = screen.getByRole("button");
    expect(badge).toHaveAttribute("aria-haspopup", "dialog");
    expect(badge).toHaveAttribute("aria-expanded", "false");
  });

  it("rounds the label and positions in px", () => {
    render(
      <JoinBadgeView
        glyph="fade"
        blocked={false}
        seamSec={65.25}
        zoomPxPerSec={10}
        expanded={false}
        onClick={vi.fn()}
      />,
    );
    const badge = screen.getByRole("button", { name: "Fade join at 1:05.3" });
    expect(badge.style.left).toBe("652.5px");
  });
});

const left = clipRow({
  id: "c0",
  source_start: 0,
  source_end: 5,
  timeline_start: 0,
  timeline_end: 5,
});
const right = clipRow({
  id: "c1",
  source_start: 5,
  source_end: 10,
  timeline_start: 5,
  timeline_end: 10,
  fade_in_ms: 10,
  join_left_clip_id: "c0",
  join_in_mode: "fade",
});
const left2 = clipRow({
  id: "d0",
  source_start: 0,
  source_end: 5,
  timeline_start: 0,
  timeline_end: 5,
});
const right2 = clipRow({
  id: "d1",
  source_start: 5,
  source_end: 10,
  timeline_start: 5,
  timeline_end: 10,
  fade_in_ms: 10,
  join_left_clip_id: "d0",
  join_in_mode: "fade",
});

describe("JoinBadge (live)", () => {
  beforeEach(() => {
    useDawStore
      .getState()
      .hydrate("/tmp/ep.json", minimalProject({ tracks: [sampleTrack()] }));
    useDawStore.setState({ openJoinId: null });
  });

  it("opens and closes the join popover, and closes on Escape with focus restored", async () => {
    const user = userEvent.setup();
    render(
      <JoinBadge
        left={left}
        right={right}
        seamSec={5}
        zoomPxPerSec={50}
        trackFadeMaxMs={null}
      />,
    );
    const badge = screen.getByRole("button", { name: "Fade join at 0:05.0" });
    expect(badge).toHaveAttribute("aria-expanded", "false");
    await user.click(badge);
    expect(badge).toHaveAttribute("aria-expanded", "true");
    const dialog = screen.getByRole("dialog", { name: "Fade join at 0:05.0" });
    expect(badge.getAttribute("aria-controls")).toBe(dialog.id);
    await user.click(badge);
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(badge);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(badge).toHaveFocus();
  });

  it("has no axe violations while open", async () => {
    render(
      <JoinBadge
        left={left}
        right={right}
        seamSec={5}
        zoomPxPerSec={50}
        trackFadeMaxMs={null}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Fade join at 0:05.0" }),
    );
    await expectNoA11yViolations(document.body);
  });

  it("keeps one join popover open: opening another badge by keyboard closes the first", async () => {
    const user = userEvent.setup();
    render(
      <>
        <JoinBadge
          left={left}
          right={right}
          seamSec={5}
          zoomPxPerSec={50}
          trackFadeMaxMs={null}
        />
        <JoinBadge
          left={left2}
          right={right2}
          seamSec={5}
          zoomPxPerSec={50}
          trackFadeMaxMs={null}
        />
      </>,
    );
    const [a, b] = screen.getAllByRole("button", {
      name: "Fade join at 0:05.0",
    });
    await user.click(a);
    b.focus();
    await user.keyboard("{Enter}");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(a).toHaveAttribute("aria-expanded", "false");
    expect(b).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(b).toHaveFocus();
  });

  it("closes its popover when the badge unmounts", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <JoinBadge
        left={left}
        right={right}
        seamSec={5}
        zoomPxPerSec={50}
        trackFadeMaxMs={null}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Fade join at 0:05.0" }),
    );
    expect(useDawStore.getState().openJoinId).toBe("c1");
    unmount();
    expect(useDawStore.getState().openJoinId).toBeNull();
  });

  it("the badge does not close its popover while SetClipJoin is in flight", async () => {
    vi.mocked(setClipJoin).mockImplementationOnce(() => new Promise(() => {}));
    const user = userEvent.setup();
    render(
      <JoinBadge
        left={left}
        right={right}
        seamSec={5}
        zoomPxPerSec={50}
        trackFadeMaxMs={null}
      />,
    );
    const badge = screen.getByRole("button", { name: "Fade join at 0:05.0" });
    await user.click(badge);
    await user.click(screen.getByRole("button", { name: "Crossfade" }));
    await user.click(badge);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

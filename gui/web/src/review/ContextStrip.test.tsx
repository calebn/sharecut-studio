import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { ContextStrip } from "./ContextStrip";
import type { ReviewItem } from "./reviewQueueModel";

const item = (id: string, at: number): ReviewItem => ({
  id,
  kind: "suggestion",
  at,
  savedSeconds: 1,
});

describe("ContextStrip", () => {
  it("draws no tick for an unplaced item and does not throw", () => {
    const { container } = render(
      <ContextStrip
        items={[item("a", 30), item("u", Number.POSITIVE_INFINITY)]}
        duration={60}
        selectedId="u"
      />,
    );
    expect(container.querySelectorAll(".sys-overview-tick")).toHaveLength(1);
  });

  describe("seeking", () => {
    beforeEach(() => {
      clearRegisteredCommands();
      registerDawCommands();
      useDawStore.setState({
        playheadSec: 0,
        guestMode: "comment",
        project: minimalProject({ timeline_duration_sec: 60 }),
      });
    });

    it("seeks the transport to the clicked spot, even for a guest", async () => {
      render(<ContextStrip items={[]} duration={60} selectedId={null} />);
      const strip = screen.getByRole("slider", { name: "Episode overview" });
      vi.spyOn(strip, "getBoundingClientRect").mockReturnValue({
        left: 0,
        width: 200,
        right: 200,
        top: 0,
        bottom: 32,
        height: 32,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      fireEvent.click(strip, { clientX: 50, detail: 1 });
      await waitFor(() => expect(useDawStore.getState().playheadSec).toBe(15));
    });

    it("puts a comment clip's playhead and auto-stop bound back when a drag is cancelled", async () => {
      render(<ContextStrip items={[]} duration={60} selectedId={null} />);
      const strip = screen.getByRole("slider", { name: "Episode overview" });
      vi.spyOn(strip, "getBoundingClientRect").mockReturnValue({
        left: 0,
        width: 200,
        right: 200,
        top: 0,
        bottom: 32,
        height: 32,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      act(() =>
        useDawStore.getState().beginAudition({ playheadSec: 10, untilSec: 14 }),
      );
      fireEvent.pointerDown(strip, { pointerId: 1, clientX: 40 });
      fireEvent.pointerMove(strip, { pointerId: 1, clientX: 120 });
      await waitFor(() => expect(useDawStore.getState().playheadSec).toBe(36));
      expect(useDawStore.getState().playUntilSec).toBeNull();
      fireEvent.keyDown(document.body, { key: "Escape" });
      await waitFor(() => expect(useDawStore.getState().playheadSec).toBe(10));
      expect(useDawStore.getState().playUntilSec).toBe(14);
    });
  });
});

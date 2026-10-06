import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { InspectorPeek } from "./InspectorPeek";
import { peekTarget } from "./peekTarget";

const api = vi.hoisted(() => ({ setClipFade: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  setClipFade: api.setClipFade,
}));

const clip = clipRow({
  id: "c2",
  track_id: "host",
  source_start: 10,
  source_end: 40,
  timeline_start: 10,
  timeline_end: 40,
  fade_in_ms: 300,
});
const project = minimalProject({
  tracks: [sampleTrack({ id: "host" })],
  clips: { tracks: { host: [clip] }, clip_count: 1 },
});
const announce = vi.fn<(message: string) => void>();

function peekAt(fadeInMs: number) {
  const p = minimalProject({
    ...project,
    clips: {
      tracks: { host: [{ ...clip, fade_in_ms: fadeInMs }] },
      clip_count: 1,
    },
  });
  useDawStore.getState().hydrate("/tmp/p.json", p, null);
  useDawStore.setState({ announceStatus: announce });
  const peek = peekTarget(
    p,
    { kind: "clip", id: "c2", trackId: "host" },
    {
      kind: "fade-in",
      id: "c2",
    },
  );
  if (!peek) throw new Error("no peek");
  return peek;
}

beforeEach(() => {
  api.setClipFade.mockReset().mockResolvedValue(undefined);
  announce.mockReset();
});

describe("InspectorPeek", () => {
  it("shows the value and saves one keyboard step per nudge", async () => {
    const user = userEvent.setup();
    render(<InspectorPeek peek={peekAt(300)} />);
    expect(screen.getByRole("status")).toHaveTextContent("300 ms");
    const group = screen.getByRole("group", { name: "Nudge fade in" });
    expect(
      [...group.querySelectorAll("button")].map((b) => [
        b.textContent,
        b.getAttribute("aria-label"),
      ]),
    ).toEqual([
      ["−10", "Fade in 10 ms shorter"],
      ["−1", "Fade in 1 ms shorter"],
      ["+1", "Fade in 1 ms longer"],
      ["+10", "Fade in 10 ms longer"],
    ]);
    await user.click(
      screen.getByRole("button", { name: "Fade in 10 ms longer" }),
    );
    await waitFor(() => expect(announce).toHaveBeenCalledWith("Fade saved"));
    expect(api.setClipFade.mock.calls).toEqual([["/tmp/p.json", "c2", 310, 0]]);
    await expectNoA11yViolations(group);
  });

  it("says so at the limit and saves nothing", async () => {
    const user = userEvent.setup();
    render(<InspectorPeek peek={peekAt(0)} />);
    await user.click(
      screen.getByRole("button", { name: "Fade in 1 ms shorter" }),
    );
    expect(announce).toHaveBeenCalledWith("Fade in is at its limit");
    expect(api.setClipFade.mock.calls).toEqual([]);
  });

  it("offers no nudges to a share guest without edit", () => {
    const peek = peekAt(300);
    useDawStore.setState({
      projectPath: "share:tok",
      shareCapabilities: ["comment"],
    });
    render(<InspectorPeek peek={peek} />);
    expect(screen.getByRole("status")).toHaveTextContent("300 ms");
    expect(screen.queryByRole("group")).toBeNull();
  });
});

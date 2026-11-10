import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import {
  clipRow,
  editBoundaries,
  minimalProject,
  sampleTrack,
} from "../test/fixtures";
import { replayPointer } from "./hitRouting";
import { SeamLayer } from "./SeamLayer";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  loadBoundaryContext: vi.fn(async () => ({ token: "ctx-token" })),
  rollClipJoin: vi.fn(async () => ({ queued: false })),
}));

const TRACK = "mira-voice";
const left = clipRow({
  id: "L",
  source_start: 0,
  source_end: 4,
  timeline_start: 0,
  timeline_end: 4,
  source_duration_sec: 60,
});
const right = clipRow({
  id: "R",
  source_start: 4,
  source_end: 9,
  timeline_start: 4,
  timeline_end: 9,
  source_duration_sec: 60,
});

function load(lane = [left, right]) {
  useDawStore.setState({
    project: minimalProject({
      tracks: [sampleTrack({ id: TRACK })],
      clips: { tracks: { [TRACK]: lane }, clip_count: lane.length },
      edit_boundaries: editBoundaries(lane),
    }),
    projectPath: "/tmp/episode",
    guestMode: null,
    shareCapabilities: null,
    joinMutationInFlight: false,
    selection: null,
  });
}

function mount(props: Partial<React.ComponentProps<typeof SeamLayer>> = {}) {
  const onRollPreview = vi.fn();
  const onSelectSeam = vi.fn();
  const view = render(
    <SeamLayer
      trackId={TRACK}
      zoomPxPerSec={100}
      rollPreview={null}
      onRollPreview={onRollPreview}
      isMoving={() => false}
      onSelectSeam={onSelectSeam}
      {...props}
    />,
  );
  return { ...view, onRollPreview, onSelectSeam };
}

beforeEach(() => {
  vi.mocked(api.rollClipJoin).mockClear();
  load();
});
afterEach(() => useDawStore.setState({ project: null, projectPath: "" }));

describe("SeamLayer", () => {
  it("draws a hollow diamond per touching pair at the seam's time", () => {
    const { container } = mount();
    const marks = container.querySelectorAll<HTMLElement>(".seam-mark");
    expect(marks).toHaveLength(1);
    expect(marks[0]?.style.left).toBe("400px");
    expect(container.querySelector(".sys-seam")).toHaveAttribute(
      "data-kind",
      "split",
    );
  });

  it("draws a filled diamond where a cut took time out", () => {
    load([left, { ...right, source_start: 7 }]);
    const { container } = mount();
    expect(container.querySelector(".sys-seam")).toHaveAttribute(
      "data-kind",
      "cut",
    );
    expect(
      screen.getByRole("button", { name: /^Cut at 0:04\.0, .*3\.0 s cut/ }),
    ).toBeInTheDocument();
  });

  it("selects the seam on press, and marks the selected one", () => {
    const { onSelectSeam } = mount();
    fireEvent.click(screen.getByRole("button", { name: /^Split at 0:04\.0/ }));
    expect(onSelectSeam).toHaveBeenCalledExactlyOnceWith("eb:L:R");
  });

  it("shows aria-pressed for the selected seam", () => {
    useDawStore.setState({
      selection: { kind: "seam", id: "eb:L:R", trackId: TRACK },
    });
    mount();
    expect(
      screen.getByRole("button", { name: /^Split at 0:04\.0/ }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("registers as the roll hit target of its right clip for touch", () => {
    mount();
    const hit = screen.getByRole("button", { name: /^Split at 0:04\.0/ });
    expect(hit).toHaveAttribute("data-hit-kind", "roll");
    expect(hit).toHaveAttribute("data-hit-id", "R");
  });

  it("skips a seam beside a moving clip", () => {
    const { container } = mount({ isMoving: (id) => id === "R" });
    expect(container.querySelector(".seam-mark")).toBeNull();
  });

  it("follows a live roll of its own clips only", () => {
    const { container } = mount({
      rollPreview: { leftClipId: "L", rightClipId: "R", deltaSec: 0.5 },
    });
    expect(container.querySelector<HTMLElement>(".seam-mark")?.style.left).toBe(
      "450px",
    );
  });

  it("previews a drag on the lane's clips and saves one roll through the sheet's command on release", async () => {
    const { onRollPreview } = mount();
    const hit = screen.getByRole("button", { name: /^Split at 0:04\.0/ });
    fireEvent.pointerDown(hit, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 120 });
    expect(onRollPreview).toHaveBeenLastCalledWith({
      leftClipId: "L",
      rightClipId: "R",
      deltaSec: 0.2,
    });
    fireEvent.pointerUp(hit, { pointerId: 1 });
    await vi.waitFor(() => expect(api.rollClipJoin).toHaveBeenCalledTimes(1));
    const [path, l, r, deltaSec, token] =
      vi.mocked(api.rollClipJoin).mock.calls[0] ?? [];
    expect([path, l, r, token]).toEqual([
      "/tmp/episode",
      "L",
      "R",
      "ctx-token",
    ]);
    expect(deltaSec).toBeCloseTo(0.2, 9);
    await vi.waitFor(() =>
      expect(onRollPreview).toHaveBeenLastCalledWith(null),
    );
  });

  it("takes no roll from an unarmed touch drag and rolls once the long press has armed it", () => {
    const { onRollPreview } = mount();
    const hit = screen.getByRole("button", { name: /^Split at 0:04\.0/ });
    fireEvent.pointerDown(hit, {
      pointerId: 3,
      pointerType: "touch",
      button: 0,
      clientX: 100,
    });
    fireEvent.pointerMove(hit, {
      pointerId: 3,
      pointerType: "touch",
      clientX: 160,
    });
    expect(onRollPreview).not.toHaveBeenCalled();
    fireEvent.pointerUp(hit, { pointerId: 3, pointerType: "touch" });

    const press = (type: "pointerdown" | "pointermove", x: number) =>
      replayPointer(
        type,
        hit,
        new PointerEvent(type, {
          pointerId: 4,
          pointerType: "touch",
          isPrimary: true,
          clientX: x,
        }),
      );
    press("pointerdown", 100);
    press("pointermove", 120);
    expect(onRollPreview).toHaveBeenLastCalledWith({
      leftClipId: "L",
      rightClipId: "R",
      deltaSec: 0.2,
    });
  });

  it("has no axe violations", async () => {
    const { container } = mount();
    await expectNoA11yViolations(container);
  });
});

import { act, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectJoinDraft } from "../edit/joinRender";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { clipRow } from "../test/fixtures";
import { JoinEditor } from "./JoinEditor";

vi.mock("./WaveformLayer", () => ({ WaveformLayer: () => null }));

const left = clipRow({
  id: "left",
  source_start: 0,
  source_end: 5,
  timeline_start: 0,
  timeline_end: 5,
  fade_out_ms: 20,
  source_duration_sec: 100,
});
const right = clipRow({
  id: "right",
  source_start: 5,
  source_end: 10,
  timeline_start: 5,
  timeline_end: 10,
  fade_in_ms: 20,
  join_in_mode: "crossfade",
  join_left_clip_id: "left",
  join_crossfade_ms: 20,
  source_duration_sec: 100,
});

const waves = {
  leftRef: "source:a",
  rightRef: "source:b",
  role: "dialogue",
  gainDb: 0,
} satisfies Partial<ComponentProps<typeof JoinEditor>>;

const WAVE_SELECTOR = ".join-blend-waves, .join-blend-seam";

function mount(props: Partial<ComponentProps<typeof JoinEditor>> = {}) {
  return render(
    <JoinEditor left={left} right={right} zoomPxPerSec={50} {...props} />,
  );
}

function draft(ms: number, base = right, from = left) {
  act(() =>
    useDawStore.getState().setJoinDraft(projectJoinDraft(from, base, ms)),
  );
}

beforeEach(() => {
  useDawStore.setState({ joinDraft: null });
});

describe("JoinEditor", () => {
  it("paints the saved overlap as a centred 1 px box", () => {
    const { container } = mount();
    expect(container.querySelector(".join-blend")).toHaveStyle({
      left: "249.5px",
      width: "1px",
    });
  });

  it("paints the drafted length from the store and returns to the saved one", () => {
    const { container } = mount();
    draft(420);
    expect(container.querySelector(".join-blend")).toHaveStyle({
      left: "239.5px",
      width: "21px",
    });
    expect(container.querySelectorAll(".join-blend path")).toHaveLength(1);
    act(() => useDawStore.getState().setJoinDraft(null));
    expect(container.querySelector(".join-blend")).toHaveStyle({
      left: "249.5px",
      width: "1px",
    });
    expect(container.querySelectorAll(".join-blend path")).toHaveLength(0);
  });

  it("caps the drafted box at the render headroom", () => {
    const tight = { ...right, source_start: 0.05, source_end: 10 };
    const { container } = mount({ right: tight });
    draft(5000, tight);
    expect(container.querySelector(".join-blend")).toHaveStyle({
      width: "5px",
    });
  });

  it("ignores a draft for another join", () => {
    const { container } = mount();
    act(() =>
      useDawStore
        .getState()
        .setJoinDraft({ ...right, id: "elsewhere", join_crossfade_ms: 300 }),
    );
    expect(container.querySelector(".join-blend")).toHaveStyle({
      width: "1px",
    });
  });

  it("draws no blend for a draft whose left recording is unmeasured", () => {
    const unmeasured = { ...left, source_duration_sec: null };
    const { container } = mount({ left: unmeasured });
    draft(420, right, unmeasured);
    expect(container.querySelector(".join-blend")).toBeNull();
  });

  it.each([
    ["no_headroom", false],
    ["not_abutting", false],
    ["no_fade_in", true],
  ] as const)(
    "draws waves for a draft of a saved %s join: %s",
    (reason, drawn) => {
      const saved = {
        ...right,
        join_crossfade_ms: 0,
        join_crossfade_blocked: reason,
      };
      const { container } = mount({ right: saved, ...waves });
      draft(420, saved);
      expect(container.querySelector(WAVE_SELECTOR) !== null).toBe(drawn);
    },
  );

  it("has no accessibility violations while a draft is drawn", async () => {
    const { container } = mount({ ...waves });
    draft(420);
    await expectNoA11yViolations(container);
  });
});

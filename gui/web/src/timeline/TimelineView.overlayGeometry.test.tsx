import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { stubRaf } from "../test/raf";
import { stubResizeObserver } from "../test/resizeObserver";
import { attachHitRouting } from "./hitRouting";
import { TimelineView } from "./TimelineView";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("../commands/pointer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/pointer")>()),
  executePointerCommand: dispatch,
}));
vi.mock("./hitRouting", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hitRouting")>();
  return { ...actual, attachHitRouting: vi.fn(actual.attachHitRouting) };
});
vi.mock("../waveform/statusStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../waveform/statusStore")>()),
  useWaveformStatus: () => null,
  useLaneWaveformStatus: () => "idle",
}));

const project = minimalProject({
  tracks: [sampleTrack({ id: "host", label: "Avery" })],
  timeline_duration_sec: 120,
});
const path = "/tmp/overlay-geometry.project.json";
let scrollBox: DOMRect;

function router() {
  const result = vi.mocked(attachHitRouting).mock.results.at(-1);
  if (!result || result.type !== "return")
    throw new Error("Expected attached real hit router");
  return result.value;
}
function lane() {
  const node = document.querySelector<HTMLElement>(
    '.lane-row[data-track-id="host"]',
  );
  if (!node) throw new Error("Expected the real track lane");
  return node;
}
function Witness({ onCommit }: { onCommit: (changed: boolean) => void }) {
  const changed = useDawStore((state) => state.highlightStaleRender);
  useLayoutEffect(() => {
    onCommit(changed);
  }, [changed, onCommit]);
  return null;
}
function mount(onCommit?: (changed: boolean) => void) {
  return render(
    <DawProvider projectPath={path} initialProject={project}>
      <TimelineView />
      {onCommit ? <Witness onCommit={onCommit} /> : null}
    </DawProvider>,
  );
}

beforeEach(() => {
  stubResizeObserver();
  scrollBox = new DOMRect(0, 100, 800, 500);
  vi.stubGlobal("innerHeight", 800);
  for (const [name, normal, menu] of [
    ["clientWidth", 800, 220],
    ["offsetWidth", 800, 220],
    ["clientHeight", 600, 198],
    ["offsetHeight", 600, 200],
    ["scrollHeight", 600, 198],
  ] as const) {
    vi.spyOn(HTMLElement.prototype, name, "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("edit-create-menu") ? menu : normal;
    });
  }
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("timeline-scroll")
        ? scrollBox
        : new DOMRect(20, 100, 4800, 500);
    },
  );
  clearRegisteredCommands();
  registerDawCommands();
  dispatch.mockReset();
  dispatch.mockResolvedValue({ status: "ok" });
  vi.mocked(attachHitRouting).mockClear();
  useDawStore.getState().hydrate(path, project);
  useDawStore.setState({
    userZoomed: true,
    zoomPxPerSec: 40,
    isPlaying: false,
    selection: null,
    highlightStaleRender: false,
    lastAgentQuery: null,
    shareCapabilities: null,
    guestMode: null,
  });
});
afterEach(() => {
  clearRegisteredCommands();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TimelineView committed overlay geometry", () => {
  it("settles the real Create host before a frame and focuses its first row on the normal frame", () => {
    const raf = stubRaf();
    mount();
    act(() => {
      expect(router().openCreate({ x: 300, y: 400 }, lane())).toBe(true);
    });
    const menu = screen.getByRole("menu", { name: /^Create at 00:07.000/ });
    expect(menu.style.left).toBe("190px");
    expect(menu.style.top).toBe("176px");
    const first = screen.getAllByRole("menuitem")[0];
    act(() => {
      raf.fire(100);
    });
    expect(first).toHaveFocus();
    fireEvent.click(screen.getByRole("menuitem", { name: "Add chapter here" }));
    expect(dispatch).toHaveBeenCalledExactlyOnceWith("edit.addChapter", {
      atTime: 7,
    });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("resamples an unrelated parent commit and keeps same-title focus while replacing the held place", () => {
    const raf = stubRaf();
    mount();
    const currentRouter = router();
    const surface = lane();
    act(() => {
      currentRouter.openCreate({ x: 300, y: 400 }, surface);
    });
    const original = screen.getByRole("menu");
    const first = screen.getAllByRole("menuitem")[0];
    act(() => {
      raf.fire(100);
    });
    expect(first).toHaveFocus();
    scrollBox = new DOMRect(0, 100, 400, 500);
    act(() => {
      // TimelineView reads this field but it does not touch the overlays.
      useDawStore.setState({ lastAgentQuery: "unrelated" });
    });
    expect(screen.getByRole("menu")).toBe(original);
    expect(original.style.left).toBe("164px");
    expect(first).toHaveFocus();
    act(() => {
      currentRouter.openCreate({ x: 300.009765625, y: 400 }, surface);
    });
    expect(screen.getByRole("menu")).toBe(original);
    expect(first).toHaveFocus();
    fireEvent.click(screen.getByRole("menuitem", { name: "Add chapter here" }));
    expect(dispatch).toHaveBeenCalledExactlyOnceWith("edit.addChapter", {
      atTime: 7.000244140625,
    });
  });

  it("runs the current held-place command at a sibling layout boundary while recording its numeric observation", async (context) => {
    stubRaf();
    const witness = vi.fn((changed: boolean) => {
      if (!changed) return null;
      const menu = screen.getByRole("menu", { name: /^Create at 00:07.000/ });
      const observation = { left: menu.style.left, top: menu.style.top };
      screen.getByRole("menuitem", { name: "Add chapter here" }).click();
      return observation;
    });
    mount(witness);
    const currentRouter = router();
    const surface = lane();
    act(() => {
      currentRouter.openCreate({ x: 300, y: 400 }, surface);
    });
    expect(screen.getByRole("menu").style.left).toBe("190px");
    scrollBox = new DOMRect(0, 100, 400, 500);
    act(() => {
      currentRouter.openCreate({ x: 300.009765625, y: 400 }, surface);
      useDawStore.setState({ highlightStaleRender: true });
    });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith("edit.addChapter", {
      atTime: 7.000244140625,
    });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(witness.mock.results.at(-1)?.value).toMatchObject({
      left: expect.any(String),
      top: "176px",
    });
    await context.annotate(
      JSON.stringify(witness.mock.results.at(-1)?.value),
      "geometry",
    );
  });

  it("retires the overlay through the existing loading branch and attaches a new real router on replacement", async () => {
    stubRaf();
    mount();
    const oldRouter = router();
    act(() => {
      oldRouter.openCreate({ x: 300, y: 400 }, lane());
    });
    const old = screen.getByRole("menu");
    act(() => {
      useDawStore.setState({ project: null });
    });
    expect(
      screen.getByRole("group", { name: "Loading timeline" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("menu")).toBeNull();
    act(() => {
      useDawStore
        .getState()
        .hydrate(path, { ...project, timeline_duration_sec: 140 });
    });
    await waitFor(() => expect(router()).not.toBe(oldRouter));
    expect(screen.queryByRole("menu")).toBeNull();
    act(() => {
      router().openCreate({ x: 300, y: 400 }, lane());
    });
    expect(screen.getByRole("menu")).not.toBe(old);
    expect(screen.getByRole("menu").style.top).toBe("176px");
  });
});

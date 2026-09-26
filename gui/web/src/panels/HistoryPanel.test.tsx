import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadHistoryDiff } from "../api";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import type { HistoryGroup } from "../types/project";
import { HistoryPanel } from "./HistoryPanel";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  loadHistoryDiff: vi.fn(),
}));

function historyProject(count: number) {
  const groups: HistoryGroup[] = Array.from({ length: count }, (_, i) => ({
    kind: "mutation",
    label: `edit ${i}`,
    title: `edit ${i}`,
    before_index: 2 * i,
    after_index: 2 * i + 1,
  }));
  return minimalProject({
    history: { cursor: 0, can_undo: true, can_redo: false, groups },
  });
}

describe("HistoryPanel", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/p.json", null);
  });

  it("hides the step count and marks the list busy until groups hydrate", () => {
    const project = minimalProject({
      meta: {
        name: "Test Episode",
        workspace_dir: "/tmp/test",
        hydration: { transcript_words: false, history_groups: false },
      },
    });
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <HistoryPanel />
      </DawProvider>,
    );
    expect(screen.getByText("Loading history…")).toBeTruthy();
    expect(screen.queryByText(/0 steps/)).toBeNull();
    expect(document.querySelector(".history-list")).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });
});

describe("HistoryPanel list", () => {
  it("renders a short list flat", () => {
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={historyProject(5)}>
        <HistoryPanel />
      </DawProvider>,
    );
    expect(container.querySelectorAll(".history-row")).toHaveLength(5);
    expect(container.querySelector(".is-virtualized")).toBeNull();
    expect(container.querySelector(".history-row-slot")).toBeNull();
  });
});

describe("HistoryPanel virtualization", () => {
  let scrollTop = 0;

  beforeEach(() => {
    scrollTop = 0;
    useDawStore.getState().hydrate("/tmp/p.json", null);
    // virtual-core reads offset*/client* sizes; list = 600px, rows = 36px.
    const size = function (this: HTMLElement) {
      return this.classList.contains("history-list") ? 600 : 36;
    };
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      size,
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      size,
    );
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains("history-list")) {
          return DOMRect.fromRect({ width: 400, height: 600 });
        }
        return DOMRect.fromRect({ width: 400, height: 36 });
      },
    );
    vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(
      () => scrollTop,
    );
    vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation(
      function (this: HTMLElement, v: number) {
        scrollTop = v;
        this.dispatchEvent(new Event("scroll"));
      },
    );
    vi.mocked(loadHistoryDiff).mockResolvedValue({
      summary: ["fade changed"],
      diff: {},
      to_label: "after edit 0",
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const renderPanel = () =>
    render(
      <DawProvider
        projectPath="/tmp/p.json"
        initialProject={historyProject(1000)}
      >
        <HistoryPanel />
      </DawProvider>,
    );
  const rowAt = (container: HTMLElement, index: number) =>
    container.querySelector<HTMLElement>(`[data-history-index="${index}"]`);

  it("renders a bounded, labelled list of steps", async () => {
    const { container } = renderPanel();
    expect(container.querySelectorAll(".history-row").length).toBeLessThan(
      1000,
    );
    expect(rowAt(container, 0)).toBeTruthy();
    expect(rowAt(container, 999)).toBeNull();
    const list = container.querySelector(".history-list.is-virtualized");
    expect(list?.getAttribute("role")).toBe("list");
    expect(list?.getAttribute("aria-label")).toBe("History, 1000 steps");
    const slot = container.querySelector(".history-row-slot");
    expect(slot?.getAttribute("role")).toBe("listitem");
    expect(slot?.getAttribute("aria-setsize")).toBe("1000");
    expect(slot?.getAttribute("aria-posinset")).toBe("1");
    await expectNoA11yViolations(container);
  });

  it("keeps the selected row mounted after scrolling away", async () => {
    const { container } = renderPanel();
    fireEvent.click(rowAt(container, 0)!);
    await waitFor(() => expect(loadHistoryDiff).toHaveBeenCalled());
    await screen.findByText("fade changed");
    act(() => {
      const list = container.querySelector<HTMLElement>(".history-list")!;
      list.scrollTop = 36 * 1000;
    });
    await waitFor(() => expect(rowAt(container, 999)).toBeTruthy());
    expect(rowAt(container, 0)).toBeTruthy();
  });
});

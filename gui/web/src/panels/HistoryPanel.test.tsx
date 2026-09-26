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
import type { HistoryDiff, HistoryGroup } from "../types/project";
import { historyGroupKey } from "../utils/historyGroupKey";
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
    before_id: `before-${i}`,
    after_id: `after-${i}`,
  }));
  return minimalProject({
    history: { cursor: 0, can_undo: true, can_redo: false, groups },
  });
}

const rowAt = (container: HTMLElement, index: number) =>
  container.querySelector<HTMLElement>(`[data-history-index="${index}"]`);

describe("historyGroupKey", () => {
  it("keys on entry ids and falls back to indexes", () => {
    expect(
      historyGroupKey(
        { kind: "mutation", before_index: 0, after_index: 1, after_id: "x" },
        0,
      ),
    ).toBe("m-x");
    expect(
      historyGroupKey({ kind: "mutation", before_index: 0, after_index: 1 }, 0),
    ).toBe("m-0-1");
    expect(historyGroupKey({ kind: "snapshot", index: 3, id: "s1" }, 0)).toBe(
      "s-s1",
    );
    expect(historyGroupKey({ kind: "snapshot", index: 3 }, 0)).toBe("s-3");
    expect(historyGroupKey({ kind: "snapshot" }, 7)).toBe("s-7");
  });
});

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
    expect(
      screen.getByText("Loading history…").closest(".history-list"),
    ).toBeNull();
    expect(screen.queryByText(/0 steps/)).toBeNull();
    expect(document.querySelector(".history-list")).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });
});

describe("HistoryPanel list", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/p.json", null);
  });

  afterEach(() => {
    vi.mocked(loadHistoryDiff).mockReset();
  });

  function deferredDiffs() {
    const resolvers: ((d: HistoryDiff) => void)[] = [];
    vi.mocked(loadHistoryDiff).mockImplementation(
      () => new Promise<HistoryDiff>((resolve) => resolvers.push(resolve)),
    );
    return resolvers;
  }
  const diffOf = (line: string) =>
    ({ summary: [line], diff: {}, to_label: `after step of ${line}` }) as never;
  const renderList = () =>
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={historyProject(5)}>
        <HistoryPanel />
      </DawProvider>,
    );

  const replaceGroupAfterId = (index: number, afterId: string) =>
    act(() => {
      const project = useDawStore.getState().project!;
      const groups = project.history.groups.map((g, i) =>
        i === index ? { ...g, after_id: afterId } : g,
      );
      useDawStore
        .getState()
        .setProject({ ...project, history: { ...project.history, groups } });
    });

  it("ignores an older diff that resolves after the latest one", async () => {
    const resolvers = deferredDiffs();
    const { container } = renderList();
    fireEvent.click(rowAt(container, 0)!);
    fireEvent.click(rowAt(container, 1)!);
    await waitFor(() => expect(resolvers).toHaveLength(2));
    await act(async () => resolvers[1]!(diffOf("second")));
    expect(await screen.findByText("second")).toBeTruthy();
    await act(async () => resolvers[0]!(diffOf("first")));
    expect(screen.queryByText("first")).toBeNull();
    expect(screen.getByText("second")).toBeTruthy();
    expect(rowAt(container, 1)!.classList.contains("selected")).toBe(true);
  });

  it("stays loading until the latest diff resolves", async () => {
    const resolvers = deferredDiffs();
    const { container } = renderList();
    fireEvent.click(rowAt(container, 0)!);
    fireEvent.click(rowAt(container, 1)!);
    await waitFor(() => expect(resolvers).toHaveLength(2));
    await act(async () => resolvers[0]!(diffOf("first")));
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByText("first")).toBeNull();
    await act(async () => resolvers[1]!(diffOf("second")));
    expect(await screen.findByText("second")).toBeTruthy();
  });

  it("shows a failed diff load as an inline error", async () => {
    vi.mocked(loadHistoryDiff).mockRejectedValueOnce(
      new Error("diff exploded"),
    );
    const { container } = renderList();
    fireEvent.click(rowAt(container, 0)!);
    expect(await screen.findByText("diff exploded")).toBeTruthy();
    expect(container.querySelector(".history-diff")).toBeNull();
  });

  it("drops the diff when the selected step leaves the history", async () => {
    vi.mocked(loadHistoryDiff).mockResolvedValue(diffOf("fade changed"));
    const { container } = renderList();
    fireEvent.click(rowAt(container, 2)!);
    await screen.findByText("fade changed");
    act(() => {
      const project = useDawStore.getState().project!;
      const groups = project.history.groups.map((g, i) =>
        i === 2 ? { ...g, after_id: "replaced", title: "new edit" } : g,
      );
      useDawStore
        .getState()
        .setProject({ ...project, history: { ...project.history, groups } });
    });
    expect(screen.queryByText("fade changed")).toBeNull();
    expect(container.querySelector(".history-row.selected")).toBeNull();
    expect(container.querySelector(".history-diff")).toBeNull();
  });

  it("keeps the selection cleared when the stale step's key comes back", async () => {
    vi.mocked(loadHistoryDiff).mockResolvedValue(diffOf("fade changed"));
    const { container } = renderList();
    fireEvent.click(rowAt(container, 2)!);
    await screen.findByText("fade changed");
    replaceGroupAfterId(2, "replaced");
    replaceGroupAfterId(2, "after-2");
    expect(container.querySelector(".history-row.selected")).toBeNull();
    expect(screen.queryByText("fade changed")).toBeNull();
    expect(container.querySelector(".history-diff")).toBeNull();
  });

  it("drops an in-flight diff whose step left the history", async () => {
    const resolvers = deferredDiffs();
    const { container } = renderList();
    fireEvent.click(rowAt(container, 2)!);
    await waitFor(() => expect(resolvers).toHaveLength(1));
    replaceGroupAfterId(2, "replaced");
    await act(async () => resolvers[0]!(diffOf("late diff")));
    replaceGroupAfterId(2, "after-2");
    expect(screen.queryByText("late diff")).toBeNull();
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(container.querySelector(".history-row.selected")).toBeNull();
    expect(container.querySelector(".history-diff")).toBeNull();
  });

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

  it("keeps the focused row mounted and focused when groups shift", async () => {
    const { container } = renderPanel();
    act(() => rowAt(container, 0)!.focus());
    act(() => {
      container.querySelector<HTMLElement>(".history-list")!.scrollTop =
        36 * 1000;
    });
    await waitFor(() => expect(rowAt(container, 999)).toBeTruthy());
    expect(rowAt(container, 0)).toBe(document.activeElement);
    act(() => {
      const project = useDawStore.getState().project!;
      const added: HistoryGroup = {
        kind: "mutation",
        title: "new edit",
        before_index: 2000,
        after_index: 2001,
        after_id: "after-new",
      };
      useDawStore.getState().setProject({
        ...project,
        history: {
          ...project.history,
          groups: [added, ...project.history.groups],
        },
      });
    });
    await waitFor(() => expect(rowAt(container, 1)).toBeTruthy());
    expect(document.activeElement?.textContent).toContain("edit 0");
    expect(document.activeElement?.getAttribute("data-history-index")).toBe(
      "1",
    );
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

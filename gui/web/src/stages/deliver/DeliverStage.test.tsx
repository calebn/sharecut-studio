import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliverStage, type DeliverStageProps } from "./DeliverStage";
import {
  CHAPTERS,
  CLEAR_FACTS,
  CLIPS,
  DONE,
  exportedState,
  NEEDS_MODEL,
  NEVER,
  OPEN_FACTS,
  REQUEST,
  SETTINGS,
  TOTAL,
} from "./deliverFixture";
import type { ExportState } from "./deliverLogic";

const platform = vi.hoisted(() => ({ apple: false }));
vi.mock("../../utils/platform", () => ({
  isApplePlatform: () => platform.apple,
}));

afterEach(() => {
  platform.apple = false;
});

const REVEAL = "Show in folder";

function handlers() {
  return {
    onFix: vi.fn(),
    onExport: vi.fn(),
    onCancel: vi.fn(),
    onReveal: vi.fn(),
    onDownload: vi.fn(),
    onChangeFolder: vi.fn(),
    onCopyLink: vi.fn(),
    onRefreshMix: vi.fn(),
    onPlayFrom: vi.fn(),
    onPlayClip: vi.fn(),
    onFindClips: vi.fn(),
    onOpenClipInEdit: vi.fn(),
    onGetModel: vi.fn(),
  };
}

function props(extra: Partial<DeliverStageProps> = {}): DeliverStageProps {
  return {
    facts: CLEAR_FACTS,
    total: TOTAL,
    initialSettings: SETTINGS,
    initialChapters: CHAPTERS,
    initialClips: CLIPS,
    saveTo: "Field Notes/export",
    exportState: NEVER,
    clock: { time: "0:00", total: "52:00" },
    playhead: 724,
    link: { url: null },
    pinnedTo: "Rough cut",
    toastMs: 600_000,
    ...handlers(),
    ...extra,
  };
}

function setup(extra: Partial<DeliverStageProps> = {}) {
  const all = props(extra);
  const view = render(<DeliverStage {...all} />);
  const stage = () => view.container.querySelector(".dv-stage") as HTMLElement;
  return { ...view, all, stage };
}

const modE = (el: Element, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(el, { key: "e", ctrlKey: true, ...init });

describe("Mod+E", () => {
  it("exports once with the chosen settings, clips and range", () => {
    const { stage, all } = setup();
    modE(stage());
    expect(all.onExport).toHaveBeenCalledOnce();
    expect(all.onExport).toHaveBeenCalledWith({
      settings: SETTINGS,
      clips: [{ id: "k3", start: 0, end: 33, title: "Cold open" }],
      chapters: CHAPTERS,
      range: null,
    });
  });

  it("ignores a held key even once the double-export guard has released", () => {
    vi.useFakeTimers();
    try {
      const { stage, all } = setup();
      modE(stage());
      act(() => {
        vi.advanceTimersByTime(2500);
      });
      modE(stage(), { repeat: true });
      expect(all.onExport).toHaveBeenCalledOnce();
      modE(stage());
      expect(all.onExport).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("needs the bare chord: Shift or Alt with it does nothing", () => {
    const { stage, all } = setup();
    modE(stage(), { shiftKey: true });
    modE(stage(), { altKey: true });
    expect(all.onExport).not.toHaveBeenCalled();
  });

  it("is Cmd on Apple platforms and Ctrl elsewhere", () => {
    platform.apple = true;
    const apple = setup();
    modE(apple.stage());
    expect(apple.all.onExport).not.toHaveBeenCalled();
    fireEvent.keyDown(apple.stage(), { key: "e", metaKey: true });
    expect(apple.all.onExport).toHaveBeenCalledOnce();
    apple.unmount();
    platform.apple = false;
    const other = setup();
    fireEvent.keyDown(other.stage(), { key: "e", metaKey: true });
    expect(other.all.onExport).not.toHaveBeenCalled();
    modE(other.stage());
    expect(other.all.onExport).toHaveBeenCalledOnce();
  });

  it("exports a range passed in from Edit instead of the Deliver part", () => {
    const { stage, all } = setup({ selection: { start: 40, end: 90 } });
    modE(stage());
    expect(vi.mocked(all.onExport).mock.calls[0]?.[0].range).toEqual({
      start: 40,
      end: 90,
    });
  });

  it("falls back to the Deliver range for a selection that cannot be exported", () => {
    for (const selection of [
      { start: 5, end: 5 },
      { start: 9, end: 3 },
      { start: Number.NaN, end: 30 },
      { start: TOTAL + 10, end: TOTAL + 20 },
    ]) {
      const { stage, all, unmount } = setup({ selection });
      modE(stage());
      expect(vi.mocked(all.onExport).mock.calls[0]?.[0].range).toBeNull();
      unmount();
    }
    const { stage, all } = setup({ selection: { start: -4, end: TOTAL + 50 } });
    modE(stage());
    expect(vi.mocked(all.onExport).mock.calls[0]?.[0].range).toEqual({
      start: 0,
      end: TOTAL,
    });
  });

  it("can export again when the host ignores the first request", () => {
    vi.useFakeTimers();
    try {
      const { stage, all } = setup();
      modE(stage());
      modE(stage());
      expect(all.onExport).toHaveBeenCalledOnce();
      act(() => {
        vi.advanceTimersByTime(2500);
      });
      modE(stage());
      expect(all.onExport).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing while exporting, with no format, or while loading", () => {
    const running = setup({
      exportState: { phase: "running", progress: 0.1, detail: "" },
    });
    modE(running.stage());
    expect(running.all.onExport).not.toHaveBeenCalled();
    running.unmount();
    const empty = setup({ initialSettings: { ...SETTINGS, formats: [] } });
    modE(empty.stage());
    expect(empty.all.onExport).not.toHaveBeenCalled();
    empty.unmount();
    const loading = setup({ state: "loading" });
    modE(loading.stage());
    expect(loading.all.onExport).not.toHaveBeenCalled();
  });

  it("does nothing while the transcription model is missing", () => {
    const { stage, all } = setup({ exportState: NEEDS_MODEL });
    modE(stage());
    expect(all.onExport).not.toHaveBeenCalled();
  });

  it("works after an error mount recovers", () => {
    const all = props();
    function Host() {
      const [state, setState] = useState<"error" | "ready">("error");
      return (
        <DeliverStage
          {...all}
          state={state}
          onRetry={() => setState("ready")}
        />
      );
    }
    const { container } = render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    modE(container.querySelector(".dv-stage") as Element);
    expect(all.onExport).toHaveBeenCalledOnce();
  });

  it("works after a guest mount becomes the host", () => {
    const all = props({ guest: true });
    const { container, rerender } = render(<DeliverStage {...all} />);
    rerender(<DeliverStage {...all} guest={false} />);
    modE(container.querySelector(".dv-stage") as Element);
    expect(all.onExport).toHaveBeenCalledOnce();
  });
});

describe("Export button", () => {
  it("is one filled button and keeps working with items open", async () => {
    const { container, all } = setup({ facts: OPEN_FACTS });
    expect(container.querySelectorAll(".primary")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(all.onFix).toHaveBeenCalledWith("review", "comments");
    await userEvent.click(screen.getByRole("button", { name: /^Export/ }));
    expect(all.onExport).toHaveBeenCalledOnce();
  });

  it("does not export twice before the host answers", async () => {
    const { all } = setup();
    const button = screen.getByRole("button", { name: /^Export/ });
    await userEvent.click(button);
    await userEvent.click(button);
    modE(button);
    expect(all.onExport).toHaveBeenCalledOnce();
  });

  it("can export again once the host state has changed", async () => {
    const all = props();
    const { rerender } = render(<DeliverStage {...all} />);
    await userEvent.click(screen.getByRole("button", { name: /^Export/ }));
    rerender(
      <DeliverStage {...all} exportState={{ phase: "failed", cause: "x" }} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Export/ }));
    expect(all.onExport).toHaveBeenCalledTimes(2);
  });

  it("is disabled while loading, in the phone foot too", () => {
    setup({ state: "loading", layout: "phone" });
    expect(screen.getByRole("button", { name: /^Export/ })).toBeDisabled();
  });

  it("becomes Reveal after an export and is the only filled button", () => {
    const { container } = setup({ exportState: DONE });
    expect(screen.queryByRole("button", { name: /^Export/ })).toBeNull();
    expect(container.querySelectorAll(".primary")).toHaveLength(1);
    expect(screen.getByRole("button", { name: REVEAL })).toBeInTheDocument();
  });

  it("puts the one Export button in the phone foot", () => {
    const { container } = setup({ layout: "phone" });
    expect(container.querySelectorAll(".dv-export")).toHaveLength(1);
    expect(container.querySelector(".dv-foot .dv-export")).not.toBeNull();
  });
});

const field = (value: string, className: string) =>
  screen
    .getAllByDisplayValue(value)
    .find((el) => el.classList.contains(className)) as HTMLElement;
const clipTitle = (value: string) => field(value, "dv-clip-title");
const chapterTitle = (value: string) => field(value, "dv-chapter-title");

describe("stale after an export", () => {
  it("brings Export back when the loudness changes", async () => {
    setup({ exportState: DONE });
    await userEvent.click(screen.getByRole("button", { name: /^Streaming/ }));
    expect(screen.getByText("Edited since export")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Export/ })).toBeEnabled();
    expect(screen.queryByRole("button", { name: REVEAL })).toBeNull();
  });

  it("goes stale when a format or the range changes", async () => {
    setup({ exportState: DONE });
    await userEvent.click(screen.getByRole("button", { name: /^FLAC/ }));
    expect(screen.getByText("Edited since export")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^FLAC/ }));
    expect(screen.queryByText("Edited since export")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Part…" }));
    expect(screen.getByText("Edited since export")).toBeInTheDocument();
  });

  it("goes stale when a clip is approved afterwards, without listing a file that was never written", async () => {
    const exported = exportedState({
      settings: SETTINGS,
      clips: [],
      chapters: CHAPTERS,
      range: null,
    });
    setup({ exportState: exported });
    expect(screen.queryByText("clips/cold-open.wav")).toBeNull();
    await userEvent.click(
      screen.getAllByRole("button", { name: /^Approve/ })[0] as HTMLElement,
    );
    expect(screen.getByText("Edited since export")).toBeInTheDocument();
    expect(screen.queryByText("clips/nobody-asked-the-river.wav")).toBeNull();
  });

  it("stays done when an edit is typed back to what was exported", async () => {
    setup({ exportState: DONE });
    const title = clipTitle("Cold open");
    await userEvent.type(title, "x");
    expect(screen.getByText("Edited since export")).toBeInTheDocument();
    await userEvent.type(title, "{Backspace}");
    expect(screen.queryByText("Edited since export")).toBeNull();
  });

  it("goes stale when an approved clip is trimmed", async () => {
    setup({ exportState: DONE });
    await userEvent.click(
      screen.getByRole("button", { name: "More for Cold open" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Trim" }),
    );
    const out = screen.getByRole("textbox", { name: "Out of Cold open" });
    await userEvent.clear(out);
    await userEvent.type(out, "0:20{Enter}");
    expect(screen.getByText("Edited since export")).toBeInTheDocument();
  });

  it("ignores edits to a clip that was not approved at export", async () => {
    setup({ exportState: DONE });
    await userEvent.type(clipTitle("Nobody asked the river"), "!");
    expect(screen.queryByText("Edited since export")).toBeNull();
  });

  it("goes stale when a chapter is retitled, retimed, added or removed", async () => {
    setup({ exportState: DONE });
    const stale = () => screen.queryByText("Edited since export") !== null;
    await userEvent.type(chapterTitle("The old mill"), "!");
    expect(stale()).toBe(true);
    await userEvent.type(chapterTitle("The old mill!"), "{Backspace}");
    expect(stale()).toBe(false);

    const time = screen.getByRole("textbox", { name: "Time of The old mill" });
    await userEvent.clear(time);
    await userEvent.type(time, "6:00{Enter}");
    expect(stale()).toBe(true);
    await userEvent.clear(time);
    await userEvent.type(time, "5:12.4{Enter}");
    expect(stale()).toBe(false);

    await userEvent.click(
      screen.getByRole("button", { name: "Add at playhead" }),
    );
    expect(stale()).toBe(true);
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Chapter 5" }),
    );
    expect(stale()).toBe(false);
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Listener mail" }),
    );
    expect(stale()).toBe(true);
  });

  it("covers the range a Mod+E export wrote", () => {
    const selection = { start: 40, end: 90 };
    const exported = exportedState({ ...REQUEST, range: selection });
    setup({ exportState: exported, selection });
    expect(screen.queryByText("Edited since export")).toBeNull();
  });

  it("stays done when loudness or Part is changed and changed back", async () => {
    setup({ exportState: DONE });
    const stale = () => screen.queryByText("Edited since export") !== null;
    await userEvent.click(screen.getByRole("button", { name: /^Streaming/ }));
    expect(stale()).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: /^Podcast/ }));
    expect(stale()).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Part…" }));
    expect(stale()).toBe(true);
    await userEvent.click(
      screen.getByRole("button", { name: "Whole episode" }),
    );
    expect(stale()).toBe(false);
  });

  it("keeps a chosen In and Out when Part… is clicked again", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Part…" }));
    const out = screen.getByRole("textbox", { name: "Out" });
    await userEvent.clear(out);
    await userEvent.type(out, "0:30{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Part…" }));
    expect(screen.getByRole("textbox", { name: "Out" })).toHaveValue("0:30.0");
  });

  it("goes stale when an approved clip's In moves", async () => {
    setup({ exportState: DONE });
    await userEvent.click(
      screen.getByRole("button", { name: "More for Cold open" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Trim" }),
    );
    const start = screen.getByRole("textbox", { name: "In of Cold open" });
    await userEvent.clear(start);
    await userEvent.type(start, "0:05{Enter}");
    expect(screen.getByText("Edited since export")).toBeInTheDocument();
    await userEvent.clear(start);
    await userEvent.type(start, "0:00{Enter}");
    expect(screen.queryByText("Edited since export")).toBeNull();
  });

  it("lists the clips an export did include", () => {
    setup({ exportState: DONE });
    expect(screen.getByText("clips/cold-open.wav")).toBeInTheDocument();
  });
});

describe("chapters", () => {
  const titles = () =>
    screen
      .getAllByRole("textbox", { name: /^Title of/ })
      .filter((el) => el.classList.contains("dv-chapter-title"));

  it("removes a chapter and brings back only that one with Undo", async () => {
    setup();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove The old mill" }),
    );
    expect(titles()).toHaveLength(3);
    const cold = titles()[0] as HTMLElement;
    await userEvent.clear(cold);
    await userEvent.type(cold, "Welcome");
    await userEvent.click(
      screen.getByRole("button", { name: "Add at playhead" }),
    );
    expect(titles()).toHaveLength(4);
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(titles()).toHaveLength(5);
    expect(titles().map((t) => (t as HTMLInputElement).value)).toEqual([
      "Welcome",
      "The old mill",
      "Chapter 4",
      "What the river wanted",
      "Listener mail",
    ]);
  });

  it("adds a chapter at the playhead", async () => {
    setup();
    await userEvent.click(
      screen.getByRole("button", { name: "Add at playhead" }),
    );
    const times = screen
      .getAllByRole("textbox", { name: /^Time of/ })
      .map((t) => (t as HTMLInputElement).value);
    expect(times).toContain("12:04.0");
  });

  it("puts focus on the next chapter after a remove", async () => {
    setup();
    const button = screen.getByRole("button", { name: "Remove The old mill" });
    button.focus();
    fireEvent.click(button);
    const row = (document.activeElement as HTMLElement).closest(".dv-chapter");
    expect(
      row?.querySelector<HTMLInputElement>(".dv-chapter-title")?.value,
    ).toBe("What the river wanted");
  });
});

describe("the Add at playhead position", () => {
  it("never puts a chapter past the end of the episode", async () => {
    setup({ playhead: TOTAL + 500 });
    await userEvent.click(
      screen.getByRole("button", { name: "Add at playhead" }),
    );
    const times = screen
      .getAllByRole("textbox", { name: /^Time of/ })
      .map((t) => (t as HTMLInputElement).value);
    expect(times.at(-1)).toBe("52:00.0");
  });
});

describe("a selection that appears after a plain export", () => {
  it("does not make the export stale", () => {
    const all = props({ exportState: DONE });
    const { rerender } = render(<DeliverStage {...all} />);
    rerender(<DeliverStage {...all} selection={{ start: 40, end: 90 }} />);
    expect(screen.queryByText("Edited since export")).toBeNull();
  });
});

describe("names for assistive technology", () => {
  it("falls back for an empty title and tells duplicates apart", async () => {
    setup({
      initialChapters: [
        { id: "a", at: 0, title: "" },
        { id: "b", at: 10, title: "Same" },
        { id: "c", at: 20, title: "Same" },
      ],
    });
    expect(
      screen.getByRole("button", { name: "Remove chapter 1" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove Same 2" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove Same 3" }),
    ).toBeInTheDocument();
  });
});

describe("clips", () => {
  it("keeps focus on the clip after Approve", () => {
    setup();
    const approve = screen.getAllByRole("button", {
      name: /^Approve/,
    })[0] as HTMLElement;
    approve.focus();
    fireEvent.click(approve);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.textContent).toContain("Approved");
  });

  it("removes a clip, and Undo brings back only that clip", async () => {
    setup();
    await userEvent.click(
      screen.getByRole("button", { name: "More for The boat was still there" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Remove" }),
    );
    expect(screen.queryByDisplayValue("The boat was still there")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: /^Approve Nobody asked the river/ }),
    );
    await userEvent.type(clipTitle("Nobody asked the river"), "!");
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(
      screen.getByDisplayValue("The boat was still there"),
    ).toBeInTheDocument();
    expect(clipTitle("Nobody asked the river!")).toBeInTheDocument();
    expect(screen.getAllByText("Approved")).toHaveLength(2);
  });

  it("opens a clip in Edit from the more menu", async () => {
    const { all } = setup();
    await userEvent.click(
      screen.getByRole("button", { name: "More for Cold open" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Open in Edit" }),
    );
    expect(all.onOpenClipInEdit).toHaveBeenCalledWith("k3");
  });
});

describe("focus after Export", () => {
  it("stays inside the stage when the focused Export button goes away", () => {
    const all = props();
    const { rerender } = render(<DeliverStage {...all} />);
    const button = screen.getByRole("button", { name: /^Export/ });
    button.focus();
    const running: ExportState = {
      phase: "running",
      progress: 0.1,
      detail: "",
    };
    act(() => {
      rerender(<DeliverStage {...all} exportState={running} />);
    });
    expect(document.activeElement).toBe(
      document.querySelector(".dv-stage") as HTMLElement,
    );
  });
});

describe("states", () => {
  it("shows a guest a Cover and no controls", () => {
    setup({ guest: true });
    expect(screen.getByText("Only the host can deliver")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Export/ })).toBeNull();
  });

  it("shows skeletons and no fixes while loading", () => {
    const { container } = setup({ state: "loading", facts: OPEN_FACTS });
    expect(container.querySelectorAll(".sys-skeleton").length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(screen.queryByText("Ready to export")).toBeNull();
  });

  it("retries after an error", async () => {
    const onRetry = vi.fn();
    setup({ state: "error", onRetry });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("asks for the model before exporting", async () => {
    const { all } = setup({ exportState: NEEDS_MODEL });
    await userEvent.click(screen.getByRole("button", { name: "Get" }));
    expect(all.onGetModel).toHaveBeenCalledOnce();
  });
});

describe("what each part of the page shows", () => {
  const rowTitles = [
    "Exporting",
    "Export failed",
    "Edited since export",
    "Exported",
  ];
  const shown = () =>
    rowTitles.filter((t) => screen.queryByText(t, { exact: true }) !== null);

  it.each([
    [
      { phase: "running", progress: 0.2, detail: "x" } as ExportState,
      ["Exporting"],
    ],
    [{ phase: "failed", cause: "no disk" } as ExportState, ["Export failed"]],
    [DONE, ["Exported"]],
    [{ ...DONE, phase: "stale" } as ExportState, ["Edited since export"]],
    [NEVER, []],
  ])("shows only its own status row", (exportState, titles) => {
    setup({ exportState });
    expect(shown()).toEqual(titles);
  });

  it("lists exported files only after an export", () => {
    const never = setup();
    expect(never.container.querySelector(".dv-files")).toBeNull();
    never.unmount();
    const done = setup({ exportState: DONE });
    expect(done.container.querySelector(".dv-files")).not.toBeNull();
  });

  it("offers Reveal in the app and Download in a browser, for the file clicked", async () => {
    const app = setup({ exportState: DONE });
    await userEvent.click(
      screen.getAllByRole("button", { name: "Reveal" })[0] as HTMLElement,
    );
    expect(app.all.onReveal).toHaveBeenCalledWith(
      expect.objectContaining({ name: "field-notes.mp3" }),
    );
    expect(app.all.onDownload).not.toHaveBeenCalled();
    app.unmount();
    const browser = setup({ exportState: DONE, env: "browser" });
    expect(screen.queryByRole("button", { name: "Reveal" })).toBeNull();
    await userEvent.click(
      screen.getAllByRole("button", { name: "Download" })[0] as HTMLElement,
    );
    expect(browser.all.onDownload).toHaveBeenCalledWith(
      expect.objectContaining({ name: "field-notes.mp3" }),
    );
    expect(browser.all.onReveal).not.toHaveBeenCalled();
  });

  it("marks the listen link only after an export", () => {
    const never = setup();
    expect(never.container.querySelector("[data-highlight]")).toBeNull();
    never.unmount();
    const done = setup({ exportState: DONE });
    expect(done.container.querySelector("[data-highlight]")).not.toBeNull();
  });

  it("shows the listen link when ready and a skeleton while loading", () => {
    const ready = setup();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    ready.unmount();
    setup({ state: "loading" });
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("marks the page busy only while loading", () => {
    const ready = setup();
    expect(ready.container.querySelector(".dv-page[aria-busy]")).toBeNull();
    ready.unmount();
    const loading = setup({ state: "loading" });
    expect(
      loading.container.querySelector('.dv-page[aria-busy="true"]'),
    ).not.toBeNull();
  });

  it("shows which loudness and range are chosen", async () => {
    setup();
    const pressed = (name: RegExp | string) =>
      screen.getByRole("button", { name }).getAttribute("aria-pressed");
    expect(pressed(/^Podcast/)).toBe("true");
    expect(pressed(/^Broadcast/)).toBe("false");
    expect(pressed("Whole episode")).toBe("true");
    expect(pressed("Part…")).toBe("false");
    await userEvent.click(screen.getByRole("button", { name: "Part…" }));
    expect(pressed("Whole episode")).toBe("false");
    expect(pressed("Part…")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: /^Broadcast/ }));
    expect(pressed(/^Broadcast/)).toBe("true");
    expect(pressed(/^Podcast/)).toBe("false");
  });

  it("plays and pauses from the Player", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
  });

  it("shows one Find clips when there are no clips, and the strength and approval of each card", () => {
    const empty = setup({ initialClips: [] });
    expect(screen.getAllByRole("button", { name: "Find clips" })).toHaveLength(
      1,
    );
    empty.unmount();
    const full = setup();
    expect(
      full.container.querySelectorAll(".dv-clip[data-approved]"),
    ).toHaveLength(1);
    const on = (name: string) =>
      screen.getByRole("img", { name }).querySelectorAll("[data-on]").length;
    expect(on("Strong clip")).toBe(3);
    expect(on("Fair clip")).toBe(2);
    expect(on("Weak clip")).toBe(1);
  });
});

describe("the double-export timer", () => {
  it("is cancelled when the host answers, so it cannot release a later export early", () => {
    vi.useFakeTimers();
    try {
      const all = props();
      const { container, rerender } = render(<DeliverStage {...all} />);
      const stage = () => container.querySelector(".dv-stage") as Element;
      modE(stage());
      rerender(
        <DeliverStage {...all} exportState={{ phase: "failed", cause: "x" }} />,
      );
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      modE(stage());
      expect(all.onExport).toHaveBeenCalledTimes(2);
      act(() => {
        vi.advanceTimersByTime(1100);
      });
      modE(stage());
      expect(all.onExport).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Mod+E on Apple with both modifiers", () => {
  it("needs Cmd without Ctrl", () => {
    platform.apple = true;
    const { stage, all } = setup();
    fireEvent.keyDown(stage(), { key: "e", metaKey: true, ctrlKey: true });
    expect(all.onExport).not.toHaveBeenCalled();
  });
});

describe("Mod+E only for E", () => {
  it("ignores other chords and plain E, and takes the browser's Ctrl+E", () => {
    const { stage, all } = setup();
    for (const key of ["c", "v", "z", "a", "s"]) modE(stage(), { key });
    fireEvent.keyDown(stage(), { key: "e" });
    expect(all.onExport).not.toHaveBeenCalled();
    const event = new KeyboardEvent("keydown", {
      key: "e",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    stage().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(all.onExport).toHaveBeenCalledOnce();
  });

  it("leaves typing in a title alone but still exports with the chord", async () => {
    const { all } = setup();
    const title = chapterTitle("The old mill");
    await userEvent.type(title, "e");
    expect(all.onExport).not.toHaveBeenCalled();
    expect(title).toHaveValue("The old mille");
    fireEvent.keyDown(title, { key: "c", ctrlKey: true });
    expect(all.onExport).not.toHaveBeenCalled();
    fireEvent.keyDown(title, { key: "e", ctrlKey: true });
    expect(all.onExport).toHaveBeenCalledOnce();
  });
});

describe("Export button range", () => {
  it("writes the Deliver range, not the Edit selection", async () => {
    const { all } = setup({ selection: { start: 40, end: 90 } });
    await userEvent.click(screen.getByRole("button", { name: /^Export/ }));
    expect(vi.mocked(all.onExport).mock.calls[0]?.[0].range).toBeNull();
  });
});

describe("primary buttons after an export", () => {
  it("Reveal calls onReveal and Download calls onDownload, with no file", async () => {
    const app = setup({ exportState: DONE });
    await userEvent.click(screen.getByRole("button", { name: REVEAL }));
    expect(app.all.onReveal).toHaveBeenCalledWith();
    expect(app.all.onDownload).not.toHaveBeenCalled();
    app.unmount();
    const browser = setup({ exportState: DONE, env: "browser" });
    await userEvent.click(screen.getByRole("button", { name: "Download all" }));
    expect(browser.all.onDownload).toHaveBeenCalledWith();
    expect(browser.all.onReveal).not.toHaveBeenCalled();
  });

  it("says Reveal in Finder on Apple platforms", () => {
    platform.apple = true;
    setup({ exportState: DONE });
    expect(
      screen.getByRole("button", { name: "Reveal in Finder" }),
    ).toBeInTheDocument();
  });
});

describe("host callbacks", () => {
  it("Cancel, Copy, Change, Play, Find clips and Refresh mix reach the host", async () => {
    const running = setup({
      exportState: { phase: "running", progress: 0.3, detail: "x" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(running.all.onCancel).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(running.all.onChangeFolder).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(running.all.onCopyLink).toHaveBeenCalledOnce();
    await userEvent.click(
      screen.getByRole("button", { name: "Play from The old mill" }),
    );
    expect(running.all.onPlayFrom).toHaveBeenCalledWith(312.4);
    await userEvent.click(
      screen.getByRole("button", { name: "Play The boat was still there" }),
    );
    expect(running.all.onPlayClip).toHaveBeenCalledWith("k2");
    await userEvent.click(screen.getByRole("button", { name: "Find clips" }));
    expect(running.all.onFindClips).toHaveBeenCalledOnce();
    running.unmount();
    const noMix = setup({ link: { url: null, noMix: true } });
    await userEvent.click(screen.getByRole("button", { name: "Refresh mix" }));
    expect(noMix.all.onRefreshMix).toHaveBeenCalledOnce();
  });
});

describe("empty lists", () => {
  it("lets you add the first chapter", async () => {
    setup({ initialChapters: [] });
    await userEvent.click(
      screen.getByRole("button", { name: "Add at playhead" }),
    );
    expect(
      screen.getAllByRole("textbox", {
        name: /^Title of chapter|Title of Chapter/,
      }),
    ).toHaveLength(1);
  });

  it("offers Find clips when there are no clips", async () => {
    const { all } = setup({ initialClips: [] });
    expect(screen.getByText("No clip ideas yet.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Find clips" }));
    expect(all.onFindClips).toHaveBeenCalledOnce();
  });
});

describe("Part range", () => {
  const field = (name: string) =>
    screen.getByRole("textbox", { name }) as HTMLInputElement;
  const type = async (name: string, text: string) => {
    await userEvent.clear(field(name));
    await userEvent.type(field(name), `${text}{Enter}`);
  };

  it("starts at the beginning and runs a minute", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Part…" }));
    expect(field("In")).toHaveValue("0:00.0");
    expect(field("Out")).toHaveValue("1:00.0");
  });

  it("never starts past the end of a short episode", async () => {
    setup({ total: 45 });
    await userEvent.click(screen.getByRole("button", { name: "Part…" }));
    expect(field("Out")).toHaveValue("0:45.0");
  });

  it("moves In and Out independently and keeps them apart", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Part…" }));
    await type("Out", "0:30");
    expect(field("In")).toHaveValue("0:00.0");
    expect(field("Out")).toHaveValue("0:30.0");
    await type("In", "0:10");
    expect(field("In")).toHaveValue("0:10.0");
    expect(field("Out")).toHaveValue("0:30.0");
    await type("In", "0:45");
    expect(field("Out")).toHaveValue("0:46.0");
  });

  it("sizes each format chip from the part, not the episode", async () => {
    setup();
    expect(screen.getByRole("button", { name: /^MP3/ })).toHaveTextContent(
      "50 MB",
    );
    await userEvent.click(screen.getByRole("button", { name: "Part…" }));
    expect(screen.getByRole("button", { name: /^MP3/ })).toHaveTextContent(
      "960 KB",
    );
  });
});

describe("clip Undo", () => {
  const order = () =>
    screen
      .getAllByRole("textbox")
      .filter((el) => el.classList.contains("dv-clip-title"))
      .map((el) => (el as HTMLInputElement).value);

  it("puts the clip back where it was and dismisses the toast", async () => {
    setup();
    const before = order();
    await userEvent.click(
      screen.getByRole("button", { name: "More for The boat was still there" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Remove" }),
    );
    expect(
      screen.getByText("Removed The boat was still there"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(order()).toEqual(before);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});

describe("trimming a clip", () => {
  const open = async () => {
    await userEvent.click(
      screen.getByRole("button", { name: "More for Cold open" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Trim" }),
    );
  };

  it("moves Out and In separately and shows the new length", async () => {
    setup();
    await open();
    const out = screen.getByRole("textbox", { name: "Out of Cold open" });
    await userEvent.clear(out);
    await userEvent.type(out, "0:20{Enter}");
    expect(
      screen.getByRole("textbox", { name: "In of Cold open" }),
    ).toHaveValue("0:00.0");
    expect(screen.getByText("20.0 s")).toBeInTheDocument();
    const start = screen.getByRole("textbox", { name: "In of Cold open" });
    await userEvent.clear(start);
    await userEvent.type(start, "0:05{Enter}");
    expect(out).toHaveValue("0:20.0");
    expect(screen.getByText("15.0 s")).toBeInTheDocument();
  });

  it("stops at the end of the episode and closes again from the menu", async () => {
    setup();
    await open();
    const out = screen.getByRole("textbox", { name: "Out of Cold open" });
    await userEvent.clear(out);
    await userEvent.type(out, "99:00{Enter}");
    expect(out).toHaveValue("52:00.0");
    await userEvent.click(
      screen.getByRole("button", { name: "More for Cold open" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Done trimming" }),
    );
    expect(
      screen.queryByRole("textbox", { name: "In of Cold open" }),
    ).toBeNull();
  });
});

describe("the listen link follows what is shown", () => {
  it("loses its mark when the export goes stale", async () => {
    const { container } = setup({ exportState: DONE });
    expect(container.querySelector("[data-highlight]")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^Streaming/ }));
    expect(container.querySelector("[data-highlight]")).toBeNull();
  });
});

describe("what the status rows say", () => {
  it("shows the file list, folder and times", () => {
    setup({ exportState: DONE });
    expect(screen.getByText("Field Notes/export")).toBeInTheDocument();
    expect(screen.getByText("Last export 2 h ago")).toBeInTheDocument();
    expect(screen.getByText("field-notes.wav")).toBeInTheDocument();
    expect(screen.getByText("clips/cold-open.wav")).toBeInTheDocument();
  });

  it("shows why an export failed and what is running", () => {
    const failed = setup({
      exportState: { phase: "failed", cause: "The disk is full." },
    });
    expect(screen.getByText("The disk is full.")).toBeInTheDocument();
    failed.unmount();
    setup({
      exportState: { phase: "running", progress: 0.6, detail: "Mastering 60%" },
    });
    expect(screen.getByText("Mastering 60%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });
});

describe("the right item gets the action", () => {
  it("approves only the clip whose button was pressed", async () => {
    setup();
    await userEvent.click(
      screen.getByRole("button", { name: "Approve The boat was still there" }),
    );
    expect(
      screen.queryByRole("button", {
        name: "Approve The boat was still there",
      }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Approve Nobody asked the river" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Approved")).toHaveLength(2);
  });

  it("trims and plays the clip whose menu or button was used", async () => {
    const { all } = setup();
    await userEvent.click(
      screen.getByRole("button", { name: "More for The boat was still there" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Trim" }),
    );
    expect(
      screen.getByRole("textbox", { name: "In of The boat was still there" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "In of Nobody asked the river" }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "More for The boat was still there" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Open in Edit" }),
    );
    expect(all.onOpenClipInEdit).toHaveBeenCalledWith("k2");
  });
});

describe("a stale export still has its files", () => {
  it("lists them with working Reveal and Download buttons", async () => {
    const stale = { ...DONE, phase: "stale" } as ExportState;
    const app = setup({ exportState: stale });
    expect(screen.getByText("field-notes.wav")).toBeInTheDocument();
    await userEvent.click(
      screen.getAllByRole("button", { name: "Reveal" })[1] as HTMLElement,
    );
    expect(app.all.onReveal).toHaveBeenCalledWith(
      expect.objectContaining({ name: "field-notes.wav" }),
    );
    app.unmount();
    const browser = setup({ exportState: stale, env: "browser" });
    await userEvent.click(
      screen.getAllByRole("button", { name: "Download" })[0] as HTMLElement,
    );
    expect(browser.all.onDownload).toHaveBeenCalledWith(
      expect.objectContaining({ name: "field-notes.mp3" }),
    );
  });
});

describe("Mod+E on other platforms with both modifiers", () => {
  it("needs Ctrl without Cmd", () => {
    const { stage, all } = setup();
    fireEvent.keyDown(stage(), { key: "e", ctrlKey: true, metaKey: true });
    expect(all.onExport).not.toHaveBeenCalled();
  });
});

describe("state edits build on each other", () => {
  it("keeps every chapter and clip edit made one after the other", async () => {
    setup();
    await userEvent.type(chapterTitle("Cold open"), "!");
    const time = screen.getByRole("textbox", { name: "Time of The old mill" });
    await userEvent.clear(time);
    await userEvent.type(time, "6:00{Enter}");
    await userEvent.click(
      screen.getByRole("button", { name: "Add at playhead" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Listener mail" }),
    );
    const titles = screen
      .getAllByRole("textbox")
      .filter((el) => el.classList.contains("dv-chapter-title"))
      .map((el) => (el as HTMLInputElement).value);
    expect(titles).toEqual([
      "Cold open!",
      "The old mill",
      "Chapter 5",
      "What the river wanted",
    ]);
    await userEvent.type(clipTitle("Nobody asked the river"), "?");
    await userEvent.click(
      screen.getByRole("button", { name: "Approve The boat was still there" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "More for Cold open" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Trim" }),
    );
    const out = screen.getByRole("textbox", { name: "Out of Cold open" });
    await userEvent.clear(out);
    await userEvent.type(out, "0:20{Enter}");
    expect(clipTitle("Nobody asked the river?")).toBeInTheDocument();
    expect(screen.getAllByText("Approved")).toHaveLength(2);
    expect(screen.getByText("20.0 s")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "More for The boat was still there" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Remove" }),
    );
    expect(clipTitle("Nobody asked the river?")).toBeInTheDocument();
    expect(screen.getByText("20.0 s")).toBeInTheDocument();
    expect(chapterTitle("Cold open!")).toBeInTheDocument();
  });

  it("holds a chapter time at the end of the episode", async () => {
    setup();
    const time = screen.getByRole("textbox", { name: "Time of The old mill" });
    await userEvent.clear(time);
    await userEvent.type(time, "99:00{Enter}");
    expect(
      screen.getByRole("textbox", { name: "Time of The old mill" }),
    ).toHaveValue("52:00.0");
  });
});

describe("export settings reach the stage", () => {
  it("blocks Export once every format is off, and says why", async () => {
    const { stage, all } = setup();
    await userEvent.click(screen.getByRole("button", { name: /^MP3/ }));
    await userEvent.click(screen.getByRole("button", { name: /^WAV/ }));
    const button = screen.getByRole("button", { name: /^Export/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Choose a format first.");
    modE(stage());
    expect(all.onExport).not.toHaveBeenCalled();
  });

  it("brings Export back in the phone foot when the export goes stale", async () => {
    setup({ exportState: DONE, layout: "phone" });
    expect(screen.queryByRole("button", { name: /^Export/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^Streaming/ }));
    expect(screen.getByRole("button", { name: /^Export/ })).toBeEnabled();
  });

  it("shows In and Out only for a Part", () => {
    setup();
    expect(screen.queryByRole("textbox", { name: "In" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Out" })).toBeNull();
  });

  it("lets In and Out reach the end of the episode, not just the part length", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Part…" }));
    const start = screen.getByRole("textbox", { name: "In" });
    await userEvent.clear(start);
    await userEvent.type(start, "10:00{Enter}");
    expect(screen.getByRole("textbox", { name: "In" })).toHaveValue("10:00.0");
    const out = screen.getByRole("textbox", { name: "Out" });
    await userEvent.clear(out);
    await userEvent.type(out, "99:00{Enter}");
    expect(screen.getByRole("textbox", { name: "Out" })).toHaveValue("52:00.0");
  });
});

describe("the model row", () => {
  it("shows only while the model is missing, with its size and a working Get", async () => {
    const never = setup();
    expect(screen.queryByText(/^Needs the/)).toBeNull();
    never.unmount();
    const missing = setup({ exportState: NEEDS_MODEL });
    expect(
      screen.getByText("Needs the transcription model"),
    ).toBeInTheDocument();
    expect(screen.getByText("1.6 GB")).toBeInTheDocument();
    missing.unmount();
    setup({ exportState: NEEDS_MODEL, onGetModel: undefined });
    expect(screen.queryByRole("button", { name: "Get" })).toBeNull();
  });
});

describe("files of an export", () => {
  const stale = { ...DONE, phase: "stale" } as ExportState;

  it("each row names its own file and size and acts on that file", async () => {
    const app = setup({ exportState: stale });
    expect(screen.getByText("field-notes.mp3")).toBeInTheDocument();
    const files = within(
      app.container.querySelector(".dv-files") as HTMLElement,
    );
    expect(files.getByText("50 MB")).toBeInTheDocument();
    expect(files.getByText("550 MB")).toBeInTheDocument();
    app.unmount();
    const browser = setup({ exportState: stale, env: "browser" });
    await userEvent.click(
      screen.getAllByRole("button", { name: "Download" })[1] as HTMLElement,
    );
    expect(browser.all.onDownload).toHaveBeenCalledWith(
      expect.objectContaining({ name: "field-notes.wav" }),
    );
  });
});

describe("the phone layout", () => {
  it("shows chapters and clips once, and Share instead of Copy", () => {
    setup({ layout: "phone" });
    expect(screen.getAllByRole("heading", { name: "Chapters" })).toHaveLength(
      1,
    );
    expect(screen.getAllByRole("heading", { name: "Clips" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    expect(screen.queryByText("Viewer")).toBeNull();
  });

  it("shows chapters and clips once on desktop too, with the word Viewer", () => {
    setup();
    expect(screen.getAllByRole("heading", { name: "Chapters" })).toHaveLength(
      1,
    );
    expect(screen.getAllByRole("heading", { name: "Clips" })).toHaveLength(1);
    expect(screen.getByText("Viewer")).toBeInTheDocument();
    expect(screen.getByText("Pinned to Rough cut")).toBeInTheDocument();
  });
});

describe("Mod+E on Apple without a modifier", () => {
  it("does not export on a plain E", () => {
    platform.apple = true;
    const { stage, all } = setup();
    fireEvent.keyDown(stage(), { key: "e" });
    expect(all.onExport).not.toHaveBeenCalled();
  });
});

describe("the error cover without a retry", () => {
  it("offers no button when the host gave no way to retry", () => {
    setup({ state: "error", onRetry: undefined });
    expect(screen.getByText("Could not load Deliver")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});

describe("the toast and the Player", () => {
  it("keeps the Undo toast for the time the host asked for", () => {
    vi.useFakeTimers();
    try {
      setup({ toastMs: 5000 });
      fireEvent.click(
        screen.getByRole("button", { name: "Remove The old mill" }),
      );
      expect(screen.getByText("Removed The old mill")).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(screen.getByText("Removed The old mill")).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(screen.queryByText("Removed The old mill")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the time and the total in the right places", () => {
    setup({ clock: { time: "12:04", total: "52:00" } });
    expect(screen.getByText("12:04")).toBeInTheDocument();
    expect(screen.getByText(/52:00/)).toBeInTheDocument();
    expect(screen.getByText("12:04").textContent).not.toContain("52:00");
  });
});

describe("rendering the whole page", () => {
  it("raises no React warnings, such as repeated keys", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      setup({
        exportState: DONE,
        link: {
          url: "https://x.example/abc",
          openedBy: [{ name: "Rosa" }, { name: "Jon" }],
        },
      });
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("shows each readiness row with its own title and detail", () => {
    setup({ facts: { ...OPEN_FACTS, mixUpToDate: false, truePeak: -2.1 } });
    const text = document.body.textContent ?? "";
    for (const part of [
      "Suggestions decided",
      "14 of 14",
      "Comments resolved",
      "2 of 3",
      "Unsure words checked",
      "2 left",
      "Edited since the last mix",
      "−2.1 dBTP",
      "23.6 s",
    ]) {
      expect(text).toContain(part);
    }
  });
});

describe("more of what the page shows", () => {
  it("gives each readiness row its own state", () => {
    const { container } = setup({ facts: OPEN_FACTS });
    const states = [
      ...container.querySelectorAll(".dv-readiness-list [data-state]"),
    ].map((el) => el.getAttribute("data-state"));
    expect(states).toEqual([
      "done",
      "needs-you",
      "needs-you",
      "done",
      "done",
      "done",
      "done",
      "done",
    ]);
  });

  it("goes stale when one format is swapped for another", async () => {
    setup({ exportState: DONE });
    await userEvent.click(screen.getByRole("button", { name: /^WAV/ }));
    await userEvent.click(screen.getByRole("button", { name: /^FLAC/ }));
    expect(screen.getByText("Edited since export")).toBeInTheDocument();
  });

  it("explains an empty chapter list", () => {
    setup({ initialChapters: [] });
    expect(
      screen.getByText(/Chapters help listeners skip around/),
    ).toBeInTheDocument();
  });
});

describe("chapters added at the playhead keep their own ids", () => {
  const add = () =>
    userEvent.click(screen.getByRole("button", { name: "Add at playhead" }));
  const title = (name: string) =>
    screen.getByRole("textbox", { name: `Title of ${name}` });
  const time = (name: string) =>
    screen.getByRole("textbox", { name: `Time of ${name}` });

  it("retitles, retimes and removes one of two added chapters without touching the other", async () => {
    setup();
    await add();
    await add();
    const secondTitle = title("Chapter 6");
    const secondTime = time("Chapter 6");
    await userEvent.clear(secondTitle);
    await userEvent.type(secondTitle, "Second");
    expect(title("Chapter 5")).toHaveValue("Chapter 5");
    expect(time("Chapter 5")).toHaveValue("12:04.0");
    await userEvent.clear(secondTime);
    await userEvent.type(secondTime, "1:40{Enter}");
    expect(time("Second")).toHaveValue("1:40.0");
    expect(time("Chapter 5")).toHaveValue("12:04.0");
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Second" }),
    );
    expect(title("Chapter 5")).toHaveValue("Chapter 5");
    expect(
      screen.queryByRole("textbox", { name: "Title of Second" }),
    ).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(title("Second")).toHaveValue("Second");
    expect(title("Chapter 5")).toHaveValue("Chapter 5");
  });

  it("removes only the chapter asked for, whichever of the two it is", async () => {
    setup();
    await add();
    await add();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Chapter 5" }),
    );
    expect(title("Chapter 6")).toHaveValue("Chapter 6");
    expect(
      screen.queryByRole("textbox", { name: "Title of Chapter 5" }),
    ).toBeNull();
  });

  it("gives chapters added after a remove an id that is not in use", async () => {
    setup();
    await add();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Chapter 5" }),
    );
    await add();
    await add();
    const values = () =>
      screen
        .getAllByRole("textbox", { name: /^Title of/ })
        .filter((el) => el.classList.contains("dv-chapter-title"))
        .map((el) => (el as HTMLInputElement).value);
    const before = values();
    expect(new Set(before).size).toBe(before.length);
    const added = screen.getByRole("textbox", { name: "Title of Chapter 6" });
    await userEvent.clear(added);
    await userEvent.type(added, "Changed");
    const after = values();
    expect(after.filter((v) => v === "Changed")).toHaveLength(1);
    expect(after).toHaveLength(before.length);
  });
});

describe.each(["desktop", "phone"] as const)(
  "every action on the %s layout",
  (layout) => {
    it("Export sends the request, from a fresh state and from a stale one", async () => {
      const fresh = setup({ layout });
      await userEvent.click(screen.getByRole("button", { name: /^Export/ }));
      expect(fresh.all.onExport).toHaveBeenCalledOnce();
      expect(fresh.all.onExport).toHaveBeenCalledWith(REQUEST);
      expect(fresh.all.onReveal).not.toHaveBeenCalled();
      expect(fresh.all.onDownload).not.toHaveBeenCalled();
      fresh.unmount();
      const stale = setup({
        layout,
        exportState: { ...DONE, phase: "stale" } as ExportState,
      });
      await userEvent.click(screen.getByRole("button", { name: /^Export/ }));
      expect(stale.all.onExport).toHaveBeenCalledOnce();
      expect(stale.all.onReveal).not.toHaveBeenCalled();
      expect(stale.all.onDownload).not.toHaveBeenCalled();
    });

    it("Mod+E exports the same request the button does", () => {
      const { stage, all } = setup({ layout });
      modE(stage());
      expect(all.onExport).toHaveBeenCalledWith(REQUEST);
    });

    it("Reveal reaches onReveal alone, with no file", async () => {
      const { all } = setup({ layout, exportState: DONE });
      await userEvent.click(screen.getByRole("button", { name: REVEAL }));
      expect(all.onReveal).toHaveBeenCalledOnce();
      expect(all.onReveal).toHaveBeenCalledWith();
      expect(all.onDownload).not.toHaveBeenCalled();
      expect(all.onExport).not.toHaveBeenCalled();
    });

    it("Download all reaches onDownload alone, with no file", async () => {
      const { all } = setup({ layout, exportState: DONE, env: "browser" });
      await userEvent.click(
        screen.getByRole("button", { name: "Download all" }),
      );
      expect(all.onDownload).toHaveBeenCalledOnce();
      expect(all.onDownload).toHaveBeenCalledWith();
      expect(all.onReveal).not.toHaveBeenCalled();
      expect(all.onExport).not.toHaveBeenCalled();
    });

    it("a file row acts on its own file in the app, done or stale", async () => {
      for (const phase of ["done", "stale"] as const) {
        const { all, unmount } = setup({
          layout,
          exportState: { ...DONE, phase } as ExportState,
        });
        const rows = screen.getAllByRole("button", { name: "Reveal" });
        await userEvent.click(rows[1] as HTMLElement);
        expect(all.onReveal).toHaveBeenCalledOnce();
        expect(all.onReveal).toHaveBeenCalledWith(
          expect.objectContaining({ name: "field-notes.wav" }),
        );
        await userEvent.click(rows[0] as HTMLElement);
        expect(all.onReveal).toHaveBeenLastCalledWith(
          expect.objectContaining({ name: "field-notes.mp3" }),
        );
        expect(all.onDownload).not.toHaveBeenCalled();
        unmount();
      }
    });

    it("a file row acts on its own file in the browser, done or stale", async () => {
      for (const phase of ["done", "stale"] as const) {
        const { all, unmount } = setup({
          layout,
          env: "browser",
          exportState: { ...DONE, phase } as ExportState,
        });
        const rows = screen.getAllByRole("button", { name: "Download" });
        await userEvent.click(rows[1] as HTMLElement);
        expect(all.onDownload).toHaveBeenCalledOnce();
        expect(all.onDownload).toHaveBeenCalledWith(
          expect.objectContaining({ name: "field-notes.wav" }),
        );
        await userEvent.click(rows[0] as HTMLElement);
        expect(all.onDownload).toHaveBeenLastCalledWith(
          expect.objectContaining({ name: "field-notes.mp3" }),
        );
        expect(all.onReveal).not.toHaveBeenCalled();
        unmount();
      }
    });

    it("Copy or Share reaches onCopyLink alone, in every phase", async () => {
      const label = layout === "phone" ? "Share" : "Copy";
      for (const exportState of [NEVER, DONE]) {
        const { all, unmount } = setup({
          layout,
          exportState,
          link: { url: "https://x.test/l/abc" },
        });
        await userEvent.click(screen.getByRole("button", { name: label }));
        expect(all.onCopyLink).toHaveBeenCalledOnce();
        expect(all.onExport).not.toHaveBeenCalled();
        unmount();
      }
    });

    it("Undo brings back a removed chapter and a removed clip", async () => {
      setup({ layout });
      await userEvent.click(
        screen.getByRole("button", { name: "Remove The old mill" }),
      );
      expect(screen.queryByDisplayValue("The old mill")).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Undo" }));
      expect(screen.getByDisplayValue("The old mill")).toBeInTheDocument();
      await userEvent.click(
        screen.getByRole("button", {
          name: "More for The boat was still there",
        }),
      );
      await userEvent.click(
        await screen.findByRole("menuitem", { name: "Remove" }),
      );
      expect(screen.queryByDisplayValue("The boat was still there")).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Undo" }));
      expect(
        screen.getByDisplayValue("The boat was still there"),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    });

    it("Dismiss closes the toast without undoing", async () => {
      setup({ layout });
      await userEvent.click(
        screen.getByRole("button", { name: "Remove The old mill" }),
      );
      await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByText("Removed The old mill")).toBeNull();
      expect(screen.queryByDisplayValue("The old mill")).toBeNull();
    });

    it("every other host callback gets its own argument", async () => {
      const app = setup({
        layout,
        facts: OPEN_FACTS,
        exportState: NEEDS_MODEL,
        link: { url: null, noMix: true },
      });
      await userEvent.click(screen.getByRole("button", { name: "Get" }));
      expect(app.all.onGetModel).toHaveBeenCalledOnce();
      await userEvent.click(screen.getByRole("button", { name: "Change" }));
      expect(app.all.onChangeFolder).toHaveBeenCalledOnce();
      await userEvent.click(
        screen.getByRole("button", { name: "Refresh mix" }),
      );
      expect(app.all.onRefreshMix).toHaveBeenCalledOnce();
      await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
      expect(app.all.onFix).toHaveBeenCalledWith("review", "comments");
      await userEvent.click(
        screen.getByRole("button", { name: "Play from The old mill" }),
      );
      expect(app.all.onPlayFrom).toHaveBeenCalledWith(312.4);
      await userEvent.click(
        screen.getByRole("button", { name: "Play Nobody asked the river" }),
      );
      expect(app.all.onPlayClip).toHaveBeenCalledWith("k1");
      await userEvent.click(screen.getByRole("button", { name: "Find clips" }));
      expect(app.all.onFindClips).toHaveBeenCalledOnce();
      await userEvent.click(
        screen.getByRole("button", {
          name: "More for The boat was still there",
        }),
      );
      await userEvent.click(
        await screen.findByRole("menuitem", { name: "Open in Edit" }),
      );
      expect(app.all.onOpenClipInEdit).toHaveBeenCalledWith("k2");
    });

    it("Cancel reaches onCancel while exporting, and Export is off", async () => {
      const { all } = setup({
        layout,
        exportState: { phase: "running", progress: 0.3, detail: "x" },
      });
      expect(screen.getByRole("button", { name: /^Export/ })).toBeDisabled();
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(all.onCancel).toHaveBeenCalledOnce();
      expect(all.onExport).not.toHaveBeenCalled();
    });

    it("shows a guest only the cover, with no dock and no controls", () => {
      const { container } = setup({ layout, guest: true });
      expect(screen.getByText("Only the host can deliver")).toBeInTheDocument();
      expect(container.querySelector(".dv-foot")).toBeNull();
      expect(screen.queryAllByRole("button")).toHaveLength(0);
      expect(container.querySelector(".dv-stage")).toHaveAttribute(
        "data-layout",
        layout,
      );
    });

    it("shows an error only the cover, with Try again", async () => {
      const onRetry = vi.fn();
      const { container } = setup({ layout, state: "error", onRetry });
      expect(container.querySelector(".dv-foot")).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(onRetry).toHaveBeenCalledOnce();
    });
  },
);

describe("toasts and timers", () => {
  const remove = (name: string) =>
    fireEvent.click(screen.getByRole("button", { name: `Remove ${name}` }));
  const wait = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });

  it("a second toast replaces the first and gets its full time", () => {
    vi.useFakeTimers();
    try {
      setup({ toastMs: 5000 });
      remove("The old mill");
      wait(4000);
      remove("What the river wanted");
      expect(screen.queryByText("Removed The old mill")).toBeNull();
      expect(
        screen.getByText("Removed What the river wanted"),
      ).toBeInTheDocument();
      wait(4000);
      expect(
        screen.getByText("Removed What the river wanted"),
      ).toBeInTheDocument();
      wait(1500);
      expect(screen.queryByText("Removed What the river wanted")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Undo after a second removal brings back only the second", () => {
    vi.useFakeTimers();
    try {
      setup();
      remove("The old mill");
      remove("What the river wanted");
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      expect(
        screen.getByDisplayValue("What the river wanted"),
      ).toBeInTheDocument();
      expect(screen.queryByDisplayValue("The old mill")).toBeNull();
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a toast that timed out leaves no Undo behind", () => {
    vi.useFakeTimers();
    try {
      setup({ toastMs: 1000 });
      remove("The old mill");
      wait(1500);
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves no timer running once unmounted, with a toast and an export in flight", () => {
    vi.useFakeTimers();
    try {
      const { unmount, all, stage } = setup({ toastMs: 5000 });
      remove("The old mill");
      modE(stage());
      expect(all.onExport).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      unmount();
      expect(vi.getTimerCount()).toBe(0);
      wait(10_000);
      expect(error).not.toHaveBeenCalled();
      error.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets Export run again 2 seconds after an answer that never came", () => {
    vi.useFakeTimers();
    try {
      const { stage, all } = setup();
      modE(stage());
      wait(1900);
      modE(stage());
      expect(all.onExport).toHaveBeenCalledOnce();
      wait(200);
      modE(stage());
      expect(all.onExport).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the stage keeps its layout name in every state", () => {
  it.each(["desktop", "phone"] as const)(
    "marks the %s layout while ready, loading and on error",
    (layout) => {
      for (const state of ["ready", "loading", "error"] as const) {
        const { container, unmount } = setup({ layout, state });
        expect(container.querySelector(".dv-stage")).toHaveAttribute(
          "data-layout",
          layout,
        );
        unmount();
      }
    },
  );

  it("is the desktop layout unless told otherwise", () => {
    const { container } = setup({ layout: undefined });
    expect(container.querySelector(".dv-stage")).toHaveAttribute(
      "data-layout",
      "desktop",
    );
    expect(container.querySelector(".dv-foot .dv-export")).toBeNull();
  });
});

describe("timers that depend on the host's settings", () => {
  const wait = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });

  it("keeps the Undo toast for six seconds when the host does not say", () => {
    vi.useFakeTimers();
    try {
      setup({ toastMs: undefined });
      fireEvent.click(
        screen.getByRole("button", { name: "Remove The old mill" }),
      );
      wait(5900);
      expect(screen.getByText("Removed The old mill")).toBeInTheDocument();
      wait(200);
      expect(screen.queryByText("Removed The old mill")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the double-export guard through re-renders until the host answers", async () => {
    const { stage, all } = setup();
    modE(stage());
    await userEvent.click(
      screen.getByRole("button", { name: "Remove The old mill" }),
    );
    modE(stage());
    expect(all.onExport).toHaveBeenCalledOnce();
  });
});

describe("loading skeletons and the toast dock", () => {
  it("draw each section in its own layout and row count", () => {
    vi.useFakeTimers();
    try {
      const { container } = setup({ state: "loading" });
      act(() => {
        vi.advanceTimersByTime(400);
      });
      const blocks = [...container.querySelectorAll(".sys-skeleton-blocks")];
      expect(
        blocks.map((b) => [b.className.split("--")[1], b.children.length]),
      ).toEqual([
        ["list", 4],
        ["list", 4],
        ["list", 3],
        ["cards", 3],
        ["list", 2],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts the toast region in the dock", () => {
    const { container } = setup();
    expect(container.querySelector(".ui-toast-region")).toHaveClass(
      "sys-toast-dock",
    );
  });
});

describe("what the last audit found unguarded", () => {
  it("keeps a space typed in a chapter title, even a trailing one", async () => {
    setup();
    const input = screen.getByRole("textbox", {
      name: "Title of The old mill",
    });
    await userEvent.clear(input);
    await userEvent.type(input, "Down by the mill ");
    expect(input).toHaveValue("Down by the mill ");
  });

  describe("Readiness fixes with a suggestion row first", () => {
    const open = {
      ...CLEAR_FACTS,
      suggestions: { decided: 10, total: 14 },
      mixUpToDate: false,
      truePeak: -0.5,
    };

    it("opens the stage each row names", async () => {
      const { all } = setup({ facts: open });
      await userEvent.click(
        screen.getByRole("button", { name: "Refresh mix" }),
      );
      expect(all.onFix).toHaveBeenLastCalledWith("edit", "mix");
      await userEvent.click(screen.getByRole("button", { name: "Fix" }));
      expect(all.onFix).toHaveBeenLastCalledWith("edit", "peaks");
      await userEvent.click(screen.getByRole("button", { name: "Review" }));
      expect(all.onFix).toHaveBeenLastCalledWith("review", "suggestions");
    });

    it("counts the open suggestion in the summary", () => {
      setup({ facts: open });
      expect(
        screen.getByText("3 things left. You can still export."),
      ).toBeInTheDocument();
    });

    it("says one thing left when only a suggestion is open", () => {
      setup({
        facts: { ...CLEAR_FACTS, suggestions: { decided: 13, total: 14 } },
      });
      expect(
        screen.getByText("1 thing left. You can still export."),
      ).toBeInTheDocument();
    });
  });

  it("does not call one unsure word done, and still offers Check", async () => {
    const { all } = setup({ facts: { ...CLEAR_FACTS, unsureWordsLeft: 1 } });
    expect(
      screen.getByText("1 thing left. You can still export."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(all.onFix).toHaveBeenCalledWith("review", "unsure-words");
  });

  it("shows which formats are on, WAV and FLAC included", async () => {
    setup();
    const on = (name: RegExp) =>
      screen.getByRole("button", { name }).getAttribute("aria-pressed");
    expect([on(/^MP3/), on(/^WAV/), on(/^FLAC/)]).toEqual([
      "true",
      "true",
      "false",
    ]);
    await userEvent.click(screen.getByRole("button", { name: /^FLAC/ }));
    await userEvent.click(screen.getByRole("button", { name: /^MP3/ }));
    expect([on(/^MP3/), on(/^WAV/), on(/^FLAC/)]).toEqual([
      "false",
      "true",
      "true",
    ]);
  });

  it("keeps Out above In when Out is typed below it", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Part…" }));
    const start = screen.getByRole("textbox", { name: "In" });
    await userEvent.clear(start);
    await userEvent.type(start, "10:00{Enter}");
    const out = screen.getByRole("textbox", { name: "Out" });
    await userEvent.clear(out);
    await userEvent.type(out, "5:00{Enter}");
    expect(screen.getByRole("textbox", { name: "In" })).toHaveValue("10:00.0");
    expect(screen.getByRole("textbox", { name: "Out" })).toHaveValue("10:01.0");
  });

  it("holds a clip's Out at the episode end even when its In sits at the end", async () => {
    setup({
      initialClips: [
        {
          id: "z",
          title: "Last gasp",
          start: TOTAL - 0.2,
          end: TOTAL,
          score: 0.5,
          approved: false,
        },
      ],
    });
    await userEvent.click(
      screen.getByRole("button", { name: "More for Last gasp" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Trim" }),
    );
    const out = screen.getByRole("textbox", { name: "Out of Last gasp" });
    await userEvent.clear(out);
    await userEvent.type(out, "0:10{Enter}");
    expect(out).toHaveValue("52:00.0");
  });

  it("fires Refresh mix, not Try again, when both handlers exist", async () => {
    const onRetry = vi.fn();
    const { all } = setup({ link: { url: null, noMix: true }, onRetry });
    await userEvent.click(screen.getByRole("button", { name: "Refresh mix" }));
    expect(all.onRefreshMix).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it.each(["desktop", "phone"] as const)(
    "exports the Deliver In and Out, not the Edit selection, from the %s button",
    async (layout) => {
      const { all } = setup({ layout, selection: { start: 40, end: 90 } });
      await userEvent.click(screen.getByRole("button", { name: "Part…" }));
      await userEvent.click(screen.getByRole("button", { name: /^Export/ }));
      expect(vi.mocked(all.onExport).mock.calls[0]?.[0].range).toEqual({
        start: 0,
        end: 60,
      });
    },
  );

  it("leaves focus where the user moved it when the remembered control goes away", () => {
    const { container } = setup();
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      const remove = screen.getByRole("button", {
        name: "Remove The old mill",
      });
      remove.focus();
      outside.focus();
      fireEvent.click(remove);
      expect(container.contains(remove)).toBe(false);
      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });
});

describe("round three of the audit: what the page shows", () => {
  it.each([
    [{ decided: 10, total: 14 }, "10 of 14"],
    [{ decided: 0, total: 3 }, "0 of 3"],
    [{ decided: 14, total: 14 }, "14 of 14"],
  ])("reads suggestions %o as %s", (suggestions, detail) => {
    setup({ facts: { ...CLEAR_FACTS, suggestions } });
    expect(screen.getByText(detail)).toBeInTheDocument();
  });

  it.each([
    ["podcast", "−16.0 LUFS target, will be checked"],
    ["broadcast", "−23.0 LUFS target, will be checked"],
    ["streaming", "−14.0 LUFS target, will be checked"],
  ] as const)("shows the %s loudness target", (loudness, detail) => {
    setup({ facts: { ...CLEAR_FACTS, loudness } });
    expect(screen.getByText(detail)).toBeInTheDocument();
  });

  it("shows the real progress of a running export", () => {
    setup({ exportState: { phase: "running", progress: 0.3, detail: "x" } });
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "30",
    );
  });

  it("disables Export with the reason while the model is missing", async () => {
    const { all, stage } = setup({ exportState: NEEDS_MODEL });
    const button = screen.getByRole("button", { name: /^Export/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Needs the transcription model.");
    modE(stage());
    expect(all.onExport).not.toHaveBeenCalled();
  });

  it.each([1, 2])(
    "lists %i exported file(s), each with its own action",
    (count) => {
      const files = exportedState(REQUEST).files.slice(0, count);
      const { container } = setup({
        exportState: { ...DONE, files } as ExportState,
      });
      const list = within(container.querySelector(".dv-files") as HTMLElement);
      expect(list.getAllByRole("button", { name: "Reveal" })).toHaveLength(
        count,
      );
      for (const file of files)
        expect(list.getByText(file.name)).toBeInTheDocument();
    },
  );

  it("shows one clip with Find clips still on offer", async () => {
    const { all } = setup({
      initialClips: [CLIPS[0] as (typeof CLIPS)[number]],
    });
    await userEvent.click(screen.getByRole("button", { name: "Find clips" }));
    expect(all.onFindClips).toHaveBeenCalledOnce();
  });

  it("names the summary heading as a polite live region that labels the section", () => {
    setup({ facts: OPEN_FACTS });
    const heading = screen.getByRole("heading", {
      name: "2 things left. You can still export.",
    });
    expect(heading).toHaveAttribute("aria-live", "polite");
    expect(
      screen.getByRole("region", { name: heading.textContent as string }),
    ).toBeInTheDocument();
  });

  it("makes the Approved mark no tab stop", () => {
    setup();
    const mark = screen.getByText("Approved");
    expect(mark.getAttribute("tabindex")).not.toBe("0");
    expect(mark.tabIndex).toBeLessThan(0);
  });
});

describe("round three of the audit: names that tell items apart", () => {
  const titled = (titles: string[]) =>
    titles.map((title, i) => ({
      id: `n${i}`,
      title,
      start: i * 10,
      end: i * 10 + 5,
      score: 0.5,
      approved: false,
    }));

  it.each([
    [
      ["Alpha", "Beta", "Gamma"],
      ["Alpha", "Beta", "Gamma"],
    ],
    [
      ["Same", "Same", "Other"],
      ["Same 1", "Same 2", "Other"],
    ],
    [
      ["", "Beta", "  "],
      ["clip 1", "Beta", "clip 3"],
    ],
    [
      ["Intro", "Intro ", " Intro"],
      ["Intro 1", "Intro 2", "Intro 3"],
    ],
  ])(
    "every clip button and field is named by its own clip: %j",
    (titles, names) => {
      setup({ initialClips: titled(titles) });
      for (const name of names) {
        expect(
          screen.getByRole("textbox", { name: `Title of ${name}` }),
        ).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: `Play ${name}` }),
        ).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: `Approve ${name}` }),
        ).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: `More for ${name}` }),
        ).toBeInTheDocument();
      }
    },
  );

  it("acts on the clip named, not the first", async () => {
    const { all } = setup({ initialClips: titled(["Same", "Same", "Other"]) });
    await userEvent.click(screen.getByRole("button", { name: "Play Same 2" }));
    expect(all.onPlayClip).toHaveBeenLastCalledWith("n1");
    await userEvent.click(screen.getByRole("button", { name: "Play Other" }));
    expect(all.onPlayClip).toHaveBeenLastCalledWith("n2");
  });

  it("names chapters the same way", () => {
    setup({
      initialChapters: [
        { id: "a", at: 1, title: "Intro" },
        { id: "b", at: 2, title: "Intro " },
        { id: "c", at: 3, title: "   " },
      ],
    });
    for (const name of ["Intro 1", "Intro 2", "chapter 3"]) {
      expect(
        screen.getByRole("textbox", { name: `Title of ${name}` }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("textbox", { name: `Time of ${name}` }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: `Remove ${name}` }),
      ).toBeInTheDocument();
    }
  });
});

describe("round three of the audit: chapters", () => {
  it("never lets a chapter go below zero by arrow, Shift-arrow or drag", () => {
    const { stage, all } = setup();
    const time = screen.getByRole("textbox", { name: "Time of Cold open" });
    time.focus();
    fireEvent.keyDown(time, { key: "ArrowDown" });
    fireEvent.keyDown(time, { key: "ArrowDown", shiftKey: true });
    const grip = screen.getByText("Time of Cold open");
    fireEvent.pointerDown(grip, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 20, pointerId: 1 });
    fireEvent.pointerUp(grip, { pointerId: 1 });
    modE(stage());
    const sent = vi.mocked(all.onExport).mock.calls[0]?.[0].chapters ?? [];
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((c) => c.at >= 0)).toBe(true);
    expect(sent.find((c) => c.id === "c1")?.at).toBe(0);
  });

  it.each([
    [0, "The old mill"],
    [1, "What the river wanted"],
    [2, "Listener mail"],
    [3, "What the river wanted"],
  ])(
    "after removing chapter %i, focus lands in the chapters list on %s",
    (index, expected) => {
      setup();
      const titles = [
        "Cold open",
        "The old mill",
        "What the river wanted",
        "Listener mail",
      ];
      const button = screen.getByRole("button", {
        name: `Remove ${titles[index]}`,
      });
      button.focus();
      fireEvent.click(button);
      const active = document.activeElement as HTMLElement;
      expect(
        active.closest("[data-focus-list]")?.getAttribute("data-focus-list"),
      ).toBe("chapters");
      expect(
        active
          .closest(".dv-chapter")
          ?.querySelector<HTMLInputElement>(".dv-chapter-title")?.value,
      ).toBe(expected);
    },
  );

  it("after removing the last chapter focus lands on the new last one", () => {
    setup();
    const button = screen.getByRole("button", { name: "Remove Listener mail" });
    button.focus();
    fireEvent.click(button);
    const row = (document.activeElement as HTMLElement).closest(".dv-chapter");
    expect(
      row?.querySelector<HTMLInputElement>(".dv-chapter-title")?.value,
    ).toBe("What the river wanted");
  });
});

describe("round three of the audit: In at the end of the episode", () => {
  it("keeps Out inside the episode", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Part…" }));
    const start = screen.getByRole("textbox", { name: "In" });
    await userEvent.clear(start);
    await userEvent.type(start, "52:00{Enter}");
    expect(screen.getByRole("textbox", { name: "In" })).toHaveValue("51:59.0");
    expect(screen.getByRole("textbox", { name: "Out" })).toHaveValue("52:00.0");
  });
});

describe("round three of the audit: the listen link through the stage", () => {
  const URL = "https://share.example.app/l/7Hq2mXk9TnP4vLr8Za3w";
  const link = { url: URL, openedBy: [{ name: "Rosa" }, { name: "Jon" }] };

  it.each(["desktop", "phone"] as const)(
    "passes the whole link and openers on %s",
    (layout) => {
      const { container } = setup({ layout, link });
      expect(container.querySelector(".sys-link-text")).toHaveAttribute(
        "title",
        URL,
      );
      expect(
        screen.getByRole("img", { name: "Opened by Rosa, Jon" }),
      ).toBeInTheDocument();
    },
  );

  it.each([
    ["desktop", "copied", "Copied"],
    ["phone", "copied", "Copied"],
    ["desktop", "blocked", "Press Ctrl C"],
    ["phone", "blocked", "Share"],
  ] as const)("on %s a %s clipboard says %s", (layout, copyState, label) => {
    const { container } = setup({ layout, link: { ...link, copyState } });
    expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    expect(container.querySelector(".sys-link")).toHaveAttribute(
      "data-copy",
      copyState,
    );
  });

  it("says Press ⌘ C on Apple platforms", () => {
    platform.apple = true;
    setup({ link: { ...link, copyState: "blocked" } });
    expect(
      screen.getByRole("button", { name: "Press ⌘ C" }),
    ).toBeInTheDocument();
  });
});

describe("every readiness title is on the page", () => {
  it.each([
    ["all clear", CLEAR_FACTS],
    [
      "everything open",
      {
        ...CLEAR_FACTS,
        suggestions: { decided: 1, total: 14 },
        comments: { resolved: 0, total: 3 },
        unsureWordsLeft: 2,
        mixUpToDate: false,
        truePeak: -0.5,
      },
    ],
  ])("%s", (_name, facts) => {
    const { container } = setup({ facts });
    const titles = [
      ...container.querySelectorAll(".dv-readiness .sys-status-title"),
    ].map((el) => el.textContent);
    expect(titles).toEqual([
      "Suggestions decided",
      "Comments resolved",
      "Unsure words checked",
      "Mix up to date",
      "Loudness",
      "Peaks under −1.5 dBTP",
      "Chapters",
      "Edits saved",
    ]);
  });
});

describe("round four of the audit", () => {
  const clipsFor = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `q${i}`,
      title: `Clip number ${i + 1}`,
      start: i * 10,
      end: i * 10 + 5,
      score: 0.5,
      approved: false,
    }));
  const listOf = (el: Element | null) =>
    el?.closest("[data-focus-list]")?.getAttribute("data-focus-list");

  it.each(["Nobody asked the river x", "two  spaces in", "ends with a space "])(
    "keeps every keystroke of the clip title %j",
    async (text) => {
      setup();
      const input = clipTitle("Nobody asked the river");
      await userEvent.clear(input);
      await userEvent.type(input, text);
      expect(input).toHaveValue(text);
    },
  );

  it.each([0, 1, 2])(
    "after removing clip %i from its menu, focus lands in the Clips list",
    async (index) => {
      setup({ initialClips: clipsFor(3) });
      await userEvent.click(
        screen.getByRole("button", {
          name: `More for Clip number ${index + 1}`,
        }),
      );
      await userEvent.click(
        await screen.findByRole("menuitem", { name: "Remove" }),
      );
      expect(listOf(document.activeElement)).toBe("clips");
    },
  );

  it("after removing a chapter, focus lands in the Chapters list", () => {
    setup();
    const button = screen.getByRole("button", { name: "Remove The old mill" });
    button.focus();
    fireEvent.click(button);
    expect(listOf(document.activeElement)).toBe("chapters");
  });

  it.each([0, 1, 2, 3])(
    "approving clip %i leaves focus on that clip's own Approved mark",
    (index) => {
      setup({ initialClips: clipsFor(4) });
      const button = screen.getByRole("button", {
        name: `Approve Clip number ${index + 1}`,
      });
      button.focus();
      fireEvent.click(button);
      const active = document.activeElement as HTMLElement;
      expect(active.getAttribute("data-focus-key")).toBe(
        `clip:q${index}:approve`,
      );
      expect(active).toHaveTextContent("Approved");
      expect(
        active
          .closest(".dv-clip")
          ?.querySelector<HTMLInputElement>(".dv-clip-title")?.value,
      ).toBe(`Clip number ${index + 1}`);
    },
  );

  it.each([
    [312.4, "5:12.4"],
    [0.1, "0:00.1"],
    [59.9, "0:59.9"],
    [83.5, "1:23.5"],
    [1180, "19:40.0"],
    [3119.9, "51:59.9"],
  ])("shows a chapter at %f s as %s", (at, shown) => {
    setup({ initialChapters: [{ id: "only", at, title: "Only" }] });
    expect(screen.getByRole("textbox", { name: "Time of Only" })).toHaveValue(
      shown,
    );
  });

  it.each([
    [0, "ArrowUp", "0:00.1"],
    [312.4, "ArrowUp", "5:12.5"],
    [312.4, "ArrowDown", "5:12.3"],
    [59.9, "ArrowUp", "1:00.0"],
  ])("nudges a chapter at %f s with %s to %s", (at, key, shown) => {
    setup({ initialChapters: [{ id: "only", at, title: "Only" }] });
    const time = screen.getByRole("textbox", { name: "Time of Only" });
    time.focus();
    fireEvent.keyDown(time, { key });
    expect(screen.getByRole("textbox", { name: "Time of Only" })).toHaveValue(
      shown,
    );
  });

  it("titles the disabled Export button Exporting now. while it runs", () => {
    setup({ exportState: { phase: "running", progress: 0.2, detail: "x" } });
    const button = screen.getByRole("button", { name: /^Export/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Exporting now.");
  });

  it.each([
    ["a fresh export", { exportState: NEVER }, "Export"],
    [
      "a stale one",
      { exportState: { ...DONE, phase: "stale" } as ExportState },
      "Export",
    ],
    [
      "a failed one",
      { exportState: { phase: "failed", cause: "x" } as ExportState },
      "Export",
    ],
    ["a missing model", { exportState: NEEDS_MODEL }, "Export"],
    [
      "one running",
      {
        exportState: {
          phase: "running",
          progress: 0.2,
          detail: "x",
        } as ExportState,
      },
      "Export",
    ],
    [
      "a Part range",
      {
        initialSettings: {
          ...SETTINGS,
          part: { mode: "part", start: 0, end: 60 },
        } as typeof SETTINGS,
      },
      "Export",
    ],
    ["an Edit selection", { selection: { start: 40, end: 90 } }, "Export"],
    ["a done export in the app", { exportState: DONE }, "Show in folder"],
    [
      "a done export in the browser",
      { exportState: DONE, env: "browser" },
      "Download all",
    ],
  ] as const)(
    "labels the primary button exactly for %s",
    (_name, extra, label) => {
      for (const layout of ["desktop", "phone"] as const) {
        const { container, unmount } = setup({
          ...(extra as Partial<DeliverStageProps>),
          layout,
        });
        const buttons = container.querySelectorAll(".dv-export");
        expect(buttons).toHaveLength(1);
        expect(buttons[0]?.textContent).toBe(label);
        unmount();
      }
    },
  );

  it("says Reveal in Finder on Apple, exactly", () => {
    platform.apple = true;
    const { container } = setup({ exportState: DONE });
    expect(container.querySelector(".dv-export")?.textContent).toBe(
      "Reveal in Finder",
    );
  });

  it.each([
    [
      "stale",
      { ...DONE, phase: "stale" } as ExportState,
      "Edited since export",
    ],
    ["done", DONE, "Exported"],
  ])(
    "a %s export names its time on the status row",
    (_name, exportState, title) => {
      setup({ exportState });
      const row = screen.getByText(title).closest(".sys-status") as HTMLElement;
      expect(within(row).getByText("Last export 2 h ago")).toBeInTheDocument();
    },
  );

  it.each([
    ["Listen link", {}],
    ["Captions and transcript are written with every export.", {}],
    ["Only the host can deliver", { guest: true }],
    ["You can listen and comment in Review.", { guest: true }],
    ["Could not load Deliver", { state: "error" }],
    ["Your edits are saved.", { state: "error" }],
  ] as const)("shows the exact copy %j", (copy, extra) => {
    setup(extra as Partial<DeliverStageProps>);
    expect(screen.getByText(copy)).toBeInTheDocument();
  });
});

describe("round five of the audit: the whole visible page, state by state", () => {
  const RUNNING: ExportState = {
    phase: "running",
    progress: 0.4,
    detail: "Mixing",
  };
  const PART = {
    ...SETTINGS,
    part: { mode: "part", start: 30, end: 90 },
  } as typeof SETTINGS;
  const LINKED = {
    url: "https://share.example.app/l/7Hq2mXk9TnP4vLr8Za3w",
    openedBy: [{ name: "Rosa" }],
  };
  const STATES: [string, Partial<DeliverStageProps>][] = [
    ["ready", {}],
    ["loading", { state: "loading" }],
    ["error", { state: "error" }],
    ["guest", { guest: true }],
    ["stale", { exportState: { ...DONE, phase: "stale" } as ExportState }],
    ["exporting", { exportState: RUNNING }],
    ["done in the app", { exportState: DONE, link: LINKED }],
    [
      "done in the browser",
      { exportState: DONE, env: "browser", link: LINKED },
    ],
    ["no mix", { link: { url: null, noMix: true } }],
    ["no mix with a link", { link: { ...LINKED, noMix: true } }],
    ["with a link", { link: LINKED }],
    ["without a link", { link: { url: null } }],
    ["blocked clipboard", { link: { ...LINKED, copyState: "blocked" } }],
    ["a Part range", { initialSettings: PART }],
    ["an Edit selection", { selection: { start: 40, end: 90 } }],
    ["the model missing", { exportState: NEEDS_MODEL }],
  ];

  const nameOf = (el: Element) => {
    const label = el.getAttribute("aria-label");
    if (label) return label;
    const by = el.getAttribute("aria-labelledby");
    const target = by ? el.ownerDocument.getElementById(by) : null;
    return (target ?? el).textContent ?? "";
  };

  const describeState = (extra: Partial<DeliverStageProps>) => {
    const { container, unmount } = setup(extra);
    const buttons = screen
      .queryAllByRole("button")
      .map(
        (b) => nameOf(b) + (b.hasAttribute("disabled") ? " (disabled)" : ""),
      );
    const regions = screen.queryAllByRole("region").map((r) => nameOf(r));
    const rows = [...container.querySelectorAll(".sys-status")].map((r) =>
      r.getAttribute("data-state"),
    );
    const text = (container.textContent ?? "").replace(/\s+/g, " ").trim();
    unmount();
    return { text, buttons, regions, rows };
  };

  it("pins the text, button names, region names and row states", () => {
    const seen: Record<string, ReturnType<typeof describeState>> = {};
    for (const layout of ["desktop", "phone"] as const)
      for (const [name, extra] of STATES)
        seen[`${layout}: ${name}`] = describeState({ ...extra, layout });
    expect(seen).toMatchInlineSnapshot(`
      {
        "desktop: a Part range": {
          "buttons": [
            "MP3960 KB",
            "WAV11 MB",
            "FLAC6 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Export",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Copy",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Chapters",
            "Clips",
            "Listen link",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP3960 KBWAV11 MBFLAC6 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…InOutSaves to Field Notes/exportChangeExportChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedListen linkViewerMade when you copy itPinned to Rough cutCopy0:00 / 52:001515AB",
        },
        "desktop: an Edit selection": {
          "buttons": [
            "MP350 MB",
            "WAV550 MB",
            "FLAC303 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Export",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Copy",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Chapters",
            "Clips",
            "Listen link",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeExportChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedListen linkViewerMade when you copy itPinned to Rough cutCopy0:00 / 52:001515AB",
        },
        "desktop: blocked clipboard": {
          "buttons": [
            "MP350 MB",
            "WAV550 MB",
            "FLAC303 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Export",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Press Ctrl C",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Chapters",
            "Clips",
            "Listen link",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeExportChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedListen linkViewerhttps://share.…k9TnP4vLr8Za3wPinned to Rough cutRPress Ctrl C0:00 / 52:001515AB",
        },
        "desktop: done in the app": {
          "buttons": [
            "MP350 MB",
            "WAV550 MB",
            "FLAC303 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Show in folder",
            "Reveal",
            "Reveal",
            "Reveal",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Copy",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Chapters",
            "Clips",
            "Listen link",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeDone: ExportedLast export 2 h agoShow in folderfield-notes.mp350 MBRevealfield-notes.wav550 MBRevealclips/cold-open.wav6 MBRevealChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedListen linkViewerhttps://share.…k9TnP4vLr8Za3wPinned to Rough cutRCopy0:00 / 52:001515AB",
        },
        "desktop: done in the browser": {
          "buttons": [
            "MP350 MB",
            "WAV550 MB",
            "FLAC303 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Download all",
            "Download",
            "Download",
            "Download",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Copy",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Chapters",
            "Clips",
            "Listen link",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeDone: ExportedLast export 2 h agoDownload allfield-notes.mp350 MBDownloadfield-notes.wav550 MBDownloadclips/cold-open.wav6 MBDownloadChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedListen linkViewerhttps://share.…k9TnP4vLr8Za3wPinned to Rough cutRCopy0:00 / 52:001515AB",
        },
        "desktop: error": {
          "buttons": [],
          "regions": [
            "Could not load Deliver",
          ],
          "rows": [],
          "text": "Could not load DeliverYour edits are saved.",
        },
        "desktop: exporting": {
          "buttons": [
            "MP350 MB",
            "WAV550 MB",
            "FLAC303 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Cancel",
            "Export (disabled)",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Copy",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Chapters",
            "Clips",
            "Listen link",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "running",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeRunning: ExportingMixingCancelExportChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedListen linkViewerMade when you copy itPinned to Rough cutCopy0:00 / 52:001515AB",
        },
        "desktop: guest": {
          "buttons": [],
          "regions": [
            "Only the host can deliver",
          ],
          "rows": [],
          "text": "Only the host can deliverYou can listen and comment in Review.",
        },
        "desktop: loading": {
          "buttons": [
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Readiness",
            "Episode file",
            "Chapters",
            "Clips",
          ],
          "rows": [],
          "text": "Episode fileChaptersClips0:00 / 52:001515AB",
        },
        "desktop: no mix": {
          "buttons": [
            "MP350 MB",
            "WAV550 MB",
            "FLAC303 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Export",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Refresh mix",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Chapters",
            "Clips",
            "Listen link",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeExportChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedListen linkMake a mix to shareRefresh mix0:00 / 52:001515AB",
        },
        "desktop: no mix with a link": {
          "buttons": [
            "MP350 MB",
            "WAV550 MB",
            "FLAC303 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Export",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Refresh mix",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Chapters",
            "Clips",
            "Listen link",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeExportChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedListen linkMake a mix to shareRefresh mix0:00 / 52:001515AB",
        },
        "desktop: ready": {
          "buttons": [
            "MP350 MB",
            "WAV550 MB",
            "FLAC303 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Export",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Copy",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Chapters",
            "Clips",
            "Listen link",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeExportChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedListen linkViewerMade when you copy itPinned to Rough cutCopy0:00 / 52:001515AB",
        },
        "desktop: stale": {
          "buttons": [
            "MP350 MB",
            "WAV550 MB",
            "FLAC303 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Export",
            "Reveal",
            "Reveal",
            "Reveal",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Copy",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Chapters",
            "Clips",
            "Listen link",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "needs-you",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeNeeds you: Edited since exportLast export 2 h agoExportfield-notes.mp350 MBRevealfield-notes.wav550 MBRevealclips/cold-open.wav6 MBRevealChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedListen linkViewerMade when you copy itPinned to Rough cutCopy0:00 / 52:001515AB",
        },
        "desktop: the model missing": {
          "buttons": [
            "MP350 MB",
            "WAV550 MB",
            "FLAC303 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Get",
            "Export (disabled)",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Copy",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Chapters",
            "Clips",
            "Listen link",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "needs-you",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeNeeds you: Needs the transcription model1.6 GBGetExportChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedListen linkViewerMade when you copy itPinned to Rough cutCopy0:00 / 52:001515AB",
        },
        "desktop: with a link": {
          "buttons": [
            "MP350 MB",
            "WAV550 MB",
            "FLAC303 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Export",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Copy",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Chapters",
            "Clips",
            "Listen link",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeExportChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedListen linkViewerhttps://share.…k9TnP4vLr8Za3wPinned to Rough cutRCopy0:00 / 52:001515AB",
        },
        "desktop: without a link": {
          "buttons": [
            "MP350 MB",
            "WAV550 MB",
            "FLAC303 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Export",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Copy",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Chapters",
            "Clips",
            "Listen link",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeExportChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedListen linkViewerMade when you copy itPinned to Rough cutCopy0:00 / 52:001515AB",
        },
        "phone: a Part range": {
          "buttons": [
            "MP3960 KB",
            "WAV11 MB",
            "FLAC6 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Share",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Export",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Listen link",
            "Chapters",
            "Clips",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP3960 KBWAV11 MBFLAC6 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…InOutSaves to Field Notes/exportChangeListen linkMade when you copy itPinned to Rough cutShareChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedExport0:00 / 52:001515AB",
        },
        "phone: an Edit selection": {
          "buttons": [
            "MP350 MB",
            "WAV550 MB",
            "FLAC303 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Share",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Export",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Listen link",
            "Chapters",
            "Clips",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeListen linkMade when you copy itPinned to Rough cutShareChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedExport0:00 / 52:001515AB",
        },
        "phone: blocked clipboard": {
          "buttons": [
            "MP350 MB",
            "WAV550 MB",
            "FLAC303 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Share",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Export",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Listen link",
            "Chapters",
            "Clips",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeListen linkhttps://share.…k9TnP4vLr8Za3wPinned to Rough cutRShareChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedExport0:00 / 52:001515AB",
        },
        "phone: done in the app": {
          "buttons": [
            "MP350 MB",
            "WAV550 MB",
            "FLAC303 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Reveal",
            "Reveal",
            "Reveal",
            "Share",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Show in folder",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Listen link",
            "Chapters",
            "Clips",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeDone: ExportedLast export 2 h agofield-notes.mp350 MBRevealfield-notes.wav550 MBRevealclips/cold-open.wav6 MBRevealListen linkhttps://share.…k9TnP4vLr8Za3wPinned to Rough cutRShareChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedShow in folder0:00 / 52:001515AB",
        },
        "phone: done in the browser": {
          "buttons": [
            "MP350 MB",
            "WAV550 MB",
            "FLAC303 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Download",
            "Download",
            "Download",
            "Share",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Download all",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Listen link",
            "Chapters",
            "Clips",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeDone: ExportedLast export 2 h agofield-notes.mp350 MBDownloadfield-notes.wav550 MBDownloadclips/cold-open.wav6 MBDownloadListen linkhttps://share.…k9TnP4vLr8Za3wPinned to Rough cutRShareChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedDownload all0:00 / 52:001515AB",
        },
        "phone: error": {
          "buttons": [],
          "regions": [
            "Could not load Deliver",
          ],
          "rows": [],
          "text": "Could not load DeliverYour edits are saved.",
        },
        "phone: exporting": {
          "buttons": [
            "MP350 MB",
            "WAV550 MB",
            "FLAC303 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Cancel",
            "Share",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Export (disabled)",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Listen link",
            "Chapters",
            "Clips",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "running",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeRunning: ExportingMixingCancelListen linkMade when you copy itPinned to Rough cutShareChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedExport0:00 / 52:001515AB",
        },
        "phone: guest": {
          "buttons": [],
          "regions": [
            "Only the host can deliver",
          ],
          "rows": [],
          "text": "Only the host can deliverYou can listen and comment in Review.",
        },
        "phone: loading": {
          "buttons": [
            "Export (disabled)",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Readiness",
            "Episode file",
            "Chapters",
            "Clips",
          ],
          "rows": [],
          "text": "Episode fileChaptersClipsExport0:00 / 52:001515AB",
        },
        "phone: no mix": {
          "buttons": [
            "MP350 MB",
            "WAV550 MB",
            "FLAC303 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Refresh mix",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Export",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Listen link",
            "Chapters",
            "Clips",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeListen linkMake a mix to shareRefresh mixChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedExport0:00 / 52:001515AB",
        },
        "phone: no mix with a link": {
          "buttons": [
            "MP350 MB",
            "WAV550 MB",
            "FLAC303 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Refresh mix",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Export",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Listen link",
            "Chapters",
            "Clips",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeListen linkMake a mix to shareRefresh mixChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedExport0:00 / 52:001515AB",
        },
        "phone: ready": {
          "buttons": [
            "MP350 MB",
            "WAV550 MB",
            "FLAC303 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Share",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Export",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Listen link",
            "Chapters",
            "Clips",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeListen linkMade when you copy itPinned to Rough cutShareChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedExport0:00 / 52:001515AB",
        },
        "phone: stale": {
          "buttons": [
            "MP350 MB",
            "WAV550 MB",
            "FLAC303 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Reveal",
            "Reveal",
            "Reveal",
            "Share",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Export",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Listen link",
            "Chapters",
            "Clips",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "needs-you",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeNeeds you: Edited since exportLast export 2 h agofield-notes.mp350 MBRevealfield-notes.wav550 MBRevealclips/cold-open.wav6 MBRevealListen linkMade when you copy itPinned to Rough cutShareChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedExport0:00 / 52:001515AB",
        },
        "phone: the model missing": {
          "buttons": [
            "MP350 MB",
            "WAV550 MB",
            "FLAC303 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Get",
            "Share",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Export (disabled)",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Listen link",
            "Chapters",
            "Clips",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "needs-you",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeNeeds you: Needs the transcription model1.6 GBGetListen linkMade when you copy itPinned to Rough cutShareChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedExport0:00 / 52:001515AB",
        },
        "phone: with a link": {
          "buttons": [
            "MP350 MB",
            "WAV550 MB",
            "FLAC303 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Share",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Export",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Listen link",
            "Chapters",
            "Clips",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeListen linkhttps://share.…k9TnP4vLr8Za3wPinned to Rough cutRShareChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedExport0:00 / 52:001515AB",
        },
        "phone: without a link": {
          "buttons": [
            "MP350 MB",
            "WAV550 MB",
            "FLAC303 MB",
            "Podcast−16",
            "Broadcast−23",
            "Streaming−14",
            "Whole episode",
            "Part…",
            "Change",
            "Share",
            "Play from Cold open",
            "Remove Cold open",
            "Play from The old mill",
            "Remove The old mill",
            "Play from What the river wanted",
            "Remove What the river wanted",
            "Play from Listener mail",
            "Remove Listener mail",
            "Add at playhead",
            "Find clips",
            "Play Nobody asked the river",
            "Approve Nobody asked the river",
            "More for Nobody asked the river",
            "Play The boat was still there",
            "Approve The boat was still there",
            "More for The boat was still there",
            "Play Cold open",
            "More for Cold open",
            "Export",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
            "Comment",
          ],
          "regions": [
            "Deliver",
            "Ready to export",
            "Episode file",
            "Listen link",
            "Chapters",
            "Clips",
          ],
          "rows": [
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
            "done",
          ],
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBCaptions and transcript are written with every export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeListen linkMade when you copy itPinned to Rough cutShareChaptersTime of Cold openTime of The old millTime of What the river wantedTime of Listener mailAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedExport0:00 / 52:001515AB",
        },
      }
    `);
  });

  it("gives the stale row the needs-you state, not done", () => {
    setup({ exportState: { ...DONE, phase: "stale" } as ExportState });
    const row = screen.getByText("Edited since export").closest(".sys-status");
    expect(row).toHaveAttribute("data-state", "needs-you");
    expect(row).not.toHaveAttribute("data-state", "done");
  });

  it("gives the done row the done state", () => {
    setup({ exportState: DONE });
    expect(screen.getByText("Exported").closest(".sys-status")).toHaveAttribute(
      "data-state",
      "done",
    );
  });

  it("shows Make a mix to share instead of a link when both arrive", () => {
    const { all } = setup({
      link: { url: "https://share.example.app/l/abc", noMix: true },
    });
    expect(screen.getByText("Make a mix to share")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh mix" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    expect(screen.queryByTitle("https://share.example.app/l/abc")).toBeNull();
    expect(all.onCopyLink).not.toHaveBeenCalled();
  });

  it.each([
    ["1:23.5", "1:23.5"],
    ["0:00.7", "0:00.7"],
    ["10:05.3", "10:05.3"],
    ["10:06.9", "10:06.9"],
  ])("keeps the tenths when a clip In is typed as %s", async (typed, shown) => {
    setup();
    await userEvent.click(
      screen.getByRole("button", { name: "More for Nobody asked the river" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Trim" }),
    );
    const start = screen.getByRole("textbox", { name: /^In of / });
    await userEvent.clear(start);
    await userEvent.type(start, `${typed}{Enter}`);
    expect(screen.getByRole("textbox", { name: /^In of / })).toHaveValue(shown);
  });

  it.each([
    ["ArrowUp", "10:12.1"],
    ["ArrowDown", "10:11.9"],
  ])(
    "keeps the tenths when a clip In is nudged with %s",
    async (key, shown) => {
      setup();
      await userEvent.click(
        screen.getByRole("button", { name: "More for Nobody asked the river" }),
      );
      await userEvent.click(
        await screen.findByRole("menuitem", { name: "Trim" }),
      );
      const start = screen.getByRole("textbox", { name: /^In of / });
      start.focus();
      fireEvent.keyDown(start, { key });
      expect(screen.getByRole("textbox", { name: /^In of / })).toHaveValue(
        shown,
      );
    },
  );
});

describe("the loading blocker", () => {
  it("titles the disabled phone Export button Still loading.", () => {
    setup({ state: "loading", layout: "phone" });
    const button = screen.getByRole("button", { name: /^Export/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Still loading.");
  });
});

describe("round six of the audit", () => {
  it.each([
    ["the header action", CLIPS],
    ["the empty state", []],
  ] as const)(
    "Find clips in %s reaches onFindClips, not onRetry",
    async (_where, initialClips) => {
      const onRetry = vi.fn();
      const { all } = setup({ initialClips, onRetry });
      await userEvent.click(screen.getByRole("button", { name: "Find clips" }));
      expect(all.onFindClips).toHaveBeenCalledOnce();
      expect(onRetry).not.toHaveBeenCalled();
    },
  );

  it("Try again reaches onRetry only", async () => {
    const onRetry = vi.fn();
    const { all } = setup({ state: "error", onRetry });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(all.onFindClips).not.toHaveBeenCalled();
  });

  it("keeps two-decimal times typed into the chapter, In and Out fields", async () => {
    const { stage, all } = setup();
    const time = screen.getByRole("textbox", { name: "Time of The old mill" });
    await userEvent.clear(time);
    await userEvent.type(time, "1:23.26{Enter}");
    expect(
      screen.getByRole("textbox", { name: "Time of The old mill" }),
    ).toHaveValue("1:23.3");
    await userEvent.click(screen.getByRole("button", { name: "Part…" }));
    const start = screen.getByRole("textbox", { name: "In" });
    await userEvent.clear(start);
    await userEvent.type(start, "1:23.26{Enter}");
    const out = screen.getByRole("textbox", { name: "Out" });
    await userEvent.clear(out);
    await userEvent.type(out, "2:00.74{Enter}");
    modE(stage());
    const sent = vi.mocked(all.onExport).mock.calls[0]?.[0];
    expect(sent?.range?.start).toBeCloseTo(83.26, 5);
    expect(sent?.range?.end).toBeCloseTo(120.74, 5);
    expect(sent?.chapters.find((c) => c.id === "c2")?.at).toBeCloseTo(83.26, 5);
  });

  it("lists formats in the order they were switched on", async () => {
    const { stage, all } = setup();
    await userEvent.click(screen.getByRole("button", { name: /^MP3/ }));
    await userEvent.click(screen.getByRole("button", { name: /^FLAC/ }));
    await userEvent.click(screen.getByRole("button", { name: /^MP3/ }));
    modE(stage());
    expect(vi.mocked(all.onExport).mock.calls[0]?.[0].settings.formats).toEqual(
      ["wav", "flac", "mp3"],
    );
  });
});

describe("round seven of the audit", () => {
  it.each([
    ["Time of The old mill", "125", "2:05.0"],
    ["Time of The old mill", "999.9", "16:39.9"],
    ["Time of The old mill", "3000", "50:00.0"],
  ])("commits %s typed as %s", async (label, typed, shown) => {
    setup();
    const input = screen.getByRole("textbox", { name: label });
    await userEvent.clear(input);
    await userEvent.type(input, `${typed}{Enter}`);
    expect(screen.getByRole("textbox", { name: label })).toHaveValue(shown);
  });

  it("commits three-digit seconds in the In and Out fields", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Part…" }));
    const start = screen.getByRole("textbox", { name: "In" });
    await userEvent.clear(start);
    await userEvent.type(start, "125{Enter}");
    const out = screen.getByRole("textbox", { name: "Out" });
    await userEvent.clear(out);
    await userEvent.type(out, "300{Enter}");
    expect(screen.getByRole("textbox", { name: "In" })).toHaveValue("2:05.0");
    expect(screen.getByRole("textbox", { name: "Out" })).toHaveValue("5:00.0");
  });

  it("commits three-digit seconds in a clip's In and Out fields", async () => {
    setup();
    await userEvent.click(
      screen.getByRole("button", { name: "More for Nobody asked the river" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Trim" }),
    );
    const out = screen.getByRole("textbox", { name: /^Out of / });
    await userEvent.clear(out);
    await userEvent.type(out, "700{Enter}");
    const start = screen.getByRole("textbox", { name: /^In of / });
    await userEvent.clear(start);
    await userEvent.type(start, "125{Enter}");
    expect(screen.getByRole("textbox", { name: /^In of / })).toHaveValue(
      "2:05.0",
    );
    expect(screen.getByRole("textbox", { name: /^Out of / })).toHaveValue(
      "11:40.0",
    );
  });

  it("keeps a 60-character chapter title intact, keystroke by keystroke", async () => {
    setup();
    const title =
      "A chapter title that runs on well past any short limit, 60 ch";
    expect(title).toHaveLength(61);
    const text = title.slice(0, 60);
    const input = screen.getByRole("textbox", {
      name: "Title of The old mill",
    });
    await userEvent.clear(input);
    await userEvent.type(input, text);
    expect(input).toHaveValue(text);
  });

  it.each([
    ["ready", {}],
    ["loading", { state: "loading" }],
    ["error", { state: "error" }],
    ["ready with nothing in it", { initialChapters: [], initialClips: [] }],
    [
      "loading with nothing in it",
      { state: "loading", initialChapters: [], initialClips: [] },
    ],
  ] as const)("shows a guest only the cover while %s", (_name, extra) => {
    for (const layout of ["desktop", "phone"] as const) {
      const { container, unmount } = setup({
        ...(extra as Partial<DeliverStageProps>),
        guest: true,
        layout,
      });
      expect(screen.getByText("Only the host can deliver")).toBeInTheDocument();
      expect(
        screen.getByText("You can listen and comment in Review."),
      ).toBeInTheDocument();
      for (const section of [
        "Episode file",
        "Chapters",
        "Clips",
        "Listen link",
      ])
        expect(screen.queryByRole("heading", { name: section })).toBeNull();
      expect(screen.queryAllByRole("button")).toHaveLength(0);
      expect(container.querySelector(".dv-page, .dv-foot")).toBeNull();
      unmount();
    }
  });

  it("names chapter Play buttons by the same disambiguated names", () => {
    setup({
      initialChapters: [
        { id: "a", at: 1, title: "Intro" },
        { id: "b", at: 2, title: "Intro " },
        { id: "c", at: 3, title: "   " },
        { id: "d", at: 4, title: "" },
      ],
    });
    for (const name of ["Intro 1", "Intro 2", "chapter 3", "chapter 4"])
      expect(
        screen.getByRole("button", { name: `Play from ${name}` }),
      ).toBeInTheDocument();
  });
});

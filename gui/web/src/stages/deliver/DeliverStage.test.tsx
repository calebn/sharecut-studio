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

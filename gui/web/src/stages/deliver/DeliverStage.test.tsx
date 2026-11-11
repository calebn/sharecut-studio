import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultModelsWrapper,
  modelStatus,
  modelsApi,
  modelsWrapper,
  registryRows,
} from "../../test/renderWithModels";
import { BOUNCE_DEFAULTS, type BounceOptions } from "./bounceLogic";
import { DeliverStage, type DeliverStageProps } from "./DeliverStage";
import {
  CHAPTERS,
  CLEAR_FACTS,
  CLIPS,
  DONE,
  exportedFilesOf,
  exportedState,
  FAILED,
  NEEDS_MODEL,
  NEVER,
  OPEN_FACTS,
  PEAKS,
  REQUEST,
  SETTINGS,
  STALE,
  TOTAL,
  WORDS,
} from "./deliverFixture";
import type { ExportState } from "./deliverLogic";
import { type ListenFixture, listenOf } from "./listenFixture";
import { SAMPLE_PREVIEW, transcriptOptions } from "./transcriptFixtures";

const platform = vi.hoisted(() => ({ apple: false }));
vi.mock("../../utils/platform", () => ({
  isApplePlatform: () => platform.apple,
}));

afterEach(() => {
  platform.apple = false;
});

const MP3 = /^(Reveal|Download) field-notes\.mp3/;
const WAV = /^(Reveal|Download) field-notes\.wav/;

function handlers() {
  return {
    onFix: vi.fn(),
    onExport: vi.fn(),
    onCancel: vi.fn(),
    onChangeFolder: vi.fn(),
    onCopyLink: vi.fn(),
    onRefreshMix: vi.fn(),
    onPlayFrom: vi.fn(),
    onPlayClip: vi.fn(),
    onFindClips: vi.fn(),
    onOpenClipInEdit: vi.fn(),
  };
}

/** The stage's props plus the plain fields the host's Listen link row is built from. */
type Harness = DeliverStageProps & {
  link?: ListenFixture;
  onCopyLink?: () => void;
  onRefreshMix?: () => void;
};

function props(extra: Partial<Harness> = {}): Harness {
  return {
    facts: CLEAR_FACTS,
    total: TOTAL,
    initialSettings: SETTINGS,
    initialChapters: CHAPTERS,
    initialClips: CLIPS,
    saveTo: "Field Notes/export",
    exportState: NEVER,
    clock: { time: "0:00", total: "52:00" },
    getPlayheadSec: () => 724,
    link: { url: null },
    toastMs: 600_000,
    ...handlers(),
    ...extra,
  };
}

function setup(extra: Partial<Harness> = {}, wrapper = defaultModelsWrapper) {
  const all = props(extra);
  const { link, onCopyLink, onRefreshMix, ...rest } = all;
  const view = render(
    <DeliverStage
      {...rest}
      listen={
        rest.listen ??
        listenOf({
          ...link,
          url: link?.url ?? null,
          onCopy: onCopyLink,
          onRefreshMix,
        })
      }
    />,
    { wrapper },
  );
  const stage = () => view.container.querySelector(".dv-stage") as HTMLElement;
  return { ...view, all, stage };
}

const pressExport = () =>
  fireEvent.click(screen.getByRole("button", { name: /^Export/ }));

const modE = (el: Element, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(el, { key: "e", ctrlKey: true, ...init });

describe("Mod+E", () => {
  it("is left to the window keymap, so the stage never exports on it", () => {
    const { stage, all } = setup();
    const event = new KeyboardEvent("keydown", {
      key: "e",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    stage().dispatchEvent(event);
    modE(stage(), { metaKey: true, ctrlKey: false });
    expect(event.defaultPrevented).toBe(false);
    expect(all.onExport).not.toHaveBeenCalled();
  });
});

describe("Review hand-off", () => {
  it("leads back to Review with the open count, and is not a filled button", async () => {
    const { container, all } = setup({ facts: OPEN_FACTS });
    const handoff = screen.getByRole("button", { name: "Review 3 open items" });
    expect(handoff).not.toHaveClass("primary");
    expect(container.querySelectorAll(".primary")).toHaveLength(1);
    await userEvent.click(handoff);
    expect(all.onFix).toHaveBeenCalledWith("review", "comments");
    expect(all.onExport).not.toHaveBeenCalled();
  });

  it("is absent when nothing is open or only the mix is open", () => {
    const view = setup();
    expect(screen.queryByRole("button", { name: /^Review \d/ })).toBeNull();
    view.rerender(
      <DeliverStage
        {...view.all}
        facts={{ ...CLEAR_FACTS, mixUpToDate: false }}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Review \d/ })).toBeNull();
  });

  it("is absent while loading and counts one item in the singular", () => {
    const view = setup({ state: "loading", facts: OPEN_FACTS });
    expect(screen.queryByRole("button", { name: /^Review \d/ })).toBeNull();
    view.rerender(
      <DeliverStage
        {...view.all}
        state="ready"
        facts={{ ...CLEAR_FACTS, unsureWordsLeft: 1 }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Review 1 open item" }),
    ).toBeInTheDocument();
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

  it("stays Export after an export and is the only filled button", () => {
    const { container } = setup({ exportState: DONE });
    expect(container.querySelectorAll(".primary")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /^Export/ })).toBeInTheDocument();
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
const scrub = (name: string | RegExp) =>
  screen.getByRole("spinbutton", { name });
const setScrub = async (name: string | RegExp, text: string) => {
  await userEvent.click(scrub(name));
  await userEvent.keyboard(`{Control>}a{/Control}${text}{Enter}`);
};

describe("stale after an export", () => {
  it("offers Export again beside the stale row, and it exports what the page shows", async () => {
    const { all, container } = setup({ exportState: STALE });
    const again = screen.getByRole("button", { name: "Export again" });
    expect(again).not.toHaveClass("primary");
    expect(container.querySelectorAll(".primary")).toHaveLength(1);
    await userEvent.click(again);
    expect(all.onExport).toHaveBeenCalledOnce();
  });

  it("brings Export back when the loudness changes", async () => {
    setup({ exportState: DONE });
    await userEvent.click(screen.getByRole("button", { name: /^Streaming/ }));
    expect(screen.getByText("Export is out of date")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Export$/ })).toBeEnabled();
  });

  it("goes stale when a format or the range changes", async () => {
    setup({ exportState: DONE });
    await userEvent.click(screen.getByRole("button", { name: /^FLAC/ }));
    expect(screen.getByText("Export is out of date")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^FLAC/ }));
    expect(screen.queryByText("Export is out of date")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Part…" }));
    expect(screen.getByText("Export is out of date")).toBeInTheDocument();
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
    await setScrub("Out of Cold open", "20");
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
    await userEvent.type(chapterTitle("The old mill"), "!{Enter}");
    expect(stale()).toBe(true);
    await userEvent.type(chapterTitle("The old mill!"), "{Backspace}{Enter}");
    expect(stale()).toBe(false);

    const time = screen.getByRole("spinbutton", {
      name: "Time of The old mill",
    });
    await userEvent.click(time);
    await userEvent.keyboard("6:00{Enter}");
    expect(stale()).toBe(true);
    await userEvent.click(time);
    await userEvent.keyboard("5:12.4{Enter}");
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

  it("stays done when loudness or Part is changed and changed back", async () => {
    setup({ exportState: DONE });
    const stale = () => screen.queryByText("Export is out of date") !== null;
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
    const out = screen.getByRole("spinbutton", { name: "Out" });
    await userEvent.click(out);
    await userEvent.keyboard("0:30{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Part…" }));
    expect(screen.getByRole("spinbutton", { name: "Out" })).toHaveAttribute(
      "aria-valuetext",
      "30.00 s",
    );
  });

  it("goes stale when an approved clip's In moves", async () => {
    setup({ exportState: DONE });
    await userEvent.click(
      screen.getByRole("button", { name: "More for Cold open" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Trim" }),
    );
    await setScrub("In of Cold open", "5");
    expect(screen.getByText("Edited since export")).toBeInTheDocument();
    await setScrub("In of Cold open", "0");
    expect(screen.queryByText("Edited since export")).toBeNull();
  });

  it("lists the clips an export did include", () => {
    setup({
      exportState: DONE,
      files: exportedFilesOf(REQUEST, "reveal"),
    });
    expect(screen.getByText("cold-open.wav")).toBeInTheDocument();
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
      .getAllByRole("spinbutton", { name: /^Time of/ })
      .map((t) => t.getAttribute("aria-valuetext"));
    expect(times).toContain("724.00 s");
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
    setup({ getPlayheadSec: () => TOTAL + 500 });
    await userEvent.click(
      screen.getByRole("button", { name: "Add at playhead" }),
    );
    const times = screen
      .getAllByRole("spinbutton", { name: /^Time of/ })
      .map((t) => t.getAttribute("aria-valuetext"));
    expect(times.at(-1)).toBe("3120.00 s");
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

  it("unapproves a clip, reports it, and focus lands on its Approve button", () => {
    const onClips = vi.fn();
    setup({ onClips });
    const approve = screen.getAllByRole("button", {
      name: /^Approve/,
    })[0] as HTMLElement;
    fireEvent.click(approve);
    const unapprove = screen.getAllByRole("button", {
      name: /^Unapprove /,
    })[0] as HTMLElement;
    const before = screen.getAllByRole("button", {
      name: /^Unapprove /,
    }).length;
    unapprove.focus();
    fireEvent.click(unapprove);
    expect(screen.getAllByRole("button", { name: /^Unapprove / }).length).toBe(
      before - 1,
    );
    expect(document.activeElement?.textContent).toContain("Approve");
    expect(document.activeElement?.getAttribute("data-focus-key")).toMatch(
      /:approve$/,
    );
    expect(document.activeElement?.tagName).toBe("BUTTON");
    expect(onClips).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ approved: false })]),
    );
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

  it("asks for the model before exporting, in the export section, and downloads the size it needs", async () => {
    const api = modelsApi({ status: modelStatus(registryRows()) });
    setup({ exportState: NEEDS_MODEL }, modelsWrapper(api));
    await userEvent.click(
      screen.getByRole("button", { name: "Get the transcription model" }),
    );
    expect(api.download).toHaveBeenCalledWith(["whisper"], {
      whisperModel: "large-v3-turbo",
    });
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

  it("lists the files the folder holds, whatever the last export did", () => {
    const none = setup({ files: { files: [], access: "download" } });
    expect(none.container.querySelector(".dv-files")).toBeNull();
    none.unmount();
    for (const exportState of [NEVER, DONE, FAILED]) {
      const shown = setup({
        exportState,
        files: exportedFilesOf(REQUEST, "download"),
      });
      expect(shown.container.querySelector(".dv-files")).not.toBeNull();
      shown.unmount();
    }
  });

  it("offers Reveal in the app and Download in a browser, for the file clicked", async () => {
    const onReveal = vi.fn();
    const onStarted = vi.fn();
    const app = setup({
      exportState: DONE,
      files: { ...exportedFilesOf(REQUEST, "reveal"), onReveal, onStarted },
    });
    expect(screen.queryByRole("link", { name: MP3 })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: MP3 }));
    expect(onReveal).toHaveBeenCalledWith(
      expect.objectContaining({ name: "field-notes.mp3" }),
    );
    expect(onStarted).not.toHaveBeenCalled();
    app.unmount();
    const browserReveal = vi.fn();
    setup({
      exportState: DONE,
      files: {
        ...exportedFilesOf(REQUEST, "download"),
        onReveal: browserReveal,
        onStarted,
      },
    });
    expect(screen.queryByRole("button", { name: MP3 })).toBeNull();
    const link = screen.getByRole("link", { name: MP3 });
    expect(link).toHaveAttribute("href", "#field-notes.mp3");
    link.addEventListener("click", (event) => event.preventDefault());
    await userEvent.click(link);
    expect(onStarted).toHaveBeenCalledWith(
      expect.objectContaining({ name: "field-notes.mp3" }),
    );
    expect(browserReveal).not.toHaveBeenCalled();
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
    expect(
      screen.getByRole("button", { name: "Copy listen link" }),
    ).toBeInTheDocument();
    ready.unmount();
    setup({ state: "loading" });
    expect(
      screen.queryByRole("button", { name: "Copy listen link" }),
    ).toBeNull();
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
  it("is cancelled when the host answers, so it cannot release a later export early", async () => {
    vi.useFakeTimers();
    try {
      const all = props();
      const { rerender } = render(<DeliverStage {...all} />);
      const click = () =>
        fireEvent.click(screen.getByRole("button", { name: /^Export/ }));
      click();
      rerender(
        <DeliverStage {...all} exportState={{ phase: "failed", cause: "x" }} />,
      );
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      click();
      expect(all.onExport).toHaveBeenCalledTimes(2);
      act(() => {
        vi.advanceTimersByTime(1100);
      });
      click();
      expect(all.onExport).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the primary button after an export", () => {
  it("is still Export, with no Download all, Reveal in Finder or Show in folder", async () => {
    for (const apple of [false, true]) {
      platform.apple = apple;
      for (const access of ["reveal", "download"] as const) {
        const { all, unmount } = setup({
          exportState: { ...DONE, phase: "stale" } as ExportState,
          files: exportedFilesOf(REQUEST, access),
        });
        await userEvent.click(screen.getByRole("button", { name: /^Export$/ }));
        expect(all.onExport).toHaveBeenCalledOnce();
        for (const gone of [
          "Download all",
          "Reveal in Finder",
          "Show in folder",
        ]) {
          expect(screen.queryByText(gone)).toBeNull();
        }
        unmount();
      }
    }
  });

  it("is the only filled button once the files are listed", () => {
    const { container } = setup({
      exportState: DONE,
      files: exportedFilesOf(REQUEST, "download"),
    });
    expect(container.querySelectorAll("button.primary")).toHaveLength(1);
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
    await userEvent.click(
      screen.getByRole("button", { name: "Copy listen link" }),
    );
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
  const field = (name: string) => screen.getByRole("spinbutton", { name });
  const type = async (name: string, text: string) => {
    await userEvent.click(field(name));
    await userEvent.keyboard(`${text}{Enter}`);
  };
  const shown = (name: string, text: string) =>
    expect(field(name)).toHaveAttribute("aria-valuetext", text);

  it("starts at the beginning and runs a minute", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Part…" }));
    shown("In", "0.00 s");
    shown("Out", "60.00 s");
  });

  it("never starts past the end of a short episode", async () => {
    setup({ total: 45 });
    await userEvent.click(screen.getByRole("button", { name: "Part…" }));
    shown("Out", "45.00 s");
  });

  it("moves In and Out independently and keeps them apart", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Part…" }));
    await type("Out", "0:30");
    shown("In", "0.00 s");
    shown("Out", "30.00 s");
    await type("In", "0:10");
    shown("In", "10.00 s");
    shown("Out", "30.00 s");
    await type("In", "0:45");
    shown("Out", "46.00 s");
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
    await setScrub("Out of Cold open", "20");
    expect(scrub("In of Cold open")).toHaveAttribute("aria-valuenow", "0");
    expect(scrub("Out of Cold open")).toHaveAttribute("aria-valuenow", "20");
    expect(scrub("Out of Cold open")).toHaveAttribute(
      "aria-valuetext",
      "20.00 s",
    );
    expect(screen.getByText("20.0 s")).toBeInTheDocument();
    await setScrub("In of Cold open", "5");
    expect(scrub("In of Cold open")).toHaveAttribute("aria-valuenow", "5");
    expect(scrub("Out of Cold open")).toHaveAttribute("aria-valuenow", "20");
    expect(screen.getByText("15.0 s")).toBeInTheDocument();
  });

  it("stops at the end of the episode and closes again from the menu", async () => {
    setup();
    await open();
    await setScrub("Out of Cold open", "3120");
    expect(scrub("Out of Cold open")).toHaveAttribute("aria-valuenow", "3120");
    await userEvent.click(
      screen.getByRole("button", { name: "More for Cold open" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Done trimming" }),
    );
    expect(
      screen.queryByRole("spinbutton", { name: "In of Cold open" }),
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
    setup({
      exportState: DONE,
      files: exportedFilesOf(REQUEST, "reveal"),
    });
    expect(screen.getByText("Field Notes/export")).toBeInTheDocument();
    expect(screen.getByText("Last export 2 h ago")).toBeInTheDocument();
    expect(screen.getByText("field-notes.wav")).toBeInTheDocument();
    expect(screen.getByText("cold-open.wav")).toBeInTheDocument();
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
      screen.getByRole("spinbutton", {
        name: "In of The boat was still there",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("spinbutton", {
        name: "In of Nobody asked the river",
      }),
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
  it("lists them with working Reveal and Download rows", async () => {
    const stale = { ...DONE, phase: "stale" } as ExportState;
    const onReveal = vi.fn();
    const app = setup({
      exportState: stale,
      files: { ...exportedFilesOf(REQUEST, "reveal"), onReveal },
    });
    expect(screen.getByText("field-notes.wav")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: WAV }));
    expect(onReveal).toHaveBeenCalledWith(
      expect.objectContaining({ name: "field-notes.wav" }),
    );
    app.unmount();
    setup({ exportState: stale, files: exportedFilesOf(REQUEST, "download") });
    expect(screen.getByRole("link", { name: MP3 })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: WAV })).toBeInTheDocument();
  });
});

describe("state edits build on each other", () => {
  it("keeps every chapter and clip edit made one after the other", async () => {
    setup();
    await userEvent.type(chapterTitle("Cold open"), "!");
    const time = screen.getByRole("spinbutton", {
      name: "Time of The old mill",
    });
    await userEvent.click(time);
    await userEvent.keyboard("6:00{Enter}");
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
    await setScrub("Out of Cold open", "20");
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
    const time = screen.getByRole("spinbutton", {
      name: "Time of The old mill",
    });
    await userEvent.click(time);
    await userEvent.keyboard("99:00{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("3120");
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{End}");
    expect(
      screen.getByRole("spinbutton", { name: "Time of The old mill" }),
    ).toHaveAttribute("aria-valuetext", "3120.00 s");
  });
});

describe("export settings reach the stage", () => {
  it("blocks Export once every format is off, and says why", async () => {
    const { all } = setup();
    await userEvent.click(screen.getByRole("button", { name: /^MP3/ }));
    await userEvent.click(screen.getByRole("button", { name: /^WAV/ }));
    const button = screen.getByRole("button", { name: /^Export/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Choose a format first.");
    await userEvent.click(button);
    expect(all.onExport).not.toHaveBeenCalled();
  });

  it("brings Export back in the phone foot when the export goes stale", async () => {
    setup({ exportState: DONE, layout: "phone" });
    await userEvent.click(screen.getByRole("button", { name: /^Streaming/ }));
    expect(screen.getByRole("button", { name: /^Export$/ })).toBeEnabled();
    expect(screen.getByText("Export is out of date")).toBeInTheDocument();
  });

  it("shows In and Out only for a Part", () => {
    setup();
    expect(screen.queryByRole("spinbutton", { name: "In" })).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: "Out" })).toBeNull();
  });

  it("lets In and Out reach the end of the episode, not just the part length", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Part…" }));
    const start = screen.getByRole("spinbutton", { name: "In" });
    await userEvent.click(start);
    await userEvent.keyboard("10:00{Enter}");
    expect(screen.getByRole("spinbutton", { name: "In" })).toHaveAttribute(
      "aria-valuetext",
      "600.00 s",
    );
    const out = screen.getByRole("spinbutton", { name: "Out" });
    await userEvent.click(out);
    await userEvent.keyboard("99:00{Enter}{Escape}{End}");
    expect(screen.getByRole("spinbutton", { name: "Out" })).toHaveAttribute(
      "aria-valuetext",
      "3120.00 s",
    );
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
  });
});

describe("files of an export", () => {
  const stale = { ...DONE, phase: "stale" } as ExportState;

  it("each row names its own file and size and acts on that file", async () => {
    const app = setup({
      exportState: stale,
      files: exportedFilesOf(REQUEST, "reveal"),
    });
    expect(screen.getByText("field-notes.mp3")).toBeInTheDocument();
    const files = within(
      app.container.querySelector(".dv-files") as HTMLElement,
    );
    expect(files.getByText("50 MB")).toBeInTheDocument();
    expect(files.getByText("550 MB")).toBeInTheDocument();
    app.unmount();
    const onStarted = vi.fn();
    setup({
      exportState: stale,
      files: { ...exportedFilesOf(REQUEST, "download"), onStarted },
    });
    const link = screen.getByRole("link", { name: WAV });
    link.addEventListener("click", (event) => event.preventDefault());
    await userEvent.click(link);
    expect(onStarted).toHaveBeenCalledWith(
      expect.objectContaining({ name: "field-notes.wav" }),
    );
  });
});

describe("the phone layout", () => {
  it("shows chapters and clips once, and the Listen link row", () => {
    setup({ layout: "phone" });
    expect(screen.getAllByRole("heading", { name: "Chapters" })).toHaveLength(
      1,
    );
    expect(screen.getAllByRole("heading", { name: "Clips" })).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Copy listen link" }),
    ).toBeInTheDocument();
  });

  it("shows chapters and clips once on desktop too, with the word Viewer", () => {
    setup();
    expect(screen.getAllByRole("heading", { name: "Chapters" })).toHaveLength(
      1,
    );
    expect(screen.getAllByRole("heading", { name: "Clips" })).toHaveLength(1);
    expect(screen.getByText("Viewer")).toBeInTheDocument();
    expect(
      screen.getByText("Pinned to the version current when you copy it"),
    ).toBeInTheDocument();
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
  it("leaves the Player to the app frame when asked", () => {
    setup({ showPlayer: false });
    expect(screen.queryByRole("group", { name: "Player" })).toBeNull();
  });

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
    expect(screen.getByText("Export is out of date")).toBeInTheDocument();
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
    screen.getByRole("spinbutton", { name: `Time of ${name}` });

  it("retitles, retimes and removes one of two added chapters without touching the other", async () => {
    setup();
    await add();
    await add();
    const secondTitle = title("Chapter 6");
    const secondTime = time("Chapter 6");
    await userEvent.clear(secondTitle);
    await userEvent.type(secondTitle, "Second");
    expect(title("Chapter 5")).toHaveValue("Chapter 5");
    expect(time("Chapter 5")).toHaveAttribute("aria-valuetext", "724.00 s");
    await userEvent.click(secondTime);
    await userEvent.keyboard("1:40{Enter}");
    expect(time("Second")).toHaveAttribute("aria-valuetext", "100.00 s");
    expect(time("Chapter 5")).toHaveAttribute("aria-valuetext", "724.00 s");
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
      fresh.unmount();
      const stale = setup({
        layout,
        exportState: { ...DONE, phase: "stale" } as ExportState,
      });
      await userEvent.click(screen.getByRole("button", { name: /^Export$/ }));
      expect(stale.all.onExport).toHaveBeenCalledOnce();
    });

    it("the Export button sends the full request", () => {
      const { all } = setup({ layout });
      pressExport();
      expect(all.onExport).toHaveBeenCalledWith(REQUEST);
    });

    it("a file row acts on its own file in the app, done or stale", async () => {
      for (const phase of ["done", "stale"] as const) {
        const onReveal = vi.fn();
        const { all, unmount } = setup({
          layout,
          exportState: { ...DONE, phase } as ExportState,
          files: { ...exportedFilesOf(REQUEST, "reveal"), onReveal },
        });
        await userEvent.click(screen.getByRole("button", { name: WAV }));
        expect(onReveal).toHaveBeenCalledOnce();
        expect(onReveal).toHaveBeenCalledWith(
          expect.objectContaining({ name: "field-notes.wav" }),
        );
        await userEvent.click(screen.getByRole("button", { name: MP3 }));
        expect(onReveal).toHaveBeenLastCalledWith(
          expect.objectContaining({ name: "field-notes.mp3" }),
        );
        expect(all.onExport).not.toHaveBeenCalled();
        unmount();
      }
    });

    it("a file row acts on its own file in the browser, done or stale", async () => {
      for (const phase of ["done", "stale"] as const) {
        const onStarted = vi.fn();
        const { all, unmount } = setup({
          layout,
          exportState: { ...DONE, phase } as ExportState,
          files: { ...exportedFilesOf(REQUEST, "download"), onStarted },
        });
        for (const [pattern, name] of [
          [WAV, "field-notes.wav"],
          [MP3, "field-notes.mp3"],
        ] as const) {
          const link = screen.getByRole("link", { name: pattern });
          link.addEventListener("click", (event) => event.preventDefault());
          await userEvent.click(link);
          expect(onStarted).toHaveBeenLastCalledWith(
            expect.objectContaining({ name }),
          );
        }
        expect(all.onExport).not.toHaveBeenCalled();
        unmount();
      }
    });

    it("Copy reaches onCopyLink alone, in every phase", async () => {
      const label = "Copy listen link";
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
      const { unmount, all } = setup({ toastMs: 5000 });
      remove("The old mill");
      pressExport();
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
      const { all } = setup();
      pressExport();
      wait(1900);
      pressExport();
      expect(all.onExport).toHaveBeenCalledOnce();
      wait(200);
      pressExport();
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

  it("keeps the Undo toast for ten seconds when the host does not say", () => {
    vi.useFakeTimers();
    try {
      setup({ toastMs: undefined });
      fireEvent.click(
        screen.getByRole("button", { name: "Remove The old mill" }),
      );
      wait(9900);
      expect(screen.getByText("Removed The old mill")).toBeInTheDocument();
      wait(200);
      expect(screen.queryByText("Removed The old mill")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the double-export guard through re-renders until the host answers", async () => {
    const { all } = setup();
    pressExport();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove The old mill" }),
    );
    pressExport();
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
    const start = screen.getByRole("spinbutton", { name: "In" });
    await userEvent.click(start);
    await userEvent.keyboard("10:00{Enter}");
    const out = screen.getByRole("spinbutton", { name: "Out" });
    await userEvent.click(out);
    await userEvent.keyboard("5:00{Enter}");
    expect(screen.getByRole("spinbutton", { name: "In" })).toHaveAttribute(
      "aria-valuetext",
      "600.00 s",
    );
    expect(screen.getByRole("spinbutton", { name: "Out" })).toHaveAttribute(
      "aria-valuetext",
      "601.00 s",
    );
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
    await setScrub("Out of Last gasp", "10");
    expect(scrub("Out of Last gasp")).toHaveAttribute("aria-valuenow", "3120");
  });

  it("fires Refresh mix, not Try again, when both handlers exist", async () => {
    const onRetry = vi.fn();
    const { all } = setup({ link: { url: null, noMix: true }, onRetry });
    await userEvent.click(screen.getByRole("button", { name: "Refresh mix" }));
    expect(all.onRefreshMix).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

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
    const { all } = setup({ exportState: NEEDS_MODEL });
    const button = screen.getByRole("button", { name: /^Export/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Needs the transcription model.");
    pressExport();
    expect(all.onExport).not.toHaveBeenCalled();
  });

  it.each([1, 2])(
    "lists %i exported file(s), each with its own action",
    (count) => {
      const source = exportedFilesOf(REQUEST, "reveal");
      const files = source.files.slice(0, count);
      const { container } = setup({
        exportState: DONE,
        files: { ...source, files },
      });
      const list = within(container.querySelector(".dv-files") as HTMLElement);
      expect(list.getAllByRole("button", { name: /^Reveal/ })).toHaveLength(
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
        screen.getByRole("spinbutton", { name: `Time of ${name}` }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: `Remove ${name}` }),
      ).toBeInTheDocument();
    }
  });
});

describe("round three of the audit: chapters", () => {
  it("never lets a chapter go below zero by arrow, Shift-arrow or drag", () => {
    const { all } = setup();
    const time = screen.getByRole("spinbutton", { name: "Time of Cold open" });
    time.focus();
    fireEvent.keyDown(time, { key: "ArrowDown" });
    fireEvent.keyDown(time, { key: "ArrowDown", shiftKey: true });
    fireEvent.pointerDown(time, { clientX: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(time, { clientX: 90, pointerId: 1 });
    fireEvent.pointerMove(time, { clientX: 20, pointerId: 1 });
    fireEvent.pointerUp(time, { pointerId: 1 });
    pressExport();
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
    const start = screen.getByRole("spinbutton", { name: "In" });
    await userEvent.click(start);
    await userEvent.keyboard("52:00{Enter}");
    expect(screen.getByRole("spinbutton", { name: "In" })).toHaveAttribute(
      "aria-valuetext",
      "3119.00 s",
    );
    expect(screen.getByRole("spinbutton", { name: "Out" })).toHaveAttribute(
      "aria-valuetext",
      "3120.00 s",
    );
  });
});

describe("round three of the audit: the listen link through the stage", () => {
  const URL = "https://share.example.app/l/7Hq2mXk9TnP4vLr8Za3w";
  const link = { url: URL };

  it.each(["desktop", "phone"] as const)(
    "passes the whole link on %s",
    (layout) => {
      const { container } = setup({ layout, link });
      expect(container.querySelector(".sys-link-text")).toHaveAttribute(
        "title",
        URL,
      );
    },
  );

  it.each([
    ["desktop", "copied", /^Copied/],
    ["phone", "copied", /^Copied/],
    ["desktop", "blocked", /^Press Ctrl C/],
    ["phone", "blocked", /^Press Ctrl C/],
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
      screen.getByRole("button", { name: /^Press ⌘ C/ }),
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
    [312.4, "312.40 s"],
    [0.1, "0.10 s"],
    [59.9, "59.90 s"],
    [83.5, "83.50 s"],
    [1180, "1180.00 s"],
    [3119.9, "3119.90 s"],
  ])("shows a chapter at %f s as %s", (at, shown) => {
    setup({ initialChapters: [{ id: "only", at, title: "Only" }] });
    expect(
      screen.getByRole("spinbutton", { name: "Time of Only" }),
    ).toHaveAttribute("aria-valuetext", shown);
  });

  it.each([
    [0, "ArrowUp", "0.10 s"],
    [312.4, "ArrowUp", "312.50 s"],
    [312.4, "ArrowDown", "312.30 s"],
    [59.9, "ArrowUp", "60.00 s"],
  ])("nudges a chapter at %f s with %s to %s", (at, key, shown) => {
    setup({ initialChapters: [{ id: "only", at, title: "Only" }] });
    const time = screen.getByRole("spinbutton", { name: "Time of Only" });
    time.focus();
    fireEvent.keyDown(time, { key });
    expect(
      screen.getByRole("spinbutton", { name: "Time of Only" }),
    ).toHaveAttribute("aria-valuetext", shown);
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
    ["a done export", { exportState: DONE }, "Export"],
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

  it("says Export on Apple after an export too, exactly", () => {
    platform.apple = true;
    const { container } = setup({ exportState: DONE });
    expect(container.querySelector(".dv-export")?.textContent).toBe("Export");
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
    [
      "Available captions and transcript are included with every audio export.",
      {},
    ],
    ["Only the host can deliver", { guest: true }],
    ["You can listen and comment in Review.", { guest: true }],
    ["Could not load Deliver", { state: "error" }],
    ["Your edits are saved.", { state: "error" }],
  ] as const)("shows the exact copy %j", (copy, extra) => {
    setup(extra as Partial<DeliverStageProps>);
    expect(screen.getByText(copy)).toBeInTheDocument();
  });
});

describe("Episode file transcript note", () => {
  it.each(["desktop", "phone"] as const)(
    "%s keeps the above-reader Episode file content unchanged through preview hydration",
    (layout) => {
      const all = props({
        layout,
        transcript: transcriptOptions({ preview: { kind: "loading" } }),
      });
      const view = render(<DeliverStage {...all} />);
      const episode = screen.getByRole("region", { name: "Episode file" });
      const before = episode.textContent;
      view.rerender(<DeliverStage {...all} transcript={transcriptOptions()} />);
      expect(screen.getByRole("region", { name: "Episode file" })).toBe(
        episode,
      );
      expect(episode.textContent).toBe(before);
    },
  );
  it.each([
    { kind: "ready", preview: SAMPLE_PREVIEW },
    { kind: "loading" },
    { kind: "failed", cause: "x" },
    { kind: "allCut" },
    { kind: "none" },
  ] as const)(
    "keeps the section-presence message for preview $kind",
    (preview) => {
      setup({ transcript: transcriptOptions({ preview }) });
      const episode = screen.getByRole("region", { name: "Episode file" });
      expect(
        within(episode).getByText(
          "Available captions and transcript are included with every audio export. Choose more files in Transcript below.",
        ),
      ).toBeInTheDocument();
    },
  );

  it("explains available automatic files without referring to an absent section", () => {
    setup();
    const episode = screen.getByRole("region", { name: "Episode file" });
    expect(
      within(episode).getByText(
        "Available captions and transcript are included with every audio export.",
      ),
    ).toBeInTheDocument();
    expect(within(episode).queryByText(/Transcript below/)).toBeNull();
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
  const STATES: [string, Partial<Harness>][] = [
    ["ready", {}],
    ["loading", { state: "loading" }],
    ["error", { state: "error" }],
    ["guest", { guest: true }],
    ["stale", { exportState: { ...DONE, phase: "stale" } as ExportState }],
    ["exporting", { exportState: RUNNING }],
    [
      "done in the app",
      {
        exportState: DONE,
        files: exportedFilesOf(REQUEST, "reveal"),
        link: LINKED,
      },
    ],
    [
      "done in the browser",
      {
        exportState: DONE,
        files: exportedFilesOf(REQUEST, "download"),
        link: LINKED,
      },
    ],
    ["no mix", { link: { url: null, noMix: true } }],
    ["with a link", { link: LINKED }],
    ["without a link", { link: { url: null } }],
    ["blocked clipboard", { link: { ...LINKED, copyState: "blocked" } }],
    ["a Part range", { initialSettings: PART }],
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
            "Unapprove Cold open",
            "More for Cold open",
            "Pin to this version (disabled)",
            "Copy listen link",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
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
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP3960 KBWAV11 MBFLAC6 MBAvailable captions and transcript are included with every audio export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…In30.00sOut90.00sSaves to Field Notes/exportChangeExportChapters0.00s312.40s1180.00s2410.50sAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedUnapproveListen linkViewerMade when you copy itPinned to the version current when you copy itCopy0:00 / 52:001515AB",
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
            "Unapprove Cold open",
            "More for Cold open",
            "Reachable from anywhere",
            "Pin to this version (disabled)",
            "Press Ctrl C listen link",
            "More for listen link",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
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
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBAvailable captions and transcript are included with every audio export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeExportChapters0.00s312.40s1180.00s2410.50sAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedUnapproveListen linkViewerhttps://share.example.app/l/7Hq2mXk9TnP4vLr8Za3wFrozen on Rough cutPress Ctrl C0:00 / 52:001515AB",
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
            "Export",
            "Reveal field-notes.mp3, 50 MB",
            "Reveal field-notes.wav, 550 MB",
            "Reveal cold-open.wav, 6 MB",
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
            "Unapprove Cold open",
            "More for Cold open",
            "Reachable from anywhere",
            "Pin to this version (disabled)",
            "Copy listen link",
            "More for listen link",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
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
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBAvailable captions and transcript are included with every audio export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeDone: ExportedLast export 2 h agoExportmp3field-notes.mp3Listening file50 MBRevealwavfield-notes.wavLossless master550 MBRevealwavcold-open.wavClip6 MBRevealChapters0.00s312.40s1180.00s2410.50sAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedUnapproveListen linkViewerhttps://share.…k9TnP4vLr8Za3wFrozen on Rough cutCopy0:00 / 52:001515AB",
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
            "Unapprove Cold open",
            "More for Cold open",
            "Reachable from anywhere",
            "Pin to this version (disabled)",
            "Copy listen link",
            "More for listen link",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
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
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBAvailable captions and transcript are included with every audio export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeDone: ExportedLast export 2 h agoExportmp3field-notes.mp3Listening file50 MBDownloadwavfield-notes.wavLossless master550 MBDownloadwavcold-open.wavClip6 MBDownloadThe master is large. Use Wi-Fi, or choose the listening file.Chapters0.00s312.40s1180.00s2410.50sAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedUnapproveListen linkViewerhttps://share.…k9TnP4vLr8Za3wFrozen on Rough cutCopy0:00 / 52:001515AB",
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
            "Unapprove Cold open",
            "More for Cold open",
            "Pin to this version (disabled)",
            "Copy listen link",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
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
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBAvailable captions and transcript are included with every audio export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeRunning: ExportingMixingCancelYou can leave this page. The export keeps going and the status bar shows its progress.ExportChapters0.00s312.40s1180.00s2410.50sAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedUnapproveListen linkViewerMade when you copy itPinned to the version current when you copy itCopy0:00 / 52:001515AB",
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
            "Unapprove Cold open",
            "More for Cold open",
            "Refresh mix",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
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
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBAvailable captions and transcript are included with every audio export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeExportChapters0.00s312.40s1180.00s2410.50sAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedUnapproveListen linkMake a mix to shareRefresh mix0:00 / 52:001515AB",
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
            "Unapprove Cold open",
            "More for Cold open",
            "Pin to this version (disabled)",
            "Copy listen link",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
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
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBAvailable captions and transcript are included with every audio export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeExportChapters0.00s312.40s1180.00s2410.50sAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedUnapproveListen linkViewerMade when you copy itPinned to the version current when you copy itCopy0:00 / 52:001515AB",
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
            "Export again",
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
            "Unapprove Cold open",
            "More for Cold open",
            "Pin to this version (disabled)",
            "Copy listen link",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
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
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBAvailable captions and transcript are included with every audio export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeNeeds you: Edited since exportLast export 2 h agoExport againExportChapters0.00s312.40s1180.00s2410.50sAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedUnapproveListen linkViewerMade when you copy itPinned to the version current when you copy itCopy0:00 / 52:001515AB",
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
            "Manage models",
            "Get the transcription model",
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
            "Unapprove Cold open",
            "More for Cold open",
            "Pin to this version (disabled)",
            "Copy listen link",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
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
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBAvailable captions and transcript are included with every audio export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeNeeds you: Needs the transcription model1.6 GBManageGetExportNeeds the transcription model.Chapters0.00s312.40s1180.00s2410.50sAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedUnapproveListen linkViewerMade when you copy itPinned to the version current when you copy itCopy0:00 / 52:001515AB",
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
            "Unapprove Cold open",
            "More for Cold open",
            "Reachable from anywhere",
            "Pin to this version (disabled)",
            "Copy listen link",
            "More for listen link",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
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
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBAvailable captions and transcript are included with every audio export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeExportChapters0.00s312.40s1180.00s2410.50sAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedUnapproveListen linkViewerhttps://share.…k9TnP4vLr8Za3wFrozen on Rough cutCopy0:00 / 52:001515AB",
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
            "Unapprove Cold open",
            "More for Cold open",
            "Pin to this version (disabled)",
            "Copy listen link",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
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
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBAvailable captions and transcript are included with every audio export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeExportChapters0.00s312.40s1180.00s2410.50sAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedUnapproveListen linkViewerMade when you copy itPinned to the version current when you copy itCopy0:00 / 52:001515AB",
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
            "Pin to this version (disabled)",
            "Copy listen link",
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
            "Unapprove Cold open",
            "More for Cold open",
            "Export",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
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
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP3960 KBWAV11 MBFLAC6 MBAvailable captions and transcript are included with every audio export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…In30.00sOut90.00sSaves to Field Notes/exportChangeListen linkMade when you copy itPinned to the version current when you copy itCopyChapters0.00s312.40s1180.00s2410.50sAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedUnapproveExport0:00 / 52:001515AB",
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
            "Reachable from anywhere",
            "Pin to this version (disabled)",
            "Press Ctrl C listen link",
            "More for listen link",
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
            "Unapprove Cold open",
            "More for Cold open",
            "Export",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
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
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBAvailable captions and transcript are included with every audio export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeListen linkhttps://share.example.app/l/7Hq2mXk9TnP4vLr8Za3wFrozen on Rough cutPress Ctrl CChapters0.00s312.40s1180.00s2410.50sAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedUnapproveExport0:00 / 52:001515AB",
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
            "Reveal field-notes.mp3, 50 MB",
            "Reveal field-notes.wav, 550 MB",
            "Reveal cold-open.wav, 6 MB",
            "Reachable from anywhere",
            "Pin to this version (disabled)",
            "Copy listen link",
            "More for listen link",
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
            "Unapprove Cold open",
            "More for Cold open",
            "Export",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
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
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBAvailable captions and transcript are included with every audio export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeDone: ExportedLast export 2 h agomp3field-notes.mp3Listening file50 MBRevealwavfield-notes.wavLossless master550 MBRevealwavcold-open.wavClip6 MBRevealListen linkhttps://share.…k9TnP4vLr8Za3wFrozen on Rough cutCopyChapters0.00s312.40s1180.00s2410.50sAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedUnapproveExport0:00 / 52:001515AB",
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
            "Reachable from anywhere",
            "Pin to this version (disabled)",
            "Copy listen link",
            "More for listen link",
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
            "Unapprove Cold open",
            "More for Cold open",
            "Export",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
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
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBAvailable captions and transcript are included with every audio export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeDone: ExportedLast export 2 h agomp3field-notes.mp3Listening file50 MBDownloadwavfield-notes.wavLossless master550 MBDownloadwavcold-open.wavClip6 MBDownloadThe master is large. Use Wi-Fi, or choose the listening file.Listen linkhttps://share.…k9TnP4vLr8Za3wFrozen on Rough cutCopyChapters0.00s312.40s1180.00s2410.50sAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedUnapproveExport0:00 / 52:001515AB",
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
            "Pin to this version (disabled)",
            "Copy listen link",
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
            "Unapprove Cold open",
            "More for Cold open",
            "Export (disabled)",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
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
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBAvailable captions and transcript are included with every audio export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeRunning: ExportingMixingCancelYou can leave this page. The export keeps going and the status bar shows its progress.Listen linkMade when you copy itPinned to the version current when you copy itCopyChapters0.00s312.40s1180.00s2410.50sAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedUnapproveExport0:00 / 52:001515AB",
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
          ],
          "regions": [
            "Deliver",
            "Readiness",
            "Episode file",
            "Chapters",
            "Clips",
          ],
          "rows": [],
          "text": "Episode fileChaptersClipsExportStill loading.0:00 / 52:001515AB",
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
            "Unapprove Cold open",
            "More for Cold open",
            "Export",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
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
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBAvailable captions and transcript are included with every audio export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeListen linkMake a mix to shareRefresh mixChapters0.00s312.40s1180.00s2410.50sAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedUnapproveExport0:00 / 52:001515AB",
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
            "Pin to this version (disabled)",
            "Copy listen link",
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
            "Unapprove Cold open",
            "More for Cold open",
            "Export",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
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
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBAvailable captions and transcript are included with every audio export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeListen linkMade when you copy itPinned to the version current when you copy itCopyChapters0.00s312.40s1180.00s2410.50sAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedUnapproveExport0:00 / 52:001515AB",
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
            "Export again",
            "Pin to this version (disabled)",
            "Copy listen link",
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
            "Unapprove Cold open",
            "More for Cold open",
            "Export",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
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
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBAvailable captions and transcript are included with every audio export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeNeeds you: Edited since exportLast export 2 h agoExport againListen linkMade when you copy itPinned to the version current when you copy itCopyChapters0.00s312.40s1180.00s2410.50sAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedUnapproveExport0:00 / 52:001515AB",
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
            "Manage models",
            "Get the transcription model",
            "Pin to this version (disabled)",
            "Copy listen link",
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
            "Unapprove Cold open",
            "More for Cold open",
            "Export (disabled)",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
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
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBAvailable captions and transcript are included with every audio export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeNeeds you: Needs the transcription model1.6 GBManageGetListen linkMade when you copy itPinned to the version current when you copy itCopyChapters0.00s312.40s1180.00s2410.50sAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedUnapproveExportNeeds the transcription model.0:00 / 52:001515AB",
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
            "Reachable from anywhere",
            "Pin to this version (disabled)",
            "Copy listen link",
            "More for listen link",
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
            "Unapprove Cold open",
            "More for Cold open",
            "Export",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
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
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBAvailable captions and transcript are included with every audio export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeListen linkhttps://share.…k9TnP4vLr8Za3wFrozen on Rough cutCopyChapters0.00s312.40s1180.00s2410.50sAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedUnapproveExport0:00 / 52:001515AB",
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
            "Pin to this version (disabled)",
            "Copy listen link",
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
            "Unapprove Cold open",
            "More for Cold open",
            "Export",
            "0:00 / 52:00. Expand player",
            "Back 15 seconds",
            "Play",
            "Forward 15 seconds",
            "A",
            "B",
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
          "text": "Ready to exportDone: Suggestions decided14 of 14Done: Comments resolved3 of 3Done: Unsure words checked0 leftDone: Mix up to dateCurrentDone: Loudness−16.0 LUFS target, will be checkedDone: Peaks under −1.5 dBTPChecked on exportDone: Chapters5Done: Edits saved23.6 sEpisode fileMP350 MBWAV550 MBFLAC303 MBAvailable captions and transcript are included with every audio export.LoudnessPodcast−16Broadcast−23Streaming−14RangeWhole episodePart…Saves to Field Notes/exportChangeListen linkMade when you copy itPinned to the version current when you copy itCopyChapters0.00s312.40s1180.00s2410.50sAdd at playheadClipsFind clips41.0 sApprove28.0 sApprove33.0 sApprovedUnapproveExport0:00 / 52:001515AB",
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

  it.each([
    ["1:23.5", "83.50 s"],
    ["0:00.7", "0.70 s"],
    ["10:05.3", "605.30 s"],
    ["10:06.9", "606.90 s"],
    ["83.5", "83.50 s"],
  ])("keeps the tenths when a clip In is typed as %s", async (typed, shown) => {
    setup();
    await userEvent.click(
      screen.getByRole("button", { name: "More for Nobody asked the river" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Trim" }),
    );
    await setScrub(/^In of /, typed);
    expect(scrub(/^In of /)).toHaveAttribute("aria-valuetext", shown);
  });

  it.each([
    ["ArrowUp", "612.10 s"],
    ["ArrowDown", "611.90 s"],
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
      const start = scrub(/^In of /);
      start.focus();
      fireEvent.keyDown(start, { key });
      expect(scrub(/^In of /)).toHaveAttribute("aria-valuetext", shown);
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
    const { all } = setup();
    const time = screen.getByRole("spinbutton", {
      name: "Time of The old mill",
    });
    await userEvent.click(time);
    await userEvent.keyboard("1:23.26{Enter}");
    expect(
      screen.getByRole("spinbutton", { name: "Time of The old mill" }),
    ).toHaveAttribute("aria-valuetext", "83.26 s");
    await userEvent.click(screen.getByRole("button", { name: "Part…" }));
    const start = screen.getByRole("spinbutton", { name: "In" });
    await userEvent.click(start);
    await userEvent.keyboard("1:23.26{Enter}");
    const out = screen.getByRole("spinbutton", { name: "Out" });
    await userEvent.click(out);
    await userEvent.keyboard("2:00.74{Enter}");
    pressExport();
    const sent = vi.mocked(all.onExport).mock.calls[0]?.[0];
    expect(sent?.range?.start).toBeCloseTo(83.26, 5);
    expect(sent?.range?.end).toBeCloseTo(120.74, 5);
    expect(sent?.chapters.find((c) => c.id === "c2")?.at).toBeCloseTo(83.26, 5);
  });

  it("snaps a dragged chapter time to the sentence start from the episode words and sends one retime", () => {
    const words = [
      { text: "Well", start: 300, end: 300.4 },
      { text: "then.", start: 300.5, end: 301 },
      { text: "The", start: 305, end: 305.3 },
      { text: "mill.", start: 305.4, end: 306 },
      { text: "Next", start: 330, end: 330.4 },
    ];
    const { all } = setup({ words });
    const time = screen.getByRole("spinbutton", {
      name: "Time of The old mill",
    });
    fireEvent.pointerDown(time, { clientX: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(time, { clientX: 110, pointerId: 1 });
    fireEvent.pointerMove(time, { clientX: 20, pointerId: 1 });
    fireEvent.pointerUp(time, { pointerId: 1 });
    pressExport();
    const at = vi
      .mocked(all.onExport)
      .mock.calls[0]?.[0].chapters.find((c) => c.id === "c2")?.at;
    expect(at).toBe(305);
  });

  it("lists formats in the order they were switched on", async () => {
    const { all } = setup();
    await userEvent.click(screen.getByRole("button", { name: /^MP3/ }));
    await userEvent.click(screen.getByRole("button", { name: /^FLAC/ }));
    await userEvent.click(screen.getByRole("button", { name: /^MP3/ }));
    pressExport();
    expect(vi.mocked(all.onExport).mock.calls[0]?.[0].settings.formats).toEqual(
      ["wav", "flac", "mp3"],
    );
  });
});

describe("round seven of the audit", () => {
  it.each([
    ["Time of The old mill", "125", "125.00 s"],
    ["Time of The old mill", "999.9", "999.90 s"],
    ["Time of The old mill", "3000", "3000.00 s"],
  ])("commits %s typed as %s", async (label, typed, shown) => {
    setup();
    await userEvent.click(screen.getByRole("spinbutton", { name: label }));
    await userEvent.keyboard(`${typed}{Enter}`);
    expect(screen.getByRole("spinbutton", { name: label })).toHaveAttribute(
      "aria-valuetext",
      shown,
    );
  });

  it("commits three-digit seconds in the In and Out fields", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Part…" }));
    const start = screen.getByRole("spinbutton", { name: "In" });
    await userEvent.click(start);
    await userEvent.keyboard("125{Enter}");
    const out = screen.getByRole("spinbutton", { name: "Out" });
    await userEvent.click(out);
    await userEvent.keyboard("300{Enter}");
    expect(screen.getByRole("spinbutton", { name: "In" })).toHaveAttribute(
      "aria-valuetext",
      "125.00 s",
    );
    expect(screen.getByRole("spinbutton", { name: "Out" })).toHaveAttribute(
      "aria-valuetext",
      "300.00 s",
    );
  });

  it("commits three-digit seconds in a clip's In and Out fields", async () => {
    setup();
    await userEvent.click(
      screen.getByRole("button", { name: "More for Nobody asked the river" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Trim" }),
    );
    await setScrub(/^Out of /, "700");
    await setScrub(/^In of /, "125");
    expect(scrub(/^In of /)).toHaveAttribute("aria-valuetext", "125.00 s");
    expect(scrub(/^Out of /)).toHaveAttribute("aria-valuetext", "700.00 s");
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

describe("round eight of the audit", () => {
  const long = (seed: string) =>
    seed.repeat(Math.ceil(100 / seed.length)).slice(0, 100);
  const inputs = {
    chapter: () =>
      screen.getByRole("textbox", { name: "Title of The old mill" }),
    clip: () =>
      screen.getByRole("textbox", { name: "Title of Nobody asked the river" }),
  };

  it.each(["chapter", "clip"] as const)(
    "keeps a 100-character %s title whole",
    async (which) => {
      setup();
      const input = inputs[which]();
      const text = long(
        "Quick brown fox, jumps over the lazy dog 0123456789. ",
      );
      expect(text).toHaveLength(100);
      await userEvent.clear(input);
      await userEvent.type(input, text);
      expect(input).toHaveValue(text);
    },
  );

  it.each(["chapter", "clip"] as const)(
    "keeps digits, punctuation and unicode in a %s title",
    async (which) => {
      for (const text of [
        "Episode 2",
        "Top 5",
        "Q&A: 10/10",
        "Café 日本",
        "100% – “quoted” (maybe)?",
        "2024",
        "😀 ok",
      ]) {
        const { unmount } = setup();
        const input = inputs[which]();
        await userEvent.clear(input);
        await userEvent.type(input, text);
        expect(input).toHaveValue(text);
        unmount();
      }
    },
  );

  it.each(["chapter", "clip"] as const)(
    "keeps leading, trailing and doubled spaces in a %s title as typed",
    async (which) => {
      for (const text of [
        "  lead",
        "trail  ",
        "dou  ble",
        " ",
        "a b  c   d ",
      ]) {
        const { unmount } = setup();
        const input = inputs[which]();
        await userEvent.clear(input);
        await userEvent.type(input, text);
        expect(input).toHaveValue(text);
        unmount();
      }
    },
  );

  const keys = (init: KeyboardEventInit) => ({ key: "ArrowUp", ...init });
  const nudges = [
    ["plain", {}, 1],
    ["Shift", { shiftKey: true }, 10],
    ["Alt", { altKey: true }, 0.1],
  ] as const;

  it.each(nudges)(
    "%s+ArrowUp moves a chapter time by %f steps of 0.1 s",
    (_n, init, steps) => {
      const { all } = setup();
      const time = screen.getByRole("spinbutton", {
        name: "Time of The old mill",
      });
      time.focus();
      fireEvent.keyDown(time, keys(init));
      pressExport();
      const at = vi
        .mocked(all.onExport)
        .mock.calls[0]?.[0].chapters.find((c) => c.id === "c2")?.at;
      expect(at).toBeCloseTo(312.4 + steps * 0.1, 6);
    },
  );

  it.each(nudges)(
    "%s+ArrowUp moves Part In and Out by %f steps of 0.1 s",
    async (_n, init, steps) => {
      for (const which of ["In", "Out"] as const) {
        const { all, unmount } = setup();
        await userEvent.click(screen.getByRole("button", { name: "Part…" }));
        const field = screen.getByRole("spinbutton", { name: which });
        field.focus();
        fireEvent.keyDown(field, keys(init));
        pressExport();
        const range = vi.mocked(all.onExport).mock.calls[0]?.[0].range;
        const base = which === "In" ? 0 : 60;
        expect(range?.[which === "In" ? "start" : "end"]).toBeCloseTo(
          base + steps * 0.1,
          6,
        );
        unmount();
      }
    },
  );

  it.each(nudges)(
    "%s+ArrowUp moves a clip's In and Out by %f steps of 0.1 s",
    async (_n, init, steps) => {
      for (const which of ["In", "Out"] as const) {
        const { all, unmount } = setup();
        await userEvent.click(
          screen.getByRole("button", {
            name: "Approve Nobody asked the river",
          }),
        );
        await userEvent.click(
          screen.getByRole("button", {
            name: "More for Nobody asked the river",
          }),
        );
        await userEvent.click(
          await screen.findByRole("menuitem", { name: "Trim" }),
        );
        const field = screen.getByRole("spinbutton", {
          name: `${which} of Nobody asked the river`,
        });
        field.focus();
        fireEvent.keyDown(field, keys(init));
        pressExport();
        const clip = vi
          .mocked(all.onExport)
          .mock.calls[0]?.[0].clips.find((c) => c.id === "k1");
        const base = which === "In" ? 612 : 653;
        expect(clip?.[which === "In" ? "start" : "end"]).toBeCloseTo(
          base + steps * 0.1,
          6,
        );
        unmount();
      }
    },
  );

  it("brings back both of two chapters with the same title, in order, after Undo", async () => {
    const { all } = setup({
      initialChapters: [
        { id: "a", at: 10, title: "Intro" },
        { id: "b", at: 20, title: "Intro" },
        { id: "c", at: 30, title: "Chapter 3" },
        { id: "d", at: 40, title: "Chapter 3" },
      ],
    });
    for (const name of ["Intro 2", "Chapter 3 4"]) {
      await userEvent.click(
        screen.getByRole("button", { name: `Remove ${name}` }),
      );
      await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    }
    expect(
      screen
        .getAllByRole("textbox", { name: /^Title of / })
        .filter((el) => el.classList.contains("dv-chapter-title")),
    ).toHaveLength(4);
    pressExport();
    expect(
      vi.mocked(all.onExport).mock.calls[0]?.[0].chapters.map((c) => c.id),
    ).toEqual(["a", "b", "c", "d"]);
  });

  it.each(["1:23,4", "1;23", "1e3", "0x10", "Infinity", "NaN", "1:23:45"])(
    "keeps the old chapter time when %j is committed",
    async (typed) => {
      const { all } = setup();
      const time = screen.getByRole("spinbutton", {
        name: "Time of The old mill",
      });
      await userEvent.click(time);
      await userEvent.keyboard(`${typed}{Enter}{Escape}`);
      expect(
        screen.getByRole("spinbutton", { name: "Time of The old mill" }),
      ).toHaveAttribute("aria-valuetext", "312.40 s");
      pressExport();
      const at = vi
        .mocked(all.onExport)
        .mock.calls[0]?.[0].chapters.find((c) => c.id === "c2")?.at;
      expect(at).toBe(312.4);
    },
  );
});

describe("clip trim handles in the stage", () => {
  const openTrim = async () => {
    await userEvent.click(
      screen.getByRole("button", { name: "More for Nobody asked the river" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Trim" }),
    );
  };
  const handle = (edge: "In" | "Out") =>
    screen.getByRole("slider", {
      name: `${edge} handle of Nobody asked the river`,
    });
  const input = (edge: "In" | "Out") =>
    screen.getByRole("spinbutton", {
      name: `${edge} of Nobody asked the river`,
    });
  const exportedClip = (all: DeliverStageProps) =>
    vi.mocked(all.onExport).mock.calls[0]?.[0].clips.find((c) => c.id === "k1");

  it("shows the strip only for the clip being trimmed", async () => {
    setup({ words: WORDS, peaks: PEAKS });
    expect(screen.queryByRole("group", { name: /^Waveform of/ })).toBeNull();
    await openTrim();
    expect(screen.getAllByRole("group", { name: /^Waveform of/ })).toHaveLength(
      1,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "More for Nobody asked the river" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Done trimming" }),
    );
    expect(screen.queryByRole("group", { name: /^Waveform of/ })).toBeNull();
  });

  it.each([
    ["In", "ArrowRight", {}, "start", 612.01],
    ["In", "ArrowLeft", { shiftKey: true }, "start", 611.9],
    ["Out", "ArrowLeft", {}, "end", 652.99],
    ["Out", "ArrowRight", { shiftKey: true }, "end", 653.1],
  ] as const)(
    "%s %s %j moves 10 ms or 100 ms, with and without words",
    async (edge, key, init, kind, expected) => {
      for (const extra of [{ words: WORDS, peaks: PEAKS }, {}]) {
        const { all, unmount } = setup(extra);
        await userEvent.click(
          screen.getByRole("button", {
            name: "Approve Nobody asked the river",
          }),
        );
        await openTrim();
        fireEvent.keyDown(handle(edge), { key, ...init });
        pressExport();
        expect(exportedClip(all)?.[kind]).toBeCloseTo(expected, 6);
        unmount();
      }
    },
  );

  it("shows the moved value in the field and on the handle", async () => {
    setup({ words: WORDS, peaks: PEAKS });
    await openTrim();
    fireEvent.keyDown(handle("In"), { key: "ArrowRight", shiftKey: true });
    expect(input("In")).toHaveAttribute("aria-valuetext", "612.10 s");
    expect(handle("In")).toHaveAttribute("aria-valuenow", "612.1");
  });

  it.each([
    ["start", 10.5, 612.35],
    ["end", 652.5, 652.66],
  ] as const)(
    "a drag of %s snaps to a word edge",
    async (kind, atSeconds, expected) => {
      const { all } = setup({ words: WORDS, peaks: PEAKS });
      await userEvent.click(
        screen.getByRole("button", { name: "Approve Nobody asked the river" }),
      );
      await openTrim();
      const edge = kind === "start" ? "In" : "Out";
      const track = screen.getByRole("group", {
        name: "Waveform of Nobody asked the river",
      });
      vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
        left: 0,
        width: 1000,
        right: 1000,
        top: 0,
        bottom: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      const win = { start: 609, end: 656 };
      const x =
        (((kind === "start" ? 612.4 : atSeconds) - win.start) /
          (win.end - win.start)) *
        1000;
      fireEvent.pointerDown(handle(edge), {
        pointerId: 1,
        clientX: 500,
        buttons: 1,
      });
      fireEvent.pointerMove(handle(edge), {
        pointerId: 1,
        clientX: x,
        buttons: 1,
      });
      fireEvent.pointerUp(handle(edge), { pointerId: 1 });
      pressExport();
      expect(exportedClip(all)?.[kind]).toBeCloseTo(expected, 6);
    },
  );

  it("fires onClips once per pointer drag of a field", async () => {
    const onClips = vi.fn();
    setup({ onClips });
    await openTrim();
    const field = input("In");
    onClips.mockClear();
    fireEvent.pointerDown(field, { clientX: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(field, { clientX: 110, pointerId: 1 });
    fireEvent.pointerMove(field, { clientX: 130, pointerId: 1 });
    fireEvent.pointerMove(field, { clientX: 150, pointerId: 1 });
    expect(onClips).not.toHaveBeenCalled();
    fireEvent.pointerUp(field, { clientX: 150, pointerId: 1 });
    expect(onClips).toHaveBeenCalledTimes(1);
    const committed = onClips.mock.calls[0]?.[0].find(
      (c: { id: string }) => c.id === "k1",
    );
    expect(committed.start).toBeGreaterThan(612);
  });

  it("leaves the clip alone when Escape cancels a typed edit", async () => {
    const onClips = vi.fn();
    setup({ onClips });
    await openTrim();
    onClips.mockClear();
    await userEvent.click(input("In"));
    await userEvent.keyboard("{Control>}a{/Control}700{Escape}");
    expect(onClips).not.toHaveBeenCalled();
    expect(input("In")).toHaveAttribute("aria-valuenow", "612");
  });

  it("commits a typed value when the card collapses", async () => {
    setup();
    await openTrim();
    await userEvent.click(input("In"));
    await userEvent.keyboard("{Control>}a{/Control}620");
    await userEvent.click(
      screen.getByRole("button", { name: "More for Nobody asked the river" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Done trimming" }),
    );
    await openTrim();
    expect(input("In")).toHaveAttribute("aria-valuenow", "620");
  });

  it("takes pasted m:ss.f text", async () => {
    setup();
    await openTrim();
    await userEvent.click(input("In"));
    await userEvent.keyboard("{Control>}a{/Control}");
    await userEvent.paste("10:20.5");
    await userEvent.keyboard("{Enter}");
    expect(input("In")).toHaveAttribute("aria-valuenow", "620.5");
  });

  it("keeps a typed In in step with the handle", async () => {
    setup({ words: WORDS, peaks: PEAKS });
    await openTrim();
    await setScrub("In of Nobody asked the river", "10:15");
    expect(handle("In")).toHaveAttribute("aria-valuenow", "615");
  });

  it("never lets the handles cross", async () => {
    setup({
      words: WORDS,
      peaks: PEAKS,
      initialClips: [
        {
          ...CLIPS[0],
          id: "k1",
          start: 612,
          end: 613.5,
        } as (typeof CLIPS)[number],
      ],
    });
    await openTrim();
    for (let i = 0; i < 20; i += 1)
      fireEvent.keyDown(handle("In"), { key: "ArrowRight", shiftKey: true });
    const start = Number(handle("In").getAttribute("aria-valuenow"));
    const end = Number(handle("Out").getAttribute("aria-valuenow"));
    expect(end - start).toBeGreaterThanOrEqual(1 - 1e-9);
  });

  it.each(["Out", "In"] as const)(
    "keeps the handles on the strip when a far %s is typed into the field",
    async (edge) => {
      setup({ words: WORDS, peaks: PEAKS });
      await openTrim();
      await setScrub(
        `${edge} of Nobody asked the river`,
        edge === "Out" ? "50:00" : "0:05",
      );
      for (const which of ["In", "Out"] as const) {
        const at = Number.parseFloat(handle(which).style.insetInlineStart);
        expect(at).toBeGreaterThanOrEqual(0);
        expect(at).toBeLessThanOrEqual(100);
      }
      const region = document.querySelector(".dv-trim-region") as HTMLElement;
      expect(
        Number.parseFloat(region.style.insetInlineStart) +
          Number.parseFloat(region.style.inlineSize),
      ).toBeLessThanOrEqual(100.001);
    },
  );

  it("trims through the handles without offering Undo, like the fields", async () => {
    setup({ words: WORDS, peaks: PEAKS });
    await openTrim();
    fireEvent.keyDown(handle("In"), { key: "ArrowRight", shiftKey: true });
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});

describe("the Listen link reach in the stage", () => {
  it.each(["desktop", "phone"] as const)(
    "marks a link only this network reaches with a slashed globe on %s, and says so in its popover",
    async (layout) => {
      setup({
        layout,
        link: { url: "https://share.example.app/l/abc", reach: "network" },
      });
      const glyph = screen.getByRole("button", {
        name: "Only on this network",
      });
      expect(screen.queryByText(/Only people on this network/)).toBeNull();
      await userEvent.click(glyph);
      expect(
        screen.getByText(
          "Only people on this network can open it. Turn on online sharing to reach anyone.",
        ),
      ).toBeInTheDocument();
    },
  );

  it("marks a link that reaches anywhere with a filled globe", () => {
    setup({
      link: { url: "https://share.example.app/l/abc", reach: "anywhere" },
    });
    expect(
      screen.getByRole("button", { name: "Reachable from anywhere" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Only people on this network/)).toBeNull();
  });
});

const at = (c: { at: number }) => c.at;

describe("write-back to the host", () => {
  it("reports nothing until something changes", () => {
    const onChapters = vi.fn();
    const onClips = vi.fn();
    setup({ onChapters, onClips });
    expect(onChapters).not.toHaveBeenCalled();
    expect(onClips).not.toHaveBeenCalled();
  });

  it("reports the chapters after one is added at the playhead", async () => {
    const onChapters = vi.fn();
    const getPlayheadSec = vi.fn(() => 900);
    setup({ onChapters, getPlayheadSec });
    expect(getPlayheadSec).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: /Add at playhead/ }),
    );
    expect(onChapters).toHaveBeenCalledOnce();
    expect(onChapters.mock.calls[0]?.[0].map(at)).toEqual(
      [...CHAPTERS.map(at), 900].sort((a, b) => a - b),
    );
  });

  it("reports the chapters after one is removed, and not the clips", async () => {
    const onChapters = vi.fn();
    const onClips = vi.fn();
    setup({ onChapters, onClips });
    await userEvent.click(
      screen.getByRole("button", { name: `Remove ${CHAPTERS[1]?.title}` }),
    );
    expect(onChapters.mock.calls[0]?.[0]).toEqual(
      CHAPTERS.filter((chapter) => chapter.id !== CHAPTERS[1]?.id),
    );
    expect(onClips).not.toHaveBeenCalled();
  });

  it("reports the clips after one is approved", async () => {
    const onClips = vi.fn();
    setup({ onClips });
    await userEvent.click(
      screen.getAllByRole("button", { name: /^Approve/ })[0]!,
    );
    const approved = (clips: readonly { approved: boolean }[]) =>
      clips.filter((clip) => clip.approved).length;
    expect(approved(onClips.mock.calls[0]?.[0])).toBe(approved(CLIPS) + 1);
  });
});

describe("a chapter title", () => {
  it("is reported once, when Enter or leaving the field commits it", async () => {
    const onChapters = vi.fn();
    setup({ onChapters });
    const title = screen.getByRole("textbox", {
      name: "Title of The old mill",
    });
    await userEvent.type(title, " now");
    expect(onChapters).not.toHaveBeenCalled();
    await userEvent.tab();
    expect(onChapters).toHaveBeenCalledOnce();
    expect(onChapters.mock.calls[0]?.[0][1].title).toBe("The old mill now");
  });
});

describe("a clip trim gesture", () => {
  const openTrim = async () => {
    await userEvent.click(
      screen.getByRole("button", { name: "More for Nobody asked the river" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Trim" }),
    );
  };

  it("is reported once when a drag ends", async () => {
    const onClips = vi.fn();
    setup({ onClips });
    await openTrim();
    const handle = screen.getByRole("slider", {
      name: "In handle of Nobody asked the river",
    });
    fireEvent.pointerDown(handle, { clientX: 10, pointerId: 1, buttons: 1 });
    for (const clientX of [20, 30, 40])
      fireEvent.pointerMove(handle, { clientX, pointerId: 1, buttons: 1 });
    expect(onClips).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(onClips).toHaveBeenCalledOnce();
  });

  it("is reported once when focus leaves after arrow presses", async () => {
    const onClips = vi.fn();
    setup({ onClips });
    await openTrim();
    screen
      .getByRole("slider", { name: "Out handle of Nobody asked the river" })
      .focus();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(onClips).not.toHaveBeenCalled();
    await userEvent.tab();
    expect(onClips).toHaveBeenCalledOnce();
  });
});

describe("a clip removed in a host that restores it", () => {
  it("tells the host which clip Undo brought back", async () => {
    const onClipRestore = vi.fn();
    setup({ onClipRestore });
    await userEvent.click(
      screen.getByRole("button", { name: "More for Nobody asked the river" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Remove" }),
    );
    expect(onClipRestore).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onClipRestore).toHaveBeenCalledOnce();
    expect(onClipRestore.mock.calls[0]?.[0]).toMatchObject({
      title: "Nobody asked the river",
    });
  });
});

describe("the parts a host may leave out", () => {
  it("leaves out the Loudness row without a loudness", () => {
    setup({ facts: { ...CLEAR_FACTS, loudness: undefined } });
    expect(
      screen.queryByText("Loudness", { selector: ".sys-status-title" }),
    ).toBeNull();
  });

  it("leaves out the Listen link", () => {
    setup({ showLink: false });
    expect(screen.queryByText("Listen link")).toBeNull();
  });

  it("leaves out the loudness and range choices", () => {
    setup({ exportOptions: { loudness: false, range: false } });
    expect(screen.queryByRole("group", { name: "Loudness" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Range" })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Export/ })[0]).toBeEnabled();
  });

  it("leaves out Saves to without a way to change it", () => {
    setup({ onChangeFolder: undefined });
    expect(screen.queryByText(/Saves to/)).toBeNull();
  });
});

describe("host export options", () => {
  it("offers the formats the host gives, sized from their own rates", () => {
    setup({
      initialSettings: { ...SETTINGS, formats: ["m4a"] },
      exportOptions: {
        formats: [
          { id: "m4a", label: "M4A (AAC) · 128 kbps", bytesPerSecond: 16_000 },
        ],
      },
    });
    const group = screen.getByRole("group", { name: "Formats" });
    expect(within(group).getAllByRole("button")).toHaveLength(1);
    expect(
      within(group).getByRole("button", { name: /^M4A \(AAC\) · 128 kbps/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(within(group).queryByRole("button", { name: /^MP3/ })).toBeNull();
  });

  it("reports the formats the person toggles", async () => {
    const onFormats = vi.fn();
    setup({
      initialSettings: { ...SETTINGS, formats: ["mp3"] },
      exportOptions: {
        formats: [
          { id: "mp3", label: "MP3", bytesPerSecond: 16_000 },
          { id: "flac", label: "FLAC", bytesPerSecond: 97_000 },
        ],
        selected: ["mp3"],
        onFormats,
      },
    });
    await userEvent.click(screen.getByRole("button", { name: /^FLAC/ }));
    expect(onFormats).toHaveBeenLastCalledWith(["mp3", "flac"]);
  });

  it("follows the formats the host chooses and keeps the person's own toggle", async () => {
    const view = render(
      <DeliverStage
        {...props({
          initialSettings: { ...SETTINGS, formats: [] },
          exportOptions: { selected: [] },
        })}
      />,
    );
    const pressed = () =>
      screen
        .getAllByRole("button", { name: /^(MP3|WAV|FLAC)/ })
        .filter((b) => b.getAttribute("aria-pressed") === "true")
        .map((b) => b.textContent?.slice(0, 3));
    expect(pressed()).toEqual([]);
    view.rerender(
      <DeliverStage
        {...props({
          initialSettings: { ...SETTINGS, formats: [] },
          exportOptions: { selected: ["flac", "mp3"] },
        })}
      />,
    );
    expect(pressed()).toEqual(["MP3", "FLA"]);
    await userEvent.click(screen.getByRole("button", { name: /^FLAC/ }));
    expect(pressed()).toEqual(["MP3"]);
  });

  it("says WAV is written with every export, and still exports with nothing else chosen", () => {
    const { all } = setup({
      initialSettings: { ...SETTINGS, formats: [] },
      exportOptions: { wavAlwaysWritten: true, formats: [] },
    });
    expect(
      screen.getByText(
        "WAV is the lossless master and is written with every export.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "WAV" })).toBeDisabled();
    pressExport();
    expect(all.onExport).toHaveBeenCalledOnce();
  });

  it("blocks Export with no format when WAV is not written", () => {
    setup({ initialSettings: { ...SETTINGS, formats: [] } });
    expect(
      screen.getAllByRole("button", { name: "Export" })[0],
    ).toHaveAttribute("title", "Choose a format first.");
  });

  it("shows why the settings did not load", () => {
    setup({ exportOptions: { settingsError: "no config" } });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Export settings did not load: no config. Export uses this project's saved formats.",
    );
  });

  it("still exports the project's saved formats when the settings did not load", () => {
    const { all } = setup({
      initialSettings: { ...SETTINGS, formats: [] },
      exportOptions: { settingsError: "no config", formats: [] },
    });
    pressExport();
    expect(all.onExport).toHaveBeenCalledOnce();
  });

  it("says the settings are loading and holds Export until they are", () => {
    const { all } = setup({
      initialSettings: { ...SETTINGS, formats: [] },
      exportOptions: { loading: true, formats: [] },
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading export settings…",
    );
    expect(screen.queryByRole("group", { name: "Formats" })).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Export" })[0],
    ).toHaveAttribute("title", "Wait for the settings to load.");
    pressExport();
    expect(all.onExport).not.toHaveBeenCalled();
  });

  it("moves focus to the Model need row's Get when it appears", () => {
    setup({ exportState: NEEDS_MODEL });
    expect(
      screen.getByRole("button", { name: "Get the transcription model" }),
    ).toHaveFocus();
  });

  it("scrolls the running export into view on the phone when it starts, not when it is already running", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    try {
      const running = {
        phase: "running" as const,
        progress: null,
        detail: "Starting export…",
      };
      const first = render(
        <DeliverStage {...props({ layout: "phone", exportState: running })} />,
      );
      expect(scroll).not.toHaveBeenCalled();
      first.unmount();
      const view = render(<DeliverStage {...props({ layout: "phone" })} />);
      view.rerender(
        <DeliverStage {...props({ layout: "phone", exportState: running })} />,
      );
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll.mock.contexts[0]).toHaveTextContent("Starting export…");
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("leaves the scroll alone on a desktop, where the section is already in view", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    try {
      const view = render(<DeliverStage {...props()} />);
      view.rerender(
        <DeliverStage
          {...props({
            exportState: {
              phase: "running",
              progress: null,
              detail: "Starting export…",
            },
          })}
        />,
      );
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("swaps the loudness choice for the host's sentence", () => {
    setup({
      exportOptions: {
        loudnessNote: "Mastered to −16.0 LUFS, peaks under −1.5 dBTP.",
      },
    });
    expect(
      screen.getByText(
        "Mastered to −16.0 LUFS, peaks under −1.5 dBTP. The target mirrors the loudness setting in Prepare.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Pipeline tab/)).toBeNull();
    expect(screen.queryByRole("group", { name: "Loudness" })).toBeNull();
  });

  it("hides the loudness choice when the host has no target to set", () => {
    setup({ exportOptions: { loudness: false } });
    expect(screen.queryByRole("group", { name: "Loudness" })).toBeNull();
    expect(
      screen.queryByText("Loudness", { selector: ".dv-field-label" }),
    ).toBeNull();
  });

  it("hides Range when the host cannot honour it", () => {
    setup({ exportOptions: { range: false } });
    expect(screen.queryByRole("group", { name: "Range" })).toBeNull();
    expect(
      screen.queryByText("Range", { selector: ".dv-field-label" }),
    ).toBeNull();
  });

  it("shows the host's reason on a disabled Export and exports nothing", () => {
    const { all } = setup({
      exportOptions: { blockedReason: "No project loaded" },
    });
    const button = screen.getAllByRole("button", { name: "Export" })[0];
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "No project loaded");
    expect(screen.getByText("No project loaded")).toBeInTheDocument();
    pressExport();
    expect(all.onExport).not.toHaveBeenCalled();
  });

  it("shows no file rows after an export when the host gives none", () => {
    setup({ exportState: DONE });
    expect(screen.queryByRole("button", { name: /^Reveal/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /^Download/ })).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Export" }).length,
    ).toBeGreaterThan(0);
  });

  it("explains a running export without a total, and why Cancel is off", () => {
    setup({
      exportState: {
        phase: "running",
        progress: null,
        detail: "Starting export…",
        cancelReason:
          "The export is still starting. Cancel once it has started.",
        cancelError: "offline",
      },
    });
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText("Starting export…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveAttribute(
      "title",
      "The export is still starting. Cancel once it has started.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Cancel failed: offline",
    );
  });

  it("offers Try again after a failure", async () => {
    const onExportAgain = vi.fn();
    setup({
      exportState: { phase: "failed", cause: "Disk full" },
      exportOptions: { onExportAgain },
    });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onExportAgain).toHaveBeenCalledOnce();
  });

  it("keeps the failed row and starts nothing when Try again is blocked", async () => {
    const onExportAgain = vi.fn();
    const { all } = setup({
      exportState: { phase: "failed", cause: "Disk full" },
      exportOptions: {
        onExportAgain,
        blockedReason: "Saving your changes first.",
      },
    });
    const again = screen.getByRole("button", { name: "Try again" });
    expect(again).toBeDisabled();
    expect(again).toHaveAccessibleDescription("Saving your changes first.");
    await userEvent.click(again);
    expect(onExportAgain).not.toHaveBeenCalled();
    expect(all.onExport).not.toHaveBeenCalled();
    expect(screen.getByText("Export failed")).toBeInTheDocument();
  });

  it("explains why Export again is held and keeps the cancelled row", async () => {
    const onExportAgain = vi.fn();
    const { all } = setup({
      exportState: { phase: "cancelled", detail: "Cancelled." },
      exportOptions: {
        onExportAgain,
        blockedReason: "Saving your changes first.",
      },
    });
    const again = screen.getByRole("button", { name: "Export again" });
    expect(again).toHaveAccessibleDescription("Saving your changes first.");
    await userEvent.click(again);
    expect(onExportAgain).not.toHaveBeenCalled();
    expect(all.onExport).not.toHaveBeenCalled();
    expect(screen.getByText("Export cancelled")).toBeInTheDocument();
  });

  it("lists what a cancelled export had written, and offers Export again", async () => {
    const onExportAgain = vi.fn();
    setup({
      exportState: {
        phase: "cancelled",
        detail: "Cancelled after 1 file was written to export/.",
      },
      files: exportedFilesOf(REQUEST, "reveal"),
      exportOptions: { onExportAgain },
    });
    expect(
      screen.getByText("Cancelled after 1 file was written to export/."),
    ).toBeInTheDocument();
    expect(screen.getByText("field-notes.mp3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Export again" }));
    expect(onExportAgain).toHaveBeenCalledOnce();
  });

  it("does not head a cancelled export that wrote its files as cancelled", () => {
    setup({
      exportState: {
        phase: "cancelled",
        detail: "Cancel came too late. Exported 1 file to export/",
        when: "2 h ago",
      },
      exportOptions: { onExportAgain: vi.fn() },
    });
    expect(screen.queryByText("Export cancelled")).toBeNull();
    expect(screen.getByText("Exported")).toBeInTheDocument();
  });

  it("says what a finished export measured, with the host's own summary and no sizes", () => {
    setup({
      exportState: {
        ...(DONE as Extract<ExportState, { phase: "done" | "stale" }>),
        summary: "Exported 2 files to export/",
        measured: "Measured −16.2 LUFS, true peak −1.8 dBTP.",
      },
    });
    expect(screen.getByText("Exported 2 files to export/")).toBeInTheDocument();
    expect(
      screen.getByText("Measured −16.2 LUFS, true peak −1.8 dBTP."),
    ).toBeInTheDocument();
  });
});

describe("Bounce section", () => {
  const bounce = {
    state: { phase: "idle" },
    choices: { source: "entire", includeMp3: false, limitToRegion: false },
    onChoices: vi.fn(),
    selectedCount: 0,
    soloCount: 0,
    hasRegion: false,
    onBounce: vi.fn(),
    onCancel: vi.fn(),
  } as const;

  it("sits after the episode file when the host offers it", () => {
    setup({ bounce });
    const titles = screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent);
    expect(titles.indexOf("Bounce")).toBe(titles.indexOf("Episode file") + 1);
  });

  it("is absent without the host's bounce", () => {
    setup();
    expect(screen.queryByRole("heading", { name: "Bounce" })).toBeNull();
  });

  it("is a skeleton while the page loads, and absent for a guest", () => {
    const { unmount } = setup({ bounce, state: "loading" });
    expect(screen.queryByRole("button", { name: "Bounce" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Bounce" })).toBeTruthy();
    unmount();
    setup({ bounce, guest: true });
    expect(screen.queryByRole("heading", { name: "Bounce" })).toBeNull();
  });
});

describe("host Listen link slot", () => {
  const listen = vi.fn(({ highlight }: { highlight: boolean }) => (
    <p>{highlight ? "highlighted listen row" : "plain listen row"}</p>
  ));

  it("puts the host's row in the Listen link section, in place of the one the link prop describes", () => {
    setup({ listen, showLink: true, link: { url: "https://x.test/r/a" } });
    expect(screen.getByRole("heading", { name: "Listen link" })).toBeTruthy();
    expect(screen.getByText("plain listen row")).toBeTruthy();
    expect(screen.queryByText("https://x.test/r/a")).toBeNull();
  });

  it("sits in the side column after the episode file, and there is no Share section", () => {
    setup({ listen, showLink: true });
    const titles = screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent);
    expect(titles.indexOf("Listen link")).toBeGreaterThan(
      titles.indexOf("Episode file"),
    );
    expect(titles).not.toContain("Share");
  });

  it("comes after the episode file and before Chapters and Clips on a phone", () => {
    setup({ listen, showLink: true, layout: "phone" });
    const titles = screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent);
    expect(titles.indexOf("Listen link")).toBeGreaterThan(
      titles.indexOf("Episode file"),
    );
    expect(titles.indexOf("Listen link")).toBeLessThan(
      titles.indexOf("Chapters"),
    );
    expect(titles.indexOf("Chapters")).toBeLessThan(titles.indexOf("Clips"));
  });

  it("is absent when the host offers none and showLink is off", () => {
    setup({ listen, showLink: false });
    expect(screen.queryByRole("heading", { name: "Listen link" })).toBeNull();
  });

  it("highlights the row once the export is done", () => {
    setup({
      listen,
      showLink: true,
      exportState: DONE as ExportState,
    });
    expect(screen.getByText("highlighted listen row")).toBeTruthy();
  });

  it("is a skeleton while the page loads", () => {
    setup({ listen, showLink: true, state: "loading" });
    expect(screen.queryByText("plain listen row")).toBeNull();
  });
});

describe("Deliver asynchronous section composition", () => {
  const bounce = (): BounceOptions => ({
    state: { phase: "idle" },
    choices: BOUNCE_DEFAULTS,
    onChoices: vi.fn(),
    selectedCount: 2,
    soloCount: 0,
    hasRegion: true,
    onBounce: vi.fn(),
    onCancel: vi.fn(),
  });
  it.each(["desktop", "phone"] as const)(
    "%s keeps one Transcript after Bounce, Chapters and Clips during hydration",
    (layout) => {
      const value = bounce();
      const all = props({
        layout,
        bounce: value,
        transcript: transcriptOptions({ preview: { kind: "loading" } }),
      });
      const view = render(<DeliverStage {...all} />);
      const transcript = screen.getByRole("region", { name: "Transcript" });
      const chapters = screen.getByRole("region", { name: "Chapters" });
      const clips = screen.getByRole("region", { name: "Clips" });
      const bounceSection = screen.getByRole("region", { name: "Bounce" });
      for (const preceding of [bounceSection, chapters, clips]) {
        expect(
          preceding.compareDocumentPosition(transcript) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
      expect(transcript.closest(".dv-col") !== null).toBe(layout === "desktop");
      chapters.querySelector("input")!.focus();
      const reader = document.activeElement;
      const preview = {
        ...SAMPLE_PREVIEW,
        shown: Array.from({ length: 6 }, (_, i) => ({
          ...SAMPLE_PREVIEW.shown[0],
          startSec: i,
          text: `Turn ${i}`,
        })),
      };
      view.rerender(
        <DeliverStage
          {...all}
          transcript={transcriptOptions({
            preview: { kind: "ready", preview },
          })}
        />,
      );
      expect(
        screen.getAllByRole("region", { name: "Transcript" }),
      ).toHaveLength(1);
      expect(screen.getByRole("region", { name: "Transcript" })).toBe(
        transcript,
      );
      expect(screen.getByRole("region", { name: "Chapters" })).toBe(chapters);
      expect(document.activeElement).toBe(reader);
      expect(
        within(
          screen.getByRole("list", { name: "Transcript preview" }),
        ).getAllByRole("listitem"),
      ).toHaveLength(layout === "phone" ? 4 : 6);
      expect(value.onBounce).not.toHaveBeenCalled();
    },
  );
  it.each(["desktop", "phone"] as const)(
    "%s breakpoint relocation uses existing stage focus recovery without restarting work or changing choices",
    (layout) => {
      const transcript = transcriptOptions({
        choices: ["txt", "vtt"],
        onChoices: vi.fn(),
        onExport: vi.fn(),
        onPrepare: vi.fn(),
      });
      const value = bounce();
      const all = props({ layout, transcript, bounce: value });
      const view = render(<DeliverStage {...all} />);
      const copy = within(
        screen.getByRole("region", { name: "Transcript" }),
      ).getByRole("button", { name: "Copy text" });
      copy.focus();
      const priorScroll = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "scrollIntoView",
      );
      const scroll = vi.fn();
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        writable: true,
        value: scroll,
      });
      try {
        view.rerender(
          <DeliverStage
            {...all}
            layout={layout === "desktop" ? "phone" : "desktop"}
          />,
        );
        const region = screen.getByRole("region", { name: "Transcript" });
        expect(copy.isConnected).toBe(false);
        expect(document.activeElement).toBe(
          view.container.querySelector(".dv-stage"),
        );
        expect(
          within(region).getByRole("button", { name: "Text" }),
        ).toHaveAttribute("aria-pressed", "true");
        expect(
          within(region).getByRole("button", { name: "VTT" }),
        ).toHaveAttribute("aria-pressed", "true");
        expect(
          within(region).getByRole("button", { name: "Markdown" }),
        ).toHaveAttribute("aria-pressed", "false");
        expect(
          within(region).getByRole("button", { name: "SRT" }),
        ).toHaveAttribute("aria-pressed", "false");
        expect(scroll).not.toHaveBeenCalled();
        expect(transcript.onChoices).not.toHaveBeenCalled();
        expect(transcript.onExport).not.toHaveBeenCalled();
        expect(transcript.onPrepare).not.toHaveBeenCalled();
        expect(value.onBounce).not.toHaveBeenCalled();
      } finally {
        if (priorScroll)
          Object.defineProperty(
            Element.prototype,
            "scrollIntoView",
            priorScroll,
          );
        else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    },
  );
  it.each(["desktop", "phone"] as const)(
    "%s still honors an explicit Transcript focus request",
    (layout) => {
      const onFocused = vi.fn();
      setup({
        layout,
        transcript: transcriptOptions({ focusRequested: true, onFocused }),
      });
      const region = screen.getByRole("region", { name: "Transcript" });
      expect(document.activeElement).toBe(
        within(region).getByRole("button", { name: /^Export/ }),
      );
      expect(onFocused).toHaveBeenCalledOnce();
    },
  );
  it("starts the existing command without changing another section's native anchoring", async () => {
    const value = bounce();
    setup({ bounce: value, transcript: transcriptOptions() });
    const transcript = screen.getByRole("region", { name: "Transcript" });
    transcript.style.setProperty("overflow-anchor", "auto", "important");
    await userEvent.click(screen.getByRole("button", { name: /^Bounce$/ }));
    expect(value.onBounce).toHaveBeenCalledOnce();
    expect(transcript.style.getPropertyValue("overflow-anchor")).toBe("auto");
    expect(transcript.style.getPropertyPriority("overflow-anchor")).toBe(
      "important",
    );
  });
});

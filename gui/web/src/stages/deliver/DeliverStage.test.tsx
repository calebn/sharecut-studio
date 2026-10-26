import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { isApplePlatform } from "../../utils/platform";
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
  SETTINGS,
  TOTAL,
} from "./deliverFixture";
import type { ExportState } from "./deliverLogic";

const REVEAL = isApplePlatform() ? "Reveal in Finder" : "Show in folder";

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
    modE(stage(), { repeat: true });
    modE(stage());
    expect(all.onExport).toHaveBeenCalledOnce();
    expect(all.onExport).toHaveBeenCalledWith({
      settings: SETTINGS,
      clipIds: ["k3"],
      range: null,
    });
  });

  it("exports a range passed in from Edit instead of the Deliver part", () => {
    const { stage, all } = setup({ selection: { start: 40, end: 90 } });
    modE(stage());
    expect(vi.mocked(all.onExport).mock.calls[0]?.[0].range).toEqual({
      start: 40,
      end: 90,
    });
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
    const exported = exportedState(
      { settings: SETTINGS, clipIds: [], range: null },
      CLIPS,
    );
    setup({ exportState: exported });
    expect(screen.queryByText("clips/cold-open.wav")).toBeNull();
    await userEvent.click(
      screen.getAllByRole("button", { name: "Approve" })[0] as HTMLElement,
    );
    expect(screen.getByText("Edited since export")).toBeInTheDocument();
    expect(screen.queryByText("clips/nobody-asked-the-river.wav")).toBeNull();
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
    const next = document.activeElement as HTMLElement;
    expect(next.closest("li")?.textContent).toContain("");
    expect(next).not.toBe(document.body);
    expect(next.closest(".dv-chapter")).not.toBeNull();
  });
});

describe("clips", () => {
  it("keeps focus on the clip after Approve", () => {
    setup();
    const approve = screen.getAllByRole("button", {
      name: "Approve",
    })[0] as HTMLElement;
    approve.focus();
    fireEvent.click(approve);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.textContent).toContain("Approved");
  });

  it("removes a clip with an Undo toast", async () => {
    setup();
    await userEvent.click(
      screen.getByRole("button", { name: "More for The boat was still there" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Remove" }),
    );
    expect(screen.queryByDisplayValue("The boat was still there")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(
      screen.getByDisplayValue("The boat was still there"),
    ).toBeInTheDocument();
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
    expect(document.activeElement).not.toBe(document.body);
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

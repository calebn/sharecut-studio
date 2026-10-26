import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DeliverStage, type DeliverStageProps } from "./DeliverStage";
import {
  CHAPTERS,
  CLEAR_FACTS,
  CLIPS,
  DONE,
  NEVER,
  OPEN_FACTS,
  SETTINGS,
  TOTAL,
} from "./deliverFixture";

function setup(props: Partial<DeliverStageProps> = {}) {
  const handlers = {
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
  };
  const view = render(
    <DeliverStage
      facts={CLEAR_FACTS}
      total={TOTAL}
      initialSettings={SETTINGS}
      initialChapters={CHAPTERS}
      initialClips={CLIPS}
      saveTo="Field Notes/export"
      exportState={NEVER}
      clock={{ time: "0:00", total: "52:00" }}
      playhead={724}
      link={{ url: null }}
      pinnedTo="Rough cut"
      toastMs={600_000}
      {...handlers}
      {...props}
    />,
  );
  const stage = view.container.querySelector(".dv-stage") as HTMLElement;
  return { stage, ...handlers, ...view };
}

describe("DeliverStage", () => {
  it("exports with Mod+E, once, with the chosen settings", () => {
    const { stage, onExport } = setup();
    fireEvent.keyDown(stage, { key: "e", ctrlKey: true });
    fireEvent.keyDown(stage, { key: "e", ctrlKey: true, repeat: true });
    expect(onExport).toHaveBeenCalledOnce();
    expect(onExport).toHaveBeenCalledWith(SETTINGS);
  });

  it("does not export with Mod+E while exporting or with no format", async () => {
    const running = setup({
      exportState: { phase: "running", progress: 0.1, detail: "" },
    });
    fireEvent.keyDown(running.stage, { key: "e", metaKey: true });
    expect(running.onExport).not.toHaveBeenCalled();
    running.unmount();
    const empty = setup({
      initialSettings: { ...SETTINGS, formats: [] },
    });
    fireEvent.keyDown(empty.stage, { key: "e", metaKey: true });
    expect(empty.onExport).not.toHaveBeenCalled();
  });

  it("keeps Export enabled with items open and opens the fix's stage", async () => {
    const { onFix } = setup({ facts: OPEN_FACTS });
    expect(screen.getByRole("button", { name: /^Export/ })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(onFix).toHaveBeenCalledWith("review", "comments");
  });

  it("has one filled button, and it becomes Reveal after an export", () => {
    const { container, unmount } = setup();
    expect(container.querySelectorAll(".primary")).toHaveLength(1);
    unmount();
    const done = setup({ exportState: DONE });
    expect(screen.queryByRole("button", { name: /^Export/ })).toBeNull();
    expect(done.container.querySelectorAll(".primary")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Reveal in Finder" }),
    ).toBeInTheDocument();
  });

  it("puts the one Export button in the phone foot, not in the section", () => {
    const { container } = setup({ layout: "phone" });
    expect(container.querySelectorAll(".dv-export")).toHaveLength(1);
    expect(container.querySelector(".dv-foot .dv-export")).not.toBeNull();
  });

  it("lists approved clips as files after an export", () => {
    setup({ exportState: DONE });
    expect(screen.getByText("clips/cold-open.wav")).toBeInTheDocument();
  });

  it("deletes a chapter and brings it back with Undo", async () => {
    setup();
    const chapters = () =>
      screen
        .getAllByRole("textbox", { name: /^Title of/ })
        .filter((el) => el.classList.contains("dv-chapter-title"));
    expect(chapters()).toHaveLength(4);
    await userEvent.click(
      screen.getByRole("button", { name: "Delete The old mill" }),
    );
    expect(chapters()).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(chapters()).toHaveLength(4);
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

  it("shows a guest a Cover and no controls", () => {
    setup({ guest: true });
    expect(screen.getByText("Only the host can deliver")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Export/ })).toBeNull();
  });

  it("keeps the page usable while loading and retries after an error", async () => {
    const loading = setup({ state: "loading" });
    expect(within(loading.container).queryByText("Ready to export")).toBeNull();
    loading.unmount();
    const onRetry = vi.fn();
    setup({ state: "error", onRetry });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

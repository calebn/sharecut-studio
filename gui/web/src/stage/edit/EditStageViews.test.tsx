import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawKeymapListener } from "../../keymap/listener";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import { StageFrame } from "../frame/StageFrame";
import { EditWorkspace } from "./EditWorkspace";

const PROJECT_PATH = "/tmp/edit-views/episode.project.json";

/** jsdom drops a scrollLeft write; a browser keeps it, so emulate the browser. */
function emulateScrollLeft() {
  const original = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollLeft",
  );
  const offsets = new WeakMap<HTMLElement, number>();
  Object.defineProperty(HTMLElement.prototype, "scrollLeft", {
    configurable: true,
    get(this: HTMLElement) {
      return offsets.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      offsets.set(this, value);
    },
  });
  return () => {
    if (original) {
      Object.defineProperty(HTMLElement.prototype, "scrollLeft", original);
    } else {
      delete (HTMLElement.prototype as { scrollLeft?: number }).scrollLeft;
    }
  };
}

function Host() {
  const stage = useDawStore((s) => s.stage);
  return stage === "edit" ? <EditWorkspace /> : <p>{stage} stage</p>;
}

function stageTab(name: RegExp) {
  return within(
    screen.getAllByRole("tablist", { name: "Stages" })[0],
  ).getByRole("tab", { name });
}

let restoreScroll = () => {};

beforeEach(() => {
  restoreScroll = emulateScrollLeft();
  stubViewportShell("desktop");
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore
    .getState()
    .hydrate(PROJECT_PATH, minimalProject({ tracks: [sampleTrack()] }));
  useDawStore.setState({ stage: "edit", guestMode: null });
});

afterEach(() => {
  restoreScroll();
  vi.unstubAllGlobals();
});

describe("Edit view across stage switches", () => {
  it("restores zoom and scroll after leaving Edit and coming back", () => {
    render(<Host />);
    act(() =>
      useDawStore.setState({
        zoomPxPerSec: 240,
        scrollLeft: 500,
        userZoomed: true,
      }),
    );
    act(() => useDawStore.getState().openStage("review"));
    expect(screen.getByText("review stage")).toBeInTheDocument();
    expect(useDawStore.getState().stageViews.edit).toMatchObject({
      zoomPxPerSec: 240,
      scrollLeft: 500,
      userZoomed: true,
    });
    act(() => useDawStore.getState().openStage("edit"));
    const s = useDawStore.getState();
    expect([s.zoomPxPerSec, s.scrollLeft, s.userZoomed]).toEqual([
      240,
      500,
      true,
    ]);
  });

  it("gives another stage its own fit view and leaves Edit's snapshot alone", () => {
    render(<Host />);
    act(() =>
      useDawStore.setState({
        zoomPxPerSec: 240,
        scrollLeft: 500,
        userZoomed: true,
      }),
    );
    act(() => useDawStore.getState().openStage("prepare"));
    expect(useDawStore.getState().userZoomed).toBe(false);
    expect(useDawStore.getState().scrollLeft).toBe(0);
    act(() => useDawStore.getState().openStage("edit"));
    expect(useDawStore.getState().zoomPxPerSec).toBe(240);
  });

  it("keeps the selection and the playhead through the Stage bar", async () => {
    const user = userEvent.setup();
    render(
      <StageFrame>
        <Host />
      </StageFrame>,
    );
    act(() => {
      useDawStore.getState().setSelection({ kind: "track", trackId: "host" });
      useDawStore.getState().setPlayheadSec(7);
      useDawStore.setState({
        zoomPxPerSec: 120,
        scrollLeft: 64,
        userZoomed: true,
      });
    });
    await user.click(stageTab(/Review/));
    expect(useDawStore.getState().stage).toBe("review");
    await user.click(stageTab(/Edit/));
    const s = useDawStore.getState();
    expect(s.stage).toBe("edit");
    expect(s.selection).toEqual({ kind: "track", trackId: "host" });
    expect(s.playheadSec).toBe(7);
    expect([s.zoomPxPerSec, s.scrollLeft]).toEqual([120, 64]);
  });

  it("routes timeline keys to the timeline when Edit comes up", async () => {
    const user = userEvent.setup();
    render(
      <StageFrame>
        <Host />
      </StageFrame>,
    );
    await user.click(stageTab(/Review/));
    expect(useDawStore.getState().timelineFocused).toBe(false);
    await user.click(stageTab(/Edit/));
    expect(useDawStore.getState().timelineFocused).toBe(true);
  });
});

describe("Script keys", () => {
  it("T hides and shows the Script pane; Shift+T takes it over the stage", async () => {
    const user = userEvent.setup();
    function Keyed() {
      useDawKeymapListener();
      return <EditWorkspace />;
    }
    render(<Keyed />);
    expect(screen.getByRole("region", { name: "Script" })).toBeInTheDocument();
    await user.keyboard("t");
    expect(screen.queryByRole("region", { name: "Script" })).toBeNull();
    await user.keyboard("t");
    expect(screen.getByRole("region", { name: "Script" })).toBeInTheDocument();
    await user.keyboard("{Shift>}t{/Shift}");
    expect(useDawStore.getState().scriptFocus).toBe(true);
    expect(
      document.querySelector<HTMLElement>(".edit-timeline-col")?.hidden,
    ).toBe(true);
  });
});

import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { useStageScroll } from "./useStageScroll";

function Pane({ selector }: { selector?: string }) {
  const ref = useStageScroll("edit", "script", selector);
  return (
    <div ref={ref} data-testid="wrapper">
      <div className="list" data-testid="list" />
    </div>
  );
}

function scroller(el: HTMLElement) {
  let top = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    },
  });
  return el;
}

beforeEach(() => {
  useDawStore.getState().hydrate("/tmp/scroll/p.json", minimalProject());
  useDawStore.setState({ stage: "edit" });
});

describe("useStageScroll", () => {
  it("saves the offset once, when the pane unmounts", () => {
    const { getByTestId, unmount } = render(<Pane selector=".list" />);
    const list = scroller(getByTestId("list"));
    list.scrollTop = 340;
    fireEvent.scroll(list);
    expect(useDawStore.getState().stageViews.edit).toBeUndefined();
    unmount();
    expect(useDawStore.getState().stageViews.edit?.panelScroll.script).toBe(
      340,
    );
  });

  it("restores the saved offset on mount", () => {
    useDawStore.getState().setPanelScroll("edit", "script", 220);
    const original = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollTop",
    );
    let top = 0;
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
    try {
      render(<Pane />);
      expect(top).toBe(220);
    } finally {
      if (original) {
        Object.defineProperty(HTMLElement.prototype, "scrollTop", original);
      } else {
        delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
      }
    }
  });

  it("survives a stage switch: the unmount after setStage keeps the zoom snapshot", () => {
    useDawStore.setState({
      zoomPxPerSec: 180,
      scrollLeft: 90,
      userZoomed: true,
    });
    const { getByTestId, unmount } = render(<Pane selector=".list" />);
    const list = scroller(getByTestId("list"));
    list.scrollTop = 75;
    fireEvent.scroll(list);
    act(() => useDawStore.getState().setStage("review"));
    unmount();
    const view = useDawStore.getState().stageViews.edit;
    expect(view?.panelScroll.script).toBe(75);
    expect(view?.zoomPxPerSec).toBe(180);
    expect(view?.scrollLeft).toBe(90);
    expect(view?.userZoomed).toBe(true);
  });
});

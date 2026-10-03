import { fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { useRangeGesture } from "./useRangeGesture";

class TestPointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  constructor(type: string, options: PointerEventInit = {}) {
    super(type, options);
    this.pointerId = options.pointerId ?? 1;
    this.pointerType = options.pointerType ?? "mouse";
  }
}

function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  const gesture = useRangeGesture(ref, 10, 60);
  return (
    <div
      ref={ref}
      data-testid="lanes"
      onPointerDownCapture={gesture.captureDown}
      onPointerMoveCapture={gesture.captureMove}
      onPointerUpCapture={gesture.captureUp}
      onPointerCancelCapture={gesture.captureCancel}
      onClickCapture={gesture.captureClick}
    >
      <div className="lane-row" data-track-id="destination">
        <div className="lane-seek" data-testid="blank" />
        <button type="button">Edge control</button>
        <div className="clip-block">
          <button type="button" className="clip-hit" data-testid="clip">
            Clip body
          </button>
        </div>
      </div>
      <div className="lane-row" data-track-id="second" />
    </div>
  );
}

function setup() {
  const view = render(<Harness />);
  const lanes = view.getByTestId("lanes");
  vi.spyOn(lanes, "getBoundingClientRect").mockReturnValue({
    left: 100,
    top: 0,
    bottom: 100,
    right: 700,
    width: 600,
    height: 100,
    x: 100,
    y: 0,
    toJSON() {},
  });
  [...lanes.querySelectorAll<HTMLElement>(".lane-row")].forEach((lane, i) =>
    vi.spyOn(lane, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: i * 50,
      bottom: (i + 1) * 50,
      right: 700,
      width: 600,
      height: 50,
      x: 100,
      y: i * 50,
      toJSON() {},
    }),
  );
  return view;
}

beforeEach(() => {
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  useDawStore.setState({
    project: minimalProject({
      tracks: [
        sampleTrack({ id: "destination" }),
        sampleTrack({ id: "second" }),
      ],
    }),
    selection: null,
    toolMode: "select",
    rangeArmed: false,
    commentMode: false,
    joinMutationInFlight: false,
  });
});

describe("lane range gestures", () => {
  it("selects actual crossed destination lanes in either direction", () => {
    const view = setup();
    fireEvent.pointerDown(view.getByTestId("blank"), {
      clientX: 180,
      clientY: 75,
    });
    fireEvent.pointerMove(view.getByTestId("lanes"), {
      clientX: 120,
      clientY: 20,
    });
    fireEvent.pointerUp(view.getByTestId("lanes"), {
      clientX: 120,
      clientY: 20,
    });
    expect(useDawStore.getState().selection).toMatchObject({
      kind: "range",
      target: {
        intervals: [{ start: 2, end: 8 }],
        track_ids: ["destination", "second"],
      },
    });
  });
  it("leaves ordinary clip drag and touch navigation to their handlers", () => {
    const view = setup();
    for (const [target, pointerType] of [
      [view.getByTestId("clip"), "mouse"],
      [view.getByTestId("blank"), "touch"],
    ] as const) {
      fireEvent.pointerDown(target, { clientX: 120, clientY: 20, pointerType });
      fireEvent.pointerMove(view.getByTestId("lanes"), {
        clientX: 180,
        clientY: 75,
        pointerType,
      });
      fireEvent.pointerUp(view.getByTestId("lanes"), {
        clientX: 180,
        clientY: 75,
        pointerType,
      });
      expect(useDawStore.getState().selection).toBeNull();
    }
  });
  it("requires touch arming and cancels back to the previous selection", () => {
    const previous = {
      kind: "clip" as const,
      id: "kept",
      trackId: "destination",
    };
    useDawStore.setState({ rangeArmed: true, selection: previous });
    const view = setup();
    fireEvent.pointerDown(view.getByTestId("clip"), {
      clientX: 120,
      clientY: 20,
      pointerType: "touch",
    });
    fireEvent.pointerMove(view.getByTestId("lanes"), {
      clientX: 180,
      clientY: 75,
      pointerType: "touch",
    });
    expect(useDawStore.getState().selection?.kind).toBe("range");
    fireEvent.pointerCancel(view.getByTestId("lanes"));
    expect(useDawStore.getState().selection).toEqual(previous);
  });
  it("preserves edge control ownership and respects the join busy guard", () => {
    useDawStore.setState({ rangeArmed: true });
    const view = setup();
    fireEvent.pointerDown(view.getByRole("button", { name: "Edge control" }), {
      clientX: 120,
      clientY: 20,
    });
    fireEvent.pointerMove(view.getByTestId("lanes"), {
      clientX: 180,
      clientY: 75,
    });
    expect(useDawStore.getState().selection).toBeNull();
    useDawStore.setState({ joinMutationInFlight: true });
    fireEvent.pointerDown(view.getByTestId("blank"), {
      clientX: 120,
      clientY: 20,
    });
    fireEvent.pointerMove(view.getByTestId("lanes"), {
      clientX: 180,
      clientY: 75,
    });
    expect(useDawStore.getState().selection).toBeNull();
  });
});

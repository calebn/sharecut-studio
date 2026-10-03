import { act, fireEvent, render } from "@testing-library/react";
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

function Harness({
  expose,
}: {
  expose?: (value: ReturnType<typeof useRangeGesture>) => void;
} = {}) {
  const ref = useRef<HTMLDivElement>(null);
  const gesture = useRangeGesture(ref, 10, 60);
  expose?.(gesture);
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

function setup(expose?: (value: ReturnType<typeof useRangeGesture>) => void) {
  const view = render(<Harness expose={expose} />);
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

it("a stale body owner cannot clear the newer lane range", () => {
  let gesture!: ReturnType<typeof useRangeGesture>["gesture"];
  function OwnedHarness() {
    const ref = useRef<HTMLDivElement>(null);
    gesture = useRangeGesture(ref, 10, 60).gesture;
    return (
      <div ref={ref} data-testid="owned-lanes">
        <div className="lane-row" data-track-id="destination" />
      </div>
    );
  }
  const view = render(<OwnedHarness />);
  const lanes = view.getByTestId("owned-lanes");
  vi.spyOn(lanes, "getBoundingClientRect").mockReturnValue({
    left: 100,
  } as DOMRect);
  vi.spyOn(lanes.firstElementChild!, "getBoundingClientRect").mockReturnValue({
    top: 0,
    bottom: 50,
  } as DOMRect);
  const bodyOwner = {};
  act(() => {
    gesture("start", { clientX: 110, clientY: 10 }, bodyOwner);
    gesture("move", { clientX: 150, clientY: 20 }, bodyOwner);
  });
  act(() => {
    gesture("start", { clientX: 180, clientY: 10 });
    gesture("move", { clientX: 220, clientY: 20 });
  });
  const newer = useDawStore.getState().selection;
  expect(newer).toMatchObject({
    kind: "range",
    target: { intervals: [{ start: 8, end: 12 }] },
  });
  act(() => gesture("cancel", { clientX: 150, clientY: 20 }, bodyOwner));
  expect(useDawStore.getState().selection).toBe(newer);
  act(() => gesture("move", { clientX: 240, clientY: 20 }));
  expect(useDawStore.getState().selection).toMatchObject({
    kind: "range",
    target: { intervals: [{ start: 8, end: 14 }] },
  });
});

it("parent capture cancellation ignores foreign and body-owned range events", () => {
  let range!: ReturnType<typeof useRangeGesture>;
  const view = setup((value) => {
    range = value;
  });
  const body = {};
  act(() => {
    range.gesture("start", { clientX: 110, clientY: 10 }, body);
    range.gesture("move", { clientX: 150, clientY: 20 }, body);
  });
  const owned = useDawStore.getState().selection;
  expect(owned).toMatchObject({
    kind: "range",
    target: { intervals: [{ start: 1, end: 5 }] },
  });
  fireEvent.pointerCancel(view.getByTestId("clip"), { pointerId: 99 });
  expect(useDawStore.getState().selection).toBe(owned);
  act(() => range.gesture("cancel", { clientX: 150, clientY: 20 }, body));
  expect(useDawStore.getState().selection).toBeNull();
  const blank = view.getByTestId("blank");
  fireEvent.pointerDown(blank, { pointerId: 3, clientX: 180, clientY: 10 });
  fireEvent.pointerMove(blank, { pointerId: 3, clientX: 220, clientY: 20 });
  const lane = useDawStore.getState().selection;
  expect(lane).toMatchObject({
    kind: "range",
    target: { intervals: [{ start: 8, end: 12 }] },
  });
  fireEvent.pointerCancel(blank, { pointerId: 4 });
  expect(useDawStore.getState().selection).toBe(lane);
  fireEvent.pointerCancel(blank, { pointerId: 3 });
  expect(useDawStore.getState().selection).toBeNull();
});

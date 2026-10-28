import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Clip } from "./Clip";
import { type LaneMarker, MarkerLane } from "./MarkerLane";
import { Ruler } from "./Ruler";
import { TrackHeader } from "./TrackHeader";

const renders = vi.hoisted(() => ({
  clips: 0,
  headers: 0,
  rulers: 0,
  markers: 0,
}));

vi.mock("./rulerMath", async (importActual) => {
  const actual = await importActual<typeof import("./rulerMath")>();
  return {
    ...actual,
    rulerTicks: (...args: Parameters<typeof actual.rulerTicks>) => {
      renders.rulers += 1;
      return actual.rulerTicks(...args);
    },
  };
});
vi.mock("./Marker", () => ({
  Marker: (props: { onSelect: () => void; selected?: boolean }) => {
    renders.markers += 1;
    return (
      <button
        type="button"
        aria-pressed={props.selected}
        onClick={props.onSelect}
      />
    );
  },
}));

vi.mock("./waveStrip", () => ({
  PeakStrip: () => {
    renders.clips += 1;
    return null;
  },
}));
vi.mock("./ScrubField", () => ({
  ScrubField: () => {
    renders.headers += 1;
    return null;
  },
}));

const names = ["Take 1", "Take 2", "Take 3"];
const PEAKS = [0.5];
const noop = () => undefined;

function Lane() {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <>
      {names.map((name, index) => (
        <Clip
          key={name}
          id={name}
          name={name}
          colorIndex={0}
          start={index * 5}
          duration={4}
          pxPerSecond={40}
          peaks={PEAKS}
          selected={picked === name}
          onSelect={setPicked}
        />
      ))}
    </>
  );
}

function Column() {
  const [soloed, setSoloed] = useState<string | null>(null);
  return (
    <>
      {names.map((name) => (
        <TrackHeader
          key={name}
          id={name}
          name={name}
          colorIndex={0}
          level={0}
          solo={soloed === name}
          onSelect={setSoloed}
          onMute={setSoloed}
          onSolo={setSoloed}
          onLevel={noop}
        />
      ))}
    </>
  );
}

describe("Clip in a lane", () => {
  it("draws only the clips whose own props changed when a sibling is selected", () => {
    renders.clips = 0;
    render(<Lane />);
    expect(renders.clips).toBe(3);
    fireEvent.click(screen.getByRole("button", { name: "Take 2" }));
    expect(renders.clips).toBe(4);
    fireEvent.click(screen.getByRole("button", { name: "Take 3" }));
    expect(renders.clips).toBe(6);
    fireEvent.click(screen.getByRole("button", { name: "Take 3" }));
    expect(renders.clips).toBe(6);
  });
});

describe("TrackHeader in a column", () => {
  it("draws only the headers whose own props changed when a sibling is soloed", () => {
    renders.headers = 0;
    render(<Column />);
    expect(renders.headers).toBe(3);
    fireEvent.click(screen.getByRole("button", { name: "Solo Take 1" }));
    expect(renders.headers).toBe(4);
    fireEvent.click(screen.getByRole("button", { name: "Solo Take 2" }));
    expect(renders.headers).toBe(6);
  });
});

const chapters: LaneMarker[] = names.map((name, index) => ({
  kind: "chapter",
  id: name,
  start: index * 10,
  title: name,
}));
const selectedNone: readonly string[] = [];

function Markers() {
  const [picked, setPicked] = useState<readonly string[]>(selectedNone);
  const [, setTick] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setTick((n) => n + 1)}>
        Unrelated
      </button>
      <MarkerLane
        markers={chapters}
        start={0}
        pxPerSecond={6}
        width={360}
        duration={100}
        selected={picked}
        onSelect={(id) => setPicked([id])}
      />
    </>
  );
}

function Timeline() {
  const [playhead, setPlayhead] = useState(5);
  const [, setTick] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setTick((n) => n + 1)}>
        Unrelated
      </button>
      <button type="button" onClick={() => setPlayhead((n) => n + 1)}>
        Move
      </button>
      <Ruler
        start={0}
        pxPerSecond={6}
        width={360}
        duration={100}
        playhead={playhead}
        onSeek={setPlayhead}
      />
    </>
  );
}

describe("Ruler in a timeline", () => {
  it("draws again for its own playhead and not for a parent render that changes nothing", () => {
    renders.rulers = 0;
    render(<Timeline />);
    expect(renders.rulers).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Unrelated" }));
    fireEvent.click(screen.getByRole("button", { name: "Unrelated" }));
    expect(renders.rulers).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(renders.rulers).toBe(2);
  });
});

describe("MarkerLane in a timeline", () => {
  it("draws only the markers whose own props changed when a sibling is selected, and none for an unrelated parent render", () => {
    renders.markers = 0;
    render(<Markers />);
    expect(renders.markers).toBe(3);
    fireEvent.click(screen.getByRole("button", { name: "Unrelated" }));
    expect(renders.markers).toBe(3);
    const lane = screen.getByRole("group", { name: "Markers" });
    const buttons = () => lane.querySelectorAll("button");
    fireEvent.click(buttons()[1] as HTMLElement);
    expect(renders.markers).toBe(4);
    fireEvent.click(buttons()[2] as HTMLElement);
    expect(renders.markers).toBe(6);
  });
});

const spread: LaneMarker[] = [0, 1, 2, 3, 4, 5].map((n) => ({
  kind: "chapter",
  id: `c${n}`,
  start: n * 10,
  title: `Chapter ${n}`,
}));

function MovingMarkers() {
  const [markers, setMarkers] = useState<readonly LaneMarker[]>(spread);
  const move = (id: string, by: number) =>
    setMarkers((now) =>
      now.map((marker) =>
        marker.id === id ? { ...marker, start: marker.start + by } : marker,
      ),
    );
  return (
    <>
      <button type="button" onClick={() => move("c2", 1)}>
        Nudge
      </button>
      <button type="button" onClick={() => setMarkers((now) => [...now])}>
        Copy
      </button>
      <MarkerLane
        markers={markers}
        start={0}
        pxPerSecond={6}
        width={400}
        duration={100}
        onSelect={noop}
      />
    </>
  );
}

describe("MarkerLane when the host moves one marker", () => {
  it("draws the moved marker and the one whose title it cuts off, and none of the other four", () => {
    renders.markers = 0;
    render(<MovingMarkers />);
    expect(renders.markers).toBe(6);
    fireEvent.click(screen.getByRole("button", { name: "Nudge" }));
    expect(renders.markers).toBe(8);
    fireEvent.click(screen.getByRole("button", { name: "Nudge" }));
    expect(renders.markers).toBe(10);
  });

  it("draws nothing when the host passes a new array of the same markers", () => {
    renders.markers = 0;
    render(<MovingMarkers />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(renders.markers).toBe(6);
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Clip } from "./Clip";
import { TrackHeader } from "./TrackHeader";

const renders = vi.hoisted(() => ({ clips: 0, headers: 0 }));

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

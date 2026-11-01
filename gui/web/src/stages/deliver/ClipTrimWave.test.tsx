import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClipTrimWave } from "./ClipTrimWave";

const WORDS = [
  { text: "a", start: 10, end: 10.4 },
  { text: "b", start: 10.6, end: 11.2 },
  { text: "c", start: 11.3, end: 11.8 },
  { text: "d", start: 12, end: 12.2 },
  { text: "e", start: 12.3, end: 13 },
];

function setup(extra: Partial<React.ComponentProps<typeof ClipTrimWave>> = {}) {
  const onTrim = vi.fn();
  render(
    <ClipTrimWave
      name="Clip"
      peaks={[0.2, 0.5, 0.9, 0.4]}
      window={{ start: 9, end: 14 }}
      start={10.6}
      end={11.8}
      words={WORDS}
      onTrim={onTrim}
      {...extra}
    />,
  );
  const handle = (edge: "In" | "Out") =>
    screen.getByRole("slider", { name: `${edge} handle of Clip` });
  const track = screen.getByRole("group", { name: "Waveform of Clip" });
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
    left: 100,
    width: 500,
    right: 600,
    top: 0,
    bottom: 0,
    height: 0,
    x: 100,
    y: 0,
    toJSON: () => ({}),
  });
  return { onTrim, handle };
}

describe("ClipTrimWave keys", () => {
  it.each([
    ["In", "ArrowRight", {}, 10.61],
    ["In", "ArrowLeft", {}, 10.59],
    ["In", "ArrowRight", { shiftKey: true }, 10.7],
    ["In", "ArrowLeft", { shiftKey: true }, 10.5],
    ["Out", "ArrowRight", {}, 11.81],
    ["Out", "ArrowLeft", {}, 11.79],
    ["Out", "ArrowRight", { shiftKey: true }, 11.9],
    ["Out", "ArrowLeft", { shiftKey: true }, 11.7],
  ] as const)(
    "%s %s %j moves to %f, with words or without",
    (edge, key, init, expected) => {
      for (const words of [WORDS, []]) {
        const { onTrim, handle } = setup({ words });
        fireEvent.keyDown(handle(edge), { key, ...init });
        expect(onTrim).toHaveBeenCalledOnce();
        expect(onTrim.mock.calls[0]?.[0]).toBe(edge === "In" ? "start" : "end");
        expect(onTrim.mock.calls[0]?.[1]).toBeCloseTo(expected, 6);
        cleanup();
      }
    },
  );

  it.each(["a", "ArrowUp", "ArrowDown", "Home", "End", "PageUp"])(
    "ignores %s",
    (key) => {
      const { onTrim, handle } = setup();
      fireEvent.keyDown(handle("In"), { key });
      expect(onTrim).not.toHaveBeenCalled();
    },
  );

  it("stops at the edges of the strip", () => {
    const { onTrim, handle } = setup({ start: 9, end: 14 });
    fireEvent.keyDown(handle("In"), { key: "ArrowLeft" });
    fireEvent.keyDown(handle("Out"), { key: "ArrowRight" });
    expect(onTrim.mock.calls[0]?.[1]).toBe(9);
    expect(onTrim.mock.calls[1]?.[1]).toBe(14);
  });
});

describe("ClipTrimWave drag", () => {
  const drag = (el: HTMLElement, x: number, init: PointerEventInit = {}) => {
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 300, buttons: 1 });
    fireEvent.pointerMove(el, {
      pointerId: 1,
      clientX: x,
      buttons: 1,
      ...init,
    });
    fireEvent.pointerUp(el, { pointerId: 1 });
  };

  it.each([
    ["In", 100 + 500 * ((10.5 - 9) / 5), "start", 10.6],
    ["In", 100 + 500 * ((10.2 - 9) / 5), "start", 10],
    ["Out", 100 + 500 * ((11.5 - 9) / 5), "end", 11.2],
    ["Out", 100 + 500 * ((11.7 - 9) / 5), "end", 11.8],
  ] as const)(
    "%s snaps a drag to the nearest word edge",
    (edge, x, kind, expected) => {
      const { onTrim, handle } = setup();
      drag(handle(edge), x);
      expect(onTrim).toHaveBeenLastCalledWith(kind, expected);
    },
  );

  it("moves freely while Alt is held", () => {
    const { onTrim, handle } = setup();
    drag(handle("In"), 100 + 500 * ((10.5 - 9) / 5), { altKey: true });
    expect(onTrim.mock.calls.at(-1)?.[1]).toBeCloseTo(10.5, 6);
  });

  it("moves freely with no words", () => {
    const { onTrim, handle } = setup({ words: [] });
    drag(handle("Out"), 100 + 500 * ((11.55 - 9) / 5));
    expect(onTrim.mock.calls.at(-1)?.[1]).toBeCloseTo(11.55, 6);
  });

  it("stays inside the strip", () => {
    const { onTrim, handle } = setup({ words: [] });
    drag(handle("In"), -500);
    drag(handle("Out"), 5000);
    expect(onTrim).toHaveBeenNthCalledWith(1, "start", 9);
    expect(onTrim).toHaveBeenNthCalledWith(2, "end", 14);
  });

  it("does nothing on a move without a press", () => {
    const { onTrim, handle } = setup();
    fireEvent.pointerMove(handle("In"), {
      pointerId: 1,
      clientX: 200,
      buttons: 1,
    });
    expect(onTrim).not.toHaveBeenCalled();
  });

  it("stops after release or cancel", () => {
    const { onTrim, handle } = setup();
    fireEvent.pointerDown(handle("In"), {
      pointerId: 1,
      clientX: 300,
      buttons: 1,
    });
    fireEvent.pointerCancel(handle("In"), { pointerId: 1 });
    fireEvent.pointerMove(handle("In"), {
      pointerId: 1,
      clientX: 200,
      buttons: 1,
    });
    expect(onTrim).not.toHaveBeenCalled();
  });

  it("stops when the pointer capture is lost", () => {
    const { onTrim, handle } = setup();
    fireEvent.pointerDown(handle("Out"), {
      pointerId: 1,
      clientX: 300,
      buttons: 1,
    });
    fireEvent.lostPointerCapture(handle("Out"), { pointerId: 1 });
    fireEvent.pointerMove(handle("Out"), {
      pointerId: 1,
      clientX: 200,
      buttons: 1,
    });
    expect(onTrim).not.toHaveBeenCalled();
  });

  it.each(["In", "Out"] as const)(
    "ignores a %s move with no button held, even after a press",
    (edge) => {
      const { onTrim, handle } = setup();
      fireEvent.pointerDown(handle(edge), {
        pointerId: 1,
        clientX: 300,
        buttons: 1,
      });
      fireEvent.pointerMove(handle(edge), {
        pointerId: 1,
        clientX: 200,
        buttons: 0,
      });
      expect(onTrim).not.toHaveBeenCalled();
      fireEvent.pointerMove(handle(edge), {
        pointerId: 1,
        clientX: 200,
        buttons: 1,
      });
      expect(onTrim).toHaveBeenCalledOnce();
    },
  );
});

describe("ClipTrimWave anatomy", () => {
  it("names its handles and reports their values and range", () => {
    const { handle } = setup();
    const start = handle("In");
    expect(start).toHaveAttribute("aria-valuemin", "9");
    expect(start).toHaveAttribute("aria-valuemax", "14");
    expect(start).toHaveAttribute("aria-valuenow", "10.6");
    expect(start).toHaveAttribute("aria-valuetext", "0:10.6");
    expect(handle("Out")).toHaveAttribute("aria-valuetext", "0:11.8");
  });

  it("places the handles and the region by time", () => {
    const { handle } = setup();
    expect(handle("In").style.insetInlineStart).toBe("32%");
    expect(handle("Out").style.insetInlineStart).toBe("56%");
    const region = document.querySelector(".dv-trim-region") as HTMLElement;
    expect(region.style.insetInlineStart).toBe("32%");
    expect(Number.parseFloat(region.style.inlineSize)).toBeCloseTo(24, 6);
  });

  it("draws a peak per bucket", () => {
    setup();
    expect(document.querySelectorAll(".sys-wave-peak")).toHaveLength(4);
  });

  it("draws a flat line without peaks", () => {
    setup({ peaks: [] });
    expect(document.querySelectorAll(".sys-wave-peak")).toHaveLength(1);
    cleanup();
    setup({ peaks: undefined });
    expect(document.querySelectorAll(".sys-wave-peak")).toHaveLength(1);
  });

  it.each([
    [3000, 3010, "100%", "100%", "0%"],
    [-50, -40, "0%", "0%", "0%"],
    [5, 20, "0%", "100%", "100%"],
  ])(
    "keeps a clip %f to %f s inside the strip when drawn",
    (from, to, startAt, endAt, width) => {
      const { handle } = setup({ start: from, end: to });
      expect(handle("In").style.insetInlineStart).toBe(startAt);
      expect(handle("Out").style.insetInlineStart).toBe(endAt);
      const region = document.querySelector(".dv-trim-region") as HTMLElement;
      expect(region.style.inlineSize).toBe(width);
    },
  );

  it("releases the hold when it unmounts mid-gesture", () => {
    const onGesture = vi.fn();
    const { handle } = setup({ onGesture });
    fireEvent.pointerDown(handle("In"), { pointerId: 1, clientX: 150 });
    fireEvent.pointerMove(handle("In"), {
      pointerId: 1,
      clientX: 200,
      buttons: 1,
    });
    expect(onGesture).toHaveBeenLastCalledWith(true);
    cleanup();
    expect(onGesture).toHaveBeenLastCalledWith(false);
  });
});

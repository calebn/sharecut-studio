import { describe, expect, it } from "vitest";
import { placePendingActionbar } from "./pendingActionPlacement";

function availablePlacement(
  position: ReturnType<typeof placePendingActionbar>,
) {
  if (!position) throw new Error("Expected an available actionbar placement");
  return position;
}

describe("placePendingActionbar", () => {
  const panel = { width: 240, height: 120 };
  const viewport = { width: 390, height: 844 };

  it("places the actions below the lane without covering its handles", () => {
    const position = availablePlacement(
      placePendingActionbar(
        { left: 120, top: 100, bottom: 200, width: 14 },
        panel,
        viewport,
        8,
      ),
    );
    expect(position.top).toBe(208);
    expect(position.maxHeight).toBe(628);
  });

  it("flips above a lane near the viewport bottom", () => {
    const position = availablePlacement(
      placePendingActionbar(
        { left: 320, top: 700, bottom: 810, width: 14 },
        panel,
        viewport,
        8,
      ),
    );
    expect(position.top).toBe(572);
    expect(position.left).toBe(142);
    expect(position.maxHeight).toBe(684);
  });

  it("caps a tall panel to the roomier side and keeps it outside the lane", () => {
    const position = availablePlacement(
      placePendingActionbar(
        { left: 120, top: 400, bottom: 500, width: 14 },
        { width: 240, height: 400 },
        viewport,
        8,
      ),
    );
    expect(position).toEqual({ left: 8, top: 8, maxHeight: 384 });
    expect(position.top + position.maxHeight).toBeLessThan(400);
  });

  it("uses the roomier side and caps to its full available height", () => {
    const position = availablePlacement(
      placePendingActionbar(
        { left: 120, top: 400, bottom: 500, width: 14 },
        { width: 240, height: 700 },
        viewport,
        8,
      ),
    );
    expect(position.top).toBe(8);
    expect(position.maxHeight).toBe(384);
    expect(position.top + position.maxHeight).toBeLessThan(400);
  });

  it("keeps placement inside the viewport when the lane is below it", () => {
    const position = availablePlacement(
      placePendingActionbar(
        { left: 120, top: 1000, bottom: 1100, width: 14 },
        panel,
        viewport,
        8,
      ),
    );
    expect(position.top).toBe(708);
    expect(position.top + panel.height).toBeLessThanOrEqual(
      viewport.height - 8,
    );
  });

  it("keeps placement inside the viewport when the lane is above it", () => {
    const position = availablePlacement(
      placePendingActionbar(
        { left: 120, top: -100, bottom: -40, width: 14 },
        panel,
        viewport,
        8,
      ),
    );
    expect(position.top).toBe(16);
    expect(position.top).toBeGreaterThanOrEqual(8);
  });

  it("hides inline controls when neither side has room", () => {
    expect(
      placePendingActionbar(
        { left: 120, top: 8, bottom: 836, width: 14 },
        panel,
        viewport,
        8,
      ),
    ).toBeNull();
  });
});

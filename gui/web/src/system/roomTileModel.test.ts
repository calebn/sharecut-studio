import { describe, expect, it } from "vitest";
import { type RoomTileProps, roomTileLabel } from "./roomTileModel";

const live = (rest: Partial<Extract<RoomTileProps, { presence: "live" }>>) =>
  ({
    presence: "live",
    person: { name: "Ava", colorIndex: 1 },
    ...rest,
  }) as RoomTileProps;

describe("roomTileLabel for the viewer's own tile", () => {
  it("says you right after the name", () => {
    expect(roomTileLabel(live({ you: true }))).toBe("Ava, you");
    expect(roomTileLabel(live({ you: true, clipped: 1 }))).toBe(
      "Ava, you, 1 clip",
    );
    expect(roomTileLabel(live({ you: true, muted: true }))).toBe(
      "Ava, you, muted",
    );
  });

  it("leaves a tile without you as it was", () => {
    expect(
      roomTileLabel(
        live({ host: true, person: { name: "Host", colorIndex: 0 } }),
      ),
    ).toBe("Host, host");
    expect(roomTileLabel(live({}))).toBe("Ava");
  });
});

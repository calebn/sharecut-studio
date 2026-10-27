import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ListenerAvatar, ListenerRow, RoomTile } from "./RoomTile";
import {
  clampLevel,
  clipCount,
  type RoomTileProps,
  roomTileLabel,
  savingFraction,
} from "./roomTileModel";

const MAYA = { name: "Maya Okafor", colorIndex: 0 };
const live = (rest: Partial<Extract<RoomTileProps, { presence: "live" }>>) =>
  ({ presence: "live", person: MAYA, ...rest }) as RoomTileProps;

describe("RoomTile states in words", () => {
  it.each([
    [{ presence: "joining", person: MAYA } as const, "Joining…"],
    [{ presence: "left", person: MAYA } as const, "Left"],
    [{ presence: "declined", person: MAYA } as const, "Declined"],
    [live({ connection: "lost" }), "Reconnecting…"],
    [live({ saving: "saved" }), "Saved"],
    [live({ saving: "failed" }), "Couldn't save"],
    [live({ saving: { done: 2, total: 5 } }), "Saving 40%"],
  ])("prints the status for %j", (props, text) => {
    render(<RoomTile {...props} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByRole("group")).toHaveAccessibleName(
      expect.stringContaining(text),
    );
  });

  it("names every live flag in the accessible name", () => {
    const label = roomTileLabel(
      live({ muted: true, connection: "weak", clipped: 3, alert: true }),
    );
    expect(label).toBe(
      "Maya Okafor, muted, Weak signal, 3 clips, needs attention",
    );
    expect(roomTileLabel(live({ speaking: true }))).toContain("speaking");
    expect(roomTileLabel(live({ clipped: 1 }))).toContain("1 clip");
  });

  it("never announces speaking the tile does not show", () => {
    for (const rest of [
      { muted: true },
      { connection: "lost" as const },
      { saving: "saved" as const },
      { listener: true },
    ]) {
      expect(roomTileLabel(live({ speaking: true, ...rest }))).not.toContain(
        "speaking",
      );
    }
  });

  it("keeps a failed save in words over a lost connection", () => {
    render(<RoomTile {...live({ connection: "lost", saving: "failed" })} />);
    expect(screen.getByText("Couldn't save")).toBeInTheDocument();
    expect(screen.queryByText("Reconnecting…")).toBeNull();
    expect(screen.getByRole("group")).toHaveAccessibleName(
      "Maya Okafor, Reconnecting…, Couldn't save",
    );
    expect(
      roomTileLabel(
        live({ connection: "lost", saving: { done: 1, total: 2 } }),
      ),
    ).toBe("Maya Okafor, Reconnecting…, Saving 50%");
  });

  it("shows Declined with the mic-off glyph", () => {
    const { container } = render(
      <RoomTile presence="declined" person={MAYA} />,
    );
    expect(screen.getByText("Declined")).toBeInTheDocument();
    expect(container.querySelector(".sys-room-glyphs svg")).not.toBeNull();
  });

  it("shows the signal beside the ear glyph only when a listener is weak or lost", () => {
    const { rerender } = render(<RoomTile {...live({ listener: true })} />);
    expect(screen.getByTitle("Listening")).toBeInTheDocument();
    expect(screen.queryByTitle("Good connection")).toBeNull();
    rerender(<RoomTile {...live({ listener: true, connection: "weak" })} />);
    expect(screen.getByTitle("Listening")).toBeInTheDocument();
    expect(screen.getByTitle("Weak signal")).toBeInTheDocument();
    rerender(<RoomTile {...live({ listener: true, connection: "lost" })} />);
    expect(screen.getByTitle("Connection lost")).toBeInTheDocument();
  });

  it("normalises the clip count for badge and label", () => {
    expect(clipCount(2.9)).toBe(2);
    expect(clipCount(-3)).toBe(0);
    expect(clipCount(Number.NaN)).toBe(0);
    expect(clipCount(undefined)).toBe(0);
    const { container } = render(<RoomTile {...live({ clipped: 2.9 })} />);
    expect(container.querySelector(".sys-room-clip")).toHaveTextContent("2");
    expect(roomTileLabel(live({ clipped: 2.9 }))).toContain("2 clips");
    expect(roomTileLabel(live({ clipped: Number.NaN }))).toBe("Maya Okafor");
  });

  it("labels the glyphs and adds no live region", () => {
    const { container } = render(
      <RoomTile {...live({ muted: true, connection: "weak" })} />,
    );
    const group = screen.getByRole("group");
    expect(within(group).getByTitle("Muted")).toBeInTheDocument();
    expect(within(group).getByTitle("Weak signal")).toBeInTheDocument();
    expect(container.querySelector("[aria-live]")).toBeNull();
  });

  it("shows the clip count as a badge", () => {
    render(<RoomTile {...live({ clipped: 3 })} />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("is an Invite button only as a placeholder", async () => {
    const onInvite = vi.fn();
    render(<RoomTile presence="placeholder" onInvite={onInvite} />);
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    expect(onInvite).toHaveBeenCalledOnce();
  });
});

describe("level ring", () => {
  it("clamps to 0..1", () => {
    expect(clampLevel(-0.4)).toBe(0);
    expect(clampLevel(3)).toBe(1);
    expect(clampLevel(0.25)).toBe(0.25);
    expect(clampLevel(undefined)).toBe(0);
    expect(clampLevel(Number.NaN)).toBe(0);
  });

  it("sets the level as a custom property and stops it when muted", () => {
    const { container, rerender } = render(
      <RoomTile {...live({ level: 4 })} />,
    );
    const face = () =>
      container.querySelector<HTMLElement>(".sys-room-face") as HTMLElement;
    expect(face().style.getPropertyValue("--sys-room-level")).toBe("1");
    rerender(<RoomTile {...live({ level: 0.6, muted: true })} />);
    expect(face().style.getPropertyValue("--sys-room-level")).toBe("0");
  });

  it("marks speaking on the tile and adds a meter bar only to the self tile", () => {
    const { container, rerender } = render(
      <RoomTile {...live({ speaking: true })} />,
    );
    expect(container.querySelector("[data-speaking]")).not.toBeNull();
    expect(container.querySelector(".sys-room-meter")).toBeNull();
    rerender(<RoomTile {...live({ isMe: true, level: 0.5 })} />);
    expect(container.querySelector(".sys-room-meter")).not.toBeNull();
  });
});

describe("saving ring", () => {
  it("fills by saved share and tolerates an empty total", () => {
    expect(savingFraction(1, 4)).toBe(0.25);
    expect(savingFraction(9, 4)).toBe(1);
    expect(savingFraction(1, 0)).toBe(0);
  });

  it("draws no fill arc at zero, so there is no dot", () => {
    const { container } = render(
      <RoomTile {...live({ saving: { done: 0, total: 4 } })} />,
    );
    expect(container.querySelector(".sys-room-saving-fill")).toBeNull();
    expect(container.querySelector(".sys-room-saving-track")).not.toBeNull();
  });

  it("draws the fill, a check when saved and an exclamation when failed", () => {
    const { container, rerender } = render(
      <RoomTile {...live({ saving: { done: 1, total: 4 } })} />,
    );
    expect(
      container
        .querySelector(".sys-room-saving-fill")
        ?.getAttribute("stroke-dasharray"),
    ).toBe("0.25 1");
    rerender(<RoomTile {...live({ saving: "saved" })} />);
    expect(
      container.querySelector(".sys-room-saving-mark--success"),
    ).not.toBeNull();
    rerender(<RoomTile {...live({ saving: "failed" })} />);
    expect(
      container.querySelector(".sys-room-saving-mark--warning"),
    ).toHaveTextContent("!");
  });
});

describe("listener row", () => {
  it("is 28 px avatars with an ear glyph and the name in text", () => {
    const { container } = render(
      <ListenerRow>
        <ListenerAvatar person={MAYA} label="You" />
        <ListenerAvatar person={{ name: "Jon", colorIndex: 2 }} />
      </ListenerRow>,
    );
    expect(screen.getByRole("list", { name: "Listening" })).toBeInTheDocument();
    expect(screen.getByText("You, listening")).toBeInTheDocument();
    expect(screen.getByText("Jon, listening")).toBeInTheDocument();
    expect(container.querySelectorAll(".sys-person-avatar--28")).toHaveLength(
      2,
    );
    expect(container.querySelectorAll(".sys-room-listener-glyph")).toHaveLength(
      2,
    );
  });
});

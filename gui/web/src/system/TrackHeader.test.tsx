import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { TrackHeader, type TrackHeaderProps } from "./TrackHeader";

const base: TrackHeaderProps = {
  id: "track-1",
  name: "Maya",
  colorIndex: 2,
  level: -3,
  onSelect: () => undefined,
  onMute: () => undefined,
  onSolo: () => undefined,
  onLevel: () => undefined,
};

function setup(over: Partial<TrackHeaderProps> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onMute: vi.fn(),
    onSolo: vi.fn(),
    onLevel: vi.fn(),
  };
  const view = render(<TrackHeader {...base} {...handlers} {...over} />);
  return { ...handlers, ...view };
}

const mute = () => screen.getByRole("button", { name: "Mute Maya" });
const solo = () => screen.getByRole("button", { name: "Solo Maya" });
const select = () => screen.getByRole("button", { name: "Maya" });

describe("TrackHeader controls", () => {
  it("names each control for its track and acts on a click", async () => {
    const user = userEvent.setup();
    const { onSelect, onMute, onSolo } = setup();
    await user.click(select());
    await user.click(mute());
    await user.click(solo());
    expect([onSelect, onMute, onSolo].map((f) => f.mock.calls)).toEqual([
      [["track-1", false]],
      [["track-1"]],
      [["track-1"]],
    ]);
    expect(
      screen.getByRole("spinbutton", { name: "Maya level" }),
    ).toHaveAttribute("aria-valuenow", "-3");
  });

  it("says when the select click is additive: Shift, Ctrl or Cmd", () => {
    const { onSelect } = setup();
    fireEvent.click(select(), { shiftKey: true });
    fireEvent.click(select(), { ctrlKey: true });
    fireEvent.click(select(), { metaKey: true });
    expect(onSelect.mock.calls).toEqual([
      ["track-1", true],
      ["track-1", true],
      ["track-1", true],
    ]);
  });

  it("pins mute and solo as toggles that say what they are", () => {
    const { rerender } = render(<TrackHeader {...base} />);
    expect(mute()).toHaveAttribute("aria-pressed", "false");
    expect(solo()).toHaveAttribute("aria-pressed", "false");
    rerender(<TrackHeader {...base} mute="listen" solo />);
    expect(mute()).toHaveAttribute("aria-pressed", "true");
    expect(mute()).toHaveAccessibleDescription("Unmute. Muted for you only");
    expect(solo()).toHaveAttribute("aria-pressed", "true");
    expect(solo()).toHaveAccessibleDescription("Unsolo. Soloed for you only");
  });

  it("does not press mute for an implied mute, and says why the track is silent", () => {
    render(<TrackHeader {...base} mute="implied" />);
    expect(mute()).toHaveAttribute("aria-pressed", "false");
    expect(mute()).toHaveAccessibleDescription(
      "Mute. Not muted: silent because you soloed another track, and only you hear it that way",
    );
    expect(select()).toHaveAccessibleDescription(
      "Silent while another track is soloed",
    );
  });

  it("lists everything that is set on the select button", () => {
    render(<TrackHeader {...base} mute="saved" solo rebuilding />);
    expect(select()).toHaveAccessibleDescription(
      "Muted in the mix. Soloed. Rebuilding",
    );
  });

  it("commits a level typed in the field", async () => {
    const user = userEvent.setup();
    const { onLevel } = setup();
    screen.getByRole("spinbutton", { name: "Maya level" }).focus();
    await user.keyboard("{Enter}-6{Enter}");
    expect(onLevel.mock.calls).toEqual([["track-1", -6]]);
  });

  it("steps the level 0.5 dB with an arrow", async () => {
    const user = userEvent.setup();
    const { onLevel } = setup();
    screen.getByRole("spinbutton", { name: "Maya level" }).focus();
    await user.keyboard("{ArrowUp}");
    expect(onLevel.mock.calls).toEqual([["track-1", -2.5]]);
  });
});

describe("TrackHeader as a guest sees it", () => {
  it("keeps a mix mute on and the level fixed, but lets them solo", async () => {
    const user = userEvent.setup();
    const { onMute, onSolo } = setup({ readOnly: true, mute: "saved" });
    await user.click(mute());
    await user.click(solo());
    expect(mute()).toHaveAttribute("aria-disabled", "true");
    expect(mute()).toHaveAccessibleDescription(
      "Muted in the mix. Only the host and editors can unmute it",
    );
    expect(onMute).not.toHaveBeenCalled();
    expect(onSolo).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("spinbutton", { name: "Maya level" }),
    ).toHaveAttribute("aria-readonly", "true");
  });

  it("can still mute a track for themselves", async () => {
    const user = userEvent.setup();
    const { onMute } = setup({ readOnly: true });
    await user.click(mute());
    expect(onMute).toHaveBeenCalledTimes(1);
  });
});

describe("TrackHeader forms", () => {
  it("is the avatar alone on a phone, still named, with the state as a badge", () => {
    const { container } = render(
      <TrackHeader {...base} form="phone" mute="saved" />,
    );
    expect(container.querySelector(".sys-track")).toHaveAttribute(
      "data-form",
      "phone",
    );
    expect(select()).toHaveAccessibleDescription("Muted in the mix");
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.queryByRole("button", { name: "Mute Maya" })).toBeNull();
    expect(container.querySelector(".sys-track-name")).toBeNull();
    expect(container.querySelector(".sys-track-badge")).not.toBeNull();
  });

  it("shows a headphones badge for a soloed phone track", () => {
    const { container } = render(<TrackHeader {...base} form="phone" solo />);
    expect(container.querySelector(".sys-track-badge svg")).not.toBeNull();
  });

  it("adds the meter in the wide form only", () => {
    const { container, rerender } = render(
      <TrackHeader {...base} form="wide" playing={0.4} />,
    );
    expect(container.querySelector(".sys-track-meter")).not.toBeNull();
    expect(
      container
        .querySelector<HTMLElement>(".sys-track")
        ?.style.getPropertyValue("--sys-track-level"),
    ).toBe("0.4");
    rerender(<TrackHeader {...base} form="default" />);
    expect(container.querySelector(".sys-track-meter")).toBeNull();
  });

  it("keeps the live level between 0 and 1", () => {
    const { container, rerender } = render(
      <TrackHeader {...base} playing={3} />,
    );
    const level = () =>
      container
        .querySelector<HTMLElement>(".sys-track")
        ?.style.getPropertyValue("--sys-track-level");
    expect(level()).toBe("1");
    rerender(<TrackHeader {...base} playing={-1} />);
    expect(level()).toBe("0");
  });

  it("marks a set track so its controls show without a hover", () => {
    const { container, rerender } = render(<TrackHeader {...base} level={0} />);
    const header = () => container.querySelector(".sys-track");
    expect(header()).not.toHaveAttribute("data-set");
    rerender(<TrackHeader {...base} level={0} solo />);
    expect(header()).toHaveAttribute("data-set", "true");
    rerender(<TrackHeader {...base} level={-3} />);
    expect(header()).toHaveAttribute("data-set", "true");
  });
});

describe("TrackHeader reordering", () => {
  it("moves the track with Shift and Up or Down, only with Shift, and keeps those keys from the window", async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    const seen = vi.fn();
    render(
      <div
        role="toolbar"
        aria-label="keymap"
        onKeyDown={(event) => event.key.startsWith("Arrow") && seen(event.key)}
      >
        <TrackHeader {...base} onMove={onMove} />
      </div>,
    );
    select().focus();
    await user.keyboard(
      "{ArrowUp}{Shift>}{ArrowUp}{ArrowDown}{ArrowLeft}{/Shift}",
    );
    expect(onMove.mock.calls).toEqual([
      ["track-1", -1],
      ["track-1", 1],
    ]);
    expect(seen.mock.calls).toEqual([["ArrowUp"], ["ArrowLeft"]]);
  });

  it("is draggable only when the host takes the drag, from the header and not from its controls", () => {
    const onDragStart = vi.fn();
    const { container, rerender } = render(<TrackHeader {...base} />);
    const header = () => container.querySelector<HTMLElement>(".sys-track");
    expect(header()).not.toHaveAttribute("draggable");
    rerender(<TrackHeader {...base} onDragStart={onDragStart} />);
    expect(header()).toHaveAttribute("draggable", "true");
    fireEvent.pointerDown(select());
    fireEvent.dragStart(select());
    fireEvent.pointerDown(header() as HTMLElement);
    fireEvent.dragStart(header() as HTMLElement);
    expect(onDragStart.mock.calls.map(([id]) => id)).toEqual([
      "track-1",
      "track-1",
    ]);
    fireEvent.pointerDown(mute());
    const refused = fireEvent.dragStart(header() as HTMLElement);
    fireEvent.pointerDown(screen.getByRole("spinbutton"));
    fireEvent.dragStart(header() as HTMLElement);
    expect(refused).toBe(false);
    expect(onDragStart).toHaveBeenCalledTimes(2);
  });

  it("marks the lifted header and the drop line", () => {
    const { container, rerender } = render(
      <TrackHeader {...base} reorder="lifted" />,
    );
    const header = () => container.querySelector(".sys-track");
    expect(header()).toHaveAttribute("data-reorder", "lifted");
    rerender(<TrackHeader {...base} reorder="after" />);
    expect(header()).toHaveAttribute("data-reorder", "after");
  });
});

describe("TrackHeader host attributes", () => {
  it("passes anchors to the header and to Mute and Solo", () => {
    const { container } = setup({
      anchorProps: {
        header: { "data-presence-anchor": "track:track-1" },
        mute: { "data-presence-anchor": "track-mute:track-1" },
        solo: { "data-presence-anchor": "track-solo:track-1" },
      },
    });
    expect(container.querySelector(".sys-track")).toHaveAttribute(
      "data-presence-anchor",
      "track:track-1",
    );
    expect(mute()).toHaveAttribute(
      "data-presence-anchor",
      "track-mute:track-1",
    );
    expect(solo()).toHaveAttribute(
      "data-presence-anchor",
      "track-solo:track-1",
    );
  });
});

describe("TrackHeader accessibility", () => {
  it("has no axe violations in any state", async () => {
    for (const over of [
      {},
      { form: "wide", playing: 0.5, solo: true },
      { form: "phone", mute: "saved" },
      { mute: "implied", rebuilding: true, selected: true },
      { readOnly: true, mute: "saved" },
    ] satisfies Partial<TrackHeaderProps>[]) {
      const { container, unmount } = setup(over);
      await expectNoA11yViolations(container);
      unmount();
    }
  });
});

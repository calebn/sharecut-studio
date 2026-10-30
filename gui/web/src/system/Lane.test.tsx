import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { Lane, LaneItem, type LaneProps } from "./Lane";

const base: LaneProps = {
  name: "Maya Okafor",
  colorIndex: 0,
  start: 2.5,
  pxPerSecond: 24,
  width: 360,
};

function setup(over: Partial<LaneProps> = {}, children?: React.ReactNode) {
  return render(
    <Lane {...base} {...over}>
      {children}
    </Lane>,
  );
}

const lane = () => screen.getByRole("group", { name: "Track Maya Okafor" });

describe("Lane", () => {
  it("is a group named for its track, never for all of them", () => {
    setup();
    expect(lane()).toBeVisible();
    expect(screen.queryByRole("group", { name: "Tracks" })).toBeNull();
  });

  it("is 72 px tall by default, and holds a height to 72 through 240", () => {
    const { rerender } = setup();
    expect(lane().style.getPropertyValue("--sys-lane-height")).toBe("72px");
    rerender(<Lane {...base} height={300} />);
    expect(lane().style.getPropertyValue("--sys-lane-height")).toBe("240px");
    rerender(<Lane {...base} height={60} />);
    expect(lane().style.getPropertyValue("--sys-lane-height")).toBe("72px");
    rerender(<Lane {...base} height={104} />);
    expect(lane().style.getPropertyValue("--sys-lane-height")).toBe("104px");
  });

  it("takes its width and its track colour from its props", () => {
    setup({ colorIndex: 3 });
    expect(lane().style.getPropertyValue("--sys-lane-width")).toBe("360px");
    expect(lane().style.getPropertyValue("--sys-lane-color")).toBe(
      "var(--color-presence-3)",
    );
  });

  it("carries the anchor attributes it is given", () => {
    setup({ anchorProps: { "data-presence-anchor": "track:maya" } });
    expect(lane()).toHaveAttribute("data-presence-anchor", "track:maya");
  });

  it("is busy with a flat line while peaks load, and not otherwise", () => {
    const { container, rerender } = setup({ loading: true });
    expect(lane()).toHaveAttribute("aria-busy", "true");
    expect(container.querySelector(".sys-lane-flat")).not.toBeNull();
    rerender(<Lane {...base} />);
    expect(lane()).not.toHaveAttribute("aria-busy");
    expect(container.querySelector(".sys-lane-flat")).toBeNull();
  });

  it("says why a silent lane is silent, in the header's words", () => {
    const { rerender } = setup({ mute: "saved" });
    expect(lane()).toHaveAccessibleDescription("Muted in the mix");
    rerender(<Lane {...base} mute="listen" />);
    expect(lane()).toHaveAccessibleDescription("Muted for you only");
    rerender(<Lane {...base} mute="implied" />);
    expect(lane()).toHaveAccessibleDescription(
      "Silent while another track is soloed",
    );
    rerender(<Lane {...base} mute="off" />);
    expect(lane()).not.toHaveAttribute("aria-describedby");
  });

  it("is no tab stop", () => {
    setup();
    expect(lane()).not.toHaveAttribute("tabindex");
  });

  it("has no axe violations", async () => {
    const { container } = setup(
      { mute: "saved", loading: true },
      <LaneItem at={12} duration={4}>
        <button type="button">Clip</button>
      </LaneItem>,
    );
    await expectNoA11yViolations(container);
  });
});

describe("LaneItem", () => {
  const item = (over: { at: number; duration: number }) => (
    <LaneItem {...over}>
      <span>clip</span>
    </LaneItem>
  );

  it("stands 228 px in and 96 px wide for 12 s + 4 s at 24 px/s from 2.5 s", () => {
    const { container } = setup({}, item({ at: 12, duration: 4 }));
    const box = container.querySelector<HTMLElement>(".sys-lane-item");
    expect(box?.style.getPropertyValue("--sys-lane-x")).toBe("228px");
    expect(box?.style.getPropertyValue("--sys-lane-w")).toBe("96px");
  });

  it("follows the window when the lane scrolls or zooms", () => {
    const { container, rerender } = setup({}, item({ at: 12, duration: 4 }));
    rerender(
      <Lane {...base} start={10} pxPerSecond={48}>
        {item({ at: 12, duration: 4 })}
      </Lane>,
    );
    const box = container.querySelector<HTMLElement>(".sys-lane-item");
    expect(box?.style.getPropertyValue("--sys-lane-x")).toBe("96px");
    expect(box?.style.getPropertyValue("--sys-lane-w")).toBe("192px");
  });

  it("draws nothing for a clip wholly outside the window", () => {
    const { container } = setup(
      {},
      <>
        {item({ at: 0, duration: 1 })}
        {item({ at: 100, duration: 4 })}
      </>,
    );
    expect(container.querySelector(".sys-lane-item")).toBeNull();
  });

  it("keeps a clip that began before the window but runs into it", () => {
    const { container } = setup({}, item({ at: 0, duration: 6 }));
    const box = container.querySelector<HTMLElement>(".sys-lane-item");
    expect(box?.style.getPropertyValue("--sys-lane-x")).toBe("-60px");
  });

  it("belongs inside a lane", () => {
    expect(() => render(item({ at: 0, duration: 1 }))).toThrow(
      "LaneItem belongs inside a Lane",
    );
  });
});

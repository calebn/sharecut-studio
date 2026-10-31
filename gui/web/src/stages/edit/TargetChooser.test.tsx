import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_ICON_NAMES } from "../../system/icons";
import { expectNoA11yViolations } from "../../test/a11y";
import { keymapHandoff, overlayOpen } from "../../ui/modalGate";
import {
  type ChooserKind,
  KIND_ICONS,
  KIND_NAMES,
  TARGET_ID_ATTR,
} from "./chooserKinds";
import {
  type ChooserTarget,
  TargetChooser,
  type TargetChooserProps,
} from "./TargetChooser";

const renders = vi.hoisted(() => ({ icons: 0 }));

vi.mock("../../system/SystemIcon", async (importActual) => {
  const actual = await importActual<typeof import("../../system/SystemIcon")>();
  return {
    ...actual,
    SystemIcon: (props: Parameters<typeof actual.SystemIcon>[0]) => {
      renders.icons += 1;
      return actual.SystemIcon(props);
    },
  };
});

const dir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(
  join(dir, "../../styles/partials/stage-edit.css"),
  "utf8",
);
const source = readFileSync(join(dir, "TargetChooser.tsx"), "utf8");

const bounds = { left: 0, top: 0, right: 600, bottom: 400 };
const clip: ChooserTarget = {
  id: "clip-1",
  kind: "clip",
  trackColorIndex: 0,
  label: "Maya take 2",
};
const comment: ChooserTarget = {
  id: "comment-1",
  kind: "comment",
  trackColorIndex: 3,
  label: "Check the level here",
};
const point: ChooserTarget = {
  id: "point-1",
  kind: "envelope-point",
  trackColorIndex: 11,
  label: "-3.0 dB",
};

function props(over: Partial<TargetChooserProps> = {}): TargetChooserProps {
  return {
    targets: [clip, comment, point],
    anchor: { x: 300, y: 300 },
    bounds,
    onPick: () => undefined,
    onCancel: () => undefined,
    ...over,
  };
}

const chips = () => screen.getAllByRole("menuitem");
const ids = () => chips().map((chip) => chip.getAttribute(TARGET_ID_ATTR));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TargetChooser chips", () => {
  it("is a menu of one menuitem button per target, in the order given", () => {
    render(<TargetChooser {...props()} />);
    expect(screen.getByRole("menu", { name: "Targets here, 3" })).toBeVisible();
    expect(ids()).toEqual(["clip-1", "comment-1", "point-1"]);
    for (const chip of chips()) {
      expect(chip.tagName).toBe("BUTTON");
      expect(chip).toHaveAttribute("type", "button");
      expect(chip).not.toHaveAttribute("aria-checked");
    }
    expect(screen.queryByRole("menuitemradio")).toBeNull();
  });

  it("names each chip for its kind and label", () => {
    render(<TargetChooser {...props()} />);
    expect(chips().map((chip) => chip.getAttribute("aria-label"))).toEqual([
      "Clip, Maya take 2",
      "Comment, Check the level here",
      "Envelope point, -3.0 dB",
    ]);
  });

  it("draws nothing for no target or one", () => {
    const { container, rerender } = render(
      <TargetChooser {...props({ targets: [] })} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<TargetChooser {...props({ targets: [clip] })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("draws two chips for two targets", () => {
    render(<TargetChooser {...props({ targets: [clip, comment] })} />);
    expect(chips()).toHaveLength(2);
  });

  it("draws five chips for six targets and leaves the sixth to the host's paging", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      ...clip,
      id: `t${i}`,
      label: `Take ${i}`,
    }));
    render(<TargetChooser {...props({ targets: six })} />);
    expect(ids()).toEqual(["t0", "t1", "t2", "t3", "t4"]);
    expect(
      screen.getByRole("menu", { name: "Targets here, showing 5 of 6" }),
    ).toBeVisible();
  });

  it("uses the data-target-id attribute, and never the legacy router's chooser or create attributes", () => {
    expect(TARGET_ID_ATTR).toBe("data-target-id");
    render(<TargetChooser {...props()} />);
    const menu = screen.getByRole("menu");
    expect(menu.querySelector("[data-chooser-item]")).toBeNull();
    expect(menu.querySelector("[data-create-item]")).toBeNull();
  });

  it("gives each kind its icon, and every one is a registered icon name", () => {
    const names = new Set<string>(SYSTEM_ICON_NAMES);
    expect(KIND_ICONS).toEqual({
      clip: "audio-waveform",
      seam: "blend",
      comment: "message-square",
      suggestion: "wand-sparkles",
      "envelope-point": "spline",
      word: "text-cursor-input",
    });
    for (const name of Object.values(KIND_ICONS)) {
      expect(names.has(name), name).toBe(true);
    }
    expect(KIND_NAMES).toEqual({
      clip: "Clip",
      seam: "Seam",
      comment: "Comment",
      suggestion: "Suggestion",
      "envelope-point": "Envelope point",
      word: "Word",
    });
    const kinds = Object.keys(KIND_ICONS) as ChooserKind[];
    const all: ChooserTarget[] = kinds.map((kind) => ({
      id: kind,
      kind,
      trackColorIndex: 0,
      label: kind,
    }));
    render(<TargetChooser {...props({ targets: all.slice(0, 5) })} />);
    for (const chip of chips()) {
      expect(chip.querySelector("svg")).not.toBeNull();
    }
  });

  it("rings each chip in its track's colour, wrapping past eight", () => {
    render(<TargetChooser {...props()} />);
    expect(
      chips().map((chip) => chip.style.getPropertyValue("--edit-chooser-ring")),
    ).toEqual([
      "var(--color-presence-0)",
      "var(--color-presence-3)",
      "var(--color-presence-3)",
    ]);
  });

  it("sets the fan from the layout: placement on the root and each chip at its centre", () => {
    render(<TargetChooser {...props()} />);
    const menu = screen.getByRole("menu");
    expect(menu).toHaveAttribute("data-placement", "above");
    expect(chips().map((chip) => [chip.style.left, chip.style.top])).toEqual([
      ["248px", "250px"],
      ["300px", "244px"],
      ["352px", "250px"],
    ]);
  });

  it("opens below the point near the top of the box", () => {
    render(<TargetChooser {...props({ anchor: { x: 300, y: 40 } })} />);
    expect(screen.getByRole("menu")).toHaveAttribute("data-placement", "below");
    expect(chips()[1].style.top).toBe("96px");
  });

  it("has no accessibility violations", async () => {
    const { container } = render(
      <TargetChooser {...props({ over: "comment-1" })} />,
    );
    await expectNoA11yViolations(container);
  });
});

describe("TargetChooser caption", () => {
  it("shows the label of the chip a finger is over, and only that one", () => {
    const { rerender, container } = render(<TargetChooser {...props()} />);
    expect(container.querySelector(".edit-target-chooser-caption")).toBeNull();
    rerender(<TargetChooser {...props({ over: "comment-1" })} />);
    const caption = container.querySelector(".edit-target-chooser-caption");
    expect(caption).toHaveTextContent("Check the level here");
    expect(caption).toHaveAttribute("aria-hidden", "true");
    rerender(<TargetChooser {...props({ over: "gone" })} />);
    expect(container.querySelector(".edit-target-chooser-caption")).toBeNull();
  });

  it("marks exactly the chip over, by id", () => {
    const { rerender } = render(
      <TargetChooser {...props({ over: "point-1" })} />,
    );
    expect(chips().map((chip) => chip.classList.contains("is-over"))).toEqual([
      false,
      false,
      true,
    ]);
    expect(chips().map((chip) => chip.hasAttribute("data-over"))).toEqual([
      false,
      false,
      true,
    ]);
    expect(chips()[2].getAttribute("data-over")).toBe("");
    rerender(<TargetChooser {...props({ over: null })} />);
    expect(screen.getByRole("menu").querySelector(".is-over")).toBeNull();
  });

  it("sits above the arc's middle (below it when the fan opens below)", () => {
    const { container, rerender } = render(<TargetChooser {...props()} />);
    const caption = () =>
      container.querySelector<HTMLElement>(".edit-target-chooser-caption");
    rerender(<TargetChooser {...props({ over: "clip-1" })} />);
    expect([caption()?.style.left, caption()?.style.top]).toEqual([
      "300px",
      "214px",
    ]);
  });
});

describe("TargetChooser picking", () => {
  it("reports the chip's id on a click", async () => {
    const onPick = vi.fn();
    render(<TargetChooser {...props({ onPick })} />);
    await userEvent.click(chips()[1]);
    expect(onPick.mock.calls).toEqual([["comment-1"]]);
  });
});

describe("TargetChooser keyboard and focus", () => {
  it("focuses the first chip, moves with Left, Right, Home and End, and wraps", async () => {
    const user = userEvent.setup();
    render(<TargetChooser {...props()} />);
    await waitFor(() => expect(chips()[0]).toHaveFocus());
    await user.keyboard("{ArrowRight}");
    expect(chips()[1]).toHaveFocus();
    await user.keyboard("{End}");
    expect(chips()[2]).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(chips()[0]).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(chips()[2]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(chips()[0]).toHaveFocus();
  });

  it("does not move on Up or Down: a fan has no vertical meaning", async () => {
    const user = userEvent.setup();
    render(<TargetChooser {...props()} />);
    await waitFor(() => expect(chips()[0]).toHaveFocus());
    await user.keyboard("{ArrowDown}{ArrowUp}");
    expect(chips()[0]).toHaveFocus();
  });

  it("picks the focused chip with Enter, and a Space after it is ignored", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<TargetChooser {...props({ onPick })} />);
    await waitFor(() => expect(chips()[0]).toHaveFocus());
    await user.keyboard("{ArrowRight}{Enter}");
    await user.keyboard(" ");
    expect(onPick.mock.calls).toEqual([["comment-1"]]);
  });

  it("picks once per open: a second activation after the first does nothing", async () => {
    const onPick = vi.fn();
    render(<TargetChooser {...props({ onPick })} />);
    await userEvent.click(chips()[0]);
    await userEvent.click(chips()[1]);
    expect(onPick.mock.calls).toEqual([["clip-1"]]);
  });

  it("cancels on Escape", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<TargetChooser {...props({ onCancel })} />);
    await waitFor(() => expect(chips()[0]).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("cancels when focus leaves the fan (Tab), and not for focus moving between chips", () => {
    const onCancel = vi.fn();
    render(
      <>
        <TargetChooser {...props({ onCancel })} />
        <button type="button">Outside</button>
      </>,
    );
    fireEvent.blur(chips()[0], { relatedTarget: chips()[1] });
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.blur(chips()[1], {
      relatedTarget: screen.getByRole("button", { name: "Outside" }),
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("returns focus to where it was when it closes", async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Opener
          </button>
          {open ? (
            <TargetChooser {...props({ onCancel: () => setOpen(false) })} />
          ) : null}
        </>
      );
    }
    const user = userEvent.setup();
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(chips()[0]).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("holds the keymap while open and lets go of it exactly once it closes", () => {
    const { rerender, unmount } = render(<TargetChooser {...props()} />);
    expect(overlayOpen()).toBe(true);
    expect(keymapHandoff()).toEqual([]);
    rerender(<TargetChooser {...props({ targets: [clip] })} />);
    expect(overlayOpen()).toBe(false);
    expect(keymapHandoff()).toBeNull();
    rerender(<TargetChooser {...props()} />);
    expect(overlayOpen()).toBe(true);
    unmount();
    expect(overlayOpen()).toBe(false);
    expect(keymapHandoff()).toBeNull();
  });

  it("stays open when its targets change while focus is inside it", async () => {
    const onCancel = vi.fn();
    const { rerender } = render(<TargetChooser {...props({ onCancel })} />);
    await waitFor(() => expect(chips()[0]).toHaveFocus());
    rerender(
      <TargetChooser {...props({ onCancel, targets: [clip, comment] })} />,
    );
    expect(chips()).toHaveLength(2);
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("TargetChooser owns no gesture", () => {
  it("has no pointer, touch or key handler, window listener, capture or press library", () => {
    expect(source).not.toMatch(/onPointer|onTouch|onKeyDown|onMouse/);
    expect(source).not.toMatch(/addEventListener|setPointerCapture/);
    expect(source).not.toMatch(/@react-aria|usePress|createPortal/);
    expect(source).not.toMatch(/noteMenuOpen/);
    expect(source).not.toMatch(/from "\.\.\/\.\.\/timeline/);
    expect(source).not.toMatch(/ArrowLeft|ArrowRight/);
  });
});

describe("TargetChooser sizes", () => {
  it("draws chips as 44 px circles (the touch minimum) with a 3 px ring (0.1875 rem)", () => {
    expect(css).toMatch(
      /\.edit-target-chooser \{\s*--edit-chooser-ring-width: 0\.1875rem;/,
    );
    expect(css).toMatch(
      /\.edit-target-chooser-chip \{[^}]*inline-size: var\(--touch-min\);[^}]*block-size: var\(--touch-min\);/,
    );
    expect(css).toMatch(
      /\.edit-target-chooser-chip \{[^}]*border: var\(--edit-chooser-ring-width\) solid var\(--edit-chooser-ring\);[^}]*border-radius: 50%;/,
    );
  });

  it("ellipsizes a long caption inside 15 rem", () => {
    expect(css).toMatch(
      /\.edit-target-chooser-caption \{[^}]*max-inline-size: 15rem;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/,
    );
  });

  it("sits in the box it is mounted in: no fixed position, popover or portal, and no motion", () => {
    const { container } = render(<TargetChooser {...props()} />);
    expect(container.querySelector(".edit-target-chooser")).not.toBeNull();
    expect(screen.getByRole("menu").closest("[popover]")).toBeNull();
    const block = css
      .slice(css.indexOf("/* Target chooser"))
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(block).not.toMatch(/position:\s*fixed/);
    expect(block).not.toMatch(/transition|animation/);
    expect(block).not.toMatch(/\d\s*px\b/);
  });

  it("outlines the chip under a finger in the system highlight under forced colours", () => {
    expect(css).toMatch(
      /@media \(forced-colors: active\) \{\s*\.edit-target-chooser \{\s*--edit-chooser-ink: Highlight;\s*\}\s*\.edit-target-chooser-chip\.is-over \{\s*outline: var\(--focus-ring-width\) solid var\(--edit-chooser-ink\);/,
    );
  });
});

describe("TargetChooser in a parent that renders again", () => {
  const noop = () => undefined;
  const anchor = { x: 300, y: 300 };
  const targets = [clip, comment, point];

  function Parent() {
    const [, setTick] = useState(0);
    return (
      <>
        <button type="button" onClick={() => setTick((n) => n + 1)}>
          Unrelated
        </button>
        <TargetChooser
          targets={targets}
          anchor={anchor}
          bounds={bounds}
          onPick={noop}
          onCancel={noop}
        />
      </>
    );
  }

  it("does not draw its chips again for an unrelated parent render", () => {
    renders.icons = 0;
    render(<Parent />);
    const first = renders.icons;
    expect(first).toBeGreaterThanOrEqual(3);
    fireEvent.click(screen.getByRole("button", { name: "Unrelated" }));
    expect(renders.icons).toBe(first);
  });
});

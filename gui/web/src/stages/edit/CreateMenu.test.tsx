import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import {
  CREATE_ITEM_ATTR,
  CreateMenu,
  type CreateMenuProps,
} from "./CreateMenu";
import { type CreateFacts, createMenuRows } from "./createMenuRows";

const renders = vi.hoisted(() => ({ rows: 0 }));

vi.mock("./createMenuRows", async (importActual) => {
  const actual = await importActual<typeof import("./createMenuRows")>();
  return {
    ...actual,
    // Only a drawn row asks for its key caps.
    rowShortcut: (...args: Parameters<typeof actual.rowShortcut>) => {
      renders.rows += 1;
      return actual.rowShortcut(...args);
    },
  };
});

const dir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(
  join(dir, "../../styles/partials/stage-edit.css"),
  "utf8",
);
const hitRouting = readFileSync(
  join(dir, "../../timeline/hitRouting.ts"),
  "utf8",
);

const LANE: CreateFacts = {
  lane: true,
  envelopeShown: true,
  clipboardHasAudio: false,
};
const bounds = { left: 0, top: 0, right: 600, bottom: 400 };

function props(over: Partial<CreateMenuProps> = {}): CreateMenuProps {
  return {
    rows: createMenuRows(LANE),
    time: "12:04.3",
    track: "Maya",
    anchor: { x: 300, y: 300 },
    bounds,
    onPick: () => undefined,
    onClose: () => undefined,
    ...over,
  };
}

const menu = () =>
  screen.getByRole("menu", { name: "Create at 12:04.3 · Maya" });
const labels = () =>
  screen.getAllByRole("menuitem").map((el) => el.textContent ?? "");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CreateMenu rows", () => {
  it("is a menu named for the held time and track, with its rows as menuitems", () => {
    render(<CreateMenu {...props()} />);
    expect(menu()).toBeVisible();
    expect(screen.getAllByRole("menuitem")).toHaveLength(4);
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    expect(menu().querySelector("[aria-checked]")).toBeNull();
  });

  it("heads the menu with the time and track, and the time alone off a lane", () => {
    const { container, rerender } = render(<CreateMenu {...props()} />);
    expect(
      container.querySelector(".edit-create-menu-title"),
    ).toHaveTextContent("12:04.3 · Maya");
    rerender(<CreateMenu {...props({ track: null })} />);
    expect(
      container.querySelector(".edit-create-menu-title")?.textContent,
    ).toBe("12:04.3");
    expect(
      screen.getByRole("menu", { name: "Create at 12:04.3" }),
    ).toBeVisible();
  });

  it("shows the rows in the spec's order with their first chord as key caps", () => {
    render(<CreateMenu {...props()} />);
    expect(labels()).toEqual([
      "Split hereS",
      "Comment hereC",
      "Add chapter here⇧ C",
      "Add volume point",
    ]);
  });

  it("leaves a row out when it does not apply, and has no disabled row", () => {
    const { rerender } = render(
      <CreateMenu
        {...props({
          rows: createMenuRows({ ...LANE, envelopeShown: false }),
        })}
      />,
    );
    expect(screen.queryByRole("menuitem", { name: /volume/ })).toBeNull();
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
    rerender(
      <CreateMenu
        {...props({
          rows: createMenuRows({ ...LANE, lane: false }),
          track: null,
        })}
      />,
    );
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
    for (const row of screen.getAllByRole("menuitem")) {
      expect(row).not.toHaveAttribute("aria-disabled");
    }
  });

  it("offers Paste only when the clipboard has audio", () => {
    const { rerender } = render(<CreateMenu {...props()} />);
    expect(screen.queryByRole("menuitem", { name: /Paste/ })).toBeNull();
    rerender(
      <CreateMenu
        {...props({
          rows: createMenuRows({ ...LANE, clipboardHasAudio: true }),
        })}
      />,
    );
    expect(labels().at(-1)).toBe("Paste");
  });

  it("separates the lane's row from the rows for the whole point", () => {
    const { container } = render(<CreateMenu {...props()} />);
    const separators = container.querySelectorAll("hr");
    expect(separators).toHaveLength(1);
    expect(separators[0]?.nextElementSibling).toHaveTextContent(
      "Add volume point",
    );
  });

  it("announces every chord of a row to assistive tech, and hides the caps", () => {
    render(<CreateMenu {...props()} />);
    const split = screen.getByRole("menuitem", { name: /Split here/ });
    expect(split.getAttribute("aria-keyshortcuts")).toMatch(
      /^S (Control|Meta)\+K$/,
    );
    expect(split.querySelector("kbd")).toHaveAttribute("aria-hidden", "true");
    expect(
      screen
        .getByRole("menuitem", { name: /Add chapter here/ })
        .getAttribute("aria-keyshortcuts"),
    ).toBe("Shift+C");
    expect(
      screen
        .getByRole("menuitem", { name: /Add volume point/ })
        .getAttribute("aria-keyshortcuts"),
    ).toBeNull();
  });

  it("gives each row its icon", () => {
    render(
      <CreateMenu
        {...props({
          rows: createMenuRows({ ...LANE, clipboardHasAudio: true }),
        })}
      />,
    );
    for (const row of screen.getAllByRole("menuitem")) {
      expect(row.querySelector("svg")).not.toBeNull();
    }
  });

  it("has no accessibility violations", async () => {
    const { container } = render(
      <CreateMenu
        {...props({
          rows: createMenuRows({ ...LANE, clipboardHasAudio: true }),
        })}
      />,
    );
    await expectNoA11yViolations(container);
  });
});

describe("CreateMenu row note", () => {
  const NOTE = "Cuts at this time, not the playhead";
  const noted = () =>
    createMenuRows(LANE).map((row) =>
      row.id === "split" ? { ...row, note: NOTE } : row,
    );

  it("exposes a note as the item's description and tooltip, not its name or its text", () => {
    render(<CreateMenu {...props({ rows: noted() })} />);
    const split = screen.getByRole("menuitem", { name: "Split here" });
    expect(split).toHaveAttribute("aria-description", NOTE);
    expect(split).toHaveAttribute("title", NOTE);
    expect(split.textContent).not.toContain(NOTE);
    expect(
      screen.getByRole("menuitem", { name: "Comment here" }),
    ).not.toHaveAttribute("aria-description");
  });

  it("does the same in the phone Sheet", async () => {
    render(<CreateMenu {...props({ phone: true, rows: noted() })} />);
    const split = await screen.findByRole("button", { name: "Split here" });
    expect(split).toHaveAttribute("aria-description", NOTE);
    expect(split).toHaveAttribute("title", NOTE);
    expect(split.textContent).toBe("Split here");
  });
});

describe("CreateMenu sizes", () => {
  it("is 220 px wide (13.75 rem), with 36 px rows and 44 px rows under a coarse pointer", () => {
    expect(css).toMatch(
      /\.ui-menu-panel\.edit-create-menu \{\s*--menu-item-min-block-size: 2\.25rem;[^}]*inline-size: 13\.75rem;/,
    );
    expect(css).toMatch(
      /@media \(pointer: coarse\) \{\s*\.ui-menu-panel\.edit-create-menu \{\s*--menu-item-min-block-size: var\(--touch-min\);/,
    );
  });

  it("has a 32 px header", () => {
    expect(css).toMatch(
      /\.edit-create-menu-title \{[^}]*block-size: var\(--control-height\);/,
    );
  });

  it("uses no fixed position, popover or portal: it sits in the box it is mounted in", () => {
    const { container } = render(<CreateMenu {...props()} />);
    expect(container.querySelector(".edit-create-layer")).not.toBeNull();
    expect(menu().closest("[popover]")).toBeNull();
    const block = css.slice(css.indexOf("/* Create here menu"));
    expect(block).not.toMatch(/position:\s*fixed/);
  });
});

describe("CreateMenu placement", () => {
  const size = (width: number, height: number) => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(
      width,
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(
      height,
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
      height,
    );
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      height,
    );
  };

  it("sits above the held point, 24 px clear of it", () => {
    size(220, 200);
    render(<CreateMenu {...props()} />);
    expect(menu()).toHaveAttribute("data-placement", "above");
    expect(menu().style.left).toBe("190px");
    expect(menu().style.top).toBe("76px");
  });

  it("flips below the point near the top of the box and clamps at the side edge", () => {
    size(220, 200);
    render(<CreateMenu {...props({ anchor: { x: 590, y: 40 } })} />);
    expect(menu()).toHaveAttribute("data-placement", "below");
    expect(menu().style.top).toBe("64px");
    expect(menu().style.left).toBe("364px");
  });

  it("goes beside the point when neither above nor below has room", () => {
    size(220, 200);
    render(
      <CreateMenu
        {...props({
          anchor: { x: 300, y: 150 },
          bounds: { left: 0, top: 0, right: 600, bottom: 300 },
        })}
      />,
    );
    expect(menu()).toHaveAttribute("data-placement", "right");
    expect(menu().style.left).toBe("324px");
    expect(menu().style.top).toBe("50px");
  });

  it("stays clear of the fixed playhead", () => {
    size(220, 200);
    render(
      <CreateMenu {...props({ anchor: { x: 300, y: 300 }, avoidX: 290 })} />,
    );
    expect(menu().style.left).toBe("298px");
  });

  it("caps its height and scrolls when no room is tall enough", () => {
    size(220, 500);
    render(
      <CreateMenu
        {...props({
          bounds: { left: 0, top: 0, right: 600, bottom: 200 },
          anchor: { x: 300, y: 100 },
        })}
      />,
    );
    expect(menu()).toHaveAttribute("data-scrolls");
    expect(menu().style.maxBlockSize).toBe("168px");
  });
});

describe("CreateMenu picking", () => {
  it("reports the row's id on a click", async () => {
    const onPick = vi.fn();
    render(<CreateMenu {...props({ onPick })} />);
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Comment here/ }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Add volume point/ }),
    );
    expect(onPick.mock.calls).toEqual([["comment"], ["addVolumePoint"]]);
  });

  it("marks the row a sliding finger is over, and no other", () => {
    const { rerender } = render(<CreateMenu {...props({ over: 1 })} />);
    const rows = screen.getAllByRole("menuitem");
    expect(rows.map((row) => row.classList.contains("is-over"))).toEqual([
      false,
      true,
      false,
      false,
    ]);
    rerender(<CreateMenu {...props({ over: null })} />);
    expect(menu().querySelector(".is-over")).toBeNull();
  });

  it("gives each row its index in the attribute the hit router reads, which the router names the same", () => {
    expect(CREATE_ITEM_ATTR).toBe("data-create-item");
    expect(hitRouting).toContain(
      `export const CREATE_ITEM_ATTR = "${CREATE_ITEM_ATTR}";`,
    );
    render(<CreateMenu {...props()} />);
    expect(
      screen
        .getAllByRole("menuitem")
        .map((row) => row.getAttribute(CREATE_ITEM_ATTR)),
    ).toEqual(["0", "1", "2", "3"]);
  });

  it("never claims the router's chooser attribute", () => {
    render(<CreateMenu {...props()} />);
    expect(menu().querySelector("[data-chooser-item]")).toBeNull();
  });
});

describe("CreateMenu keyboard and focus", () => {
  it("focuses the first row, moves between rows with the arrows, Home and End, and wraps", async () => {
    const user = userEvent.setup();
    render(<CreateMenu {...props()} />);
    const rows = screen.getAllByRole("menuitem");
    await waitFor(() => expect(rows[0]).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(rows[1]).toHaveFocus();
    await user.keyboard("{End}");
    expect(rows[3]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(rows[0]).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(rows[3]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(rows[0]).toHaveFocus();
  });

  it("picks the focused row with Enter and Space", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<CreateMenu {...props({ onPick })} />);
    await waitFor(() =>
      expect(screen.getAllByRole("menuitem")[0]).toHaveFocus(),
    );
    await user.keyboard("{ArrowDown}{Enter}");
    await user.keyboard(" ");
    expect(onPick.mock.calls).toEqual([["comment"], ["comment"]]);
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<CreateMenu {...props({ onClose })} />);
    await waitFor(() =>
      expect(screen.getAllByRole("menuitem")[0]).toHaveFocus(),
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when focus leaves the menu (Tab), and not for focus moving between its rows", async () => {
    const onClose = vi.fn();
    render(
      <>
        <CreateMenu {...props({ onClose })} />
        <button type="button">Outside</button>
      </>,
    );
    const rows = screen.getAllByRole("menuitem");
    fireEvent.blur(rows[0] as HTMLElement, { relatedTarget: rows[1] });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.blur(rows[1] as HTMLElement, {
      relatedTarget: screen.getByRole("button", { name: "Outside" }),
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open when its rows change while focus is inside it", async () => {
    const onClose = vi.fn();
    const { rerender } = render(<CreateMenu {...props({ onClose })} />);
    await waitFor(() =>
      expect(screen.getAllByRole("menuitem")[0]).toHaveFocus(),
    );
    rerender(
      <CreateMenu
        {...props({
          onClose,
          rows: createMenuRows({ ...LANE, clipboardHasAudio: true }),
        })}
      />,
    );
    expect(screen.getAllByRole("menuitem")).toHaveLength(
      createMenuRows({ ...LANE, clipboardHasAudio: true }).length,
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
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
            <CreateMenu {...props({ onClose: () => setOpen(false) })} />
          ) : null}
        </>
      );
    }
    const user = userEvent.setup();
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getAllByRole("menuitem")[0]).toHaveFocus(),
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(opener).toHaveFocus();
  });
});

describe("CreateMenu phone form", () => {
  it("is the same rows in a content-height Sheet, as buttons", async () => {
    const onPick = vi.fn();
    render(
      <CreateMenu
        {...props({
          phone: true,
          onPick,
          rows: createMenuRows({ ...LANE, clipboardHasAudio: true }),
        })}
      />,
    );
    const dialog = await screen.findByRole("dialog", {
      name: "12:04.3 · Maya",
    });
    expect(dialog.className).toContain("bottom-sheet--fit");
    expect(
      dialog.querySelector('[role="slider"], .bottom-sheet-grabber'),
    ).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    const rows = Array.from(
      dialog.querySelectorAll<HTMLElement>(".sys-row-btn"),
    );
    expect(rows.map((row) => row.textContent)).toEqual([
      "Split here",
      "Comment here",
      "Add chapter here",
      "Add volume point",
      "Paste",
    ]);
    expect(rows.map((row) => row.getAttribute(CREATE_ITEM_ATTR))).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
    ]);
    fireEvent.click(rows[4] as HTMLElement);
    expect(onPick).toHaveBeenCalledWith("paste");
  });

  it("leaves out the rows that do not apply, as the popover does", async () => {
    render(
      <CreateMenu
        {...props({
          phone: true,
          rows: createMenuRows({ ...LANE, lane: false }),
          track: null,
        })}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: "12:04.3" });
    expect(dialog.querySelectorAll(".sys-row-btn")).toHaveLength(3);
  });
});

describe("CreateMenu in a parent that renders again", () => {
  const noop = () => undefined;
  const anchor = { x: 300, y: 300 };

  function Parent() {
    const [, setTick] = useState(0);
    const [rows] = useState(() => createMenuRows(LANE));
    return (
      <>
        <button type="button" onClick={() => setTick((n) => n + 1)}>
          Unrelated
        </button>
        <CreateMenu
          rows={rows}
          time="12:04.3"
          track="Maya"
          anchor={anchor}
          bounds={bounds}
          onPick={noop}
          onClose={noop}
        />
      </>
    );
  }

  it("does not draw its rows again for an unrelated parent render", () => {
    renders.rows = 0;
    render(<Parent />);
    const first = renders.rows;
    expect(first).toBeGreaterThanOrEqual(4);
    fireEvent.click(screen.getByRole("button", { name: "Unrelated" }));
    expect(renders.rows).toBe(first);
  });
});

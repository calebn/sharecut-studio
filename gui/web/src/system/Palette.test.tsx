import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Palette, type PaletteItem } from "./Palette";
import { verbPaletteItems } from "./paletteItems";
import { resultGroups } from "./paletteResults";

const items: PaletteItem[] = [
  { id: "a", group: "Commands", label: "Cut", context: "Action bar" },
  { id: "b", group: "Commands", label: "Mute" },
  { id: "c", group: "Stages", label: "Go to Review" },
  { id: "d", group: "People", label: "Rosa Diaz", context: "Follow" },
];

describe("resultGroups", () => {
  it("groups in the fixed order and drops empty groups", () => {
    expect(resultGroups(items, "").map((g) => g.name)).toEqual([
      "Commands",
      "Stages",
      "People",
    ]);
  });

  it("matches the label or the context, ignoring case and padding", () => {
    expect(
      resultGroups(items, "  FOLLOW ").flatMap((g) => g.items.map((i) => i.id)),
    ).toEqual(["d"]);
    expect(
      resultGroups(items, "cut").flatMap((g) => g.items.map((i) => i.id)),
    ).toEqual(["a"]);
  });

  it("shows only Recent for an empty query, in the order given", () => {
    const groups = resultGroups(items, "", ["d", "a"]);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("Recent");
    expect(groups[0].items.map((i) => i.id)).toEqual(["d", "a"]);
  });

  it("falls back to every group when no recent id exists any more", () => {
    expect(resultGroups(items, "", ["gone"]).map((g) => g.name)).toEqual([
      "Commands",
      "Stages",
      "People",
    ]);
  });

  it("ignores Recent once there is a query", () => {
    const groups = resultGroups(items, "mute", ["d"]);
    expect(groups.map((g) => g.name)).toEqual(["Commands"]);
  });
});

describe("Palette", () => {
  it("filters as you type and says when nothing matches", async () => {
    const user = userEvent.setup();
    render(<Palette items={items} />);
    expect(screen.getAllByRole("option")).toHaveLength(4);
    const search = screen.getByRole("combobox", { name: "Search commands" });
    await user.type(search, "mu");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await user.type(search, "zz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("moves the active row with the arrows, wrapping, and runs it on Enter", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    render(<Palette items={items} onRun={onRun} />);
    const search = screen.getByRole("combobox");
    expect(search).toHaveAttribute(
      "aria-activedescendant",
      screen.getAllByRole("option")[0].id,
    );
    await user.type(search, "{ArrowUp}");
    expect(screen.getAllByRole("option")[3]).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.type(search, "{ArrowDown}{ArrowDown}{Enter}");
    expect(onRun).toHaveBeenCalledWith(items[1]);
  });

  it("makes the hovered row the active one", async () => {
    const user = userEvent.setup();
    render(<Palette items={items} />);
    const rows = screen.getAllByRole("option");
    await user.hover(rows[2]);
    expect(rows[2]).toHaveAttribute("aria-selected", "true");
  });

  it("runs a row on click and closes on Escape", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    const onClose = vi.fn();
    render(<Palette items={items} onRun={onRun} onClose={onClose} />);
    await user.click(screen.getByRole("option", { name: /Go to Review/ }));
    expect(onRun).toHaveBeenCalledWith(items[2]);
    await user.type(screen.getByRole("combobox"), "{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("lists key-less verbs and each stage once", () => {
    const list = verbPaletteItems();
    const labels = list.map((item) => item.label);
    expect(labels).toContain("Invite");
    expect(labels).toContain("Copy link");
    expect(labels).not.toContain("Go to stage");
    expect(labels.filter((label) => label === "Go to Review")).toHaveLength(1);
    expect(new Set(list.map((item) => item.id)).size).toBe(list.length);
  });

  it("writes a context as a sentence", () => {
    const cut = verbPaletteItems().find((item) => item.id === "verb:cut");
    expect(cut?.context).toBe("Action bar");
  });
});

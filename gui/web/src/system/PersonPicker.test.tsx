import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PersonPicker } from "./PersonPicker";
import { ALIKE, PEOPLE } from "./prepareFixtures";

describe("PersonPicker", () => {
  it("is a radiogroup named by the question, with one native radio per person", () => {
    render(<PersonPicker people={PEOPLE} onPick={vi.fn()} />);
    const group = screen.getByRole("radiogroup", {
      name: "Who is this voice?",
    });
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(PEOPLE.length);
    for (const radio of radios) {
      expect(radio.tagName).toBe("INPUT");
      expect(group).toContainElement(radio);
    }
    expect(
      new Set(radios.map((radio) => radio.getAttribute("name"))).size,
    ).toBe(1);
  });

  it("marks the current person and picks on click", async () => {
    const onPick = vi.fn();
    render(<PersonPicker people={PEOPLE} currentId="joss" onPick={onPick} />);
    expect(screen.getByRole("radio", { name: /^Joss/ })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: /^Maya/ }));
    expect(onPick).toHaveBeenCalledWith("maya");
  });

  it("moves with the arrow keys the browser gives radios", async () => {
    const onPick = vi.fn();
    render(<PersonPicker people={PEOPLE} currentId="maya" onPick={onPick} />);
    await userEvent.tab();
    expect(screen.getByRole("radio", { name: /^Maya/ })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(onPick).toHaveBeenLastCalledWith("anneke");
  });

  it("keeps Fix text beside the radio, not inside it", async () => {
    const onRename = vi.fn();
    render(
      <PersonPicker people={PEOPLE} onPick={vi.fn()} onRename={onRename} />,
    );
    const fixes = screen.getAllByRole("button", { name: /^Fix text/ });
    expect(fixes).toHaveLength(PEOPLE.length);
    for (const fix of fixes) {
      expect(fix.closest("label")).toBeNull();
    }
    await userEvent.click(fixes[1]);
    expect(onRename).toHaveBeenCalledWith("anneke");
  });

  it("offers no Fix text without a handler", () => {
    render(<PersonPicker people={PEOPLE} onPick={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("tells two people with the same name apart and keys them by id", async () => {
    const onPick = vi.fn();
    render(<PersonPicker people={ALIKE} currentId="sam-a" onPick={onPick} />);
    const [first, second] = screen.getAllByRole("radio", { name: /^Sam/ });
    expect(first).toHaveAccessibleName(/Track 1/);
    expect(second).toHaveAccessibleName(/Track 2/);
    expect(first).toBeChecked();
    await userEvent.click(second);
    expect(onPick).toHaveBeenCalledWith("sam-b");
  });
});

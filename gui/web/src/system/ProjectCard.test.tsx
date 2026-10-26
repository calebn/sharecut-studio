import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectCardList } from "./ProjectCard";
import { MISSING, PROJECTS } from "./projectCardFixtures";

function setup(projects = PROJECTS) {
  const onOpen = vi.fn();
  const onFind = vi.fn();
  render(
    <ProjectCardList
      projects={projects}
      label="Recent episodes"
      onOpen={onOpen}
      onFind={onFind}
    />,
  );
  const cards = projects.map((project) =>
    screen.getByRole("button", { name: project.name }),
  );
  return { cards, onOpen, onFind, user: userEvent.setup() };
}

describe("ProjectCardList", () => {
  it("has one tab stop, on the first card", () => {
    const { cards } = setup();
    expect(cards.map((card) => card.tabIndex)).toEqual([0, -1, -1, -1]);
  });

  it("moves with arrows in list order and does not wrap", async () => {
    const { cards, user } = setup();
    await user.tab();
    expect(cards[0]).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(cards[1]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(cards[2]).toHaveFocus();
    await user.keyboard("{ArrowLeft}{ArrowUp}{ArrowUp}");
    expect(cards[0]).toHaveFocus();
    expect(cards.map((card) => card.tabIndex)).toEqual([0, -1, -1, -1]);
  });

  it("jumps with Home and End and moves the tab stop", async () => {
    const { cards, user } = setup();
    await user.tab();
    await user.keyboard("{End}");
    expect(cards[3]).toHaveFocus();
    expect(cards.map((card) => card.tabIndex)).toEqual([-1, -1, -1, 0]);
    await user.keyboard("{Home}");
    expect(cards[0]).toHaveFocus();
  });

  it("opens with Enter and Space at the stage the chip names", async () => {
    const { cards, onOpen, user } = setup();
    await user.tab();
    await user.keyboard("{ArrowRight}{Enter}");
    expect(onOpen).toHaveBeenLastCalledWith("garden", "prepare");
    cards[2].focus();
    await user.keyboard(" ");
    expect(onOpen).toHaveBeenLastCalledWith("audit", "edit");
  });

  it("describes a card by its meta and chip", () => {
    const { cards } = setup();
    expect(cards[0]).toHaveAccessibleDescription(
      /52:10 · edited 2 h ago.*Review 6/,
    );
  });

  it("rings the first card without giving it focus", () => {
    const { cards } = setup();
    const ring = document.querySelectorAll("[data-primary]");
    expect(ring).toHaveLength(1);
    expect(ring[0]).toContainElement(cards[0]);
    expect(document.body).toHaveFocus();
    expect(cards[1].tabIndex).toBe(-1);
  });

  it("offers Find beside a missing folder and does not open", async () => {
    const { onOpen, onFind, user } = setup([PROJECTS[0], MISSING]);
    const card = screen.getByRole("button", { name: MISSING.name });
    expect(card).toHaveAttribute("aria-disabled", "true");
    await user.click(
      screen.getByRole("button", { name: `Find ${MISSING.name}` }),
    );
    expect(onFind).toHaveBeenCalledWith("moved");
    await user.click(card);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

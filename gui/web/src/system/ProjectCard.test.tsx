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
    screen.getByRole("button", { name: new RegExp(`^${project.name}`) }),
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

  it.each(["Alt", "Control", "Meta", "Shift"])(
    "leaves %s+arrow to the browser (Alt+Left is Back)",
    async (modifier) => {
      const { cards, user } = setup();
      await user.tab();
      const seen = vi.fn();
      const watch = (event: KeyboardEvent) => {
        if (event.key === "ArrowRight") seen(event.defaultPrevented);
      };
      document.addEventListener("keydown", watch);
      await user.keyboard(`{${modifier}>}{ArrowRight}{/${modifier}}`);
      document.removeEventListener("keydown", watch);
      expect(seen).toHaveBeenLastCalledWith(false);
      expect(cards[0]).toHaveFocus();
    },
  );

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

  it("names a card by its visible name, meta and chip", () => {
    const { cards } = setup();
    expect(cards[0]).toHaveAccessibleName(/52:10 · edited 2 h ago.*Review 6/);
  });

  it("marks no card until one has focus, so the ring means focus only", () => {
    const { cards } = setup();
    expect(document.body).toHaveFocus();
    expect(
      document.querySelectorAll("[data-primary], [data-busy]"),
    ).toHaveLength(0);
    expect(cards[1].tabIndex).toBe(-1);
  });

  it("marks only the card being opened as busy", () => {
    render(
      <ProjectCardList
        projects={PROJECTS}
        label="Recent episodes"
        busyId={PROJECTS[1].id}
        onOpen={vi.fn()}
      />,
    );
    const busy = screen
      .getAllByRole("button")
      .filter((card) => card.getAttribute("aria-busy") === "true");
    expect(busy).toHaveLength(1);
    expect(busy[0]).toHaveAccessibleName(new RegExp(`^${PROJECTS[1].name}`));
    expect(busy[0].closest(".sys-project")).toHaveAttribute(
      "data-busy",
      "true",
    );
  });

  it("offers Find beside a missing folder and does not open", async () => {
    const { onOpen, onFind, user } = setup([PROJECTS[0], MISSING]);
    const card = screen.getByRole("button", {
      name: new RegExp(`^${MISSING.name}`),
    });
    expect(card).toHaveAttribute("aria-disabled", "true");
    await user.click(
      screen.getByRole("button", { name: `Find ${MISSING.name}` }),
    );
    expect(onFind).toHaveBeenCalledWith("moved");
    await user.click(card);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("leaves a Find button with the arrow keys like its card", async () => {
    const { cards, user } = setup([PROJECTS[0], MISSING, PROJECTS[1]]);
    const find = screen.getByRole("button", { name: `Find ${MISSING.name}` });
    await user.tab();
    await user.tab();
    expect(find).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(cards[2]).toHaveFocus();
    find.focus();
    await user.keyboard("{ArrowLeft}");
    expect(cards[0]).toHaveFocus();
  });

  it("keeps the tab stop on the same card when a card is added before it", async () => {
    const user = userEvent.setup();
    const props = { label: "Recent episodes", onOpen: vi.fn() };
    const { rerender } = render(
      <ProjectCardList projects={PROJECTS.slice(1)} {...props} />,
    );
    await user.tab();
    const focused = document.activeElement;
    rerender(<ProjectCardList projects={PROJECTS} {...props} />);
    expect(focused).toHaveAttribute("tabindex", "0");
  });
});

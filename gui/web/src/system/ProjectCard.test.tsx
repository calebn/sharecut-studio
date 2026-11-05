import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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

  it.each([
    ["Alt", { altKey: true }],
    ["Control", { ctrlKey: true }],
    ["Meta", { metaKey: true }],
    ["Shift", { shiftKey: true }],
  ])("leaves %s+arrow to the browser (Alt+Left is Back)", async (_, mods) => {
    const { cards, user } = setup();
    await user.tab();
    // fireEvent returns false when a handler cancelled the event.
    const notCancelled = fireEvent.keyDown(cards[0], {
      key: "ArrowRight",
      ...mods,
    });
    expect(notCancelled).toBe(true);
    expect(cards[0]).toHaveFocus();
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

describe("ProjectCardList actions", () => {
  function withActions(projects = PROJECTS, variant: "card" | "row" = "card") {
    const actions = {
      onReveal: vi.fn(),
      onDuplicate: vi.fn(),
      onRemove: vi.fn(),
    };
    const onOpen = vi.fn();
    render(
      <ProjectCardList
        projects={projects}
        variant={variant}
        label="Recent episodes"
        onOpen={onOpen}
        actions={actions}
      />,
    );
    const cards = projects.map((project) =>
      screen.getByRole("button", { name: new RegExp(`^${project.name}`) }),
    );
    return { ...actions, onOpen, cards, user: userEvent.setup() };
  }

  it("opens the menu on right-click without opening the project", async () => {
    const { cards, onOpen, user } = withActions();
    await user.pointer({ keys: "[MouseRight]", target: cards[0] });
    const menu = await screen.findByRole("menu", {
      name: `${PROJECTS[0].name}: actions`,
    });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Open", "Reveal in folder", "Duplicate", "Remove from list"]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens the menu on the context-menu event a focused card gets from the Menu key or Shift+F10", async () => {
    const { cards } = withActions();
    cards[0].focus();
    fireEvent.contextMenu(cards[0]);
    expect(await screen.findByRole("menu")).toBeInTheDocument();
  });

  it("opens the keyboard context menu after a touch on the card", async () => {
    const { cards } = withActions();
    fireEvent.pointerDown(cards[0], { pointerType: "touch", clientX: 5 });
    fireEvent.pointerUp(cards[0], { pointerType: "touch", clientX: 5 });
    cards[0].focus();
    fireEvent.keyDown(cards[0], { key: "F10", shiftKey: true });
    fireEvent.contextMenu(cards[0]);
    expect(await screen.findByRole("menu")).toBeInTheDocument();
  });

  it("names each swipe Remove button for its episode", () => {
    withActions(PROJECTS, "row");
    for (const project of PROJECTS) {
      expect(
        screen.getByRole("button", {
          name: `Remove ${project.name} from list`,
          hidden: true,
        }),
      ).toBeInTheDocument();
    }
  });

  it.each([
    ["Open", "onOpen"],
    ["Reveal in folder", "onReveal"],
    ["Duplicate", "onDuplicate"],
    ["Remove from list", "onRemove"],
  ] as const)("%s runs for the card it was opened on", async (name, run) => {
    const handlers = withActions();
    await handlers.user.pointer({
      keys: "[MouseRight]",
      target: handlers.cards[1],
    });
    await handlers.user.click(await screen.findByRole("menuitem", { name }));
    if (run === "onOpen") {
      expect(handlers.onOpen).toHaveBeenCalledWith("garden", "prepare");
    } else {
      expect(handlers[run]).toHaveBeenCalledWith("garden");
    }
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers only Remove from list on a card whose folder moved", async () => {
    const { cards, user } = withActions([PROJECTS[0], MISSING]);
    await user.pointer({ keys: "[MouseRight]", target: cards[1] });
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Remove from list"]);
  });

  it("moves focus to the next card after a removal", async () => {
    const { cards, user } = withActions();
    await user.pointer({ keys: "[MouseRight]", target: cards[0] });
    await user.click(
      await screen.findByRole("menuitem", { name: "Remove from list" }),
    );
    await waitFor(() => expect(cards[1]).toHaveFocus());
    expect(cards[1].tabIndex).toBe(0);
  });

  it("has no menu on a list without actions", async () => {
    const { cards, user } = setup();
    await user.pointer({ keys: "[MouseRight]", target: cards[0] });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  describe("swipe on the phone rows", () => {
    function swipe(card: HTMLElement, dx: number) {
      const slide = card.closest(".sys-project-slide") as HTMLElement;
      const at = (x: number) => ({
        pointerId: 1,
        pointerType: "touch",
        isPrimary: true,
        clientX: x,
        clientY: 10,
      });
      fireEvent.pointerDown(slide, at(200));
      fireEvent.pointerMove(slide, at(200 + dx));
      fireEvent.pointerUp(slide, at(200 + dx));
    }

    it("keeps Remove from list out of the way until a left swipe", () => {
      const { cards } = withActions(PROJECTS, "row");
      const remove = screen.getAllByText("Remove from list", {
        selector: "button",
      })[0];
      const row = cards[0].closest(".sys-project") as HTMLElement;
      expect(row).not.toHaveAttribute("data-revealed");
      expect(remove).toHaveAttribute("tabindex", "-1");
      vi.spyOn(remove, "offsetWidth", "get").mockReturnValue(96);
      swipe(cards[0], -80);
      expect(row).toHaveAttribute("data-revealed", "true");
      expect(remove).toHaveAttribute("tabindex", "0");
    });

    it("removes the row from the revealed button and does not open it", async () => {
      const { cards, onOpen, onRemove, user } = withActions(PROJECTS, "row");
      const remove = screen.getAllByText("Remove from list", {
        selector: "button",
      })[0];
      vi.spyOn(remove, "offsetWidth", "get").mockReturnValue(96);
      swipe(cards[0], -80);
      await user.click(remove);
      expect(onRemove).toHaveBeenCalledWith("rosa");
      expect(onOpen).not.toHaveBeenCalled();
    });

    it("does not open the row when the swipe lets go", () => {
      const { cards, onOpen } = withActions(PROJECTS, "row");
      const remove = screen.getAllByText("Remove from list", {
        selector: "button",
      })[0];
      vi.spyOn(remove, "offsetWidth", "get").mockReturnValue(96);
      swipe(cards[0], -80);
      fireEvent.click(cards[0]);
      expect(onOpen).not.toHaveBeenCalled();
    });

    it("hides the button again after a short swipe, and ignores a mouse", () => {
      const { cards } = withActions(PROJECTS, "row");
      const remove = screen.getAllByText("Remove from list", {
        selector: "button",
      })[0];
      vi.spyOn(remove, "offsetWidth", "get").mockReturnValue(96);
      const row = cards[0].closest(".sys-project") as HTMLElement;
      swipe(cards[0], -20);
      expect(row).not.toHaveAttribute("data-revealed");
      const slide = cards[0].closest(".sys-project-slide") as HTMLElement;
      fireEvent.pointerDown(slide, {
        pointerId: 2,
        pointerType: "mouse",
        isPrimary: true,
        clientX: 200,
        clientY: 10,
      });
      fireEvent.pointerMove(slide, {
        pointerId: 2,
        pointerType: "mouse",
        clientX: 100,
        clientY: 10,
      });
      fireEvent.pointerUp(slide, { pointerId: 2, pointerType: "mouse" });
      expect(row).not.toHaveAttribute("data-revealed");
    });
  });
});

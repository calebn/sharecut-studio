import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROLES } from "../../system/linkRoles";
import { SCRIPT_TURNS } from "../../system/scriptFixtures";
import { formatTimeShort } from "../../utils/time";
import { GuestReview, type GuestReviewProps } from "./GuestReview";
import { DURATION, PEAKS, WORD_STARTS } from "./guestFixture";
import { ROLE_HINT } from "./guestLogic";

function setup(props: Partial<GuestReviewProps> = {}) {
  return render(
    <GuestReview
      access="commenter"
      title="Field Notes 14"
      version="Rough cut"
      turns={SCRIPT_TURNS}
      wordStarts={WORD_STARTS}
      duration={DURATION}
      peaks={PEAKS}
      initialPlayhead={735}
      {...props}
    />,
  );
}

const LAYOUTS = ["desktop", "phone"] as const;
const ROLE_LAYOUTS = ROLES.flatMap((role) =>
  LAYOUTS.map((layout) => [role, layout] as const),
);
const WORDS = SCRIPT_TURNS.flatMap((turn) => turn.words);
const COMMENTERS = ROLES.filter((role) => role.id !== "viewer");

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

function startOf(index: number): number {
  const start = WORD_STARTS[index];
  if (start === undefined) throw new Error(`no word ${index}`);
  return start;
}
function textOf(index: number): string {
  const word = WORDS[index];
  if (word === undefined) throw new Error(`no word ${index}`);
  return word.text;
}
const readout = () =>
  document.querySelector(".sys-player-readout")?.textContent;
const clock = (seconds: number) =>
  `${formatTimeShort(seconds)} / ${formatTimeShort(DURATION)}`;
const playingWord = () =>
  document.querySelector(".sys-script-word[data-playing]")?.textContent ?? null;
const overviewPlayhead = () =>
  (document.querySelector(".sys-overview-playhead") as HTMLElement).style
    .insetInlineStart;
const percentOf = (seconds: number) => `${(seconds / DURATION) * 100}%`;
const scrollByHand = () => {
  const body = document.querySelector(".sys-script-body") as HTMLElement;
  fireEvent.wheel(body);
  fireEvent.scroll(body);
};
const backToPlayhead = () =>
  screen.queryByRole("button", { name: /Back to playhead/ });

describe("dead link", () => {
  it("shows a Cover with no button", () => {
    setup({ state: "bad-link" });
    expect(
      screen.getByRole("heading", { name: "This link doesn't open anything" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("states", () => {
  it.each(LAYOUTS)("loading on %s is busy with no Script", (layout) => {
    setup({ state: "loading", layout });
    expect(document.querySelector(".gr-body")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(document.querySelector(".sys-skeleton")).not.toBeNull();
    expect(document.querySelector(".sys-app-header-host")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.queryByRole("region", { name: "Script" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();
  });

  it("error offers Try again with a handler, and it fires", async () => {
    const onRetry = vi.fn();
    setup({ state: "error", onRetry });
    expect(
      screen.getByRole("heading", { name: "Could not load this review" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("error offers no Try again without a handler", () => {
    setup({ state: "error" });
    expect(
      screen.getByRole("heading", { name: "Could not load this review" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("says there is nothing to read when there are no turns", () => {
    setup({ turns: [] });
    expect(
      screen.getByRole("heading", { name: "Nothing to read yet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The host has not made a transcript of this version."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Script" })).toBeNull();
  });
});

describe("editor tabs and the Edit slot", () => {
  it.each(LAYOUTS)("an editor on %s has exactly Edit and Review", (layout) => {
    setup({ access: "editor", layout });
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Edit",
      "Review",
    ]);
    expect(screen.getByRole("tab", { name: "Review" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("puts the phone tabs in their own navigation", () => {
    setup({ access: "editor", layout: "phone" });
    const nav = screen.getByRole("navigation", { name: "Review stages" });
    expect(nav.querySelectorAll('[role="tab"]')).toHaveLength(2);
  });

  it.each(ROLE_LAYOUTS.filter(([role]) => role.id !== "editor"))(
    "a %s on %s has no tabs",
    (role, layout) => {
      setup({ access: role.id, layout });
      expect(screen.queryByRole("tab")).toBeNull();
    },
  );

  it.each(LAYOUTS)("shows the given Edit content on %s", async (layout) => {
    setup({ access: "editor", layout, edit: <p>Real Edit stage</p> });
    await userEvent.click(screen.getByRole("tab", { name: "Edit" }));
    expect(screen.getByText("Real Edit stage")).toBeInTheDocument();
    expect(screen.queryByText("Edit opens here")).toBeNull();
  });

  it.each(LAYOUTS)(
    "shows the placeholder on %s, and Review comes back",
    async (layout) => {
      setup({ access: "editor", layout });
      await userEvent.click(screen.getByRole("tab", { name: "Edit" }));
      expect(screen.getByText("Edit opens here")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("tab", { name: "Review" }));
      expect(
        screen.getByRole("region", { name: "Script" }),
      ).toBeInTheDocument();
    },
  );
});

describe("composer slot", () => {
  it.each(COMMENTERS.flatMap((r) => LAYOUTS.map((l) => [r, l] as const)))(
    "%s on %s has the composer once, after the Script only on phone",
    (role, layout) => {
      setup({ access: role.id, layout, composer: <p>Composer here</p> });
      const found = screen.getAllByText("Composer here");
      expect(found).toHaveLength(1);
      const script = screen.getByRole("region", { name: "Script" });
      const follows = script.compareDocumentPosition(found[0] as HTMLElement);
      expect(Boolean(follows & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
        layout === "phone",
      );
    },
  );

  it.each(LAYOUTS)("a viewer on %s has none", (layout) => {
    setup({ access: "viewer", layout, composer: <p>Composer here</p> });
    expect(screen.queryByText("Composer here")).toBeNull();
  });
});

describe("Comment and collapse controls", () => {
  it.each(COMMENTERS.flatMap((r) => LAYOUTS.map((l) => [r, l] as const)))(
    "%s on %s has a Comment button",
    (role, layout) => {
      setup({ access: role.id, layout, onComment: () => {} });
      expect(
        screen.getByRole("button", { name: "Comment" }),
      ).toBeInTheDocument();
    },
  );

  it.each(LAYOUTS)("a viewer on %s has none", (layout) => {
    setup({ access: "viewer", layout, onComment: () => {} });
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
  });

  it("collapses the Player with its own button, on a phone only", () => {
    setup({ layout: "desktop" });
    expect(
      screen.queryByRole("button", { name: "Collapse player" }),
    ).toBeNull();
  });

  it("collapses to the bar on a phone and expands again", async () => {
    setup({ layout: "phone" });
    await userEvent.click(
      screen.getByRole("button", { name: "Collapse player" }),
    );
    expect(
      screen.queryByRole("button", { name: "Collapse player" }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: /Expand player/ }),
    );
    expect(
      screen.getByRole("button", { name: "Collapse player" }),
    ).toBeInTheDocument();
  });

  it("collapses to the bar when the Script is scrolled by hand on a phone", () => {
    setup({ layout: "phone" });
    scrollByHand();
    expect(
      screen.getByRole("button", { name: /Expand player/ }),
    ).toBeInTheDocument();
  });

  it("stays expanded on desktop when the Script is scrolled", () => {
    setup({ layout: "desktop" });
    scrollByHand();
    expect(screen.queryByRole("button", { name: /Expand player/ })).toBeNull();
    expect(document.querySelector(".sys-player--expanded")).not.toBeNull();
  });
});

describe("Player and Script wiring", () => {
  it.each(ROLES)("a $id gets a Player without A/B", ({ id }) => {
    setup({ access: id });
    expect(document.querySelector(".sys-player--expanded")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "A" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Audition" })).toBeNull();
  });

  it.each([
    ["viewer", "Read only"],
    ["commenter", "Read only · you can comment"],
    ["editor", "Read only · you can comment"],
  ] as const)("the Script of a %s says %j", (access, text) => {
    setup({ access });
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it.each([0, 1, 9, 20, 40, 53])(
    "the playing word at word %i's start is that word",
    (index) => {
      setup({ initialPlayhead: startOf(index) });
      expect(playingWord()).toBe(textOf(index));
    },
  );

  it("shows no playing word before the first one starts", () => {
    setup({ initialPlayhead: 0 });
    expect(playingWord()).toBeNull();
  });

  it.each([0, 4, 20, 45])(
    "tapping word %i seeks to exactly its start",
    async (index) => {
      setup({ initialPlayhead: 0 });
      await userEvent.click(
        screen.getByRole("button", { name: textOf(index) }),
      );
      expect(playingWord()).toBe(textOf(index));
      expect(readout()).toBe(clock(startOf(index)));
      expect(overviewPlayhead()).toBe(percentOf(startOf(index)));
    },
  );

  it("shows the current and total time in that order", () => {
    setup({ initialPlayhead: 735 });
    expect(readout()).toBe(clock(735));
  });

  it.each([
    ["Back 15 seconds", 735, 720],
    ["Forward 15 seconds", 735, 750],
    ["Back 15 seconds", 5, 0],
    ["Forward 15 seconds", DURATION - 5, DURATION],
    ["Forward 15 seconds", DURATION, DURATION],
  ])("%s from %i lands on %i", async (name, from, to) => {
    setup({ initialPlayhead: from });
    await userEvent.click(screen.getByRole("button", { name }));
    expect(readout()).toBe(clock(to));
    expect(overviewPlayhead()).toBe(percentOf(to));
  });

  it.each([
    [false, "Play", "Pause"],
    [true, "Pause", "Play"],
  ])(
    "play toggles both ways when initialPlaying is %s",
    async (initialPlaying, first, second) => {
      setup({ initialPlaying });
      await userEvent.click(screen.getByRole("button", { name: first }));
      expect(screen.getByRole("button", { name: second })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: second }));
      expect(screen.getByRole("button", { name: first })).toBeInTheDocument();
    },
  );

  it("draws the overview playhead as a share of the episode", () => {
    setup({ initialPlayhead: DURATION / 2 });
    expect(overviewPlayhead()).toBe("50%");
  });
});

describe("following", () => {
  it.each([0, 20, 45])(
    "Back to playhead scrolls the playing word %i to the centre",
    async (index) => {
      const scrolled: { text: string | null; block: unknown }[] = [];
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value(this: HTMLElement, arg: ScrollIntoViewOptions) {
          scrolled.push({ text: this.textContent, block: arg.block });
        },
      });
      setup({ initialPlayhead: startOf(index) });
      scrollByHand();
      scrolled.length = 0;
      await userEvent.click(backToPlayhead() as HTMLElement);
      expect(scrolled).toEqual([{ text: textOf(index), block: "center" }]);
      expect(backToPlayhead()).toBeNull();
    },
  );

  it("shows Back to playhead after a hand scroll", () => {
    setup();
    expect(backToPlayhead()).toBeNull();
    scrollByHand();
    expect(backToPlayhead()).not.toBeNull();
  });

  it("follows again when the follow control is pressed", async () => {
    setup();
    scrollByHand();
    await userEvent.click(
      screen.getByRole("button", { name: "Follow the playhead" }),
    );
    expect(backToPlayhead()).toBeNull();
    expect(
      screen.getByRole("button", { name: "Follow the playhead" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});

describe("Role chip and hint per role", () => {
  it.each(ROLE_LAYOUTS)("%s on %s", (role, layout) => {
    setup({ access: role.id, layout, firstVisit: true });
    const chip = screen.getByRole("img", {
      name: new RegExp(`^${role.label}: `),
    });
    expect(chip.textContent).toBe(layout === "phone" ? "" : role.label);
    expect(screen.getByRole("note")).toHaveTextContent(ROLE_HINT[role.id]);
  });

  it("shows once on a first visit and tells the app when dismissed", async () => {
    const seen = vi.fn();
    setup({ firstVisit: true, onRoleHintSeen: seen });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss hint" }));
    expect(screen.queryByRole("note")).toBeNull();
    expect(seen).toHaveBeenCalledOnce();
  });

  it("keeps keyboard focus after the hint closes", async () => {
    setup({ firstVisit: true });
    screen.getByRole("button", { name: "Dismiss hint" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("note")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("stays quiet on a later visit", () => {
    setup();
    expect(screen.queryByRole("note")).toBeNull();
  });
});

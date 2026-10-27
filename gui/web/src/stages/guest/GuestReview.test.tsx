import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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

describe("GuestReview", () => {
  it("shows the composer slot to a commenter and hides it from a viewer", () => {
    const { unmount } = setup({ composer: <p>Composer here</p> });
    expect(screen.getByText("Composer here")).toBeInTheDocument();
    unmount();
    setup({ access: "viewer", composer: <p>Composer here</p> });
    expect(screen.queryByText("Composer here")).toBeNull();
  });

  it("follows the playhead in the Script", () => {
    setup({ initialPlayhead: 724 });
    expect(document.querySelector("[data-playing]")).not.toBeNull();
  });

  it("gives a viewer no composer and no Stage bar", () => {
    setup({ access: "viewer" });
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("gives an editor Edit and Review", async () => {
    setup({ access: "editor" });
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    await userEvent.click(screen.getByRole("tab", { name: /Edit/ }));
    expect(screen.getByText("Edit opens here")).toBeInTheDocument();
  });

  it("shows a Cover with no button for a dead link", () => {
    setup({ state: "bad-link" });
    expect(
      screen.getByRole("heading", { name: "This link doesn't open anything" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("Comment and collapse controls", () => {
  it.each([
    ["viewer", "desktop", false],
    ["viewer", "phone", false],
    ["commenter", "desktop", true],
    ["commenter", "phone", true],
    ["editor", "desktop", true],
    ["editor", "phone", true],
  ] as const)("%s on %s has a Comment button: %s", (access, layout, has) => {
    setup({ access, layout, onComment: () => {} });
    expect(!!screen.queryByRole("button", { name: "Comment" })).toBe(has);
  });

  it("collapses the Player only on a phone", () => {
    const { unmount } = setup({ layout: "desktop" });
    expect(
      screen.queryByRole("button", { name: "Collapse player" }),
    ).toBeNull();
    unmount();
    setup({ layout: "phone" });
    expect(
      screen.getByRole("button", { name: "Collapse player" }),
    ).toBeInTheDocument();
  });
});

describe("Back to playhead", () => {
  it("scrolls the playing word into view as well as following again", async () => {
    const scroll = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scroll;
    setup({ initialPlayhead: 735 });
    const body = document.querySelector(".sys-script-body") as HTMLElement;
    fireEvent.wheel(body);
    fireEvent.scroll(body);
    expect(
      screen.getByRole("button", { name: /Back to playhead/ }),
    ).toBeInTheDocument();
    scroll.mockClear();
    await userEvent.click(
      screen.getByRole("button", { name: /Back to playhead/ }),
    );
    expect(scroll).toHaveBeenCalledWith({ block: "center" });
    expect(
      screen.queryByRole("button", { name: /Back to playhead/ }),
    ).toBeNull();
  });
});

describe("Role hint", () => {
  it("shows once on a first visit and tells the app when dismissed", async () => {
    const seen = vi.fn();
    setup({ firstVisit: true, onRoleHintSeen: seen });
    expect(screen.getByRole("note")).toHaveTextContent("The host decides");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss hint" }));
    expect(screen.queryByRole("note")).toBeNull();
    expect(seen).toHaveBeenCalledOnce();
  });

  it("keeps keyboard focus after the hint closes", async () => {
    setup({ firstVisit: true });
    screen.getByRole("button", { name: "Dismiss hint" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(document.activeElement).not.toBe(document.body);
  });

  it("stays quiet on a later visit", () => {
    setup();
    expect(screen.queryByRole("note")).toBeNull();
  });
});

type Access = "viewer" | "commenter" | "editor";
const ROLES: readonly Access[] = ["viewer", "commenter", "editor"];
const LAYOUTS = ["desktop", "phone"] as const;
const WORDS = SCRIPT_TURNS.flatMap((turn) => turn.words);
const label = (seconds: number) => formatTimeShort(seconds);
const playingWord = () =>
  document.querySelector("[data-playing]")?.textContent ?? null;
const scrollByHand = () => {
  const body = document.querySelector(".sys-script-body") as HTMLElement;
  fireEvent.wheel(body);
  fireEvent.scroll(body);
};

describe("states", () => {
  it.each(LAYOUTS)(
    "loading on %s shows a busy skeleton and no Script",
    (layout) => {
      setup({ state: "loading", layout, composer: <p>Composer here</p> });
      expect(document.querySelector("main")).toHaveAttribute(
        "aria-busy",
        "true",
      );
      expect(
        document.querySelector(".sys-skeleton, [class*='skeleton']"),
      ).not.toBeNull();
      expect(document.querySelector(".sys-app-header-host")).toHaveAttribute(
        "aria-busy",
        "true",
      );
      expect(screen.queryByRole("region", { name: "Script" })).toBeNull();
      expect(screen.queryByText("Composer here")).toBeNull();
    },
  );

  it.each([
    ["with a handler", true],
    ["without one", false],
  ])("error %s", async (_name, withRetry) => {
    const onRetry = vi.fn();
    setup({ state: "error", onRetry: withRetry ? onRetry : undefined });
    expect(
      screen.getByRole("heading", { name: "Could not load this review" }),
    ).toBeInTheDocument();
    const retry = screen.queryByRole("button", { name: "Try again" });
    expect(!!retry).toBe(withRetry);
    if (retry) {
      await userEvent.click(retry);
      expect(onRetry).toHaveBeenCalledOnce();
    }
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
      expect.stringContaining("Edit"),
      expect.stringContaining("Review"),
    ]);
    expect(screen.getByRole("tab", { name: /Review/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("puts the phone tabs in their own navigation, not the header", () => {
    setup({ access: "editor", layout: "phone" });
    const nav = screen.getByRole("navigation", { name: "Review stages" });
    expect(nav.querySelectorAll('[role="tab"]')).toHaveLength(2);
  });

  it.each(LAYOUTS)(
    "shows the given Edit content on %s, else the placeholder",
    async (layout) => {
      const { unmount } = setup({
        access: "editor",
        layout,
        edit: <p>Real Edit stage</p>,
      });
      await userEvent.click(screen.getByRole("tab", { name: /Edit/ }));
      expect(screen.getByText("Real Edit stage")).toBeInTheDocument();
      expect(screen.queryByText("Edit opens here")).toBeNull();
      unmount();
      setup({ access: "editor", layout });
      await userEvent.click(screen.getByRole("tab", { name: /Edit/ }));
      expect(screen.getByText("Edit opens here")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("tab", { name: /Review/ }));
      expect(
        screen.getByRole("region", { name: "Script" }),
      ).toBeInTheDocument();
    },
  );

  it.each(["viewer", "commenter"] as const)(
    "a %s has no tabs on either layout",
    (access) => {
      for (const layout of LAYOUTS) {
        const { unmount } = setup({ access, layout });
        expect(screen.queryByRole("tab")).toBeNull();
        unmount();
      }
    },
  );
});

describe("composer slot", () => {
  it.each(
    ROLES.flatMap((access) =>
      LAYOUTS.map((layout) => [access, layout] as const),
    ),
  )("%s on %s", (access, layout) => {
    setup({ access, layout, composer: <p>Composer here</p> });
    const found = screen.queryAllByText("Composer here");
    expect(found).toHaveLength(access === "viewer" ? 0 : 1);
    const script = screen.getByRole("region", { name: "Script" });
    const [composer] = found;
    if (composer) {
      const after =
        script.compareDocumentPosition(composer) &
        Node.DOCUMENT_POSITION_FOLLOWING;
      expect(!!after).toBe(layout === "phone");
    }
  });
});

describe("Player and Script wiring", () => {
  it.each(ROLES)("a %s gets a Player without A/B", (access) => {
    setup({ access });
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
      setup({ initialPlayhead: WORD_STARTS[index] ?? 0 });
      expect(playingWord()).toBe(WORDS[index]?.text);
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
        screen.getByRole("button", { name: WORDS[index]?.text ?? "" }),
      );
      expect(playingWord()).toBe(WORDS[index]?.text);
      expect(
        screen.getAllByText(label(WORD_STARTS[index] ?? 0)).length,
      ).toBeGreaterThan(0);
    },
  );

  it("shows the current and total time in that order", () => {
    setup({ initialPlayhead: 735 });
    const readout = document.querySelector(
      ".sys-player-readout",
    ) as HTMLElement;
    expect(readout.textContent).toContain(`${label(735)} / ${label(DURATION)}`);
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
    const readout = document.querySelector(
      ".sys-player-readout",
    ) as HTMLElement;
    expect(readout.textContent).toContain(`${label(to)} / `);
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
    const overview = document.querySelector(".sys-overview") as HTMLElement;
    expect(overview.innerHTML).toMatch(/50%|0\.5/);
  });
});

describe("following", () => {
  it.each([0, 20, 45])(
    "Back to playhead scrolls word %i, the playing one",
    async (index) => {
      const scrolled: (string | null)[] = [];
      window.HTMLElement.prototype.scrollIntoView = function () {
        scrolled.push(this.textContent);
      };
      setup({ initialPlayhead: WORD_STARTS[index] ?? 0 });
      scrollByHand();
      scrolled.length = 0;
      await userEvent.click(
        screen.getByRole("button", { name: /Back to playhead/ }),
      );
      expect(scrolled).toEqual([WORDS[index]?.text]);
    },
  );

  it("resumes following when the follow control is pressed again", async () => {
    setup();
    scrollByHand();
    expect(
      screen.getByRole("button", { name: /Back to playhead/ }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Follow the playhead" }),
    );
    expect(
      screen.queryByRole("button", { name: /Back to playhead/ }),
    ).toBeNull();
  });
});

describe("phone Player form", () => {
  it("collapses to the bar when the Script is scrolled by hand and expands again", async () => {
    setup({ layout: "phone" });
    expect(
      screen.getByRole("button", { name: "Collapse player" }),
    ).toBeInTheDocument();
    scrollByHand();
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

  it("collapses with its own button", async () => {
    setup({ layout: "phone" });
    await userEvent.click(
      screen.getByRole("button", { name: "Collapse player" }),
    );
    expect(
      screen.getByRole("button", { name: /Expand player/ }),
    ).toBeInTheDocument();
  });

  it("stays expanded on desktop when the Script is scrolled", () => {
    setup({ layout: "desktop" });
    scrollByHand();
    expect(screen.queryByRole("button", { name: /Expand player/ })).toBeNull();
  });
});

describe("Role chip and hint per role", () => {
  it.each(
    ROLES.flatMap((access) =>
      LAYOUTS.map((layout) => [access, layout] as const),
    ),
  )("%s on %s", (access, layout) => {
    setup({ access, layout, firstVisit: true });
    const name = access[0]?.toUpperCase() + access.slice(1);
    const chip = screen.getByRole("img", { name: new RegExp(`^${name}: `) });
    expect(chip.textContent).toBe(layout === "phone" ? "" : name);
    expect(screen.getByRole("note")).toHaveTextContent(ROLE_HINT[access]);
  });
});

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/segments";
import { BundleImportHost } from "../system/importSheet/BundleImportHost";
import { expectNoA11yViolations } from "../test/a11y";
import { deferred } from "../test/deferred";
import { ApiError } from "../utils/apiError";
import { stopAudition } from "./audition";
import { DAMAGED, HEALTHY, LIBRARY, MULTI_VERSION } from "./fixtures";
import { SegmentLibrary } from "./SegmentLibrary";
import { useSegmentLibrary } from "./useSegmentLibrary";

vi.mock("../api/segments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/segments")>()),
  loadSegments: vi.fn(),
  removeSegment: vi.fn(),
}));
vi.mock("../sessionAuth", () => ({
  withSessionTokenQuery: (url: string) => `${url}&token=t`,
}));

const load = vi.mocked(api.loadSegments);
const removeSegment = vi.mocked(api.removeSegment);

function Section({
  layout,
  withImport = false,
}: {
  layout: "table" | "list";
  withImport?: boolean;
}) {
  const library = useSegmentLibrary();
  const list = <SegmentLibrary library={library} layout={layout} />;
  return withImport ? (
    <BundleImportHost segments={library}>{list}</BundleImportHost>
  ) : (
    list
  );
}

const play = vi.fn(async () => {});
const pause = vi.fn();

beforeEach(() => {
  load.mockReset().mockResolvedValue(LIBRARY);
  removeSegment.mockReset().mockResolvedValue(undefined);
  play.mockClear();
  pause.mockClear();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});

afterEach(() => {
  act(() => stopAudition());
  vi.restoreAllMocks();
});

async function ready(layout: "table" | "list" = "table") {
  const view = render(<Section layout={layout} />);
  await screen.findByRole("button", { name: "Play Cold open" });
  return view;
}

describe("SegmentLibrary on a wide Home", () => {
  it("is a real table with column headers, a caption and one row per segment", async () => {
    await ready();
    const table = screen.getByRole("table", { name: "Segment library" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Audition", "Name", "Type", "Length", "Actions"]);
    expect(within(table).getAllByRole("row")).toHaveLength(4);
  });

  it("shows the name, version tag, kind and length computed from the clips", async () => {
    await ready();
    const cold = screen.getByRole("row", { name: /Cold open/ });
    expect(within(cold).getByText("v1")).toBeVisible();
    expect(within(cold).getByText("Intro")).toBeVisible();
    expect(within(cold).getByText("0:12")).toBeVisible();
    const sponsor = screen.getByRole("row", { name: /Acme sponsor read/ });
    expect(within(sponsor).getByText("v3 · 3 versions")).toBeVisible();
    expect(within(sponsor).getByText("0:35")).toBeVisible();
    expect(screen.queryByText(/Used in/)).toBeNull();
  });

  it("is axe-clean", async () => {
    const { container } = await ready();
    await expectNoA11yViolations(container);
  });
});

describe("SegmentLibrary on a narrow Home", () => {
  it("is a labelled list with the same rows", async () => {
    await ready("list");
    const list = screen.getByRole("list", { name: "Segment library" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("is axe-clean", async () => {
    const { container } = await ready("list");
    await expectNoA11yViolations(container);
  });
});

describe("states", () => {
  it("shows the empty state without promising a Save button", async () => {
    load.mockResolvedValue([]);
    const { container } = render(<Section layout="table" withImport />);
    const empty = await screen.findByText(/No saved segments yet/);
    expect(empty).toBeVisible();
    expect(empty.textContent).not.toMatch(/save from|selection/i);
    expect(
      screen.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["Import"]);
    expect(screen.getByText(/Have a segment or kit file/)).toBeVisible();
    await expectNoA11yViolations(container);
  });

  it("shows the failure with Try again, and loads on retry", async () => {
    load.mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    const { container } = render(<Section layout="table" />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the segment library.");
    expect(alert).toHaveTextContent("offline");
    await expectNoA11yViolations(container);
    await user.click(
      screen.getByRole("button", {
        name: "Try again to load the segment library",
      }),
    );
    expect(
      await screen.findByRole("button", { name: "Play Cold open" }),
    ).toBeVisible();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("announces loading while the list is read", () => {
    load.mockReturnValue(new Promise(() => {}));
    render(<Section layout="table" />);
    expect(screen.getByText("Loading the segment library")).toBeInTheDocument();
  });

  it("lists a damaged row with its id, a warning chip and the problem, and no Play", async () => {
    await ready();
    const row = screen.getByRole("row", { name: new RegExp(DAMAGED.id) });
    expect(within(row).getByText("Can't be played or inserted")).toBeVisible();
    expect(within(row).getByText(DAMAGED.problem)).toBeVisible();
    expect(within(row).queryByRole("button", { name: /^Play/ })).toBeNull();
    expect(
      within(row).getByRole("button", {
        name: `More actions for ${DAMAGED.id}`,
      }),
    ).toBeVisible();
  });
});

describe("audition", () => {
  it("plays from the click, labels the button Stop, and stops on a second tap", async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByRole("button", { name: "Play Cold open" }));
    expect(play).toHaveBeenCalledTimes(1);
    const stop = screen.getByRole("button", { name: "Stop Cold open" });
    expect(screen.getByText("Playing Cold open")).toBeInTheDocument();
    await user.click(stop);
    expect(
      screen.getByRole("button", { name: "Play Cold open" }),
    ).toBeVisible();
    expect(screen.getByText("Stopped")).toBeInTheDocument();
  });

  it("moves to another row without two playing", async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByRole("button", { name: "Play Cold open" }));
    await user.click(
      screen.getByRole("button", { name: "Play Acme sponsor read" }),
    );
    expect(
      screen.getByRole("button", { name: "Play Cold open" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Stop Acme sponsor read" }),
    ).toBeVisible();
  });

  it("says a segment could not be played on that row", async () => {
    play.mockRejectedValueOnce(new Error("blocked"));
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByRole("button", { name: "Play Cold open" }));
    const row = screen.getByRole("row", { name: /Cold open/ });
    expect(
      await within(row).findByText("Couldn't play this segment"),
    ).toBeVisible();
  });

  it("stops when the section unmounts", async () => {
    const user = userEvent.setup();
    const { unmount } = await ready();
    await user.click(screen.getByRole("button", { name: "Play Cold open" }));
    pause.mockClear();
    unmount();
    expect(pause).toHaveBeenCalled();
  });
});

describe("removing a segment", () => {
  async function askToRemove(user: ReturnType<typeof userEvent.setup>) {
    await user.click(
      screen.getByRole("button", {
        name: "More actions for Acme sponsor read",
      }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Remove from library" }),
    );
    return screen.getByRole("group", { name: /Remove “Acme sponsor read”/ });
  }

  it("asks first, says all versions and can't be undone, and focuses Keep", async () => {
    const user = userEvent.setup();
    await ready();
    const confirm = await askToRemove(user);
    expect(confirm).toHaveTextContent("all 3 versions");
    expect(confirm).toHaveTextContent("can't be undone");
    expect(confirm).toHaveTextContent(
      "Episodes that already use it keep their copy",
    );
    expect(within(confirm).getByRole("button", { name: "Keep" })).toHaveFocus();
    expect(removeSegment).not.toHaveBeenCalled();
  });

  it("is axe-clean while asking", async () => {
    const user = userEvent.setup();
    const { container } = await ready();
    await askToRemove(user);
    await expectNoA11yViolations(container);
  });

  it("Keep and Escape both leave the segment and return focus to its More button", async () => {
    const user = userEvent.setup();
    await ready();
    await askToRemove(user);
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(
      screen.getByRole("button", {
        name: "More actions for Acme sponsor read",
      }),
    ).toHaveFocus();
    await askToRemove(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: /Remove/ })).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "More actions for Acme sponsor read",
      }),
    ).toHaveFocus();
    expect(removeSegment).not.toHaveBeenCalled();
  });

  it("removes, says so in a status line with no Undo, and focuses the next row's Play", async () => {
    const user = userEvent.setup();
    await ready();
    const confirm = await askToRemove(user);
    load.mockResolvedValue([HEALTHY, DAMAGED]);
    await user.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Play Acme sponsor read" }),
      ).toBeNull(),
    );
    expect(removeSegment).toHaveBeenCalledWith(MULTI_VERSION.id);
    expect(
      screen.getByText("Removed Acme sponsor read from the library."),
    ).toHaveAttribute("role", "status");
    expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull();
    expect(
      screen.getByRole("button", {
        name: `More actions for ${DAMAGED.id}`,
      }),
    ).toHaveFocus();
  });

  it("stops the audition of the row being removed", async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(
      screen.getByRole("button", { name: "Play Acme sponsor read" }),
    );
    await askToRemove(user);
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
    expect(pause).toHaveBeenCalled();
  });

  it("restores the row and says why when the segment is in use", async () => {
    removeSegment.mockRejectedValueOnce(
      new ApiError("busy", "segment_busy", 409),
    );
    const user = userEvent.setup();
    await ready();
    const confirm = await askToRemove(user);
    await user.click(within(confirm).getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Another action is using this segment. Try again.",
    );
    expect(
      screen.getByRole("button", { name: "Play Acme sponsor read" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "More actions for Acme sponsor read",
      }),
    ).toHaveFocus();
  });

  it("offers Remove for a damaged row, naming every version", async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(
      screen.getByRole("button", { name: `More actions for ${DAMAGED.id}` }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Remove from library" }),
    );
    expect(
      screen.getByRole("group", { name: new RegExp(`Remove ${DAMAGED.id}`) }),
    ).toHaveTextContent("every version");
  });

  it("moves focus to the empty message when the last segment goes", async () => {
    load.mockResolvedValue([HEALTHY]);
    const user = userEvent.setup();
    render(<Section layout="list" />);
    await user.click(
      await screen.findByRole("button", { name: "More actions for Cold open" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Remove from library" }),
    );
    load.mockResolvedValue([]);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    const empty = (await screen.findByText(/No saved segments yet/))
      .parentElement;
    await waitFor(() => expect(empty).toHaveFocus());
  });

  it("sends one removal when Remove is pressed again while it is in flight", async () => {
    const pending = deferred();
    removeSegment.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    await ready();
    const confirm = await askToRemove(user);
    const button = within(confirm).getByRole("button", { name: "Remove" });
    await user.click(button);
    await user.click(button);
    await user.keyboard("{Enter}");
    expect(removeSegment).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve());
    await screen.findByText("Removed Acme sponsor read from the library.");
    expect(removeSegment).toHaveBeenCalledTimes(1);
  });

  it("ignores a second Remove while one is in flight and keeps focus for the first", async () => {
    const pending = deferred();
    removeSegment.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    await ready();
    const confirm = await askToRemove(user);
    await user.click(within(confirm).getByRole("button", { name: "Remove" }));
    await user.click(
      screen.getByRole("button", { name: `More actions for ${DAMAGED.id}` }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Remove from library" }),
    );
    expect(screen.getAllByRole("group")).toHaveLength(1);
    expect(
      screen.getByRole("group", { name: /Remove “Acme sponsor read”/ }),
    ).toBeVisible();
    expect(removeSegment).toHaveBeenCalledTimes(1);
    load.mockResolvedValue([HEALTHY, DAMAGED]);
    await act(async () => pending.resolve());
    expect(
      await screen.findByText("Removed Acme sponsor read from the library."),
    ).toBeVisible();
    expect(screen.queryByRole("group")).toBeNull();
    expect(
      screen.getByRole("button", { name: `More actions for ${DAMAGED.id}` }),
    ).toHaveFocus();
  });

  it("keeps the rows and offers Try again when the list read after a removal fails", async () => {
    const user = userEvent.setup();
    await ready();
    const confirm = await askToRemove(user);
    load.mockRejectedValueOnce(new Error("offline"));
    await user.click(within(confirm).getByRole("button", { name: "Remove" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("offline");
    expect(
      screen.getByRole("button", { name: "Play Cold open" }),
    ).toBeVisible();
    load.mockResolvedValue([HEALTHY, DAMAGED]);
    await user.click(
      within(alert).getByRole("button", {
        name: "Try again to load the segment library",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

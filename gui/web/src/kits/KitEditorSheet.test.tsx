import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/kits";
import type { SegmentListRow } from "../api/segments";
import { DAMAGED, HEALTHY, MULTI_VERSION, segment } from "../segments/fixtures";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { deferred } from "../test/deferred";
import { stubViewportShell } from "../test/viewportShell";
import { ApiError } from "../utils/apiError";
import { kit as kitRow } from "./fixtures";
import { KitLibrary } from "./KitLibrary";
import { useKitLibrary } from "./useKitLibrary";

vi.mock("../api/kits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/kits")>()),
  loadKits: vi.fn(),
  saveKit: vi.fn(),
}));

const loadKits = vi.mocked(api.loadKits);
const saveKit = vi.mocked(api.saveKit);

const OUTRO = segment({
  id: "outro-4d2e",
  name: "Sign off",
  kind: "outro",
  clips: [{ audio: "o.flac", offset_sec: 0, duration_sec: 20 }],
});
const SEGMENTS: SegmentListRow[] = [HEALTHY, MULTI_VERSION, OUTRO, DAMAGED];

let reloadSegments = vi.fn();

function Section({ rows = SEGMENTS }: { rows?: SegmentListRow[] | null }) {
  const library = useKitLibrary(true);
  return (
    <KitLibrary
      library={library}
      segments={{ rows, reload: reloadSegments }}
      omitWhenEmpty
    />
  );
}

const announced = () => useDawStore.getState().statusAnnouncement;

async function openSheet(rows?: SegmentListRow[] | null) {
  const user = userEvent.setup();
  const view = render(<Section rows={rows} />);
  await user.click(await screen.findByRole("button", { name: "New kit" }));
  const dialog = await screen.findByRole("dialog", { name: "New kit" });
  return { user, dialog, view };
}

const add = (user: ReturnType<typeof userEvent.setup>, name: string) =>
  user.click(screen.getByRole("button", { name: `Add ${name}` }));

const entries = (dialog: HTMLElement) =>
  within(
    within(dialog).getByRole("list", { name: "Kit segments" }),
  ).getAllByRole("listitem");

beforeEach(() => {
  stubViewportShell("desktop");
  reloadSegments = vi.fn();
  loadKits.mockReset().mockResolvedValue([kitRow()]);
  saveKit
    .mockReset()
    .mockResolvedValue({ status: "added", id: "new-kit-1", version: 1 });
  useDawStore.setState({ guestMode: null, statusAnnouncement: "" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("New kit button", () => {
  it("is in the Kits section for the host", async () => {
    render(<Section />);
    expect(
      await screen.findByRole("button", { name: "New kit" }),
    ).toBeVisible();
    expect(screen.getByText("Show Kit")).toBeVisible();
  });

  it("shows the section on Home with no kits when a segment exists", async () => {
    loadKits.mockResolvedValue([]);
    render(<Section />);
    expect(await screen.findByText(/No kits yet/)).toBeVisible();
    expect(screen.getByRole("button", { name: "New kit" })).toBeVisible();
  });

  it("leaves Home's section out with no kits and no readable segment", async () => {
    loadKits.mockResolvedValue([]);
    render(<Section rows={[DAMAGED]} />);
    await waitFor(() => expect(loadKits).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Kits" })).toBeNull();
  });

  it("is not offered to a guest or without a segment library", async () => {
    useDawStore.setState({ guestMode: "viewer" });
    const { unmount } = render(<Section />);
    expect(screen.queryByRole("button", { name: "New kit" })).toBeNull();
    unmount();
    useDawStore.setState({ guestMode: null });
    function Bare() {
      return <KitLibrary library={useKitLibrary(true)} />;
    }
    render(<Bare />);
    await screen.findByText("Show Kit");
    expect(screen.queryByRole("button", { name: "New kit" })).toBeNull();
  });
});

describe("KitEditorSheet", () => {
  it("opens empty with the name focused and Save off for a reason", async () => {
    const { dialog } = await openSheet();
    expect(within(dialog).getByLabelText("Name")).toHaveFocus();
    expect(
      within(dialog).getByText(/Add the segments this kit puts/),
    ).toBeVisible();
    const save = screen.getByRole("button", { name: "Save kit" });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute("title", "Add at least one segment.");
    expect(within(dialog).queryByText("Saves a new kit.")).toBeNull();
    await userEvent.type(within(dialog).getByLabelText("Name"), "Weekly");
    expect(within(dialog).getByText("Saves a new kit.")).toBeVisible();
  });

  it("lists readable segments to add, hides the damaged one and says so", async () => {
    const { dialog } = await openSheet();
    const picker = within(dialog).getByRole("list", {
      name: "Segments you can add",
    });
    expect(within(picker).getAllByRole("listitem")).toHaveLength(3);
    expect(within(picker).queryByText("outro-77de")).toBeNull();
    expect(
      within(dialog).getByText("1 segment can't be read and isn't listed."),
    ).toBeVisible();
  });

  it("says what is missing when the library has no segment, or is still loading", async () => {
    const first = await openSheet([]);
    expect(
      within(first.dialog).getByText(/Save a segment from an episode first/),
    ).toBeVisible();
  });

  it("says the library is loading while its rows are null", async () => {
    const { dialog } = await openSheet(null);
    expect(within(dialog).getByText("Loading your segments…")).toBeVisible();
  });

  it("adds in order with Start for an intro and End for the rest, builds entries from the library", async () => {
    const { user, dialog } = await openSheet();
    await add(user, "Cold open");
    await add(user, "Acme sponsor read");
    await add(user, "Sign off");
    const rows = entries(dialog);
    expect(rows).toHaveLength(3);
    const pressed = (row: HTMLElement) =>
      within(row).getByRole("radio", { checked: true }).textContent;
    expect(rows.map(pressed)).toEqual(["Start", "End", "End"]);
    expect(within(rows[0]).getByText("Cold open")).toBeVisible();
    expect(within(rows[0]).getByText("Intro")).toBeVisible();
    expect(within(rows[0]).getByText("0:12")).toBeVisible();
    expect(
      within(dialog).getByText("Added Sign off at position 3."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save kit" })).toBeEnabled();
  });

  it("lets a segment be added twice and counts it", async () => {
    const { user, dialog } = await openSheet();
    await add(user, "Cold open");
    expect(within(dialog).getByText("In kit (1)")).toBeVisible();
    await add(user, "Cold open");
    expect(within(dialog).getByText("In kit (2)")).toBeVisible();
    expect(entries(dialog)).toHaveLength(2);
  });

  it("moves an entry, announces it and keeps focus on the control that moved it", async () => {
    const { user, dialog } = await openSheet();
    await add(user, "Cold open");
    await add(user, "Acme sponsor read");
    await add(user, "Sign off");
    const down = within(entries(dialog)[0]).getByRole("button", {
      name: "Move Cold open down",
    });
    expect(
      within(entries(dialog)[0]).getByRole("button", {
        name: "Move Cold open up",
      }),
    ).toHaveAttribute("title", "Already first");
    await user.click(down);
    expect(
      within(dialog).getByText("Moved Cold open to position 2 of 3."),
    ).toBeInTheDocument();
    expect(
      entries(dialog).map(
        (row) => within(row).getAllByText(/./)[1].textContent,
      ),
    ).toEqual(["Acme sponsor read", "Cold open", "Sign off"]);
    expect(
      within(entries(dialog)[1]).getByRole("button", {
        name: "Move Cold open down",
      }),
    ).toHaveFocus();
    await user.click(
      within(entries(dialog)[1]).getByRole("button", {
        name: "Move Cold open down",
      }),
    );
    // At the end the Down button is disabled, so focus goes to Up.
    expect(
      within(entries(dialog)[2]).getByRole("button", {
        name: "Move Cold open up",
      }),
    ).toHaveFocus();
    expect(
      within(entries(dialog)[2]).getByRole("button", {
        name: "Move Cold open down",
      }),
    ).toHaveAttribute("title", "Already last");
  });

  it("removes an entry and puts focus on the next one's Remove", async () => {
    const { user, dialog } = await openSheet();
    await add(user, "Cold open");
    await add(user, "Acme sponsor read");
    await user.click(
      screen.getByRole("button", { name: "Remove Cold open from the kit" }),
    );
    expect(entries(dialog)).toHaveLength(1);
    expect(
      within(dialog).getByText("Removed Cold open from the kit."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Remove Acme sponsor read from the kit",
      }),
    ).toHaveFocus();
    await user.click(
      screen.getByRole("button", {
        name: "Remove Acme sponsor read from the kit",
      }),
    );
    expect(within(dialog).getByLabelText("Name")).toHaveFocus();
    expect(screen.getByRole("button", { name: "Save kit" })).toBeDisabled();
  });

  it("warns when a Start entry follows another Start entry, and not after it is changed", async () => {
    const { user, dialog } = await openSheet();
    await add(user, "Cold open");
    await add(user, "Cold open");
    const second = entries(dialog)[1];
    expect(
      within(second).getByText(
        "Start entries apply one after another, so Cold open will land ahead of Cold open. Set one of them to End, or leave it if that order is what you want.",
      ),
    ).toBeVisible();
    expect(within(entries(dialog)[0]).queryByRole("note")).toBeNull();
    await user.click(within(second).getByRole("radio", { name: "End" }));
    expect(within(second).queryByRole("note")).toBeNull();
  });

  it("sends exactly the name and the entries in order, then reveals and announces the new kit", async () => {
    loadKits.mockResolvedValueOnce([kitRow()]);
    const { user, dialog } = await openSheet();
    await add(user, "Sign off");
    await add(user, "Cold open");
    await user.click(
      within(entries(dialog)[1]).getByRole("button", {
        name: "Move Cold open up",
      }),
    );
    loadKits.mockResolvedValue([
      kitRow(),
      kitRow({ id: "new-kit-1", name: "Weekly", entries: 2 }),
    ]);
    await user.type(within(dialog).getByLabelText("Name"), "  Weekly ");
    await user.click(screen.getByRole("button", { name: "Save kit" }));
    expect(saveKit).toHaveBeenCalledTimes(1);
    expect(saveKit.mock.calls[0][0]).toEqual({
      name: "Weekly",
      entries: [
        { segment_id: "intro-9f3a", at: "start" },
        { segment_id: "outro-4d2e", at: "end" },
      ],
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "New kit" })).toBeNull(),
    );
    expect(announced()).toBe("Saved the kit Weekly with 2 segments.");
    const row = (await screen.findByText("Weekly")).closest(
      "li",
    ) as HTMLElement;
    expect(row).toHaveAttribute("data-new");
    await waitFor(() => expect(row).toHaveFocus());
    expect(screen.getByText("Show Kit").closest("li")).not.toHaveAttribute(
      "data-new",
    );
  });

  it("says a same-name save made a new version, and an identical one changed nothing", async () => {
    const { user, dialog } = await openSheet();
    await add(user, "Cold open");
    await user.type(within(dialog).getByLabelText("Name"), "Show Kit");
    expect(
      within(dialog).getByText(
        "Saves version 2 of Show Kit. The earlier version is kept.",
      ),
    ).toBeVisible();
    saveKit.mockResolvedValue({
      status: "new_version",
      id: "show-kit-1a2b3c4d",
      version: 2,
    });
    await user.click(screen.getByRole("button", { name: "Save kit" }));
    await waitFor(() =>
      expect(announced()).toBe(
        "Saved a new version of Show Kit (v2). The earlier version is kept.",
      ),
    );
  });

  it("reports unchanged without a new row", async () => {
    saveKit.mockResolvedValue({
      status: "unchanged",
      id: "show-kit-1a2b3c4d",
      version: 1,
    });
    const { user, dialog } = await openSheet();
    await add(user, "Cold open");
    await user.type(within(dialog).getByLabelText("Name"), "Show Kit");
    await user.click(screen.getByRole("button", { name: "Save kit" }));
    await waitFor(() =>
      expect(announced()).toBe(
        "Show Kit already has these segments. Nothing changed.",
      ),
    );
  });

  it("warns that a name differing only in case makes a separate kit", async () => {
    const { user, dialog } = await openSheet();
    await user.type(within(dialog).getByLabelText("Name"), "show kit");
    expect(
      within(dialog).getByText(
        "A kit called Show Kit exists. This saves a separate kit.",
      ),
    ).toBeVisible();
  });

  it("shows a name problem after the field is left or Save is pressed, and saves nothing", async () => {
    const { user, dialog } = await openSheet();
    await add(user, "Cold open");
    const name = within(dialog).getByLabelText("Name");
    await user.type(name, "日本");
    expect(
      within(dialog).queryByText(/at least one letter or digit/),
    ).toBeNull();
    await user.tab();
    expect(
      await within(dialog).findByText(
        "Use at least one letter or digit from a to z.",
      ),
    ).toBeVisible();
    expect(name).toHaveAttribute("aria-invalid", "true");
    await user.clear(name);
    await user.click(screen.getByRole("button", { name: "Save kit" }));
    expect(
      await within(dialog).findByText("Enter a name for the kit."),
    ).toBeVisible();
    expect(name).toHaveFocus();
    expect(saveKit).not.toHaveBeenCalled();
  });

  it("keeps the sheet open on a refusal and reads the segments again for a missing one", async () => {
    saveKit.mockRejectedValue(
      new ApiError(
        "1 segment of this kit is not in the library",
        "kit_segment_missing",
        409,
      ),
    );
    const { user, dialog } = await openSheet();
    await add(user, "Cold open");
    await user.type(within(dialog).getByLabelText("Name"), "Weekly");
    await user.click(screen.getByRole("button", { name: "Save kit" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "A segment in this kit was removed from the library. Remove it from the list, then save again.",
    );
    expect(reloadSegments).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "New kit" })).toBeVisible();
    expect(entries(dialog)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Save kit" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save kit" })).toHaveFocus();
  });

  it("returns focus to the name field when the studio refuses the name", async () => {
    saveKit.mockRejectedValue(new ApiError("x", "kit_name_invalid", 422));
    const { user, dialog } = await openSheet();
    await add(user, "Cold open");
    await user.type(within(dialog).getByLabelText("Name"), "Weekly");
    await user.click(screen.getByRole("button", { name: "Save kit" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "A kit name needs at least one letter or digit from a to z.",
    );
    expect(within(dialog).getByLabelText("Name")).toHaveFocus();
  });

  it("flags an entry whose segment left the library and blocks Save until it is removed", async () => {
    const { user, dialog, view } = await openSheet();
    await add(user, "Cold open");
    await add(user, "Sign off");
    await user.type(within(dialog).getByLabelText("Name"), "Weekly");
    view.rerender(<Section rows={[HEALTHY, MULTI_VERSION]} />);
    const rows = entries(dialog);
    expect(within(rows[1]).getByText("outro-4d2e")).toBeVisible();
    expect(within(rows[1]).getByText(/no longer in the library/)).toBeVisible();
    const save = screen.getByRole("button", { name: "Save kit" });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute(
      "title",
      "Remove the segments that are no longer in the library.",
    );
    await user.click(
      screen.getByRole("button", { name: "Remove outro-4d2e from the kit" }),
    );
    expect(save).toBeEnabled();
  });

  it("sends one save for a double press and holds the controls while it runs", async () => {
    const pending = deferred<{
      status: "added";
      id: string;
      version: number;
    }>();
    saveKit.mockReturnValue(pending.promise);
    const { user, dialog } = await openSheet();
    await add(user, "Cold open");
    await user.type(within(dialog).getByLabelText("Name"), "Weekly");
    const save = screen.getByRole("button", { name: "Save kit" });
    await user.click(save);
    await user.click(save);
    expect(saveKit).toHaveBeenCalledTimes(1);
    expect(await within(dialog).findByText("Saving the kit…")).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add Sign off" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "New kit" })).toBeVisible();
    pending.resolve({ status: "added", id: "weekly-1", version: 1 });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "New kit" })).toBeNull(),
    );
  });

  it("stops adding at 32 entries and says why", async () => {
    const { user, dialog } = await openSheet();
    for (let i = 0; i < 32; i += 1) await add(user, "Sign off");
    expect(entries(dialog)).toHaveLength(32);
    const button = screen.getByRole("button", { name: "Add Cold open" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "A kit holds up to 32 segments.");
  });

  it("closes on Escape and returns focus to New kit, with a fresh draft next time", async () => {
    const { user, dialog } = await openSheet();
    await add(user, "Cold open");
    await user.type(within(dialog).getByLabelText("Name"), "Draft");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "New kit" })).toBeNull(),
    );
    const opener = screen.getByRole("button", { name: "New kit" });
    await waitFor(() => expect(opener).toHaveFocus());
    await user.click(opener);
    const again = await screen.findByRole("dialog", { name: "New kit" });
    expect(within(again).getByLabelText("Name")).toHaveValue("");
    expect(
      within(again).queryByRole("list", { name: "Kit segments" }),
    ).toBeNull();
  });

  it("has no axe violations open with entries", async () => {
    const { user, view } = await openSheet();
    await add(user, "Cold open");
    await add(user, "Cold open");
    await expectNoA11yViolations(view.baseElement);
  });

  it("uses the bottom sheet on a phone", async () => {
    stubViewportShell("phone");
    const { dialog } = await openSheet();
    expect(within(dialog).getByLabelText("Name")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save kit" })).toBeVisible();
  });
});

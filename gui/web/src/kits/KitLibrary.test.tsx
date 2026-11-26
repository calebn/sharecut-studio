import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/kits";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { deferred } from "../test/deferred";
import { ApiError } from "../utils/apiError";
import { DAMAGED, HEALTHY, KITS, MULTI_VERSION, UNUSABLE } from "./fixtures";
import { KitLibrary } from "./KitLibrary";
import { useKitLibrary } from "./useKitLibrary";

vi.mock("../api/kits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/kits")>()),
  loadKits: vi.fn(),
  downloadKitFile: vi.fn(),
}));

const load = vi.mocked(api.loadKits);
const download = vi.mocked(api.downloadKitFile);

function Section({ omitWhenEmpty = false }: { omitWhenEmpty?: boolean }) {
  const library = useKitLibrary(true);
  return <KitLibrary library={library} omitWhenEmpty={omitWhenEmpty} />;
}

const FILE = { blob: new Blob(["zip"]), filename: "show-kit.sharecutkit" };

beforeEach(() => {
  load.mockReset().mockResolvedValue(KITS);
  download.mockReset().mockResolvedValue(FILE);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  URL.createObjectURL = vi.fn(() => "blob:kit");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  useDawStore.setState({ guestMode: null, statusAnnouncement: "" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function ready() {
  const view = render(<Section />);
  await screen.findByText("Show Kit");
  return view;
}

describe("KitLibrary", () => {
  it("lists each kit with its name, version tag and entry count", async () => {
    await ready();
    const list = screen.getByRole("list", { name: "Saved kits" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    const show = screen.getByText(HEALTHY.name).closest("li") as HTMLElement;
    expect(within(show).getByText("v1")).toBeVisible();
    expect(within(show).getByText("2 segments")).toBeVisible();
    const summer = screen
      .getByText(MULTI_VERSION.name)
      .closest("li") as HTMLElement;
    expect(within(summer).getByText("1 segment")).toBeVisible();
    expect(within(summer).getByText("v3 · 3 versions")).toBeVisible();
  });

  it("keeps an unusable kit listed with a warning chip and the server's problem, and offers no export", async () => {
    await ready();
    const row = screen.getByText(UNUSABLE.name).closest("li") as HTMLElement;
    expect(
      within(row).getByText("Can't be added to an episode yet"),
    ).toBeVisible();
    expect(within(row).getByText(UNUSABLE.problem as string)).toBeVisible();
    expect(
      within(row).getByText(
        "It can't be exported until its segments are back in the library.",
      ),
    ).toBeVisible();
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("names a damaged kit plainly, shows its id and problem, and offers no actions", async () => {
    await ready();
    const row = screen.getByText(DAMAGED.id).closest("li") as HTMLElement;
    expect(within(row).getByText("Unreadable kit")).toBeVisible();
    expect(within(row).getByText("Can't be read")).toBeVisible();
    expect(within(row).getByText(DAMAGED.problem)).toBeVisible();
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("names the section and its list differently", async () => {
    await ready();
    expect(screen.getByRole("region", { name: "Kits" })).toBeVisible();
    expect(screen.queryAllByRole("list", { name: "Kits" })).toHaveLength(0);
    expect(screen.getByRole("list", { name: "Saved kits" })).toBeVisible();
  });

  it("exports through More once and announces the saved file", async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(
      screen.getByRole("button", { name: "More actions for Show Kit" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Export as file" }),
    );
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Saved show-kit.sharecutkit",
      ),
    );
    expect(download).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith(HEALTHY.id);
  });

  it("ignores a second export while one is running", async () => {
    const user = userEvent.setup();
    const pending = deferred<typeof FILE>();
    download.mockReturnValueOnce(pending.promise);
    await ready();
    for (const name of ["Show Kit", "Summer series"]) {
      await user.click(
        screen.getByRole("button", { name: `More actions for ${name}` }),
      );
      await user.click(
        await screen.findByRole("menuitem", { name: "Export as file" }),
      );
    }
    expect(download).toHaveBeenCalledTimes(1);
    pending.resolve(FILE);
  });

  async function exportShowKit(user: ReturnType<typeof userEvent.setup>) {
    await user.click(
      screen.getByRole("button", { name: "More actions for Show Kit" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Export as file" }),
    );
  }

  it("shows the server's words once, in one alert, when the export fails", async () => {
    const user = userEvent.setup();
    download.mockRejectedValue(new Error("The disk is full."));
    await ready();
    await exportShowKit(user);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The disk is full.");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(useDawStore.getState().statusAnnouncement).not.toContain(
      "The disk is full.",
    );
    expect(load).toHaveBeenCalledTimes(1);
  });

  it.each([
    [404, "kit_unknown", "That kit is not in the library."],
    [
      409,
      "kit_segment_missing",
      "1 segment of this kit is not in the library.",
    ],
  ])(
    "shows a %i answer and reads the list again",
    async (status, code, message) => {
      const user = userEvent.setup();
      download.mockRejectedValue(new ApiError(message, code, status));
      await ready();
      load.mockResolvedValue([{ ...HEALTHY, usable: false, missing: 1 }]);
      await exportShowKit(user);
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      const row = (await screen.findByText(HEALTHY.name)).closest(
        "li",
      ) as HTMLElement;
      await waitFor(() => expect(within(row).queryByRole("button")).toBeNull());
    },
  );

  it("announces the loading state through a status region that is already mounted", async () => {
    const pending = deferred<typeof KITS>();
    load.mockReturnValue(pending.promise);
    render(<Section />);
    const status = screen.getAllByRole("status")[0];
    expect(status).toHaveTextContent("Loading the kits");
    pending.resolve(KITS);
    await screen.findByText("Show Kit");
    expect(screen.getAllByRole("status")[0]).toBe(status);
    expect(status).toBeEmptyDOMElement();
  });

  it("says there are no kits", async () => {
    load.mockResolvedValue([]);
    render(<Section />);
    expect(await screen.findByText(/No kits yet/)).toBeVisible();
  });

  it("is left out on Home when there are no kits and nothing went wrong", async () => {
    load.mockResolvedValue([]);
    const { container } = render(<Section omitWhenEmpty />);
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a failed read with Try again on Home, and recovers", async () => {
    const user = userEvent.setup();
    load.mockRejectedValueOnce(new Error("The studio did not answer."));
    render(<Section omitWhenEmpty />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The studio did not answer.",
    );
    await user.click(
      screen.getByRole("button", { name: "Try again to load the kits" }),
    );
    expect(await screen.findByText("Show Kit")).toBeVisible();
  });

  it("renders nothing for a guest", async () => {
    useDawStore.setState({ guestMode: "viewer" });
    const { container } = render(<Section />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is axe-clean", async () => {
    const { container } = await ready();
    await expectNoA11yViolations(container);
  });
});

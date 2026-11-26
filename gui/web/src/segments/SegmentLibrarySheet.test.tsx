import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as kitsApi from "../api/kits";
import * as api from "../api/segments";
import { KITS } from "../kits/fixtures";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { deferred } from "../test/deferred";
import { stubViewportShell } from "../test/viewportShell";
import { stopAudition } from "./audition";
import { LIBRARY } from "./fixtures";
import { SegmentLibrarySheet } from "./SegmentLibrarySheet";

vi.mock("../api/segments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/segments")>()),
  loadSegments: vi.fn(),
  removeSegment: vi.fn(),
}));

vi.mock("../api/kits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/kits")>()),
  loadKits: vi.fn(),
}));

const loadKits = vi.mocked(kitsApi.loadKits);
const load = vi.mocked(api.loadSegments);
const removeSegment = vi.mocked(api.removeSegment);
const pause = vi.fn();

beforeEach(() => {
  loadKits.mockReset().mockResolvedValue([]);
  load.mockReset().mockResolvedValue(LIBRARY);
  removeSegment.mockReset().mockResolvedValue(undefined);
  pause.mockClear();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(
    async () => {},
  );
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});

afterEach(() => {
  act(() => stopAudition());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SegmentLibrarySheet", () => {
  it("lists the kits below the segments under their own heading", async () => {
    stubViewportShell("desktop");
    loadKits.mockResolvedValue(KITS);
    const { baseElement } = render(
      <SegmentLibrarySheet open onClose={vi.fn()} />,
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Segment library",
    });
    const kits = await within(dialog).findByRole("region", { name: "Kits" });
    expect(within(kits).getAllByRole("listitem")).toHaveLength(4);
    expect(
      within(dialog).getAllByRole("heading", { name: "Kits" }),
    ).toHaveLength(1);
    await expectNoA11yViolations(baseElement);
  });

  it("says there are no kits in the sheet, and reads none for a guest", async () => {
    stubViewportShell("desktop");
    const { unmount } = render(<SegmentLibrarySheet open onClose={vi.fn()} />);
    expect(await screen.findByText(/No kits yet/)).toBeVisible();
    unmount();
    loadKits.mockClear();
    useDawStore.setState({ guestMode: "viewer" });
    try {
      render(<SegmentLibrarySheet open onClose={vi.fn()} />);
      await screen.findByRole("list", { name: "Segment library" });
      expect(screen.queryByRole("region", { name: "Kits" })).toBeNull();
      expect(loadKits).not.toHaveBeenCalled();
    } finally {
      useDawStore.setState({ guestMode: null });
    }
  });

  it("reads the kits again each time the sheet opens, without a second fetch of its own", async () => {
    stubViewportShell("desktop");
    const reload = vi.fn();
    const kits = { rows: KITS, error: null, reload };
    const { rerender } = render(
      <SegmentLibrarySheet open={false} onClose={vi.fn()} kits={kits} />,
    );
    expect(reload).not.toHaveBeenCalled();
    rerender(<SegmentLibrarySheet open onClose={vi.fn()} kits={kits} />);
    await screen.findByRole("region", { name: "Kits" });
    expect(reload).toHaveBeenCalledTimes(1);
    rerender(
      <SegmentLibrarySheet open={false} onClose={vi.fn()} kits={kits} />,
    );
    rerender(<SegmentLibrarySheet open onClose={vi.fn()} kits={kits} />);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(loadKits).not.toHaveBeenCalled();
  });

  it("does not reload handed kits for a guest", async () => {
    stubViewportShell("desktop");
    useDawStore.setState({ guestMode: "viewer" });
    try {
      const reload = vi.fn();
      render(
        <SegmentLibrarySheet
          open
          onClose={vi.fn()}
          kits={{ rows: KITS, error: null, reload }}
        />,
      );
      await screen.findByRole("list", { name: "Segment library" });
      expect(screen.queryByRole("region", { name: "Kits" })).toBeNull();
      expect(reload).not.toHaveBeenCalled();
      expect(loadKits).not.toHaveBeenCalled();
    } finally {
      useDawStore.setState({ guestMode: null });
    }
  });

  it("reads nothing while closed", () => {
    stubViewportShell("desktop");
    render(<SegmentLibrarySheet open={false} onClose={vi.fn()} />);
    expect(load).not.toHaveBeenCalled();
  });

  it.each(["desktop", "phone"] as const)(
    "lists the segments as a list in a dialog named Segment library on %s",
    async (shell) => {
      stubViewportShell(shell);
      const { baseElement } = render(
        <SegmentLibrarySheet open onClose={vi.fn()} />,
      );
      const dialog = await screen.findByRole("dialog", {
        name: "Segment library",
      });
      expect(
        await within(dialog).findByRole("list", { name: "Segment library" }),
      ).toBeVisible();
      expect(within(dialog).getAllByRole("listitem")).toHaveLength(3);
      await expectNoA11yViolations(baseElement);
    },
  );

  it("stops the audition when the sheet closes", async () => {
    stubViewportShell("desktop");
    const user = userEvent.setup();
    const { rerender } = render(<SegmentLibrarySheet open onClose={vi.fn()} />);
    await user.click(
      await screen.findByRole("button", { name: "Play Cold open" }),
    );
    pause.mockClear();
    rerender(<SegmentLibrarySheet open={false} onClose={vi.fn()} />);
    await waitFor(() => expect(pause).toHaveBeenCalled());
  });

  it("closes from the Close button", async () => {
    stubViewportShell("desktop");
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SegmentLibrarySheet open onClose={onClose} />);
    const dialog = await screen.findByRole("dialog", {
      name: "Segment library",
    });
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("does not close on Escape while a removal is in flight", async () => {
    stubViewportShell("desktop");
    const pending = deferred();
    removeSegment.mockReturnValueOnce(pending.promise);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SegmentLibrarySheet open onClose={onClose} />);
    await user.click(
      await screen.findByRole("button", {
        name: "More actions for Acme sponsor read",
      }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Remove from library" }),
    );
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    load.mockResolvedValue([LIBRARY[0]]);
    await act(async () => pending.resolve());
    expect(
      await screen.findByText("Removed Acme sponsor read from the library."),
    ).toBeVisible();
  });
});

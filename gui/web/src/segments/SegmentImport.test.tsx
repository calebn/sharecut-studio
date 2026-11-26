import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/segments";
import { useDawStore } from "../state/dawStore";
import { BundleImportHost } from "../system/importSheet/BundleImportHost";
import { expectNoA11yViolations } from "../test/a11y";
import { deferred } from "../test/deferred";
import { stubViewportShell } from "../test/viewportShell";
import { zipFile } from "../test/zipFile";
import { ApiError } from "../utils/apiError";
import { stopAudition } from "./audition";
import { HEALTHY, LIBRARY, SEGMENT_FILE, segment, waiting } from "./fixtures";
import { SegmentLibrary } from "./SegmentLibrary";
import { useSegmentLibrary } from "./useSegmentLibrary";

vi.mock("../api/segments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/segments")>()),
  loadSegments: vi.fn(),
  previewSegmentImport: vi.fn(),
  commitSegmentImport: vi.fn(),
  cancelSegmentImport: vi.fn(),
  downloadSegmentFile: vi.fn(),
}));
vi.mock("../sessionAuth", () => ({
  withSessionTokenQuery: (url: string) => `${url}&token=t`,
}));

const load = vi.mocked(api.loadSegments);
const preview = vi.mocked(api.previewSegmentImport);
const commit = vi.mocked(api.commitSegmentImport);
const cancel = vi.mocked(api.cancelSegmentImport);
const download = vi.mocked(api.downloadSegmentFile);
const play = vi.fn(async function (this: HTMLMediaElement) {});
let createObjectURL = vi.fn();
let revokeObjectURL = vi.fn();
const TOKEN = "a".repeat(32);

function Section() {
  const library = useSegmentLibrary();
  return (
    <BundleImportHost segments={library}>
      <SegmentLibrary library={library} layout="list" />
    </BundleImportHost>
  );
}

const announced = () => useDawStore.getState().statusAnnouncement;
const picker = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>(
    "input[type=file]",
  ) as HTMLInputElement;

beforeEach(() => {
  stubViewportShell("desktop");
  load.mockReset().mockResolvedValue(LIBRARY);
  preview.mockReset().mockResolvedValue(waiting());
  commit
    .mockReset()
    .mockResolvedValue({ status: "added", id: "cold-open-new", version: 1 });
  cancel.mockReset().mockResolvedValue(undefined);
  download.mockReset();
  play.mockClear();
  useDawStore.setState({ guestMode: null, statusAnnouncement: "" });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});

afterEach(() => {
  act(() => stopAudition());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function chooseFile() {
  const user = userEvent.setup();
  const view = render(<Section />);
  await screen.findByRole("button", { name: "Play Cold open" });
  await user.upload(picker(view.container), SEGMENT_FILE());
  return { user, view };
}

describe("Import", () => {
  it("is a native button that opens the file picker, accepting segment files, kit files and zip", async () => {
    const view = render(<Section />);
    const button = await screen.findByRole("button", { name: "Import" });
    const input = picker(view.container);
    expect(input).toHaveAttribute(
      "accept",
      ".sharecutseg,.sharecutkit,application/zip",
    );
    expect(input).not.toHaveAttribute("multiple");
    const open = vi.spyOn(input, "click");
    await userEvent.click(button);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("shows the checking line while the file uploads, with Cancel", async () => {
    const pending = deferred<api.SegmentImportPreview>();
    preview.mockReturnValueOnce(pending.promise);
    await chooseFile();
    const sheet = await screen.findByRole("dialog", {
      name: "Import a segment",
    });
    expect(within(sheet).getByRole("status")).toHaveTextContent(
      "Checking cold-open.sharecutseg…",
    );
    expect(within(sheet).getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it.each([
    [
      "added",
      { outcome: "added" as const },
      "Adds Cold open",
      "Add to library",
    ],
    [
      "new_version",
      { outcome: "new_version" as const, version: 2 },
      "Adds as Cold open v2",
      "Add to library",
    ],
    [
      "unchanged",
      { outcome: "unchanged" as const, existing_id: "intro-9f3a" },
      "Already in your library",
      "Show in library",
    ],
  ])(
    "previews the name, kind, length and outcome: %s",
    async (_name, over, line, primary) => {
      preview.mockResolvedValue(waiting(over));
      await chooseFile();
      const sheet = await screen.findByRole("dialog", {
        name: "Import a segment",
      });
      expect(within(sheet).getByText("Cold open")).toBeVisible();
      expect(within(sheet).getByText("Intro")).toBeVisible();
      expect(within(sheet).getByText("0:12")).toBeVisible();
      expect(within(sheet).getByText(line)).toBeVisible();
      expect(
        within(sheet).getByRole("button", { name: primary }),
      ).toBeEnabled();
      expect(
        within(sheet).getByRole("button", { name: "Play Cold open" }),
      ).toBeVisible();
      expect(commit).not.toHaveBeenCalled();
      expect(load).toHaveBeenCalledTimes(1);
    },
  );

  it("names a segment with several clips by their count", async () => {
    preview.mockResolvedValue(waiting({ clip_count: 3 }));
    await chooseFile();
    expect(await screen.findByText("3 clips")).toBeVisible();
  });

  it("plays the waiting file's own clips, not a library segment", async () => {
    preview.mockResolvedValue(waiting({ clip_count: 2 }));
    const { user } = await chooseFile();
    const sheet = await screen.findByRole("dialog", {
      name: "Import a segment",
    });
    await user.click(
      within(sheet).getByRole("button", { name: "Play Cold open" }),
    );
    expect(play).toHaveBeenCalledTimes(1);
    const element = play.mock.contexts[0] as unknown as HTMLMediaElement;
    expect(element.src).toContain(`/api/segments/import/${TOKEN}/audio?clip=0`);
    await user.click(
      within(sheet).getByRole("button", { name: "Stop Cold open" }),
    );
  });

  it("adds: says so in a toast, reloads the list and marks the new row", async () => {
    const { user } = await chooseFile();
    load.mockResolvedValue([
      ...LIBRARY,
      segment({ id: "cold-open-new", name: "Cold open (new)" }),
    ]);
    const sheet = await screen.findByRole("dialog", {
      name: "Import a segment",
    });

    await user.click(
      within(sheet).getByRole("button", { name: "Add to library" }),
    );

    await waitFor(() =>
      expect(announced()).toBe("Added Cold open to your library"),
    );
    expect(commit).toHaveBeenCalledWith(TOKEN);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Import a segment" }),
      ).toBeNull(),
    );
    const row = await screen.findByText("Cold open (new)");
    expect(row.closest("[data-segment-row]")).toHaveAttribute("data-new");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("returns focus to the Import button after the sheet closes", async () => {
    const { user } = await chooseFile();
    const sheet = await screen.findByRole("dialog", {
      name: "Import a segment",
    });
    await user.click(within(sheet).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Import" })).toHaveFocus(),
    );
    expect(cancel).toHaveBeenCalledWith(TOKEN);
    expect(commit).not.toHaveBeenCalled();
  });

  it("closes on Escape and removes the waiting file", async () => {
    const { user } = await chooseFile();
    await screen.findByRole("dialog", { name: "Import a segment" });
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Import a segment" }),
      ).toBeNull(),
    );
    expect(cancel).toHaveBeenCalledWith(TOKEN);
  });

  it("shows the already-in-library row without adding anything", async () => {
    preview.mockResolvedValue(
      waiting({ outcome: "unchanged", existing_id: HEALTHY.id }),
    );
    const { user } = await chooseFile();
    const sheet = await screen.findByRole("dialog", {
      name: "Import a segment",
    });
    await user.click(
      within(sheet).getByRole("button", { name: "Show in library" }),
    );
    await waitFor(() =>
      expect(announced()).toBe("Cold open is already in your library"),
    );
    expect(commit).not.toHaveBeenCalled();
    expect(
      (await screen.findByText("Cold open")).closest("[data-segment-row]"),
    ).toHaveAttribute("data-new");
  });

  it("shows a refused file's message in the card and adds nothing", async () => {
    preview.mockRejectedValue(
      new ApiError(
        "a.flac does not match its hash in MANIFEST.sha256.",
        "segment_hash_mismatch",
        422,
      ),
    );
    const { view } = await chooseFile();
    const sheet = await screen.findByRole("dialog", {
      name: "Import a segment",
    });
    expect(await within(sheet).findByRole("alert")).toHaveTextContent(
      "a.flac does not match its hash in MANIFEST.sha256.",
    );
    expect(within(sheet).getByText("cold-open.sharecutseg")).toBeVisible();
    expect(commit).not.toHaveBeenCalled();
    expect(
      within(sheet).queryByRole("button", { name: "Add to library" }),
    ).toBeNull();
    await expectNoA11yViolations(document.body);

    const open = vi.spyOn(picker(view.container), "click");
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Choose another file" }),
    );
    expect(open).toHaveBeenCalled();
  });

  it("keeps the card open with the reason when the library is busy", async () => {
    commit.mockRejectedValueOnce(
      new ApiError(
        "The segment library is being changed by another program.",
        "segment_busy",
        409,
      ),
    );
    const { user } = await chooseFile();
    const sheet = await screen.findByRole("dialog", {
      name: "Import a segment",
    });
    await user.click(
      within(sheet).getByRole("button", { name: "Add to library" }),
    );
    expect(await within(sheet).findByRole("alert")).toHaveTextContent(
      "being changed by another program",
    );
    expect(
      within(sheet).getByRole("button", { name: "Add to library" }),
    ).toBeEnabled();
  });

  it("disables both buttons while adding", async () => {
    const pending = deferred<api.SegmentSaveResult>();
    commit.mockReturnValueOnce(pending.promise);
    const { user } = await chooseFile();
    const sheet = await screen.findByRole("dialog", {
      name: "Import a segment",
    });
    await user.click(
      within(sheet).getByRole("button", { name: "Add to library" }),
    );
    expect(
      within(sheet).getByRole("button", { name: "Adding…" }),
    ).toBeDisabled();
    expect(
      within(sheet).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    await act(async () =>
      pending.resolve({ status: "added", id: "x", version: 1 }),
    );
  });

  it("is a bottom sheet on a phone and axe-clean in both forms", async () => {
    stubViewportShell("phone");
    await chooseFile();
    const sheet = await screen.findByRole("dialog", {
      name: "Import a segment",
    });
    expect(sheet.className).toContain("bottom-sheet");
    await expectNoA11yViolations(document.body);
  });

  it("is axe-clean as a centered card", async () => {
    await chooseFile();
    await screen.findByRole("dialog", { name: "Import a segment" });
    await expectNoA11yViolations(document.body);
  });
});

describe("drop", () => {
  const dropOf = (files: File[]) => ({
    dataTransfer: { files, types: ["Files"], dropEffect: "none" },
  });

  async function list() {
    render(<Section />);
    const rows = await screen.findByRole("list", { name: "Segment library" });
    return rows.closest(".segment-library-body") as HTMLElement;
  }

  it("shows a drop state while a file is over the list and clears it on leave", async () => {
    const body = await list();
    fireEvent.dragOver(body, dropOf([SEGMENT_FILE()]));
    expect(body).toHaveAttribute("data-drop");
    expect(
      screen.getByText("Drop a segment or kit file to import it"),
    ).toBeInTheDocument();
    fireEvent.dragLeave(body, { relatedTarget: document.body });
    expect(body).not.toHaveAttribute("data-drop");
  });

  it("previews a dropped segment file", async () => {
    const body = await list();
    fireEvent.drop(body, dropOf([SEGMENT_FILE()]));
    await screen.findByRole("dialog", { name: "Import a segment" });
    expect(preview.mock.calls[0][0].name).toBe("cold-open.sharecutseg");
  });

  it("refuses a file that is not a segment or kit file, naming the extensions", async () => {
    const body = await list();
    const event = fireEvent.drop(
      body,
      dropOf([new File(["x"], "take.wav", { type: "audio/wav" })]),
    );
    expect(event).toBe(false);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That isn't a segment or kit file (.sharecutseg, .sharecutkit).",
    );
    expect(preview).not.toHaveBeenCalled();
  });

  it("takes one file at a time", async () => {
    const body = await list();
    fireEvent.drop(body, dropOf([SEGMENT_FILE(), SEGMENT_FILE()]));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Import one file at a time.",
    );
    expect(preview).not.toHaveBeenCalled();
  });

  it("matches the extension whatever its case", async () => {
    const body = await list();
    fireEvent.drop(body, dropOf([new File(["z"], "Cold.SHARECUTSEG")]));
    await screen.findByRole("dialog", { name: "Import a segment" });
  });

  it("leaves a drag that carries no files alone", async () => {
    const body = await list();
    const event = fireEvent.dragOver(body, {
      dataTransfer: { files: [], types: ["text/plain"] },
    });
    expect(event).toBe(true);
    expect(body).not.toHaveAttribute("data-drop");
  });
});

describe("guests and the empty library", () => {
  it("offers no import to a guest", async () => {
    useDawStore.setState({ guestMode: "viewer" });
    const view = render(<Section />);
    await screen.findByRole("button", { name: "Play Cold open" });
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
    expect(picker(view.container)).toBeNull();
    const body = view.container.querySelector(
      ".segment-library-body",
    ) as HTMLElement;
    fireEvent.drop(body, {
      dataTransfer: { files: [SEGMENT_FILE()], types: ["Files"] },
    });
    expect(preview).not.toHaveBeenCalled();
  });

  it("offers Import in the empty library too", async () => {
    load.mockResolvedValue([]);
    render(<Section />);
    expect(await screen.findByRole("button", { name: "Import" })).toBeVisible();
  });
});

describe("Export", () => {
  const file = (name = "cold-open.sharecutseg") => ({
    blob: new Blob(["zip"], { type: "application/zip" }),
    filename: name,
  });

  async function exportRow() {
    const user = userEvent.setup();
    render(<Section />);
    await user.click(
      await screen.findByRole("button", { name: "More actions for Cold open" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Export as file" }),
    );
    return user;
  }

  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(pointer: coarse)" ? false : false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    createObjectURL = vi.fn(() => "blob:segment");
    revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });

  it("is in the More menu of a readable row and not of a damaged one", async () => {
    const user = userEvent.setup();
    render(<Section />);
    await user.click(
      await screen.findByRole("button", {
        name: "More actions for outro-77de",
      }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Remove from library" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: "Export as file" }),
    ).toBeNull();
  });

  it("downloads the file by an object-URL anchor where the browser cannot share", async () => {
    download.mockResolvedValue(file());
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    await exportRow();
    await waitFor(() =>
      expect(announced()).toBe("Saved cold-open.sharecutseg"),
    );
    expect(download).toHaveBeenCalledWith(HEALTHY.id);
    expect(click).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalled();
  });

  it("shares the file with the share sheet on a touch device that can share files", async () => {
    download.mockResolvedValue(file());
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const share = vi.fn(async () => {});
    Object.assign(navigator, { canShare: () => true, share });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    await exportRow();
    await waitFor(() => expect(announced()).toBe("Shared Cold open"));
    const sent = (share.mock.calls[0] as unknown as [{ files: File[] }])[0]
      .files[0];
    expect(sent.name).toBe("cold-open.sharecutseg");
    expect(sent.type).toBe("application/zip");
    expect(click).not.toHaveBeenCalled();
    Reflect.deleteProperty(navigator, "canShare");
    Reflect.deleteProperty(navigator, "share");
  });

  it("treats closing the share sheet as a cancel, not an error", async () => {
    download.mockResolvedValue(file());
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const share = vi.fn(async () => {
      throw new DOMException("closed", "AbortError");
    });
    Object.assign(navigator, { canShare: () => true, share });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    await exportRow();
    await waitFor(() => expect(share).toHaveBeenCalled());
    expect(click).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    Reflect.deleteProperty(navigator, "canShare");
    Reflect.deleteProperty(navigator, "share");
  });

  it("falls back to a download when the share is refused for another reason", async () => {
    download.mockResolvedValue(file());
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const share = vi.fn(async () => {
      throw new DOMException("needs a tap", "NotAllowedError");
    });
    Object.assign(navigator, { canShare: () => true, share });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    await exportRow();
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    Reflect.deleteProperty(navigator, "canShare");
    Reflect.deleteProperty(navigator, "share");
  });

  it("says why when the export fails", async () => {
    download.mockRejectedValue(
      new ApiError("There is no segment called x.", "segment_unknown", 404),
    );
    await exportRow();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "There is no segment called x.",
    );
  });
});

describe("drops that must not leave Studio or replace a waiting file", () => {
  const filesOf = (files: File[]) => ({
    dataTransfer: { files, types: ["Files"], dropEffect: "none" },
  });

  it("claims a file dropped while the list is still loading and says to wait", async () => {
    load.mockReturnValue(new Promise(() => {}));
    const view = render(<Section />);
    const body = view.container.querySelector(
      ".segment-library-body",
    ) as HTMLElement;
    expect(fireEvent.dragOver(body, filesOf([SEGMENT_FILE()]))).toBe(false);
    expect(fireEvent.drop(body, filesOf([SEGMENT_FILE()]))).toBe(false);
    expect(preview).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Wait for the library to finish",
    );
  });

  it("claims a file dropped while an import is committing", async () => {
    commit.mockReturnValueOnce(new Promise(() => {}));
    const { user, view } = await chooseFile();
    const sheet = await screen.findByRole("dialog", {
      name: "Import a segment",
    });
    await user.click(
      within(sheet).getByRole("button", { name: "Add to library" }),
    );
    const body = view.container.querySelector(
      ".segment-library-body",
    ) as HTMLElement;
    expect(fireEvent.drop(body, filesOf([SEGMENT_FILE()]))).toBe(false);
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("does not replace the waiting file when a file is dropped on the preview sheet", async () => {
    await chooseFile();
    const sheet = await screen.findByRole("dialog", {
      name: "Import a segment",
    });
    expect(fireEvent.drop(sheet, filesOf([SEGMENT_FILE()]))).toBe(false);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("accepts a zip by its type and reads its entries to tell it is a segment", async () => {
    render(<Section />);
    const list = await screen.findByRole("list", { name: "Segment library" });
    const body = list.closest(".segment-library-body") as HTMLElement;
    fireEvent.drop(
      body,
      filesOf([zipFile("renamed (1).zip", ["segment.json", "clip-01.flac"])]),
    );
    await screen.findByRole("dialog", { name: "Import a segment" });
  });
});

describe("Export, host only and honest", () => {
  const made = { blob: new Blob(["zip"]), filename: "cold-open.sharecutseg" };
  const touch = () =>
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));

  beforeEach(() => {
    createObjectURL = vi.fn(() => "blob:segment");
    revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  async function open() {
    const user = userEvent.setup();
    render(<Section />);
    await user.click(
      await screen.findByRole("button", { name: "More actions for Cold open" }),
    );
    return user;
  }

  it("is not offered to a guest", async () => {
    useDawStore.setState({ guestMode: "viewer" });
    await open();
    await screen.findByRole("menuitem", { name: "Remove from library" });
    expect(
      screen.queryByRole("menuitem", { name: "Export as file" }),
    ).toBeNull();
  });

  it("builds one file for a double tap", async () => {
    const pending = deferred<typeof made>();
    download.mockReturnValue(pending.promise);
    const user = await open();
    await user.click(
      await screen.findByRole("menuitem", { name: "Export as file" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "More actions for Cold open" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Export as file" }),
    );
    expect(download).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(made));
  });

  it("keeps the object URL for a minute so the browser can finish saving", async () => {
    download.mockResolvedValue(made);
    const user = await open();
    await user.click(
      await screen.findByRole("menuitem", { name: "Export as file" }),
    );
    await waitFor(() =>
      expect(announced()).toBe("Saved cold-open.sharecutseg"),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("replaces the preparing line when the share sheet is closed", async () => {
    download.mockResolvedValue(made);
    touch();
    Object.assign(navigator, {
      canShare: () => true,
      share: async () => {
        throw new DOMException("closed", "AbortError");
      },
    });
    const user = await open();
    await user.click(
      await screen.findByRole("menuitem", { name: "Export as file" }),
    );
    await waitFor(() =>
      expect(announced()).toBe("Export of Cold open cancelled"),
    );
    Reflect.deleteProperty(navigator, "canShare");
    Reflect.deleteProperty(navigator, "share");
  });

  it("says the file was saved instead when the share needs a fresher tap", async () => {
    download.mockResolvedValue(made);
    touch();
    Object.assign(navigator, {
      canShare: () => true,
      share: async () => {
        throw new DOMException("needs a tap", "NotAllowedError");
      },
    });
    const user = await open();
    await user.click(
      await screen.findByRole("menuitem", { name: "Export as file" }),
    );
    await waitFor(() =>
      expect(announced()).toBe(
        "Saved cold-open.sharecutseg. This browser would not open the share sheet, so the file was saved instead.",
      ),
    );
    Reflect.deleteProperty(navigator, "canShare");
    Reflect.deleteProperty(navigator, "share");
  });

  it("replaces the preparing line with the failure", async () => {
    download.mockRejectedValue(
      new ApiError("There is no segment called x.", "segment_unknown", 404),
    );
    const user = await open();
    await user.click(
      await screen.findByRole("menuitem", { name: "Export as file" }),
    );
    await waitFor(() =>
      expect(announced()).toBe("There is no segment called x."),
    );
  });
});

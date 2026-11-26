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
import * as kitsApi from "../../api/kits";
import * as segmentsApi from "../../api/segments";
import { useWindowFileDrop } from "../../hooks/useWindowFileDrop";
import { KIT_FILE, KIT_TOKEN, waitingKit } from "../../kits/fixtures";
import { KitLibrary } from "../../kits/KitLibrary";
import type { KitLibraryState } from "../../kits/useKitLibrary";
import { SEGMENT_FILE, waiting } from "../../segments/fixtures";
import { SegmentLibrary } from "../../segments/SegmentLibrary";
import type { SegmentLibraryState } from "../../segments/useSegmentLibrary";
import { useDawStore } from "../../state/dawStore";
import { deferred } from "../../test/deferred";
import { stubViewportShell } from "../../test/viewportShell";
import { zipFile } from "../../test/zipFile";
import { ApiError } from "../../utils/apiError";
import { BundleImportHost } from "./BundleImportHost";

vi.mock("../../api/segments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/segments")>()),
  previewSegmentImport: vi.fn(),
  commitSegmentImport: vi.fn(),
  cancelSegmentImport: vi.fn(),
}));
vi.mock("../../api/kits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/kits")>()),
  previewKitImport: vi.fn(),
  commitKitImport: vi.fn(),
  cancelKitImport: vi.fn(),
}));

const previewSegment = vi.mocked(segmentsApi.previewSegmentImport);
const cancelSegment = vi.mocked(segmentsApi.cancelSegmentImport);
const previewKit = vi.mocked(kitsApi.previewKitImport);
const commitKit = vi.mocked(kitsApi.commitKitImport);
const cancelKit = vi.mocked(kitsApi.cancelKitImport);

const announced = () => useDawStore.getState().statusAnnouncement;

function libraries() {
  const segments: SegmentLibraryState = {
    rows: [],
    error: null,
    highlightId: null,
    reload: vi.fn(),
    reveal: vi.fn(),
    remove: vi.fn(async () => null),
  };
  const kits: KitLibraryState = { rows: [], error: null, reload: vi.fn() };
  return { segments, kits };
}

function Mounted({
  listening = true,
  state,
}: {
  listening?: boolean;
  state: ReturnType<typeof libraries>;
}) {
  return (
    <BundleImportHost
      segments={state.segments}
      kits={state.kits}
      listening={listening}
    >
      <SegmentLibrary library={state.segments} layout="list" />
      <KitLibrary library={state.kits} />
    </BundleImportHost>
  );
}

function dropOn(target: EventTarget, files: File[], types = ["Files"]) {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.assign(event, { dataTransfer: { files, types, dropEffect: "none" } });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  stubViewportShell("desktop");
  useDawStore.setState({ guestMode: null, statusAnnouncement: "" });
  previewSegment.mockReset().mockResolvedValue(waiting());
  cancelSegment.mockReset().mockResolvedValue(undefined);
  previewKit.mockReset().mockResolvedValue(waitingKit());
  commitKit.mockReset().mockResolvedValue({
    kit: { status: "added", id: "show-kit-1a2b3c4d", version: 1 },
    segments: [{ status: "added", id: "intro-new", version: 1 }],
  });
  cancelKit.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const picker = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>(
    "input[type=file]",
  ) as HTMLInputElement;

describe("one Import button", () => {
  it("takes a kit file and opens the kit sheet", async () => {
    const state = libraries();
    const view = render(<Mounted state={state} />);
    await userEvent.upload(picker(view.container), KIT_FILE());
    await screen.findByRole("dialog", { name: "Import a kit" });
    expect(previewKit.mock.calls[0][0].name).toBe("show-kit.sharecutkit");
    expect(previewSegment).not.toHaveBeenCalled();
  });

  it("takes a segment file and opens the segment sheet", async () => {
    const state = libraries();
    const view = render(<Mounted state={state} />);
    await userEvent.upload(picker(view.container), SEGMENT_FILE());
    await screen.findByRole("dialog", { name: "Import a segment" });
    expect(previewKit).not.toHaveBeenCalled();
  });

  it("is there with no segments and no kits, and with the kit section left out", async () => {
    const state = libraries();
    render(
      <BundleImportHost segments={state.segments}>
        <SegmentLibrary library={state.segments} layout="list" />
      </BundleImportHost>,
    );
    expect(await screen.findByRole("button", { name: "Import" })).toBeVisible();
  });

  it("tells a zip by its entry names and sends it to the import it belongs to", async () => {
    const state = libraries();
    const view = render(<Mounted state={state} />);
    await userEvent.upload(
      picker(view.container),
      zipFile("show (1).zip", ["kit.json", "MANIFEST.sha256"]),
    );
    await screen.findByRole("dialog", { name: "Import a kit" });
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.upload(
      picker(view.container),
      zipFile("intro.zip", ["segment.json", "clip-01.flac"]),
    );
    await screen.findByRole("dialog", { name: "Import a segment" });
  });

  it("says a file is neither and uploads nothing", async () => {
    const state = libraries();
    const view = render(<Mounted state={state} />);
    await userEvent.upload(
      picker(view.container),
      zipFile("notes.zip", ["notes.txt"]),
    );
    await waitFor(() =>
      expect(announced()).toBe(
        "That isn't a segment or kit file (.sharecutseg, .sharecutkit).",
      ),
    );
    expect(previewKit).not.toHaveBeenCalled();
    expect(previewSegment).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("adds a kit, reads both lists again, reveals the new segment and returns focus", async () => {
    const state = libraries();
    const view = render(<Mounted state={state} />);
    await userEvent.upload(picker(view.container), KIT_FILE());
    const sheet = await screen.findByRole("dialog", { name: "Import a kit" });
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Add to library" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(commitKit).toHaveBeenCalledWith(KIT_TOKEN);
    expect(announced()).toBe(
      "Added Show Kit to your library, with 1 new segment",
    );
    expect(state.kits.reload).toHaveBeenCalled();
    expect(state.segments.reveal).toHaveBeenCalledWith("intro-new");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Import" })).toHaveFocus(),
    );
  });

  it("reads both lists even when the add fails after some segments landed", async () => {
    commitKit.mockRejectedValueOnce(
      new (await import("../../utils/apiError")).ApiError(
        "Busy.",
        "kit_busy",
        409,
        null,
        {
          detail: "Busy.",
          segments_added: [{ status: "added", id: "a", version: 1 }],
          segments_total: 2,
        },
      ),
    );
    const state = libraries();
    const view = render(<Mounted state={state} />);
    await userEvent.upload(picker(view.container), KIT_FILE());
    const sheet = await screen.findByRole("dialog", { name: "Import a kit" });
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Add to library" }),
    );
    await within(sheet).findByText(/Added 1 of 2 segments/);
    expect(state.kits.reload).toHaveBeenCalledTimes(1);
    expect(state.segments.reload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "Import a kit" })).toBeVisible();
  });
});

describe("drop anywhere on the window", () => {
  it("previews a kit file dropped outside the list", async () => {
    const state = libraries();
    render(<Mounted state={state} />);
    await screen.findByRole("button", { name: "Import" });
    const event = dropOn(document.body, [KIT_FILE()]);
    expect(event.defaultPrevented).toBe(true);
    await screen.findByRole("dialog", { name: "Import a kit" });
    expect(previewKit).toHaveBeenCalledTimes(1);
  });

  it("previews a segment file, and a renamed kit zip by its entries", async () => {
    const state = libraries();
    render(<Mounted state={state} />);
    dropOn(document.body, [SEGMENT_FILE()]);
    await screen.findByRole("dialog", { name: "Import a segment" });
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    dropOn(document.body, [zipFile("x (1).zip", ["kit.json"])]);
    await screen.findByRole("dialog", { name: "Import a kit" });
  });

  it("takes a .zip by its name when the system gave it no type", async () => {
    const state = libraries();
    render(<Mounted state={state} />);
    dropOn(document.body, [zipFile("show (2).zip", ["kit.json"], "")]);
    await screen.findByRole("dialog", { name: "Import a kit" });
  });

  it("takes one file at a time", async () => {
    const state = libraries();
    render(<Mounted state={state} />);
    dropOn(document.body, [KIT_FILE(), SEGMENT_FILE()]);
    expect(announced()).toBe("Import one file at a time.");
    expect(previewKit).not.toHaveBeenCalled();
    expect(previewSegment).not.toHaveBeenCalled();
  });

  it("leaves audio and other drops to whoever else listens", () => {
    const state = libraries();
    render(<Mounted state={state} />);
    const event = dropOn(document.body, [
      new File(["x"], "take.wav", { type: "audio/wav" }),
    ]);
    expect(event.defaultPrevented).toBe(false);
    expect(previewKit).not.toHaveBeenCalled();
  });

  it("leaves a drag with no files, and a drop a nearer target took", async () => {
    const state = libraries();
    render(<Mounted state={state} />);
    expect(dropOn(document.body, [], ["text/plain"]).defaultPrevented).toBe(
      false,
    );
    const taken = new Event("drop", { bubbles: true, cancelable: true });
    Object.assign(taken, {
      dataTransfer: { files: [KIT_FILE()], types: ["Files"] },
    });
    taken.preventDefault();
    act(() => {
      document.body.dispatchEvent(taken);
    });
    await new Promise((done) => setTimeout(done, 30));
    expect(previewKit).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves a dragover a nearer target already accepted", () => {
    const state = libraries();
    render(<Mounted state={state} />);
    const over = new Event("dragover", { bubbles: true, cancelable: true });
    const transfer = { types: ["Files"], dropEffect: "none" };
    Object.assign(over, { dataTransfer: transfer });
    over.preventDefault();
    act(() => {
      document.body.dispatchEvent(over);
    });
    expect(transfer.dropEffect).toBe("none");
  });

  it("accepts the drag so the browser does not open the file", () => {
    const state = libraries();
    render(<Mounted state={state} />);
    const over = new Event("dragover", { bubbles: true, cancelable: true });
    Object.assign(over, {
      dataTransfer: { types: ["Files"], dropEffect: "none" },
    });
    act(() => {
      document.body.dispatchEvent(over);
    });
    expect(over.defaultPrevented).toBe(true);
  });

  it("refuses a second file while one is uploading or being added, whichever kind either is", async () => {
    const pending = deferred<kitsApi.KitImportPreview>();
    previewKit.mockReturnValueOnce(pending.promise);
    const state = libraries();
    render(<Mounted state={state} />);
    dropOn(document.body, [KIT_FILE()]);
    await screen.findByRole("dialog", { name: "Import a kit" });
    dropOn(document.body, [SEGMENT_FILE()]);
    await waitFor(() =>
      expect(announced()).toBe(
        "Wait for the library to finish, then drop the file again.",
      ),
    );
    expect(previewSegment).not.toHaveBeenCalled();
    expect(previewKit).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(waitingKit()));
  });

  it("refuses a second file while the first is still being checked", async () => {
    const state = libraries();
    render(<Mounted state={state} />);
    dropOn(document.body, [zipFile("a.zip", ["kit.json"])]);
    dropOn(document.body, [zipFile("b.zip", ["kit.json"])]);
    expect(announced()).toMatch(/Wait for the library/);
    await screen.findByRole("dialog", { name: "Import a kit" });
    expect(previewKit).toHaveBeenCalledTimes(1);
  });

  it("replaces a waiting preview with the next file", async () => {
    const state = libraries();
    render(<Mounted state={state} />);
    dropOn(document.body, [KIT_FILE()]);
    await screen.findByRole("dialog", { name: "Import a kit" });
    dropOn(document.body, [SEGMENT_FILE()]);
    await screen.findByRole("dialog", { name: "Import a segment" });
    expect(cancelKit).toHaveBeenCalledWith(KIT_TOKEN);
  });

  it.each([
    ["kit", () => previewKit, () => KIT_FILE(), "Import a kit"],
    ["segment", () => previewSegment, () => SEGMENT_FILE(), "Import a segment"],
  ])(
    "takes a second file from the %s error sheet",
    async (_kind, preview, file, title) => {
      const state = libraries();
      const view = render(<Mounted state={state} />);
      preview().mockRejectedValueOnce(
        new ApiError("Damaged.", "x_invalid", 422),
      );
      await userEvent.upload(picker(view.container), file());
      const sheet = await screen.findByRole("dialog", { name: title });
      await within(sheet).findByRole("alert");
      await userEvent.upload(picker(view.container), file());
      await waitFor(() => expect(preview()).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      expect(announced()).not.toMatch(/Wait for the library/);
      dropOn(document.body, [file()]);
      await waitFor(() => expect(preview()).toHaveBeenCalledTimes(3));
    },
  );

  it("imports the bundle in a mixed drop and says the audio was not added", async () => {
    const onFiles = vi.fn();
    function Both({ state }: { state: ReturnType<typeof libraries> }) {
      useWindowFileDrop(true, onFiles);
      return <Mounted state={state} />;
    }
    const state = libraries();
    render(<Both state={state} />);
    const wav = new File(["x"], "take.wav", { type: "audio/wav" });
    dropOn(document.body, [wav, KIT_FILE()]);
    await screen.findByRole("dialog", { name: "Import a kit" });
    expect(announced()).toBe(
      "Audio in the same drop wasn't added. Drop it on its own.",
    );
    expect(onFiles).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    dropOn(document.body, [wav]);
    expect(onFiles).toHaveBeenCalledWith([wav]);
  });

  it("says nothing about audio when the bundle comes with other files only", async () => {
    const state = libraries();
    render(<Mounted state={state} />);
    dropOn(document.body, [
      new File(["x"], "notes.txt", { type: "text/plain" }),
      KIT_FILE(),
    ]);
    await screen.findByRole("dialog", { name: "Import a kit" });
    expect(announced()).toBe("");
  });

  it("does not listen while it is told not to", () => {
    const state = libraries();
    render(<Mounted state={state} listening={false} />);
    const event = dropOn(document.body, [KIT_FILE()]);
    expect(event.defaultPrevented).toBe(false);
    expect(previewKit).not.toHaveBeenCalled();
  });

  it("stops listening when it unmounts", () => {
    const state = libraries();
    const view = render(<Mounted state={state} />);
    view.unmount();
    expect(dropOn(document.body, [KIT_FILE()]).defaultPrevented).toBe(false);
  });
});

describe("after the add", () => {
  it("reads the segment list again when a kit added no new segment, and reveals none", async () => {
    commitKit.mockResolvedValueOnce({
      kit: { status: "new_version", id: "show-kit-1a2b3c4d", version: 2 },
      segments: [{ status: "unchanged", id: "intro", version: 1 }],
    });
    const state = libraries();
    render(<Mounted state={state} />);
    dropOn(document.body, [KIT_FILE()]);
    const sheet = await screen.findByRole("dialog", { name: "Import a kit" });
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Add to library" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(state.segments.reload).toHaveBeenCalledTimes(1);
    expect(state.kits.reload).toHaveBeenCalledTimes(1);
    expect(state.segments.reveal).not.toHaveBeenCalled();
  });

  it("does not read the segment list a second time when a segment was revealed", async () => {
    const state = libraries();
    render(<Mounted state={state} />);
    dropOn(document.body, [KIT_FILE()]);
    const sheet = await screen.findByRole("dialog", { name: "Import a kit" });
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Add to library" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(state.segments.reload).not.toHaveBeenCalled();
    expect(state.segments.reveal).toHaveBeenCalledWith("intro-new");
  });
});

describe("unmounting", () => {
  it("starts no upload for a file still being read when the host goes away", async () => {
    const state = libraries();
    const view = render(<Mounted state={state} />);
    dropOn(document.body, [zipFile("a.zip", ["kit.json"])]);
    view.unmount();
    await new Promise((done) => setTimeout(done, 30));
    expect(previewKit).not.toHaveBeenCalled();
    expect(previewSegment).not.toHaveBeenCalled();
  });

  it("aborts an upload and cancels its token when the host goes away", async () => {
    const pending = deferred<kitsApi.KitImportPreview>();
    previewKit.mockReturnValueOnce(pending.promise);
    const state = libraries();
    const view = render(<Mounted state={state} />);
    dropOn(document.body, [KIT_FILE()]);
    await waitFor(() => expect(previewKit).toHaveBeenCalledTimes(1));
    const signal = previewKit.mock.calls[0][1] as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(waitingKit()));
    expect(cancelKit).toHaveBeenCalledWith(KIT_TOKEN);
  });
});

describe("a guest", () => {
  beforeEach(() => {
    useDawStore.setState({ guestMode: "review" });
  });

  it("renders its children only, with no Import and no window listener", async () => {
    const add = vi.spyOn(document, "addEventListener");
    const state = libraries();
    render(<Mounted state={state} />);
    await screen.findByText(/No saved segments yet/);
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
    expect(add.mock.calls.map((call) => call[0])).not.toContain("drop");
    expect(add.mock.calls.map((call) => call[0])).not.toContain("dragover");
    const event = dropOn(document.body, [KIT_FILE()]);
    expect(event.defaultPrevented).toBe(false);
    expect(previewKit).not.toHaveBeenCalled();
    expect(previewSegment).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the list's own drop", () => {
  it("routes a kit dropped on the segment list the same way", async () => {
    const state = libraries();
    render(<Mounted state={state} />);
    const body = (await screen.findByText(/No saved segments yet/)).closest(
      ".segment-library-body",
    ) as HTMLElement;
    fireEvent.drop(body, {
      dataTransfer: { files: [KIT_FILE()], types: ["Files"] },
    });
    await screen.findByRole("dialog", { name: "Import a kit" });
    expect(previewKit).toHaveBeenCalledTimes(1);
  });
});

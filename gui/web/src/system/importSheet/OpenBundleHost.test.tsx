import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as inboxApi from "../../api/inbox";
import * as kitsApi from "../../api/kits";
import * as segmentsApi from "../../api/segments";
import {
  _resetOpenBundleQueueForTests,
  OPEN_BUNDLE_EVENT,
  OPEN_BUNDLE_QUEUE_KEY,
} from "../../desktop/openBundleQueue";
import {
  _resetPageCloseRiskForTests,
  CLOSE_GUARD_PARAM,
} from "../../desktop/useDesktopCloseGuard";
import { KitLibrary } from "../../kits/KitLibrary";
import { useKitLibrary } from "../../kits/useKitLibrary";
import { SEGMENT_FILE, waiting } from "../../segments/fixtures";
import { SegmentLibrary } from "../../segments/SegmentLibrary";
import { useSegmentLibrary } from "../../segments/useSegmentLibrary";
import { useDawStore } from "../../state/dawStore";
import { stubViewportShell } from "../../test/viewportShell";
import { ApiError } from "../../utils/apiError";
import { BundleImportHost } from "./BundleImportHost";
import {
  OPEN_FILE_FAILED,
  OPEN_FILE_GONE,
  OPEN_FILE_TOO_LARGE,
} from "./bundleCopy";
import {
  FINISH_THE_TAKE,
  MAX_RECEIVED_BYTES,
  OpenBundleHost,
} from "./OpenBundleHost";
import { _resetOpenImportForTests, holdOpenImport } from "./openImportSignal";

const { isTauri } = vi.hoisted(() => ({ isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri }));
vi.mock("../../api/inbox", () => ({
  fetchInboxFile: vi.fn(),
  dropInboxFile: vi.fn(),
}));
vi.mock("../../api/segments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/segments")>()),
  loadSegments: vi.fn(),
  previewSegmentImport: vi.fn(),
  commitSegmentImport: vi.fn(),
  cancelSegmentImport: vi.fn(),
}));
vi.mock("../../api/kits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/kits")>()),
  loadKits: vi.fn(),
  previewKitImport: vi.fn(),
  cancelKitImport: vi.fn(),
}));

const fetchInbox = vi.mocked(inboxApi.fetchInboxFile);
const dropInbox = vi.mocked(inboxApi.dropInboxFile);
const loadSegments = vi.mocked(segmentsApi.loadSegments);
const loadKits = vi.mocked(kitsApi.loadKits);
const previewSegment = vi.mocked(segmentsApi.previewSegmentImport);
const commitSegment = vi.mocked(segmentsApi.commitSegmentImport);
const cancelSegment = vi.mocked(segmentsApi.cancelSegmentImport);

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ID_2 = "1f8fad5b-d9cb-469f-a165-70867728950e";
const NAME = "cold-open.sharecutseg";
const said = () => useDawStore.getState().statusAnnouncement;

function push(id = ID, name = NAME, size = 1000) {
  const holder = window as unknown as Record<string, unknown[] | undefined>;
  const queue = holder[OPEN_BUNDLE_QUEUE_KEY] ?? [];
  queue.push({ id, name, size });
  holder[OPEN_BUNDLE_QUEUE_KEY] = queue;
  act(() => {
    window.dispatchEvent(new CustomEvent(OPEN_BUNDLE_EVENT));
  });
}

/** What Home and the Library sheet each are: a host with its own lists, listening for drops. */
function ListHost({ label }: { label: string }) {
  const segments = useSegmentLibrary(true);
  const kits = useKitLibrary(true);
  return (
    <BundleImportHost segments={segments} kits={kits}>
      <section aria-label={label}>
        <SegmentLibrary library={segments} layout="list" />
        <KitLibrary library={kits} />
      </section>
    </BundleImportHost>
  );
}

beforeEach(() => {
  stubViewportShell("desktop");
  isTauri.mockReturnValue(true);
  useDawStore.setState({ guestMode: null, statusAnnouncement: "" });
  fetchInbox.mockReset().mockResolvedValue(SEGMENT_FILE());
  dropInbox.mockReset().mockResolvedValue(undefined);
  loadSegments.mockReset().mockResolvedValue([]);
  loadKits.mockReset().mockResolvedValue([]);
  previewSegment.mockReset().mockResolvedValue(waiting());
  commitSegment
    .mockReset()
    .mockResolvedValue({ status: "added", id: "cold-open-1", version: 1 });
  cancelSegment.mockReset().mockResolvedValue(undefined);
  vi.mocked(kitsApi.cancelKitImport).mockResolvedValue(undefined);
  _resetOpenBundleQueueForTests();
  _resetOpenImportForTests();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  _resetPageCloseRiskForTests();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

const sheet = () => screen.findByRole("dialog", { name: "Import a segment" });

describe("OpenBundleHost", () => {
  it("stages a file queued before it mounted, reading it by id and dropping the inbox copy", async () => {
    push();
    render(<OpenBundleHost />);
    await sheet();
    expect(fetchInbox).toHaveBeenCalledExactlyOnceWith(
      ID,
      NAME,
      expect.any(AbortSignal),
    );
    expect(dropInbox).toHaveBeenCalledExactlyOnceWith(ID);
    expect(previewSegment.mock.calls[0][0].name).toBe("cold-open.sharecutseg");
  });

  it("stages a file pushed while it is mounted, and each id once", async () => {
    render(<OpenBundleHost />);
    expect(fetchInbox).not.toHaveBeenCalled();
    push();
    push();
    await sheet();
    expect(fetchInbox).toHaveBeenCalledTimes(1);
  });

  it("renders nothing and reads nothing outside the app", async () => {
    isTauri.mockReturnValue(false);
    push();
    const view = render(<OpenBundleHost />);
    expect(view.container).toBeEmptyDOMElement();
    expect(document.querySelector("input[type=file]")).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchInbox).not.toHaveBeenCalled();
    expect(
      (window as unknown as Record<string, unknown[]>)[OPEN_BUNDLE_QUEUE_KEY],
    ).toHaveLength(1);
  });

  it("renders nothing for a guest", async () => {
    useDawStore.setState({ guestMode: "review" } as never);
    push();
    const view = render(<OpenBundleHost />);
    expect(view.container).toBeEmptyDOMElement();
    expect(document.querySelector("input[type=file]")).toBeNull();
    expect(fetchInbox).not.toHaveBeenCalled();
  });

  it("says the file can't be found on a 404 and leaves nothing to delete", async () => {
    fetchInbox.mockRejectedValue(
      new ApiError("gone", "import_inbox_unknown", 404),
    );
    push();
    render(<OpenBundleHost />);
    await waitFor(() => expect(said()).toBe(OPEN_FILE_GONE));
    expect(OPEN_FILE_GONE).toContain("can't be found");
    expect(dropInbox).not.toHaveBeenCalled();
    expect(previewSegment).not.toHaveBeenCalled();
  });

  it("says it couldn't open the file on a network failure and drops the copy", async () => {
    fetchInbox.mockRejectedValue(new ApiError("offline", "network_error"));
    push();
    render(<OpenBundleHost />);
    await waitFor(() => expect(said()).toBe(OPEN_FILE_FAILED));
    expect(dropInbox).toHaveBeenCalledExactlyOnceWith(ID);
    expect(previewSegment).not.toHaveBeenCalled();
  });

  it("refuses a file over the in-memory ceiling before reading it", async () => {
    push(ID, NAME, MAX_RECEIVED_BYTES + 1);
    render(<OpenBundleHost />);
    await waitFor(() => expect(said()).toBe(OPEN_FILE_TOO_LARGE));
    expect(fetchInbox).not.toHaveBeenCalled();
    expect(dropInbox).toHaveBeenCalledExactlyOnceWith(ID);
  });

  it("refuses a file that is not a segment or kit and still moves to the next", async () => {
    fetchInbox.mockResolvedValueOnce(new File(["x"], "notes.zip"));
    push(ID, "notes.zip");
    push(ID_2);
    fetchInbox.mockResolvedValueOnce(SEGMENT_FILE());
    render(<OpenBundleHost />);
    await sheet();
    expect(fetchInbox).toHaveBeenCalledTimes(2);
  });

  it("stages two files one after another, the second once the first sheet closes", async () => {
    push(ID);
    push(ID_2, "second.sharecutseg");
    render(<OpenBundleHost />);
    const first = await sheet();
    expect(fetchInbox).toHaveBeenCalledTimes(1);
    await userEvent.click(
      within(first).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() => expect(fetchInbox).toHaveBeenCalledTimes(2));
    await sheet();
    expect(fetchInbox.mock.calls[1].slice(0, 2)).toEqual([
      ID_2,
      "second.sharecutseg",
    ]);
  });

  it("adds to the library through the shared sheet", async () => {
    push();
    render(<OpenBundleHost />);
    const dialog = await sheet();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Add to library" }),
    );
    await waitFor(() => expect(commitSegment).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Import a segment" }),
      ).toBeNull(),
    );
  });

  it("holds the file while another host has a sheet open, then opens it", async () => {
    const home = render(<ListHost label="Home" />);
    const mine = new File(["zip"], "mine.sharecutseg", {
      type: "application/zip",
    });
    await userEvent.upload(
      home.container.querySelector("input[type=file]") as HTMLInputElement,
      mine,
    );
    const open = await sheet();
    render(<OpenBundleHost />);
    push();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(fetchInbox).not.toHaveBeenCalled();
    await userEvent.click(within(open).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(fetchInbox).toHaveBeenCalledTimes(1));
    await sheet();
  });

  it("holds the file while a take is armed, says so once, and opens it when the take ends", async () => {
    window.history.replaceState(null, "", `/?${CLOSE_GUARD_PARAM}=host`);
    push();
    render(<OpenBundleHost />);
    await waitFor(() => expect(said()).toBe(FINISH_THE_TAKE));
    expect(fetchInbox).not.toHaveBeenCalled();
    expect(window.location.search).toBe(`?${CLOSE_GUARD_PARAM}=host`);
    window.history.replaceState(null, "", "/");
    await waitFor(() => expect(fetchInbox).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    await sheet();
    expect(window.location.pathname).toBe("/");
  });

  it("keeps a file whose fetch finishes under a busy signal, opening it once only when released", async () => {
    let finish: (file: File) => void = () => {};
    fetchInbox.mockReset().mockReturnValue(
      new Promise<File>((resolve) => {
        finish = resolve;
      }),
    );
    push();
    render(<OpenBundleHost />);
    await waitFor(() => expect(fetchInbox).toHaveBeenCalledTimes(1));
    let release = () => {};
    act(() => {
      release = holdOpenImport();
    });
    await act(async () => {
      finish(SEGMENT_FILE());
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(previewSegment).not.toHaveBeenCalled();
    act(() => release());
    await sheet();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(fetchInbox).toHaveBeenCalledTimes(1);
    expect(previewSegment).toHaveBeenCalledTimes(1);
  });

  it("keeps a file whose fetch finishes while a take is armed, opening it when the take ends", async () => {
    let finish: (file: File) => void = () => {};
    fetchInbox.mockReset().mockReturnValue(
      new Promise<File>((resolve) => {
        finish = resolve;
      }),
    );
    push();
    render(<OpenBundleHost />);
    await waitFor(() => expect(fetchInbox).toHaveBeenCalledTimes(1));
    window.history.replaceState(null, "", `/?${CLOSE_GUARD_PARAM}=host`);
    await act(async () => {
      finish(SEGMENT_FILE());
      await Promise.resolve();
    });
    await waitFor(() => expect(said()).toBe(FINISH_THE_TAKE));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(previewSegment).not.toHaveBeenCalled();
    window.history.replaceState(null, "", "/");
    await sheet();
    expect(fetchInbox).toHaveBeenCalledTimes(1);
    expect(previewSegment).toHaveBeenCalledTimes(1);
  });

  it("aborts the fetch on unmount and does not open or drop anything", async () => {
    let seen: AbortSignal | undefined;
    fetchInbox.mockReset().mockImplementation((_id, _name, signal) => {
      seen = signal;
      return new Promise<File>((_, reject) => {
        signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });
    push();
    const view = render(<OpenBundleHost />);
    await waitFor(() => expect(fetchInbox).toHaveBeenCalledTimes(1));
    expect(seen?.aborted).toBe(false);
    view.unmount();
    expect(seen?.aborted).toBe(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(said()).toBe("");
    expect(dropInbox).not.toHaveBeenCalled();
    expect(previewSegment).not.toHaveBeenCalled();
  });

  it("with Home, the Library sheet and this host mounted, opens one sheet and refreshes both lists", async () => {
    render(
      <>
        <ListHost label="Home" />
        <ListHost label="Library" />
        <OpenBundleHost />
      </>,
    );
    await waitFor(() => expect(loadSegments).toHaveBeenCalledTimes(2));
    const kitReads = loadKits.mock.calls.length;
    push();
    const dialog = await sheet();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Add to library" }),
    );
    await waitFor(() => expect(loadSegments).toHaveBeenCalledTimes(4));
    expect(loadKits.mock.calls.length).toBeGreaterThan(kitReads);
  });

  it("returns focus to the main region when nothing had focus to go back to", async () => {
    const main = document.createElement("main");
    document.body.append(main);
    push();
    render(<OpenBundleHost />);
    const dialog = await sheet();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(main).toHaveFocus());
    main.remove();
  });
});
